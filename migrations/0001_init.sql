CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  lang TEXT,
  search_mode TEXT NOT NULL DEFAULT 'advanced' CHECK (search_mode IN ('advanced', 'fast')),
  total_cost REAL NOT NULL DEFAULT 0,
  openrouter_key TEXT,
  added_by INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX users_username ON users(username);

CREATE TABLE grants (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  added_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE memes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'animation')),
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  preview_file_id TEXT,
  preview_unique_id TEXT,
  mime TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration INTEGER,
  caption TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'embedding' CHECK (status IN ('embedding', 'describing', 'ready', 'failed')),
  status_msg_id INTEGER,
  title TEXT,
  description TEXT,
  ocr_text TEXT,
  speech_text TEXT,
  meme_context TEXT,
  cultural_meaning TEXT,
  language TEXT,
  tags TEXT,
  search_phrases TEXT,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, file_unique_id)
);
CREATE INDEX memes_user_created ON memes(user_id, created_at DESC);

CREATE VIRTUAL TABLE memes_fts USING fts5(
  title, ocr_text, speech_text, tags, search_phrases, description, meme_context, cultural_meaning,
  content = 'memes', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER memes_ai AFTER INSERT ON memes BEGIN
  INSERT INTO memes_fts (rowid, title, ocr_text, speech_text, tags, search_phrases, description, meme_context, cultural_meaning)
  VALUES (new.rowid, new.title, new.ocr_text, new.speech_text, new.tags, new.search_phrases, new.description, new.meme_context, new.cultural_meaning);
END;
CREATE TRIGGER memes_ad AFTER DELETE ON memes BEGIN
  INSERT INTO memes_fts (memes_fts, rowid, title, ocr_text, speech_text, tags, search_phrases, description, meme_context, cultural_meaning)
  VALUES ('delete', old.rowid, old.title, old.ocr_text, old.speech_text, old.tags, old.search_phrases, old.description, old.meme_context, old.cultural_meaning);
END;
CREATE TRIGGER memes_au AFTER UPDATE ON memes BEGIN
  INSERT INTO memes_fts (memes_fts, rowid, title, ocr_text, speech_text, tags, search_phrases, description, meme_context, cultural_meaning)
  VALUES ('delete', old.rowid, old.title, old.ocr_text, old.speech_text, old.tags, old.search_phrases, old.description, old.meme_context, old.cultural_meaning);
  INSERT INTO memes_fts (rowid, title, ocr_text, speech_text, tags, search_phrases, description, meme_context, cultural_meaning)
  VALUES (new.rowid, new.title, new.ocr_text, new.speech_text, new.tags, new.search_phrases, new.description, new.meme_context, new.cultural_meaning);
END;

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  key_source TEXT NOT NULL CHECK (key_source IN ('global', 'user')),
  cost REAL NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  meme_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX tx_user_created ON transactions(user_id, created_at);
