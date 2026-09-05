import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../shared/local-env.mjs";
import { isLauncherRuntimeReachable, readLauncherRuntime } from "../shared/launcher-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(projectRoot);

// injector 托管的服务会把自己的实际地址写进 launcher runtime 描述符，端口不一定是默认值，
// 所以可达性要按描述符里的 origin 探，而不是写死 47823。
const launcherRuntime = await readLauncherRuntime(projectRoot);
const serverUrl = launcherRuntime ? `${launcherRuntime.url.origin}/` : "http://127.0.0.1:47823/";
const webUrl = "http://127.0.0.1:5173/";

async function isReachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function waitUntilReachable(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd.exe"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const opener = spawn(command, args, { detached: true, stdio: "ignore" });
  opener.unref();
}

// 两个判据都要看：token 感知探测确认 injector 托管的服务活着；裸可达性兜住
// 「描述符已失效但端口仍被别的服务占用」，避免我们再起一个撞端口的 dev server。
const serverAlreadyRunning = await isLauncherRuntimeReachable(launcherRuntime)
  || await isReachable(serverUrl);

const children = [];
if (!serverAlreadyRunning) {
  children.push(spawn(process.execPath, ["--watch", "server/index.mjs", "--dev"], {
    stdio: "inherit",
  }));
}
if (!(await isReachable(webUrl))) {
  children.push(spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:web"], {
    stdio: "inherit",
  }));
}

waitUntilReachable(webUrl)
  .then(() => openBrowser(webUrl))
  .catch((error) => {
    console.error(error.message);
    stop(1);
  });

let shuttingDown = false;

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0 && signal !== "SIGTERM") stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
