---
name: manage-taskboard
version: 1.0.0
description: Use when tracking Taskboard issues, comments, relations, review handoffs, or Coding workflow runs through taskctl.
---

# Manage Taskboard

Use `taskctl` for every project, issue, and comment operation. Read [references/cli.md](references/cli.md) before choosing a command or option.

## Workflow

1. Search for an existing issue before creating one. Use `context current`, then list the project issues and compare their identifiers, titles, descriptions, and status.
   - If an issue already tracks the same requirement, append the new requirement or acceptance detail to that issue without discarding its existing scope.
   - If the work depends on, blocks, is blocked by, or is closely related to another issue, add the matching issue relation.
   - Use a parent/sub-issue relation when one requirement is a contained part of a larger issue. A child has one parent; a parent may have many sub-issues.
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
2. Before executing an issue, read the latest issue content and all comments. Treat comments as part of the current requirements, especially when completed work has been returned for changes.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text.
   - When understanding that image is necessary, use `attachment download` to save it locally, then inspect the saved file with an available image-viewing tool.
3. Create or update issues with the CLI; consume its JSON output.
   Issues created through `taskctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
4. Let `taskctl` attribute every issue, relation, or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`.
5. To claim a `todo` issue, move it to `in_progress` with `--if-version` from the latest read before starting implementation. If this claim reports a version conflict or a new read shows that its status changed, skip the issue and do not implement it.
6. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
7. Before requesting review, verify the requested work and acceptance criteria.
8. After implementation and self-verification, add a comment summarizing the key changes, verification, result, and remaining risks; then move the issue to `in_review`. Never move it directly to `done`.
9. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Codex self-verification alone is not sufficient.
10. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

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
