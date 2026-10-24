import assert from "node:assert/strict";
import { test } from "node:test";
import { executionEligibility, transitionExecution } from "../shared/execution-claim.mjs";
const owner = { platform: "claude", sessionId: "new-session" };
const task = (extra = {}) => ({ id: "t", projectId: "p", status: "todo", version: 1, archivedAt: null, labels: [], relations: { blockedBy: [], subIssues: [] }, executionState: null, ...extra });
test("historical Claude and Codex origins are not occupancy", () => {
  for (const history of [{ agentSession: { platform: "claude", sessionId: "old" } }, { threadBinding: { threadId: "old" } }]) {
    assert.equal(executionEligibility(task(history), "p").eligible, true);
    const result = transitionExecution(task(history), { action: "claim", policyVersion: 1, owner, requestId: "one", version: 1, projectId: "p" }, "claim-one", "now");
    assert.equal(result.state.active.owner.sessionId, "new-session");
    assert.deepEqual(result.state.origins, { threadBinding: history.threadBinding ?? null, agentSession: history.agentSession ?? null, legacyLocalThreadId: null });
  }
});
test("active claim protects all platforms and never expires", () => {
  const claimed = transitionExecution(task(), { action: "claim", policyVersion: 1, owner, requestId: "one", version: 1, projectId: "p" }, "claim-one", "1900");
  const active = task({ status: "in_progress", executionState: claimed.state, version: 2 });
  assert.equal(executionEligibility(active, "p").reason, "active_claim");
  assert.throws(() => transitionExecution(active, { action: "resume", owner: { platform: "claude", sessionId: "other" }, claimId: "claim-one", version: 2 }, "unused", "now"), /owner/);
  assert.equal(transitionExecution(active, { action: "resume", owner, claimId: "claim-one", version: 2 }, "unused", "now").state.active.id, "claim-one");
  const released = transitionExecution(active, { action: "release", owner, claimId: "claim-one", version: 2, status: "todo" }, "unused", "now");
  assert.equal(released.state.active, null);
  assert.equal(released.state.history[0].id, "claim-one");
  assert.throws(() => transitionExecution(task({ executionState: released.state }), { action: "resume", owner, claimId: "claim-one", version: 1 }, "unused", "now"), /claim/);
});
test("mechanical eligibility reports stable reasons", () => {
  for (const [extra, reason] of [[{ status: "in_progress" }, "legacy_execution_requires_recovery"], [{ archivedAt: "date" }, "archived"], [{ executionState: { hold: true } }, "hold"], [{ relations: { blockedBy: [{ status: "todo" }], subIssues: [] } }, "unresolved_dependency"], [{ relations: { blockedBy: [], subIssues: [{}] } }, "parent_summary"], [{ projectId: "other" }, "project_mismatch"]]) {
    assert.equal(executionEligibility(task(extra), "p").reason, reason);
  }
  assert.throws(() => transitionExecution(task(), { action: "claim", policyVersion: 1, owner: { platform: "codex", threadId: "partial" }, version: 1, projectId: "p", requestId: "a" }, "id", "now"), /identity/);
});
