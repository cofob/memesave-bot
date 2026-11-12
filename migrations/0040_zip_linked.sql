-- Memes of a ZIP import with a source link: their metadata jobs are spread by this count (src/zip.ts).
ALTER TABLE zip_imports ADD COLUMN linked INTEGER NOT NULL DEFAULT 0;
