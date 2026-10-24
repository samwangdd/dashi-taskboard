# Execution claims

`threadBinding` / `agentSession` record conversation provenance. `executionState.active` alone records a current execution owner; it has an opaque claim ID, complete session identity, request ID, start time and progress time. The first claim snapshots existing provenance in `executionState.origins`; each release appends an immutable history entry. Local Codex owners keep all five real identity fields. Cloud owners use a stable `workspaceKey` (or `sessionKey` for a path-based external session); absolute device paths stay in the local companion. Its `executionWorkspace` view resolves a key only against existing device project/worktree mappings and explicitly returns `resolved=false` when none matches. Hashing does not reconstruct a missing path. Claims do not expire. An old or invisible executor remains protected.

## Read, claim and hand off

1. Read the full issue, comments and attachments for semantic permission, then run `taskctl issue eligibility ID --project PROJECT --json`. The response includes `eligible`, stable `reason`, task `version`, project `policyVersion`, and the effective policy. Eligibility is a read-only preview, never a lock.
2. Use `issue claim ID --project PROJECT --policy-version N --if-version N --request-id UNIQUE_ID` with either external `--agent-platform PLATFORM --session-id SESSION` or all five Codex `--binding-*` flags matching the real `--thread-id`. Keep the same request ID for uncertain retries. Claim atomically rechecks eligibility, enters `in_progress`, stores the owner and writes an activity. A stale version or policy returns a conflict; refresh instead of taking over.
3. Read back the issue and retain `executionState.active.id`. Continue with `issue resume ID --claim-id CLAIM ...identity --if-version N`; this retains the claim across scheduler ticks. `issue update` / `issue move` need the same `--claim-id` and owner for an executing issue. Task field updates use optimistic task versions. Comments and relations retain their separate provenance semantics and do not create, renew or release execution ownership.
4. Hand off with `issue release ID --claim-id CLAIM --status todo|in_review|blocked|done|canceled ...identity --if-version N`. Only the current owner can release. A blocked handoff ends execution; rescheduling requires an explicit return to `todo` and satisfied semantic prerequisites. Workflow/user acceptance still controls whether `done` is authorized.

`todo` with no active claim may be claimed even when provenance points to another historical session. A different active owner cannot be resumed or replaced. Old clients that create or move directly into `in_progress`, or edit an active task without owner proof, receive `426 EXECUTION_PROTOCOL_REQUIRED`. Upgrade the server and taskctl together; there is no legacy lock fallback. Archive and project moves require release first.

## Project policy

`taskctl project execution-policy get PROJECT` reads the policy and its independent version. `... set PROJECT --policy-file FILE --if-version N` replaces it with a version check. The JSON has `dependencyUnlockStatuses` (allowed: `done`, `canceled`, `in_review`), `holdLabels`, and `excludeParentSummaries`. Defaults are `done`, `hold`, and excluding parent summaries. A selector's ordering, serial lanes, and parallel limits remain project policy in that selector. Semantic approval remains a human/agent read of requirements and recent comments.

The shared evaluator is used by SQLite and D1. Claim writes also recheck dependency rows and parent relations inside the atomic write. D1 checks the persisted project policy version in that same write. The preflight response is tied to task and policy versions, not an expiring lease.

## Migration preview and recovery

Local startup adds nullable `tasks.execution_state` and project policy columns idempotently. Cloud uses migration `0014_execution_claim.sql`; local-to-cloud export/import preserves execution state and project policy/version, converting device paths to stable keys before export. apply it through the existing deployment migration workflow before starting the new Worker. No startup migration changes task statuses, removes provenance, or creates/releases claims. Run `taskctl issue execution-preview --project PROJECT --json` before rollout; it only reads and reports each task's current eligibility and versions.

| Existing record / source | Preview / action |
| --- | --- |
| Jira-synchronized source | `external_execution_unsupported`; execution lifecycle is refused. Legacy active Jira PATCH/MOVE validates ownership before any external side effect; no distributed Jira claim transaction is implemented |
| `todo`, historical Codex / external session, no active claim | Eligible if the other gates pass; lazy first-claim provenance snapshot |
| `in_progress`, no execution claim | `legacy_execution_requires_recovery`; preserve binding and evidence; do not auto-claim |
| Any task with active claim | Protected regardless of age or process visibility |
| Archived, held, unresolved dependency, parent summary | Ineligible with a specific reason |
| Contradictory active claim/status or malformed persisted state | Keep protected; inspect the record and evidence before operator recovery |

For a legacy stopped executor, use the existing explicitly authorized recovery workflow to return the task to `todo` while preserving its historical session fields, then claim through the new protocol. For a new active claim after interruption, resume the original real session and release it. There is no automatic timeout, bulk reset, or impersonation-based recovery command. If that real session cannot resume, leave the claim protected for explicit operator recovery; this change does not implement a transfer UI.

Test only disposable local databases and Miniflare D1 fixtures during development. The API/CLI integration suite covers historical Codex and Claude handoff, concurrent claim, stale owner, lifecycle, policy conflict and transaction rollback. It is included by `npm test`'s existing `test/*.test.mjs` glob.
