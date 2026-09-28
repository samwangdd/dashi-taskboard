// Exercises everything that touches the outside world: the SQL, the CLI wiring, the
// heartbeat and the refusals. The fixture is built with the repository's own writer, so a
// schema or writer change turns these red — which is the ADR's stated reason this script
// ships in-repo at all.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { TaskboardDatabase } from "../server/database.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/taskboard-signals.mjs", import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

const ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex",
  avatarUrl: null,
  agentKind: "codex",
};

async function buildBoard() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-signals-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  database.createProject({ id: "p1", name: "Fixture", workspacePath: null });
  return { database, directory, filename };
}

function addIssue(database, title, status = "todo") {
  return database.createTask({
    projectId: "p1",
    title,
    description: "",
    status,
    priority: "none",
    labels: [],
    actor: ACTOR,
    assignee: ACTOR,
    threadId: null,
    threadBinding: null,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
}

function move(database, task, status) {
  return database.updateTask(task.id, task.version, { status }, null, null, ACTOR);
}

function run(directory, args = [], { expectFailure = false } = {}) {
  const options = {
    env: { ...process.env, CODEX_TASKBOARD_DATA_DIR: directory },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], options);
    assert.ok(!expectFailure, "expected a non-zero exit");
    return { stdout, status: 0 };
  } catch (error) {
    assert.ok(expectFailure, `unexpected failure: ${error.stderr || error.message}`);
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", status: error.status };
  }
}

const heartbeatOf = (directory) =>
  JSON.parse(readFileSync(path.join(directory, "taskboard-signals.heartbeat.json"), "utf8"));

test("a board built by the real writer yields signals and defects end to end", async () => {
  const board = await buildBoard();
  try {
    const reworked = addIssue(board.database, "reworked issue");
    let current = move(board.database, reworked, "in_progress");
    current = move(board.database, current, "in_review");
    move(board.database, current, "in_progress"); // rework

    const skipped = addIssue(board.database, "closed without review");
    move(board.database, skipped, "done"); // review-skipped

    const healthy = addIssue(board.database, "ordinary issue");
    move(board.database, healthy, "in_progress"); // happy

    board.database.close();

    const { stdout } = run(board.directory, ["--since", "2000-01-01"]);
    const report = JSON.parse(stdout);

    // Five status changes: three on the reworked issue, one each on the other two.
    // Creating an issue at `todo` records no transition.
    assert.equal(report.summary.transitions, 5);
    const triggers = report.signals.map((signal) => signal.trigger).sort();
    assert.deepEqual(triggers, ["review-skipped", "rework"]);
    for (const signal of report.signals) {
      assert.equal(signal.type, "board-anomaly");
      assert.match(signal.session, /^\d{4}-W\d{2}$/);
    }
  } finally {
    await rm(board.directory, { recursive: true, force: true });
  }
});

test("the SQL finds a stale blocker through the writer's own relation direction", async () => {
  const board = await buildBoard();
  try {
    const blocked = addIssue(board.database, "waiting on someone");
    const blocker = addIssue(board.database, "the blocker");
    board.database.addTaskRelation(
      blocked.id,
      blocked.version,
      "blocked_by",
      blocker.id,
      null,
      null,
      ACTOR,
    );
    move(board.database, blocker, "done");
    const refreshed = board.database.getTask(blocked.id);
    move(board.database, refreshed, "blocked");
    board.database.close();

    const report = JSON.parse(run(board.directory, ["--since", "2000-01-01"]).stdout);
    const stale = report.defects.filter((defect) => defect.kind === "stale-blocker");

    assert.equal(stale.length, 1, JSON.stringify(report.defects));
    assert.equal(stale[0].identifier, blocked.identifier);
  } finally {
    await rm(board.directory, { recursive: true, force: true });
  }
});

test("an empty window faults, still prints defects, and still records a heartbeat", async () => {
  const board = await buildBoard();
  try {
    const stuck = addIssue(board.database, "blocked long ago");
    move(board.database, stuck, "blocked");
    // Age it past the zombie threshold so a defect exists independently of the window.
    board.database.database
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * DAY_MS).toISOString(), stuck.id);
    board.database.close();

    const result = run(board.directory, ["--since", "2099-01-01"], { expectFailure: true });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no activity/i);

    const report = JSON.parse(result.stdout);
    assert.ok(
      report.defects.some((defect) => defect.kind === "zombie-blocked"),
      "a quiet window must not suppress defects that never used the window",
    );

    const heartbeat = heartbeatOf(board.directory);
    assert.match(heartbeat.error, /no activity/i);
    assert.ok(heartbeat.ranAt, "the run that faulted is the one that most needs to prove it ran");
  } finally {
    await rm(board.directory, { recursive: true, force: true });
  }
});

test("invoking the script through a symlink still runs it", async () => {
  const board = await buildBoard();
  try {
    const issue = addIssue(board.database, "one transition");
    move(board.database, issue, "in_progress");
    board.database.close();

    const link = path.join(board.directory, "linked-signals.mjs");
    symlinkSync(SCRIPT, link);

    const stdout = execFileSync(process.execPath, [link, "--since", "2000-01-01"], {
      env: { ...process.env, CODEX_TASKBOARD_DATA_DIR: board.directory },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    assert.ok(stdout.length > 0, "a symlinked entrypoint must not be a silent no-op");
    assert.ok(JSON.parse(stdout).summary.transitions >= 1);
  } finally {
    await rm(board.directory, { recursive: true, force: true });
  }
});

test("cloud mode is refused rather than served from the stale local copy", async () => {
  const board = await buildBoard();
  try {
    board.database.close();
    writeFileSync(
      path.join(board.directory, "cloud-companion.json"),
      JSON.stringify({ version: 1, remoteUrl: "https://example.invalid/board" }),
    );

    const result = run(board.directory, ["--since", "2000-01-01"], { expectFailure: true });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /cloud mode is active/);
  } finally {
    await rm(board.directory, { recursive: true, force: true });
  }
});

test("a typo'd or valueless flag is rejected instead of silently using the default window", async () => {
  const board = await buildBoard();
  try {
    board.database.close();

    const typo = run(board.directory, ["--sicne", "2000-01-01"], { expectFailure: true });
    assert.match(typo.stderr, /unknown flag --sicne/);

    const dangling = run(board.directory, ["--since"], { expectFailure: true });
    assert.match(dangling.stderr, /--since needs a value/);

    const unbacked = run(board.directory, ["--apply"], { expectFailure: true });
    assert.match(unbacked.stderr, /--apply needs/);
  } finally {
    await rm(board.directory, { recursive: true, force: true });
  }
});

test("--apply appends one JSON line per signal to the named file", async () => {
  const board = await buildBoard();
  try {
    const issue = addIssue(board.database, "closed without review");
    move(board.database, issue, "done");
    board.database.close();

    const target = path.join(board.directory, "signals.jsonl");
    writeFileSync(target, "");
    run(board.directory, ["--since", "2000-01-01", "--apply", "--signals", target]);

    const lines = readFileSync(target, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).trigger, "review-skipped");
    assert.ok(existsSync(target));
  } finally {
    await rm(board.directory, { recursive: true, force: true });
  }
});
