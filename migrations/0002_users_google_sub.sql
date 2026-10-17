-- Key users on Google's immutable `sub`, not on email (emails change and get
-- recycled). The table was empty when this ran, so it is rebuilt, not altered.
DROP TABLE users;
CREATE TABLE users (
  id             TEXT PRIMARY KEY,                -- ULID; what every user_id references
  google_sub     TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL,                   -- lowercased; refreshed on each sign-in
  created_at     TEXT NOT NULL,
  last_login_at  TEXT NOT NULL
);
