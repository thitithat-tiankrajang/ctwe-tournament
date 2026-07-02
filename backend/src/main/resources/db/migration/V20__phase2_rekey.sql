-- Phase 2 re-key (docs/DATABASE_SPEC.md §3): every high-volume table moves to small composite keys,
-- match_results merges into matches, and surrogate UUIDs disappear from hot rows.
--
-- SAFETY MODEL: this is a pure copy-transform. New tables are built alongside the old ones, row
-- counts are asserted BEFORE anything is dropped, and the whole file runs in one transaction —
-- any failure (bad data, count mismatch) rolls back completely and production data is untouched.

-- ---------------------------------------------------------------------------
-- 0. Preconditions: every player id must be a system 'P<number>' code (they all are — codes are
--    system-generated). A non-conforming row aborts the migration with a clear message.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT external_id INTO bad FROM players WHERE external_id !~ '^P[0-9]+$' LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'V20 aborted: player external_id "%" is not a P-code; fix data first', bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. players: PK (card_id, code SMALLINT). 'P001' -> 1; rendered back as 'P' || lpad(code,3,'0').
CREATE TABLE players_v2 (
  card_id    UUID     NOT NULL REFERENCES tournament_cards(id),
  code       SMALLINT NOT NULL,
  first_name VARCHAR(120) NOT NULL,
  last_name  VARCHAR(120) NOT NULL,
  school     VARCHAR(200) NOT NULL,
  PRIMARY KEY (card_id, code)
);

INSERT INTO players_v2 (card_id, code, first_name, last_name, school)
SELECT card_id, substring(external_id from 2)::smallint, first_name, last_name, school
FROM players;

-- Old-id -> new-code map used by every dependent transform below.
CREATE TEMP TABLE player_map ON COMMIT DROP AS
SELECT id AS old_id, card_id, substring(external_id from 2)::smallint AS code FROM players;
CREATE INDEX ON player_map(old_id);

-- ---------------------------------------------------------------------------
-- 2. pairing_snapshots: PK (card_id, snapshot_no); the games array becomes a [from, to] range.
CREATE TABLE pairing_snapshots_v2 (
  card_id      UUID      NOT NULL REFERENCES tournament_cards(id),
  snapshot_no  SMALLINT  NOT NULL,
  game_from    SMALLINT  NOT NULL,
  game_to      SMALLINT  NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  voided_at    TIMESTAMPTZ,
  voided_by    VARCHAR(64),
  PRIMARY KEY (card_id, snapshot_no),
  CHECK (game_to >= game_from)
);

CREATE TEMP TABLE snapshot_map ON COMMIT DROP AS
SELECT id AS old_id, card_id,
       (row_number() OVER (PARTITION BY card_id ORDER BY confirmed_at, id))::smallint AS snapshot_no
FROM pairing_snapshots;
CREATE INDEX ON snapshot_map(old_id);

INSERT INTO pairing_snapshots_v2 (card_id, snapshot_no, game_from, game_to, confirmed_at, voided_at, voided_by)
SELECT map.card_id, map.snapshot_no,
       (SELECT MIN(n) FROM unnest(s.game_numbers) n),
       (SELECT MAX(n) FROM unnest(s.game_numbers) n),
       s.confirmed_at, s.voided_at, s.voided_by
FROM pairing_snapshots s JOIN snapshot_map map ON map.old_id = s.id;

-- ---------------------------------------------------------------------------
-- 3. games / pairing_rules: composite PKs; to_game (= from_game + 1 always) is derived, not stored.
--    games is re-keyed before matches because the new matches FK points at it.
CREATE TABLE games_v2 (
  card_id     UUID     NOT NULL REFERENCES tournament_cards(id),
  game_number SMALLINT NOT NULL,
  status      VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  max_diff    INTEGER  NOT NULL CHECK (max_diff BETWEEN 1 AND 1000000),
  PRIMARY KEY (card_id, game_number)
);
INSERT INTO games_v2 (card_id, game_number, status, max_diff)
SELECT card_id, game_number, status, max_diff FROM games;

CREATE TABLE pairing_rules_v2 (
  card_id   UUID     NOT NULL REFERENCES tournament_cards(id),
  from_game SMALLINT NOT NULL,
  rule_type VARCHAR(32) NOT NULL CHECK (rule_type IN ('PAIR_RESULT','SWISS','KING_OF_THE_HILL')),
  PRIMARY KEY (card_id, from_game)
);
INSERT INTO pairing_rules_v2 (card_id, from_game, rule_type)
SELECT card_id, from_game, rule_type FROM pairing_rules;

