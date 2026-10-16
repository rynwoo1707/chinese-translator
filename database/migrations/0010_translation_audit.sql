ALTER TABLE jobs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN ai_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN ai_cache_hits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN model TEXT;
ALTER TABLE jobs ADD COLUMN prompt_version TEXT;
ALTER TABLE jobs ADD COLUMN translated_at TEXT;
ALTER TABLE jobs ADD COLUMN reviewed_at TEXT;
ALTER TABLE jobs ADD COLUMN published_at TEXT;

CREATE INDEX idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX idx_jobs_model_created ON jobs(model, created_at);
