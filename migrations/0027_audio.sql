-- One audio track per post (a single photo or an album) and the video made from it (src/audio.ts).
ALTER TABLE posts ADD COLUMN audio_r2 TEXT;      -- u/<user>/audio/<post>.<rand>.<ext>; a new upload gets a new key
ALTER TABLE posts ADD COLUMN audio_mime TEXT;
ALTER TABLE posts ADD COLUMN audio_file_id TEXT; -- Telegram file id after the first send
ALTER TABLE posts ADD COLUMN clip_r2 TEXT;       -- photos + audio as one video (ffmpeg, thumb/clip.go)
ALTER TABLE posts ADD COLUMN clip_file_id TEXT;
