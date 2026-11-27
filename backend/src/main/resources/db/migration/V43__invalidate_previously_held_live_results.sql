-- Scores on published pairings in an open paired block were previously omitted from public reads.
-- Give the new representation a fresh version so old bundle ETags and immutable card URLs expire.
UPDATE tournament_cards c
SET public_version = public_version + 1
WHERE EXISTS (
    SELECT 1 FROM pairing_rules rule
    WHERE rule.card_id = c.id AND rule.from_game = c.current_game AND rule.rule_type = 'PAIR_RESULT'
)
AND EXISTS (
    SELECT 1 FROM matches m
    WHERE m.card_id = c.id AND m.game_number >= c.current_game AND m.snapshot_no IS NULL
      AND m.pairing_published_at IS NOT NULL AND m.result_type IS NOT NULL
      AND (m.player_one IS NOT NULL OR m.player_two IS NOT NULL)
);
