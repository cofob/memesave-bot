-- Telegram message metadata as JSON (forward origin, chat, sender, date, entities), without the media fields.
ALTER TABLE memes ADD COLUMN tg_meta TEXT;