-- ---------------------------------------------------------------------------
-- 4. matches: merged with match_results, natural PK (card_id, game_number, table_number),
--    players referenced by their per-card SMALLINT code, result_type encoded W/D/P.
CREATE TABLE matches_v2 (
  card_id              UUID      NOT NULL REFERENCES tournament_cards(id),
  game_number          SMALLINT  NOT NULL,
  table_number         SMALLINT  NOT NULL,
  player_one           SMALLINT,
  player_two           SMALLINT,
  snapshot_no          SMALLINT,
  pairing_published_at TIMESTAMPTZ,
  score_one            SMALLINT,
  score_two            SMALLINT,
  result_type          CHAR(1),
  winner               SMALLINT,
  calculated_diff      INTEGER,
  submitted_by         VARCHAR(64),
  submitted_at         TIMESTAMPTZ,
  PRIMARY KEY (card_id, game_number, table_number),
  FOREIGN KEY (card_id, game_number) REFERENCES games_v2 (card_id, game_number),
  FOREIGN KEY (card_id, player_one)  REFERENCES players_v2 (card_id, code),
  FOREIGN KEY (card_id, player_two)  REFERENCES players_v2 (card_id, code),
  FOREIGN KEY (card_id, winner)      REFERENCES players_v2 (card_id, code),
  FOREIGN KEY (card_id, snapshot_no) REFERENCES pairing_snapshots_v2 (card_id, snapshot_no),
  CHECK (result_type IN ('W', 'D', 'P')),
  CHECK (score_one IS NULL OR score_one >= 0),
  CHECK (score_two IS NULL OR score_two >= 0),
  CHECK (
    (result_type IS NULL AND winner IS NULL AND score_one IS NULL AND score_two IS NULL AND calculated_diff IS NULL)
    OR (result_type = 'D' AND winner IS NULL AND score_one = score_two AND calculated_diff = 0)
    OR (result_type = 'W' AND winner IS NOT NULL AND score_one <> score_two AND calculated_diff > 0)
    OR (result_type = 'P' AND winner IS NULL AND calculated_diff >= 0)
  ),
  -- a published (snapshotted) pairing must contain at least one player (bye = exactly one)
  CHECK (snapshot_no IS NULL OR player_one IS NOT NULL OR player_two IS NOT NULL)
);

INSERT INTO matches_v2 (card_id, game_number, table_number, player_one, player_two, snapshot_no,
                        pairing_published_at, score_one, score_two, result_type, winner,
                        calculated_diff, submitted_by, submitted_at)
SELECT m.card_id, g.game_number, m.table_number,
       p1.code, p2.code, sm.snapshot_no, m.pairing_published_at,
       r.score_one, r.score_two, left(r.result_type, 1), pw.code,
       r.calculated_diff, r.submitted_by, r.submitted_at
FROM matches m
JOIN games g ON g.id = m.game_id
LEFT JOIN player_map p1 ON p1.old_id = m.player_one_id AND p1.card_id = m.card_id
LEFT JOIN player_map p2 ON p2.old_id = m.player_two_id AND p2.card_id = m.card_id
LEFT JOIN match_results r ON r.match_id = m.id
LEFT JOIN player_map pw ON pw.old_id = r.winner_id AND pw.card_id = m.card_id
LEFT JOIN snapshot_map sm ON sm.old_id = m.snapshot_id;

-- ---------------------------------------------------------------------------
-- 5. table_seats: competition_tables + table_players collapse into one seat table.
CREATE TABLE table_seats (
  card_id     UUID     NOT NULL REFERENCES tournament_cards(id),
  table_no    SMALLINT NOT NULL,
  seat_no     SMALLINT NOT NULL CHECK (seat_no BETWEEN 1 AND 4),
  player_code SMALLINT NOT NULL,
  PRIMARY KEY (card_id, table_no, seat_no),
  FOREIGN KEY (card_id, player_code) REFERENCES players_v2 (card_id, code)
);
INSERT INTO table_seats (card_id, table_no, seat_no, player_code)
SELECT t.card_id, t.table_number, tp.seat_number, pm.code
FROM competition_tables t
JOIN table_players tp ON tp.table_id = t.id
JOIN player_map pm ON pm.old_id = tp.player_id AND pm.card_id = t.card_id;

