import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { CodingWorkflowService } from "../server/coding-workflow.mjs";
import { ApiError, TaskboardDatabase } from "../server/database.mjs";
import { CODING_WORKFLOW_ID, DEFAULT_CODING_WORKFLOW_CONFIG } from "../shared/coding-workflow.mjs";

const run = promisify(execFile);
const cleanups = [];
const ACTOR = {
  type: "agent",
  id: "coding-test",
  name: "Coding Test",
  avatarUrl: null,
};

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coding-workflow-test-"));
  const repository = path.join(directory, "repo");
  await mkdir(repository);
  await run("git", ["init", "-q", "-b", "codex/test", repository]);
  await run("git", ["-C", repository, "config", "user.name", "Coding Test"]);
  await run("git", ["-C", repository, "config", "user.email", "coding@example.invalid"]);
  await writeFile(path.join(repository, "example.mjs"), "export const value = 1;\n");
  await run("git", ["-C", repository, "add", "--", "example.mjs"]);
  await run("git", ["-C", repository, "commit", "-q", "-m", "fixture"]);
  const { stdout } = await run("git", ["-C", repository, "rev-parse", "HEAD"]);

  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "coding", name: "Coding", workspacePath: repository });
  const task = database.createTask({
    projectId: "coding",
    title: "Coding fixture",
    description: "",
    status: "in_progress",
    priority: "none",
    labels: [],
    threadId: "coding-test",
    actor: ACTOR,
    assignee: ACTOR,
    workflowId: CODING_WORKFLOW_ID,
    developmentContext: { type: "worktree", path: repository, branch: "codex/test" },
    dueDate: null,
    recurrence: null,
  });
  const runRecord = database.createOrResumeCodingRun(task.id, stdout.trim());
  const implementingRun = database.saveCodingContract(runRecord.id, runRecord.version, {
    acceptance: ["fixture passes"],
  });
  const service = new CodingWorkflowService(database);
  cleanups.push(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { database, databasePath, implementingRun, repository, service, task };
}

test("run mutations require an exact run id while task lookup remains read-only", async () => {
  const { database, implementingRun, task } = await createFixture();
  assert.equal(database.getCodingRun(task.identifier), null);
  assert.equal(database.getLatestCodingRunForTask(task.identifier).id, implementingRun.id);
  assert.throws(
    () => database.saveCodingContract(task.identifier, implementingRun.version, {}),
    (error) => error instanceof ApiError && error.code === "CODING_RUN_NOT_FOUND",
  );
});

test("returning an in-review run resets its implementation budget", async () => {
  const { database, implementingRun, task } = await createFixture();
  database.database.prepare(`
    UPDATE coding_runs SET phase = 'in_review', round = 4, result = 'committed' WHERE id = ?
  `).run(implementingRun.id);
  const resumed = database.createOrResumeCodingRun(task.id, "new-start-revision");
  assert.equal(resumed.id, implementingRun.id);
  assert.equal(resumed.phase, "orchestrating");
  assert.equal(resumed.round, 1);
  assert.equal(resumed.startRevision, "new-start-revision");
  assert.deepEqual(resumed.changedFiles, []);
});

test("a persisted run keeps its frozen config snapshot", async () => {
  const { database, implementingRun } = await createFixture();
  const frozenConfig = {
    ...DEFAULT_CODING_WORKFLOW_CONFIG,
    implementerModel: "retired-model-from-when-the-run-started",
  };
  database.database.prepare("UPDATE coding_runs SET config_snapshot = ? WHERE id = ?")
    .run(JSON.stringify(frozenConfig), implementingRun.id);
  assert.deepEqual(database.getCodingRun(implementingRun.id).configSnapshot, frozenConfig);
});

test("terminal runs reject new role handoffs and unmatched completion returns null", async () => {
  const { database, implementingRun, service, task } = await createFixture();
  database.database.prepare("UPDATE coding_runs SET phase = 'blocked' WHERE id = ?").run(implementingRun.id);
  await assert.rejects(
    service.addHandoff(implementingRun.id, {
      sourceRole: "implementer",
      targetRole: "verifier",
      body: "late handoff",
    }),
    (error) => error instanceof ApiError && error.code === "INVALID_CODING_PHASE",
  );
  assert.throws(
    () => database.addCodingArtifact(implementingRun.id, {
      kind: "handoff",
      sourceRole: "implementer",
      targetRole: "verifier",
      body: "late database handoff",
    }),
    (error) => error instanceof ApiError && error.code === "INVALID_CODING_PHASE",
  );
  assert.equal(database.listCodingArtifacts(implementingRun.id).length, 0);
  assert.equal(database.completeCodingRunForTask(task.id), null);
});

test("a commit resumes after Git succeeds but the first database finalize fails", async () => {
  const { database, implementingRun, repository, service, task } = await createFixture();
  await writeFile(path.join(repository, "example.mjs"), "export const value = 2;\n");
  await service.addHandoff(implementingRun.id, {
    sourceRole: "implementer",
    targetRole: "verifier",
    body: "ready",
  });
  await service.recordVerdict(implementingRun.id, {
    result: "pass",
    ui: false,
    body: "verified",
  });

  const finalize = database.markCodingRunCommitted.bind(database);
  let failOnce = true;
  database.markCodingRunCommitted = (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("simulated database failure");
    }
    return finalize(...args);
  };

  await assert.rejects(service.commit(implementingRun.id, "feat: update fixture"), /simulated database failure/);
  assert.equal(database.getCodingRun(implementingRun.id).phase, "committing");
  assert.equal((await run("git", ["-C", repository, "status", "--short"])).stdout, "");

  const recovered = await service.commit(implementingRun.id, "feat: update fixture");
  assert.equal(recovered.run.phase, "in_review");
  assert.equal(recovered.task.status, "in_review");
  assert.equal(recovered.run.commitSha, (await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim());

  const idempotent = await service.commit(implementingRun.id, "feat: update fixture");
  assert.equal(idempotent.idempotent, true);
  assert.equal(database.listComments(task.id).length, 1);
});

test("a no-code commit remains idempotent without creating an empty Git commit", async () => {
  const { database, implementingRun, repository, service, task } = await createFixture();
  await service.addHandoff(implementingRun.id, {
    sourceRole: "implementer",
    targetRole: "verifier",
    body: "no changes required",
  });
  await service.recordVerdict(implementingRun.id, {
    result: "pass",
    ui: false,
    body: "existing code passes",
  });
  const before = (await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const result = await service.commit(implementingRun.id, "chore: no code change");
  assert.equal(result.run.result, "no_code_change");
  assert.equal(result.run.commitSha, null);
  assert.equal((await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim(), before);
  assert.equal((await service.commit(implementingRun.id, "chore: no code change")).idempotent, true);
  assert.equal(database.listComments(task.id).length, 1);
});

test("coding settings reject a stale writer across database connections", async () => {
  const { database, databasePath } = await createFixture();
  const second = new TaskboardDatabase(databasePath);
  cleanups.push(async () => second.close());
  assert.equal(second.getCodingWorkflowSettings("coding").version, 0);
  database.saveCodingWorkflowSettings("coding", 0, {
    defaultWorkflowId: CODING_WORKFLOW_ID,
    config: DEFAULT_CODING_WORKFLOW_CONFIG,
  });
  assert.throws(
    () => second.saveCodingWorkflowSettings("coding", 0, {
      defaultWorkflowId: null,
      config: DEFAULT_CODING_WORKFLOW_CONFIG,
    }),
    (error) => error instanceof ApiError && error.code === "VERSION_CONFLICT",
  );
});
