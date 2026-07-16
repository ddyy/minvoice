-- Durable email delivery + login rate limiting.
--
-- email_outbox: side-effect emails (payment receipts, paid notices, reminders)
-- are enqueued in the same transaction as the state change that caused them,
-- then delivered at-least-once: an immediate attempt right after the request,
-- with the daily cron retrying failures (capped attempts, growing backoff).
CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('payment_receipt', 'paid_notice', 'reminder')),
  payload TEXT NOT NULL, -- JSON, per-kind shape; see services/outbox.ts
  -- Dedup for enqueuers that may retry across runs (reminders): INSERT OR
  -- IGNORE on this key means "already queued" is a no-op, so an undelivered
  -- reminder can't stack duplicates behind an outage. NULL = no dedup.
  dedup_key TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT, -- NULL = ready now; else datetime('now') must pass it
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX idx_email_outbox_pending ON email_outbox (sent_at, next_attempt_at);

-- login_attempts: per-IP attempt counter for the password auth mode. Each
-- login POST consumes an attempt ATOMICALLY (upsert + RETURNING) before the
-- password is checked, so parallel requests can't slip under the limit.
-- Row resets when the window lapses and is deleted on successful login.
CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  window_start TEXT NOT NULL DEFAULT (datetime('now')),
  attempts INTEGER NOT NULL DEFAULT 0
);
