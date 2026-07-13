ALTER TABLE tournament_cards
  ADD COLUMN initial_pairing_rule VARCHAR(32) NOT NULL DEFAULT 'RANDOM';

ALTER TABLE tournament_cards
  ADD CONSTRAINT tournament_cards_initial_pairing_rule_check
  CHECK (initial_pairing_rule IN ('RANDOM', 'SWISS', 'KING_OF_THE_HILL'));
