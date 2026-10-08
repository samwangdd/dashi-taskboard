import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOARD_SIGNAL_TYPE,
  buildLessonSignals,
  classifyTransition,
  findBoardDefects,
  isoWeek,
  markBatchReclaims,
  readTransitions,
} from "../scripts/taskboard-signals.mjs";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-19T04:00:00.000Z");

const at = (offsetDays) => new Date(NOW.getTime() - offsetDays * DAY).toISOString();

// ---------------------------------------------------------------- transitions

test("happy-path transitions carry throughput but no lesson", () => {
  for (const [before, after] of [
    ["backlog", "todo"],
    ["todo", "in_progress"],
    ["in_progress", "in_review"],
    ["in_review", "done"],
  ]) {
    assert.equal(classifyTransition(before, after).kind, "happy", `${before}->${after}`);
  }
});

test("rework, skipped review and reopening are anomalous and named", () => {
  assert.deepEqual(classifyTransition("in_review", "in_progress"), {
    kind: "anomalous",
    reason: "rework",
  });
  assert.deepEqual(classifyTransition("todo", "done"), {
    kind: "anomalous",
    reason: "review-skipped",
  });
  assert.deepEqual(classifyTransition("in_progress", "done"), {
    kind: "anomalous",
    reason: "review-skipped",
  });
  assert.deepEqual(classifyTransition("done", "in_progress"), {
    kind: "anomalous",
    reason: "reopened",
  });
  assert.deepEqual(classifyTransition("in_progress", "blocked"), {
    kind: "anomalous",
    reason: "blocked",
  });
});

test("deciding not to do unstarted work is a terminal outcome, not a lesson", () => {
  assert.equal(classifyTransition("backlog", "canceled").kind, "happy");
  assert.equal(classifyTransition("todo", "canceled").kind, "happy");
  assert.equal(classifyTransition("in_progress", "canceled").kind, "happy");
});

test("canceling work that was already accepted is a reversed acceptance", () => {
  assert.deepEqual(classifyTransition("done", "canceled"), {
    kind: "anomalous",
    reason: "acceptance-reversed",
  });
  assert.deepEqual(classifyTransition("in_review", "canceled"), {
    kind: "anomalous",
    reason: "acceptance-reversed",
  });
});

test("leaving blocked is recovery only when the work resumes", () => {
  assert.equal(classifyTransition("blocked", "in_progress").kind, "happy");
  assert.equal(classifyTransition("blocked", "in_review").kind, "happy");
});

test("closing straight out of blocked is the strongest review skip on the board", () => {
  assert.deepEqual(classifyTransition("blocked", "done"), {
    kind: "anomalous",
    reason: "review-skipped",
  });
});

test("releasing a claim and deprioritising are named, not lumped into off-path", () => {
  assert.deepEqual(classifyTransition("in_progress", "todo"), {
    kind: "anomalous",
    reason: "claim-released",
  });
  assert.deepEqual(classifyTransition("in_review", "todo"), {
    kind: "anomalous",
    reason: "claim-released",
  });
  assert.deepEqual(classifyTransition("in_progress", "backlog"), {
    kind: "anomalous",
    reason: "deprioritised",
  });
  assert.deepEqual(classifyTransition("todo", "backlog"), {
    kind: "anomalous",
    reason: "deprioritised",
  });
});

test("reviving a canceled issue is a reversed decision, not an unnamed edge", () => {
  assert.deepEqual(classifyTransition("canceled", "in_progress"), {
    kind: "anomalous",
    reason: "revived",
  });
});

test("claiming straight out of backlog is ordinary, not an anomaly", () => {
  assert.equal(classifyTransition("backlog", "in_progress").kind, "happy");
});

// -------------------------------------------------------------- batch reclaim

test("same actor moving several issues the same way within a minute is a batch reclaim", () => {
  const base = NOW.getTime();
  const activities = [1, 2, 3].map((n) => ({
    id: `a${n}`,
    taskId: `t${n}`,
    actorId: "codex-agent",
    before: "in_progress",
    after: "todo",
    createdAt: new Date(base + n * 5000).toISOString(),
  }));

  const reclaimed = markBatchReclaims(activities);

  assert.equal(reclaimed.size, 3);
  for (const activity of activities) assert.ok(reclaimed.has(activity.id));
});

