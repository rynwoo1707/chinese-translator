-- A whole-book run holds its job while it works: runner_id names the run (one id per browser), lease_until (epoch ms)
-- is renewed by every progress report. Another device's run is refused until the run pauses, finishes or stops
-- reporting, so two devices never translate and pay for the same pages. usage_reports keeps the ids of the last token
-- reports (JSON array): a report sent again after its answer was lost is counted once.
ALTER TABLE book_jobs ADD COLUMN runner_id TEXT;
ALTER TABLE book_jobs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE book_jobs ADD COLUMN usage_reports TEXT NOT NULL DEFAULT '[]';
