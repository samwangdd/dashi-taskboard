---
name: manage-taskboard
version: 1.0.0
description: Use when tracking Taskboard issues, comments, relations, review handoffs, or Coding workflow runs through taskctl.
---

# Manage Taskboard

Use `taskctl` for every project, issue, relation, and comment operation. Consume its JSON output. Use the exact issue identifier returned by the taskboard or supplied in the prompt. Never assume, derive, or rewrite an identifier prefix.

Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Terminology: local companion

In this product, **companion** means the **device-local loopback service** used for cloud mode (Codex/Git/Skill/MCP, path mapping, Basic Auth proxy). Related names: `local companion`, `loopback companion`, `CODEX_TASKBOARD_COMPANION_URL`, `cloud-companion.json`, `LOCAL_COMPANION_REQUIRED`.

When writing Chinese, keep the English word or use **本地 companion** / **本地配套服务** / **环回代理**. Never translate as **伴侣** or invent **伴侣 API**. Ordinary task/comment/attachment HTTP routes (`/api/tasks`, `/api/comments`, `/api/attachments`, …) are the **Taskboard HTTP API** (or local server API)—not “companion API”.

## Core workflow

1. For an existing issue, first run `issue get` and `comment list`. Read the description and latest comments before deciding whether to start. Treat comments as current requirements, including returned work. If they say to wait, not execute, or not start now, stop and report without changing the status.
2. Treat `backlog` as not approved for execution. Unless the user explicitly authorizes that issue, do not claim it, move it to another status, or perform task work; its assignee alone is not authorization. If work may start, claim it before reading code, downloading attachments, analyzing the implementation, or doing any other task work. Move a claimable `todo` to `in_progress` with its current `version`; do not continue until the move succeeds. If it is already `in_progress`, continue only when it is bound to the current conversation. Never move an issue claimed by another conversation.
3. If the move conflicts because the `version` is stale, run `issue get` and `comment list` again. Retry once with the latest `version` only when the issue is still a claimable `todo`, is not bound to another conversation, is not archived, and its description and latest comments are unchanged. If it was claimed, its status or requirements changed, it is archived, the service is unavailable, a permanent API error occurs, or the retry fails, stop and report. Never loop or take over another agent's claim.
4. For a new durable requirement, run `context current` and search existing project issues before creating one. Update a matching issue instead of creating a duplicate. Do not track trivial requests.
5. Execute only the requested work in the issue's branch or worktree when one is bound.
6. Verify the requested operation path. Add a comment with the changes, verification result, outcome, and remaining risks. Read the issue again, then move it to `in_review` with its current `version`.
7. Move an issue to `done` only after the user explicitly accepts it or asks to complete it. Use `blocked` when work cannot continue and `canceled` when it will not continue.

## Other operations

- Preserve existing issue scope when adding requirements or acceptance details.
- Add only relations that the work requires. Use parent for contained work, blocks or blocked_by for dependencies, and related for close association.
- Let `taskctl` read `CODEX_THREAD_ID` for writes. Outside Codex, pass the exact conversation ID with `--thread-id`.
- Use the latest returned `version` with `--if-version` for concurrent updates. On conflict, read the issue again and reconcile before retrying.
- Download and inspect an inline `![alt](api/attachments/<id>/content)` image only when it is needed to understand the requirement.

## Coding workflow

When an issue has `workflowId: "coding"`, do not use the generic implementation and review steps above. The Taskboard companion owns the run state and the exact-file commit:

1. Claiming the issue creates or resumes one coding run and freezes its configured agent models. The companion rejects a dirty branch or worktree before claim. By default, rounds 1–3 use `gpt-5.3-codex-spark`; one final escalation round uses `gpt-5.6-terra`.
2. The orchestrator writes a versioned verification contract before dispatching the implementer.
3. Every role boundary writes a handoff artifact using the `handoff` skill's objective, references, next action, and suggested skills structure. Immediately after a failed verifier verdict, write the verifier → implementer handoff before the next implementation round. The orchestrator remains the state owner but is not a relay hop.
4. The implementer runs only changed-scope unit, integration, and configured type checks through `taskctl coding check`. Every command must contain exactly one `{files}` marker. Full test, typecheck, and build commands are forbidden.
5. The verifier reads captured check evidence instead of repeating those commands. Use the configured UI verifier for UI work and provide preview routes plus expected results in the verification contract.
6. After all configured verification passes, call `taskctl coding commit` without asking for another commit confirmation. The engine commits the recorded files, adds the final summary, and moves the issue to `in_review`. It never pushes or creates a PR.
7. A returned issue resumes the same run and produces an additive commit. Exhausted implementation rounds move the issue to `blocked`; a verified no-code result moves to `in_review` without an empty commit.

Use the `coding` commands in the CLI reference for every run transition. Intermediate rounds stay in coding artifacts; only `in_review` and `blocked` produce user-facing task notifications.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.
