-- Normalize existing cards into the explicit staff workflow.
UPDATE tournament_cards
SET runtime_stage = CASE
  WHEN status = 'DRAFT' THEN 'PLAYER_REGISTRATION'
  WHEN status = 'READY' THEN 'TABLE_PAIRING'
  WHEN status = 'RUNNING' THEN 'RESULT_COLLECTION'
  WHEN status IN ('FINISHED', 'CLOSED') THEN 'FINAL_PUBLISHED'
  ELSE 'PLAYER_REGISTRATION'
END;

CREATE INDEX IF NOT EXISTS idx_cards_runtime_stage ON tournament_cards(runtime_stage, status);
