ALTER TABLE games
  ADD COLUMN max_diff INTEGER NOT NULL DEFAULT 350,
  ADD CONSTRAINT games_max_diff_range CHECK (max_diff BETWEEN 1 AND 1000000);

ALTER TABLE match_results
  DROP CONSTRAINT IF EXISTS match_results_check,
  ALTER COLUMN winner_id DROP NOT NULL,
  ADD COLUMN result_type VARCHAR(8) NOT NULL DEFAULT 'WIN',
  ADD COLUMN calculated_diff INTEGER NOT NULL DEFAULT 0;

UPDATE match_results r
SET calculated_diff = LEAST(ABS(r.score_one - r.score_two), g.max_diff),
    result_type = CASE WHEN r.score_one = r.score_two THEN 'DRAW' ELSE 'WIN' END,
    winner_id = CASE WHEN r.score_one = r.score_two THEN NULL ELSE r.winner_id END
FROM matches m JOIN games g ON g.id = m.game_id
WHERE m.id = r.match_id;

ALTER TABLE match_results
  ADD CONSTRAINT match_results_scores_non_negative CHECK (score_one >= 0 AND score_two >= 0),
  ADD CONSTRAINT match_results_diff_non_negative CHECK (calculated_diff >= 0),
  ADD CONSTRAINT match_results_outcome_consistency CHECK (
    (result_type = 'DRAW' AND winner_id IS NULL AND score_one = score_two AND calculated_diff = 0)
    OR
    (result_type = 'WIN' AND winner_id IS NOT NULL AND score_one <> score_two AND calculated_diff > 0)
  );

ALTER TABLE standings
  ADD COLUMN draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
  ADD COLUMN win_points INTEGER NOT NULL DEFAULT 0 CHECK (win_points >= 0);

UPDATE standings SET win_points = wins * 2;
