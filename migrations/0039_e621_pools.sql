-- 1: a synced post of a series pool imports the whole pool as a comic (src/e621.ts); 0: only the post.
ALTER TABLE e621_accounts ADD COLUMN pools INTEGER NOT NULL DEFAULT 1;
