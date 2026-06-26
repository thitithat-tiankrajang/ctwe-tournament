-- Gibsonization (optional, per card). When enabled, the pairing step detects players who have CLINCHED
-- a top-K finish (guaranteed champion / guaranteed qualification) given the remaining regular games and
-- their max-diff caps, and uses Gibson pairing (clinched player vs an out-of-contention player) so the
-- runaway leader's spread can't distort the order of the remaining contenders.
-- Additive only — existing cards default to disabled.
ALTER TABLE tournament_cards ADD COLUMN gibson_enabled BOOLEAN NOT NULL DEFAULT false;
