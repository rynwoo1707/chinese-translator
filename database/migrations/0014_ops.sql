-- Daily caps (accounts created per IP, translation requests and PDF extractions per account). window_start is the day
-- number in Vietnam time; the first use on a new day resets the count.
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

-- An admin can lock an account without deleting it: its sessions stop working at once and it cannot log in.
ALTER TABLE reader_users ADD COLUMN disabled_at TEXT;
-- The version of the terms of use and privacy policy the account accepted, and when. NULL: created before consent was
-- recorded.
ALTER TABLE reader_users ADD COLUMN terms_version TEXT;
ALTER TABLE reader_users ADD COLUMN terms_accepted_at TEXT;

-- The PDF layout asset (study/<user>/pdf-layout/<asset>/) a session translates, so deleting a session can tell whether
-- another one still uses those files. NULL for sessions saved before this migration: their saved state names it.
ALTER TABLE study_sessions ADD COLUMN pdf_asset_id TEXT;
CREATE INDEX idx_study_sessions_user_asset ON study_sessions(user_id, pdf_asset_id);
