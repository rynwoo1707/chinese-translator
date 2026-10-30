-- The coverage stamp (services/pdf-layout/extract.py EXTRACTION_VERSION, its oldest page's) of the layout a study session
-- was saved or exported with. Thư viện riêng marks a part an older extractor read ("Bố cục cũ") and Xưởng dịch offers
-- "Cập nhật bố cục" for it. NULL: no kept layout, or saved before this migration (such a layout part is older).
ALTER TABLE study_sessions ADD COLUMN layout_version INTEGER;
-- The library part a range takes over once it is complete (a refreshed layout, or a range translated again with "Thay
-- phần …"), kept from its first save: a draft continued in another tab or on another device still replaces that part
-- instead of adding the same pages to the book twice.
ALTER TABLE study_sessions ADD COLUMN replaces_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL;
CREATE INDEX idx_study_sessions_replaces ON study_sessions(replaces_chapter_id);
-- The kept layout (its pdf asset id) a refreshed copy was made from ("Cập nhật bố cục"), whatever file hashes older rows
-- lack: once complete the copy takes over that layout's part, keeping its PDF until its own export, and that layout, a
-- draft refreshed before it was finished, never adds the same pages to the book a second time.
ALTER TABLE study_sessions ADD COLUMN refreshed_from TEXT;
