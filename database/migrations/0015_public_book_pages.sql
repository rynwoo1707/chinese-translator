-- A PDF part of a library book can say which pages of which stored original it translates, as study_sessions does for a
-- student's book, so readers rebuild the whole book like the original and read each page beside its source. The
-- original is kept at library/<story>/sources/<source_sha256>.pdf; its page count and file name are copied here when the
-- part is added. NULL for every older chapter.
ALTER TABLE chapters ADD COLUMN source_sha256 TEXT;
-- JSON array of 1-based pages of that file, in the order of the part's PDF pages, e.g. [2,3,4].
ALTER TABLE chapters ADD COLUMN source_pages TEXT;
ALTER TABLE chapters ADD COLUMN source_total_pages INTEGER;
ALTER TABLE chapters ADD COLUMN source_filename TEXT;
