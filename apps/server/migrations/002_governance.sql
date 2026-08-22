ALTER TABLE users ADD COLUMN platform_admin_at INTEGER;
ALTER TABLE users ADD COLUMN platform_admin_revoked_at INTEGER;

ALTER TABLE message_queue ADD COLUMN attribution_role TEXT;
ALTER TABLE message_queue ADD COLUMN attribution_label TEXT;

ALTER TABLE chat_groups ADD COLUMN join_mode TEXT NOT NULL DEFAULT 'approval' CHECK(join_mode IN ('open','approval','question','closed'));
ALTER TABLE chat_groups ADD COLUMN join_question TEXT;

ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','moderator','member'));
ALTER TABLE group_members ADD COLUMN forced_by INTEGER REFERENCES users(id);
UPDATE group_members SET role='owner' WHERE user_id=(SELECT owner_id FROM chat_groups WHERE id=group_members.group_id);

CREATE TABLE platform_admin_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  redeemed_by INTEGER REFERENCES users(id),
  redeemed_at INTEGER
);

CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  archived_at INTEGER,
  created_by TEXT NOT NULL
);

CREATE TABLE disclaimer_acceptances (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, version)
);

CREATE TABLE user_mutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_by_actor TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
  ,CHECK(created_by IS NOT NULL OR created_by_actor IS NOT NULL)
);
CREATE INDEX user_mutes_active ON user_mutes(user_id, group_id, expires_at, revoked_at);

CREATE TABLE group_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE UNIQUE INDEX group_join_pending ON group_join_requests(group_id,user_id) WHERE status='pending';

CREATE TABLE message_metadata (
  id TEXT PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  removed_by INTEGER REFERENCES users(id),
  removal_reason TEXT,
  CHECK((recipient_id IS NULL) <> (group_id IS NULL))
);
CREATE INDEX message_metadata_group ON message_metadata(group_id, created_at);

CREATE TABLE group_message_queue (
  delivery_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message_metadata(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  envelope TEXT NOT NULL,
  attribution_role TEXT,
  attribution_label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX group_message_queue_recipient ON group_message_queue(recipient_id, expires_at);
