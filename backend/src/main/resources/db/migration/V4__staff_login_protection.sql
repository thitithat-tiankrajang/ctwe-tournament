ALTER TABLE staff_accounts
  ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  ADD COLUMN locked_until TIMESTAMPTZ;

CREATE INDEX idx_staff_locked_until ON staff_accounts(locked_until) WHERE locked_until IS NOT NULL;
