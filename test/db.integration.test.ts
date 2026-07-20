import { env, exports } from 'cloudflare:workers';
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  awaitingPaymentReview,
  cancelOutboxRow,
  clearLoginAttempts,
  createClient,
  createInvoice,
  enqueueReminder,
  getInvoice,
  getInvoiceItems,
  getPayments,
  listDueOutbox,
  markInvoicePaidFromWebhook,
  markInvoiceSent,
  markReminderSent,
  monthlyReport,
  reportSummary,
  recordLoginAttempt,
  updateInvoice,
  type WebhookPayment,
} from '../src/db/queries';
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MINUTES, MAX_OUTBOX_ATTEMPTS } from '../src/lib/outbox';
import { processEmailOutbox } from '../src/services/outbox';

const DB = env.DB;
const FORCED_ITEM_FAILURE = '__FORCE_ITEM_FAILURE__';

async function installItemFailureTrigger(): Promise<void> {
  await DB.prepare(
    `CREATE TRIGGER reject_forced_invoice_item
     BEFORE INSERT ON invoice_items
     WHEN NEW.description = '${FORCED_ITEM_FAILURE}'
     BEGIN
       SELECT RAISE(ABORT, 'forced item insert failure');
     END`
  ).run();
}

async function removeItemFailureTrigger(): Promise<void> {
  await DB.exec('DROP TRIGGER IF EXISTS reject_forced_invoice_item');
}

async function seedSentInvoice(total = 10000): Promise<number> {
  const clientId = await createClient(DB, {
    name: 'Acme',
    email: 'ap@acme.test',
    address: null,
    default_rate_cents: null,
    payment_terms_days: null,
  });
  const id = await createInvoice(DB, {
    client_id: clientId,
    issue_date: '2026-07-01',
    due_date: '2026-07-10',
    subject: 'Test',
    notes: null,
    items: [{ description: 'Work', quantity: 1, unit_price_cents: total }],
  });
  await markInvoiceSent(DB, id);
  return id;
}

const webhookPayload = (invoiceId: number, over: Partial<WebhookPayment> = {}): WebhookPayment => ({
  provider: 'stripe',
  eventId: 'evt_1',
  eventType: 'checkout.session.completed',
  payload: '{}',
  invoiceId,
  providerRef: 'cs_1',
  amountCents: 10000,
  currency: 'USD',
  ...over,
});

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM email_outbox'),
    DB.prepare('DELETE FROM login_attempts'),
    DB.prepare('DELETE FROM webhook_events'),
    DB.prepare('DELETE FROM payments'),
    DB.prepare('DELETE FROM invoice_events'),
    DB.prepare('DELETE FROM invoice_items'),
    DB.prepare('DELETE FROM invoices'),
    DB.prepare('DELETE FROM clients'),
    DB.prepare(
      `UPDATE settings SET email_provider = 'cloudflare', email_from = '',
       reminders_enabled = 0, last_seen_origin = '' WHERE id = 1`
    ),
  ]);
  await removeItemFailureTrigger();
});

