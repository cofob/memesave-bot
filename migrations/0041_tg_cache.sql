-- Background cache of all memes in Telegram (src/search/tgupload.ts): when a meme was last queued for the upload, and how often.
ALTER TABLE memes ADD COLUMN upload_at INTEGER;
ALTER TABLE memes ADD COLUMN upload_tries INTEGER NOT NULL DEFAULT 0;
