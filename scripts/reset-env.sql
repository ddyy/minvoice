-- Factory reset: wipe all data AND restore settings to defaults, which
-- re-arms the first-launch setup wizard on the next /admin visit.
-- Usage: npm run db:reset:local | db:reset:test | db:reset:prod

DELETE FROM invoice_events;
DELETE FROM payments;
DELETE FROM webhook_events;
DELETE FROM invoice_items;
DELETE FROM invoices;
DELETE FROM clients;
DELETE FROM sqlite_sequence
WHERE name IN ('invoice_events', 'payments', 'webhook_events', 'invoice_items', 'invoices', 'clients');

-- A factory reset also revokes every MCP connection: registered OAuth clients,
-- pending codes, and access/refresh tokens. (wipe-data.sql keeps them on
-- purpose: it preserves business continuity, and grants belong to the owner.)
DELETE FROM oauth_codes;
DELETE FROM oauth_tokens;
DELETE FROM oauth_clients;

UPDATE settings SET
  business_name = '',
  business_address = '',
  business_email = NULL,
  logo_url = NULL,
  currency = 'USD',
  tax_rate_bps = 0,
  invoice_prefix = 'INV-',
  next_invoice_number = 1,
  default_rate_cents = 0,
  timezone = 'UTC',
  email_provider = 'cloudflare',
  email_from = '',
  payment_terms_days = 0,
  setup_complete = 0
WHERE id = 1;
