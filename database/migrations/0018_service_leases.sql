-- One call to the PDF layout service at a time per account (extract, refresh, render): the service runs only a few
-- jobs at once and one call can hold a job for minutes, so a single account must never hold them all. A call takes
-- its key ('pdf:<user id>') and deletes the row when it ends; expires_at (ms) frees the key of a call whose Worker
-- stopped before it could. token tells this call's lease from a newer one taken after it ran out.
CREATE TABLE service_leases (key TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);

-- Set when the deletion of an account starts, before anything is removed: its sessions stop working at once, and a
-- request that was already running removes what it writes after that (account.js accountActive). A deletion that
-- cannot finish (one of the account's books is being translated) clears it again.
ALTER TABLE reader_users ADD COLUMN deleting_at TEXT;
