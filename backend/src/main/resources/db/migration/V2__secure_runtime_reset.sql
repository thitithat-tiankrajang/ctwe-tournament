CREATE OR REPLACE FUNCTION reject_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_snapshot_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pairing_snapshots are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS idx_results_winner ON match_results(winner_id);
CREATE INDEX IF NOT EXISTS idx_standings_card_rank ON standings(card_id, wins DESC, diff DESC);
