import assert from "node:assert/strict";
import test from "node:test";
import { planIntegration, renderIntegrationCard } from "../shared/integration-planner.mjs";
import { executeIntegration } from "../shared/integration-execution.mjs";

function input() {
  return { project: { id: "p", activityRevision: "1" }, target: { branch: "features/test", sha: "a" },
    policy: { authority: { projectId: "p", targetBranch: "features/test", mode: "merge", method: "merge", maxActions: 1, transport: "git-cas-push", allowForceWithLease: true } }, issues: [],
    mergeRequests: [{ id: "1", sourceBranch: "feature/a", sourceSha: "b", targetBranch: "features/test", targetSha: "a", providerRevision: "1", changedFiles: ["a.js"], domains: [], dependsOn: [], draft: false, discussionsResolved: true, ci: "passed", runtimeEvidence: "passed", review: "approved", mergeability: "mergeable", git: "clean", inclusion: "absent" }] };
}

test("one authorized merge revalidates inputs and independently verifies target inclusion", async () => {
  const state = input(); const plan = planIntegration(state); const calls = [];
  assert.equal(plan.nextAction.type, "merge");
  const result = await executeIntegration(plan.revision, {
    readSnapshot: async () => { calls.push("snapshot"); return state; },
    merge: async request => { calls.push(request); return { acceptedSha: "b" }; },
    readTarget: async () => { calls.push("readback"); return { sha: "b", containsAccepted: true }; },
  });
  assert.equal(result.status, "integrated");
  assert.equal(calls.filter(c => typeof c === "object").length, 1);
  assert.equal(calls.at(-1), "readback");
  assert.equal(state.issues.length, 0);
  assert.match(renderIntegrationCard(plan), /integration-readiness:v1/);
});

test("stale target/source, missing authority and production targets never write", async () => {
  for (const change of [s => { s.target.sha = "new"; }, s => { s.mergeRequests[0].sourceSha = "new"; }, s => { s.policy = {}; }, s => { s.target.branch = "main"; s.policy.authority.targetBranch = "main"; s.mergeRequests[0].targetBranch = "main"; }]) {
    const state = input(); const revision = planIntegration(state).revision; change(state);
    const result = await executeIntegration(revision, { readSnapshot: async () => state, merge: async () => assert.fail("unauthorized write"), readTarget: async () => assert.fail("no merge") });
    assert.notEqual(result.status, "integrated");
  }
});

test("ambiguous merge or failed readback stops without retry", async () => {
  for (const failure of ["merge", "readback"]) {
    const state = input(); let writes = 0;
    const result = await executeIntegration(planIntegration(state).revision, {
      readSnapshot: async () => state,
      merge: async () => { writes++; if (failure === "merge") throw new Error("timeout"); return { acceptedSha: "b" }; },
      readTarget: async () => ({ sha: "a", containsAccepted: false }),
    });
    assert.equal(result.status, "execution_error"); assert.equal(writes, 1); assert.equal(result.requiresReplan, true);
  }
});