describe('invoice write atomicity', () => {
  it('commits a header and all line items together', async () => {
    const clientId = await createClient(DB, {
      name: 'C',
      email: null,
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    const id = await createInvoice(DB, {
      client_id: clientId,
      issue_date: '2026-07-01',
      due_date: null,
      subject: null,
      notes: null,
      items: [
        { description: 'A', quantity: 2, unit_price_cents: 500 },
        { description: 'B', quantity: 1, unit_price_cents: 2500 },
      ],
    });

    expect(await getInvoiceItems(DB, id)).toHaveLength(2);
    expect((await getInvoice(DB, id))?.total_cents).toBe(3500);
  });

  it('rolls back the header when a line-item insert fails', async () => {
    const clientId = await createClient(DB, {
      name: 'C',
      email: null,
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    await installItemFailureTrigger();
    try {
      await expect(
        createInvoice(DB, {
          client_id: clientId,
          issue_date: '2026-07-01',
          due_date: null,
          subject: 'Must roll back',
          notes: null,
          items: [
            { description: 'A', quantity: 1, unit_price_cents: 500 },
            { description: FORCED_ITEM_FAILURE, quantity: 1, unit_price_cents: 500 },
          ],
        })
      ).rejects.toThrow();
    } finally {
      await removeItemFailureTrigger();
    }

    expect(await DB.prepare('SELECT COUNT(*) FROM invoices').first<number>('COUNT(*)')).toBe(0);
    expect(await DB.prepare('SELECT COUNT(*) FROM invoice_items').first<number>('COUNT(*)')).toBe(0);
  });

  it('rolls back header and item changes when an update item fails', async () => {
    const id = await seedSentInvoice();
    await installItemFailureTrigger();
    try {
      await expect(
        updateInvoice(DB, id, {
          issue_date: '2026-07-02',
          due_date: '2026-07-20',
          subject: 'Changed',
          notes: 'Changed',
          items: [
            { description: 'Replacement', quantity: 1, unit_price_cents: 2500 },
            { description: FORCED_ITEM_FAILURE, quantity: 1, unit_price_cents: 2500 },
          ],
        })
      ).rejects.toThrow();
    } finally {
      await removeItemFailureTrigger();
    }

    const invoice = await getInvoice(DB, id);
    const items = await getInvoiceItems(DB, id);
    expect(invoice?.subject).toBe('Test');
    expect(invoice?.total_cents).toBe(10000);
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('Work');
  });
});

describe('markInvoicePaidFromWebhook', () => {
  it('records payment, transitions invoice, and enqueues both emails', async () => {
    const id = await seedSentInvoice();
    expect(await markInvoicePaidFromWebhook(DB, webhookPayload(id))).toBe('paid');

    expect((await getInvoice(DB, id))?.status).toBe('paid');
    expect(
      await DB.prepare('SELECT COUNT(*) FROM payments WHERE invoice_id = ?').bind(id).first<number>('COUNT(*)')
    ).toBe(1);
    const outbox = await listDueOutbox(DB, MAX_OUTBOX_ATTEMPTS);
    expect(outbox.map((row) => row.kind).sort()).toEqual(['paid_notice', 'payment_receipt']);
  });

  it('is idempotent for a replayed event', async () => {
    const id = await seedSentInvoice();
    await markInvoicePaidFromWebhook(DB, webhookPayload(id));
    expect(await markInvoicePaidFromWebhook(DB, webhookPayload(id))).toBe('duplicate');

    expect(
      await DB.prepare('SELECT COUNT(*) FROM payments WHERE invoice_id = ?').bind(id).first<number>('COUNT(*)')
    ).toBe(1);
    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(2);
  });

  it('records a distinct event without re-transitioning an already-paid invoice', async () => {
    const id = await seedSentInvoice();
    await markInvoicePaidFromWebhook(DB, webhookPayload(id));
    expect(
      await markInvoicePaidFromWebhook(
        DB,
        webhookPayload(id, { eventId: 'evt_2', providerRef: 'cs_2' })
      )
    ).toBe('recorded');
    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(2);
  });

  it('rolls back the event when a later payment write fails', async () => {
    await expect(
      markInvoicePaidFromWebhook(
        DB,
        webhookPayload(999999, { eventId: 'evt_fails', providerRef: 'cs_fails' })
      )
    ).rejects.toThrow();

    expect(await DB.prepare('SELECT COUNT(*) FROM webhook_events').first<number>('COUNT(*)')).toBe(0);
    expect(await DB.prepare('SELECT COUNT(*) FROM payments').first<number>('COUNT(*)')).toBe(0);
    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(0);
  });
});

describe('reminder outbox', () => {
  it('deduplicates re-enqueue of the same invoice and reminder number', async () => {
    const id = await seedSentInvoice();
    const payload = { invoiceId: id, payUrl: 'https://invoice.test/pay/t', reminderNumber: 1 };
    await enqueueReminder(DB, payload);
    await enqueueReminder(DB, payload);

    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(1);
  });

  it('writes one reminder event when overlapping drains complete together', async () => {
    const id = await seedSentInvoice();
    await enqueueReminder(DB, {
      invoiceId: id,
      payUrl: 'https://invoice.test/pay/t',
      reminderNumber: 1,
    });
    const [row] = await listDueOutbox(DB, MAX_OUTBOX_ATTEMPTS);

    await Promise.all([
      markReminderSent(DB, row.id, id, 'Reminder 1 emailed'),
      markReminderSent(DB, row.id, id, 'Reminder 1 emailed'),
    ]);

    expect(
      await DB.prepare(
        `SELECT COUNT(*) FROM invoice_events WHERE invoice_id = ? AND type = 'reminder'`
      )
        .bind(id)
        .first<number>('COUNT(*)')
    ).toBe(1);
  });

  it('frees the dedup key when a pending reminder is cancelled', async () => {
    const id = await seedSentInvoice();
    const payload = { invoiceId: id, payUrl: 'https://invoice.test/pay/t', reminderNumber: 1 };
    await enqueueReminder(DB, payload);
    const [row] = await listDueOutbox(DB, MAX_OUTBOX_ATTEMPTS);
    await cancelOutboxRow(DB, row.id);
    await enqueueReminder(DB, payload);

    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(1);
  });

  it('delivers a reminder and atomically records completion through the processor', async () => {
    const id = await seedSentInvoice();
    await DB.prepare(
      `UPDATE settings SET email_provider = 'cloudflare', email_from = 'billing@example.test' WHERE id = 1`
    ).run();
    await enqueueReminder(DB, {
      invoiceId: id,
      payUrl: 'https://invoice.test/pay/t',
      reminderNumber: 1,
    });

    let deliveries = 0;
    const EMAIL: SendEmail = {
      async send() {
        deliveries += 1;
        return { messageId: 'test-message' };
      },
    };
    await processEmailOutbox({ ...env, EMAIL });

    expect(deliveries).toBe(1);
    expect(
      await DB.prepare('SELECT COUNT(*) FROM email_outbox WHERE sent_at IS NOT NULL').first<number>('COUNT(*)')
    ).toBe(1);
    expect(
      await DB.prepare(
        `SELECT COUNT(*) FROM invoice_events WHERE invoice_id = ? AND type = 'reminder'`
      )
        .bind(id)
        .first<number>('COUNT(*)')
    ).toBe(1);
  });

  it('cancels a queued reminder when its invoice is no longer payable', async () => {
    const id = await seedSentInvoice();
    await enqueueReminder(DB, {
      invoiceId: id,
      payUrl: 'https://invoice.test/pay/t',
      reminderNumber: 1,
    });
    await DB.prepare(`UPDATE invoices SET status = 'paid' WHERE id = ?`).bind(id).run();

    await processEmailOutbox(env);

    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(0);
  });

  it('the scheduled handler records delivery failures with retry backoff', async () => {
    await DB.prepare(
      `INSERT INTO email_outbox (kind, payload, dedup_key) VALUES ('reminder', '{not-json', 'broken')`
    ).run();
    const ctx = createExecutionContext();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      worker.scheduled(createScheduledController({ cron: '0 15 * * *' }), env, ctx);
      await waitOnExecutionContext(ctx);
    } finally {
      errorLog.mockRestore();
    }

    const row = await DB.prepare(
      `SELECT attempts, last_error, next_attempt_at > datetime('now') AS retry_scheduled
       FROM email_outbox WHERE dedup_key = 'broken'`
    ).first<{ attempts: number; last_error: string | null; retry_scheduled: number }>();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBeTruthy();
    expect(row?.retry_scheduled).toBe(1);
  });
});

describe('login rate limiting', () => {
  it('returns sequential counts past the configured cap', async () => {
    const ip = '203.0.113.7';
    const counts: number[] = [];
    for (let i = 0; i < 12; i++) counts.push(await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES));

    expect(counts.slice(0, 3)).toEqual([1, 2, 3]);
    expect(counts[LOGIN_MAX_ATTEMPTS - 1]).toBe(LOGIN_MAX_ATTEMPTS);
    expect(counts[LOGIN_MAX_ATTEMPTS]).toBeGreaterThan(LOGIN_MAX_ATTEMPTS);
  });

  it('parallel attempts each consume a distinct slot', async () => {
    const ip = '203.0.113.8';
    const results = await Promise.all(
      Array.from({ length: 20 }, () => recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES))
    );

    expect(new Set(results).size).toBe(20);
    expect(Math.max(...results)).toBe(20);
  });

  it('the login endpoint allows attempt ten and returns 429 for attempt eleven', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) {
      await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES);
    }
    const login = () =>
      exports.default.fetch(
        new Request('https://invoice.test/admin/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'cf-connecting-ip': ip,
            'sec-fetch-site': 'same-origin',
          },
          body: 'password=wrong',
        })
      );

    expect((await login()).status).toBe(401);
    expect((await login()).status).toBe(429);
  });

  it('clearLoginAttempts resets the counter after success', async () => {
    const ip = '203.0.113.9';
    await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES);
    await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES);
    await clearLoginAttempts(DB, ip);

    expect(await recordLoginAttempt(DB, ip, LOGIN_WINDOW_MINUTES)).toBe(1);
  });
});

