ALTER TABLE users ADD COLUMN public_identity TEXT;
ALTER TABLE users ADD COLUMN identity_fingerprint TEXT;
ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT 'private' CHECK(gender IN ('female','male','nonbinary','private'));

CREATE INDEX message_metadata_recipient ON message_metadata(recipient_id, created_at);
