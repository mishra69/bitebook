-- Questions a model asked in the chat before replying, with the user's answers (prompt/4,
-- D18). Every later prompt lists them so the same thing isn't asked twice.
CREATE TABLE questions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  batch_id    TEXT NOT NULL REFERENCES batches(id),
  topic       TEXT NOT NULL,                   -- short label, e.g. 'curry protein'
  question    TEXT NOT NULL,
  answer      TEXT,                            -- null: asked but not answered
  created_at  TEXT NOT NULL
);
CREATE INDEX questions_by_user ON questions (user_id, created_at);
