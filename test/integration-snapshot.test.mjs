import assert from "node:assert/strict";
import test from "node:test";
import { collectIntegrationSnapshot } from "../server/integration-snapshot.mjs";
import { planIntegration } from "../shared/integration-planner.mjs";

const mr = { iid: 1, sha: "a".repeat(40), source_branch: "feature/a", target_branch: "integration", updated_at: "2026-09-09", draft: false, blocking_discussions_resolved: true, detailed_merge_status: "mergeable", head_pipeline: { sha: "a".repeat(40), status: "success" } };
const target = "b".repeat(40);
function dependencies(overrides = {}) {
  return {
    project: { id: "p", workspacePath: "/repo" }, issues: [{ id: "i", identifier: "I-1", version: 1, status: "in_review", labels: [], relations: {}, developmentContext: { branch: "feature/a" } }],
    policy: {},
    provider: async endpoint => {
      if (endpoint.includes("repository/branches")) return { protected: false, commit: { id: target } };
      if (endpoint.includes("/changes")) return { ...mr, overflow: false, changes: [{ old_path: "a.js", new_path: "a.js" }] };
      if (endpoint.includes("/approvals")) return { approved: true };
      if (endpoint.includes("/merge_requests?")) return [mr];
      return mr;
    },
    git: async args => {
      if (args[0] === "remote") return { stdout: "git@gitlab.example.com:team/repo.git\n", code: 0 };
      if (args[0] === "cat-file") return { stdout: "", code: 0 };
      if (args[0] === "merge-base") return { stdout: "", code: 1 };
      if (args[0] === "diff") return { stdout: "diff", code: 1 };
      if (args[0] === "cherry") return { stdout: `+ ${mr.sha}\n`, code: 0 };
      if (args[0] === "merge-tree") return { stdout: "tree\n", code: 0 };
      if (args[0] === "rev-parse") return { stdout: "target-tree\n", code: 0 };
      throw new Error("Unexpected git call");
    }, ...overrides,
  };
}

test("live snapshot adapter keeps missing runtime evidence distinct from merge readiness", async () => {
  const result = await collectIntegrationSnapshot("integration", dependencies());
  assert.equal(result.target.sha, target);
  assert.deepEqual(result.repository, { host: "gitlab.example.com", projectPath: "team/repo" });
  assert.equal(result.mergeRequests[0].runtimeEvidence, "missing");
  assert.equal(result.mergeRequests[0].git, "behind");
  assert.equal(planIntegration(result).candidates[0].state, "needs_rebase");
});

test("open MR membership changing during collection invalidates the snapshot", async () => {
  const deps = dependencies(); const provider = deps.provider; let listReads = 0;
  deps.provider = async endpoint => {
    if (endpoint.includes("/merge_requests?state=opened") && ++listReads === 2) return [{ ...mr, sha: "d".repeat(40) }];
    return provider(endpoint);
  };
  assert.equal(planIntegration(await collectIntegrationSnapshot("integration", deps)).status, "invalid");
});

test("configured authority is preserved and GitLab-protected targets are denied", async () => {
  const authority = { projectId: "p", targetBranch: "integration", mode: "merge", method: "merge", maxActions: 1, transport: "git-cas-push", allowForceWithLease: true };
  const deps = dependencies({ policy: { authority, protectedBranches: ["release"] } });
  const provider = deps.provider;
  deps.provider = async endpoint => endpoint.includes("repository/branches")
    ? { commit: { id: target }, protected: true } : provider(endpoint);
  const result = await collectIntegrationSnapshot("integration", deps);
  assert.equal(result.policy.authority, authority);
  assert.deepEqual(result.policy.protectedBranches, ["release", "integration"]);
  assert.equal(planIntegration(result).nextAction.type, "report");
});

test("a squash-equivalent source is covered when its merge result keeps the target tree", async () => {
  const tree = "c".repeat(40);
  const deps = dependencies(); const git = deps.git;
  deps.git = async args => {
    if (args[0] === "merge-tree") return { stdout: `${tree}\n`, code: 0 };
    if (args[0] === "rev-parse") return { stdout: `${tree}\n`, code: 0 };
    return git(args);
  };
  const result = await collectIntegrationSnapshot("integration", deps);
  assert.equal(result.mergeRequests[0].inclusion, "equivalent");
  assert.equal(planIntegration(result).candidates[0].state, "covered_or_empty");
});

test("truncated changes reach the provider data guard", async () => {
  const deps = dependencies(); const provider = deps.provider;
  deps.provider = async endpoint => endpoint.endsWith("/changes")
    ? { ...mr, overflow: true, changes: [{ old_path: "a.js", new_path: "a.js" }] } : provider(endpoint);
  const result = await collectIntegrationSnapshot("integration", deps);
  assert.equal(result.error, "malformed_or_truncated_provider_data");
  assert.equal(planIntegration(result).status, "invalid");
});

test("provider failure, missing mapping and missing Git objects fail closed", async () => {
  for (const deps of [
    dependencies({ provider: async () => { throw new Error("provider unavailable"); } }),
    dependencies({ project: { id: "p" } }),
    dependencies({ git: async () => { throw new Error("timeout"); } }),
  ]) {
    assert.equal(planIntegration(await collectIntegrationSnapshot("integration", deps)).status, "invalid");
  }
});

test("runtime evidence must name the exact source and target and a durable evidence reference", async () => {
  const deps = dependencies({ policy: { runtimeEvidence: { "1": { sourceSha: mr.sha, targetSha: target, result: "passed", evidenceRef: "taskboard-comment:evidence-1" } } } });
  assert.equal((await collectIntegrationSnapshot("integration", deps)).mergeRequests[0].runtimeEvidence, "passed");
  deps.policy.runtimeEvidence["1"].sourceSha = "c".repeat(40);
  assert.equal((await collectIntegrationSnapshot("integration", deps)).mergeRequests[0].runtimeEvidence, "missing");
});

test("a source changed during collection invalidates the snapshot", async () => {
  const deps = dependencies(); const provider = deps.provider; let reads = 0;
  deps.provider = async endpoint => {
    if (endpoint.endsWith("merge_requests/1") && ++reads > 1) return { ...mr, sha: "d".repeat(40) };
    return provider(endpoint);
  };
  assert.equal(planIntegration(await collectIntegrationSnapshot("integration", deps)).status, "invalid");
});

test("a merged parent still in_review satisfies dependency only after target ancestry proof", async () => {
  const deps = dependencies(); const provider = deps.provider; const git = deps.git;
  deps.issues[0].relations = { blockedBy: [{ id: "parent", status: "in_review" }] };
  deps.issues.push({ id: "parent", status: "in_review", version: 1, labels: [], relations: {}, developmentContext: { branch: "feature/parent" } });
  deps.provider = async endpoint => endpoint.includes("state=merged") ? [{ merge_commit_sha: "e".repeat(40), squash_commit_sha: null, updated_at: "parent-v1" }] : provider(endpoint);
  deps.git = async args => args[0] === "merge-base" && args[2] === "e".repeat(40) ? { code: 0, stdout: "" } : git(args);
  const result = await collectIntegrationSnapshot("integration", deps);
  assert.deepEqual(result.mergeRequests[0].dependsOn, []);
  assert.equal(result.issues.find(i => i.id === "parent").integrated, true);
});
