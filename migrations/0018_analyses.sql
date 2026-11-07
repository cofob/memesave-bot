-- Embedding analyses: built by the analyze/ container, the result JSON is kept in R2 "tmp/analysis/" (one per day).
CREATE TABLE analyses (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  stage TEXT,                              -- vectors | project | cluster | extras | write | done
  done INTEGER NOT NULL DEFAULT 0,         -- progress of the stage
  total INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  llm INTEGER NOT NULL DEFAULT 1,          -- name clusters with an LLM (a small AI cost)
  labeled INTEGER NOT NULL DEFAULT 0,      -- the stored result has LLM cluster names
  chat INTEGER NOT NULL DEFAULT 0,         -- send the report to the bot chat when done
  status_msg_id INTEGER,                   -- bot message the report replies to
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX analyses_user_created ON analyses(user_id, created_at);
