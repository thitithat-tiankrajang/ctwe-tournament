-- Public Snapshot publication state (Phase B).
--
-- Additive only, per the plan's forward-only Flyway rule: every column is NULLable or defaulted, the
-- new table is referenced by no existing query, and no existing column or constraint is touched.
-- Reverting the application therefore leaves inert, unused schema rather than a broken database.
--
-- These columns describe a DERIVED artifact in R2. PostgreSQL remains the source of truth; nothing
-- here permits, records, or implies deletion of tournament data.

ALTER TABLE tournaments
  ADD COLUMN snapshot_state VARCHAR(16) NOT NULL DEFAULT 'NOT_PUBLISHED'
    CHECK (snapshot_state IN (
      'NOT_PUBLISHED',   -- default; nothing is public
      'APPROVED',        -- Phase E only; unreachable in Phase B
      'PUBLISHING',      -- an attempt is in flight (also the concurrency guard)
      'PUBLISHED',       -- exactly one verified object is public
      'PUBLISH_FAILED',  -- an attempt aborted; whatever was public before is untouched
      'RETRACTED'        -- Phase F only; unreachable in Phase B
    )),
  -- Monotonic per tournament. Incremented at the START of an attempt, so a failed attempt burns its
  -- number rather than letting two different payloads ever share one.
  ADD COLUMN snapshot_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN published_at TIMESTAMPTZ NULL,
  -- 'sha256-' + 64 hex characters. Wider than the architecture's CHAR(64) sketch because the
  -- checksum is stored in the same prefixed form the artifact and the public envelope carry, so the
  -- three can be compared without reformatting.
  ADD COLUMN snapshot_checksum VARCHAR(71) NULL;

-- One row per publication ATTEMPT that reached verification, kept forever: the audit trail of what
-- was public, when, and who made it so. Rows are never updated after they reach a terminal status.
CREATE TABLE public_snapshot_publications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id     UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  version           BIGINT NOT NULL,
  checksum          VARCHAR(71) NOT NULL,
  payload_bytes     BIGINT NOT NULL,
  -- The derived public key (base32 of the domain-separated SHA-256 of the access token). Recorded so
  -- an operator can map a public object back to a tournament without recomputing it.
  object_key        VARCHAR(128) NOT NULL,
  status            VARCHAR(16) NOT NULL
                      CHECK (status IN ('VERIFIED', 'PROMOTED', 'FAILED')),
  failure_reason    TEXT NULL,
  actor             VARCHAR(64) NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT public_snapshot_publications_version_key UNIQUE (tournament_id, version)
);

CREATE INDEX idx_public_snapshot_publications_tournament
  ON public_snapshot_publications (tournament_id, version DESC);
