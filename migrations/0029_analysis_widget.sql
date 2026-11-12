-- The last edit of an analysis progress widget: edits at most every 3 s (Telegram limits message edits).
ALTER TABLE analyses ADD COLUMN widget_at INTEGER;
