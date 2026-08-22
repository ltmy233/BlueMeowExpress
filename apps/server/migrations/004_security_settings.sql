ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
ALTER TABLE users ADD COLUMN self_destruct_days INTEGER;
ALTER TABLE users ADD COLUMN message_auto_delete_seconds INTEGER;
UPDATE users SET last_seen_at=COALESCE(last_seen_at, updated_at, created_at);
