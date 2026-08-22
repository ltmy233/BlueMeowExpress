CREATE TABLE contact_preferences (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pinned INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, contact_id),
  CHECK (owner_id <> contact_id)
);

CREATE INDEX contact_preferences_blocked
  ON contact_preferences(owner_id, blocked);
