ALTER TABLE matches
  ALTER COLUMN player_one_id DROP NOT NULL,
  ALTER COLUMN player_two_id DROP NOT NULL;

ALTER TABLE matches
  ADD CONSTRAINT matches_snapshot_requires_complete_pair
  CHECK (snapshot_id IS NULL OR (player_one_id IS NOT NULL AND player_two_id IS NOT NULL));