describe('multi-currency invoices and reports', () => {
  async function seedTwoCurrencies(): Promise<{ usd: number; eur: number }> {
    const clientId = await createClient(DB, {
      name: 'Global GmbH',
      email: 'ap@global.test',
      address: null,
      default_rate_cents: null,
      payment_terms_days: null,
    });
    const usd = await createInvoice(DB, {
      client_id: clientId,
      issue_date: '2026-07-01',
      due_date: null,
      subject: null,
      notes: null,
      items: [{ description: 'Design', quantity: 1, unit_price_cents: 10000 }],
    });
    const eur = await createInvoice(DB, {
      client_id: clientId,
      issue_date: '2026-07-02',
      due_date: null,
      subject: null,
      notes: null,
      currency: 'EUR',
      items: [{ description: 'Dev', quantity: 1, unit_price_cents: 5000 }],
    });
    await markInvoiceSent(DB, usd);
    await markInvoiceSent(DB, eur);
    return { usd, eur };
  }

  it('createInvoice takes the draft currency, defaulting to settings', async () => {
    const { usd, eur } = await seedTwoCurrencies();
    expect((await getInvoice(DB, usd))!.currency).toBe('USD');
    expect((await getInvoice(DB, eur))!.currency).toBe('EUR');
  });

  it('updateInvoice can change the currency and keeps it when omitted', async () => {
    const { usd } = await seedTwoCurrencies();
    const items = [{ description: 'Design', quantity: 1, unit_price_cents: 10000 }];
    await updateInvoice(DB, usd, {
      issue_date: '2026-07-01', due_date: null, subject: null, notes: null, currency: 'GBP', items,
    });
    expect((await getInvoice(DB, usd))!.currency).toBe('GBP');
    await updateInvoice(DB, usd, {
      issue_date: '2026-07-01', due_date: null, subject: null, notes: null, items,
    });
    expect((await getInvoice(DB, usd))!.currency).toBe('GBP');
  });

  it('report sums are grouped per currency, never added together', async () => {
    const { eur } = await seedTwoCurrencies();
    await markInvoicePaidFromWebhook(
      DB,
      webhookPayload(eur, { amountCents: 5000, currency: 'EUR', providerRef: 'cs_eur', eventId: 'evt_eur' })
    );

    const today = new Date().toISOString().slice(0, 10);
    const summary = await reportSummary(DB, today);
    expect(summary.outstanding_count).toBe(1);
    expect(summary.by_currency).toEqual([
      { currency: 'EUR', outstanding_cents: 0, received_ytd_cents: 5000 },
      { currency: 'USD', outstanding_cents: 10000, received_ytd_cents: 0 },
    ]);

    const invoiced = (await monthlyReport(DB))
      .filter((r) => r.ym === '2026-07' && r.invoiced_count > 0)
      .map((r) => [r.currency, r.invoiced_cents]);
    expect(invoiced).toEqual([
      ['EUR', 5000],
      ['USD', 10000],
    ]);
  });
});

