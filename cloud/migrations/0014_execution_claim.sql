ALTER TABLE tasks ADD COLUMN execution_state TEXT;
ALTER TABLE projects ADD COLUMN execution_policy TEXT;
ALTER TABLE projects ADD COLUMN execution_policy_version INTEGER NOT NULL DEFAULT 1;
