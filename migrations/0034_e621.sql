-- e621 account of a user: favorites and upvotes are imported (src/e621.ts).
CREATE TABLE e621_accounts (
  user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  api_key TEXT NOT NULL, -- encrypted
  fav_page INTEGER NOT NULL DEFAULT 1, -- next page of favorites to scan; 0: all scanned
  vote_before INTEGER, -- upvotes are scanned downwards by post id: last id of the previous page; NULL: not started, 0: all scanned
  backfill_done INTEGER NOT NULL DEFAULT 0, -- 0: a full scan (backfill or daily rescan) is running
  last_sync INTEGER NOT NULL DEFAULT 0, -- last step of a sync job
  scanned_at INTEGER NOT NULL DEFAULT (unixepoch()), -- end of the last full scan
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Posts already handled: imported, part of an imported pool, or skipped.
CREATE TABLE e621_posts (
  user_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  pool_id INTEGER,
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE e621_pools (
  user_id INTEGER NOT NULL,
  pool_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, pool_id)
);
