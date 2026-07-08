-- Minvoice schema (consolidated pre-release, 2026-07).
-- Money is integer cents; tax rates are basis points. Timestamps are UTC;
-- the business time zone (settings.timezone) drives display and date logic.

-- Singleton business settings (CHECK id = 1), seeded below. setup_complete = 0
-- forces the first-launch wizard.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT NOT NULL DEFAULT '',
  business_address TEXT NOT NULL DEFAULT '',
  business_email TEXT,
  logo_url TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  invoice_prefix TEXT NOT NULL DEFAULT 'INV-',
  next_invoice_number INTEGER NOT NULL DEFAULT 1,
  default_rate_cents INTEGER NOT NULL DEFAULT 0,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  email_provider TEXT NOT NULL DEFAULT 'cloudflare',
  email_from TEXT NOT NULL DEFAULT '',
  setup_complete INTEGER NOT NULL DEFAULT 0,
  -- Per-provider toggles + optional in-app credentials. Precedence: wrangler
  -- secrets (encrypted at rest) always win over these columns; storing keys
  -- here is the convenience path for zero-CLI setups.
  stripe_enabled INTEGER NOT NULL DEFAULT 1,
  paypal_enabled INTEGER NOT NULL DEFAULT 1,
  stripe_secret_key TEXT NOT NULL DEFAULT '',
  stripe_webhook_secret TEXT NOT NULL DEFAULT '',
  paypal_client_id TEXT NOT NULL DEFAULT '',
  paypal_client_secret TEXT NOT NULL DEFAULT '',
  paypal_webhook_id TEXT NOT NULL DEFAULT '',
  resend_api_key TEXT NOT NULL DEFAULT '',
  -- PayPal environment selector (live | sandbox); PAYPAL_API_BASE var wins when set
  paypal_environment TEXT NOT NULL DEFAULT 'live',
  -- Overdue payment reminders (opt-in; daily cron). last_seen_origin records
  -- the public origin from real pay-page traffic so the cron can build pay
  -- links on deployments without APP_BASE_URL (workers.dev / one-click).
  reminders_enabled INTEGER NOT NULL DEFAULT 0,
  last_seen_origin TEXT NOT NULL DEFAULT '',
  -- Comma-separated days-overdue thresholds; one reminder per entry
  reminder_schedule TEXT NOT NULL DEFAULT '1, 7, 14'
);

INSERT INTO settings (id) VALUES (1);

CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  address TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  -- NULL = inherit the settings-level default
  default_rate_cents INTEGER,
  payment_terms_days INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  currency TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  subject TEXT,
  notes TEXT,
  -- Snapshotted at creation; totals are computed once and stored
  tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  -- Unguessable pay-link capability token
  public_token TEXT NOT NULL UNIQUE,
  paypal_order_id TEXT,
  sent_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
);

-- No ON DELETE CASCADE: deleting an invoice must remove payments explicitly
-- (deleteInvoice does) so books are never silently orphaned.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal', 'manual')),
  provider_ref TEXT,
  stripe_payment_intent TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  note TEXT,
  -- Soft undo: NULL means the payment counts; History keeps both entries
  undone_at TEXT,
  -- Effective (possibly backdated) date vs record time (created_at)
  recorded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Webhook idempotency guard #2
  UNIQUE (provider, provider_ref)
);

-- Webhook idempotency guard #1: replays and double-deliveries are no-ops
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, event_id)
);

-- Activity timeline: edits, sends, emails, payment undo, views, ...
CREATE TABLE invoice_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_items_invoice ON invoice_items(invoice_id);
CREATE INDEX idx_events_invoice ON invoice_events(invoice_id);
