ALTER TABLE screening_pool ADD COLUMN returned_from_game integer CHECK (returned_from_game > 0);
ALTER TABLE games ADD COLUMN pair_result_deferred_tables integer CHECK (pair_result_deferred_tables BETWEEN 0 AND 3);
