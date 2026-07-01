-- Support pairings that are not a multiple of four:
--   * a "bye" is a one-player pairing (the lone player must win) — it must be allowed in a published
--     snapshot, so a snapshot match only needs at least one player present (not a complete pair).
--   * a director "ลงดาบ" penalty records result_type = 'PENALTY' (both players lose, no winner).

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_snapshot_requires_complete_pair;
ALTER TABLE matches ADD CONSTRAINT matches_snapshot_requires_present_player
  CHECK (snapshot_id IS NULL OR player_one_id IS NOT NULL OR player_two_id IS NOT NULL);

ALTER TABLE match_results DROP CONSTRAINT IF EXISTS match_results_outcome_consistency;
ALTER TABLE match_results ADD CONSTRAINT match_results_outcome_consistency CHECK (
  (result_type = 'DRAW' AND winner_id IS NULL AND score_one = score_two AND calculated_diff = 0)
  OR (result_type = 'WIN' AND winner_id IS NOT NULL AND score_one <> score_two AND calculated_diff > 0)
  OR (result_type = 'PENALTY' AND winner_id IS NULL AND calculated_diff >= 0)
);
