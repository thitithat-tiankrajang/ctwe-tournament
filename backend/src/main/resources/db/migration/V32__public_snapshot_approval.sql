-- Public Snapshot approval (Phase E).
--
-- Additive only, per the plan's forward-only Flyway rule: one new table, referenced by no existing
-- query, and no existing column or constraint is touched. Reverting the application leaves inert,
-- unused schema — and any snapshot already published in Phase B keeps serving, because approval
-- gates NEW publications only.
--
-- Publication is deliberately a two-step, attributable act (architecture §4.1): approving is where a
-- human accepts that athlete names and school affiliations become permanently public, and publishing
-- is a separate operation that cannot proceed without a live approval recorded here.

CREATE TABLE public_snapshot_approvals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id       UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  approved_by         VARCHAR(64) NOT NULL,
  approved_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Which revision of the bilingual acknowledgment text (§4.4) the approver was actually shown.
  -- Recorded so a later change to that text cannot retroactively claim consent nobody gave.
  acknowledgment_rev  SMALLINT NOT NULL,
  -- SHA-256 over every card's (id, public_version), lowercase hex, no prefix. Unlike a snapshot
  -- checksum this never appears in an artifact, so it is stored bare rather than in the 'sha256-…'
  -- form of tournaments.snapshot_checksum. public_version (V14) changes exactly when publicly
  -- visible data changes, so this diverges precisely when the approver's view goes stale.
  content_fingerprint CHAR(64) NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  -- Revocation is a soft delete. The architecture's illustrative shape in §4.3 has no such columns
  -- and the plan's API says DELETE, but an approval is an attributable act: destroying the row would
  -- destroy the record of who accepted permanent publication of minors' names, which is the one
  -- thing this table exists to keep. The row stays; these two columns say it no longer authorizes.
  revoked_at          TIMESTAMPTZ NULL,
  revoked_by          VARCHAR(64) NULL
);

-- The validity lookup is always "the newest row for this tournament", so the index leads with the
-- tournament and orders by approval time.
CREATE INDEX idx_public_snapshot_approvals_tournament
  ON public_snapshot_approvals (tournament_id, approved_at DESC);