describe('stale-currency/amount webhooks', () => {
  it('records the payment but refuses the paid transition on mismatch', async () => {
    const id = await seedSentInvoice(10000); // USD 100.00
    // Invoice edited to EUR after the checkout session was created
    await updateInvoice(DB, id, {
      issue_date: '2026-07-01', due_date: '2026-07-10', subject: 'Test', notes: null,
      currency: 'EUR',
      items: [{ description: 'Work', quantity: 1, unit_price_cents: 10000 }],
    });

    expect(await markInvoicePaidFromWebhook(DB, webhookPayload(id))).toBe('recorded'); // USD 10000
    expect((await getInvoice(DB, id))?.status).toBe('sent'); // NOT paid
    expect(
      await DB.prepare('SELECT COUNT(*) FROM payments WHERE invoice_id = ?').bind(id).first<number>('COUNT(*)')
    ).toBe(1); // money moved — payment row kept for manual review
    expect(await DB.prepare('SELECT COUNT(*) FROM email_outbox').first<number>('COUNT(*)')).toBe(0); // no receipts

    // A payment matching the CURRENT currency and total still transitions
    expect(
      await markInvoicePaidFromWebhook(
        DB,
        webhookPayload(id, { currency: 'EUR', eventId: 'evt_eur', providerRef: 'cs_eur' })
      )
    ).toBe('paid');
    expect((await getInvoice(DB, id))?.status).toBe('paid');
  });

  it('refuses the transition on an amount mismatch too', async () => {
    const id = await seedSentInvoice(10000);
    expect(await markInvoicePaidFromWebhook(DB, webhookPayload(id, { amountCents: 5000 }))).toBe('recorded');
    expect((await getInvoice(DB, id))?.status).toBe('sent');
  });
});

