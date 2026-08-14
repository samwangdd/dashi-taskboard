import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Mirrors resolvePort in server/app.mjs: an unusable value should fail loudly
// here instead of silently becoming a proxy target like http://127.0.0.1:NaN.
function resolvePort(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    // Keep several worktrees running side by side: override both ports per instance,
    // e.g. TASKBOARD_WEB_PORT=5174 TASKBOARD_PORT=47901 npm run dev
    port: resolvePort("TASKBOARD_WEB_PORT", 5173),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${resolvePort("TASKBOARD_PORT", 47823)}`,
    },
  },
});
