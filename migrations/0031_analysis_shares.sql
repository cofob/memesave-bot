-- Public links of analysis snapshots (src/analysisshare.ts); the sanitized JSON is in R2 "share/analysis/<id>.json".
CREATE TABLE analysis_shares (
  id TEXT PRIMARY KEY,                 -- public short id
  analysis_id TEXT NOT NULL UNIQUE,    -- one link per analysis: "copy link" again returns it
  user_id INTEGER NOT NULL,            -- who made it
  pair_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX analysis_shares_user ON analysis_shares(user_id);
CREATE INDEX analysis_shares_pair ON analysis_shares(pair_id);