describe('awaitingPaymentReview', () => {
  it('suppresses checkout after a mismatched provider payment', async () => {
    const id = await seedSentInvoice(10000);
    // stale payment recorded, invoice stays sent (mismatch guard)
    await markInvoicePaidFromWebhook(DB, webhookPayload(id, { amountCents: 5000 }));
    const invoice = (await getInvoice(DB, id))!;
    expect(invoice.status).toBe('sent');
    expect(awaitingPaymentReview(invoice, await getPayments(DB, id))).toBe(true);
  });

  it('ignores manual partial payments and undone provider payments', async () => {
    const id = await seedSentInvoice(10000);
    expect(awaitingPaymentReview({ status: 'sent' }, [])).toBe(false);
    // manual partial payment: checkout stays available
    expect(awaitingPaymentReview({ status: 'sent' }, [{ provider: 'manual', undone_at: null }])).toBe(false);
    // undone provider payment: resolved by the admin, checkout is back
    expect(awaitingPaymentReview({ status: 'sent' }, [{ provider: 'stripe', undone_at: '2026-07-19' }])).toBe(false);
    // paid invoices are handled by status, not review state
    expect(awaitingPaymentReview({ status: 'paid' }, [{ provider: 'stripe', undone_at: null }])).toBe(false);
    void id;
  });
});
