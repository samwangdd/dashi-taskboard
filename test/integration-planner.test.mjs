import assert from "node:assert/strict";
import test from "node:test";
import { planIntegration } from "../shared/integration-planner.mjs";

export function snapshot(count = 1) {
  return {
    project: { id: "square", activityRevision: "v1" },
    target: { branch: "features/square", sha: "target-a" },
    policy: {},
    issues: [],
    mergeRequests: Array.from({ length: count }, (_, i) => ({
      id: String(i + 1), sourceBranch: `feature/${i + 1}`, sourceSha: `source-${i + 1}`,
      targetBranch: "features/square", targetSha: "target-a", providerRevision: "v1",
      changedFiles: [`feature-${i + 1}.js`], domains: [], dependsOn: [],
      draft: false, discussionsResolved: true, ci: "passed", runtimeEvidence: "passed",
      review: "approved", mergeability: "mergeable", git: "clean", inclusion: "absent",
    })),
  };
}

test("14 MR backlog chooses one integration head and applies claim backpressure", () => {
  const input = snapshot(14);
  input.mergeRequests.forEach((mr, i) => {
    if (i >= 3 && i < 8) mr.git = "behind";
    if (i >= 8 && i < 13) mr.git = "conflict";
    if (i === 13) mr.draft = true;
    if (i < 2) mr.changedFiles = ["follow-list.js", "profile.js"];
  });
  input.issues = [{ id: "todo-follow", status: "todo", domains: ["follow"], plannedFiles: ["follow-list.js"], blockedBy: [] }];
  const plan = planIntegration(input);
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.nextAction, { type: "report", candidateId: "1", proposedAction: "merge", reason: "missing_authorization" });
  assert.equal(plan.candidates.filter(c => c.state === "needs_rebase").length, 5);
  assert.equal(plan.candidates.filter(c => c.state === "conflict").length, 5);
  assert.equal(plan.backpressure.openMergeRequests, 14);
  assert.deepEqual(plan.claims.allowed, []);
  assert.equal(plan.conflictEdges.some(e => e.left === "1" && e.right === "2"), true);
  assert.match(plan.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(planIntegration(input), plan);
});

test("independent lanes remain claimable while file/domain overlap and dependencies wait", () => {
  const input = snapshot(2);
  input.mergeRequests[0].domains = ["follow"];
  input.mergeRequests[1].domains = ["follow"];
  input.mergeRequests[1].dependsOn = ["1"];
  input.issues = [
    { id: "overlap", status: "todo", domains: ["follow"], plannedFiles: [], blockedBy: [] },
    { id: "independent", status: "todo", domains: ["search"], plannedFiles: ["search.js"], blockedBy: [] },
    { id: "dependent", status: "todo", domains: ["other"], plannedFiles: [], blockedBy: ["overlap"] },
    { id: "unknown", status: "todo", domains: [], plannedFiles: [], blockedBy: [] },
  ];
  const plan = planIntegration(input);
  assert.deepEqual(plan.claims.allowed, ["independent"]);
  assert.equal(plan.candidates[1].state, "dependency_wait");
  assert.deepEqual(plan.conflictEdges[0].domains, ["follow"]);
  assert.deepEqual(plan.dependencyEdges, [{ from: "2", to: "1" }]);
  input.mergeRequests[0].inclusion = "included";
  assert.equal(planIntegration(input).candidates[1].state, "merge_ready");
});

test("evidence states, invalid snapshots and cross-cutting freezes are explicit", () => {
  for (const [delta, expected] of [
    [{ ci: "failed" }, "external_evidence_wait"],
    [{ ci: "missing" }, "external_evidence_wait"],
    [{ runtimeEvidence: "missing" }, "external_evidence_wait"],
    [{ discussionsResolved: false }, "draft_or_review_wait"],
    [{ review: "pending" }, "draft_or_review_wait"],
    [{ targetSha: "old" }, "stale"],
    [{ inclusion: "equivalent", git: "behind" }, "covered_or_empty"],
    [{ inclusion: "empty", git: "conflict" }, "covered_or_empty"],
  ]) {
    const input = snapshot(); Object.assign(input.mergeRequests[0], delta);
    assert.equal(planIntegration(input).candidates[0].state, expected);
  }
  for (const input of [null, {}, { ...snapshot(), error: "provider_failed" },
    { ...snapshot(), target: null }, { ...snapshot(), mergeRequests: [{}] }]) {
    const plan = planIntegration(input);
    assert.equal(plan.status, "invalid");
    assert.equal(plan.nextAction.type, "report");
    assert.deepEqual(plan.claims.allowed, []);
  }
  const large = snapshot();
  large.mergeRequests[0].changedFiles = Array.from({ length: 31 }, (_, i) => `f${i}.js`);
  large.issues = [{ id: "todo", status: "todo", domains: ["search"], plannedFiles: [], blockedBy: [] }];
  assert.equal(planIntegration(large).backpressure.freeze, true);
  assert.deepEqual(planIntegration(large).claims.allowed, []);
  const empty = snapshot(0);
  empty.issues = [{ id: "done", status: "done", domains: [], plannedFiles: [], blockedBy: [] }];
  assert.equal(planIntegration(empty).nextAction.type, "no_action");
  assert.equal(planIntegration(snapshot(0)).status, "invalid");
});

