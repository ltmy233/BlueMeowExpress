ALTER TABLE users ADD COLUMN ban_expires_at INTEGER;
ALTER TABLE users ADD COLUMN banned_until INTEGER;

CREATE INDEX users_active_bans ON users(banned_at, ban_expires_at);