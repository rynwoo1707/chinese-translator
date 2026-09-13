CREATE TABLE reader_credentials (
  user_id TEXT PRIMARY KEY REFERENCES reader_users(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reader_credentials_email ON reader_credentials(email_normalized);
