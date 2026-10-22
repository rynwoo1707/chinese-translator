-- Registration also refuses an email that an account signing in with Google already holds (reader-auth.js). Such an
-- account keeps its email in reader_users.email as Google gave it; this index lets the check (lower(email)=?) find it
-- without reading every account. The code works without it, only slower.
CREATE INDEX IF NOT EXISTS idx_reader_users_email ON reader_users(lower(email));
