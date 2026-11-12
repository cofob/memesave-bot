-- How an album shows in the web app: a horizontal carousel, or a comic read from top to bottom.
ALTER TABLE posts ADD COLUMN layout TEXT NOT NULL DEFAULT 'carousel' CHECK (layout IN ('carousel', 'comic'));