test("two issues, or moves spread beyond the window, are not a batch reclaim", () => {
  const base = NOW.getTime();
  const pair = [1, 2].map((n) => ({
    id: `p${n}`,
    taskId: `t${n}`,
    actorId: "codex-agent",
    before: "in_progress",
    after: "todo",
    createdAt: new Date(base + n * 1000).toISOString(),
  }));
  assert.equal(markBatchReclaims(pair).size, 0, "two is below the group floor");

  const spread = [0, 1, 2].map((n) => ({
    id: `s${n}`,
    taskId: `t${n}`,
    actorId: "codex-agent",
    before: "in_progress",
    after: "todo",
    createdAt: new Date(base + n * 5 * 60 * 1000).toISOString(),
  }));
  assert.equal(markBatchReclaims(spread).size, 0, "five minutes apart is not one tick");
});

test("one actor's batch does not absorb another actor's move", () => {
  const base = NOW.getTime();
  const activities = [
    ...[1, 2, 3].map((n) => ({
      id: `c${n}`,
      taskId: `t${n}`,
      actorId: "codex-agent",
      before: "in_progress",
      after: "todo",
      createdAt: new Date(base + n * 1000).toISOString(),
    })),
    {
      id: "human",
      taskId: "t9",
      actorId: "sammore",
      before: "in_progress",
      after: "todo",
      createdAt: new Date(base + 2000).toISOString(),
    },
  ];

  const reclaimed = markBatchReclaims(activities);

  assert.equal(reclaimed.size, 3);
  assert.ok(!reclaimed.has("human"), "a human move inside the same minute is still real");
});

// -------------------------------------------------------------- board defects

const task = (overrides) => ({
  id: overrides.identifier,
  identifier: overrides.identifier,
  status: "todo",
  title: `title ${overrides.identifier}`,
  updatedAt: at(0),
  ...overrides,
});

test("a blocked issue whose every blocker is closed is a stale blocker", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    tasks: [
      task({ identifier: "MEX-235", status: "blocked", updatedAt: at(1) }),
      task({ identifier: "MEX-241", status: "done" }),
    ],
    relations: [{ taskIdentifier: "MEX-235", type: "blocked_by", relatedIdentifier: "MEX-241" }],
    comments: [],
    lastTransitions: [],
  });

  const stale = defects.filter((d) => d.kind === "stale-blocker");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].identifier, "MEX-235");
  assert.match(stale[0].detail, /MEX-241/);
});

test("a blocked issue with one open blocker is not stale", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    tasks: [
      task({ identifier: "A-1", status: "blocked", updatedAt: at(1) }),
      task({ identifier: "A-2", status: "done" }),
      task({ identifier: "A-3", status: "in_progress" }),
    ],
    relations: [
      { taskIdentifier: "A-1", type: "blocked_by", relatedIdentifier: "A-2" },
      { taskIdentifier: "A-1", type: "blocked_by", relatedIdentifier: "A-3" },
    ],
    comments: [],
    lastTransitions: [],
  });

  assert.equal(defects.filter((d) => d.kind === "stale-blocker").length, 0);
});

test("a blocked issue untouched beyond the stale window is a zombie", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    tasks: [
      task({ identifier: "OLD-1", status: "blocked", updatedAt: at(23) }),
      task({ identifier: "NEW-1", status: "blocked", updatedAt: at(2) }),
    ],
    relations: [],
    comments: [],
    lastTransitions: [],
  });

  const zombies = defects.filter((d) => d.kind === "zombie-blocked");
  assert.deepEqual(
    zombies.map((d) => d.identifier),
    ["OLD-1"],
  );
  assert.match(zombies[0].detail, /23/);
});

test("closing an issue without leaving a comment is a zero-evidence close", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    tasks: [
      task({ identifier: "Q-1", status: "done", updatedAt: at(1) }),
      task({ identifier: "Q-2", status: "done", updatedAt: at(1) }),
    ],
    relations: [],
    comments: [{ taskIdentifier: "Q-2", createdAt: at(1) }],
    lastTransitions: [],
  });

  const bare = defects.filter((d) => d.kind === "zero-evidence-close");
  assert.deepEqual(
    bare.map((d) => d.identifier),
    ["Q-1"],
  );
});

test("an issue closed long before the window is not re-reported every run", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    tasks: [task({ identifier: "ANCIENT-1", status: "done", updatedAt: at(120) })],
    relations: [],
    comments: [],
    lastTransitions: [],
  });

  assert.equal(defects.filter((d) => d.kind === "zero-evidence-close").length, 0);
});

