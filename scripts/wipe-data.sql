-- Wipe all transactional data, keep business settings.
-- Usage: npm run db:wipe:local | db:wipe:test | db:wipe:prod
-- Production safety net: D1 Time Travel can restore any point in the last 30 days.

DELETE FROM invoice_events;
DELETE FROM payments;
DELETE FROM webhook_events;
DELETE FROM invoice_items;
DELETE FROM invoices;
DELETE FROM clients;

-- Fresh numbering: invoice counter back to 1, AUTOINCREMENT ids restart
UPDATE settings SET next_invoice_number = 1 WHERE id = 1;
DELETE FROM sqlite_sequence
WHERE name IN ('invoice_events', 'payments', 'webhook_events', 'invoice_items', 'invoices', 'clients');
