-- What the phone saw while uploading (D23): request timings and outcomes, the app going
-- to the background, the network dropping. Logged on the phone first and sent later,
-- so t_ms (the phone's clock) is when it happened. Kept 30 days (src/worker/purge.ts).
CREATE TABLE diag_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id),
  t_ms         INTEGER NOT NULL,
  type         TEXT NOT NULL,
  data         TEXT NOT NULL,              -- JSON: the whole event as the phone logged it
  received_at  TEXT NOT NULL
);
CREATE INDEX diag_events_by_user_time ON diag_events (user_id, t_ms);
