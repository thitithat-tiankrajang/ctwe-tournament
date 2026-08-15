-- Tournament shelving (Phase G / Part II).
--
-- Additive only: two NULLable columns on an existing table, referenced by no existing query.
-- Reverting the application leaves inert, unused schema.
--
-- WHY THIS EXISTS (architecture §19.1). The backend may only be suspended when
-- active_tournament_count = 0, and a tournament counts as settled when its snapshot is PUBLISHED —
-- or when an admin has explicitly said it will never be published. Without the second option a
-- single finished-but-deliberately-unpublished tournament would block every future shutdown
-- forever, which would quietly make zero-compute mode unreachable.
--
-- Shelving is a statement about PUBLICATION INTENT and nothing else. It publishes nothing, withdraws
-- nothing, and touches no card, player, match or game row. It is deliberately reversible: an
-- irreversible flag set from one console click would be a worse trade than the problem it solves.

ALTER TABLE tournaments
  ADD COLUMN shelved_at TIMESTAMPTZ NULL,
  -- Not in the plan's column list, added for the same reason V33 records retracted_by: shelving is
  -- an operator decision that authorizes a shutdown to proceed without this tournament's results
  -- being public, so the record should say who made it.
  ADD COLUMN shelved_by VARCHAR(64) NULL;

COMMENT ON COLUMN tournaments.shelved_at IS
  'Phase G: an admin declared this tournament will never be published, so it no longer blocks a '
  'backend shutdown (architecture §19.1). Publication intent only — nothing public changes.';
