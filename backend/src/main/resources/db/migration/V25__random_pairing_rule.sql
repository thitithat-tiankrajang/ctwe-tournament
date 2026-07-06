ALTER TABLE pairing_rules
  DROP CONSTRAINT IF EXISTS pairing_rules_rule_type_check;

-- V20 created the replacement table as pairing_rules_v2 before renaming it, so PostgreSQL keeps
-- this generated constraint name on upgraded databases.
ALTER TABLE pairing_rules
  DROP CONSTRAINT IF EXISTS pairing_rules_v2_rule_type_check;

ALTER TABLE pairing_rules
  ADD CONSTRAINT pairing_rules_rule_type_check
  CHECK (rule_type IN ('PAIR_RESULT', 'SWISS', 'KING_OF_THE_HILL', 'RANDOM'));
