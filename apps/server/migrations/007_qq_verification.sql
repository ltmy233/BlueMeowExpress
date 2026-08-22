CREATE TABLE qq_binding_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qq_number TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE qq_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qq_number TEXT NOT NULL,
  group_id TEXT,
  bound_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(user_id),
  UNIQUE(qq_number)
);

CREATE TABLE qq_bot_heartbeats (
  bot_id TEXT PRIMARY KEY,
  bot_name TEXT NOT NULL,
  status TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  group_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX qq_binding_requests_expiry ON qq_binding_requests(expires_at);
CREATE INDEX qq_bindings_qq_number ON qq_bindings(qq_number);
