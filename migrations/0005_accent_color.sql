-- Brand accent color for customer-facing surfaces (email header rule, buttons,
-- links; PDF brand tape and PAID stamp). Hex string; defaults to the built-in
-- Ledger green so existing installs are unchanged.
ALTER TABLE settings ADD COLUMN accent_color TEXT NOT NULL DEFAULT '#1e5b43';
