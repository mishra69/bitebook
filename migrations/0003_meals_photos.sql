-- Meals and their photos. Every row carries user_id and every query filters on it (D9).
CREATE TABLE meals (
  id          TEXT PRIMARY KEY,                -- ULID, generated on the device
  user_id     TEXT NOT NULL REFERENCES users(id),
  taken_at    TEXT NOT NULL,                   -- ISO 8601 with the device's UTC offset
  taken_ms    INTEGER NOT NULL,                -- same instant as epoch ms, for ordering
  tz          TEXT NOT NULL,                   -- IANA zone, e.g. 'America/Chicago'
  meal_type   TEXT CHECK (meal_type IN ('breakfast','lunch','dinner','snack')),
  note        TEXT,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT                             -- soft delete; corpus rows are never hard-deleted
);
CREATE INDEX meals_by_user_time ON meals (user_id, taken_ms);

CREATE TABLE photos (
  id               TEXT PRIMARY KEY,           -- ULID, generated on the device
  user_id          TEXT NOT NULL REFERENCES users(id),
  meal_id          TEXT NOT NULL REFERENCES meals(id),
  position         INTEGER NOT NULL,           -- order within the meal
  original_key     TEXT NOT NULL,              -- R2 key; kept after roll-off for reference
  original_mime    TEXT NOT NULL,
  original_bytes   INTEGER NOT NULL,
  original_sha256  TEXT NOT NULL,              -- computed on device, verified by the Worker
  original_status  TEXT NOT NULL DEFAULT 'r2' CHECK (original_status IN ('r2','archived_local')),
  archived_at      TEXT,
  display_key      TEXT NOT NULL,
  display_bytes    INTEGER NOT NULL,
  width            INTEGER,
  height           INTEGER
);
CREATE INDEX photos_by_user_meal ON photos (user_id, meal_id);
