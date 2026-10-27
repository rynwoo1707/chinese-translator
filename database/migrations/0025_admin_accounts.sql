-- Admin accounts (backend/admin-auth.js). People sign in to /admin with a username and a password. ADMIN_TOKEN stays a
-- server secret (the Bearer credential of the command-line tools, the key of the saved Gemini key and of the
-- auth_failures counts) and is typed only to create the first account or to reset a forgotten password.
-- username is shown as it was typed; username_normalized (NFC, trimmed, lower case) is what login looks up. The password
-- is kept as reader_credentials keeps one (PBKDF2-SHA256 with a 16-byte salt). An account with disabled_at set cannot
-- sign in and its sessions stop counting.
CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  password_changed_at TEXT,
  last_login_at TEXT,
  disabled_at TEXT
);

-- A signed-in browser (cookie cat_hien_admin). Only the SHA-256 (hex) of the cookie is kept, so a copy of the database
-- signs nobody in. Times are epoch ms: a session ends 12 hours after it began (expires_at) or after 2 hours without a
-- request (last_seen_at, refreshed at most every 5 minutes), whichever comes first.
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX idx_admin_sessions_expiry ON admin_sessions(expires_at);

-- The "Cách dịch" of an admin job (frontend/translation-modes.js). NULL: the server's default (ADMIN_TRANSLATION_MODE,
-- else premium), written into the row once the job starts so that one job is translated in one mode.
ALTER TABLE jobs ADD COLUMN mode TEXT;
-- Gemini's reasoning ("thinking") tokens of the job, counted inside total_tokens like the other kinds.
ALTER TABLE jobs ADD COLUMN thinking_tokens INTEGER NOT NULL DEFAULT 0;
