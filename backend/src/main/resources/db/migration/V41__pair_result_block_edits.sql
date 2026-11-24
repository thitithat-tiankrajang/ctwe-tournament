ALTER TABLE matches ADD COLUMN pairing_override boolean NOT NULL DEFAULT false;
ALTER TABLE matches ADD COLUMN forced_bye boolean NOT NULL DEFAULT false;
ALTER TABLE matches ADD COLUMN pair_result_target_table integer;
ALTER TABLE matches ADD COLUMN pair_result_target_side integer;
CREATE UNIQUE INDEX matches_pair_result_redirect
  ON matches (card_id, game_number, pair_result_target_table, pair_result_target_side)
  WHERE pair_result_target_table IS NOT NULL;

ALTER TABLE players ADD COLUMN withdrawn_from_game integer CHECK (withdrawn_from_game > 0);
ALTER TABLE screening_pool ADD COLUMN excluded_from_game integer CHECK (excluded_from_game > 0);

-- Existing game-one previews were stored as physical seats. Keep their pairing identifiers
-- when moving the editable preview into the same match store as subsequent games.
INSERT INTO matches (card_id, game_number, table_number, player_one, player_two)
SELECT ts.card_id, 1, (ts.table_no - 1) * 2 + (ts.seat_no + 1) / 2,
       max(ts.player_code) FILTER (WHERE ts.seat_no % 2 = 1),
       max(ts.player_code) FILTER (WHERE ts.seat_no % 2 = 0)
FROM table_seats ts JOIN tournament_cards c ON c.id = ts.card_id
WHERE c.current_game = 1 AND c.runtime_stage = 'PAIRING_PREVIEW'
GROUP BY ts.card_id, ts.table_no, (ts.seat_no + 1) / 2
ON CONFLICT DO NOTHING;

-- Give already-running paired rounds the same empty slots as newly generated ones.
INSERT INTO matches (card_id, game_number, table_number)
SELECT c.id, c.current_game + 1, slot.n
FROM tournament_cards c JOIN pairing_rules r ON r.card_id = c.id AND r.from_game = c.current_game AND r.rule_type = 'PAIR_RESULT'
CROSS JOIN LATERAL generate_series(1, (
  SELECT COALESCE(max(m.table_number) + max(m.table_number) % 2, 0)
  FROM matches m WHERE m.card_id = c.id AND m.game_number = c.current_game AND m.snapshot_no IS NULL
)) AS slot(n)
WHERE c.runtime_stage IN ('PAIRING_PREVIEW', 'RESULT_COLLECTION')
ON CONFLICT DO NOTHING;
