-- Two additions to `matches`, both required before the Screening Pool can be safe.
--
-- 1. VOIDED SLOTS — the deadlock fix.
--
--    Screening both players of one pairing is an ordinary thing for a director to do (two players
--    from the same table fail to appear). That leaves the slot holding nobody, and before this
--    migration such a row is a permanent dead end:
--      * submitResult refuses a both-NULL row outright, so it can never be scored;
--      * reviewResults counts it but can never mark it complete, so review throws forever;
--      * the published-pairing CHECK forbids snapshotting it, so the block cannot be published.
--    The round is stranded with no way forward except destroying table numbering.
--
--    A voided slot resolves this without deleting anything: it keeps its table number (printed table
--    cards and PDF exports stay valid, and seat numbers are derived from table_number so deleting a
--    row would silently renumber every seat after it), holds nobody, can never hold a result, and is
--    skipped by every completeness check.
--
-- 2. RESULT WITHDRAWAL — the public half of force commit.
--
--    When a force commit destroys a result the audience has already seen, the score must not simply
--    vanish from the public scoreboard. It is marked withdrawn until staff enter a replacement.
--    (This is NOT V33 retraction, which operates at tournament level and takes an entire published
--    archive offline — aimed at one match it would withdraw the whole tournament's public record.)
ALTER TABLE matches
  ADD COLUMN voided_at           TIMESTAMPTZ,
  ADD COLUMN voided_by           VARCHAR(64),
  ADD COLUMN result_withdrawn_at TIMESTAMPTZ,
  ADD COLUMN result_withdrawn_by VARCHAR(64);

-- A voided slot holds nobody and can never hold a result. Enforced here rather than in the service
-- because "a voided slot with a score" would corrupt standings silently.
ALTER TABLE matches ADD CONSTRAINT matches_voided_is_empty CHECK (
  voided_at IS NULL
  OR (player_one IS NULL AND player_two IS NULL AND result_type IS NULL)
);

ALTER TABLE matches ADD CONSTRAINT matches_voided_actor_recorded CHECK (
  (voided_at IS NULL) = (voided_by IS NULL)
);

-- "Withdrawn" means the previous result was removed and no replacement has been entered yet.
-- Once staff submit a new result the marker is cleared, so the two can never coexist.
ALTER TABLE matches ADD CONSTRAINT matches_withdrawn_is_unscored CHECK (
  result_withdrawn_at IS NULL OR result_type IS NULL
);

ALTER TABLE matches ADD CONSTRAINT matches_withdrawn_actor_recorded CHECK (
  (result_withdrawn_at IS NULL) = (result_withdrawn_by IS NULL)
);

-- ---------------------------------------------------------------------------
-- Replace the "a published pairing must contain at least one player" rule with a voided-exempt
-- version.
--
-- The constraint is dropped BY DEFINITION rather than by name on purpose. V18 created it as
-- `matches_snapshot_requires_present_player`, but V20 rebuilt the whole table and re-declared the
-- rule as an unnamed inline CHECK, so PostgreSQL auto-named it — currently `matches_v2_check1`, a
-- name that is an artifact of declaration order and must not be relied on. Matching the definition
-- works on every environment regardless of how it got here, and fails loudly if the rule ever
-- stopped existing.
DO $$
DECLARE target TEXT;
BEGIN
  SELECT conname INTO target
  FROM pg_constraint
  WHERE conrelid = 'matches'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) =
        'CHECK (((snapshot_no IS NULL) OR (player_one IS NOT NULL) OR (player_two IS NOT NULL)))';

  IF target IS NULL THEN
    RAISE EXCEPTION
      'V37 aborted: the published-pairing CHECK on matches was not found. It may have been renamed '
      'or altered; inspect pg_constraint for conrelid = matches before re-running.';
  END IF;

  EXECUTE format('ALTER TABLE matches DROP CONSTRAINT %I', target);
END $$;

-- Same rule, one exemption: a VOIDED slot may be both-NULL and still be snapshotted. That exemption
-- is the whole point — it is what lets a block containing an abandoned pairing be published at all.
ALTER TABLE matches ADD CONSTRAINT matches_snapshot_requires_present_player CHECK (
  snapshot_no IS NULL
  OR voided_at IS NOT NULL
  OR player_one IS NOT NULL
  OR player_two IS NOT NULL
);

-- ---------------------------------------------------------------------------
-- Allow a BYE to win with zero diff.
--
-- A bye is `Player vs EMPTY` — nobody played, so it must not move a tie-break. This system's ranking
-- leads with capped diff, so a hand-typed bye margin would reorder real standings on the strength of
-- a game that never happened. The result is therefore recorded as a WIN with calculated_diff = 0.
--
-- The existing outcome-consistency CHECK forbids exactly that: its WIN branch demands
-- `calculated_diff > 0`. The exemption below is scoped to byes (one side NULL) so an ordinary win
-- still cannot be recorded without a margin — relaxing the WIN branch outright would let a real match
-- be saved as a 0-margin victory, which is a different and much worse bug.
--
-- Dropped by definition for the same reason as above: V20 re-declared this rule as an unnamed inline
-- CHECK, so its current name (`matches_v2_check`) is an artifact of declaration order.
DO $$
DECLARE target TEXT;
BEGIN
  SELECT conname INTO target
  FROM pg_constraint
  WHERE conrelid = 'matches'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%result_type = ''W''::bpchar%calculated_diff > 0%';

  IF target IS NULL THEN
    RAISE EXCEPTION
      'V37 aborted: the outcome-consistency CHECK on matches was not found. Inspect pg_constraint '
      'for conrelid = matches before re-running.';
  END IF;

  EXECUTE format('ALTER TABLE matches DROP CONSTRAINT %I', target);
END $$;

ALTER TABLE matches ADD CONSTRAINT matches_outcome_consistency CHECK (
  (result_type IS NULL AND winner IS NULL AND score_one IS NULL
     AND score_two IS NULL AND calculated_diff IS NULL)
  OR (result_type = 'D' AND winner IS NULL AND score_one = score_two AND calculated_diff = 0)
  OR (result_type = 'W' AND winner IS NOT NULL AND score_one <> score_two
      -- A bye (exactly one player present) wins with no margin; every real match needs one.
      AND (calculated_diff > 0 OR player_one IS NULL OR player_two IS NULL))
  OR (result_type = 'P' AND winner IS NULL AND calculated_diff >= 0)
);
