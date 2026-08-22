ALTER TABLE announcements ADD COLUMN confirm_required INTEGER NOT NULL DEFAULT 0 CHECK(confirm_required IN (0,1));

CREATE TABLE announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(announcement_id, user_id)
);
CREATE INDEX announcement_reads_user ON announcement_reads(user_id, read_at);
