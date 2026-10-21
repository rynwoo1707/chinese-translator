-- Password reset links (no e-mail is sent): an admin creates one for an account with a password
-- (POST /api/users/:id/password-reset) and hands it to the student, who sets a new password with it
-- (POST /api/auth/password-reset). Only the SHA-256 of the token is kept (hex, like reader_sessions), so a copy of the
-- database cannot reset anyone's password. A link works once (used_at, epoch ms) within 24 hours (expires_at, epoch
-- ms). A new link replaces the account's older ones; locking or deleting the account removes them.
CREATE TABLE reader_password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX idx_reader_password_resets_user ON reader_password_resets(user_id);
