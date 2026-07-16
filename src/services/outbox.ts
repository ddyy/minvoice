import type { Bindings } from '../env';
import { backoffMinutes, MAX_OUTBOX_ATTEMPTS } from '../lib/outbox';
import {
  cancelOutboxRow,
  getInvoice,
  getSettings,
  listDueOutbox,
  markOutboxFailed,
  markOutboxSent,
  markReminderSent,
  type OutboxRow,
} from '../db/queries';
import { sendPaidNotice, sendPaymentReceipt, sendReminderEmail, type PaymentEmailInfo } from './email';

/**
 * Drain due email_outbox rows: deliver, mark sent, or record the failure with
 * backoff for a later sweep. Runs opportunistically right after the state
 * change that enqueued (via waitUntil) and on every cron tick, so a failed
 * immediate attempt is retried within a day at worst.
 *
 * Semantics are at-least-once: a crash between delivery and the sent-mark, or
 * overlapping sweeps, can repeat an email. For receipts and reminders a rare
 * duplicate beats a silent never — the failure mode this replaced.
 */
export async function processEmailOutbox(env: Bindings): Promise<void> {
  const due = await listDueOutbox(env.DB, MAX_OUTBOX_ATTEMPTS);
  if (due.length === 0) return;

  // Cron has no request middleware to resolve APP_BASE_URL on zero-config
  // deploys, and receipt/notice links are built from it — resolve here the
  // same way the reminder enqueuer does: configured value, else the origin
  // the pay page last saw.
  const settings = await getSettings(env.DB);
  const base = ((env.APP_BASE_URL ?? '').trim() || settings.last_seen_origin).replace(/\/+$/, '');
  const resolvedEnv: Bindings = base ? { ...env, APP_BASE_URL: base } : env;

  for (const row of due) {
    // Reminder payloads carry their pay URL from enqueue time; receipts and
    // notices need a live base URL — without one, leave them pending (no
    // attempt consumed) rather than sending emails with broken links.
    if (!base && row.kind !== 'reminder') {
      console.warn(`outbox ${row.kind}#${row.id}: no APP_BASE_URL and no traffic-derived origin yet — leaving pending`);
      continue;
    }
    try {
      await deliver(resolvedEnv, row);
    } catch (e) {
      console.error(`outbox ${row.kind}#${row.id} failed (attempt ${row.attempts + 1})`, e);
      await markOutboxFailed(env.DB, row.id, String(e), backoffMinutes(row.attempts + 1));
    }
  }
}

/** Deliver one row and record its completion (throws to trigger retry). */
async function deliver(env: Bindings, row: OutboxRow): Promise<void> {
  if (row.kind === 'payment_receipt' || row.kind === 'paid_notice') {
    const p = JSON.parse(row.payload) as PaymentEmailInfo & { invoiceId: number };
    if (row.kind === 'payment_receipt') await sendPaymentReceipt(env, env.DB, p.invoiceId, p);
    else await sendPaidNotice(env, env.DB, p.invoiceId, p);
    return markOutboxSent(env.DB, row.id);
  }

  // reminder — the history event is written only on ACTUAL delivery, in the
  // same transaction as the sent-mark, so the invoice timeline and the
  // cadence counter never claim an email that didn't go out.
  const p = JSON.parse(row.payload) as { invoiceId: number; payUrl: string; reminderNumber: number };
  const [invoice, settings] = await Promise.all([getInvoice(env.DB, p.invoiceId), getSettings(env.DB)]);
  // Paid or voided since enqueue, or email turned off: a nudge would be wrong.
  // CANCEL (delete) rather than mark sent — deletion releases the dedup_key,
  // so if the payment is undone or email re-enabled, this reminder number can
  // be enqueued again instead of being blocked until the 30-day purge.
  if (!invoice || invoice.status !== 'sent' || settings.email_provider === 'none') {
    return cancelOutboxRow(env.DB, row.id);
  }
  await sendReminderEmail(env, settings, invoice, p.payUrl, p.reminderNumber);
  await markReminderSent(
    env.DB,
    row.id,
    p.invoiceId,
    `Reminder ${p.reminderNumber} emailed to ${invoice.client_email}`
  );
}
