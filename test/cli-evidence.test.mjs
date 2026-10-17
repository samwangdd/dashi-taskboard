import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "../cli/taskctl.mjs";
import { createTaskboardServer } from "../server/index.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskctl-evidence-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  const address = await app.listen({ port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Evidence publish integration" }),
  });
  const { task } = await response.json();
  const bodyFile = path.join(directory, "body.md");
  const imageFile = path.join(directory, "evidence.png");
  await writeFile(bodyFile, "Before\n\n{{evidence}}\n\nAfter");
  await writeFile(imageFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64"));
  const args = ["comment", "publish", task.identifier, "--body-file", bodyFile, "--file", imageFile, "--thread-id", "evidence-session"];
  async function run(extra = [], fetchImplementation = fetch) {
    let stdout = "";
    let stderr = "";
    const exitCode = await main([...args, ...extra], {
      env: { CODEX_TASKBOARD_URL: baseUrl }, fetch: fetchImplementation,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });
    return { exitCode, payload: JSON.parse(stdout || stderr) };
  }
  const comments = async () => (await (await fetch(`${baseUrl}/api/tasks/${task.id}/comments`)).json()).comments;
  return { run, comments, baseUrl, imageFile, bodyFile };
}

test("publishes a real PNG, verifies downloaded bytes, and explicitly retries without duplicates", async (t) => {
  const { run, comments, baseUrl, imageFile } = await fixture(t);
  const result = await run();
  assert.equal(result.exitCode, 0);
  const receipt = result.payload;
  assert.equal(receipt.verified, true);
  assert.equal(receipt.sha256, receipt.downloadedSha256);
  const saved = (await comments())[0];
  assert.equal(saved.threadId, "evidence-session");
  assert.equal(saved.body, `Before\n\n![Evidence](${receipt.reference})\n\nAfter`);
  assert.equal(saved.attachments[0].commentId, saved.id);
  const downloaded = Buffer.from(await (await fetch(`${baseUrl}/${receipt.reference}`)).arrayBuffer());
  assert.deepEqual(downloaded, await readFile(imageFile));
  const retry = await run(["--comment", saved.id, "--if-version", String(saved.version)]);
  assert.equal(retry.exitCode, 0);
  assert.equal(retry.payload.attachmentId, receipt.attachmentId);
  assert.equal((await comments()).length, 1);
  assert.equal((await comments())[0].attachments.length, 1);
});

test("upload and reference failures return the existing comment and support explicit recovery", async (t) => {
  for (const phase of ["upload", "reference", "readback"]) {
    await t.test(phase, async (t) => {
      const { run, comments } = await fixture(t);
      const failure = await run([], async (url, init) => {
        const pathname = new URL(url).pathname;
        if ((phase === "upload" && init?.method === "POST" && pathname.endsWith("/attachments"))
          || (phase === "reference" && init?.method === "PATCH")) {
          return Response.json({ error: { code: "DEMO_FAILURE", message: "Reported publish failure" } }, { status: 503 });
        }
        if (phase === "readback" && pathname.endsWith("/content")) return new Response("corrupt content");
        return fetch(url, init);
      });
      assert.notEqual(failure.exitCode, 0);
      assert.equal(failure.payload.verified, undefined);
      const saved = (await comments())[0];
      assert.equal(failure.payload.error.details.commentId, saved.id);
      const recovered = await run(["--comment", saved.id, "--if-version", String(saved.version)]);
      assert.equal(recovered.exitCode, 0);
      const after = await comments();
      assert.equal(after.length, 1);
      assert.equal(after[0].attachments.length, 1);
    });
  }
});

test("rejects a local-path-only report and refuses stale or another session's comment", async (t) => {
  const { run, comments, bodyFile, baseUrl } = await fixture(t);
  await writeFile(bodyFile, "Screenshot: /tmp/evidence.png");
  assert.notEqual((await run()).exitCode, 0);
  assert.equal((await comments()).length, 0);
  await writeFile(bodyFile, "{{evidence}}");
  const published = await run();
  const saved = (await comments())[0];
  await writeFile(bodyFile, "No inline marker");
  const invalidRetry = await run(["--comment", saved.id, "--if-version", String(saved.version)]);
  assert.notEqual(invalidRetry.exitCode, 0);
  assert.equal(invalidRetry.payload.error.details.commentId, saved.id);
  await writeFile(bodyFile, "{{evidence}}");
  const stale = await run(["--comment", saved.id, "--if-version", "1"]);
  assert.equal(stale.payload.error.code, "VERSION_CONFLICT");
  const reassigned = await fetch(`${baseUrl}/api/comments/${saved.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: saved.body, version: saved.version, threadId: "another-session" }),
  });
  assert.equal(reassigned.status, 200);
  const { comment: foreignComment } = await reassigned.json();
  const foreign = await run(["--comment", saved.id, "--if-version", String(foreignComment.version)]);
  assert.notEqual(foreign.exitCode, 0);
  assert.equal((await comments())[0].body, `![Evidence](${published.payload.reference})`);
});
