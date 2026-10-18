-- Export/import (docs/SPEC.md §3, §6) and the memory every prompt carries (D13, D15).
CREATE TABLE batches (
  id              TEXT PRIMARY KEY,            -- ULID
  user_id         TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,               -- e.g. 'prompt/1'
  prompt_text     TEXT NOT NULL,               -- exactly what was handed to the model
  key_map         TEXT NOT NULL,               -- JSON: {"A": "<meal_id>", ...}
  active_codes    TEXT NOT NULL,               -- JSON: remembered-food codes the prompt listed
  channel         TEXT NOT NULL DEFAULT 'chat' CHECK (channel IN ('chat','api')),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','imported','abandoned')),
  reply_raw       TEXT,                        -- exactly what was pasted back
  reply_model     TEXT,
  summary         TEXT,                        -- JSON: reply.summary
  imported_at     TEXT
);
CREATE INDEX batches_by_user_status ON batches (user_id, status);

CREATE TABLE analyses (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  meal_id         TEXT NOT NULL REFERENCES meals(id),
  batch_id        TEXT NOT NULL REFERENCES batches(id),
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  schema_version  TEXT NOT NULL,               -- e.g. 'bitebook.reply/1'
  skipped         INTEGER NOT NULL DEFAULT 0,  -- a skipped meal stays pending
  payload         TEXT NOT NULL,               -- JSON: that meal's object from the reply
  created_at      TEXT NOT NULL
);
CREATE INDEX analyses_by_user_meal ON analyses (user_id, meal_id);

CREATE TABLE foods (                           -- remembered foods, maintained by replies
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  code            TEXT NOT NULL,               -- 'F1', 'F2', … per user, never reused
  name            TEXT NOT NULL,
  serving         TEXT NOT NULL,
  kcal            REAL, protein_g REAL, carbs_g REAL, fat_g REAL,  -- per serving, rough
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  source_batch_id TEXT REFERENCES batches(id), -- the reply that last added or changed it
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  retired_at      TEXT,
  UNIQUE (user_id, code)
);

CREATE TABLE notes (                           -- the user's notes; every prompt includes them
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX notes_by_user ON notes (user_id);
