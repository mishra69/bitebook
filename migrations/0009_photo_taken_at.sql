-- Each photo's own time, so helpings taken minutes apart are visible (D19). Photos saved
-- before this get their meal's time, which is what they were shown with until now.
ALTER TABLE photos ADD COLUMN taken_at TEXT;
UPDATE photos SET taken_at = (SELECT taken_at FROM meals WHERE meals.id = photos.meal_id) WHERE taken_at IS NULL;
