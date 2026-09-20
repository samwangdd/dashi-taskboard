# Board defects are reported to the board; only lessons enter the signal pipeline

ADR 0001 sends everything `scripts/taskboard-signals.mjs` extracts into the distillation
pipeline as signals. Extraction against two real weeks showed that the board yields two
different kinds of finding, and only one of them is a signal. A blocker that closed eight
days ago while its dependant sits in `blocked` is not evidence that a lesson may exist —
it is wrong board state right now, and routing it through a pipeline that thresholds on
recurrence and waits for human review means nobody ever unblocks the issue. The extractor
therefore emits two outputs: **board defects**, printed for the board, and **lesson
signals**, appended to the incumbent pipeline unchanged.

## Status

accepted (2026-09-19), amends 0001

## This is 0001's own vocabulary, not a departure from it

`CONTEXT.md` defines a **Signal** as "one piece of recorded evidence that a lesson may
exist". A stale blocker, a zombie-blocked issue, an issue closed without a comment, and an
issue whose comments moved on while its status did not are all statements about the board
as it stands. They need an edit, not a proposal. Keeping them out of the pipeline also
keeps the pipeline's recurrence thresholds meaningful: defects should be acted on the
first time they are seen, which is precisely what a recurrence threshold prevents.

## The recurrence key is the ISO week, not the issue-week pair

0001 requires board signals to be "thresholded across issue **and** week". The first
implementation read that as a composite key, `<issue>#<ISO week>`, so that the incumbent
`group_actionable(threshold=2)` — which counts distinct `session` values — would count
distinct issue-weeks.

Measured against the real distillation library, that key **fires on a single automation
tick**: two different issues reworked five seconds apart are two distinct issue-weeks and
clear a threshold of two by themselves. That is the exact false positive 0001's consequence
was written to prevent.

The key is therefore the ISO week alone. A pattern recurs when it reappears in a **second
week**; volume inside one week never makes it recur, however many issues that volume spans.
The cost is deliberate: several issues hitting the same problem in one week wait until the
following week to raise a proposal. Given that a tick touching many issues is the normal
case on this board, waiting is the correct bias.

## Extraction discards more than 0001 anticipated, and names what it keeps

0001 requires filtering happy-path transitions and batch reclaims. Two refinements came out
of measurement:

**A batch is counted in issues, not rows.** `CONTEXT.md` defines a batch reclaim as
"several **issues** moved the same way by the same actor within one minute". One issue
moved three times in thirty seconds is a loop thrashing on that issue — a real signal — and
counting rows would have discarded it.

**A batch is clustered on the gap between consecutive moves, not on distance from the
first.** A tick that moves N issues takes a round-trip each and routinely spans more than a
minute end to end; anchoring the window on the first move cuts the batch and leaks its tail
out as fake rework.

Anomalous transitions also carry a named reason rather than falling into one `off-path`
bucket. The incumbent fingerprints on the reason, so unnamed edges collapse into a single
coarse recurrence group that the distiller is instructed to discard — the work would be
extracted, grouped, reviewed and then thrown away. Naming the common edges
(`claim-released`, `deprioritised`, `acceptance-reversed`, `revived`) took `off-path` from
40 of 100 signals down to 11 of 114 on the same two weeks.

## Two 0001 consequences remain unmet, both outside this repository

**Comments do not yet supply the reason.** 0001 says "comments may only supply the reason,
cited by issue and timestamp". `buildLessonSignals` never receives comments, so every
signal's evidence is a templated one-line excerpt. Implementing this needs a decision about
what a cited reason looks like in the signal record.

**The pipeline's own layers were not sized for board volume.** Board excerpts share their
status tokens, so the incumbent's candidate-pairing step produces roughly ten times the
pairs per signal that conversational signals do, each costing an adjudication. Separately,
the pipeline's consumer rewrites `signals.jsonl` wholesale under an exclusive lock, so a
plain append can be erased without error. Both fixes live in the pipeline's repository.
0001 assumed the incumbent needed nothing beyond a new `type`; that assumption does not
hold, and `--apply` should stay off a schedule until it does.
