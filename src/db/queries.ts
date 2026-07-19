import { computeTotals, itemAmountCents, type ItemInput } from '../lib/money';
import { newPublicToken } from '../lib/tokens';
import { todayInTz } from '../lib/dates';

// ---------- Row types ----------

export type Settings = {
  id: 1;
  business_name: string;
  business_address: string;
  business_email: string | null;
  logo_url: string | null;
  currency: string;
  tax_rate_bps: number;
  invoice_prefix: string;
  next_invoice_number: number;
  default_rate_cents: number; // 0 = no default
  timezone: string; // IANA name; storage stays UTC
  locale: string; // BCP-47 tag for customer-facing language + formatting
  accent_color: string; // brand accent hex for emails + PDF
  email_provider: 'cloudflare' | 'resend' | 'none';
  email_from: string;
  reminders_enabled: number;
  /** Comma-separated days-overdue thresholds, e.g. '1, 7, 14' — one reminder per entry */
  reminder_schedule: string;
  /** Public origin observed on pay-page traffic — cron pay links when APP_BASE_URL is unset */
  last_seen_origin: string;
  // Provider toggles + in-app credentials (env secrets take precedence)
  stripe_enabled: number;
  paypal_enabled: number;
  stripe_secret_key: string;
  stripe_webhook_secret: string;
  paypal_client_id: string;
  paypal_client_secret: string;
  paypal_webhook_id: string;
  paypal_environment: 'live' | 'sandbox';
  resend_api_key: string;
  payment_terms_days: number; // 0 = no default due date
  setup_complete: number; // 0 -> first-launch wizard gates /admin
};

export type Client = {
  id: number;
  name: string;
  email: string | null;
  address: string | null;
  archived: number;
  default_rate_cents: number | null; // NULL = inherit settings default
  payment_terms_days: number | null; // NULL = inherit settings terms
  locale: string | null; // NULL = inherit settings locale (customer-facing language)
  created_at: string;
};

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'void';

export type Invoice = {
  id: number;
  number: string;
  client_id: number;
  status: InvoiceStatus;
  currency: string;
  issue_date: string;
  due_date: string | null;
  subject: string | null;
  notes: string | null;
  tax_rate_bps: number;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  public_token: string;
  paypal_order_id: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

export type InvoiceItem = {
  id: number;
  invoice_id: number;
  position: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
};

export type Payment = {
  id: number;
  invoice_id: number;
  provider: 'stripe' | 'paypal' | 'manual';
  provider_ref: string | null;
  amount_cents: number;
  currency: string;
  note: string | null;
  undone_at: string | null; // soft delete — NULL means the payment counts
  created_at: string; // effective payment date (may be a backdated YYYY-MM-DD)
  recorded_at: string | null; // when the row was entered — drives history order
  stripe_payment_intent: string | null; // pi_... for dashboard deep links
};

export type InvoiceWithClient = Invoice & { client_name: string; client_email: string | null; client_locale: string | null };

export function isOverdue(
  inv: Pick<Invoice, 'status' | 'due_date'>,
  today: string = new Date().toISOString().slice(0, 10)
): boolean {
  return inv.status === 'sent' && !!inv.due_date && inv.due_date < today;
}

// ---------- Settings ----------

export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db.prepare('SELECT * FROM settings WHERE id = 1').first<Settings>();
  if (!row) throw new Error('settings row missing — migration not applied?');
  return row;
}

export async function updateSettings(
  db: D1Database,
  s: Omit<
    Settings,
    | 'id'
    | 'next_invoice_number'
    | 'setup_complete'
    | 'stripe_enabled'
    | 'paypal_enabled'
    | 'stripe_secret_key'
    | 'stripe_webhook_secret'
    | 'paypal_client_id'
    | 'paypal_client_secret'
    | 'paypal_webhook_id'
    | 'paypal_environment'
    | 'resend_api_key'
    | 'reminders_enabled'
    | 'reminder_schedule'
    | 'last_seen_origin'
  >
): Promise<void> {
  await db
    .prepare(
      `UPDATE settings SET business_name = ?, business_address = ?, business_email = ?,
       logo_url = ?, currency = ?, tax_rate_bps = ?, invoice_prefix = ?, default_rate_cents = ?, timezone = ?,
       locale = ?, accent_color = ?, email_provider = ?, email_from = ?, payment_terms_days = ?
       WHERE id = 1`
    )
    .bind(
      s.business_name,
      s.business_address,
      s.business_email,
      s.logo_url,
      s.currency,
      s.tax_rate_bps,
      s.invoice_prefix,
      s.default_rate_cents,
      s.timezone,
      s.locale,
      s.accent_color,
      s.email_provider,
      s.email_from,
      s.payment_terms_days
    )
    .run();
}

/** Provider toggles + stored credentials. Callers pass CURRENT values for
 *  fields the user left blank (blank input = keep existing key). */
