-- Public Snapshot retraction (Phase F).
--
-- Additive only, per the plan's forward-only Flyway rule: two NULLable columns on an existing table,
-- referenced by no existing query. Reverting the application leaves inert, unused schema, and any
-- snapshot published before the revert keeps serving exactly as it did.
--
-- Retraction withdraws the PUBLIC surface (one DeleteObject plus one purge, architecture §7.1). It
-- deletes nothing from PostgreSQL: the private history stays for audit and rollback, and the
-- tournament's own data is untouched, as everywhere else in this feature.

ALTER TABLE tournaments
  ADD COLUMN retracted_by VARCHAR(64) NULL,
  -- Written BEFORE the public object is deleted, and cleared again if the delete never happened.
  --
  -- This is a statement of intent, not a completion marker, and it exists because "the object is
  -- gone" is ambiguous on its own: a missing s/{h}.json is what a deliberate withdrawal looks like
  -- AND what a lost object looks like, and the two want opposite repairs. With this column set, the
  -- reconciler (§7.8) can finish an interrupted retraction instead of reporting a mystery; without
  -- it, the reconciler would have to guess, and guessing wrong either resurrects withdrawn data or
  -- abandons a healthy tournament.
  --
  -- snapshot_state stays PUBLISHED while this is set and the retraction is still running; it becomes
  -- RETRACTED only once the public object is actually gone.
  ADD COLUMN retracted_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN tournaments.retracted_at IS
  'Retraction intent timestamp (Phase F). Set before the public object is deleted; snapshot_state '
  'becomes RETRACTED once the deletion has happened. NULL means no retraction has been attempted.';
