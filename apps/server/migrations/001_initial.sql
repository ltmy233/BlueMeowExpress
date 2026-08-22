PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  banned_at INTEGER,
  ban_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, contact_id),
  CHECK(user_id < contact_id)
);

CREATE TABLE IF NOT EXISTS chat_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS vip_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  redeemed_by INTEGER REFERENCES users(id),
  redeemed_at INTEGER
);

CREATE TABLE IF NOT EXISTS vip_entitlements (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_queue (
  id TEXT PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  envelope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS message_queue_recipient ON message_queue(recipient_id, expires_at);

CREATE TABLE IF NOT EXISTS admin_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at DESC);
