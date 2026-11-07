-- Each use of a meme: picked from inline results, shared from the app, or sent to the chat (favorite and forgotten memes).
CREATE TABLE meme_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  meme_id TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('inline', 'share', 'send')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX meme_uses_user ON meme_uses(user_id, meme_id);

-- How each meme was saved: bot | web | miniapp | api | mcp | zip. Older memes: the bot ones are known by their message.
ALTER TABLE memes ADD COLUMN added_via TEXT;
UPDATE memes SET added_via = 'bot' WHERE tg_meta IS NOT NULL;
