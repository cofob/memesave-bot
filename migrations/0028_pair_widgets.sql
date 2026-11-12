-- Pair widgets. The HTML of a sent widget is fixed: a new card page needs a new shared widget (widget_rev).
ALTER TABLE pairs ADD COLUMN widget_rev TEXT; -- page version of widget_id
ALTER TABLE pairs ADD COLUMN quiz_id TEXT;    -- shared "Whose meme?" duel widget
ALTER TABLE pairs ADD COLUMN compat INTEGER;  -- the last compatibility on the card (the /pair list widget)

-- The duel: each side's current question and score.
CREATE TABLE pair_quiz (
  pair_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  meme_id TEXT,                     -- the question waiting for an answer
  score INTEGER NOT NULL DEFAULT 0, -- right answers
  total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pair_id, user_id)
) WITHOUT ROWID;