-- ---------------------------------------------------------------------------
-- 6. standings: keyed by player code; recalculated_at dropped (recomputed on every publish anyway).
CREATE TABLE standings_v2 (
  card_id     UUID     NOT NULL REFERENCES tournament_cards(id),
  player_code SMALLINT NOT NULL,
  wins        SMALLINT NOT NULL DEFAULT 0,
  draws       SMALLINT NOT NULL DEFAULT 0 CHECK (draws >= 0),
  losses      SMALLINT NOT NULL DEFAULT 0,
  win_points  SMALLINT NOT NULL DEFAULT 0 CHECK (win_points >= 0),
  diff        INTEGER  NOT NULL DEFAULT 0,
  rank        SMALLINT,
  PRIMARY KEY (card_id, player_code),
  FOREIGN KEY (card_id, player_code) REFERENCES players_v2 (card_id, code)
);
INSERT INTO standings_v2 (card_id, player_code, wins, draws, losses, win_points, diff, rank)
SELECT s.card_id, pm.code, s.wins, s.draws, s.losses, s.win_points, s.diff, s.rank
FROM standings s JOIN player_map pm ON pm.old_id = s.player_id AND pm.card_id = s.card_id;

-- ---------------------------------------------------------------------------
-- 7. final round: composite PKs, player codes.
CREATE TABLE final_pairings_v2 (
  card_id    UUID     NOT NULL REFERENCES tournament_cards(id) ON DELETE CASCADE,
  slot       SMALLINT NOT NULL,
  player_one SMALLINT NOT NULL,
  player_two SMALLINT NOT NULL,
  winner     SMALLINT,
  PRIMARY KEY (card_id, slot),
  FOREIGN KEY (card_id, player_one) REFERENCES players_v2 (card_id, code),
  FOREIGN KEY (card_id, player_two) REFERENCES players_v2 (card_id, code),
  FOREIGN KEY (card_id, winner)     REFERENCES players_v2 (card_id, code)
);
INSERT INTO final_pairings_v2 (card_id, slot, player_one, player_two, winner)
SELECT fp.card_id, fp.slot, p1.code, p2.code, pw.code
FROM final_pairings fp
JOIN player_map p1 ON p1.old_id = fp.player_one_id AND p1.card_id = fp.card_id
JOIN player_map p2 ON p2.old_id = fp.player_two_id AND p2.card_id = fp.card_id
LEFT JOIN player_map pw ON pw.old_id = fp.winner_id AND pw.card_id = fp.card_id;

CREATE TABLE final_game_results_v2 (
  card_id    UUID     NOT NULL REFERENCES tournament_cards(id) ON DELETE CASCADE,
  slot       SMALLINT NOT NULL,
  game_index SMALLINT NOT NULL,
  score_one  SMALLINT,
  score_two  SMALLINT,
  PRIMARY KEY (card_id, slot, game_index)
);
INSERT INTO final_game_results_v2 (card_id, slot, game_index, score_one, score_two)
SELECT card_id, slot, game_index, score_one, score_two FROM final_game_results;