test("selects a deterministic conflict action, limits active domains and routes review follow-ups", () => {
  const input = snapshot(2);
  input.mergeRequests[0].git = "conflict";
  input.mergeRequests[1].git = "behind";
  input.issues = [
    { id: "active", status: "in_progress", domains: ["search"], plannedFiles: [], blockedBy: [] },
    { id: "search", status: "todo", domains: ["search"], plannedFiles: [], blockedBy: [] },
    { id: "blocker", status: "todo", domains: ["independent"], plannedFiles: [], blockedBy: [], reviewFinding: { parentMr: "1", blocking: true, separate: false } },
    { id: "cleanup", status: "todo", domains: ["independent"], plannedFiles: [], blockedBy: [], reviewFinding: { parentMr: "1", blocking: false } },
  ];
  const plan = planIntegration(input);
  assert.equal(plan.nextAction.candidateId, "1");
  assert.equal(plan.nextAction.proposedAction, "resolve_conflict");
  assert.equal(plan.claims.skipped.find(c => c.id === "search").reason, "active_domain_limit");
  assert.equal(plan.claims.skipped.find(c => c.id === "blocker").reason, "return_to_parent_mr");
  assert.equal(plan.claims.skipped.find(c => c.id === "cleanup").reason, "backlog_until_parent_integrated");
  input.mergeRequests.reverse();
  assert.deepEqual(planIntegration(input), plan);
});

test("malformed policy and non-string graph inputs return invalid rather than throwing", () => {
  for (const policy of [{ sharedFoundations: 42 }, { protectedBranches: {} }, { domains: { follow: 42 } }, { authority: "merge" }]) {
    const input = snapshot(); input.policy = policy;
    assert.equal(planIntegration(input).status, "invalid");
  }
  for (const delta of [{ changedFiles: [42] }, { domains: [null] }, { dependsOn: [{}] }]) {
    const input = snapshot(); Object.assign(input.mergeRequests[0], delta);
    assert.equal(planIntegration(input).status, "invalid");
  }
  assert.equal(planIntegration(undefined).status, "invalid");
});

test("candidate reasons identify exact missing evidence and WIP counts each domain separately", () => {
  const input = snapshot();
  Object.assign(input.mergeRequests[0], { ci: "failed", runtimeEvidence: "missing", discussionsResolved: false });
  const reasons = planIntegration(input).candidates[0].reasons;
  assert.ok(reasons.includes("ci_failed"));
  assert.ok(reasons.includes("runtime_evidence_missing"));
  assert.ok(reasons.includes("unresolved_discussions"));
  input.policy.maxActivePerDomain = 2;
  input.issues = [
    { id: "a", status: "in_progress", domains: ["A"], plannedFiles: [], blockedBy: [] },
    { id: "b", status: "in_progress", domains: ["B"], plannedFiles: [], blockedBy: [] },
    { id: "c", status: "todo", domains: ["A", "B"], plannedFiles: [], blockedBy: [] },
  ];
  assert.deepEqual(planIntegration(input).claims.allowed, ["c"]);
});

test("release targets cannot be authorized and covered MRs remain visible as cleanup suggestions", () => {
  for (const branch of ["main", "master", "release/1.2", "production", "prod"]) {
    const input = snapshot(); input.target.branch = branch; input.mergeRequests[0].targetBranch = branch;
    input.policy.authority = { mode: "merge", projectId: "square", targetBranch: branch, maxActions: 1, transport: "git-cas-push", allowForceWithLease: true, method: "merge" };
    assert.notEqual(planIntegration(input).nextAction.type, "merge");
  }
  const input = snapshot(); input.mergeRequests[0].inclusion = "equivalent";
  assert.equal(planIntegration(input).nextAction.proposedAction, "close_covered");
});

test("null graph entries are invalid normalized input", () => {
  for (const delta of [{ mergeRequests: [null] }, { issues: [null] }]) {
    assert.equal(planIntegration({ ...snapshot(), ...delta }).status, "invalid");
  }
});
