-- gen: generation of the processing run; an edit of an unfinished meme starts a new one, jobs of older runs do nothing.
ALTER TABLE memes ADD COLUMN gen INTEGER NOT NULL DEFAULT 0;
-- edits: JSON of description fields the user set before the meme was ready (column format); the AI does not overwrite them.
ALTER TABLE memes ADD COLUMN edits TEXT;
