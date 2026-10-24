---
name: manage-taskboard
version: 1.0.0
description: Manage Codex Taskboard issues and taskctl setup when the request names Codex Taskboard, e-taskboard, or taskctl, or the conversation already establishes that board as the target. Not for GitHub, Phabricator, other external trackers, or unrelated product docs.
---

# Manage Taskboard

This skill serves the local-first Codex Taskboard product, including its configured LAN and cloud services.

Apply the workflow below only to work explicitly targeting Codex Taskboard or already established as belonging to it in the conversation. An issue identifier, repository, or generic request to manage tasks, sync status, or add comments does not establish that scope. For GitHub, Phabricator, or another external tracker, use that system's tools and workflow; do not query, claim, or mirror its issues in Taskboard unless the user asks for that board operation. When the target is unclear, clarify it before running `taskctl`.

Within that scope, use `taskctl` for every project, issue, relation, and comment operation. Consume its JSON output. Use the exact issue identifier returned by the taskboard or supplied in the prompt. Never assume, derive, or rewrite an identifier prefix.

Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Select the CLI and active service

- Use the exact `taskctl` binary and Taskboard URL supplied by the task or injected runtime. Do not replace them with a global CLI, the default port, or another board.
- On Windows, when no binary is injected and the desktop app is installed, use `& "$env:LOCALAPPDATA\Codex Taskboard\bin\taskctl.cmd" issue get ID --json` in PowerShell. The packaged wrapper reads the active launcher runtime. If this packaged path is absent, stop and ask for the exact installed `taskctl.cmd` path; do not switch to a global CLI or guess the service URL.
- On macOS, when no binary is injected and the desktop app is installed, use `'/Applications/Codex Taskboard.app/Contents/Resources/bin/taskctl' issue get ID --json`. Keep the single quotes because the path contains a space. The packaged wrapper reads the active launcher runtime; do not search the filesystem for another CLI or reconstruct the tokenized URL.
- On Linux, when no binary is injected and Codex was started by the desktop app, use `taskctl issue get ID --json`. The desktop app adds its packaged wrapper to the managed Codex `PATH`; do not search the filesystem for another CLI or reconstruct the tokenized URL.
- If that exact command reaches a sandbox restriction on the loopback service, retry the same command with the required permission. Do not switch binaries or endpoints.

## Terminology: local companion

In this product, **companion** means the **device-local loopback service** used for cloud mode (Codex/Git/Skill/MCP, path mapping, Basic Auth proxy). Related names: `local companion`, `loopback companion`, `CODEX_TASKBOARD_COMPANION_URL`, `cloud-companion.json`, `LOCAL_COMPANION_REQUIRED`.

When writing Chinese, keep the English word or use **本地 companion** / **本地配套服务** / **环回代理**. Never translate as **伴侣** or invent **伴侣 API**. Ordinary task/comment/attachment HTTP routes (`/api/tasks`, `/api/comments`, `/api/attachments`, …) are the **Taskboard HTTP API** (or local server API)—not “companion API”.

## Core workflow

1. For an existing issue, first run `issue get` and `comment list`. Also run `attachment list --task`. On the first handoff, omit `--after` and read the full results. Keep the separate `nextCursor` from each list. When the same task resumes, run `issue get` again, then pass each saved cursor to its matching list with `--after` so only new or modified entries are returned. Comment lists include the attachments on returned comments; use `attachment list --comment` with its own cursor when a known comment attachment list can grow. Read the description and latest comments before deciding whether to start. Treat comments as current requirements, including returned work. If they say to wait, not execute, or not start now, stop and report without changing the status.
2. Treat `backlog` as not approved for execution unless the user explicitly authorizes that issue. If work may start, claim it before reading code, downloading attachments, analyzing the implementation, or doing any other task work. Read authoritative eligibility and claim/resume through [execution ownership](references/execution-protocol.md); continue only after independent readback proves the current real owner and claim. Historical `threadBinding` / `agentSession` alone never locks a `todo`; another active claim or legacy unverified execution remains protected.
3. If claim conflicts, read the issue, comments and authoritative eligibility again. Retry once only if it remains eligible, no other active owner exists, and requirements are unchanged; preserve the request ID for an uncertain retry. A changed status, owner, requirements, policy or permanent API error ends this slot. Never loop or take over another agent's claim.
4. For a new durable requirement, run `context current`. Treat its project as a workspace match only when `project.workspacePath` is the current directory or one of its ancestors. An unmatched `local` project is the documented fallback, not proof that the requirement belongs in the global project. If the user named a target project or the working directory identifies one, run `project list`, select that exact project by id or name, and stop to ask if the result is ambiguous. Search existing project issues before creating one in that confirmed project, then pass its explicit id to `issue create`. Update a matching issue instead of creating a duplicate. Use the fallback only when the user explicitly wants the global project. Do not track trivial requests.
5. Execute only the requested work in the issue's branch or worktree when one is bound.
6. Verify the requested operation path. Add a comment with the changes, verification result, outcome, and remaining risks. Read the issue again, then release the active claim to `in_review` with its current `version`, claim ID and owner; read back preserved history and no active claim.
7. Move an issue to `done` only after the user explicitly accepts it or asks to complete it. Use `blocked` when work cannot continue and `canceled` when it will not continue.

## Other operations

- Run `taskctl project readme get [PROJECT_ID]` to inspect project architecture, constraints, and conventions before planning or executing complex tasks.
- Keep the project README focused on root overview and conventions; store detailed multi-page documentation in the local repository's `docs/` folder.
- Preserve existing issue scope when adding requirements or acceptance details.
- Add only relations that the work requires. Use parent for contained work, blocks or blocked_by for dependencies, and related for close association.
- For Codex controller attribution, let `taskctl` read `CODEX_THREAD_ID` or pass the exact Codex conversation ID with `--thread-id`. This value alone is not a complete task binding. For Claude Code, Pi, AGY, or Grok session traceability, pass `--agent-platform claude|pi|agy|grok --session-id ID` instead; see [CLI session traceability](references/cli.md#external-toolsession-traceability). Historical attribution is separate from the execution owner; see [execution ownership](references/execution-protocol.md).
- Codex execution owners require all five real fields: `threadId`, `codexProjectId`, `codexProjectKind`, `codexHostId`, `workspacePath`. Pass all five `--binding-*` flags matching the current native thread. Missing identity stops execution; never synthesize a legacy one-field owner.
- Preserve the exact active claim owner and claim ID for resume and execution writes. Preserve historical provenance independently; recovery never clears historical sessions as an unlocking shortcut. Read [execution ownership](references/execution-protocol.md) for legacy and interrupted claims.
- Use the latest returned `version` with `--if-version` for concurrent updates. On conflict, read the issue again and reconcile before retrying.
- Download and inspect an inline `![alt](api/attachments/<id>/content)` image only when it is needed to understand the requirement.
