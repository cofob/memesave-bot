-- Permanent R2 copies of every meme's file and preview (keys in the MEDIA bucket).
ALTER TABLE memes ADD COLUMN r2_file TEXT;
ALTER TABLE memes ADD COLUMN r2_preview TEXT;
-- Imports and uploads stored before this: "r2:<sha256>" placeholders point at "r2/<sha256>".
UPDATE memes SET r2_file = 'r2/' || substr(file_unique_id, 4) WHERE file_unique_id LIKE 'r2:%';
UPDATE memes SET r2_preview = 'r2p/' || substr(preview_unique_id, 5), preview_unique_id = NULL WHERE preview_unique_id LIKE 'r2p:%';
