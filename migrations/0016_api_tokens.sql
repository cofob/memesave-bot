-- Personal API tokens for scripts and outside services: Authorization: Bearer <token> on /app/api/*.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,                    -- SHA-256 hex of the token; the token itself is shown once
  write INTEGER NOT NULL DEFAULT 0,             -- 0: GET requests only
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  used_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
