ALTER TABLE tasks
ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1));

ALTER TABLE tasks ADD COLUMN review_artifact TEXT;

UPDATE tasks
SET review_required = 1
WHERE development_context_type IS NOT NULL;
