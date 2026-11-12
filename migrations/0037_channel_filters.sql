-- Per-channel content filters for auto-posting.
ALTER TABLE channels ADD COLUMN porn TEXT NOT NULL DEFAULT 'all' CHECK (porn IN ('all', 'only', 'none'));
ALTER TABLE channels ADD COLUMN kinds TEXT NOT NULL DEFAULT '';     -- comma list of photo,video,animation; '' = all
ALTER TABLE channels ADD COLUMN tags_in TEXT NOT NULL DEFAULT '';   -- newline list: post only memes with one of them; '' = all
ALTER TABLE channels ADD COLUMN tags_out TEXT NOT NULL DEFAULT '';  -- newline list: never post memes with one of them
ALTER TABLE channels ADD COLUMN comics TEXT NOT NULL DEFAULT 'off' CHECK (comics IN ('off', 'media', 'link')); -- link: cover + public page
