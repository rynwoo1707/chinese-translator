ALTER TABLE chapters ADD COLUMN position INTEGER;
CREATE INDEX idx_chapters_story_position ON chapters(story_id, position, created_at);
