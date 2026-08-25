import { readFile } from "node:fs/promises";
import path from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function launcherRuntimeFile(projectRoot) {
  return process.env.CODEX_TASKBOARD_RUNTIME_FILE
    ? path.resolve(process.env.CODEX_TASKBOARD_RUNTIME_FILE)
    : path.join(projectRoot, ".data", "launcher-runtime.json");
}

export async function readLauncherRuntime(projectRoot) {
  try {
    const descriptor = JSON.parse(await readFile(launcherRuntimeFile(projectRoot), "utf8"));
    const url = new URL(descriptor.url);
    const token = url.pathname.match(/^\/([a-z0-9-]{16,128})\/?$/i)?.[1];
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !token) return null;
    return { url, token };
  } catch {
    return null;
  }
}

export async function isLauncherRuntimeReachable(runtime) {
  if (!runtime) return false;
  try {
    const response = await fetch(new URL("health", `${runtime.url.href}/`), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.status === 401;
  } catch {
    return false;
  }
}
