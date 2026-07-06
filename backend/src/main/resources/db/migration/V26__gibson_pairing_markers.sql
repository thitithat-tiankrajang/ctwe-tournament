-- Preserve which side of a pairing was mathematically Gibsonized. The marker travels with the
-- player when a director swaps pairings and remains available in confirmed snapshots/results.
ALTER TABLE matches
  ADD COLUMN player_one_gibsonized BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN player_two_gibsonized BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT matches_gibsonized_player_present CHECK (
    (NOT player_one_gibsonized OR player_one IS NOT NULL)
    AND (NOT player_two_gibsonized OR player_two IS NOT NULL)
  );
