# Claude Taskboard

A local-first issue board that runs in a browser and is driven by Claude Code through the `manage-taskboard` skill. The same HTTP API powers the React UI and the `taskctl` CLI.

This is a fork of [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) adapted for Claude Code. The upstream Codex desktop embedding is preserved but not adapted; see [Embed in Codex](#embed-in-codex).

## Requirements

- Node.js 22.5 or newer

## Run locally

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:47823>. The SQLite database is stored at `.data/taskboard.sqlite`.

For development with live frontend reload:

```bash
npm run dev
```

The Vite UI runs at <http://127.0.0.1:5173> and proxies API requests to the local service.

To run several checkouts side by side, give each one its own pair of ports so the UI keeps proxying to its own backend:

```bash
TASKBOARD_WEB_PORT=5174 TASKBOARD_PORT=47901 npm run dev
```

## Lark notifications

Set `TASKBOARD_LARK_USER_ID` to your Lark `open_id` and the service sends you a
direct message whenever an issue moves into `in_review` or `blocked` — the two
statuses that need a human. This covers every path that changes a status in the
local service: the board UI, `taskctl`, the `manage-taskboard` skill, and the
Coding workflow's own automatic transitions.

The message ends with a link that opens the issue directly:

```text
🔍 待审核 · WEBSITE-7 Fix the login redirect
项目：Website
状态：in_progress → in_review
http://127.0.0.1:5173/?project=website&issue=WEBSITE-7
```

The link uses `TASKBOARD_WEB_PORT` (the same variable the Vite UI binds to, so
side-by-side checkouts each link to their own board). When you serve the built
UI with `npm start` instead of `npm run dev`, point it at the service port:
`TASKBOARD_WEB_PORT=47823`.

```bash
TASKBOARD_LARK_USER_ID=ou_xxx npm start
```

Delivery goes through `lark-cli` as a bot
(`lark-cli im +messages-send --as bot`), so the CLI must already be configured
and the app must have a direct-message relationship with you. Point
`TASKBOARD_LARK_CLI` at the executable when it is not on the service's `PATH`:

```bash
TASKBOARD_LARK_USER_ID=ou_xxx \
TASKBOARD_LARK_CLI=$HOME/.nvm/versions/node/v20.18.1/bin/lark-cli \
npm start
```

Leaving `TASKBOARD_LARK_USER_ID` unset disables notifications. A failed send is
logged to the server console and never fails the API request that triggered it.
Because the feature has no interface of its own, an unset recipient looks exactly
like the feature not being there — if nothing arrives, check this variable first.

To avoid retyping it, put machine-local settings in `.env.local` at the project
root. Both `npm run dev` and `npm start` load it at startup, and it is
git-ignored:

```bash
TASKBOARD_LARK_USER_ID=ou_xxx
TASKBOARD_LARK_CLI=/absolute/path/to/lark-cli
```

Any variable this README documents can go there, including `TASKBOARD_PORT` and
`TASKBOARD_WEB_PORT`. A variable already set in the shell wins over the file, so
`TASKBOARD_PORT=47901 npm run dev` still overrides it for one run.

See [Lark notification TODO](docs/lark-notification-todo.md) for the two known
gaps — cloud mode sends nothing, and a failed send is never retried — with what
happens today and the replacement that would close each one.

## Use the CLI

Run it from the project:

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

Use `npm link` if you want `taskctl` on your shell path. Set `TASKBOARD_URL` to point the CLI at another local or LAN service. Cloud deployments are configured through the loopback companion with `taskctl cloud login`.

## Install the Skill

The `manage-taskboard` skill is distributed through sync-spells at
`skill-category/workflow/manage-taskboard/`. Activate it through a profile
rather than copying it into `~/.claude/skills/`.

The skill teaches Claude Code to inspect an issue, move it to `in_progress`
with an optimistic version, verify the work, and move it to `in_review`; it
moves the issue to `done` only after the user explicitly confirms acceptance.

The upstream Codex version of the skill is kept unchanged at
`skills/manage-taskboard/` so that merges from upstream stay clean. It is not
the copy Claude Code uses.

## Session attribution

`taskctl` records which conversation made each issue, relation, or comment
mutation. Register the bundled SessionStart hook so Claude Code reports its
session id into context:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/dashi-taskboard/scripts/claude-session-context.mjs" }
        ]
      }
    ]
  }
}
```

Outside a hooked session, pass `--thread-id <id>` explicitly or set
`TASKBOARD_SESSION_ID`.

## Embed in Codex

> This section and the `npm run codex*` scripts are the upstream Codex desktop
> embedding. This fork does not adapt them to the Claude desktop app; they are
> left intact so they keep working against Codex.

### Recommended: keep your current window and open a separate Taskboard window

Keep the existing Codex window open. From the Taskboard repository, start a second Codex instance with a dedicated CDP port:

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

After the new Codex window appears, run the injector in another terminal:

```bash
TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

