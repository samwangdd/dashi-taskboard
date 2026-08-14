import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadLocalEnv } from "../shared/local-env.mjs";
import { createTaskboardServer, resolveHost, resolvePort } from "./app.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export { createTaskboardServer, resolveHost, resolvePort, resolveServerOptions } from "./app.mjs";

async function main() {
  loadLocalEnv(PROJECT_ROOT);
  const app = createTaskboardServer();
  const host = resolveHost();
  const listenFd = process.env.CODEX_TASKBOARD_LISTEN_FD === undefined
    ? null
    : Number(process.env.CODEX_TASKBOARD_LISTEN_FD);
  const address = await app.listen({ host, port: resolvePort(), fd: listenFd });
  console.log(`Claude Taskboard listening on http://127.0.0.1:${address.port}`);
  if (host === "0.0.0.0") {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const lanAddress of [...new Set(addresses)]) {
      console.log(`Claude Taskboard available on LAN at http://${lanAddress}:${address.port}`);
    }
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
