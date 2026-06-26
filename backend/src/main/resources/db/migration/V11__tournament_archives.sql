-- Archive-to-Excel: "deleting" a tournament now exports everything to an .xlsx kept here, then the
-- live relational data (cards/players/matches/results/standings) is removed. The file blob remains
-- downloadable forever. Additive only — no existing data is touched.
CREATE TABLE tournament_archives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_name VARCHAR(180) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  content BYTEA NOT NULL,
  byte_size BIGINT NOT NULL,
  card_count INTEGER NOT NULL DEFAULT 0,
  player_count INTEGER NOT NULL DEFAULT 0,
  archived_by VARCHAR(64),
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_archives_archived_at ON tournament_archives(archived_at DESC);
