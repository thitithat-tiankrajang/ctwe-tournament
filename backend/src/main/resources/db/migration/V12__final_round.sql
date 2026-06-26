-- Championship / final round: an optional play-off seeded from the final standings to decide top places.
-- The final has no per-game max diff; the system records per-game scores but the series winner is decided
-- MANUALLY (criteria vary). It is a separate box and does NOT change the regular standings.
-- Additive only — existing cards default to no final round.
ALTER TABLE tournament_cards
  ADD COLUMN final_type VARCHAR(24) NOT NULL DEFAULT 'NONE'
    CHECK (final_type IN ('NONE', 'CHAMPION', 'CHAMPION_AND_THIRD')),
  ADD COLUMN final_games INTEGER NOT NULL DEFAULT 0
    CHECK (final_games BETWEEN 0 AND 12);

-- One row per play-off bracket slot (created when the director starts the final).
-- slot 0 = play-off for 1st/2nd (seeds rank 1 vs 2); slot 1 = play-off for 3rd/4th (seeds rank 3 vs 4).
CREATE TABLE final_pairings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES tournament_cards(id) ON DELETE CASCADE,
  slot SMALLINT NOT NULL,
  player_one_id UUID NOT NULL REFERENCES players(id),
  player_two_id UUID NOT NULL REFERENCES players(id),
  winner_id UUID REFERENCES players(id),   -- manual conclusion: who won the series
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id, slot)
);

-- Per-game scores within a slot (game_index 1..final_games). Per-game winner is derived from the scores.
CREATE TABLE final_game_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES tournament_cards(id) ON DELETE CASCADE,
  slot SMALLINT NOT NULL,
  game_index INTEGER NOT NULL,
  score_one INTEGER,
  score_two INTEGER,
  UNIQUE (card_id, slot, game_index)
);

CREATE INDEX idx_final_pairings_card ON final_pairings(card_id);
CREATE INDEX idx_final_games_card ON final_game_results(card_id, slot, game_index);
