import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createLarkNotifier, formatLarkMessage } from "../server/lark-notifier.mjs";

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
  assert.match(call.args[7], /项目：Website\n/);
  assert.match(call.args[7], /todo → in_review/);
  assert.match(call.args[7], /http:\/\/127\.0\.0\.1:5173\/\?project=website&issue=WEBSITE-1$/);
});

test("the issue link follows TASKBOARD_WEB_PORT so side-by-side checkouts stay separate", async (t) => {
  const configured = process.env.TASKBOARD_WEB_PORT;
  process.env.TASKBOARD_WEB_PORT = "5174";
  t.after(() => {
    if (configured === undefined) delete process.env.TASKBOARD_WEB_PORT;
    else process.env.TASKBOARD_WEB_PORT = configured;
  });

  const { baseUrl, lark, task } = await startBoard();
  await move(baseUrl, task, "in_review");

  assert.match(lark.calls[0].args.at(-1), /http:\/\/127\.0\.0\.1:5174\/\?project=website&issue=WEBSITE-1$/);
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

test("a failed send keeps the recipient and the message out of the log", async (t) => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  t.after(() => { console.error = original; });

  // execFile builds its message as `Command failed: <file> <args…>\n<stderr>`,
  // so a raw error.message leaks the recipient, the payload and the CLI's stderr.
  const notifier = createLarkNotifier({
    userId: "ou_secret_recipient",
    boardUrl: "http://127.0.0.1:5173",
    run: (command, args) => Promise.reject(
      new Error(`Command failed: ${command} ${args.join(" ")}\nlark-cli: token a1b2c3 expired`),
    ),
  });

  notifier.onTaskStatusChange(
    {
      id: "task-1",
      identifier: "WEBSITE-7",
      title: "Fix the login redirect",
      projectId: "website",
      status: "blocked",
    },
    "in_progress",
    { name: "Website" },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(logged.length, 1);
  assert.match(logged[0], /WEBSITE-7/);
  assert.doesNotMatch(logged[0], /ou_secret_recipient/);
  assert.doesNotMatch(logged[0], /Fix the login redirect/);
  assert.doesNotMatch(logged[0], /token a1b2c3 expired/);
});

test("formatLarkMessage labels both notified statuses", () => {
  const task = {
    identifier: "WEBSITE-7",
    title: "Fix the login redirect",
    projectId: "website",
    status: "in_review",
  };

  assert.equal(
    formatLarkMessage(task, "in_progress", "http://127.0.0.1:5173", "Website"),
    "🔍 待审核 · WEBSITE-7 Fix the login redirect\n项目：Website\n状态：in_progress → in_review\n"
      + "http://127.0.0.1:5173/?project=website&issue=WEBSITE-7",
  );
  assert.equal(
    formatLarkMessage({ ...task, status: "blocked" }, "in_progress", "http://127.0.0.1:5173", "Website"),
    "⛔ 被阻塞 · WEBSITE-7 Fix the login redirect\n项目：Website\n状态：in_progress → blocked\n"
      + "http://127.0.0.1:5173/?project=website&issue=WEBSITE-7",
  );
});

test("a project named with an opaque id still reads as its name", async () => {
  const lark = recorder();
  const baseUrl = await startServer({
    larkUserId: "ou_test",
    larkCommand: "lark-cli-stub",
    larkCommandRunner: lark.run,
  });
  const projectId = "5728f508-b9fb-49d7-8cae-4ef8f40a6bc9";
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: projectId, name: "Taskboard", workspacePath: "/work/taskboard" },
  });
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId, title: "Ship the notification", status: "todo" },
  });

  await move(baseUrl, created.body.task, "blocked");

  const text = lark.calls[0].args.at(-1);
  assert.match(text, /项目：Taskboard\n/);
  assert.doesNotMatch(text, /项目：5728f508/);
  assert.match(text, new RegExp(`project=${projectId}&issue=`));
});
