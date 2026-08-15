# Taskboard Architecture Resources

## Knowledge

- [`README.md`](./README.md)
  The repository's supported local startup and side-by-side checkout instructions. Use for: intended ports and configuration.
- [`scripts/dev.mjs`](./scripts/dev.mjs)
  The development process launcher. Use for: seeing that one command starts both the API server and Vite.
- [`web/vite.config.ts`](./web/vite.config.ts)
  The frontend server and API proxy configuration. Use for: proving which backend a browser tab calls.
- [`server/index.mjs`](./server/index.mjs) and [`server/app.mjs`](./server/app.mjs)
  The HTTP entry point and server option resolution. Use for: service port, data directory, SQLite, and static UI identity.
- [`cli/taskctl.mjs`](./cli/taskctl.mjs)
  The CLI endpoint selection logic. Use for: proving that the current shell directory does not choose the service.
- [`server/ai-chat-catalog.mjs`](./server/ai-chat-catalog.mjs) and [`server/ai-chat-process.mjs`](./server/ai-chat-process.mjs)
  Project workspace resolution and Codex launch arguments. Use for: distinguishing the service checkout from the repository an agent acts on.

## Wisdom (Communities)

- This repository's issue history and maintainers
  Use for: validating whether a surprising cross-worktree behavior is intentional before changing lifecycle semantics.

## Gaps

- There is no single built-in command that prints service code root, data directory, port, and client endpoint together.
