-- Storage diet (Phase 1 of docs/DATABASE_SPEC.md): remove data that is 100% duplicated or has no
-- reader, and shrink oversized integer types. No API shape changes — every value the frontend sees
-- is still served, now derived from the relational source of truth instead of stored twice.

-- 1. pairing_snapshots: the JSONB payload duplicated matches+match_results in full and was never
--    read back (snapshots are rebuilt from the relational tables on every read). payload_hash and
--    bundle_key had no readers at all. Replace the immutability trigger first since it references
--    the dropped columns, keeping the same guarantees for the remaining ones.
CREATE OR REPLACE FUNCTION reject_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Preserve the V2 runtime-reset bypass (used by resetRuntimeData under SET LOCAL).
    IF current_setting('app.allow_snapshot_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'pairing_snapshots cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.card_id IS DISTINCT FROM OLD.card_id
     OR NEW.game_numbers IS DISTINCT FROM OLD.game_numbers
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'pairing_snapshots are immutable except voiding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE pairing_snapshots
  DROP COLUMN payload,
  DROP COLUMN payload_hash,
  DROP COLUMN bundle_key;

-- 2. audit_logs: values are short strings ("review", "game 3") or small result objects; nothing
--    queries inside them with JSON operators, so JSONB storage + parse overhead bought nothing.
--    Scalars are unwrapped to bare text during conversion so the audit page reads them as-is.
ALTER TABLE audit_logs
  ALTER COLUMN old_value TYPE TEXT
    USING CASE WHEN jsonb_typeof(old_value) = 'string' THEN old_value #>> '{}' ELSE old_value::text END,
  ALTER COLUMN new_value TYPE TEXT
    USING CASE WHEN jsonb_typeof(new_value) = 'string' THEN new_value #>> '{}' ELSE new_value::text END;

-- 3. match_results: version was bumped on every edit but read by nothing — pure WAL/dead-tuple
--    churn on the hottest write path. Scores fit SMALLINT (validation caps them well below 32k).
ALTER TABLE match_results
  DROP COLUMN version,
  ALTER COLUMN score_one TYPE SMALLINT,
  ALTER COLUMN score_two TYPE SMALLINT;

-- The winner index only served rare FK checks on player deletes (small per-card scans); dropping it
-- removes an index write from every result submission.
DROP INDEX IF EXISTS idx_results_winner;

-- 4. players.division duplicated tournament_cards.division on every row; it is now served by a join.
ALTER TABLE players DROP COLUMN division;

-- 5. standings: the surrogate UUID id doubled the natural key; (card_id, player_id) is the PK now.
--    Counts fit SMALLINT; diff stays INTEGER (accumulates across games).
ALTER TABLE standings DROP COLUMN id;
ALTER TABLE standings ADD PRIMARY KEY (card_id, player_id);
ALTER TABLE standings DROP CONSTRAINT IF EXISTS standings_card_id_player_id_key;
ALTER TABLE standings
  ALTER COLUMN wins TYPE SMALLINT,
  ALTER COLUMN draws TYPE SMALLINT,
  ALTER COLUMN losses TYPE SMALLINT,
  ALTER COLUMN win_points TYPE SMALLINT,
  ALTER COLUMN rank TYPE SMALLINT;

-- 6. Final round: slot/game_index/scores are tiny values.
ALTER TABLE final_game_results
  ALTER COLUMN game_index TYPE SMALLINT,
  ALTER COLUMN score_one TYPE SMALLINT,
  ALTER COLUMN score_two TYPE SMALLINT;

-- Note: dropped-column space is reclaimed lazily by autovacuum as rows are rewritten. To reclaim
-- it immediately, run once, outside this migration (VACUUM cannot run inside a transaction):
--   VACUUM FULL pairing_snapshots; VACUUM FULL audit_logs; VACUUM FULL match_results;
--   VACUUM FULL standings; VACUUM FULL players;
-- The ALTER ... TYPE statements above already rewrote their tables compactly.
