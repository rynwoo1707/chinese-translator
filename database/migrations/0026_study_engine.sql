-- Modes added after 0011 ("Kỹ nhất", premium) cannot pass the CHECK on study_sessions.mode, which SQLite cannot alter in
-- place: a session keeps a legacy value in mode (premium is stored as quality) and its real mode here. Sessions saved
-- before this migration have none, and a version without this column saves mode alone: reads take engine only while mode
-- still holds its legacy value (backend/study-history.js storedMode).
ALTER TABLE study_sessions ADD COLUMN engine TEXT;
