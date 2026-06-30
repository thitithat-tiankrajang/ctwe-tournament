-- Per-tournament private access link. The token scopes a viewer/staff to a single tournament; the
-- root landing lists OPEN tournaments by their token, and a CLOSED tournament's token resolves 404.
ALTER TABLE tournaments ADD COLUMN access_token VARCHAR(64);

UPDATE tournaments
SET access_token = replace(gen_random_uuid()::text, '-', '')
WHERE access_token IS NULL;

ALTER TABLE tournaments ALTER COLUMN access_token SET NOT NULL;
ALTER TABLE tournaments ALTER COLUMN access_token SET DEFAULT replace(gen_random_uuid()::text, '-', '');
ALTER TABLE tournaments ADD CONSTRAINT tournaments_access_token_key UNIQUE (access_token);
