import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../cli/taskctl.mjs";
import { buildTaskboardLoopPrompt } from "../shared/taskboard-automation.mjs";

async function run(args, overrides = {}) {
  let out = "", err = "";
  const code = await main(args, { env: { CODEX_TASKBOARD_URL: "http://127.0.0.1:1234" }, stdout: { write: s => out += s }, stderr: { write: s => err += s }, ...overrides });
  return { code, payload: JSON.parse(out || err) };
}

test("integration plan uses active project mapping and returns a structured invalid plan on unavailable repository", async () => {
  const calls = [];
  const result = await run(["integration", "plan", "--project", "p", "--target", "integration", "--json"], {
    fetch: async (url, init) => {
      calls.push([String(url), init.method]);
      return new Response(JSON.stringify(String(url).endsWith("/api/projects") ? { projects: [{ id: "p", workspacePath: null }] } : { tasks: [] }));
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.payload.schemaVersion, 2);
  assert.equal(result.payload.plan.status, "invalid");
  assert.ok(calls.every(([, method]) => method === "GET"));
  assert.equal(result.payload.decision.action, "report");
  assert.equal(result.payload.decision.claimIssueId, null);
});

test("delivery prompt requires the canonical plan before claiming instead of a fixed two-unit limit", () => {
  const prompt = buildTaskboardLoopPrompt({ promptKind: "delivery", taskboardProjectId: "p", projectName: "P", workspacePath: "/repo", skillPath: "/skills/manage-taskboard/SKILL.md" });
  assert.match(prompt, /integration plan/);
  assert.match(prompt, /integration execute/);
  assert.match(prompt, /decision.claimIssueId/);
  assert.doesNotMatch(prompt, /maximum is two|fewer than two/);
  assert.match(prompt, /target sync.*focused checks/i);
});

test("a busy integration domain never starves an explicitly allowed independent claim", async () => {
  const { integrationDecision } = await import("../server/integration-runtime.mjs");
  const plan = { status: "ready", claims: { allowed: ["independent"] }, nextAction: { type: "report", reason: "waiting_for_evidence_or_dependency" } };
  assert.equal(integrationDecision(plan).claimIssueId, "independent");
  plan.nextAction = { type: "report", proposedAction: "resolve_conflict", candidateId: "1" };
  assert.equal(integrationDecision(plan).claimIssueId, "independent");
  plan.claims.allowed = [];
  assert.equal(integrationDecision(plan).claimIssueId, null);
});

test("an integration head and an independent claim remain visible in the same delivery decision", async () => {
  const { integrationDecision } = await import("../server/integration-runtime.mjs");
  const plan = { status: "ready", claims: { allowed: ["independent"] }, nextAction: { type: "merge", candidateId: "1" } };
  const decision = integrationDecision(plan);
  assert.equal(decision.action, "integrate");
  assert.equal(decision.claimIssueId, "independent");
  assert.equal(decision.nextAction.candidateId, "1");
});