export async function updateProviderSettings(
  db: D1Database,
  p: Pick<
    Settings,
    | 'stripe_enabled'
    | 'paypal_enabled'
    | 'stripe_secret_key'
    | 'stripe_webhook_secret'
    | 'paypal_client_id'
    | 'paypal_client_secret'
    | 'paypal_webhook_id'
    | 'paypal_environment'
    | 'resend_api_key'
  >
): Promise<void> {
  await db
    .prepare(
      `UPDATE settings SET stripe_enabled = ?, paypal_enabled = ?, stripe_secret_key = ?,
        stripe_webhook_secret = ?, paypal_client_id = ?, paypal_client_secret = ?,
        paypal_webhook_id = ?, paypal_environment = ?, resend_api_key = ? WHERE id = 1`
    )
    .bind(
      p.stripe_enabled,
      p.paypal_enabled,
      p.stripe_secret_key,
      p.stripe_webhook_secret,
      p.paypal_client_id,
      p.paypal_client_secret,
      p.paypal_webhook_id,
      p.paypal_environment,
      p.resend_api_key
    )
    .run();
}

export async function updateEmailSettings(
  db: D1Database,
  e: Pick<Settings, 'email_provider' | 'email_from' | 'reminders_enabled' | 'reminder_schedule'>
): Promise<void> {
  await db
    .prepare(
      'UPDATE settings SET email_provider = ?, email_from = ?, reminders_enabled = ?, reminder_schedule = ? WHERE id = 1'
    )
    .bind(e.email_provider, e.email_from, e.reminders_enabled, e.reminder_schedule)
    .run();
}

export async function updateLastSeenOrigin(db: D1Database, origin: string): Promise<void> {
  await db.prepare('UPDATE settings SET last_seen_origin = ? WHERE id = 1').bind(origin).run();
}

export type OverdueInvoice = InvoiceWithClient & { reminders_sent: number; last_reminder_at: string | null };

/** Sent invoices past due with an emailable client, plus reminder history. */
export async function listOverdueForReminders(db: D1Database, today: string): Promise<OverdueInvoice[]> {
  return (
    await db
      .prepare(
        `SELECT i.*, c.name AS client_name, c.email AS client_email, c.locale AS client_locale,
           (SELECT COUNT(*) FROM invoice_events e WHERE e.invoice_id = i.id AND e.type = 'reminder') AS reminders_sent,
           (SELECT MAX(created_at) FROM invoice_events e WHERE e.invoice_id = i.id AND e.type = 'reminder') AS last_reminder_at
         FROM invoices i JOIN clients c ON c.id = i.client_id
         WHERE i.status = 'sent' AND i.due_date IS NOT NULL AND i.due_date < ?
           AND c.email IS NOT NULL AND c.email != ''`
      )
      .bind(today)
      .all<OverdueInvoice>()
  ).results;
}

export async function setResendApiKey(db: D1Database, key: string): Promise<void> {
  await db.prepare('UPDATE settings SET resend_api_key = ? WHERE id = 1').bind(key).run();
}

export async function setNextInvoiceNumber(db: D1Database, n: number): Promise<void> {
  await db.prepare('UPDATE settings SET next_invoice_number = ? WHERE id = 1').bind(n).run();
}

export async function completeSetup(db: D1Database): Promise<void> {
  await db.prepare('UPDATE settings SET setup_complete = 1 WHERE id = 1').run();
}

