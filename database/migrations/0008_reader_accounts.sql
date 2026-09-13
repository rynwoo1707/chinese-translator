CREATE TABLE reader_users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  picture TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reader_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE requests ADD COLUMN user_id TEXT REFERENCES reader_users(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'));
ALTER TABLE requests ADD COLUMN file_key TEXT;
ALTER TABLE requests ADD COLUMN filename TEXT;
ALTER TABLE requests ADD COLUMN mime TEXT;
ALTER TABLE requests ADD COLUMN story_id TEXT REFERENCES stories(id) ON DELETE SET NULL;

ALTER TABLE stories ADD COLUMN owner_user_id TEXT REFERENCES reader_users(id) ON DELETE SET NULL;
ALTER TABLE stories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('private', 'public'));

CREATE INDEX idx_reader_sessions_user ON reader_sessions(user_id);
CREATE INDEX idx_reader_sessions_expiry ON reader_sessions(expires_at);
CREATE INDEX idx_requests_user ON requests(user_id, created_at);
CREATE INDEX idx_stories_owner ON stories(owner_user_id, created_at);
