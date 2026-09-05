ALTER TABLE tasks
  ADD COLUMN creator_agent_kind TEXT
  CHECK (creator_agent_kind IS NULL OR creator_agent_kind IN ('claude-code', 'codex', 'unknown'));

ALTER TABLE tasks
  ADD COLUMN thread_agent_kind TEXT
  CHECK (thread_agent_kind IS NULL OR thread_agent_kind IN ('claude-code', 'codex', 'unknown'));

ALTER TABLE comments
  ADD COLUMN author_agent_kind TEXT
  CHECK (author_agent_kind IS NULL OR author_agent_kind IN ('claude-code', 'codex', 'unknown'));

ALTER TABLE task_activities
  ADD COLUMN actor_agent_kind TEXT
  CHECK (actor_agent_kind IS NULL OR actor_agent_kind IN ('claude-code', 'codex', 'unknown'));
