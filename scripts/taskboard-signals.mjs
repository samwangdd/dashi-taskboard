#!/usr/bin/env node
// Extracts retrospective signals from the local Taskboard database.
//
// Two outputs, because the board yields two different kinds of finding (ADR 0001):
//   - board defects  -> wrong board state right now; reported back to the board
//   - lesson signals -> evidence a working agreement may need changing; appended to the
//                       incumbent distillation pipeline's signals.jsonl
//
// Maintainer harness tooling. No HTTP route, no CLI verb, no UI, no migration.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const BOARD_SIGNAL_TYPE = "board-anomaly";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Same actor, same move, inside one automation tick. */
const BATCH_WINDOW_MS = 60 * 1000;
/** Two issues is a coincidence; three is a loop releasing claims. */
const BATCH_MIN_GROUP = 3;
/** A blocked issue nobody has touched for this long has stopped being blocked and started rotting. */
const ZOMBIE_BLOCKED_DAYS = 7;
/** Comments this far past the last transition mean the work moved on and the status did not. */
const COMMENT_DRIFT_DAYS = 1;

const HAPPY_EDGES = new Set([
  "backlog->todo",
  "backlog->in_progress",
  "todo->in_progress",
  "in_progress->in_review",
  "in_review->done",
]);

const CLOSED = new Set(["done", "canceled"]);

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

export function classifyTransition(before, after) {
  // Order is load-bearing throughout. Reversals of an outcome are checked before the
  // outcome itself, or `done -> canceled` reads as an ordinary cancellation.
  if (before === "done") {
    return { kind: "anomalous", reason: after === "canceled" ? "acceptance-reversed" : "reopened" };
  }
  if (before === "in_review" && after === "canceled") {
    return { kind: "anomalous", reason: "acceptance-reversed" };
  }
  if (before === "canceled") return { kind: "anomalous", reason: "revived" };
  // Abandoning work that was never accepted is a decision, not a lesson.
  if (after === "canceled") return { kind: "happy" };
  if (after === "blocked") return { kind: "anomalous", reason: "blocked" };
  // Leaving `blocked` is recovery only when the work actually resumes; `blocked -> done`
  // closes an issue that never re-entered review and must fall through to review-skipped.
  if (before === "blocked" && (after === "in_progress" || after === "in_review")) {
    return { kind: "happy" };
  }
  if (HAPPY_EDGES.has(`${before}->${after}`)) return { kind: "happy" };
  if (after === "done") return { kind: "anomalous", reason: "review-skipped" };
  if (before === "in_review" && after === "in_progress") {
    return { kind: "anomalous", reason: "rework" };
  }
  // Named because this is the highest-volume anomalous edge on the board: an agent
  // giving back a claim. Unnamed, it merges into one coarse `off-path` recurrence group.
  if (after === "todo" && (before === "in_progress" || before === "in_review")) {
    return { kind: "anomalous", reason: "claim-released" };
  }
  if (after === "backlog" && before !== "backlog") {
    return { kind: "anomalous", reason: "deprioritised" };
  }
  return { kind: "anomalous", reason: "off-path" };
}

/**
 * Returns the ids of transitions produced by an automation loop moving many issues the
 * same way at once. These look exactly like rework and are not rework, so they must be
 * removed during extraction rather than left for a model to notice.
 */