export function formatInvoiceNumber(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/** Replace {YYYY} {YY} {MM} {DD} tokens with today's date parts in the business time zone. */
export function expandInvoicePrefix(prefix: string, tz = 'UTC'): string {
  const [yyyy, mm, dd] = todayInTz(tz).split('-');
  return prefix
    .replaceAll('{YYYY}', yyyy)
    .replaceAll('{YY}', yyyy.slice(2))
    .replaceAll('{MM}', mm)
    .replaceAll('{DD}', dd);
}

export function hasDateTokens(prefix: string): boolean {
  return /\{(YYYY|YY|MM|DD)\}/.test(prefix);
}

/**
 * Next number for a dated prefix: highest numeric suffix among existing
 * numbers sharing the expanded prefix, plus one, padded to 2 digits.
 * e.g. prefix "{YYYY}{MM}{DD}" -> "2026070101", "2026070102", ...
 */
async function nextNumberForDatedPrefix(db: D1Database, expanded: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(number, ?) AS INTEGER)) AS m FROM invoices WHERE number LIKE ? || '%'`
    )
    .bind(expanded.length + 1, expanded)
    .first<{ m: number | null }>();
  const next = (row?.m ?? 0) + 1;
  return `${expanded}${String(next).padStart(2, '0')}`;
}

/**
 * Next auto invoice number. Date-token prefixes get a per-day sequence (the
 * global counter is not consumed); plain prefixes use the atomic counter,
 * e.g. "INV-0042". Collisions from races surface via UNIQUE(number) and are
 * handled by the create route.
 */
export async function claimInvoiceNumber(db: D1Database): Promise<string> {
  const settings = await getSettings(db);
  if (hasDateTokens(settings.invoice_prefix)) {
    return nextNumberForDatedPrefix(db, expandInvoicePrefix(settings.invoice_prefix, settings.timezone));
  }
  const row = await db
    .prepare(
      `UPDATE settings SET next_invoice_number = next_invoice_number + 1
       WHERE id = 1 RETURNING next_invoice_number - 1 AS n, invoice_prefix`
    )
    .first<{ n: number; invoice_prefix: string }>();
  if (!row) throw new Error('failed to claim invoice number');
  return formatInvoiceNumber(row.invoice_prefix, row.n);
}

/** What claimInvoiceNumber would return, without advancing the counter (form prefill). */
export async function suggestedInvoiceNumber(db: D1Database, settings: Settings): Promise<string> {
  if (hasDateTokens(settings.invoice_prefix)) {
    return nextNumberForDatedPrefix(db, expandInvoicePrefix(settings.invoice_prefix, settings.timezone));
  }
  return formatInvoiceNumber(settings.invoice_prefix, settings.next_invoice_number);
}

export async function invoiceNumberExists(db: D1Database, number: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM invoices WHERE number = ?').bind(number).first();
  return row !== null;
}

// ---------- Clients ----------

export async function listClients(db: D1Database, includeArchived = false): Promise<Client[]> {
  const sql = includeArchived
    ? 'SELECT * FROM clients ORDER BY name'
    : 'SELECT * FROM clients WHERE archived = 0 ORDER BY name';
  return (await db.prepare(sql).all<Client>()).results;
}

export async function getClient(db: D1Database, id: number): Promise<Client | null> {
  return db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first<Client>();
}

export async function createClient(
  db: D1Database,
  c: Pick<Client, 'name' | 'email' | 'address' | 'default_rate_cents' | 'payment_terms_days'> &
    Partial<Pick<Client, 'locale'>>
): Promise<number> {
  const res = await db
    .prepare('INSERT INTO clients (name, email, address, default_rate_cents, payment_terms_days, locale) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(c.name, c.email, c.address, c.default_rate_cents, c.payment_terms_days, c.locale ?? null)
    .run();
  return res.meta.last_row_id;
}

export async function updateClient(
  db: D1Database,
  id: number,
  c: Pick<Client, 'name' | 'email' | 'address' | 'archived' | 'default_rate_cents' | 'payment_terms_days' | 'locale'>
): Promise<void> {
  await db
    .prepare('UPDATE clients SET name = ?, email = ?, address = ?, archived = ?, default_rate_cents = ?, payment_terms_days = ?, locale = ? WHERE id = ?')
    .bind(c.name, c.email, c.address, c.archived, c.default_rate_cents, c.payment_terms_days, c.locale, id)
    .run();
}

// ---------- Invoices ----------

export async function listInvoices(db: D1Database): Promise<InvoiceWithClient[]> {
  return (
    await db
      .prepare(
        `SELECT i.*, c.name AS client_name, c.email AS client_email, c.locale AS client_locale
         FROM invoices i JOIN clients c ON c.id = i.client_id
         ORDER BY i.id DESC`
      )
      .all<InvoiceWithClient>()
  ).results;
}

export async function getInvoice(db: D1Database, id: number): Promise<InvoiceWithClient | null> {
  return db
    .prepare(
      `SELECT i.*, c.name AS client_name, c.email AS client_email, c.locale AS client_locale
       FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`
    )
    .bind(id)
    .first<InvoiceWithClient>();
}

export async function getInvoiceByToken(db: D1Database, token: string): Promise<InvoiceWithClient | null> {
  return db
    .prepare(
      `SELECT i.*, c.name AS client_name, c.email AS client_email, c.locale AS client_locale
       FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.public_token = ?`
    )
    .bind(token)
    .first<InvoiceWithClient>();
}

export async function getInvoiceItems(db: D1Database, invoiceId: number): Promise<InvoiceItem[]> {
  return (
    await db
      .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position, id')
      .bind(invoiceId)
      .all<InvoiceItem>()
  ).results;
}

export async function getPayments(db: D1Database, invoiceId: number): Promise<Payment[]> {
  return (
    await db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id').bind(invoiceId).all<Payment>()
  ).results;
}

export type ItemDraft = ItemInput & { description: string };

export type InvoiceDraft = {
  client_id: number;
  issue_date: string;
  due_date: string | null;
  subject: string | null;
  notes: string | null;
  items: ItemDraft[];
};

/**
 * Create an invoice. `customNumber` (already validated as unused) bypasses the
 * auto counter, which then stays put for the next auto-numbered invoice.
 */
export async function createInvoice(db: D1Database, draft: InvoiceDraft, customNumber?: string): Promise<number> {
  const settings = await getSettings(db);
  const number = customNumber ?? (await claimInvoiceNumber(db));
  const totals = computeTotals(draft.items, settings.tax_rate_bps);

  // Header + items in ONE transactional batch so a failure can't strand a
  // header without its lines. Items reference the header via the UNIQUE
  // invoice number because last_row_id isn't available mid-batch.
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO invoices (number, client_id, currency, issue_date, due_date, subject, notes,
          tax_rate_bps, subtotal_cents, tax_cents, total_cents, public_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        number,
        draft.client_id,
        settings.currency,
        draft.issue_date,
        draft.due_date,
        draft.subject,
        draft.notes,
        settings.tax_rate_bps,
        totals.subtotal_cents,
        totals.tax_cents,
        totals.total_cents,
        newPublicToken()
      ),
    ...draft.items.map((it, i) =>
      db
        .prepare(
          `INSERT INTO invoice_items (invoice_id, position, description, quantity, unit_price_cents, amount_cents)
           VALUES ((SELECT id FROM invoices WHERE number = ?), ?, ?, ?, ?, ?)`
        )
        .bind(number, i, it.description, it.quantity, it.unit_price_cents, itemAmountCents(it))
    ),
  ]);
  return results[0].meta.last_row_id;
}

/** Replace all line items and refresh denormalized totals (keeps the invoice's tax snapshot). */
export async function updateInvoice(
  db: D1Database,
  invoiceId: number,
  draft: Omit<InvoiceDraft, 'client_id'> & { client_id?: number }
): Promise<void> {
  const inv = await getInvoice(db, invoiceId);
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  const totals = computeTotals(draft.items, inv.tax_rate_bps);
  // Header update + item replacement in ONE transactional batch — totals and
  // lines can never disagree because a partial failure rolls back both.
  await db.batch([
    db
      .prepare(
        `UPDATE invoices SET client_id = ?, issue_date = ?, due_date = ?, subject = ?, notes = ?,
          subtotal_cents = ?, tax_cents = ?, total_cents = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(
        draft.client_id ?? inv.client_id,
        draft.issue_date,
        draft.due_date,
        draft.subject,
        draft.notes,
        totals.subtotal_cents,
        totals.tax_cents,
        totals.total_cents,
        invoiceId
      ),
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(invoiceId),
    ...draft.items.map((it, i) =>
      db
        .prepare(
          `INSERT INTO invoice_items (invoice_id, position, description, quantity, unit_price_cents, amount_cents)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(invoiceId, i, it.description, it.quantity, it.unit_price_cents, itemAmountCents(it))
    ),
  ]);
}

/**
 * Mark a draft as sent, or adjust the sent date of an already-sent invoice.
 * Date precedence: explicit date > existing sent_at > now. Never touches
 * paid/void invoices.
 */
export async function markInvoiceSent(db: D1Database, invoiceId: number, sentDate?: string): Promise<void> {
  await db
    .prepare(
      `UPDATE invoices SET status = 'sent', sent_at = COALESCE(?, sent_at, datetime('now')),
        updated_at = datetime('now')
       WHERE id = ? AND status IN ('draft', 'sent')`
    )
    .bind(sentDate ?? null, invoiceId)
    .run();
}

/** Undo a send: sent -> draft, clearing the sent date. History keeps the events. */
export async function markInvoiceUnsent(db: D1Database, invoiceId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE invoices SET status = 'draft', sent_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND status = 'sent'`
    )
    .bind(invoiceId)
    .run();
}

