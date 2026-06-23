CREATE TABLE staff_accounts (
  username VARCHAR(64) PRIMARY KEY,
  password_hash VARCHAR(100) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE staff_authorities (
  username VARCHAR(64) NOT NULL REFERENCES staff_accounts(username) ON DELETE CASCADE,
  authority VARCHAR(64) NOT NULL CHECK (authority = 'ROLE_STAFF'),
  PRIMARY KEY (username, authority)
);

REVOKE UPDATE (password_hash, username) ON staff_accounts FROM PUBLIC;
