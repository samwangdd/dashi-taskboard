import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { formatLarkMessage } from "../server/lark-notifier.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-lark-test-"));
  const app = createTaskboardServer({ dataDirectory: directory, ...options });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

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

function recorder() {
  const calls = [];
  return {
    calls,
    run(command, args) {
      calls.push({ command, args });
      return Promise.resolve();
    },
  };
}

async function startBoard(overrides = {}) {
  const lark = recorder();
  const baseUrl = await startServer({
    larkUserId: "ou_test",
    larkCommand: "lark-cli-stub",
    larkCommandRunner: lark.run,
    ...overrides,
  });
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "website", name: "Website", workspacePath: "/work/website" },
  });
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "website", title: "Build task board", status: "todo" },
  });
  assert.equal(created.response.status, 201);
  return { baseUrl, lark, task: created.body.task };
}

async function move(baseUrl, task, status) {
  const result = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status },
  });
  assert.equal(result.response.status, 200);
  return result.body.task;
}

test("moving an issue into in_review sends a Lark message through lark-cli", async () => {
  const { baseUrl, lark, task } = await startBoard();

  await move(baseUrl, task, "in_review");

  assert.equal(lark.calls.length, 1);
  const [call] = lark.calls;
  assert.equal(call.command, "lark-cli-stub");
  assert.deepEqual(call.args.slice(0, 6), [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--user-id",
    "ou_test",
  ]);
  assert.equal(call.args[6], "--text");
  assert.match(call.args[7], /WEBSITE-1/);
  assert.match(call.args[7], /Build task board/);
  assert.match(call.args[7], /todo → in_review/);
});

test("moving an issue into blocked sends a Lark message", async () => {
  const { baseUrl, lark, task } = await startBoard();

  await move(baseUrl, task, "blocked");

  assert.equal(lark.calls.length, 1);
  assert.match(lark.calls[0].args.at(-1), /todo → blocked/);
});

test("moving an issue into other statuses sends nothing", async () => {
  const { baseUrl, lark, task } = await startBoard();

  const inProgress = await move(baseUrl, task, "in_progress");
  const done = await move(baseUrl, inProgress, "done");
  await move(baseUrl, done, "backlog");

  assert.deepEqual(lark.calls, []);
});

test("patching the status into in_review sends a Lark message", async () => {
  const { baseUrl, lark, task } = await startBoard();

  const patched = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, status: "in_review" },
  });
  assert.equal(patched.response.status, 200);

  assert.equal(lark.calls.length, 1);
  assert.match(lark.calls[0].args.at(-1), /todo → in_review/);
});

test("patching other fields while already in_review sends nothing", async () => {
  const { baseUrl, lark, task } = await startBoard();
  const reviewing = await move(baseUrl, task, "in_review");
  assert.equal(lark.calls.length, 1);

  const patched = await request(baseUrl, `/api/tasks/${reviewing.id}`, {
    method: "PATCH",
    body: { version: reviewing.version, title: "Build a polished task board" },
  });
  assert.equal(patched.response.status, 200);

  assert.equal(lark.calls.length, 1);
});

test("no recipient configured disables the notification", async (t) => {
  const configured = process.env.TASKBOARD_LARK_USER_ID;
  delete process.env.TASKBOARD_LARK_USER_ID;
  t.after(() => {
    if (configured !== undefined) process.env.TASKBOARD_LARK_USER_ID = configured;
  });

  const lark = recorder();
  const { baseUrl, task } = await startBoard({
    larkUserId: undefined,
    larkCommandRunner: lark.run,
  });

  await move(baseUrl, task, "blocked");

  assert.deepEqual(lark.calls, []);
});

test("formatLarkMessage labels both notified statuses", () => {
  const task = {
    identifier: "WEBSITE-7",
    title: "Fix the login redirect",
    projectId: "website",
    status: "in_review",
  };

  assert.equal(
    formatLarkMessage(task, "in_progress"),
    "🔍 待审核 · WEBSITE-7 Fix the login redirect\n项目：website\n状态：in_progress → in_review",
  );
  assert.equal(
    formatLarkMessage({ ...task, status: "blocked" }, "in_progress"),
    "⛔ 被阻塞 · WEBSITE-7 Fix the login redirect\n项目：website\n状态：in_progress → blocked",
  );
});
