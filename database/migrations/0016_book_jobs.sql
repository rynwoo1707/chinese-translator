-- Whole-book translation ("Dịch cả quyển"): one row per run over an original the student stored once
-- (study/<user>/sources/<sha256>.pdf). The browser translates it chunk by chunk with the student's own Gemini key and
-- records here what became of each page, so a run can pause (a quota, a closed tab) and resume on any device.
-- page_states has one character per page of the original: '.' pending, 'd' done, 'b' blank, 'c' cover, 's' skipped,
-- 'f' failed. story_id is the private study book the translated chunks join; glossary holds the terms kept for the
-- whole book (JSON object, Chinese term -> Vietnamese), sent with every chunk. version guards concurrent updates.
CREATE TABLE book_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  story_id TEXT REFERENCES stories(id) ON DELETE SET NULL,
  total_pages INTEGER NOT NULL,
  page_states TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,
  domain TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  pause_reason TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  ai_requests INTEGER NOT NULL DEFAULT 0,
  glossary TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_book_jobs_user_updated ON book_jobs(user_id, updated_at DESC);
CREATE INDEX idx_book_jobs_user_source ON book_jobs(user_id, source_sha256);
CREATE INDEX idx_book_jobs_story ON book_jobs(story_id);
