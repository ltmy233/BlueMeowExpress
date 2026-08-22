CREATE TABLE device_migration_codes (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  new_fingerprint TEXT NOT NULL,
  new_public_identity TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

ALTER TABLE users ADD COLUMN device_epoch INTEGER NOT NULL DEFAULT 0;
