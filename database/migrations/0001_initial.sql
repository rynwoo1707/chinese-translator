CREATE TABLE stories (id TEXT PRIMARY KEY, title TEXT NOT NULL, genre TEXT NOT NULL, glossary TEXT NOT NULL DEFAULT '{}', context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE jobs (id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES stories(id), filename TEXT NOT NULL, file_key TEXT, mime TEXT, status TEXT NOT NULL DEFAULT 'uploaded', source TEXT NOT NULL DEFAULT '', translation TEXT NOT NULL DEFAULT '', warnings TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX idx_jobs_story ON jobs(story_id, created_at);
CREATE TABLE chapters (id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES stories(id), job_id TEXT UNIQUE REFERENCES jobs(id), title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX idx_chapters_story ON chapters(story_id, created_at);
CREATE TABLE requests (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
