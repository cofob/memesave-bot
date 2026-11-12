-- User setting: porn memes the bot sends go with a Telegram spoiler, and the app blurs them until a tap.
ALTER TABLE users ADD COLUMN blur_porn INTEGER NOT NULL DEFAULT 1;
