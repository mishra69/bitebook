-- Apple Health export through an iOS Shortcut (D34). A Shortcut can't do Google sign-in,
-- so each user can create one key for it; only its SHA-256 is stored.
CREATE TABLE health_keys (
  id            TEXT PRIMARY KEY,               -- ULID
  user_id       TEXT NOT NULL REFERENCES users(id),
  key_hash      TEXT NOT NULL UNIQUE,           -- hex SHA-256 of the key
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);
CREATE INDEX health_keys_by_user ON health_keys (user_id);

-- One row per Shortcut run: the meals it was handed, and when it confirmed logging them.
CREATE TABLE health_runs (
  id          TEXT PRIMARY KEY,                 -- ULID; the confirm URL carries it
  user_id     TEXT NOT NULL REFERENCES users(id),
  meal_ids    TEXT NOT NULL,                    -- JSON array
  created_at  TEXT NOT NULL,
  done_at     TEXT
);
CREATE INDEX health_runs_by_user ON health_runs (user_id, created_at);

-- What each meal sent to Health was: a Shortcut can add samples but never change or delete
-- them, so this is also how a later revision of a sent meal is noticed.
CREATE TABLE health_exports (
  meal_id      TEXT PRIMARY KEY REFERENCES meals(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  analysis_id  TEXT NOT NULL REFERENCES analyses(id),
  run_id       TEXT NOT NULL REFERENCES health_runs(id),
  values_json  TEXT NOT NULL,                   -- kcal, protein_g, carbs_g, fat_g, fiber_g as sent
  exported_at  TEXT NOT NULL
);
CREATE INDEX health_exports_by_user ON health_exports (user_id);
