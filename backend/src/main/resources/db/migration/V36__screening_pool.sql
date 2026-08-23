-- Screening Pool: a temporary, INTERNAL hold on a player the director suspects will not show up.
--
-- A screened player is still a competitor. They are not terminated, not withdrawn, not removed from
-- ranking — they are only pulled out of the active pairing so the round can proceed without their
-- table blocking. The public never learns that a hold exists (only committed pairing changes are
-- visible), and a hold can never outlive the game it was taken in: every screened player must be
-- resolved — re-seated or terminated — before review/publish will pass.
--
-- WHY ITS OWN TABLE, not columns on `players`:
--   `players` is a deliberately narrow hot row (see V19 "storage diet" and the V20 re-key) scanned by
--   every pairing and standings query. Screening is transient operational state carrying six fields of
--   context plus a resolution history, which would mean six mostly-NULL columns on the hottest row in
--   the schema. A side table also makes "the pool" a queryable object rather than a filtered scan.
--
-- Screening has NO interaction with the terminate/restore lifecycle. It generates no absence penalty
-- and never touches players.rejoin_game; those belong to restore and stay there.
CREATE TABLE screening_pool (
  card_id         UUID        NOT NULL REFERENCES tournament_cards(id),
  player_code     SMALLINT    NOT NULL,
  -- clock_timestamp(), not now(): now() is the TRANSACTION timestamp and is identical for every
  -- statement in it, so a hold opened, resolved and re-opened inside one transaction would collide on
  -- the primary key. clock_timestamp() also states the truer fact — when this row was written.
  screened_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  screened_by     VARCHAR(64) NOT NULL,
  reason          VARCHAR(16) NOT NULL
                  CHECK (reason IN ('NO_SHOW', 'LATE', 'MEDICAL', 'OTHER')),
  note            VARCHAR(280),

  -- Context captured AT SCREENING TIME, because screening empties the pairing slot in the same
  -- transaction and that is the only place this could otherwise be read from. Without it the pool
  -- card cannot say "was table 5, seat 1, against P012" — the information no longer exists anywhere.
  --
  -- origin_stale is set when the captured pairing later changes, so the card presents the context as
  -- historical instead of confidently naming an opponent who has since been moved elsewhere. A
  -- confidently wrong opponent is worse than no opponent: the director acts on it.
  origin_game     SMALLINT,
  origin_table    SMALLINT,
  origin_side     SMALLINT    CHECK (origin_side IN (1, 2)),
  origin_opponent SMALLINT,
  origin_stale    BOOLEAN     NOT NULL DEFAULT false,

  -- Exactly two exits, both recorded here. RETURNED = re-seated through Multi Switching.
  -- TERMINATED = the director took the disciplinary exit straight from the pool.
  resolved_at     TIMESTAMPTZ,
  resolved_by     VARCHAR(64),
  resolution      VARCHAR(16) CHECK (resolution IN ('RETURNED', 'TERMINATED')),

  -- screened_at is part of the key so a player may be screened, re-seated, and screened again in the
  -- same card without losing the earlier record. Resolved rows accumulate as history.
  PRIMARY KEY (card_id, player_code, screened_at),
  FOREIGN KEY (card_id, player_code) REFERENCES players (card_id, code),
  CONSTRAINT screening_resolution_complete CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  CONSTRAINT screening_resolver_recorded   CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);

-- At most one OPEN hold per player per card. This is the constraint that makes "is this player
-- screened?" a single unambiguous fact rather than a scan over history.
CREATE UNIQUE INDEX uq_screening_open
  ON screening_pool (card_id, player_code) WHERE resolved_at IS NULL;

-- "Is the pool empty?" runs on every review, publish and publish-next gate, and the pairing
-- generators exclude open holds. Both want only the open rows, so the index carries only those.
CREATE INDEX idx_screening_open_card
  ON screening_pool (card_id) WHERE resolved_at IS NULL;
