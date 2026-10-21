-- One voice note per meal (D21): the audio in R2 and its transcript, which is what prompts
-- use. The transcript is never edited; the audio is kept to compare transcription models.
CREATE TABLE voice_notes (
  meal_id           TEXT PRIMARY KEY REFERENCES meals(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  r2_key            TEXT NOT NULL,
  mime              TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  duration_ms       INTEGER NOT NULL,
  transcript        TEXT,                     -- null until transcribed
  transcript_model  TEXT,                     -- e.g. '@cf/openai/whisper-large-v3-turbo'
  transcribed_at    TEXT,
  transcribe_error  TEXT,                     -- last failure, for retries and diagnosis
  created_at        TEXT NOT NULL
);
CREATE INDEX voice_notes_by_user ON voice_notes (user_id);
