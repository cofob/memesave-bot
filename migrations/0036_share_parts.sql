-- What a public analysis link shows: the normal stats and/or the porn stats (sharer's choice).
ALTER TABLE analysis_shares ADD COLUMN parts TEXT NOT NULL DEFAULT 'normal' CHECK (parts IN ('normal', 'porn', 'normal,porn'));
