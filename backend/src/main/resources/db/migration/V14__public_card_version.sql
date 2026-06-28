ALTER TABLE tournament_cards
  ADD COLUMN public_version BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN tournament_cards.public_version IS
  'Changes only when anonymous viewers can observe a different card representation.';
