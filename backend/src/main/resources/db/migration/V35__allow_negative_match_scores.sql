-- Negative scores for real matches.
--
-- An A-Math score can legitimately be negative: a player who ends a game below zero has scored a
-- negative total, and that result must be recordable. The two CHECK constraints below were written
-- when scores were assumed non-negative and are the last layer blocking it (the frontend guard and
-- the Bean-Validation @Min(0) go with this change).
--
-- Scope: this relaxes what the COLUMN accepts. It does NOT relax the BYE rule — a bye is a lone
-- player with no opponent and must still be entered with a score above zero, which is enforced in
-- the entry grid, not here. A bye has no opponent to lose to, so a zero or negative bye is not a
-- result; the director's ลงดาบ penalty remains the way to record "no trustworthy result".
--
-- Bounds are unchanged in substance: score_one/score_two remain SMALLINT (-32768..32767) and the
-- DTOs cap the range at ±30000, leaving headroom under the column limit. calculated_diff is
-- INTEGER and comfortably holds the widest possible margin (30000 - -30000 = 60000) before the
-- game's max_diff caps it.
--
-- ONE-WAY: once a negative score exists these constraints cannot be restored without deleting data.

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_v2_score_one_check;
ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_v2_score_two_check;

-- The outcome-consistency rule is deliberately kept exactly as it was: a win still needs two
-- different scores and a positive capped diff, a draw still needs equal scores and a zero diff.
-- Those hold for negative values just as they do for positive ones.
