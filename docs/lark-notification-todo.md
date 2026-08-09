# Lark notification TODO

Two known gaps in the Lark notification described in [the README](../README.md#lark-notifications).
Both are documented rather than fixed. Each entry states what happens today and
the shape of the replacement that would close it.

Neither gap loses a status change — a board that is reloaded always shows the
truth. Only the message about the change is affected, which is why the cheap
version shipped first.

## 1. Cloud mode sends nothing

**Today.** Notifications hang off the local SQLite database, so they only fire
for issues the local service owns. Once a cloud deployment is connected with
`taskctl cloud login` (see [Cloud collaboration](cloud-collaboration.md)), every
`/api` request is forwarded straight to the worker and the local database never
sees the write. No message is sent for a status change made in cloud mode, from
any client. The worker runs its own `updateTask`/`moveTask` against D1 and has no
notification path of its own.

**Possible replacement.** Notify from the worker, so the notification lives with
whichever store is authoritative. The worker cannot spawn `lark-cli`, so it would
call the Lark API over HTTP with its own credentials — a second delivery
implementation, plus end-to-end coverage for the proxied path.

## 2. A send is fire-and-forget

**Today.** The message is spawned *after* the status transaction has committed,
and the resulting promise is dropped; a failure only reaches the server console.
The two writes are not in one transaction, so a transient `lark-cli` failure or a
crash in the gap drops that notification for good. Nothing records that a message
was owed, so it is never made up later: replaying the API call hits a version
conflict, and re-applying the same status is not a change, so it does not notify.

**Possible replacement.** A transactional outbox. Write the rendered message into
an outbox table *inside* the same transaction as the status change, so "status
changed" and "a message is owed" commit together or not at all. A background
worker then drains rows that are due, marks them sent, and retries failures with
bounded exponential backoff; pending rows survive a restart, which is what makes
delivery recoverable.

Render the message at write time rather than storing a task id to look up later,
so a title edited afterwards cannot rewrite history in a notification about an
older transition.

That buys at-least-once, not exactly-once: a crash between a successful send and
marking the row sent resends the message. Deduplicate with `lark-cli`'s
`--idempotency-key`, keyed on the transition itself (`<task id>:<version>`, unique
because each write bumps the version by one), which the Lark side collapses for an
hour. Draining the queue on graceful shutdown covers the ordinary restart case.

A cheaper 80% version, if this ever becomes annoying in practice: keep the
in-memory send, but add `--idempotency-key` and two or three backoff retries. That
covers a flaky network without a table, a worker, or a migration; it does not
cover the process dying mid-send.
