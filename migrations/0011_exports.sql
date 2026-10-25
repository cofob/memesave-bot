-- Data exports: one .zip of all user data, built by the container and kept in R2 "tmp/" for 7 days.
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  upload_id TEXT,
  size INTEGER,
  files INTEGER,                           -- media files written
  failed INTEGER,                          -- media files that could not be read
  status_msg_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX exports_user_created ON exports(user_id, created_at);
