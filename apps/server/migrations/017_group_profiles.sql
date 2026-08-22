ALTER TABLE chat_groups ADD COLUMN group_code TEXT;
ALTER TABLE chat_groups ADD COLUMN avatar_url TEXT;

UPDATE chat_groups
SET group_code = printf('%06d', 100000 + id)
WHERE group_code IS NULL;

CREATE UNIQUE INDEX chat_groups_group_code_unique ON chat_groups(group_code);
