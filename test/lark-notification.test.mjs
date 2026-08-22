import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function startBoard() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-lark-test-"));
  const calls = [];
  const app = createTaskboardServer({
    dataDirectory: directory,
    larkUserId: "ou_test",
    larkCommand: "lark-cli-stub",
    larkCommandRunner(command, args) {
      calls.push({ command, args });
      return Promise.resolve();
    },
  });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "website", name: "Website", workspacePath: "/work/website" },
  });

  return { baseUrl, calls };
}

async function createTask(baseUrl, title) {
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "website", title, status: "todo" },
  });
  assert.equal(created.response.status, 201);
  return created.body.task;
}

test("moving an issue into in_review sends a Lark notification", async () => {
  const { baseUrl, calls } = await startBoard();
  const task = await createTask(baseUrl, "Review the navigation");

  const moved = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "in_review" },
  });

  assert.equal(moved.response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "lark-cli-stub");
  assert.deepEqual(calls[0].args.slice(0, 6), [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--user-id",
    "ou_test",
  ]);
  assert.match(calls[0].args.at(-1), /WEB-1 Review the navigation/);
  assert.match(calls[0].args.at(-1), /todo → in_review/);
  assert.match(calls[0].args.at(-1), /\?project=website&issue=WEB-1$/);
});

test("patching an issue into blocked sends a Lark notification", async () => {
  const { baseUrl, calls } = await startBoard();
  const task = await createTask(baseUrl, "Resolve the blocker");

  const patched = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, status: "blocked" },
  });

  assert.equal(patched.response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(-1), /WEB-1 Resolve the blocker/);
  assert.match(calls[0].args.at(-1), /todo → blocked/);
});
