-- Manual final-round series summary. Staff/directors enter these values themselves; they are
-- intentionally not derived from per-game scores because event directors may use local tie rules.
ALTER TABLE final_pairings
  ADD COLUMN winner_wins SMALLINT CHECK (winner_wins IS NULL OR winner_wins >= 0),
  ADD COLUMN winner_losses SMALLINT CHECK (winner_losses IS NULL OR winner_losses >= 0),
  ADD COLUMN total_diff INTEGER;
