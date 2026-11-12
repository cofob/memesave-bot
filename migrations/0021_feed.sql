-- Memes the user saw in the feed (web, Mini App, bot): the "unseen" mode. seen_at is the first view.
CREATE TABLE meme_views (
  user_id INTEGER NOT NULL,
  meme_id TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 1,
  seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, meme_id)
) WITHOUT ROWID;

-- The feed date: when the user saved it at the source (e.g. the TikTok like), else when it came here.
CREATE INDEX memes_user_date ON memes(user_id, COALESCE(saved_at, created_at));
