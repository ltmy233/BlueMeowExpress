CREATE TABLE message_tombstones (
  id TEXT PRIMARY KEY,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direct_recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type = 'message-recalled'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(recipient_id, message_id, event_type)
);

CREATE INDEX message_tombstones_recipient
  ON message_tombstones(recipient_id, expires_at, created_at);