export async function setInvoiceStatus(db: D1Database, invoiceId: number, status: InvoiceStatus): Promise<void> {
  await db
    .prepare(`UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(status, invoiceId)
    .run();
}

/**
 * Hard-delete an invoice of any status. Payments must go explicitly (no
 * ON DELETE CASCADE on that FK); items and events cascade. Deleting a paid
 * invoice erases its payment records from reports — and never refunds
 * anything at the provider.
 */
export async function deleteInvoice(db: D1Database, invoiceId: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM payments WHERE invoice_id = ?').bind(invoiceId),
    db.prepare('DELETE FROM invoices WHERE id = ?').bind(invoiceId),
  ]);
}

export async function setPaypalOrderId(db: D1Database, invoiceId: number, orderId: string): Promise<void> {
  await db.prepare('UPDATE invoices SET paypal_order_id = ? WHERE id = ?').bind(orderId, invoiceId).run();
}

export async function getInvoiceByPaypalOrderId(db: D1Database, orderId: string): Promise<Invoice | null> {
  return db.prepare('SELECT * FROM invoices WHERE paypal_order_id = ?').bind(orderId).first<Invoice>();
}

// ---------- Events / timeline ----------

export type InvoiceEvent = {
  id: number;
  invoice_id: number;
  type:
    | 'sent'
    | 'unsent'
    | 'emailed'
    | 'edited'
    | 'voided'
    | 'payment_undone'
    | 'sent_date_changed'
    | 'payment_note_edited'
    | 'duplicated'
    | 'viewed'
    | 'reminder';
  detail: string | null;
  created_at: string;
};

export async function logInvoiceEvent(
  db: D1Database,
  invoiceId: number,
  type: InvoiceEvent['type'],
  detail?: string
): Promise<void> {
  await db
    .prepare('INSERT INTO invoice_events (invoice_id, type, detail) VALUES (?, ?, ?)')
    .bind(invoiceId, type, detail ?? null)
    .run();
}

/**
 * Record a pay-link view, at most one per 24h per invoice. The first view
 * ever is labeled as such — that's the "client has seen it" signal.
 */
export async function recordInvoiceView(db: D1Database, invoiceId: number, geo: string | null): Promise<void> {
  const recent = await db
    .prepare(
      `SELECT
         MAX(created_at > datetime('now', '-24 hours')) AS recently,
         COUNT(*) AS total
       FROM invoice_events WHERE invoice_id = ? AND type = 'viewed'`
    )
    .bind(invoiceId)
    .first<{ recently: number | null; total: number }>();
  if (recent?.recently) return;
  const detail = [recent?.total === 0 ? 'First view' : null, geo].filter(Boolean).join(' — ');
  await logInvoiceEvent(db, invoiceId, 'viewed', detail || undefined);
}

export async function getInvoiceEvents(db: D1Database, invoiceId: number): Promise<InvoiceEvent[]> {
  return (
    await db
      .prepare('SELECT * FROM invoice_events WHERE invoice_id = ? ORDER BY id')
      .bind(invoiceId)
      .all<InvoiceEvent>()
  ).results;
}

export type TimelineEntry = {
  at: string;
  label: string;
  detail: string | null;
  kind: 'created' | 'sent' | 'payment' | InvoiceEvent['type'];
  /** Set for entries backed by an invoice_events row — enables per-entry actions */
  eventId?: number;
};

/**
 * Merged activity history, ordered by when each thing was RECORDED — a log,
 * not a calendar. Backdated effective dates (payments, sent dates) appear in
 * the entry text instead of reshuffling the order. Ties keep insertion order
 * (JS sort is stable), so "received" always precedes its own "undone".
 */
export function buildTimeline(
  invoice: Invoice,
  payments: Payment[],
  events: InvoiceEvent[],
  formatAmount: (cents: number, currency: string) => string
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    { at: invoice.created_at, label: 'Created', detail: `Invoice ${invoice.number}`, kind: 'created' },
  ];
  // Legacy fallback: invoices sent before 'sent' events were logged. A
  // backdated sent_at would sort before Created, so clamp it.
  if (invoice.sent_at && !events.some((e) => e.type === 'sent')) {
    const backdated = invoice.sent_at < invoice.created_at;
    entries.push({
      at: backdated ? invoice.created_at : invoice.sent_at,
      label: 'Sent',
      detail: backdated ? `Dated ${invoice.sent_at.slice(0, 10)}` : null,
      kind: 'sent',
    });
  }
  for (const p of payments) {
    // A payment can't be recorded before its invoice existed — clamps legacy
    // date-only rows that would otherwise sort above Created.
    let at = p.recorded_at ?? p.created_at;
    if (at < invoice.created_at) at = invoice.created_at;
    const backdated = p.created_at.slice(0, 10) !== at.slice(0, 10);
    entries.push({
      at,
      label: `Payment received — ${formatAmount(p.amount_cents, p.currency)} via ${p.provider}${
        backdated ? ` (dated ${p.created_at.slice(0, 10)})` : ''
      }`,
      detail: p.note,
      kind: 'payment',
    });
  }
  const labels: Record<InvoiceEvent['type'], string> = {
    sent: 'Sent',
    unsent: 'Reverted to draft',
    emailed: 'Emailed',
    edited: 'Edited',
    voided: 'Voided',
    payment_undone: 'Payment undone',
    sent_date_changed: 'Sent date updated',
    payment_note_edited: 'Payment note updated',
    duplicated: 'Created by duplicating',
    viewed: 'Link opened',
    reminder: 'Reminder emailed',
  };
  for (const e of events) {
    entries.push({ at: e.created_at, label: labels[e.type], detail: e.detail, kind: e.type, eventId: e.id });
  }
  // Ascending stable sort, then reverse: most recent first, and within ties
  // the later action ("undone") correctly appears above its "received".
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).reverse();
}

/** Remove a pay-link view from the history. Only 'viewed' events are
 *  removable — the rest of the timeline is an audit log. */
export async function deleteViewEvent(db: D1Database, invoiceId: number, eventId: number): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM invoice_events WHERE id = ? AND invoice_id = ? AND type = 'viewed'")
    .bind(eventId, invoiceId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ---------- Payments / webhook idempotency ----------

/**
 * Manual "mark as paid" from the admin UI, with an optional note (check no.,
 * context) and an optional payment date (YYYY-MM-DD, for backdating a check
 * that arrived earlier). Defaults to now.
 */
export async function recordManualPayment(
  db: D1Database,
  invoice: Invoice,
  opts: { note?: string; paidDate?: string } = {}
): Promise<void> {
  const paidDate = opts.paidDate || null; // COALESCEs to now in SQL
  await db.batch([
    db
      .prepare(
        `INSERT INTO payments (invoice_id, provider, provider_ref, amount_cents, currency, note, created_at, recorded_at)
         VALUES (?, 'manual', ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))`
      )
      .bind(
        invoice.id,
        `manual-${invoice.id}-${Date.now()}`,
        invoice.total_cents,
        invoice.currency,
        opts.note || null,
        paidDate
      ),
    db
      .prepare(
        `UPDATE invoices SET status = 'paid', paid_at = COALESCE(?, datetime('now')), updated_at = datetime('now')
         WHERE id = ? AND status IN ('draft', 'sent')`
      )
      .bind(paidDate, invoice.id),
  ]);
}

// ---------- Reports ----------

export type MonthlyReportRow = {
  ym: string; // "2026-07"
  invoiced_count: number;
  invoiced_cents: number;
  received_count: number;
  received_cents: number;
};

export type ReportSummary = {
  outstanding_cents: number; // sent, not yet paid
  outstanding_count: number;
  overdue_count: number;
  received_ytd_cents: number;
};

/**
 * Per-month activity, newest first. "Invoiced" = non-draft, non-void invoices
 * by issue date; "received" = payment rows by receipt date.
 */
export async function monthlyReport(db: D1Database, clientId: number | null = null): Promise<MonthlyReportRow[]> {
  // ?1 = client filter; NULL means all clients (the OR short-circuits it)
  const [inv, pay] = await db.batch<{ ym: string; n: number; total: number }>([
    db.prepare(
      `SELECT strftime('%Y-%m', issue_date) AS ym, COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS total
       FROM invoices WHERE status IN ('sent', 'paid') AND (?1 IS NULL OR client_id = ?1) GROUP BY ym`
    ).bind(clientId),
    db.prepare(
      `SELECT strftime('%Y-%m', p.created_at) AS ym, COUNT(*) AS n, COALESCE(SUM(p.amount_cents), 0) AS total
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE p.undone_at IS NULL AND (?1 IS NULL OR i.client_id = ?1) GROUP BY ym`
    ).bind(clientId),
  ]);

  const months = new Map<string, MonthlyReportRow>();
  const row = (ym: string): MonthlyReportRow => {
    let r = months.get(ym);
    if (!r) {
      r = { ym, invoiced_count: 0, invoiced_cents: 0, received_count: 0, received_cents: 0 };
      months.set(ym, r);
    }
    return r;
  };
  for (const r of inv.results) {
    const m = row(r.ym);
    m.invoiced_count = r.n;
    m.invoiced_cents = r.total;
  }
  for (const r of pay.results) {
    const m = row(r.ym);
    m.received_count = r.n;
    m.received_cents = r.total;
  }
  return [...months.values()].sort((a, b) => (a.ym < b.ym ? 1 : -1));
}

export type PaymentListRow = {
  id: number;
  invoice_id: number;
  invoice_number: string;
  client_id: number;
  client_name: string;
  provider: string;
  provider_ref: string | null;
  stripe_payment_intent: string | null;
  amount_cents: number;
  currency: string;
  note: string | null;
  created_at: string;
  undone_at: string | null;
};

/** Every payment across all invoices, newest first — undone ones included
 *  (the page renders them struck through, matching invoice history).
 *  ?1 = client filter; NULL means all clients. */
export async function listAllPayments(
  db: D1Database,
  clientId: number | null = null
): Promise<PaymentListRow[]> {
  return (
    await db
      .prepare(
        `SELECT p.id, p.invoice_id, i.number AS invoice_number, i.client_id, c.name AS client_name,
                p.provider, p.provider_ref, p.stripe_payment_intent, p.amount_cents, p.currency,
                p.note, p.created_at, p.undone_at
         FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id
         WHERE (?1 IS NULL OR i.client_id = ?1)
         ORDER BY p.created_at DESC, p.id DESC`
      )
      .bind(clientId)
      .all<PaymentListRow>()
  ).results;
}

export async function reportSummary(
  db: D1Database,
  today: string,
  clientId: number | null = null
): Promise<ReportSummary> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COALESCE(SUM(total_cents), 0) FROM invoices
          WHERE status = 'sent' AND (?2 IS NULL OR client_id = ?2)) AS outstanding_cents,
        (SELECT COUNT(*) FROM invoices
          WHERE status = 'sent' AND (?2 IS NULL OR client_id = ?2)) AS outstanding_count,
        (SELECT COUNT(*) FROM invoices
          WHERE status = 'sent' AND due_date IS NOT NULL AND due_date < ?1
            AND (?2 IS NULL OR client_id = ?2)) AS overdue_count,
        (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p JOIN invoices i ON i.id = p.invoice_id
          WHERE p.undone_at IS NULL
            AND strftime('%Y', p.created_at) = substr(?1, 1, 4)
            AND (?2 IS NULL OR i.client_id = ?2)) AS received_ytd_cents`
    )
    .bind(today, clientId)
    .first<ReportSummary>();
  if (!row) throw new Error('report summary query returned nothing');
  return row;
}

