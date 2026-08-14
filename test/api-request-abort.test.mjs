import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { transformWithOxc } from "vite";

const apiUrl = new URL("../web/src/api.ts", import.meta.url);
const { code } = await transformWithOxc(await readFile(apiUrl, "utf8"), apiUrl.pathname);
const api = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

// The browser calls the API with same-origin paths; give them an origin and keep
// the real fetch so abort semantics stay authentic.
const nativeFetch = globalThis.fetch;
let origin = "";
globalThis.fetch = (input, init) => nativeFetch(`${origin}${input}`, init);
after(() => {
  globalThis.fetch = nativeFetch;
});

async function withStalledBody(payloadPrefix, run) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    // Headers and a partial body land, then the response hangs so the abort
    // arrives while the client is still reading the body.
    response.write(payloadPrefix);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

test("aborting while the comments body streams rejects instead of resolving empty", async () => {
  await withStalledBody('{"comments":[', async () => {
    const controller = new AbortController();
    const pending = api.listComments("task-1", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => error.name === "AbortError");
  });
});

test("aborting while the attachments body streams rejects instead of resolving empty", async () => {
  await withStalledBody('{"attachments":[', async () => {
    const controller = new AbortController();
    const pending = api.listAttachments("task-1", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error) => error.name === "AbortError");
  });
});
