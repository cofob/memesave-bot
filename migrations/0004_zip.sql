CREATE TABLE zip_imports (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  import_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'running', 'done', 'failed')),
  upload_id TEXT,
  total INTEGER,
  imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  status_msg_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX zip_imports_status ON zip_imports(status);

ALTER TABLE memes ADD COLUMN sha256 TEXT;
CREATE INDEX memes_user_sha256 ON memes(user_id, sha256);
