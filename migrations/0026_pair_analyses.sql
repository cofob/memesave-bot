-- Pair analyses (src/analysis.ts): user_id is who started and pays; endPair deletes them.
ALTER TABLE analyses ADD COLUMN pair_id TEXT;
CREATE INDEX analyses_pair ON analyses(pair_id, created_at);
