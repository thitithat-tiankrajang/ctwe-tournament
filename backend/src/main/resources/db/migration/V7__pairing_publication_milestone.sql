ALTER TABLE matches
  ADD COLUMN pairing_published_at TIMESTAMPTZ;

UPDATE matches m
SET pairing_published_at = s.confirmed_at
FROM pairing_snapshots s
WHERE s.id = m.snapshot_id;

CREATE INDEX idx_matches_card_pairing_published
  ON matches(card_id, pairing_published_at)
  WHERE pairing_published_at IS NOT NULL;
