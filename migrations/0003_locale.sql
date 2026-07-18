-- Customer-facing locale. A BCP-47 tag: the language part selects the strings
-- (en/es/de/fr, see src/lib/strings/), the full tag drives Intl date/number
-- formatting — so 'de-AT' gets German strings with Austrian formatting.
-- The admin UI stays English; only what customers see is localized.
ALTER TABLE settings ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';
-- Per-client override for businesses invoicing across languages (NULL = inherit).
ALTER TABLE clients ADD COLUMN locale TEXT;
