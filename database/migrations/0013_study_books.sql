-- A study session is one page range of a book: several sessions can share one private story, each owning its own
-- chapter. Saves and renders address that chapter by id so one range never rewrites another range's chapter.
ALTER TABLE study_sessions ADD COLUMN library_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL;
-- Page numbers are relative to the uploaded file (not the printed book); with the file hash they let the workspace
-- suggest the next range and place a new range next to its siblings from the same file.
ALTER TABLE study_sessions ADD COLUMN page_start INTEGER;
ALTER TABLE study_sessions ADD COLUMN page_end INTEGER;
ALTER TABLE study_sessions ADD COLUMN source_total_pages INTEGER;
ALTER TABLE study_sessions ADD COLUMN source_sha256 TEXT;
-- The exact translated pages (JSON array, e.g. [12,13,14,37]): a range can be a list, and the whole-book PDF puts each
-- translated page back in its place among the original pages.
ALTER TABLE study_sessions ADD COLUMN source_pages TEXT;
-- When the translation of a range last changed. updated_at also moves on a rename or a move between books; when two
-- ranges translated the same page, the whole-book PDF uses the newer translation, which only this time tells.
ALTER TABLE study_sessions ADD COLUMN translated_at TEXT;

-- The cover the student kept for a book: page cover_page of the file cover_source_sha256 stays original artwork and is
-- the image in cover_key. 0 means the student chose no cover; NULL means nothing was chosen yet.
ALTER TABLE stories ADD COLUMN cover_page INTEGER;
ALTER TABLE stories ADD COLUMN cover_source_sha256 TEXT;

CREATE INDEX idx_study_sessions_user_sha ON study_sessions(user_id, source_sha256);
CREATE INDEX idx_study_sessions_library_chapter ON study_sessions(library_chapter_id);

-- Before this migration the last save is the best record of when a range was translated.
UPDATE study_sessions SET translated_at=updated_at WHERE translated_at IS NULL;

-- Every study story created before this migration holds exactly the one chapter of the session that created it.
UPDATE study_sessions SET library_chapter_id=(SELECT c.id FROM chapters c WHERE c.story_id=study_sessions.library_story_id ORDER BY c.created_at,c.id LIMIT 1)
 WHERE library_story_id IS NOT NULL AND library_chapter_id IS NULL;
