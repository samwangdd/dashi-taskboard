ALTER TABLE tasks ADD COLUMN target_branch TEXT;
UPDATE tasks
SET target_branch = development_branch
WHERE development_context_type = 'branch' AND development_branch IS NOT NULL;
