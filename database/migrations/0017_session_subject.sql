-- Subjects added after 0011 (physics, chemistry, biology, informatics) cannot pass the CHECK on study_sessions.domain,
-- which SQLite cannot alter in place: a session keeps a legacy value in domain and its real subject here.
ALTER TABLE study_sessions ADD COLUMN subject TEXT;