/**
 * Undo a recorded payment: soft-delete the row (undone_at) so history keeps
 * the original record, log the audit event, and — when no active payments
 * remain — revert a paid invoice to 'sent' (or back to 'draft' if it was
 * never sent). Runs as one atomic batch. Does NOT refund anything at the
 * provider; it only corrects this app's books.
 */
export async function undoPayment(
  db: D1Database,
  invoiceId: number,
  paymentId: number,
  formatAmount: (cents: number, currency: string) => string
): Promise<boolean> {
  const payment = await db
    .prepare('SELECT * FROM payments WHERE id = ? AND invoice_id = ? AND undone_at IS NULL')
    .bind(paymentId, invoiceId)
    .first<Payment>();
  if (!payment) return false;

  const detail = `${formatAmount(payment.amount_cents, payment.currency)} via ${payment.provider}${
    payment.note ? ` (${payment.note})` : ''
  }`;
  await db.batch([
    db.prepare(`UPDATE payments SET undone_at = datetime('now') WHERE id = ?`).bind(paymentId),
    db
      .prepare(`INSERT INTO invoice_events (invoice_id, type, detail) VALUES (?, 'payment_undone', ?)`)
      .bind(invoiceId, detail),
    db
      .prepare(
        `UPDATE invoices SET
          status = CASE WHEN sent_at IS NULL THEN 'draft' ELSE 'sent' END,
          paid_at = NULL,
          updated_at = datetime('now')
         WHERE id = ? AND status = 'paid'
           AND NOT EXISTS (SELECT 1 FROM payments WHERE invoice_id = ? AND undone_at IS NULL)`
      )
      .bind(invoiceId, invoiceId),
  ]);
  return true;
}

