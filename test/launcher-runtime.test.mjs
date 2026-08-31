import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  isLauncherRuntimeReachable,
  launcherRuntimeFile,
  readLauncherRuntime,
} from "../shared/launcher-runtime.mjs";

const directories = [];
const servers = [];

afterEach(async () => {
  delete process.env.CODEX_TASKBOARD_RUNTIME_FILE;
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
  while (directories.length > 0) {
    await rm(directories.pop(), { recursive: true, force: true });
  }
});

async function runtimeDirectory(descriptor) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-launcher-test-"));
  directories.push(directory);
  if (descriptor !== undefined) {
    await writeFile(
      path.join(directory, ".data", "launcher-runtime.json"),
      `${JSON.stringify(descriptor)}\n`,
    ).catch(async (error) => {
      if (error.code !== "ENOENT") throw error;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(directory, ".data"), { recursive: true });
      await writeFile(
        path.join(directory, ".data", "launcher-runtime.json"),
        `${JSON.stringify(descriptor)}\n`,
      );
    });
  }
  return directory;
}

// 记录 launcher 服务收到的实际路径：reachability 探测必须命中 `/health`，
// 多出的斜杠会让实例 token 模式的服务返回 404 而不是 401，从而误判为不可达。
async function startLauncherStub() {
  const requestedPaths = [];
  const server = createServer((request, response) => {
    requestedPaths.push(request.url);
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const isHealth = pathname === "/health" || /^\/[^/]+\/health$/.test(pathname);
    response.writeHead(isHealth ? 401 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: isHealth ? "INVALID_INSTANCE_CHALLENGE" : "NOT_FOUND" } }));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, requestedPaths };
}

test("the runtime descriptor path honours CODEX_TASKBOARD_RUNTIME_FILE", () => {
  process.env.CODEX_TASKBOARD_RUNTIME_FILE = "/tmp/custom/launcher-runtime.json";

  assert.equal(launcherRuntimeFile("/somewhere"), "/tmp/custom/launcher-runtime.json");
});

test("the runtime descriptor path defaults to the project .data directory", () => {
  assert.equal(
    launcherRuntimeFile("/somewhere"),
    path.join("/somewhere", ".data", "launcher-runtime.json"),
  );
});

test("a loopback launcher URL with an instance token is accepted", async () => {
  const token = "b7d23df2-e804-4132-9201-250ac8b4876b";
  const root = await runtimeDirectory({ version: 1, pid: 1, url: `http://127.0.0.1:47823/${token}/` });

  const runtime = await readLauncherRuntime(root);

  assert.equal(runtime?.token, token);
  assert.equal(runtime?.url.origin, "http://127.0.0.1:47823");
});

test("a non-loopback launcher URL is rejected", async () => {
  const root = await runtimeDirectory({
    version: 1,
    pid: 1,
    url: "http://192.168.1.10:47823/b7d23df2-e804-4132-9201-250ac8b4876b/",
  });

  assert.equal(await readLauncherRuntime(root), null);
});

test("a launcher URL without an instance token is rejected", async () => {
  const root = await runtimeDirectory({ version: 1, pid: 1, url: "http://127.0.0.1:47823/" });

  assert.equal(await readLauncherRuntime(root), null);
});

test("a missing runtime descriptor yields no runtime", async () => {
  const root = await runtimeDirectory();

  assert.equal(await readLauncherRuntime(root), null);
});

test("the reachability probe requests the launcher health route exactly once", async () => {
  const { port, requestedPaths } = await startLauncherStub();
  const token = "b7d23df2-e804-4132-9201-250ac8b4876b";
  const root = await runtimeDirectory({ version: 1, pid: 1, url: `http://127.0.0.1:${port}/${token}/` });
  const runtime = await readLauncherRuntime(root);

  const reachable = await isLauncherRuntimeReachable(runtime);

  assert.deepEqual(requestedPaths, [`/${token}/health`]);
  assert.equal(reachable, true);
});

test("an unreachable launcher runtime is reported as unreachable", async () => {
  assert.equal(await isLauncherRuntimeReachable(null), false);
});
