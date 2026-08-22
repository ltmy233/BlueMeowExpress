CREATE TABLE IF NOT EXISTS invite_tokens (
  token TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('group','user')),
  target_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_type_id ON invite_tokens(type, target_id);
