-- Reminders by Web Push (D25). One row per device subscription; tz is the device's zone,
-- refreshed on every app open, and decides when "10:30 pm" and "morning" are.
CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,               -- the push service URL; unique per device
  user_id     TEXT NOT NULL REFERENCES users(id),
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  tz          TEXT,                           -- IANA zone, e.g. 'America/Chicago'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX push_subscriptions_by_user ON push_subscriptions (user_id);

-- One row per reminder sent, so a reminder goes out at most once per local day (and the
-- morning one once per gap without meals).
CREATE TABLE reminders_sent (
  user_id     TEXT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL CHECK (kind IN ('nightly','morning')),
  local_date  TEXT NOT NULL,                  -- YYYY-MM-DD in the user's zone
  sent_ms     INTEGER NOT NULL,
  result      TEXT NOT NULL,                  -- JSON: devices sent / failed / pruned
  PRIMARY KEY (user_id, kind, local_date)
);
