import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../cli/taskctl.mjs";
import { createTaskboardServer } from "../server/index.mjs";
import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

const owner = { platform: "claude", sessionId: "new-owner" };
for (const mode of ["local", "cloud"]) test(`${mode}: historical sessions can be claimed, concurrent owners conflict, and handoff retains history`, async () => {
  let request, close, executeSql, storedExecution;
  if (mode === "cloud") {
    const app = await createCloudWorkerHarness();
    request = (route, method = "GET", json) => app.request(route, { actorName: "Agent", method, json });
    close = () => app.dispose();
    executeSql = sql => app.db.exec(sql);
    storedExecution = id => app.db.prepare("SELECT execution_state FROM tasks WHERE id = ?").bind(id).first();
  } else {
    const dir = await mkdtemp(path.join(os.tmpdir(), "execution-claim-"));
    const app = createTaskboardServer({ dataDirectory: dir });
    const address = await app.listen({ port: 0 });
    request = async (route, method = "GET", body) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { response, body: await response.json() };
    };
    executeSql = sql => app.database.database.exec(sql);
    close = async () => { await app.close(); await rm(dir, { recursive: true, force: true }); };
  }
  try {
    const project = await request("/api/projects", "POST", { id: "execution-test", name: "Execution", workspacePath: "/tmp/execution" });
    assert.equal(project.response.status, 201);
    const created = await request("/api/tasks", "POST", { projectId: "execution-test", title: "Historical handoff", status: "todo", priority: "none", labels: [], agentSession: { platform: "claude", sessionId: "historical" } });
    assert.equal(created.response.status, 201);
    const id = created.body.task.id;
    const route = `/api/tasks/${id}`;
    const eligibility = await request(`${route}/eligibility?projectId=execution-test`);
    assert.equal(eligibility.body.eligibility.eligible, true);
    const claim = { protocol: 1, action: "claim", policyVersion: 1, projectId: "execution-test", owner, requestId: "request-one", version: 1 };
    const attempts = await Promise.all([request(`${route}/execution`, "POST", claim), request(`${route}/execution`, "POST", { ...claim, owner: { platform: "claude", sessionId: "competitor" }, requestId: "request-two" })]);
    assert.deepEqual(attempts.map(x => x.response.status).sort(), [200, 409]);
    const current = (await request(route)).body.task;
    assert.equal(current.version, 2);
    assert.equal(current.status, "in_progress");
    assert.equal(current.agentSession.sessionId, "historical");
    const active = current.executionState.active;
    const actualClaim = active.requestId === "request-one" ? claim : { ...claim, owner: { platform: "claude", sessionId: "competitor" }, requestId: "request-two" };
    assert.equal((await request(`${route}/execution`, "POST", actualClaim)).response.status, 200);
    assert.equal((await request(`${route}/move`, "POST", { status: "todo", version: 2 })).response.status, 426);
    assert.equal((await request(route, "PATCH", { title: "Unauthorized", version: 2 })).response.status, 426);
    assert.equal((await request(`${route}/execution`, "POST", { protocol: 1, action: "release", owner: { platform: "claude", sessionId: "wrong" }, claimId: active.id, status: "todo", version: 2 })).response.status, 409);
    const released = await request(`${route}/execution`, "POST", { protocol: 1, action: "release", owner: active.owner, claimId: active.id, status: "todo", version: 2 });
    assert.equal(released.response.status, 200);
    assert.equal(released.body.task.executionState.history.length, 1);
    assert.equal((await request(`${route}/execution`, "POST", { protocol: 1, action: "resume", owner: active.owner, claimId: active.id, version: 3 })).response.status, 409);
    assert.equal((await request(`${route}/move`, "POST", { status: "in_progress", version: 3, agentSession: owner })).response.status, 426);
    async function cli(args) {
      let output = "", error = "";
      const code = await main(args, { env: { CODEX_TASKBOARD_URL: "http://fixture.test" }, stdout: { write: value => { output += value; } }, stderr: { write: value => { error += value; } }, fetch: async (url, init) => {
        const target = new URL(url);
        const result = await request(target.pathname + target.search, init.method ?? "GET", init.body ? JSON.parse(init.body) : undefined);
        return new Response(JSON.stringify(result.body), { status: result.response.status, headers: { "content-type": "application/json" } });
      } });
      assert.equal(code, 0, error);
      return JSON.parse(output);
    }
    const preview = await cli(["issue", "execution-preview", "--project", "execution-test"]);
    assert.equal(preview.readOnly, true);
    assert.equal(preview.preview[0].eligible, true);
    const claimedByCli = await cli(["issue", "claim", id, "--project", "execution-test", "--policy-version", "1", "--request-id", "cli-request", "--if-version", "3", "--agent-platform", "claude", "--session-id", "cli-owner"]);
    assert.equal(claimedByCli.task.executionState.active.owner.sessionId, "cli-owner");
    const proofFlags = ["--agent-platform", "claude", "--session-id", "cli-owner", "--claim-id", claimedByCli.task.executionState.active.id];
    const updatedByCli = await cli(["issue", "update", id, "--title", "Current owner edit", "--if-version", "4", ...proofFlags]);
    assert.equal(updatedByCli.task.title, "Current owner edit");
    await cli(["issue", "release", id, "--status", "in_review", "--if-version", "5", ...proofFlags]);
    for (const status of ["todo", "in_review", "blocked", "done", "canceled"]) {
      const item = (await request("/api/tasks", "POST", { projectId: "execution-test", title: `Release ${status}`, status: "todo", priority: "none", labels: [] })).body.task;
      const start = await request(`/api/tasks/${item.id}/execution`, "POST", { ...claim, requestId: status });
      assert.equal(start.response.status, 200);
      const claimId = start.body.task.executionState.active.id;
      const resume = await request(`/api/tasks/${item.id}/execution`, "POST", { protocol: 1, action: "resume", owner, claimId, version: 2 });
      assert.equal(resume.body.task.executionState.active.id, claimId);
      const end = await request(`/api/tasks/${item.id}/execution`, "POST", { protocol: 1, action: "release", owner, claimId, version: 3, status });
      assert.equal(end.body.task.status, status);
      assert.equal(end.body.task.executionState.active, null);
      assert.equal(end.body.task.executionState.history[0].outcome, status);
    }
    const held = (await request("/api/tasks", "POST", { projectId: "execution-test", title: "Held", status: "todo", priority: "none", labels: ["hold"] })).body.task;
    assert.equal((await request(`/api/tasks/${held.id}/eligibility?projectId=execution-test`)).body.eligibility.reason, "hold");
    const codex = { threadId: "historical-codex", codexProjectId: "execution-test", codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/execution" };
    const historical = (await request("/api/tasks", "POST", { projectId: "execution-test", title: "Historical Codex", status: "todo", priority: "none", labels: [], threadBinding: codex })).body.task;
    const codexClaim = await request(`/api/tasks/${historical.id}/execution`, "POST", { ...claim, owner: { ...codex, platform: "codex", threadId: "current-codex" }, requestId: "codex" });
    assert.equal(codexClaim.response.status, 200);
    assert.deepEqual(codexClaim.body.task.threadBinding, codex);
    if (mode === "local") assert.deepEqual(codexClaim.body.task.executionState.origins.threadBinding, codex);
    else {
      assert.doesNotMatch(JSON.stringify(codexClaim.body.task.executionState), /\/tmp\/execution/);
      assert.match(codexClaim.body.task.executionState.active.owner.workspaceKey, /^sha256:/);
      const nativeRelease = await request(`/api/tasks/${historical.id}/execution`, "POST", { protocol: 1, action: "release", owner: { ...codex, platform: "codex", threadId: "current-codex" }, claimId: codexClaim.body.task.executionState.active.id, status: "todo", version: 2 });
      assert.equal(nativeRelease.response.status, 200);
      assert.equal(nativeRelease.body.task.executionState.history.length, 1);
      assert.doesNotMatch((await storedExecution(historical.id)).execution_state, /\/tmp\/execution/);
    }
    if (mode === "cloud") {
      const pi = (await request("/api/tasks", "POST", { projectId: "execution-test", title: "Pi handoff", status: "todo", agentSession: { platform: "pi", sessionId: "/Users/fixture/old-pi-session" } })).body.task;
      const piClaim = await request(`/api/tasks/${pi.id}/execution`, "POST", { ...claim, owner: { platform: "pi", sessionId: "/Users/fixture/current-pi-session" }, requestId: "pi" });
      assert.equal(piClaim.response.status, 200);
      assert.doesNotMatch(JSON.stringify(piClaim.body.task.executionState), /\/Users\/fixture/);
      assert.match(piClaim.body.task.executionState.active.owner.sessionKey, /^sha256:/);
    }
    const failed = (await request("/api/tasks", "POST", { projectId: "execution-test", title: "Fail atomic write", status: "todo", priority: "none", labels: [] })).body.task;
    await executeSql(`CREATE TRIGGER fail_execution_activity BEFORE INSERT ON task_activities WHEN NEW.task_id = '${failed.id}' BEGIN SELECT RAISE(ABORT, 'injected execution failure'); END;`);
    assert.equal((await request(`/api/tasks/${failed.id}/execution`, "POST", { ...claim, requestId: "failed" })).response.status, 500);
    const afterFailure = (await request(`/api/tasks/${failed.id}`)).body.task;
    assert.equal(afterFailure.status, "todo");
    assert.equal(afterFailure.version, 1);
    assert.equal(afterFailure.executionState, null);
    await executeSql("DROP TRIGGER fail_execution_activity;");
    const policy = await request("/api/projects/execution-test/execution-policy", "PUT", { version: 1, policy: { dependencyUnlockStatuses: ["in_review", "done"], holdLabels: ["hold"], excludeParentSummaries: true } });
    assert.equal(policy.body.version, 2);
    assert.equal((await request(`/api/tasks/${failed.id}/execution`, "POST", { ...claim, requestId: "old-policy" })).response.status, 409);
    assert.equal((await request(`/api/tasks/${failed.id}/eligibility?projectId=execution-test`)).body.eligibility.policyVersion, 2);
    const createFixture = async (title, extra = {}) => (await request("/api/tasks", "POST", { projectId: "execution-test", title, status: "todo", priority: "none", labels: [], ...extra })).body.task;
    const legacy = await createFixture("Legacy stopped execution");
    await executeSql(`UPDATE tasks SET status = 'in_progress' WHERE id = '${legacy.id}';`);
    assert.equal((await request(`/api/tasks/${legacy.id}/eligibility?projectId=execution-test`)).body.eligibility.reason, "legacy_execution_requires_recovery");
    assert.equal((await request(`/api/tasks/${legacy.id}/execution`, "POST", { ...claim, policyVersion: 2, requestId: "legacy" })).response.status, 409);
    const dependency = await createFixture("Dependency", { status: "in_review" });
    const child = await createFixture("Consumer");
    const related = await request(`/api/tasks/${child.id}/relations/blocked_by/${dependency.id}`, "POST", { version: 1 });
    assert.equal(related.response.status, 200);
    const candidate = await request(`/api/tasks/${child.id}/eligibility?projectId=execution-test`);
    assert.equal(candidate.body.eligibility.eligible, true);
    assert.equal(candidate.body.eligibility.policyVersion, 2);
    await request(`/api/tasks/${dependency.id}/move`, "POST", { version: 1, status: "todo" });
    const changedDependency = await request(`/api/tasks/${child.id}/execution`, "POST", { ...claim, version: 2, policyVersion: 2, requestId: "changed-dependency" });
    assert.equal(changedDependency.response.status, 409);
    assert.equal(changedDependency.body.error.message, "unresolved_dependency");
    const summary = await createFixture("Parent summary");
    const leaf = await createFixture("Leaf");
    await request(`/api/tasks/${leaf.id}/relations/parent/${summary.id}`, "POST", { version: 1 });
    assert.equal((await request(`/api/tasks/${summary.id}/eligibility?projectId=execution-test`)).body.eligibility.reason, "parent_summary");
    const archivedFixture = await createFixture("Archived");
    await request(`/api/tasks/${archivedFixture.id}/archive`, "POST", { version: 1 });
    assert.equal((await request(`/api/tasks/${archivedFixture.id}/eligibility?projectId=execution-test`)).body.eligibility.reason, "archived");
    assert.equal((await request(`/api/tasks/${failed.id}/execution`, "POST", { ...claim, policyVersion: 2, owner: { platform: "codex", threadId: "partial" }, requestId: "partial-owner" })).response.status, 400);
    assert.equal((await request("/api/tasks", "POST", { projectId: "execution-test", title: "Old creation bypass", status: "in_progress" })).response.status, 426);
  } finally { await close(); }
});
