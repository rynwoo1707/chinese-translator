-- revision counts the saves of a history session. A save may name the revision it was made from: one made from an older
-- copy (another tab or device saved since) is refused instead of overwriting newer work.
ALTER TABLE study_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
-- What the session's last save stored in R2 (state.json and translation.txt, UTF-8 bytes), so an account's history can be
-- held to a size. 0: saved before this migration; the size is then estimated from the character counts.
ALTER TABLE study_sessions ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
