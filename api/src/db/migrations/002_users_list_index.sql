-- 002: index for GET /v1/users keyset pagination (WHERE account_id = $1 AND (created_at, id) > …
-- ORDER BY created_at, id). Without it every page sorts all of the account's users.
-- Plain CREATE INDEX (not CONCURRENTLY): migrations run inside a transaction, and the
-- users table is empty when this first ships.
CREATE INDEX users_account_created ON users (account_id, created_at, id);
