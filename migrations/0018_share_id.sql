-- Public short id for /s/ and /d/ links; set on the first "copy link".
ALTER TABLE memes ADD COLUMN share_id TEXT;
CREATE UNIQUE INDEX memes_share_id ON memes(share_id) WHERE share_id IS NOT NULL;