test("comments arriving long after the last status change flag an unclosed fix", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    tasks: [task({ identifier: "SYN-11", status: "backlog", updatedAt: at(10) })],
    relations: [],
    comments: [{ taskIdentifier: "SYN-11", createdAt: at(2) }],
    lastTransitions: [{ identifier: "SYN-11", createdAt: at(10) }],
  });

  const drift = defects.filter((d) => d.kind === "comment-drift");
  assert.equal(drift.length, 1);
  assert.equal(drift[0].identifier, "SYN-11");
});

test("an issue that never moved at all is measured from its creation", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    // Created as todo on day 8 and never moved since; the board has no transition for it.
    tasks: [task({ identifier: "LOCAL-15", status: "todo", createdAt: at(8), updatedAt: at(8) })],
    relations: [],
    comments: [{ taskIdentifier: "LOCAL-15", createdAt: at(4) }],
    lastTransitions: [],
  });

  assert.deepEqual(
    defects.filter((d) => d.kind === "comment-drift").map((d) => d.identifier),
    ["LOCAL-15"],
  );
});

test("drift on an issue nobody has commented on this window is not re-reported", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    tasks: [task({ identifier: "STALE-1", status: "backlog", updatedAt: at(60) })],
    relations: [],
    // Last comment is older than the window: real drift, but not news this run.
    comments: [{ taskIdentifier: "STALE-1", createdAt: at(50) }],
    lastTransitions: [{ identifier: "STALE-1", createdAt: at(60) }],
  });

  assert.equal(defects.filter((d) => d.kind === "comment-drift").length, 0);
});

test("comment drift is found even when the last status change predates the window", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    tasks: [task({ identifier: "LOCAL-15", status: "todo", updatedAt: at(40) })],
    relations: [],
    comments: [{ taskIdentifier: "LOCAL-15", createdAt: at(4) }],
    // The only transition on this issue happened 40 days ago, far outside the window.
    lastTransitions: [{ identifier: "LOCAL-15", createdAt: at(40) }],
  });

  assert.deepEqual(
    defects.filter((d) => d.kind === "comment-drift").map((d) => d.identifier),
    ["LOCAL-15"],
  );
});

test("a done issue is never reported as comment drift", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    tasks: [task({ identifier: "D-1", status: "done", updatedAt: at(10) })],
    relations: [],
    comments: [{ taskIdentifier: "D-1", createdAt: at(1) }],
    lastTransitions: [{ identifier: "D-1", createdAt: at(10) }],
  });

  assert.equal(defects.filter((d) => d.kind === "comment-drift").length, 0);
});

// ------------------------------------------------------------ lesson signals

test("lesson signals carry the board type and a per-week recurrence key", () => {
  const [signal] = buildLessonSignals({
    transitions: [
      {
        id: "t1",
        taskId: "MEX-256",
        identifier: "MEX-256",
        title: "Feed tab flicker",
        project: "Mexc Square",
        actorId: "claude-code",
        actorAgentKind: "claude-code",
        before: "in_review",
        after: "in_progress",
        createdAt: "2026-09-15T10:00:00.000Z",
      },
    ],
  });

  assert.equal(signal.type, BOARD_SIGNAL_TYPE);
  assert.equal(signal.session, isoWeek(new Date("2026-09-15T10:00:00.000Z")));
  // Not the agent kind: the distiller picks a transcript parser off `platform`, and a
  // board signal has no transcript to parse.
  assert.equal(signal.platform, "taskboard");
  assert.equal(signal.actorKind, "claude-code");
  assert.equal(signal.transcript, null);
  assert.equal(signal.project, "Mexc Square");
  assert.equal(signal.trigger, "rework");
  assert.match(signal.excerpt, /MEX-256/);
  assert.match(signal.excerpt, /in_review/);
});

