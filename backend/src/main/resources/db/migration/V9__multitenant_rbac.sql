-- Multi-tenant SaaS RBAC: Admin -> Director -> Staff, with a Tournament entity above cards.
-- Admin (provider) owns the platform and provisions tournaments + director accounts.
-- Director (rented to a company) runs assigned tournaments and manages their own staff.
-- Staff (created by a director) can only enter data, scoped to their director's tournaments.

-- 1. Roles: allow the three-tier role set (was: ROLE_STAFF only).
-- Drop the prior single-role CHECK regardless of how Postgres auto-named it.
ALTER TABLE staff_authorities DROP CONSTRAINT IF EXISTS staff_authorities_authority_check;
ALTER TABLE staff_authorities DROP CONSTRAINT IF EXISTS staff_authorities_check;
ALTER TABLE staff_authorities
  ADD CONSTRAINT staff_authorities_authority_check
  CHECK (authority IN ('ROLE_ADMIN', 'ROLE_DIRECTOR', 'ROLE_STAFF'));

-- Promote the existing bootstrap account (the lone pre-existing ROLE_STAFF account) to ADMIN.
UPDATE staff_authorities SET authority = 'ROLE_ADMIN'
WHERE username = (SELECT username FROM staff_accounts ORDER BY created_at LIMIT 1)
  AND authority = 'ROLE_STAFF';

-- 2. Track which director created a staff account (NULL for admin and director accounts).
ALTER TABLE staff_accounts
  ADD COLUMN created_by VARCHAR(64) REFERENCES staff_accounts(username) ON DELETE SET NULL;

-- 3. Tournament entity (tenant container). Only admins create these.
CREATE TABLE tournaments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(180) NOT NULL,
  created_by VARCHAR(64) REFERENCES staff_accounts(username) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version BIGINT NOT NULL DEFAULT 0
);

-- 4. Each card belongs to a tournament (nullable for legacy rows; enforced for new cards in app).
ALTER TABLE tournament_cards
  ADD COLUMN tournament_id UUID REFERENCES tournaments(id) ON DELETE CASCADE;
CREATE INDEX idx_cards_tournament ON tournament_cards(tournament_id);

-- 5. Director <-> tournament assignment (admin-managed). Staff inherit their creator
--    director's tournaments, so only director rows live here.
CREATE TABLE tournament_members (
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  username VARCHAR(64) NOT NULL REFERENCES staff_accounts(username) ON DELETE CASCADE,
  PRIMARY KEY (tournament_id, username)
);
CREATE INDEX idx_tournament_members_username ON tournament_members(username);

-- 6. Backfill: park any pre-existing cards under one legacy tournament so nothing is orphaned.
DO $$
DECLARE
  legacy_owner VARCHAR(64);
  legacy_tid UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM tournament_cards WHERE tournament_id IS NULL) THEN
    SELECT username INTO legacy_owner FROM staff_accounts ORDER BY created_at LIMIT 1;
    legacy_tid := gen_random_uuid();
    INSERT INTO tournaments (id, name, created_by) VALUES (legacy_tid, 'Legacy Tournament', legacy_owner);
    UPDATE tournament_cards SET tournament_id = legacy_tid WHERE tournament_id IS NULL;
    IF legacy_owner IS NOT NULL THEN
      INSERT INTO tournament_members (tournament_id, username) VALUES (legacy_tid, legacy_owner)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
END $$;

-- 7. Soft-void support for pairing snapshots (un-pairing keeps history instead of deleting).
ALTER TABLE pairing_snapshots
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by VARCHAR(64);

-- Relax the immutability trigger: still append-only and never deletable, but allow marking
-- a snapshot voided (un-pairing). Every other column must stay frozen.
CREATE OR REPLACE FUNCTION reject_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Preserve the V2 runtime-reset bypass (used by resetRuntimeData under SET LOCAL).
    IF current_setting('app.allow_snapshot_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'pairing_snapshots cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.card_id IS DISTINCT FROM OLD.card_id
     OR NEW.bundle_key IS DISTINCT FROM OLD.bundle_key
     OR NEW.game_numbers IS DISTINCT FROM OLD.game_numbers
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN
    RAISE EXCEPTION 'pairing_snapshots are immutable except voiding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