/** Edit the free-text note on an active payment. Returns false if not found. */
export async function updatePaymentNote(
  db: D1Database,
  invoiceId: number,
  paymentId: number,
  note: string | null
): Promise<boolean> {
  const res = await db
    .prepare('UPDATE payments SET note = ? WHERE id = ? AND invoice_id = ? AND undone_at IS NULL')
    .bind(note, paymentId, invoiceId)
    .run();
  return res.meta.changes > 0;
}

export type WebhookPayment = {
  provider: 'stripe' | 'paypal';
  eventId: string;
  eventType: string;
  payload: string;
  invoiceId: number;
  providerRef: string;
  amountCents: number;
  currency: string;
  paymentIntent?: string | null;
};

/**
 * Idempotently record a payment webhook and mark the invoice paid.
 *
 * Returns:
 *  - 'paid'      this call performed the unpaid -> paid transition (receipt
 *                and paid-notice emails were enqueued in the same transaction)
 *  - 'recorded'  event was new but the invoice was already paid (e.g. the
 *                webhook arriving after PayPal's capture-on-return)
 *  - 'duplicate' event id already processed
 *
 * Everything — event row, payment, invoice transition, email enqueue — is one
 * D1 batch, which is transactional and rolls back together. A transient
 * failure therefore commits nothing, so the provider's retry starts clean;
 * the event row can never exist without its payment (the bug this replaced).
 *
 * Guards: UNIQUE(provider, event_id) on webhook_events (guard #1 — a
 * duplicate fails the whole batch and is caught below), UNIQUE(provider,
 * provider_ref) on payments (guard #2, handled inline via ON CONFLICT), and a
 * status filter on the UPDATE so a paid/void invoice never double-transitions.
 * The outbox INSERTs run before the UPDATE and share its status filter, so
 * emails are enqueued exactly when this call performs the transition.
 */
