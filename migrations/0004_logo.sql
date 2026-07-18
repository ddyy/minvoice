-- Uploaded logo, stored in D1 (logos are tens of KB; no extra binding needed,
-- unlike R2 which requires billing setup even on its free tier). Lives in its
-- own single-row table so `SELECT * FROM settings` never drags the blob along.
-- When a row exists it takes precedence over settings.logo_url.
CREATE TABLE logo (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bytes BLOB NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
