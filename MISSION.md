# Mission: Understand and identify Taskboard service instances

## Why
When several Taskboard checkouts or worktrees exist, determine which code, database, HTTP service, and target workspace are actually in use. This prevents a newly opened workspace from silently appearing to operate an older service.

## Success looks like
- Trace `npm run dev` from launcher to Vite, API server, SQLite, and the browser.
- Distinguish a Taskboard source checkout, a running service instance, and a project's `workspacePath`.
- Identify the owner of a port and the endpoint used by `taskctl` without guessing.
- Configure separate ports and data directories when two checkouts must run side by side.

## Constraints
- Use this repository's source code and observable local process state as primary evidence.
- Learn one operational path at a time, beginning with local development and `taskctl`.

## Out of scope
- Cloudflare deployment, Tauri packaging, and Codex injection internals.
- Architecture changes or fixes before the current behavior is understood and confirmed.
