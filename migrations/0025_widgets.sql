-- HTML widgets (Bot API 10.4): the messages whose state the bot keeps up to date.
ALTER TABLE zip_imports ADD COLUMN widget_msg_id INTEGER; -- progress widget; 0: Telegram refused it, text edits instead
ALTER TABLE users ADD COLUMN balance_msg_id INTEGER;      -- the last /balance widget
ALTER TABLE users ADD COLUMN balance_at INTEGER;          -- its last edit (throttle)
ALTER TABLE pairs ADD COLUMN widget_id TEXT;              -- shared compatibility card, the same in both chats
