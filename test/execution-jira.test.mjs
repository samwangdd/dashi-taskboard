import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTaskboardServer } from "../server/index.mjs";
test("legacy active Jira execution is rejected before any external side effect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "execution-jira-"));
  const originId = createHash("sha256").update("fixture-jira").digest("hex");
  const calls = [];
  const app = createTaskboardServer({ dataDirectory: directory,
    jiraConfigStore: { read: async () => ({ version: 2, originId, baseUrl: "https://jira.fixture", username: "fixture", password: "fixture" }) },
    jiraFetch: async (url, init) => { calls.push({ url, method: init.method ?? "GET" }); return new Response(JSON.stringify(url.endsWith("manifest") ? { id: "fixture-jira" } : url.includes("transitions") ? { transitions: [{ id: "todo", to: { name: "To Do", statusCategory: { key: "new" } } }] } : { issues: [], total: 0 }), { headers: { "content-type": "application/json" } }); },
  });
  try {
    const address = await app.listen({ port: 0 });
    const request = async (route, method = "GET", body) => { const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
    const item = (await request("/api/tasks", "POST", { title: "Legacy Jira", status: "todo" })).body.task;
    const active = { id: "legacy-active", owner: { platform: "claude", sessionId: "other" }, requestId: "legacy", startedAt: "2020", progressAt: "2020" };
    app.database.database.prepare("UPDATE tasks SET external_source='jira', external_origin=?, external_key='FIX-1', status='in_progress', execution_state=? WHERE id=?").run(originId, JSON.stringify({ active, history: [] }), item.id);
    const changed = await request(`/api/tasks/${item.id}`, "PATCH", { version: 1, title: "Forbidden" });
    assert.equal(calls.length, 0);
    assert.equal(changed.status, 426);
    const moved = await request(`/api/tasks/${item.id}/move`, "POST", { version: 1, status: "todo" });
    assert.equal(calls.length, 0);
    assert.equal(moved.status, 426);
    app.database.database.prepare("UPDATE tasks SET status='todo',execution_state=NULL WHERE id=?").run(item.id);
    const eligibility = await request(`/api/tasks/${item.id}/eligibility?projectId=local`);
    assert.equal(eligibility.body.eligibility.reason, "external_execution_unsupported");
    const claimed = await request(`/api/tasks/${item.id}/execution`, "POST", { protocol: 1, action: "claim", owner: { platform: "claude", sessionId: "current" }, requestId: "new", projectId: "local", policyVersion: 1, version: 1 });
    assert.equal(claimed.status, 409);
    assert.equal(claimed.body.error.message, "external_execution_unsupported");
    assert.equal(calls.length, 0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
