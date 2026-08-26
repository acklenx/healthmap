-- D1 schema for push alerts.
--
-- Apply with:
--   npx wrangler d1 execute score --remote --file=schema.sql
--
-- There are no user accounts. A subscription is identified only by the opaque
-- push endpoint the browser mints, and the only thing stored against it is the
-- list of establishment ids that install has saved.

CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint   TEXT PRIMARY KEY,
  places     TEXT NOT NULL,          -- JSON array of establishment ids
  updated_at INTEGER NOT NULL
);

-- Queued alert text. Pushes are sent without a payload; the service worker
-- drains this table to build the notification, so an alert that arrives while
-- the device is offline still shows the right thing later.
CREATE TABLE IF NOT EXISTS pending (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint        TEXT NOT NULL,
  place_id        INTEGER NOT NULL,
  name            TEXT NOT NULL,
  inspection_date TEXT NOT NULL,
  score           INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pending_endpoint ON pending (endpoint);
