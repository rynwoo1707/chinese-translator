ALTER TABLE stories ADD COLUMN author TEXT NOT NULL DEFAULT 'Chưa cập nhật';
ALTER TABLE stories ADD COLUMN source_url TEXT;
ALTER TABLE chapters ADD COLUMN source_url TEXT;
CREATE UNIQUE INDEX idx_stories_source_url ON stories(source_url) WHERE source_url IS NOT NULL;
