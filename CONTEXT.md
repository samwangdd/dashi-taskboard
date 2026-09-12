# Codex Taskboard

A local-first issue board. The same HTTP API serves the React UI, the `taskctl` CLI, and the agents
that work the board unattended.

## Language

### Board

**Issue**:
The unit of work on the board, identified by a stable identifier such as `DAS-23`.
_Avoid_: Task, ticket, card

**Activity**:
An append-only record of one change to an issue, holding the field's before and after values, the
actor, and a timestamp.
_Avoid_: Event, history entry, audit log

**Claim**:
An agent's exclusive hold on an issue, established by moving it out of `todo` while binding it to a
conversation.
_Avoid_: Assign, lock, take, pick up

**Companion**:
The device-local loopback service that cloud mode depends on for Git, Skill, MCP, path mapping, and
proxying. Ordinary issue and comment routes are the Taskboard HTTP API, not the companion.
_Avoid_: 伴侣, companion API

### Retrospective signals

**Happy-path transition**:
A status change along the intended `todo → in_progress → in_review → done` sequence. Carries
throughput information but no lesson.
_Avoid_: Normal flow, successful transition

**Anomalous transition**:
Any status change that departs from the happy path — rework, blocking, skipped review, a reversed
acceptance.
_Avoid_: Exception, error, failure, regression

**Batch reclaim**:
Several issues moved the same way by the same actor within one minute, produced by an automation
loop releasing claims. It resembles rework and is not rework.
_Avoid_: Rework, revert, rollback

**Signal**:
One piece of recorded evidence that a lesson may exist. A single signal is never grounds for
changing a working agreement.
_Avoid_: Finding, insight, observation, lesson

**Proposal**:
A distilled, human-reviewable recommendation to change a skill, a rule file, or a hook, raised only
after its underlying signals recur.
_Avoid_: Suggestion, recommendation, action item
