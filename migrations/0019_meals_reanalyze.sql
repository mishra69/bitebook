-- "Analyze again" on a meal the model skipped (D51). A skipped estimate counts as handled,
-- so the meal leaves the waiting list; asking again records when, and the meal waits again
-- until an estimate newer than this arrives.
ALTER TABLE meals ADD COLUMN reanalyze_at TEXT;
