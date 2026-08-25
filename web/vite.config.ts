import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readLauncherRuntime } from "../shared/launcher-runtime.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(async () => {
  const launcherRuntime = await readLauncherRuntime(projectRoot);
  const apiPrefix = launcherRuntime?.url.pathname.replace(/\/$/, "") ?? "";

  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    base: "./",
    plugins: [react()],
    build: {
      outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
      emptyOutDir: true,
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: launcherRuntime?.url.origin ?? "http://127.0.0.1:47823",
          rewrite: (requestPath) => `${apiPrefix}${requestPath}`,
        },
      },
    },
  };
});
