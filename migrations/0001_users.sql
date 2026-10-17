-- Every other table carries user_id REFERENCES users(id); see docs/SPEC.md §4.
CREATE TABLE users (
  id             TEXT PRIMARY KEY,                -- ULID
  email          TEXT NOT NULL UNIQUE,            -- lowercased
  created_at     TEXT NOT NULL,
  last_login_at  TEXT NOT NULL
);
