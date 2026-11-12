-- Sexual content in the picture or video frames (set by the describe model; not from the audio).
ALTER TABLE memes ADD COLUMN porn INTEGER NOT NULL DEFAULT 0;
