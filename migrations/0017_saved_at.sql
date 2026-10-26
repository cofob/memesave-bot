-- When the user saved the meme at its source (e.g. the TikTok like), from uploads of outside services.
ALTER TABLE memes ADD COLUMN saved_at INTEGER;
