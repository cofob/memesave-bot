-- What to sync: favorites, upvoted posts, or both (src/e621.ts).
ALTER TABLE e621_accounts ADD COLUMN lists TEXT NOT NULL DEFAULT 'both' CHECK (lists IN ('fav', 'up', 'both'));
