-- The API path (D27, D28): meals analyzed automatically through OpenRouter, with the
-- model's questions and the user's corrections handled in the app.

-- The model a user's meals are analyzed with (an OpenRouter id, e.g.
-- 'anthropic/claude-opus-5.5'); null means automatic analysis is off.
ALTER TABLE users ADD COLUMN api_model TEXT;

-- What each API run cost, as the provider reported it, so cost per meal, per day and per
-- person can be measured. Chat batches leave these null.
ALTER TABLE batches ADD COLUMN input_tokens INTEGER;
ALTER TABLE batches ADD COLUMN output_tokens INTEGER;
ALTER TABLE batches ADD COLUMN cost_usd REAL;
ALTER TABLE batches ADD COLUMN latency_ms INTEGER;

-- Questions the model asks on the API path are answered later, in the app.
ALTER TABLE questions ADD COLUMN meal_id TEXT REFERENCES meals(id);
ALTER TABLE questions ADD COLUMN answered_at TEXT;

-- Work for the cron runner: analyze a new meal, or revise one after the user answered its
-- questions or asked for a correction. One row per run, kept as history.
CREATE TABLE analysis_jobs (
  id           TEXT PRIMARY KEY,             -- ULID
  user_id      TEXT NOT NULL REFERENCES users(id),
  meal_id      TEXT NOT NULL REFERENCES meals(id),
  kind         TEXT NOT NULL CHECK (kind IN ('analyze','revise')),
  input        TEXT,                         -- revise: the user's answers or correction, as text
  model        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  run_after_ms INTEGER NOT NULL,             -- not before this (lets a voice note transcribe first)
  batch_id     TEXT REFERENCES batches(id),  -- the run's batch, once it has one
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX analysis_jobs_due ON analysis_jobs (status, run_after_ms);
CREATE INDEX analysis_jobs_by_meal ON analysis_jobs (user_id, meal_id);
