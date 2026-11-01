-- Up to five voice notes per meal (D46), each its own file and transcript. voice_notes
-- was keyed by meal; it's rebuilt keyed by its own id, with a position in the meal. Each
-- existing note becomes position 0 under an id equal to its meal's, which is also the
-- name of its file in R2, so no file moves.
CREATE TABLE voice_notes_new (
  id                TEXT PRIMARY KEY,         -- ULID; the file's name in R2
  meal_id           TEXT NOT NULL REFERENCES meals(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  position          INTEGER NOT NULL,         -- 0, 1, … in the order recorded
  r2_key            TEXT NOT NULL,
  mime              TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  duration_ms       INTEGER NOT NULL,
  recorded_at       TEXT,                     -- when it was recorded (null before D46)
  transcript        TEXT,
  transcript_model  TEXT,
  transcribed_at    TEXT,
  transcribe_error  TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (meal_id, position)
);
INSERT INTO voice_notes_new (id, meal_id, user_id, position, r2_key, mime, bytes, sha256, duration_ms,
  transcript, transcript_model, transcribed_at, transcribe_error, created_at)
SELECT meal_id, meal_id, user_id, 0, r2_key, mime, bytes, sha256, duration_ms,
  transcript, transcript_model, transcribed_at, transcribe_error, created_at FROM voice_notes;
DROP TABLE voice_notes;
ALTER TABLE voice_notes_new RENAME TO voice_notes;
CREATE INDEX voice_notes_by_user ON voice_notes (user_id);
CREATE INDEX voice_notes_by_meal ON voice_notes (meal_id);
