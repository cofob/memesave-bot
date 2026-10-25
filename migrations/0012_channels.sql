-- Channel auto-posting and media groups.
-- Channels where the bot posts the owner's new memes (the owner gave the bot admin rights).
CREATE TABLE channels (
  chat_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT,
  username TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  caption TEXT NOT NULL DEFAULT '{caption}',   -- caption template; '' = no caption
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX channels_user ON channels(user_id);

-- One user message: a single meme or a media group. Saved always, also without channels.
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  media_group_id TEXT,                          -- Telegram media_group_id: the memes came as one album
  caption TEXT,                                 -- the user's caption (the first one in an album)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posting', 'posted', 'skipped')),
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, media_group_id)
);
CREATE TABLE post_items (
  post_id TEXT NOT NULL,
  meme_id TEXT NOT NULL,
  position INTEGER NOT NULL,                    -- Telegram message_id: order in the album
  PRIMARY KEY (post_id, meme_id)
);
CREATE INDEX post_items_meme ON post_items(meme_id);