export function markBatchReclaims(
  activities,
  { windowMs = BATCH_WINDOW_MS, minGroup = BATCH_MIN_GROUP } = {},
) {
  const reclaimed = new Set();
  const groups = new Map();

  for (const activity of activities) {
    const key = `${activity.actorId}|${activity.before}->${activity.after}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(activity);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let cluster = [];
    const flush = () => {
      // "Several issues", per CONTEXT.md. One issue flapping three times in a minute is a
      // loop thrashing on that issue — a real signal — not a batch releasing claims.
      const issues = new Set(cluster.map((item) => item.taskId));
      if (issues.size >= minGroup) for (const item of cluster) reclaimed.add(item.id);
      cluster = [];
    };
    for (const activity of group) {
      const previous = cluster[cluster.length - 1];
      // Gap-chained against the previous item, not the cluster head: a tick that moves N
      // issues takes one round-trip each, so a genuine batch routinely spans past a
      // 60s head window and its tail would leak out as fake rework. Safe here because
      // the group is already keyed on (actor, edge).
      if (previous && Date.parse(activity.createdAt) - Date.parse(previous.createdAt) > windowMs) {
        flush();
      }
      cluster.push(activity);
    }
    flush();
  }

  return reclaimed;
}

export function isoWeek(date) {
  // Shift to the Thursday of this week: ISO weeks belong to the year containing their Thursday.
  const pinned = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayIndex = (pinned.getUTCDay() + 6) % 7;
  pinned.setUTCDate(pinned.getUTCDate() - dayIndex + 3);
  const firstThursday = new Date(Date.UTC(pinned.getUTCFullYear(), 0, 4));
  const firstDayIndex = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayIndex + 3);
  const week = 1 + Math.round((pinned - firstThursday) / (7 * DAY_MS));
  return `${pinned.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Board defects — wrong state now, reported back to the board
// ---------------------------------------------------------------------------

export function findBoardDefects({
  tasks,
  relations,
  comments,
  lastTransitions = [],
  since,
  now = new Date(),
}) {
  const defects = [];
  const byIdentifier = new Map(tasks.map((task) => [task.identifier, task]));
  const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;

  const blockersOf = new Map();
  for (const relation of relations) {
    if (relation.type !== "blocked_by") continue;
    if (!blockersOf.has(relation.taskIdentifier)) blockersOf.set(relation.taskIdentifier, []);
    blockersOf.get(relation.taskIdentifier).push(relation.relatedIdentifier);
  }

  const commentsOf = new Map();
  for (const comment of comments) {
    const list = commentsOf.get(comment.taskIdentifier) ?? [];
    list.push(Date.parse(comment.createdAt));
    commentsOf.set(comment.taskIdentifier, list);
  }

  // Comment drift compares against the issue's last status change of all time, not the
  // window's. An issue whose status last moved months ago is exactly the one where fresh
  // comments mean the work advanced and the board did not.
  const lastTransitionOf = new Map();
  for (const entry of lastTransitions) {
    const at = Date.parse(entry.createdAt);
    const seen = lastTransitionOf.get(entry.identifier);
    if (seen === undefined || at > seen) lastTransitionOf.set(entry.identifier, at);
  }

  for (const task of tasks) {
    const stamps = commentsOf.get(task.identifier) ?? [];

    if (task.status === "blocked") {
      const blockers = blockersOf.get(task.identifier) ?? [];
      // `tasks` excludes archived rows while `relations` does not, so an archived blocker
      // reads as `undefined` here. Archived is the most conclusively finished state of all.
      const resolved = blockers.filter((id) => {
        const status = byIdentifier.get(id)?.status;
        return status === undefined || CLOSED.has(status);
      });
      if (blockers.length > 0 && resolved.length === blockers.length) {
        defects.push({
          kind: "stale-blocker",
          identifier: task.identifier,
          title: task.title,
          detail: `every blocker is closed: ${resolved.join(", ")}`,
        });
      }

      const idleDays = Math.floor((now - Date.parse(task.updatedAt)) / DAY_MS);
      if (idleDays > ZOMBIE_BLOCKED_DAYS) {
        defects.push({
          kind: "zombie-blocked",
          identifier: task.identifier,
          title: task.title,
          detail: `blocked and untouched for ${idleDays} days`,
        });
      }
    }

    // Scoped to the window: an issue closed months ago would otherwise be re-reported on
    // every run forever, and nobody is going back to document it.
    if (task.status === "done" && stamps.length === 0 && Date.parse(task.updatedAt) >= sinceMs) {
      defects.push({
        kind: "zero-evidence-close",
        identifier: task.identifier,
        title: task.title,
        detail: "closed without a single comment",
      });
    }

    if (!CLOSED.has(task.status) && stamps.length > 0) {
      // An issue created and never moved has no transition; its status was last
      // established at creation, so that is the baseline drift is measured from.
      const lastTransition = lastTransitionOf.get(task.identifier) ?? Date.parse(task.createdAt);
      const lastComment = Math.max(...stamps);
      // Only drift someone added to this window is news; older drift is real but was
      // already reported on the run that first saw it.
      if (
        Number.isFinite(lastTransition) &&
        lastComment >= sinceMs &&
        lastComment - lastTransition > COMMENT_DRIFT_DAYS * DAY_MS
      ) {
        const driftDays = Math.floor((lastComment - lastTransition) / DAY_MS);
        defects.push({
          kind: "comment-drift",
          identifier: task.identifier,
          title: task.title,
          detail: `commented ${driftDays} days after the last status change, still ${task.status}`,
        });
      }
    }
  }

  return defects;
}

// ---------------------------------------------------------------------------
// Lesson signals — appended to the incumbent distillation pipeline
// ---------------------------------------------------------------------------

/**
 * The incumbent pipeline thresholds recurrence at two distinct `session` values, so the
 * recurrence key is the ISO week alone: a pattern recurs when it reappears in a second
 * week, never from volume inside one.
 *
 * Do not add the issue identifier back into this key. One automation tick routinely moves
 * many issues the same way, and keying on `<issue>#<week>` lets that single tick clear a
 * threshold of two by itself — measured against the real distillation library, and the
 * exact false positive ADR 0001 forbids. Do not put a real session id here either: that
 * restores session counting, which mis-counts board evidence in both directions.
 */
export function buildLessonSignals({ transitions, reclaimed = new Set() }) {
  const signals = [];

  for (const transition of transitions) {
    if (reclaimed.has(transition.id)) continue;
    const verdict = classifyTransition(transition.before, transition.after);
    if (verdict.kind !== "anomalous") continue;

    const at = new Date(transition.createdAt);
    signals.push({
      ts: at.toISOString(),
      session: isoWeek(at),
      transcript: null,
      cwd: null,
      project: transition.project ?? null,
      // Not the agent kind: the distiller picks a transcript parser off `platform`, and a
      // board signal has no transcript. A value it does not recognise makes it skip, which
      // is correct here. The agent kind rides in `actorKind` instead.
      platform: "taskboard",
      actorKind: transition.actorAgentKind ?? "unknown",
      skill: null,
      agent: "board",
      type: BOARD_SIGNAL_TYPE,
      trigger: verdict.reason,
      excerpt: `${transition.identifier} ${transition.before} -> ${transition.after}${
        transition.title ? `: ${transition.title}` : ""
      }`,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * An empty extraction is a fault. The pipeline this feeds once ran on an empty queue for
 * eleven days because its capture hooks had vanished from disk, reporting success every
 * time. Given normal board activity, zero rows means the reader is broken, not that the
 * week was clean.
 */
export function readTransitions({ rows, since }) {
  const transitions = [];

  for (const row of rows) {
    let changes;
    try {
      changes = JSON.parse(row.changes);
    } catch {
      continue;
    }
    for (const change of Array.isArray(changes) ? changes : []) {
      if (change?.field !== "status") continue;
      transitions.push({
        id: `${row.id}:${transitions.length}`,
        taskId: row.task_id,
        identifier: row.identifier,
        title: row.title,
        project: row.project_name,
        actorId: row.actor_id,
        actorAgentKind: row.actor_agent_kind,
        before: change.before,
        after: change.after,
        createdAt: row.created_at,
      });
    }
  }

  if (transitions.length === 0) {
    throw new Error(
      `no activity extracted since ${since}: the board is never this quiet, so treat this as a broken reader`,
    );
  }

  return transitions;
}

function assertLocalMode(dataDirectory) {
  const companionPath = path.join(dataDirectory, "cloud-companion.json");
  if (!existsSync(companionPath)) return;
  let companion;
  try {
    companion = JSON.parse(readFileSync(companionPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${companionPath}: ${error.message}`);
  }
  if (companion.remoteUrl) {
    throw new Error(
      `cloud mode is active (remoteUrl=${companion.remoteUrl}); the authoritative board lives there, refusing to read the stale local copy`,
    );
  }
}

function resolveDataDirectory() {
  if (process.env.CODEX_TASKBOARD_DATA_DIR) return process.env.CODEX_TASKBOARD_DATA_DIR;
  // From the script's own location, not the shell's cwd: a cron with a different working
  // directory would otherwise fall through to the packaged app's board and report on it.
  const repoLocal = path.join(fileURLToPath(new URL("..", import.meta.url)), ".data");
  if (existsSync(path.join(repoLocal, "taskboard.sqlite"))) return repoLocal;
  return path.join(
    process.env.HOME ?? "",
    "Library",
    "Application Support",
    "Codex Taskboard",
  );
}

function loadBoard(databasePath, since) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    // One read transaction across all four queries. The board app is always running by
    // design, so without it `tasks` can report an issue as blocked while the later
    // `task_activities` read already contains the activity that unblocked it — a torn
    // read that surfaces as a phantom zombie-blocked or stale-blocker defect.
    db.exec("BEGIN");
    const activityRows = db
      .prepare(
        `SELECT a.id, a.task_id, a.actor_id, a.actor_agent_kind, a.changes, a.created_at,
                t.identifier, t.title, p.name AS project_name
           FROM task_activities a
           JOIN tasks t ON t.id = a.task_id
           LEFT JOIN projects p ON p.id = t.project_id
          WHERE a.created_at >= ?
          ORDER BY a.created_at`,
      )
      .all(since);

    const tasks = db
      .prepare(`SELECT id, identifier, title, status, created_at, updated_at FROM tasks WHERE archived_at IS NULL`)
      .all()
      .map((row) => ({
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

    // `blocks` points from blocker to blocked; a task's blockers are the sources aimed at it.
    const relations = db
      .prepare(
        `SELECT src.identifier AS blocker, tgt.identifier AS blocked
           FROM task_relations r
           JOIN tasks src ON src.id = r.source_task_id
           JOIN tasks tgt ON tgt.id = r.target_task_id
          WHERE r.relation_type = 'blocks'`,
      )
      .all()
      .map((row) => ({
        taskIdentifier: row.blocked,
        type: "blocked_by",
        relatedIdentifier: row.blocker,
      }));

    const comments = db
      .prepare(
        `SELECT t.identifier AS identifier, c.created_at
           FROM comments c JOIN tasks t ON t.id = c.task_id`,
      )
      .all()
      .map((row) => ({ taskIdentifier: row.identifier, createdAt: row.created_at }));

    // Deliberately unbounded by the window — see the comment-drift note in findBoardDefects.
    const lastTransitions = db
      .prepare(
        `SELECT t.identifier AS identifier, MAX(a.created_at) AS created_at
           FROM task_activities a JOIN tasks t ON t.id = a.task_id
          WHERE EXISTS (
                  SELECT 1 FROM json_each(a.changes)
                   WHERE json_extract(value, '$.field') = 'status'
                )
          GROUP BY t.identifier`,
      )
      .all()
      .map((row) => ({ identifier: row.identifier, createdAt: row.created_at }));

    db.exec("COMMIT");
    return { activityRows, tasks, relations, comments, lastTransitions };
  } finally {
    db.close();
  }
}

/**
 * One O_APPEND write so a partial line is never observable.
 *
 * Unresolved: the pipeline's own consumer takes `flock(LOCK_EX)` and then rewrites the
 * file wholesale, so an append landing between its read and its truncate is erased with
 * no error anywhere. Closing that hole needs a matching lock or a drop-directory on the
 * consumer side — a change in the pipeline's repository, not this one.
 */
function appendSignals(target, signals) {
  if (!target) throw new Error("--apply needs --signals PATH or EVOLUTION_SIGNALS_PATH");
  if (signals.length === 0) return;
  appendFileSync(target, signals.map((signal) => `${JSON.stringify(signal)}\n`).join(""));
}

function writeHeartbeat(directory, payload) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "taskboard-signals.heartbeat.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

function parseArgs(argv) {
  const args = { since: null, apply: false, signalsPath: null };
  const takeValue = (flag, index) => {
    const value = argv[index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--since") args.since = takeValue(flag, ++index);
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--signals") args.signalsPath = takeValue(flag, ++index);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (args.apply && !(args.signalsPath ?? process.env.EVOLUTION_SIGNALS_PATH)) {
    throw new Error("--apply needs --signals PATH or EVOLUTION_SIGNALS_PATH");
  }
  return args;
}

function defaultSince() {
  return new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const since = args.since ?? defaultSince();
  const dataDirectory = resolveDataDirectory();

  assertLocalMode(dataDirectory);

  const databasePath = path.join(dataDirectory, "taskboard.sqlite");
  if (!existsSync(databasePath)) throw new Error(`no board database at ${databasePath}`);

  const { activityRows, tasks, relations, comments, lastTransitions } = loadBoard(
    databasePath,
    since,
  );
  // Defects first, and from unwindowed tables. An empty window is a fault for the signal
  // half only; it must not also suppress defect reporting that never used the window.
  const defects = findBoardDefects({ tasks, relations, comments, lastTransitions, since });

  let summary = { since, ranAt: new Date().toISOString(), boardDefects: defects.length };
  try {
    const transitions = readTransitions({ rows: activityRows, since });
    const reclaimed = markBatchReclaims(transitions);
    const signals = buildLessonSignals({ transitions, reclaimed });

    summary = {
      ...summary,
      transitions: transitions.length,
      batchReclaimed: reclaimed.size,
      lessonSignals: signals.length,
    };

    process.stdout.write(`${JSON.stringify({ summary, defects, signals }, null, 2)}\n`);
    if (args.apply) {
      appendSignals(args.signalsPath ?? process.env.EVOLUTION_SIGNALS_PATH, signals);
    }
    return { summary, defects, signals };
  } catch (error) {
    summary = { ...summary, error: error.message };
    process.stdout.write(`${JSON.stringify({ summary, defects, signals: [] }, null, 2)}\n`);
    throw error;
  } finally {
    // In the `finally`, because the run that most needs to prove it happened is the one
    // that faulted. A scheduled job with stderr discarded is otherwise indistinguishable
    // from a job that was never scheduled at all.
    writeHeartbeat(dataDirectory, summary);
  }
}

// The ESM loader realpath-resolves `import.meta.url` and `process.argv[1]` keeps whatever
// the caller typed, so both a symlinked entrypoint and a symlinked parent directory (every
// path under macOS `/tmp` and `/var`) make a naive compare fail. This script would then
// exit 0 having done nothing — the exact silent no-op it exists to detect.
const invokedPath = process.argv[1];
const invokedHref = invokedPath
  ? pathToFileURL(realpathSync(invokedPath)).href
  : null;
if (invokedHref && import.meta.url === invokedHref) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
