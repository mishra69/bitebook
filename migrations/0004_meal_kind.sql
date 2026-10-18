-- A capture is either a meal or a nutrition label (docs/SPEC.md §3, D13).
ALTER TABLE meals ADD COLUMN kind TEXT NOT NULL DEFAULT 'meal' CHECK (kind IN ('meal', 'label'));
