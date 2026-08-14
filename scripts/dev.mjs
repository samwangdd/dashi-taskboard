import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../shared/local-env.mjs";

// Load before spawning so both children inherit the settings, including the
// ports web/vite.config.ts reads.
loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

const children = [
  spawn(process.execPath, ["--watch", "server/index.mjs", "--dev"], {
    stdio: "inherit",
  }),
  spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:web"], {
    stdio: "inherit",
  }),
];

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
