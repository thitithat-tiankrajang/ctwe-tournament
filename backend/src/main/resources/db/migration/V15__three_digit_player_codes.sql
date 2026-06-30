-- Player relations use UUIDs internally, so compacting the public code is safe for existing
-- pairings/results. Values above 999 remain naturally wider (P1000, P1001, ...).
UPDATE players
SET external_id = 'P' || lpad((substring(external_id from 2)::integer)::text, 3, '0')
WHERE external_id ~ '^P[0-9]+$';
