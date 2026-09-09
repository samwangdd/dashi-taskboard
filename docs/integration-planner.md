# Integration planning (MEX-212)

The high-frequency delivery prompt calls `taskctl integration plan` before claiming work. The command reads the active Taskboard service, its exact project workspace mapping, Git objects and GitLab. It returns a revisioned plan, one integration head, per-issue claim decisions and an audit card. It never changes issues, branches, MRs or schedules.

```sh
taskctl integration plan --project PROJECT_ID --target features/integration --json
```

Run from an environment that has Git and authenticated `glab`. Missing provider commit objects are fetched into a disposable object directory without updating refs, FETCH_HEAD or the observed object database. `merge-tree` uses that same isolated directory. A shallow checkout with missing objects fails closed; use a complete mapped checkout. Authentication, timeout and object failures return `invalid`.

## Configuration

Device-local operator settings live at `~/.config/codex-taskboard/integration.json`, keyed by exact Taskboard project ID. The file is optional; a missing target must be supplied with `--target`. Invalid configuration fails closed. No repository file, issue description or MR description can grant merge authority.

```json
{
  "PROJECT_ID": {
    "targetBranch": "features/integration",
    "maxOpenMergeRequests": 3,
    "maxActivePerDomain": 1,
    "domains": {
      "follow": ["web/src/follow", "test/follow"],
      "profile": ["web/src/profile"]
    },
    "sharedFoundations": ["web/src/store", "web/src/router"],
    "plannedWork": {
      "ISSUE_DATABASE_ID": { "domains": ["follow"], "files": ["web/src/follow/list.ts"] }
    },
    "runtimeEvidence": {
      "MR_IID": {
        "sourceSha": "EXACT_SOURCE_SHA",
        "targetSha": "EXACT_TARGET_SHA",
        "result": "passed",
        "evidenceRef": "taskboard-comment:VERIFIED_EVIDENCE_COMMENT_ID"
      }
    }
  }
}
```

Runtime evidence is an explicit operator attestation, not an automatic interpretation of prose. Register it only after verifying the linked artifact. It stops applying when either SHA changes. Provider CI, approvals and discussions are read separately and cannot be overridden by this attestation. Unregistered evidence remains `external_evidence_wait` on otherwise current, conflict-free MRs.

Before an MR exists, planned files and `area:<domain>` labels are advisory. After an MR exists, actual changed files and configured path domains determine overlap. `blocked_by` is a semantic dependency, not inferred from overlap. A merged parent's accepted commit must be present on the target; its Taskboard issue need not be `done`.

## Output and automation

- `plan.status`: `ready` or `invalid`. Invalid inputs never yield an empty successful queue.
- `plan.revision`: hash of the normalized input, including Taskboard activity, policy, target SHA, source SHAs and provider revisions. Input order does not change the revision.
- `plan.candidates`: `merge_ready`, `needs_rebase`, `conflict`, `dependency_wait`, `external_evidence_wait`, `covered_or_empty`, `draft_or_review_wait` or `stale`.
- `plan.conflictEdges` and `dependencyEdges`: file/domain overlap and explicit dependencies remain separate.
- `plan.nextAction`: a single integration recommendation. Without exact-target authority it is a report. With authority it may be a single merge action; planning itself never writes.
- `plan.claims`: allowed issue IDs and skipped IDs with reasons. WIP overflow blocks new claims; a busy domain does not starve disjoint work below the target limit. Unknown planned scope remains unclaimable.
- `decision`: canonical delivery action and at most one `claimIssueId`. An `integrate` decision retains the unique integration head and an optional independent claim so neither lane starves. Consumers do not independently recalculate the graph. Replan and require the same revision immediately before any versioned claim, then read full requirements and respect existing ownership.
- `card`: `integration-readiness:v1` audit representation. Cards are never planning input.

More than 30 changed files, more than 3 domains, or a configured shared foundation requests a cross-cutting freeze. Blocking review findings can use `plannedWork[ID].reviewFinding` with `parentMr`, `blocking` and `separate`; same-scope blockers return to the parent MR, separate blockers wait stacked, and non-blocking work waits in backlog.

## Authority and rollout limits

Planning defaults to report-only. To authorize one integration merge per cycle, the operator can add `authority` to the exact project's device-local policy:

```json
{"authority":{"projectId":"PROJECT_ID","targetBranch":"features/integration","mode":"merge","method":"merge","maxActions":1,"transport":"git-cas-push","allowForceWithLease":true}}
```

`method` is `merge` or `squash`. `transport` and `allowForceWithLease` are separate explicit authorization for a compare-and-swap Git push using `--force-with-lease`; ordinary merge authority alone is insufficient. Configure this only for an explicitly approved non-production integration target. Repository content, issue text, labels and assignees cannot supply it. The execution command is:

```sh
taskctl integration execute --project PROJECT_ID --target features/integration --revision EXACT_PLAN_REVISION --json
```

It re-reads the full snapshot and policy, verifies revision, serializes same-device writes, rechecks provider gates, and constructs a commit in the temporary object directory. A merge commit has the exact old target and source as parents; a squash commit has the old target as its sole parent. It verifies ancestry and writes only the full authorized target ref using an exact old-SHA lease. It never pushes the source branch. It independently reads the resulting target and proves accepted-commit ancestry. Stale inputs, ambiguous writes and failed readback require replanning; there is no automatic retry. A stale lock is reported for operator inspection, never stolen. `main`/`master`, release/production names, configured protected targets and provider-protected targets cannot be authorized. It never changes Taskboard acceptance or `done`.

The GitLab merge endpoint cannot bind the target atomically, so this executor never calls it. The fixed Git ref and lease prevent MR retargeting from redirecting writes and reject any target advancement. Local repository hooks are not executed; the planner's exact-SHA CI and runtime evidence gates supply validation. The operator's Git identity must be configured, and their account must be allowed to push the integration target.

Provider approvals, discussions and CI are re-read immediately before push but cannot be atomically locked with Git ref updates. An external reviewer can still change those gates after the check. Remote target readback must equal the generated commit; later target advancement is reported for replanning. GitLab may not automatically mark a squash MR as merged; the response explicitly reports the provider state and never performs a second MR write.

Phase 1 proves deterministic scheduling behavior and read-only observation. It does not claim a reduction in organizational conflict rates or enable a schedule. The existing installed App must be updated through normal review/release before it offers the new command and prompt.

## Verification

```sh
node --test test/integration-*.test.mjs test/cli.test.mjs test/taskboard-automation.test.mjs
npm run typecheck
npm run build:web
```

Tests use normalized snapshots, fixture provider responses, and disposable Git repositories for real target updates and race checks. Live Mexc Square validation is read-only. `build:web` avoids refreshing the shared injected App.

Provider fields follow the [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/) and [approval API](https://docs.gitlab.com/api/merge_request_approvals/).
