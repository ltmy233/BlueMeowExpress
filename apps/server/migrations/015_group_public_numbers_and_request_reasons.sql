ALTER TABLE chat_groups ADD COLUMN public_number TEXT;
CREATE UNIQUE INDEX chat_groups_public_number_unique ON chat_groups(public_number);

ALTER TABLE group_join_requests ADD COLUMN rejection_reason TEXT;
