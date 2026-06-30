-- Idempotent repair: ensure every tournament has an access link. V16 may have been recorded as
-- applied without backfilling existing rows (e.g. the column already existed), leaving access_token
-- NULL, which surfaces as an "undefined" link in the UI. This runs safely whatever V16's outcome was.

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS access_token VARCHAR(64);

UPDATE tournaments
SET access_token = replace(gen_random_uuid()::text, '-', '')
WHERE access_token IS NULL OR access_token = '';

ALTER TABLE tournaments ALTER COLUMN access_token SET DEFAULT replace(gen_random_uuid()::text, '-', '');
ALTER TABLE tournaments ALTER COLUMN access_token SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_access_token_key') THEN
    ALTER TABLE tournaments ADD CONSTRAINT tournaments_access_token_key UNIQUE (access_token);
  END IF;
END $$;
