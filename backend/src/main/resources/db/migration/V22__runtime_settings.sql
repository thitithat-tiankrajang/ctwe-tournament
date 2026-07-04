-- Runtime-tunable realtime configuration (admin-managed, no redeploy needed).
-- Key-value rows so new settings never need another migration. Reads go through a short-TTL
-- Caffeine cache, so the database sees at most one query per TTL window, not one per request.
CREATE TABLE runtime_settings (
  key        VARCHAR(64) PRIMARY KEY,
  value      VARCHAR(128) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by VARCHAR(64)
);

-- Seeds mirror the previous env-var defaults (SSE_MAX_STAFF_STREAMS / SSE_MAX_PUBLIC_STREAMS and
-- the constants that were compiled into CardEventPublisher / the sync hooks).
INSERT INTO runtime_settings (key, value) VALUES
  ('realtime.enabled',                    'true'),
  ('realtime.sse-enabled',                'true'),
  ('realtime.polling-enabled',            'false'),
  ('realtime.max-public-sse-connections', '1500'),
  ('realtime.max-staff-sse-connections',  '300'),
  ('realtime.polling-interval-ms',        '60000'),
  ('realtime.heartbeat-interval-ms',      '25000'),
  ('realtime.reconnect-delay-ms',         '2000');