Keep the injector terminal running while using the embedded panel. The original Codex window remains unchanged, and the new window receives the Taskboard sidebar entry. If port `9231` is occupied, use another port in both commands.

### Alternative: restart Codex with the standalone launcher

Quit every running Codex window, then run:

```bash
TASKBOARD_HOST=127.0.0.1 npm run codex
```

This starts the local Taskboard service when needed, launches the official macOS Codex app with a loopback-only CDP port, injects a native-looking Taskboard entry after Plugins, and keeps watching both the service and replacement renderers. Opening Taskboard asks this launcher to health-check the fixed local service, restart it when needed, and rebuild a failed iframe. Keep this command running while using the embedded panel. The launcher does not modify `ChatGPT.app` or its `app.asar`.

Codex 26.715.52143 ships a renderer CSP that blocks arbitrary HTTP iframes. The launcher therefore enables CDP CSP bypass, reloads that renderer once, installs the document-start script, and waits until the Taskboard OOPIF is actually loaded. CDP is unauthenticated to other processes on the same machine, so only run trusted local code while the launcher is active.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Taskboard after a service exit. Stop it with `Ctrl-C`.

The script adds a Taskboard entry to the Codex sidebar and renders the iframe across Codex's complete main workspace, including the contextual titlebar area so Taskboard's own header does not leave an empty strip. That full rectangular header is placed above Electron's draggable layer and marked `no-drag`; because the native contextual actions are suppressed while Taskboard is active, its own actions use their normal edge padding without an artificial right-side gap. The native sidebar stays mounted, while the previous page selection and contextual header are temporarily suppressed; choosing another Codex page restores them.

“在对话中打开” selects the corresponding native Codex project when one is available and opens an unsent native composer with `$manage-taskboard ISSUE-ID`. A conversation is attributed only after it actually processes the issue. Upstream, `taskctl` read Codex's `CODEX_THREAD_ID` for this; **in this fork it reads `TASKBOARD_SESSION_ID` instead**, so attribution through the Codex embed requires exporting `TASKBOARD_SESSION_ID=$CODEX_THREAD_ID` in that environment. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; it does not patch React, replace `fetch`, load private chunks, or edit Codex data files.

To use a different UI origin, set `window.__CODEX_TASKBOARD_URL__` before the user script runs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TASKBOARD_HOST` | `0.0.0.0` | HTTP bind address; use `127.0.0.1` to disable LAN access |
| `TASKBOARD_PORT` | `47823` | Local HTTP port; the Vite dev proxy targets it too |
| `TASKBOARD_WEB_PORT` | `5173` | Vite dev server port |
| `TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |
| `TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API origin |

`npm start` prints both the local URL and the available LAN URLs. Teammates on the same trusted network can open one of those LAN URLs and use the same taskboard service. Task, comment, and attachment changes are broadcast to every open client through server-sent events; reconnecting clients perform a full refresh so changes made while disconnected are not missed. A teammate using `taskctl` can point it at the shared service with `TASKBOARD_URL=http://<host-ip>:47823`.

LAN mode has no account authentication: anyone on the trusted local network who can reach the URL can read and write the taskboard. Public internet and cloud deployment require an authenticated deployment boundary.

## Share through Cloudflare

For two trusted collaborators, the taskboard can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, and the server/CLI/injection test suite.
