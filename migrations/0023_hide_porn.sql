-- User setting: hide memes with the porn flag from search, the library and the feed (they are still imported).
ALTER TABLE users ADD COLUMN hide_porn INTEGER NOT NULL DEFAULT 0;
