-- The user's channel for silent uploads of memes without a Telegram file id (inline results need file ids).
ALTER TABLE channels ADD COLUMN storage INTEGER NOT NULL DEFAULT 0;
