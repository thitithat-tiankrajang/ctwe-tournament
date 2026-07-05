-- Director can terminate players out of a running card and later restore them (batch, per card).
-- A terminated player keeps their code and past results but is excluded from future pairings and
-- standings recalculation as an active competitor. On restore, the games they missed are charged as
-- losses of `lossPoints` each — carried as running totals (not shown as fake matches), because the
-- spec requires the restored player's history to show only games from their return onward.
ALTER TABLE players
  ADD COLUMN terminated_at TIMESTAMPTZ,
  ADD COLUMN terminated_by VARCHAR(64),
  ADD COLUMN carry_losses SMALLINT NOT NULL DEFAULT 0 CHECK (carry_losses >= 0),
  ADD COLUMN carry_diff INTEGER NOT NULL DEFAULT 0 CHECK (carry_diff >= 0),
  -- First game the player takes part in. 1 for everyone originally; a player restored back into a
  -- card whose current pairing is frozen (case C) rejoins from the NEXT game, so is excluded from the
  -- current game's pairing and its expected match count while still being active.
  ADD COLUMN rejoin_game SMALLINT NOT NULL DEFAULT 1 CHECK (rejoin_game >= 1);

-- Pairing/standings hot paths filter on this; partial index keeps the common "active players" scan cheap.
CREATE INDEX idx_players_active ON players (card_id) WHERE terminated_at IS NULL;
