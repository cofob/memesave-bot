CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'submitting', 'submitted', 'processing', 'done', 'failed', 'cancelled')),
  batch_id TEXT,
  key_source TEXT CHECK (key_source IN ('global', 'user')),
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX imports_one_collecting ON imports(user_id) WHERE status = 'collecting';
CREATE INDEX imports_status ON imports(status);

ALTER TABLE memes ADD COLUMN import_id TEXT;
CREATE INDEX memes_import ON memes(import_id);
