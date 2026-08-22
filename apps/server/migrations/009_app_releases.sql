CREATE TABLE IF NOT EXISTS app_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_name TEXT NOT NULL,
  version_code INTEGER NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  force_update INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS app_releases_published_idx ON app_releases(published_at DESC);