-- ---------------------------------------------------------------------------
-- 8. audit_logs: BIGINT identity id (half the key bytes, time-ordered by construction).
CREATE TABLE audit_logs_v2 (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id    UUID REFERENCES tournament_cards(id),
  actor      VARCHAR(180) NOT NULL,
  action     VARCHAR(100) NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO audit_logs_v2 (card_id, actor, action, old_value, new_value, created_at)
SELECT card_id, actor, action, old_value, new_value, created_at
FROM audit_logs ORDER BY created_at, id;

-- ---------------------------------------------------------------------------
-- 9. HARD ASSERTIONS — abort (and roll back everything) if any row or value was lost in transform.
DO $$
DECLARE
  old_n BIGINT; new_n BIGINT;
BEGIN
  SELECT count(*) INTO old_n FROM players;      SELECT count(*) INTO new_n FROM players_v2;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: players % -> %', old_n, new_n; END IF;

  SELECT count(*) INTO old_n FROM matches;      SELECT count(*) INTO new_n FROM matches_v2;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: matches % -> %', old_n, new_n; END IF;

  SELECT count(*) INTO old_n FROM match_results; SELECT count(*) INTO new_n FROM matches_v2 WHERE result_type IS NOT NULL;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: results % -> %', old_n, new_n; END IF;

  -- player references must survive the id->code join exactly (a NULL from a failed join would differ)
  SELECT count(*) INTO old_n FROM matches WHERE player_one_id IS NOT NULL;
  SELECT count(*) INTO new_n FROM matches_v2 WHERE player_one IS NOT NULL;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: player_one refs % -> %', old_n, new_n; END IF;
  SELECT count(*) INTO old_n FROM matches WHERE player_two_id IS NOT NULL;
  SELECT count(*) INTO new_n FROM matches_v2 WHERE player_two IS NOT NULL;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: player_two refs % -> %', old_n, new_n; END IF;
  SELECT count(*) INTO old_n FROM match_results WHERE winner_id IS NOT NULL;
  SELECT count(*) INTO new_n FROM matches_v2 WHERE winner IS NOT NULL;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: winner refs % -> %', old_n, new_n; END IF;
  SELECT count(*) INTO old_n FROM matches WHERE snapshot_id IS NOT NULL;
  SELECT count(*) INTO new_n FROM matches_v2 WHERE snapshot_no IS NOT NULL;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: snapshot refs % -> %', old_n, new_n; END IF;

  SELECT count(*) INTO old_n FROM pairing_snapshots; SELECT count(*) INTO new_n FROM pairing_snapshots_v2;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: snapshots % -> %', old_n, new_n; END IF;

  SELECT count(*) INTO old_n FROM standings;    SELECT count(*) INTO new_n FROM standings_v2;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: standings % -> %', old_n, new_n; END IF;

  SELECT count(*) INTO old_n FROM table_players; SELECT count(*) INTO new_n FROM table_seats;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: table seats % -> %', old_n, new_n; END IF;

  SELECT count(*) INTO old_n FROM games;        SELECT count(*) INTO new_n FROM games_v2;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: games % -> %', old_n, new_n; END IF;

  SELECT count(*) INTO old_n FROM pairing_rules; SELECT count(*) INTO new_n FROM pairing_rules_v2;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: rules % -> %', old_n, new_n; END IF;

  SELECT count(*) INTO old_n FROM final_pairings; SELECT count(*) INTO new_n FROM final_pairings_v2;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: final pairings % -> %', old_n, new_n; END IF;
  SELECT count(*) INTO old_n FROM final_game_results; SELECT count(*) INTO new_n FROM final_game_results_v2;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: final games % -> %', old_n, new_n; END IF;

  SELECT count(*) INTO old_n FROM audit_logs;   SELECT count(*) INTO new_n FROM audit_logs_v2;
  IF old_n <> new_n THEN RAISE EXCEPTION 'V20 aborted: audit % -> %', old_n, new_n; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 10. Swap: drop old tables (children first), rename the new set into place.
DROP TABLE match_results;
DROP TABLE matches;
DROP TABLE table_players;
DROP TABLE competition_tables;
DROP TABLE standings;
DROP TABLE final_game_results;
DROP TABLE final_pairings;
DROP TABLE pairing_snapshots;   -- row triggers do not fire for DROP TABLE
DROP TABLE pairing_rules;
DROP TABLE games;
DROP TABLE players;
DROP TABLE audit_logs;

ALTER TABLE players_v2            RENAME TO players;
ALTER TABLE games_v2              RENAME TO games;
ALTER TABLE pairing_rules_v2      RENAME TO pairing_rules;
ALTER TABLE pairing_snapshots_v2  RENAME TO pairing_snapshots;
ALTER TABLE matches_v2            RENAME TO matches;
ALTER TABLE standings_v2          RENAME TO standings;
ALTER TABLE final_pairings_v2     RENAME TO final_pairings;
ALTER TABLE final_game_results_v2 RENAME TO final_game_results;
ALTER TABLE audit_logs_v2         RENAME TO audit_logs;

CREATE INDEX idx_audit_card_created ON audit_logs (card_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 11. Snapshot immutability trigger for the new shape: rows are append-only; only voiding
--     (voided_at/voided_by) may change; deletes only under the dev-reset GUC.
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
     OR NEW.game_to IS DISTINCT FROM OLD.game_to
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'pairing_snapshots are immutable except voiding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pairing_snapshots_immutable
BEFORE UPDATE OR DELETE ON pairing_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_mutation();