export async function markInvoicePaidFromWebhook(
  db: D1Database,
  p: WebhookPayment
): Promise<'paid' | 'recorded' | 'duplicate'> {
  const emailPayload = JSON.stringify({
    invoiceId: p.invoiceId,
    amountCents: p.amountCents,
    currency: p.currency,
    provider: p.provider === 'stripe' ? 'Stripe' : 'PayPal',
  });
  const enqueue = (kind: string) =>
    db
      .prepare(
        `INSERT INTO email_outbox (kind, payload)
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status IN ('draft', 'sent'))`
      )
      .bind(kind, emailPayload, p.invoiceId);

  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare('INSERT INTO webhook_events (provider, event_id, event_type, payload) VALUES (?, ?, ?, ?)')
        .bind(p.provider, p.eventId, p.eventType, p.payload),
      enqueue('payment_receipt'),
      enqueue('paid_notice'),
      db
        .prepare(
          // If this exact provider payment was undone in-app and the provider
          // redelivers, resurrect it — the provider is the source of truth.
          `INSERT INTO payments (invoice_id, provider, provider_ref, amount_cents, currency, recorded_at, stripe_payment_intent)
           VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
           ON CONFLICT (provider, provider_ref) DO UPDATE SET
             undone_at = NULL,
             stripe_payment_intent = COALESCE(excluded.stripe_payment_intent, stripe_payment_intent)`
        )
        .bind(p.invoiceId, p.provider, p.providerRef, p.amountCents, p.currency, p.paymentIntent ?? null),
      db
        .prepare(
          `UPDATE invoices SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND status IN ('draft', 'sent')`
        )
        .bind(p.invoiceId),
    ]);
  } catch (e) {
    // Only webhook_events can raise UNIQUE here (payments handles its own
    // conflict inline), so this means: already processed, nothing committed.
    if (String(e).includes('UNIQUE')) return 'duplicate';
    throw e;
  }
  const transitioned = (results[4]?.meta?.changes ?? 0) > 0;
  return transitioned ? 'paid' : 'recorded';
}

// ---------- Logo (uploaded, stored in D1; wins over settings.logo_url) ----------

export type Logo = { bytes: Uint8Array; mime: string; updated_at: string };

export async function getLogo(db: D1Database): Promise<Logo | null> {
  const row = await db
    .prepare('SELECT bytes, mime, updated_at FROM logo WHERE id = 1')
    .first<{ bytes: ArrayBuffer | number[]; mime: string; updated_at: string }>();
  if (!row) return null;
  // D1 returns BLOBs as ArrayBuffer (or a number[] via the JSON path) — normalize.
  const bytes = row.bytes instanceof ArrayBuffer ? new Uint8Array(row.bytes) : Uint8Array.from(row.bytes);
  return { bytes, mime: row.mime, updated_at: row.updated_at };
}

