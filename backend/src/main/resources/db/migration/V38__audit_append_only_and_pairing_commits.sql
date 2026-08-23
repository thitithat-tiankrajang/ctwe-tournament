-- Turns two policy statements into enforced constraints, ahead of the only feature in this system
-- that can destroy a competition result.
--
-- 1. AUDIT IS APPEND-ONLY.
--
--    "Audit logs are never deleted" has until now been a statement about intent, sitting on an
--    ordinary table any code path could UPDATE or DELETE from. Force commit makes the audit trail
--    the ONLY surviving record of a destroyed result — the match row itself is overwritten — so the
--    guarantee has to be real.
--
--    The trigger deliberately mirrors reject_snapshot_mutation (V2 → V19 → V20): a GUC-gated escape
--    hatch for the two legitimate bulk deletes (card deletion and the dev runtime reset), and a hard
--    refusal for everything else. UPDATE is refused unconditionally — nothing in this system has any
--    business rewriting a recorded fact.
--
--    NOTE FOR WHOEVER SHIPS THIS: TournamentCardService.delete() ends with a bare
--    `DELETE FROM audit_logs WHERE card_id = ?`. It must set the GUC first, exactly as the
--    pairing_snapshots delete two lines above it already does, or card deletion breaks in production
--    while every test still passes.
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_audit_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_logs cannot be deleted';
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- 2. COMMIT IDEMPOTENCY.
--
--    A pairing commit that times out on a venue's network leaves the director not knowing whether it
--    applied. Retrying an ordinary commit is already safe — the per-slot occupancy precondition turns
--    a replay into a rejection — but a FORCE commit's replay window is genuinely dangerous: the
--    second attempt could destroy a different, newly-entered result.
--
--    The client generates commit_key once per commit attempt and reuses it across retries. The
--    service inserts here first; zero rows inserted means "already applied", and it returns the
--    current card without touching anything.
CREATE TABLE pairing_commits (
  card_id      UUID        NOT NULL REFERENCES tournament_cards(id),
  commit_key   UUID        NOT NULL,
  actor        VARCHAR(64) NOT NULL,
  forced       BOOLEAN     NOT NULL DEFAULT false,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id, commit_key)
);
