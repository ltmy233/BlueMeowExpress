ALTER TABLE contacts ADD COLUMN request_message TEXT NOT NULL DEFAULT '';

ALTER TABLE chat_groups ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 0 CHECK(auto_review IN (0,1));
ALTER TABLE chat_groups ADD COLUMN join_answer TEXT;

ALTER TABLE group_members ADD COLUMN member_title TEXT NOT NULL DEFAULT '';
ALTER TABLE group_members ADD COLUMN member_level INTEGER NOT NULL DEFAULT 1 CHECK(member_level BETWEEN 1 AND 100);
