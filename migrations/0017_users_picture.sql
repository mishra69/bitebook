-- The Google profile photo, for the avatar in the header (D41). From the ID token's
-- `picture` claim, refreshed on each sign-in; null until the next one.
ALTER TABLE users ADD COLUMN picture_url TEXT;
