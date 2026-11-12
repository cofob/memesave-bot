-- Two users who agreed to compare collections. A declined, cancelled or ended pair is deleted.
CREATE TABLE pairs (
  id TEXT PRIMARY KEY,                 -- random 12 chars base64url, also the invite token: t.me/<bot>?start=pair_<id>
  a INTEGER NOT NULL,                  -- who invited
  b INTEGER,                           -- partner; NULL for an open invite link until someone accepts it
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  a_name TEXT, b_name TEXT,            -- Telegram first names for the UI (users has only username)
  a_shares INTEGER NOT NULL DEFAULT 1, -- 0: a revoked the partner's view of a's memes
  b_shares INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  accepted_at INTEGER
);
CREATE INDEX pairs_a ON pairs(a);
CREATE INDEX pairs_b ON pairs(b);
