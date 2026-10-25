-- One status message per media group: 0 while the first item sends it.
ALTER TABLE posts ADD COLUMN status_msg_id INTEGER;
