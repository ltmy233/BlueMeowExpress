CREATE TABLE status_updates (
  id TEXT PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('text','image')),
  text_content TEXT,
  image_url TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX status_updates_author ON status_updates(author_id, expires_at);
CREATE INDEX status_updates_expiry ON status_updates(expires_at);

CREATE TABLE status_views (
  status_id TEXT NOT NULL REFERENCES status_updates(id) ON DELETE CASCADE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY(status_id, viewer_id)
);