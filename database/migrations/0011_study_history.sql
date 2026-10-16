CREATE TABLE study_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT 'general' CHECK (domain IN ('general', 'math', 'history')),
  mode TEXT NOT NULL DEFAULT 'economy' CHECK (mode IN ('economy', 'balanced', 'quality')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'translating', 'complete')),
  state_key TEXT NOT NULL,
  source_preview TEXT NOT NULL DEFAULT '',
  translation_preview TEXT NOT NULL DEFAULT '',
  translated_parts INTEGER NOT NULL DEFAULT 0,
  total_parts INTEGER NOT NULL DEFAULT 0,
  source_characters INTEGER NOT NULL DEFAULT 0,
  translation_characters INTEGER NOT NULL DEFAULT 0,
  library_story_id TEXT REFERENCES stories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_study_sessions_user_updated ON study_sessions(user_id, updated_at DESC);
CREATE INDEX idx_study_sessions_library_story ON study_sessions(library_story_id);

