-- SHA-256 of the uploaded original, so a student uploading the same textbook can be pointed to the
-- teacher-reviewed translation already in the library instead of spending tokens on it again.
ALTER TABLE jobs ADD COLUMN source_sha256 TEXT;

CREATE INDEX idx_jobs_source_sha256 ON jobs(source_sha256) WHERE source_sha256 IS NOT NULL;