export async function setLogo(db: D1Database, bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO logo (id, bytes, mime, updated_at) VALUES (1, ?, ?, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET bytes = excluded.bytes, mime = excluded.mime, updated_at = datetime('now')`
    )
    .bind(bytes, mime)
    .run();
}

export async function deleteLogo(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM logo WHERE id = 1').run();
}

// ---------- Email outbox (durable side-effect delivery) ----------

export type OutboxKind = 'payment_receipt' | 'paid_notice' | 'reminder';
export type OutboxRow = { id: number; kind: OutboxKind; payload: string; attempts: number };

/** Pending deliveries that are due now, oldest first. */
export async function listDueOutbox(db: D1Database, maxAttempts: number, limit = 25): Promise<OutboxRow[]> {
  return (
    await db
      .prepare(
        `SELECT id, kind, payload, attempts FROM email_outbox
         WHERE sent_at IS NULL AND attempts < ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
         ORDER BY id LIMIT ?`
      )
      .bind(maxAttempts, limit)
      .all<OutboxRow>()
  ).results;
}

export async function markOutboxSent(db: D1Database, id: number): Promise<void> {
  // sent_at guard: overlapping drains may both deliver; only one completes.
  await db.prepare(`UPDATE email_outbox SET sent_at = datetime('now') WHERE id = ? AND sent_at IS NULL`).bind(id).run();
}

export async function markOutboxFailed(db: D1Database, id: number, error: string, retryInMinutes: number): Promise<void> {
  await db
    .prepare(
      `UPDATE email_outbox SET attempts = attempts + 1, last_error = ?,
         next_attempt_at = datetime('now', '+' || ? || ' minutes')
       WHERE id = ?`
    )
    .bind(error.slice(0, 500), retryInMinutes, id)
    .run();
}

/**
 * Enqueue an overdue reminder, deduplicated on (invoice, reminderNumber): the
 * cadence counter derives from DELIVERED reminders (invoice_events rows that
 * markReminderSent writes), so while reminder N sits undelivered in the
 * outbox, every later cron run re-derives "reminder N is due" — INSERT OR
 * IGNORE makes those re-enqueues no-ops instead of a stack of duplicates
 * that would all fire when an email outage ends.
 */
export async function enqueueReminder(
  db: D1Database,
  payload: { invoiceId: number; payUrl: string; reminderNumber: number }
): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO email_outbox (kind, payload, dedup_key) VALUES ('reminder', ?, ?)`)
    .bind(JSON.stringify(payload), `reminder:${payload.invoiceId}:${payload.reminderNumber}`)
    .run();
}

/**
 * Record a DELIVERED reminder: the history event (which is what the cadence
 * counter and the invoice timeline read) and the outbox completion commit
 * together, only after the send succeeded. Both statements are gated on the
 * outbox row still being unsent, so when overlapping drains both deliver the
 * same row (at-least-once email), only ONE writes the event — a duplicate
 * event would advance the cadence counter and skip the next scheduled
 * reminder.
 */
export async function markReminderSent(
  db: D1Database,
  outboxId: number,
  invoiceId: number,
  detail: string
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO invoice_events (invoice_id, type, detail)
         SELECT ?, 'reminder', ? WHERE EXISTS (SELECT 1 FROM email_outbox WHERE id = ? AND sent_at IS NULL)`
      )
      .bind(invoiceId, detail, outboxId),
    db.prepare(`UPDATE email_outbox SET sent_at = datetime('now') WHERE id = ? AND sent_at IS NULL`).bind(outboxId),
  ]);
}

/**
 * Cancel a pending outbox row whose delivery would now be wrong (invoice paid
 * or voided, email turned off). DELETE rather than mark-sent: deletion frees
 * the dedup_key, so if the situation reverses (payment undone, email back on)
 * the same reminder number can be enqueued again instead of being blocked
 * until the 30-day purge. The sent_at guard keeps this a no-op when an
 * overlapping drain already delivered the row.
 */
export async function cancelOutboxRow(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM email_outbox WHERE id = ? AND sent_at IS NULL`).bind(id).run();
}

/** Drop delivered rows and exhausted failures once they're a month old. */
export async function purgeOldOutbox(db: D1Database, maxAttempts: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM email_outbox
       WHERE (sent_at IS NOT NULL OR attempts >= ?) AND created_at < datetime('now', '-30 days')`
    )
    .bind(maxAttempts)
    .run();
}

// ---------- Login rate limiting (password mode) ----------

/**
 * Atomically consume one login attempt for this IP and return the count now
 * used in the current window (a lapsed window restarts at 1). Single
 * upsert-with-RETURNING so N parallel requests get N distinct counts — the
 * check-then-increment race this replaced let simultaneous requests all see
 * a below-limit counter.
 */
export async function recordLoginAttempt(db: D1Database, ip: string, windowMinutes: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO login_attempts (ip, window_start, attempts) VALUES (?, datetime('now'), 1)
       ON CONFLICT (ip) DO UPDATE SET
         attempts = CASE WHEN window_start < datetime('now', '-' || ? || ' minutes') THEN 1 ELSE attempts + 1 END,
         window_start = CASE WHEN window_start < datetime('now', '-' || ? || ' minutes') THEN datetime('now') ELSE window_start END
       RETURNING attempts`
    )
    .bind(ip, windowMinutes, windowMinutes)
    .first<{ attempts: number }>();
  return row?.attempts ?? 1;
}

export async function clearLoginAttempts(db: D1Database, ip: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
}

/** Housekeeping for the cron: rows whose window lapsed long ago are dead weight. */
export async function purgeOldLoginAttempts(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM login_attempts WHERE window_start < datetime('now', '-1 day')`).run();
}
