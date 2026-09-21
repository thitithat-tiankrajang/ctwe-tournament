-- A published game corrected after the fact could not be corrected at all.
--
-- overrideResult re-stamps pairing_snapshots.confirmed_at so viewers see a fresh
-- "ผลเผยแพร่ล่าสุดเมื่อ ..." for the game that was just corrected. The immutability trigger
-- forbids exactly that column, so every historical correction of a PUBLISHED game failed with
-- "pairing_snapshots are immutable except voiding" and a 500.
--
-- It went unnoticed because now() is the transaction clock: a test that publishes and then
-- corrects inside ONE transaction writes the value that is already there, the trigger's
-- IS DISTINCT FROM sees no change, and nothing throws. On a live card publish and correction are
-- separate transactions, so the timestamp really moves and the trigger fires every time.
--
-- The fix keeps the rule and carves out the one documented exception, using the same controlled
-- GUC the function already uses for the dev-reset delete. Identity and scope (card_id,
-- snapshot_no, game_from, game_to) stay immutable unconditionally: what a snapshot COVERS can
-- still never be rewritten. Only the moment it was last published may move, and only while
-- overrideResult has explicitly asked for it.
CREATE OR REPLACE FUNCTION reject_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_snapshot_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'pairing_snapshots cannot be deleted';
  END IF;
  IF NEW.card_id IS DISTINCT FROM OLD.card_id
     OR NEW.snapshot_no IS DISTINCT FROM OLD.snapshot_no
     OR NEW.game_from IS DISTINCT FROM OLD.game_from
     OR NEW.game_to IS DISTINCT FROM OLD.game_to THEN
    RAISE EXCEPTION 'pairing_snapshots are immutable except voiding';
  END IF;
  IF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     AND current_setting('app.allow_snapshot_restamp', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'pairing_snapshots are immutable except voiding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
