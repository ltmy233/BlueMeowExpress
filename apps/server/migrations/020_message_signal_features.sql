-- Message metadata for Signal-like features: read receipts, reactions, edits, disappearing timer, typing presence

CREATE TABLE message_reads (
  message_id TEXT NOT NULL REFERENCES message_metadata(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_reads_user ON message_reads(user_id, read_at);

CREATE TABLE message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message_metadata(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (message_id, user_id)
);
CREATE INDEX message_reactions_message ON message_reactions(message_id, created_at);

ALTER TABLE message_metadata ADD COLUMN edited_at INTEGER;
ALTER TABLE message_metadata ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE message_metadata ADD COLUMN disappears_at INTEGER;

CREATE TABLE conversation_mutes (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
  muted_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((target_id IS NULL) <> (group_id IS NULL)),
  PRIMARY KEY (owner_id, target_id, group_id)
);

CREATE TABLE conversation_disappearing (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
  seconds INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  CHECK ((target_id IS NULL) <> (group_id IS NULL)),
  PRIMARY KEY (owner_id, target_id, group_id)
);