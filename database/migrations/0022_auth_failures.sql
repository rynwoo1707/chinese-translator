-- Wrong passwords (reader-auth.js): each kind of count (an email with a network, an email, a network, a browser the
-- account signed in from, a signed-in account confirming its password) slows down guessing where it comes from. key is
-- the SHA-256 (hex) of what is counted, so no email or address is stored in clear. level is the count of recent
-- failures: it drains at a steady rate (updated_at, epoch ms, is when it last changed), so waiting a while never resets
-- it at once. A count over its limit locks until locked_until (epoch ms): a minute, doubling with each further failure,
-- never more than an hour. A row unused for a day is removed: nothing is locked for good.
CREATE TABLE auth_failures (key TEXT PRIMARY KEY, level REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_auth_failures_updated ON auth_failures(updated_at);
