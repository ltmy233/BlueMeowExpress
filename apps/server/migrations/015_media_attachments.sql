CREATE TABLE media_attachments (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direct_recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK((direct_recipient_id IS NOT NULL AND group_id IS NULL) OR (direct_recipient_id IS NULL AND group_id IS NOT NULL))
);

CREATE INDEX media_attachments_direct ON media_attachments(owner_id, direct_recipient_id);
CREATE INDEX media_attachments_group ON media_attachments(group_id);
