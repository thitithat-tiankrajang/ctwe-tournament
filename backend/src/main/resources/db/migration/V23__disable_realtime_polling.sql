-- The frontend now relies exclusively on SSE. Disable the legacy polling fallback for databases
-- where V22 has already run; the key remains for backwards-compatible admin/config responses.
UPDATE runtime_settings
SET value = 'false', updated_at = now(), updated_by = 'V23_MIGRATION'
WHERE key = 'realtime.polling-enabled';

UPDATE runtime_settings
SET value = '1500', updated_at = now(), updated_by = 'V23_MIGRATION'
WHERE key = 'realtime.max-public-sse-connections'
  AND value = '600';
