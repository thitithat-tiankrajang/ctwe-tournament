CREATE TABLE tournament_cards (
  id UUID PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  division VARCHAR(180) NOT NULL,
  number_of_games INTEGER NOT NULL CHECK (number_of_games BETWEEN 2 AND 12),
  status VARCHAR(24) NOT NULL CHECK (status IN ('DRAFT','READY','RUNNING','FINISHED','CLOSED')),
  runtime_stage VARCHAR(32) NOT NULL,
  current_game INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE games (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES tournament_cards(id) ON DELETE CASCADE,
  game_number INTEGER NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  UNIQUE (card_id, game_number)
);

CREATE TABLE pairing_rules (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES tournament_cards(id) ON DELETE CASCADE,
  from_game INTEGER NOT NULL,
  to_game INTEGER NOT NULL,
  rule_type VARCHAR(32) NOT NULL CHECK (rule_type IN ('PAIR_RESULT','SWISS','KING_OF_THE_HILL')),
  CHECK (to_game = from_game + 1),
  UNIQUE (card_id, from_game, to_game)
);

CREATE TABLE players (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES tournament_cards(id) ON DELETE CASCADE,
  external_id VARCHAR(64) NOT NULL,
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(120) NOT NULL,
  school VARCHAR(200) NOT NULL,
  division VARCHAR(180) NOT NULL,
  UNIQUE (card_id, external_id)
);

CREATE TABLE competition_tables (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES tournament_cards(id) ON DELETE CASCADE,
  table_number INTEGER NOT NULL,
  UNIQUE (card_id, table_number)
);

CREATE TABLE table_players (
  table_id UUID NOT NULL REFERENCES competition_tables(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seat_number INTEGER NOT NULL CHECK (seat_number BETWEEN 1 AND 4),
  PRIMARY KEY (table_id, player_id),
  UNIQUE (table_id, seat_number)
);

CREATE TABLE pairing_snapshots (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES tournament_cards(id),
  bundle_key UUID NOT NULL,
  game_numbers INTEGER[] NOT NULL,
  payload JSONB NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  UNIQUE (card_id, bundle_key)
);

CREATE TABLE matches (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES tournament_cards(id),
  game_id UUID NOT NULL REFERENCES games(id),
  snapshot_id UUID REFERENCES pairing_snapshots(id),
  table_number INTEGER NOT NULL,
  player_one_id UUID NOT NULL REFERENCES players(id),
  player_two_id UUID NOT NULL REFERENCES players(id),
  UNIQUE (game_id, table_number)
);

CREATE TABLE match_results (
  id UUID PRIMARY KEY,
  match_id UUID NOT NULL UNIQUE REFERENCES matches(id),
  winner_id UUID NOT NULL REFERENCES players(id),
  score_one INTEGER NOT NULL,
  score_two INTEGER NOT NULL,
  submitted_by VARCHAR(180) NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version BIGINT NOT NULL DEFAULT 0,
  CHECK (score_one <> score_two)
);

CREATE TABLE standings (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES tournament_cards(id),
  player_id UUID NOT NULL REFERENCES players(id),
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  diff INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,
  recalculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id, player_id)
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  card_id UUID REFERENCES tournament_cards(id),
  actor VARCHAR(180) NOT NULL,
  action VARCHAR(100) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_players_card_school ON players(card_id, school);
CREATE INDEX idx_matches_card_game ON matches(card_id, game_id);
CREATE INDEX idx_snapshots_card_confirmed ON pairing_snapshots(card_id, confirmed_at);
CREATE INDEX idx_audit_card_created ON audit_logs(card_id, created_at DESC);

-- Pairing snapshots are append-only. Updates and deletes are rejected at database level.
CREATE OR REPLACE FUNCTION reject_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pairing_snapshots are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pairing_snapshots_immutable
BEFORE UPDATE OR DELETE ON pairing_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_mutation();
