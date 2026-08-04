-- Restored players' missed games are now recorded as real bye+penalty match rows (see
-- TournamentCardService.restorePlayers), reversing the V24 decision that carried them as hidden
-- running totals. This makes the missed games appear in every history/ranking surface (viewer,
-- standings, PDF) and lets the director open and edit them like any other game.
--
-- absence_loss_points remembers the per-missed-game penalty a restored player was assigned, so a
-- game that is still in progress at restore time (case C) gets its penalty row appended the moment
-- that game's block is published. The legacy carry_losses / carry_diff columns are left in place but
-- are no longer used for scoring.
ALTER TABLE players
  ADD COLUMN absence_loss_points INTEGER NOT NULL DEFAULT 0 CHECK (absence_loss_points >= 0);
