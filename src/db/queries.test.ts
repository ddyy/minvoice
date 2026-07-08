import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  expandInvoicePrefix,
  formatInvoiceNumber,
  hasDateTokens,
  isOverdue,
  suggestedInvoiceNumber,
  type Invoice,
  type InvoiceEvent,
  type Payment,
  type Settings,
} from './queries';
import { formatCents } from '../lib/money';

const baseInvoice: Invoice = {
  id: 1,
  number: 'INV-0001',
  client_id: 1,
  status: 'sent',
  currency: 'USD',
  issue_date: '2026-07-01',
  due_date: null,
  subject: null,
  notes: null,
  tax_rate_bps: 0,
  subtotal_cents: 10000,
  tax_cents: 0,
  total_cents: 10000,
  public_token: 'tok',
  paypal_order_id: null,
  sent_at: null,
  paid_at: null,
  created_at: '2026-07-01 12:00:00',
  updated_at: '2026-07-01 12:00:00',
};

const payment = (over: Partial<Payment>): Payment => ({
  id: 1,
  invoice_id: 1,
  provider: 'manual',
  provider_ref: 'ref',
  amount_cents: 10000,
  currency: 'USD',
  note: null,
  undone_at: null,
  created_at: '2026-07-01 13:00:00',
  recorded_at: '2026-07-01 13:00:00',
  stripe_payment_intent: null,
  ...over,
});

const event = (over: Partial<InvoiceEvent>): InvoiceEvent => ({
  id: 1,
  invoice_id: 1,
  type: 'edited',
  detail: null,
  created_at: '2026-07-01 14:00:00',
  ...over,
});

describe('invoice number prefixes', () => {
  it('pads plain counter numbers', () => {
    expect(formatInvoiceNumber('INV-', 42)).toBe('INV-0042');
  });

  it('detects date tokens', () => {
    expect(hasDateTokens('{YYYY}{MM}{DD}')).toBe(true);
    expect(hasDateTokens('INV-')).toBe(false);
  });

  it('expands tokens to date parts', () => {
    expect(expandInvoicePrefix('{YYYY}{MM}{DD}', 'UTC')).toMatch(/^\d{8}$/);
    expect(expandInvoicePrefix('{YY}-', 'UTC')).toMatch(/^\d{2}-$/);
    expect(expandInvoicePrefix('INV-', 'UTC')).toBe('INV-');
  });
});

describe('suggestedInvoiceNumber (plain prefix)', () => {
  it('formats from settings without touching the db', async () => {
    const settings = { invoice_prefix: 'INV-', next_invoice_number: 7, timezone: 'UTC' } as Settings;
    // db is only consulted for dated prefixes; a plain prefix must not use it
    expect(await suggestedInvoiceNumber(null as never, settings)).toBe('INV-0007');
  });
});

describe('isOverdue', () => {
  it('is due-date and status sensitive', () => {
    expect(isOverdue({ status: 'sent', due_date: '2026-06-01' }, '2026-07-01')).toBe(true);
    expect(isOverdue({ status: 'sent', due_date: '2026-07-01' }, '2026-07-01')).toBe(false); // due today ≠ overdue
    expect(isOverdue({ status: 'paid', due_date: '2026-06-01' }, '2026-07-01')).toBe(false);
    expect(isOverdue({ status: 'sent', due_date: null }, '2026-07-01')).toBe(false);
  });
});

describe('buildTimeline', () => {
  it('orders most recent first with Created last', () => {
    const t = buildTimeline(
      { ...baseInvoice, sent_at: '2026-07-01 12:30:00' },
      [payment({})],
      [event({ type: 'edited', created_at: '2026-07-01 12:15:00' })],
      formatCents
    );
    expect(t.map((e) => e.label)).toEqual([
      'Payment received — $100.00 via manual',
      'Sent',
      'Edited',
      'Created',
    ]);
  });

  it('keeps received before its own undo within the same second (reversed: undo first)', () => {
    const t = buildTimeline(
      baseInvoice,
      [payment({ recorded_at: '2026-07-01 13:00:00' })],
      [event({ type: 'payment_undone', created_at: '2026-07-01 13:00:00' })],
      formatCents
    );
    const labels = t.map((e) => e.kind);
    expect(labels.indexOf('payment_undone')).toBeLessThan(labels.indexOf('payment'));
  });

  it('orders by record time and annotates backdated payments', () => {
    const t = buildTimeline(
      baseInvoice,
      [payment({ created_at: '2026-06-30', recorded_at: '2026-07-01 15:00:00' })],
      [],
      formatCents
    );
    const p = t.find((e) => e.kind === 'payment')!;
    expect(p.at).toBe('2026-07-01 15:00:00');
    expect(p.label).toContain('(dated 2026-06-30)');
  });

  it('clamps payments that appear to predate the invoice', () => {
    const t = buildTimeline(
      baseInvoice,
      [payment({ created_at: '2026-06-15', recorded_at: null })],
      [],
      formatCents
    );
    const p = t.find((e) => e.kind === 'payment')!;
    expect(p.at).toBe(baseInvoice.created_at);
  });

  it('falls back to sent_at only when no sent event exists', () => {
    const withEvent = buildTimeline(
      { ...baseInvoice, sent_at: '2026-07-01 12:30:00' },
      [],
      [event({ type: 'sent', created_at: '2026-07-01 12:30:00' })],
      formatCents
    );
    expect(withEvent.filter((e) => e.kind === 'sent')).toHaveLength(1);

    const legacyBackdated = buildTimeline({ ...baseInvoice, sent_at: '2026-06-01' }, [], [], formatCents);
    const sent = legacyBackdated.find((e) => e.kind === 'sent')!;
    expect(sent.at).toBe(baseInvoice.created_at); // clamped, not before Created
    expect(sent.detail).toBe('Dated 2026-06-01');
  });
});
