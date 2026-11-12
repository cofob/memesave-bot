-- favorite_count of the e621 user at the start of the last full scan: the progress bar of the import (src/e621.ts).
ALTER TABLE e621_accounts ADD COLUMN fav_total INTEGER;