test("happy-path and batch-reclaimed transitions never become signals", () => {
  const signals = buildLessonSignals({
    transitions: [
      {
        id: "h1",
        taskId: "A",
        identifier: "A-1",
        before: "todo",
        after: "in_progress",
        createdAt: "2026-09-15T10:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(signals, []);
});

test("the same issue reworked in two different weeks yields two recurrence keys", () => {
  const signals = buildLessonSignals({
    transitions: ["2026-09-08T10:00:00.000Z", "2026-09-15T10:00:00.000Z"].map((createdAt, n) => ({
      id: `r${n}`,
      taskId: "X",
      identifier: "X-1",
      before: "in_review",
      after: "in_progress",
      createdAt,
    })),
  });

  assert.equal(signals.length, 2);
  assert.equal(new Set(signals.map((s) => s.session)).size, 2);
});

test("one automation tick touching many issues is a single piece of evidence", () => {
  // The false positive this key exists to prevent: two DIFFERENT issues moved five
  // seconds apart by one tick must not clear a recurrence threshold of two.
  const signals = buildLessonSignals({
    transitions: ["A-1", "B-2"].map((identifier, n) => ({
      id: `tick${n}`,
      taskId: identifier,
      identifier,
      before: "in_review",
      after: "in_progress",
      createdAt: new Date(Date.parse("2026-09-15T10:00:00.000Z") + n * 5000).toISOString(),
    })),
  });

  assert.equal(signals.length, 2);
  assert.equal(new Set(signals.map((s) => s.session)).size, 1);
});

test("the same issue reworked twice in one week collapses to one recurrence key", () => {
  const signals = buildLessonSignals({
    transitions: ["2026-09-15T10:00:00.000Z", "2026-09-17T10:00:00.000Z"].map((createdAt, n) => ({
      id: `w${n}`,
      taskId: "X",
      identifier: "X-1",
      before: "in_review",
      after: "in_progress",
      createdAt,
    })),
  });

  assert.equal(new Set(signals.map((s) => s.session)).size, 1);
});

test("isoWeek pins a date to its ISO year and week", () => {
  assert.equal(isoWeek(new Date("2026-09-15T10:00:00.000Z")), "2026-W38");
  assert.equal(isoWeek(new Date("2026-09-08T10:00:00.000Z")), "2026-W37");
});

// ------------------------------------------------------------ empty is a fault

test("readTransitions rejects a database that yields nothing in the window", () => {
  assert.throws(
    () =>
      readTransitions({
        rows: [],
        since: "2026-09-05",
      }),
    /no activity/i,
    "an empty extraction is a fault, not good news",
  );
});

// -------------------------------------------------- regressions from review 2026-09-19

test("a batch whose wall-clock span exceeds the window keeps its tail", () => {
  const base = Date.parse("2026-09-15T10:00:00.000Z");
  // Five issues, one round-trip each, 20s apart: 80s end to end, one genuine tick.
  const activities = [0, 20, 40, 61, 80].map((offset, n) => ({
    id: `b${n}`,
    taskId: `t${n}`,
    actorId: "codex-agent",
    before: "in_progress",
    after: "todo",
    createdAt: new Date(base + offset * 1000).toISOString(),
  }));

  assert.equal(markBatchReclaims(activities).size, 5, "the tail must not leak out as rework");
});

test("one issue flapping three times is thrash, not a batch reclaim", () => {
  const base = Date.parse("2026-09-15T10:00:00.000Z");
  const activities = [0, 10, 20].map((offset, n) => ({
    id: `f${n}`,
    taskId: "SAME",
    actorId: "codex-agent",
    before: "in_progress",
    after: "todo",
    createdAt: new Date(base + offset * 1000).toISOString(),
  }));

  assert.equal(markBatchReclaims(activities).size, 0);
});

test("batch-reclaimed transitions never become signals", () => {
  const transition = {
    id: "r1",
    taskId: "X",
    identifier: "X-1",
    before: "in_review",
    after: "in_progress",
    createdAt: "2026-09-15T10:00:00.000Z",
  };

  assert.equal(buildLessonSignals({ transitions: [transition] }).length, 1);
  assert.deepEqual(
    buildLessonSignals({ transitions: [transition], reclaimed: new Set(["r1"]) }),
    [],
  );
});

test("a blocker that has been archived counts as closed", () => {
  const defects = findBoardDefects({
    now: NOW,
    since: at(14),
    // The blocker is archived, so it is absent from `tasks` entirely.
    tasks: [task({ identifier: "DAS-90", status: "blocked", updatedAt: at(1) })],
    relations: [{ taskIdentifier: "DAS-90", type: "blocked_by", relatedIdentifier: "DAS-91" }],
    comments: [],
    lastTransitions: [],
  });

  assert.deepEqual(
    defects.filter((d) => d.kind === "stale-blocker").map((d) => d.identifier),
    ["DAS-90"],
  );
});

test("isoWeek holds at the year boundaries that justify the Thursday pinning", () => {
  assert.equal(isoWeek(new Date("2027-01-01T00:00:00.000Z")), "2026-W53");
  assert.equal(isoWeek(new Date("2024-12-30T00:00:00.000Z")), "2025-W01");
  assert.equal(isoWeek(new Date("2021-01-01T00:00:00.000Z")), "2020-W53");
  assert.equal(isoWeek(new Date("2015-12-28T00:00:00.000Z")), "2015-W53");
});
