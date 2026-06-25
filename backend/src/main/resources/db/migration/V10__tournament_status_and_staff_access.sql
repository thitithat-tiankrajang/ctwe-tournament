-- Tournament open/closed lifecycle (admin-controlled) + explicit per-staff tournament access.

-- 1. Admin-controlled status. CLOSED tournaments are read-only (no card edits until reopened).
ALTER TABLE tournaments
  ADD COLUMN status VARCHAR(8) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED'));

-- 2. Explicit staff -> tournament grants. A director may grant a staff only tournaments the
--    director themselves has access to; the staff then sees every card in those tournaments.
CREATE TABLE staff_tournament_access (
  username VARCHAR(64) NOT NULL REFERENCES staff_accounts(username) ON DELETE CASCADE,
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  PRIMARY KEY (username, tournament_id)
);
CREATE INDEX idx_staff_tournament_access_user ON staff_tournament_access(username);

-- 3. Backfill: existing staff keep access to all of their creator director's current tournaments
--    (this preserves the previous full-inheritance behaviour for already-provisioned staff).
INSERT INTO staff_tournament_access (username, tournament_id)
SELECT sa.username, tm.tournament_id
FROM staff_accounts sa
JOIN staff_authorities a ON a.username = sa.username AND a.authority = 'ROLE_STAFF'
JOIN tournament_members tm ON tm.username = sa.created_by
ON CONFLICT DO NOTHING;
