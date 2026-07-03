-- Anonymous Web Push subscriptions. The endpoint and encryption keys are opaque browser-issued
-- delivery credentials; they are never linked to a viewer account or other personal profile.
CREATE TABLE web_push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  endpoint_hash CHAR(64) NOT NULL,
  endpoint TEXT NOT NULL CHECK (char_length(endpoint) BETWEEN 20 AND 2048),
  p256dh VARCHAR(255) NOT NULL,
  auth_secret VARCHAR(255) NOT NULL,
  expiration_time BIGINT,
  card_id UUID REFERENCES tournament_cards(id) ON DELETE CASCADE,
  tournament_id UUID REFERENCES tournaments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(card_id, tournament_id) = 1)
);

CREATE UNIQUE INDEX uq_web_push_endpoint_card
  ON web_push_subscriptions(endpoint_hash, card_id) WHERE card_id IS NOT NULL;
CREATE UNIQUE INDEX uq_web_push_endpoint_tournament
  ON web_push_subscriptions(endpoint_hash, tournament_id) WHERE tournament_id IS NOT NULL;
CREATE INDEX idx_web_push_card ON web_push_subscriptions(card_id) WHERE card_id IS NOT NULL;
CREATE INDEX idx_web_push_tournament ON web_push_subscriptions(tournament_id) WHERE tournament_id IS NOT NULL;

-- Zero-configuration fallback for local/single-database deployments. Production can override this
-- with VAPID_* secrets; either way the key pair is generated once and never rotated on restart.
CREATE TABLE web_push_server_keys (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  public_key VARCHAR(255) NOT NULL,
  private_key VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
