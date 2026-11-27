-- Each locked final bracket gets its own pairing identity. Cancelling a final (back to
-- FINAL_SEEDING) deletes these rows and a restart inserts fresh ones, so a score or winner sent
-- against the old bracket (stale tab, offline retry) can be rejected even when the slot number
-- and finalists happen to match. The volatile default gives every existing row a distinct id.
ALTER TABLE final_pairings
  ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE final_pairings
  ADD CONSTRAINT final_pairings_id_key UNIQUE (id);
