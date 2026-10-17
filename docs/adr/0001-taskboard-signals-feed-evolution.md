# Taskboard retrospective feeds an external signal pipeline, not a report

We wanted weekly retrospectives over board history — which issues were reworked, blocked, or
pushed through without review — so that the answers could improve our working agreements. Instead
of building a retrospective feature, `scripts/taskboard-signals.mjs` reads `task_activities` and
`comments` and emits **signals** into an existing, already-scheduled distillation pipeline that
turns recurring signals into human-reviewed **proposals**. This repository owns only the extraction
step, because it is the only place where knowledge of the board schema belongs.

## Status

accepted (2026-09-12)

## Scope: harness tooling, not a product feature

`scripts/taskboard-signals.mjs` is maintainer harness tooling. It ships in the repository because
the board schema lives here and a schema change must turn this repository's tests red — not because
it is part of the Codex Taskboard product. It adds no HTTP route, no CLI verb, no UI, and no
migration. Nothing in the product depends on it.

## Considered options

**A retrospective feature in the product** (schema for derived metrics, a `/api/retro` endpoint, a
`taskctl retro` verb, a Weekly Review page). Rejected: it bets a schema migration on an unvalidated
assumption — that mining issue comments yields lessons worth acting on. The extraction step answers
that question for the cost of one script.

**A new `weekly-retro` skill.** Rejected on collision. Three existing skills already declare a
mutual-exclusion contract over the 周复盘 / weekly-review trigger space, a separate skill already
mines recent agent work for repeatable workflows on a 30-day window, and editing rule files is a
privilege the distillation pipeline explicitly reserves for its own delegates. A fourth entrant
would have to either duplicate that machinery or fight it.

**A standalone pipeline with its own distillation and report.** Rejected: the incumbent pipeline is
mature (a tested distillation library, a long proposal history, a human-review cron). Duplicating it
buys nothing and creates a second thing that can silently stop working.

## Consequences

**A separate `type` and recurrence rule are mandatory.** The incumbent pipeline thresholds
recurrence at two independent *sessions*. Board signals are naturally per-*issue*, and a single
automation tick can touch many issues in one session. Board signals therefore carry their own type
and are thresholded across issue **and** week. Feeding them in under the default type would
mis-count recurrence in both directions.

**Extraction must discard most of what it reads.** In a representative week two thirds of status
transitions were the ordinary todo → in_progress → in_review → done path, and over half of the
apparent rework was automation releasing claims in batch rather than a human redoing work. Both are
filtered during extraction, not left for a model to notice.

**Claims must be anchored to transitions, not to prose.** Comment volume on this board is written
overwhelmingly by the agents being analysed. A conclusion's assertion must come from recorded
transitions; comments may only supply the reason, cited by issue and timestamp.

**An empty result is a fault, not good news.** The pipeline this feeds had been running on an empty
queue for eleven days because its capture hooks vanished from disk, and reported success each time.
Given normal board activity, extracting zero signals is effectively impossible, so the extractor
reports zero as a fault and records a heartbeat on every run.

**This binds the extractor to local-mode storage.** It reads the device SQLite database directly,
because no bulk or date-ranged read path is exposed by the API or CLI. In cloud mode the
authoritative data lives elsewhere; the extractor must fail loudly rather than read a stale local
copy.
