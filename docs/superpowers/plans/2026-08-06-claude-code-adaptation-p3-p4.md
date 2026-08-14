# Claude Code 适配 P3+P4 实施计划（AI Chat 后端 + 目录发现）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Taskboard 内置 AI Chat 的后端从 `codex exec --json` 换成 `claude -p --output-format stream-json`，并让项目/工作区、Skill、MCP、模型目录改从 Claude Code 的本机状态读取。

**Architecture:** 三层替换。事件层把 Claude 的 stream-json 事件流归一化成 Taskboard 既有的 `item.*` 视觉事件契约（`agent_message` / `command_execution` / `file_change` / `mcp_tool_call` / `web_search` / `todo_list` / `error`），映射依据是工具名而非事件类型。进程层把参数构造与 stdin 协议换成 Claude 的 flag 形态，会话 id 改为**调用方预生成 UUID**（`--session-id`）而非跑完回读。目录层把 `codex app-server` / `codex debug models` / `~/.codex/state.json` 换成文件系统扫描 + 静态模型表 + `~/.claude.json`。

**Tech Stack:** Node.js ≥22.5（`node:child_process`、`node:test`）、Claude Code CLI。

## 前置事实（已用真实 `claude -p` 采集验证，非推测）

采集命令（本计划的 fixture 来源）：

```bash
claude -p "Run the bash command: echo hello-fixture. Then reply with just DONE." \
  --output-format stream-json --verbose --include-partial-messages \
  --model haiku --allowedTools "Bash(echo *)" --max-turns 4 < /dev/null
```

**两个硬约束（踩过才知道）：**

1. `--output-format stream-json` 配 `--print` 时**必须同时给 `--verbose`**，否则直接报错退出：`Error: When using --print, --output-format=stream-json requires --verbose`。
2. 不重定向 stdin 会先卡 3 秒并打印 `Warning: no stdin data received in 3s`。spawn 时必须明确处理 stdin（写入 prompt 后 `end()`，或 `stdio` 的 stdin 用 `ignore`）。

**实测到的事件类型全集**（82 行样本）：

| 事件 | 出现次数 | 关键字段 |
| --- | --- | --- |
| `system/init` | 1 | `session_id`、`cwd`、`tools`、`model`、`permissionMode`、`skills`、`mcp_servers`、`slash_commands`、`agents`、`plugins`、`memory_paths` |
| `system/status` | 2 | `status` |
| `system/thinking_tokens` | 13 | `estimated_tokens`、`estimated_tokens_delta` |
| `system/hook_started` / `hook_response` | 8 / 8 | `hook_name`、`hook_event`、`stdout`、`stderr`、`exit_code`、`outcome` |
| `assistant` | 4 | `message`（Anthropic 消息格式）、`parent_tool_use_id`、`session_id` |
| `user` | 1 | `message.content[]` 内为 `tool_result` 块、`tool_use_result`（`stdout`/`stderr`/`interrupted`/`isImage`/`noOutputExpected`） |
| `stream_event/*` | 50 | 原始 Anthropic 流式事件：`message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta`、`message_stop` |
| `rate_limit_event` | 1 | `rate_limit_info` |
| `result/success` | 1 | `session_id`、`result`（最终文本）、`is_error`、`num_turns`、`stop_reason`、`usage`、`total_cost_usd`、`duration_ms`、`permission_denials` |

`assistant.message.content[]` 的块类型实测有 `thinking`、`tool_use`、`text`。`tool_use` 形如 `{type:"tool_use", id:"toolu_...", name:"Bash", input:{command,description}}`；对应的 `user` 事件里是 `{type:"tool_result", tool_use_id:"toolu_...", content:"hello-fixture", is_error:false}`。

**目录数据的可用性结论：**

- `system/init.skills` 是**纯字符串数组**（实测 60 项，仅 name），**填不满** `sanitizeSkills` 需要的 `{name, description, path, scope, interface.displayName}`。因此 Skill 目录**必须走文件系统扫描**；`init.skills` 只能用作交叉校验。
- `system/init.mcp_servers` 形如 `[{name:"context7", status:"connected"}]`，可直接替代 `discoverMcpServers`，但取它需要起一个 claude 进程。
- Claude Code **没有** `codex debug models` 的等价命令 → 模型目录只能用静态表。
- `--effort` 取值实测为 `low, medium, high, xhigh, max`（比 settings schema 里的 `effortLevel` 多一个 `max`）。
- `--permission-mode` 取值为 `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`，替代 Codex 的 `read-only / workspace-write / danger-full-access` 三档 sandbox。

## 执行状态（2026-08-06）

| Task | 状态 | 提交 |
| --- | --- | --- |
| 1 stream-json fixture | ✅ | `ec8f89e` |
| 2 事件归一化 `normalizeClaudeEvent` | ✅ | `b367008` |
| 3a `buildClaudeArgs` | ✅ | `e1d884e` |
| 3b `spawnClaudeTurn` + `server/ai-chat.mjs` 重接线 | ⬜ 未开始 | — |
| 4 Skill / MCP / 模型目录 | ⬜ | — |
| 5 工作区发现 | ⬜ | — |
| 6 前端文案 + 全量验收 | ⬜ | — |

**一处有意的计划偏离**：Task 2 原写「替换 `normalizeCodexEvent`」，实际改为**新增 `normalizeClaudeEvent` 与旧函数并存**，`normalizeCodexEvent` 及其测试留到 Task 3b 删除。理由：若在 Task 2 就删旧函数，`test/ai-chat-runner.test.mjs` 会在提交之间处于破损中间态，违背「每个 Task 结束时都是独立可验证的交付物」。同理，新测试独立成 `test/ai-chat-claude-events.test.mjs` 而非追加进 400 行的 `ai-chat-runner.test.mjs`。

Task 1→3a 每一步都实测过「失败集与 `main` 基线逐条一致（18/18）+ typecheck PASS」。

## Global Constraints

- 沿用 P1/P2 已落地的命名：env 前缀 `TASKBOARD_*`、归属 env `TASKBOARD_SESSION_ID`、显示名 `Claude Agent`。
- **Taskboard 既有的 `item.*` 视觉事件契约不变**。前端 `web/src/components/AiChat.tsx` 消费的事件形状（`kind`/`type`/`role`/`content`/`data`）保持兼容，改动集中在 server 侧的归一化层。
- SQLite 列名保持不变（含 `codex_thread_id`、`ai-chat` 相关列）；不为改名引入 schema 变更。
- 会话 id 由 Taskboard **预生成 UUID** 并通过 `--session-id` 传入；续接用 `--resume <uuid>`。不再有「跑完回读 thread id」的时序。
- `scripts/codex-injector.mjs`、`scripts/codex-injector-runtime.mjs`、`inject/codex-taskboard.user.js`、`scripts/codex-rate-limits.mjs` 仍然零改动。
- ⚠️ **上游测试套件在 `main` 上有 17 个既有失败**，其中 AI Chat 那一批（`test/ai-chat-state.test.mjs`、`test/ai-chat-ui.test.mjs`、`Codex turns use stdin, explicit resume ids, server-owned cwd and sanitized visible events`、`loopback AI API freezes server-owned origin and rejects injected execution fields`）**正是本计划要重写的范围**。验收标准：这 4 项转绿，其余 13 项与基线一致，无新增失败。取基线方法见 P1/P2 计划的 Global Constraints。
- 每个 Task 只暂存该 Task 涉及的文件；工作区仍有与本计划无关的在途改动（`package.json`、`scripts/codex-injector.mjs`、`test/injector.test.mjs`），**禁止 `git add -A`**。

## 文件结构

| 文件 | 责任 | 改动性质 |
| --- | --- | --- |
| `server/ai-chat-process.mjs` | 参数构造、事件归一化、子进程生命周期 | 重写 `buildCodexArgs` / `normalizeCodexEvent` / `spawnCodexTurn` 三个导出 |
| `server/ai-chat-catalog.mjs` | 工作区解析、Skill/MCP/模型目录 | `loadDeviceWorkspaces` 换数据源；`listSkills` 换实现；模型换静态表 |
| `server/ai-chat.mjs` | 编排（拼 prompt、落库、广播） | 改可执行文件与字段名，编排逻辑基本不动 |
| `server/app.mjs` | 装配与 `/api/ai/*` 路由、`discoverSkills`/`discoverMcpServers` | 换数据源，路由契约不变 |
| `test/fixtures/claude-stream.jsonl`（新建） | 归一化层的真实事件 fixture | 新增 |

## Task 1: 建立 stream-json 事件 fixture

**Files:**
- Create: `test/fixtures/claude-stream.jsonl`
- Test: `test/claude-stream-fixture.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: fixture 文件路径 `test/fixtures/claude-stream.jsonl`，供 Task 2 的归一化测试读取。每行一个 JSON 事件，覆盖 `system/init`、`assistant`(thinking/tool_use/text)、`user`(tool_result)、`result/success`。

> fixture 手写而非直接提交采集到的真实会话转储：真实 `init` 事件含本机 `memory_paths`、`plugins`、60 项 skills 等噪声与环境信息，不适合进仓库。以下内容保留了实测到的**精确字段形状**。

- [ ] **Step 1: 写 fixture**

Create `test/fixtures/claude-stream.jsonl`（每条一行，此处为可读性换行展示，实际写成单行）:

```json
{"type":"system","subtype":"init","cwd":"/repo","session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","tools":["Bash","Read","Edit","WebSearch","TodoWrite"],"mcp_servers":[{"name":"context7","status":"connected"}],"model":"claude-haiku-4-5-20251001","permissionMode":"default","skills":["manage-taskboard","tdd"],"slash_commands":["init"],"uuid":"u-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Need to run echo."}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","uuid":"u-2"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{"command":"echo hello-fixture","description":"Echo"}}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","uuid":"u-3"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_A","content":"hello-fixture","is_error":false}]},"tool_use_result":{"stdout":"hello-fixture","stderr":"","interrupted":false,"isImage":false},"session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","uuid":"u-4"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_B","name":"Edit","input":{"file_path":"/repo/src/a.ts","old_string":"a","new_string":"b"}}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","uuid":"u-5"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_C","name":"mcp__context7__query-docs","input":{"libraryId":"/x/y","query":"q"}}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","uuid":"u-6"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_D","name":"WebSearch","input":{"query":"claude code"}}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","uuid":"u-7"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_E","name":"TodoWrite","input":{"todos":[{"content":"step","status":"pending"}]}}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","uuid":"u-8"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"DONE"}],"stop_reason":"end_turn"},"parent_tool_use_id":null,"session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","uuid":"u-9"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","uuid":"u-10"}
{"type":"result","subtype":"success","is_error":false,"result":"DONE","num_turns":3,"stop_reason":"end_turn","session_id":"6f1c2d34-5678-4abc-9def-0123456789ab","total_cost_usd":0.0123,"usage":{"input_tokens":10,"output_tokens":5},"duration_ms":1234,"uuid":"u-11"}
```

- [ ] **Step 2: 写守卫测试（防 fixture 腐化）**

Create `test/claude-stream-fixture.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the stream-json fixture covers every event shape the runner handles", async () => {
  const raw = await readFile(new URL("./fixtures/claude-stream.jsonl", import.meta.url), "utf8");
  const events = raw.trim().split("\n").map((line) => JSON.parse(line));

  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  assert.ok(init, "fixture must contain a system/init event");
  assert.match(init.session_id, /^[0-9a-f-]{36}$/);
  assert.ok(Array.isArray(init.skills));
  assert.ok(Array.isArray(init.mcp_servers));

  const toolNames = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message.content)
    .filter((block) => block.type === "tool_use")
    .map((block) => block.name);
  for (const expected of ["Bash", "Edit", "WebSearch", "TodoWrite"]) {
    assert.ok(toolNames.includes(expected), `fixture must exercise ${expected}`);
  }
  assert.ok(toolNames.some((name) => name.startsWith("mcp__")), "fixture must exercise an MCP tool");

  const toolResult = events.find((event) => event.type === "user");
  assert.equal(toolResult.message.content[0].type, "tool_result");
  assert.equal(typeof toolResult.tool_use_result.stdout, "string");

  const result = events.at(-1);
  assert.equal(result.type, "result");
  assert.equal(result.subtype, "success");
  assert.equal(result.session_id, init.session_id);
});
```

- [ ] **Step 3: 运行测试确认通过**

Run: `node --test test/claude-stream-fixture.test.mjs`
Expected: PASS。若失败，是 fixture 写错，修 fixture 而不是改测试。

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/claude-stream.jsonl test/claude-stream-fixture.test.mjs
git commit -m "test: add a Claude stream-json fixture for the AI chat runner"
```

## Task 2: 事件归一化 `normalizeClaudeEvent`

**Files:**
- Modify: `server/ai-chat-process.mjs:256-330`（`normalizeCodexEvent`）
- Test: `test/ai-chat-runner.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 fixture
- Produces: `export function normalizeClaudeEvent(raw)` → 返回 `null`（忽略）或 `{kind:"event", type, role?, content?, data}`，`type` ∈ `agent_message` / `command_execution` / `file_change` / `mcp_tool_call` / `web_search` / `todo_list` / `error`；另返回 `{kind:"session", sessionId}` 用于 `system/init`，`{kind:"completed", result}` 用于 `result`。Task 3 的 `spawnClaudeTurn` 与 `server/ai-chat.mjs` 消费它。

**工具名 → item 类型映射表**（映射依据是工具名，不是事件类型）：

| 工具名 | item type |
| --- | --- |
| `Bash`、`BashOutput`、`KillShell` | `command_execution` |
| `Write`、`Edit`、`NotebookEdit` | `file_change` |
| `WebSearch`、`WebFetch` | `web_search` |
| `TodoWrite`、`TaskCreate`、`TaskUpdate` | `todo_list` |
| 以 `mcp__` 开头 | `mcp_tool_call` |
| 其余（`Read`、`Grep`、`Glob`、`Skill`、`Agent`…） | `command_execution`，`data.tool` 记录原始工具名 |

`thinking` 块**丢弃**（Codex 侧无对应 item 类型，前端没有渲染位）；`system/thinking_tokens`、`system/status`、`system/hook_*`、`stream_event/*`、`rate_limit_event` 一律返回 `null`。

- [ ] **Step 1: 写失败的测试**

追加到 `test/ai-chat-runner.test.mjs`：

```javascript
import { readFile } from "node:fs/promises";
import { normalizeClaudeEvent } from "../server/ai-chat-process.mjs";

async function fixtureEvents() {
  const raw = await readFile(new URL("./fixtures/claude-stream.jsonl", import.meta.url), "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

test("system/init yields the session id and nothing visible", async () => {
  const [init] = await fixtureEvents();
  assert.deepEqual(normalizeClaudeEvent(init), {
    kind: "session",
    sessionId: "6f1c2d34-5678-4abc-9def-0123456789ab",
  });
});

test("assistant text becomes an agent_message", async () => {
  const events = await fixtureEvents();
  const text = events.find((event) => event.type === "assistant"
    && event.message.content[0].type === "text");
  const normalized = normalizeClaudeEvent(text);
  assert.equal(normalized.type, "agent_message");
  assert.equal(normalized.role, "assistant");
  assert.equal(normalized.content, "DONE");
});

test("thinking blocks are dropped", async () => {
  const events = await fixtureEvents();
  const thinking = events.find((event) => event.type === "assistant"
    && event.message.content[0].type === "thinking");
  assert.equal(normalizeClaudeEvent(thinking), null);
});

test("tool_use maps to an item type by tool name", async () => {
  const events = await fixtureEvents();
  const byTool = new Map();
  for (const event of events) {
    if (event.type !== "assistant") continue;
    for (const block of event.message.content) {
      if (block.type === "tool_use") byTool.set(block.name, normalizeClaudeEvent(event));
    }
  }
  assert.equal(byTool.get("Bash").type, "command_execution");
  assert.equal(byTool.get("Bash").data.command, "echo hello-fixture");
  assert.equal(byTool.get("Edit").type, "file_change");
  assert.equal(byTool.get("WebSearch").type, "web_search");
  assert.equal(byTool.get("TodoWrite").type, "todo_list");
  assert.equal(byTool.get("mcp__context7__query-docs").type, "mcp_tool_call");
});

test("noise events are ignored", async () => {
  for (const raw of [
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 5 },
    { type: "system", subtype: "status", status: "ok" },
    { type: "system", subtype: "hook_started", hook_name: "x" },
    { type: "stream_event", event: { type: "content_block_delta" } },
    { type: "rate_limit_event", rate_limit_info: {} },
  ]) {
    assert.equal(normalizeClaudeEvent(raw), null);
  }
});

test("result carries completion and the final text", async () => {
  const events = await fixtureEvents();
  const normalized = normalizeClaudeEvent(events.at(-1));
  assert.equal(normalized.kind, "completed");
  assert.equal(normalized.result.text, "DONE");
  assert.equal(normalized.result.isError, false);
  assert.equal(normalized.result.sessionId, "6f1c2d34-5678-4abc-9def-0123456789ab");
});

test("an error result is reported as an error", () => {
  const normalized = normalizeClaudeEvent({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "boom",
    session_id: "6f1c2d34-5678-4abc-9def-0123456789ab",
  });
  assert.equal(normalized.kind, "completed");
  assert.equal(normalized.result.isError, true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/ai-chat-runner.test.mjs`
Expected: FAIL with `normalizeClaudeEvent is not a function`（该导出尚不存在）。

- [ ] **Step 3: 实现**

在 `server/ai-chat-process.mjs` 中用以下内容替换 `normalizeCodexEvent`（保留同文件的 `cappedText` / `detailText` 等既有辅助函数）：

```javascript
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);
const FILE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);
const TODO_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

function itemTypeForTool(name) {
  if (typeof name !== "string") return "command_execution";
  if (name.startsWith("mcp__")) return "mcp_tool_call";
  if (COMMAND_TOOLS.has(name)) return "command_execution";
  if (FILE_TOOLS.has(name)) return "file_change";
  if (WEB_TOOLS.has(name)) return "web_search";
  if (TODO_TOOLS.has(name)) return "todo_list";
  return "command_execution";
}

function normalizedToolUse(block) {
  const type = itemTypeForTool(block.name);
  const data = {
    status: "in_progress",
    itemId: cappedText(block.id),
    tool: cappedText(block.name),
  };
  if (type === "command_execution") data.command = cappedText(block.input?.command);
  if (type === "file_change") data.path = cappedText(block.input?.file_path);
  if (type === "web_search") data.query = cappedText(block.input?.query ?? block.input?.url);
  if (type === "todo_list") data.detail = detailText(block.input?.todos);
  if (type === "mcp_tool_call") data.detail = detailText(block.input);
  return { kind: "event", type, role: "assistant", content: "", data };
}

export function normalizeClaudeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;

  if (raw.type === "system") {
    if (raw.subtype !== "init") return null;
    const sessionId = cappedText(raw.session_id);
    return sessionId ? { kind: "session", sessionId } : null;
  }

  if (raw.type === "assistant") {
    const blocks = Array.isArray(raw.message?.content) ? raw.message.content : [];
    for (const block of blocks) {
      if (block?.type === "text") {
        return {
          kind: "event",
          type: "agent_message",
          role: "assistant",
          content: cappedText(block.text),
          data: { status: "completed" },
        };
      }
      if (block?.type === "tool_use") return normalizedToolUse(block);
    }
    return null;
  }

  if (raw.type === "user") {
    const block = Array.isArray(raw.message?.content)
      ? raw.message.content.find((entry) => entry?.type === "tool_result")
      : undefined;
    if (!block) return null;
    return {
      kind: "event",
      type: "command_execution",
      role: "assistant",
      content: "",
      data: {
        status: block.is_error ? "failed" : "completed",
        itemId: cappedText(block.tool_use_id),
        detail: detailText(block.content),
        ...(raw.tool_use_result?.stderr ? { stderr: cappedText(raw.tool_use_result.stderr) } : {}),
      },
    };
  }

  if (raw.type === "result") {
    return {
      kind: "completed",
      result: {
        text: cappedText(raw.result),
        isError: raw.is_error === true,
        sessionId: cappedText(raw.session_id),
        numTurns: Number.isSafeInteger(raw.num_turns) ? raw.num_turns : 0,
        stopReason: cappedText(raw.stop_reason),
      },
    };
  }

  return null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/ai-chat-runner.test.mjs test/claude-stream-fixture.test.mjs`
Expected: 本 Task 新增的 7 个用例 PASS。旧的 Codex 用例此时仍会失败（`normalizeCodexEvent` 已被替换），由 Task 3 一并清理 —— 这是预期的中间态。

- [ ] **Step 5: Commit**

```bash
git add server/ai-chat-process.mjs test/ai-chat-runner.test.mjs
git commit -m "feat(ai-chat): normalize Claude stream-json events into taskboard items"
```

## Task 3: 参数构造与子进程 `buildClaudeArgs` / `spawnClaudeTurn`

**Files:**
- Modify: `server/ai-chat-process.mjs:159-215`（`buildCodexArgs`）、`:216-255`（`buildCodexPrompt`）、`:331-465`（`spawnCodexTurn`）
- Modify: `server/ai-chat.mjs:8-11,50,108,259-307,423,530-544`
- Test: `test/ai-chat-runner.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `normalizeClaudeEvent`
- Produces:
  - `export function buildClaudeArgs(thread, addDirectories, imagePaths = [])` → `string[]`
  - `export function buildClaudePrompt(thread, {message, skills, attachmentPaths}, skillPath)` → `string`
  - `export function spawnClaudeTurn({executable, args, cwd, env, prompt, onEvent, maxLineBytes})` → `{child, completion}`

**参数映射**（每一项都对应实测过的 flag）：

| thread 字段 | Claude flag |
| --- | --- |
| 固定 | `-p`、`--output-format stream-json`、`--verbose`（**必需，否则报错退出**）、`--include-partial-messages` 不加（Taskboard 按 item 粒度渲染，不需要 token 级增量） |
| `thread.sessionStarted === false` | `--session-id <thread.sessionId>` |
| `thread.sessionStarted === true` | `--resume <thread.sessionId>` |
| `thread.model` | `--model <model>` |
| `thread.reasoningEffort` | `--effort <low\|medium\|high\|xhigh\|max>` |
| `thread.permissionMode` | `--permission-mode <acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan>` |

**会话 id 只有一个字段**：`thread.sessionId` 就是既有 `codex_thread_id` 列的值。该列为 `NULL` 时，编排层（`server/ai-chat.mjs`）先 `randomUUID()` 生成并写入该列、置 `sessionStarted = false`，然后 spawn 时走 `--session-id`；列非空即 `sessionStarted = true`，走 `--resume`。同一个 UUID 贯穿整个 thread，不存在「预生成 id」与「已建立 id」两个值。`sessionStarted` 是从列是否为空推导出的布尔量，不落库。
| `addDirectories` | 每项一个 `--add-dir <dir>` |
| `imagePaths` | Claude Code **无** Codex 的 `-i` 等价 flag → 图片改为在 prompt 文本中以绝对路径引用，由模型自行 `Read`。`buildClaudePrompt` 负责追加这些路径。 |

- [ ] **Step 1: 写失败的测试**

替换 `test/ai-chat-runner.test.mjs` 中原有的 Codex 参数用例：

```javascript
import { buildClaudeArgs, spawnClaudeTurn } from "../server/ai-chat-process.mjs";

test("a first turn pins the session id and always passes --verbose", () => {
  const args = buildClaudeArgs(
    { sessionId: "6f1c2d34-5678-4abc-9def-0123456789ab", sessionStarted: false, model: "opus", reasoningEffort: "high", permissionMode: "acceptEdits" },
    ["/repo/pkg"],
  );
  assert.ok(args.includes("-p"));
  assert.deepEqual(
    [args[args.indexOf("--output-format") + 1], args.includes("--verbose")],
    ["stream-json", true],
  );
  assert.equal(args[args.indexOf("--session-id") + 1], "6f1c2d34-5678-4abc-9def-0123456789ab");
  assert.ok(!args.includes("--resume"));
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(args[args.indexOf("--add-dir") + 1], "/repo/pkg");
});

test("a follow-up turn resumes the same session id instead of pinning a new one", () => {
  const args = buildClaudeArgs(
    { sessionId: "6f1c2d34-5678-4abc-9def-0123456789ab", sessionStarted: true, model: "sonnet" },
    [],
  );
  assert.equal(args[args.indexOf("--resume") + 1], "6f1c2d34-5678-4abc-9def-0123456789ab");
  assert.ok(!args.includes("--session-id"));
});

test("a turn streams normalized events and resolves on result", async () => {
  const events = [];
  const { completion } = spawnClaudeTurn({
    executable: process.execPath,
    args: ["-e", `
      const lines = [
        JSON.stringify({type:"system",subtype:"init",session_id:"6f1c2d34-5678-4abc-9def-0123456789ab"}),
        JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"hi"}]}}),
        JSON.stringify({type:"result",subtype:"success",is_error:false,result:"hi",session_id:"6f1c2d34-5678-4abc-9def-0123456789ab"}),
      ];
      process.stdin.resume();
      process.stdin.on("end", () => { for (const line of lines) process.stdout.write(line + "\\n"); process.exit(0); });
    `],
    cwd: process.cwd(),
    env: process.env,
    prompt: "hello",
    onEvent: (event) => events.push(event),
  });

  const result = await completion;
  assert.equal(result.sessionId, "6f1c2d34-5678-4abc-9def-0123456789ab");
  assert.equal(events.filter((event) => event.type === "agent_message").length, 1);
});

test("a malformed JSONL line fails the turn", async () => {
  const { completion } = spawnClaudeTurn({
    executable: process.execPath,
    args: ["-e", `process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("not json\\n");process.exit(0)})`],
    cwd: process.cwd(),
    env: process.env,
    prompt: "hello",
    onEvent: () => {},
  });
  await assert.rejects(completion, /malformed JSONL/);
});
```

第三个用例里子进程等 `stdin` 的 `end` 事件才输出 —— 这直接验证了「必须写完 prompt 并 `end()`，否则 claude 会卡 3 秒警告」这个实测约束。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/ai-chat-runner.test.mjs`
Expected: FAIL with `buildClaudeArgs is not a function`。

- [ ] **Step 3: 实现 `buildClaudeArgs`**

```javascript
export function buildClaudeArgs(thread, addDirectories, imagePaths = []) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
  ];
  for (const directory of addDirectories) args.push("--add-dir", directory);
  if (thread.model) args.push("--model", thread.model);
  if (thread.reasoningEffort) args.push("--effort", thread.reasoningEffort);
  if (thread.permissionMode) args.push("--permission-mode", thread.permissionMode);
  args.push(thread.sessionStarted ? "--resume" : "--session-id", thread.sessionId);
  return args;
}
```

`imagePaths` 不进 args —— Claude Code 无 `-i` 等价 flag，图片路径由 `buildClaudePrompt` 写进 prompt 文本。

- [ ] **Step 4: 实现 `spawnClaudeTurn`**

把 `spawnCodexTurn`（`server/ai-chat-process.mjs:331-465`）重命名为 `spawnClaudeTurn`，其 JSONL 行缓冲、行长上限、stderr 截断逻辑**逐字保留**，只做以下四处替换。

**(a) 函数签名新增 `prompt`，spawn 后立刻写入并关闭 stdin**（原实现依赖 Codex 的 `-` 参数从 stdin 读，这里必须显式 `end()`，否则触发实测到的 3 秒 stdin 警告）：

```javascript
export function spawnClaudeTurn({
  executable,
  args,
  cwd,
  env,
  prompt,
  onEvent,
  maxLineBytes = 1024 * 1024,
}) {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(prompt);
  child.stdin.end();
```

**(b) 归一化调用换成新函数，并按 `kind` 分流** —— 原实现只有「可见事件」一种出口，现在有三种：

```javascript
  let sessionId = "";
  let completion = null;

  function handleLine(line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      rejectWithDiagnostic(new Error("Claude emitted malformed JSONL"));
      return;
    }
    const normalized = normalizeClaudeEvent(raw);
    if (!normalized) return;
    if (normalized.kind === "session") {
      if (sessionId && sessionId !== normalized.sessionId) {
        rejectWithDiagnostic(new Error("Claude returned an unexpected session id"));
        return;
      }
      sessionId = normalized.sessionId;
      return;
    }
    if (normalized.kind === "completed") {
      if (sessionId && normalized.result.sessionId && sessionId !== normalized.result.sessionId) {
        rejectWithDiagnostic(new Error("Claude returned an unexpected session id"));
        return;
      }
      completion = { ...normalized.result, sessionId: sessionId || normalized.result.sessionId };
      return;
    }
    onEvent(normalized);
  }
```

`system/init` 与 `result` 都带 `session_id`，两处交叉校验；任一不一致即 reject（对应原实现的 `Codex returned an unexpected thread id` 保护）。

**(c) 行长超限的错误文案**（3 处，`:377`、`:405`、`:415`）：

```javascript
      rejectWithDiagnostic(new Error(`Claude JSONL line exceeded ${maxLineBytes} bytes`));
```

**(d) 进程退出时以 `completion` 结算**，未收到 `result` 事件即视为异常退出：

```javascript
  child.once("close", (code, signal) => {
    if (settled) return;
    if (completion) {
      resolve(completion);
      return;
    }
    rejectWithDiagnostic(new Error(
      signal
        ? `Claude exited due to signal ${signal}`
        : `Claude exited with code ${code} before reporting turn completion`,
    ));
  });
```

- [ ] **Step 5: 更新 `server/ai-chat.mjs` 的调用点**

- 导入改为 `buildClaudeArgs` / `buildClaudePrompt` / `normalizeClaudeEvent` / `spawnClaudeTurn`
- `this.codexExecutable` → `this.claudeExecutable`；`CODEX_IMAGE_TYPES` → `IMAGE_TYPES`
- 首轮前生成 UUID：`const sessionId = randomUUID()`（`node:crypto`），写入 thread 后再 spawn
- 错误文案 `Codex turn failed` / `Codex exited ...` → `Claude ...`
- 临时目录前缀 `codex-taskboard-ai-turn-` → `taskboard-ai-turn-`

- [ ] **Step 6: 运行确认通过**

Run: `node --test test/ai-chat-runner.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/ai-chat-process.mjs server/ai-chat.mjs test/ai-chat-runner.test.mjs
git commit -m "feat(ai-chat): drive turns through claude -p stream-json"
```

## Task 4: Skill / MCP / 模型目录

**Files:**
- Modify: `server/ai-chat-catalog.mjs:76`（`sanitizeModels`）、`:118-200`（`listSkills`）、`:230-256`（`discoverAiCatalog`）
- Modify: `server/app.mjs:1124-1237`（`discoverSkills`）、`:1238-1250`（`discoverMcpServers`）
- Test: `test/ai-chat-server.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export async function listClaudeSkills(workspacePath, homeDirectory)` → `[{ skills: [{name, description, path, scope}] }]`，形状刻意与 `sanitizeSkills` 现有入参一致，因此 `sanitizeSkills` **不改**
  - `export function claudeModelCatalog()` → `sanitizeModels` 可消费的静态表

**Skill 扫描规则**（三个来源，`name` 去重，先到先留）：

| 来源目录 | scope |
| --- | --- |
| `<workspacePath>/.claude/skills/*/SKILL.md` | `repo` |
| `<homeDirectory>/.claude/skills/*/SKILL.md` | `user` |
| `<homeDirectory>/.claude/plugins/cache/*/*/skills/*/SKILL.md` | `system` |

每个 `SKILL.md` 解析 YAML frontmatter 的 `name` 与 `description`；`name` 缺失时回退为目录名。**必须 `realpath` 跟随符号链接** —— 本机 `.claude/skills/*` 实测是指向 sync-spells 的 symlink，不跟随会全部漏掉。

**静态模型表**（`sanitizeModels` 需要 `slug` / `display_name` / `supported_reasoning_levels` / `visibility`）：

```javascript
export function claudeModelCatalog() {
  const efforts = ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort }));
  return [
    { slug: "fable", display_name: "Fable", visibility: "list", default_reasoning_level: "high", supported_reasoning_levels: efforts, service_tiers: [] },
    { slug: "opus", display_name: "Opus", visibility: "list", default_reasoning_level: "high", supported_reasoning_levels: efforts, service_tiers: [] },
    { slug: "sonnet", display_name: "Sonnet", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: efforts, service_tiers: [] },
    { slug: "haiku", display_name: "Haiku", visibility: "list", default_reasoning_level: "low", supported_reasoning_levels: efforts, service_tiers: [] },
  ];
}
```

`discoverAiCatalog` 的 `sandboxes` 字段值改为 `["plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]`（对应 `--permission-mode`，去掉内部别名 `manual`）。

**MCP 目录**：`server/app.mjs` 的 `discoverMcpServers` 改为读 `~/.claude.json` 的 `mcpServers` 键 + `<workspacePath>/.mcp.json`，返回既有形状。不采用 `system/init.mcp_servers` —— 那需要额外起一个 claude 进程，而目录接口会在没有任何对话时被调用。

- [ ] **Step 1: 写失败的测试**

追加到 `test/ai-chat-server.test.mjs`：

```javascript
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listClaudeSkills, claudeModelCatalog } from "../server/ai-chat-catalog.mjs";

async function skillTree() {
  const root = await mkdtemp(path.join(tmpdir(), "taskboard-skills-"));
  const repoSkill = path.join(root, "repo", ".claude", "skills", "repo-one");
  await mkdir(repoSkill, { recursive: true });
  await writeFile(path.join(repoSkill, "SKILL.md"),
    "---\nname: repo-one\ndescription: Repo scoped skill\n---\n\nbody\n");

  const external = path.join(root, "external", "linked-two");
  await mkdir(external, { recursive: true });
  await writeFile(path.join(external, "SKILL.md"),
    "---\nname: linked-two\ndescription: Reached through a symlink\n---\n\nbody\n");
  const userSkills = path.join(root, "home", ".claude", "skills");
  await mkdir(userSkills, { recursive: true });
  await symlink(external, path.join(userSkills, "linked-two"));

  return { workspacePath: path.join(root, "repo"), homeDirectory: path.join(root, "home") };
}

test("skills are scanned from repo, user, and symlinked directories", async () => {
  const { workspacePath, homeDirectory } = await skillTree();
  const [entry] = await listClaudeSkills(workspacePath, homeDirectory);
  const byName = new Map(entry.skills.map((skill) => [skill.name, skill]));

  assert.equal(byName.get("repo-one").description, "Repo scoped skill");
  assert.equal(byName.get("repo-one").scope, "repo");
  assert.equal(byName.get("linked-two").description, "Reached through a symlink");
  assert.equal(byName.get("linked-two").scope, "user");
});

test("the model catalog survives sanitizeModels", () => {
  const catalog = claudeModelCatalog();
  assert.ok(catalog.every((model) => typeof model.slug === "string" && model.visibility === "list"));
  assert.deepEqual(
    catalog.find((model) => model.slug === "opus").supported_reasoning_levels.map((l) => l.effort),
    ["low", "medium", "high", "xhigh", "max"],
  );
});
```

symlink 用例是**必须**的，不是补充覆盖：本机 `.claude/skills/*` 全是指向 sync-spells 的 symlink，不跟随就一个 skill 都扫不到。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/ai-chat-server.test.mjs`
Expected: FAIL with `listClaudeSkills is not a function`。

- [ ] **Step 3: 实现**

先补 import —— 文件首行现有的是 `import { readFile, realpath, stat } from "node:fs/promises";`，需要加上 `readdir`：

```javascript
import { readdir, readFile, realpath, stat } from "node:fs/promises";
```

同时 `import { execFile, spawn } from "node:child_process";` 与 `const execFileAsync = promisify(execFile);`、`CATALOG_TIMEOUT_MS`、`CATALOG_MAX_BUFFER` 在本 Task 后**全部变成死代码**（`codex debug models` 与 `codex app-server` 两个子进程调用都被删除），一并移除，`promisify` 的 import 也随之删掉。

然后在 `server/ai-chat-catalog.mjs` 中用 `listClaudeSkills` 替换 `listSkills`（删除 `codex app-server --stdio` 的整段 JSON-RPC 握手逻辑）：

```javascript
function frontmatterField(source, field) {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return "";
  const line = match[1].split("\n").find((entry) => entry.startsWith(`${field}:`));
  if (!line) return "";
  return line.slice(field.length + 1).trim().replace(/^["']|["']$/g, "");
}

async function scanSkillDirectory(directory, scope) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    const skillPath = path.join(directory, entry.name);
    let resolved;
    try {
      resolved = await realpath(skillPath);
      if (!(await stat(resolved)).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifest = path.join(resolved, "SKILL.md");
    let source;
    try {
      source = await readFile(manifest, "utf8");
    } catch {
      continue;
    }
    skills.push({
      name: frontmatterField(source, "name") || entry.name,
      description: frontmatterField(source, "description"),
      path: manifest,
      scope,
    });
  }
  return skills;
}

export async function listClaudeSkills(workspacePath, homeDirectory) {
  const groups = await Promise.all([
    scanSkillDirectory(path.join(workspacePath, ".claude", "skills"), "repo"),
    scanSkillDirectory(path.join(homeDirectory, ".claude", "skills"), "user"),
  ]);
  const pluginRoot = path.join(homeDirectory, ".claude", "plugins", "cache");
  let pluginGroups = [];
  try {
    const markets = await readdir(pluginRoot, { withFileTypes: true });
    pluginGroups = await Promise.all(markets.flatMap((market) => (market.isDirectory()
      ? [scanSkillDirectory(path.join(pluginRoot, market.name, "skills"), "system")]
      : [])));
  } catch { /* no plugins installed */ }
  return [{ skills: [...groups, ...pluginGroups].flat() }];
}
```

`discoverAiCatalog` 改为：

```javascript
export async function discoverAiCatalog({ homeDirectory, database, projectId }) {
  const { workspacePath } = await resolveAiWorkspace(projectId, homeDirectory, database);
  const skillEntries = await listClaudeSkills(workspacePath, homeDirectory);
  return {
    models: sanitizeModels(claudeModelCatalog()),
    skills: sanitizeSkills(skillEntries),
    sandboxes: ["plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"],
  };
}
```

`sanitizeModels` 第 76 行的错误文案 `Codex returned an invalid model catalog` 改为 `invalid model catalog`。`server/app.mjs` 的 `discoverSkills` 删除，调用点改用 `listClaudeSkills`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/ai-chat-server.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/ai-chat-catalog.mjs server/app.mjs test/ai-chat-server.test.mjs
git commit -m "feat(ai-chat): read skills, MCP servers, and models from Claude Code state"
```

## Task 5: 工作区发现改读 `~/.claude.json`

**Files:**
- Modify: `server/ai-chat-catalog.mjs:22-53`（`loadDeviceWorkspaces`）
- Modify: `server/app.mjs:1022-1075`（`codexProjectRoot`、`readCodexProjectWorkspaces`）、`:1276-1290`（`resolveServerOptions` 的路径默认值）
- Test: `test/ai-chat-database.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `export async function loadDeviceWorkspaces(claudeConfigPath, database)`，返回既有的 `Map<projectId, workspacePath>` 形状，因此 `resolveAiWorkspace` 的调用契约不变。

**数据源差异**：`~/.codex/state.json` 的 `local-projects` 是嵌套对象需要解析 root；`~/.claude.json` 的 `projects` **key 本身就是绝对路径**（本机实测 94 项），value 含 `lastSessionId` 等。因此解析显著更简单 —— 直接取 key 作为 workspacePath。

`resolveServerOptions` 中 `codexHome` / `codexStatePath` / `codexProcessesPath` 三个默认值改为单个 `claudeConfigPath`，默认 `path.join(os.homedir(), ".claude.json")`；`CODEX_HOME` env 读取改为 `CLAUDE_CONFIG_DIR`（Claude Code 自己的变量）后拼 `.claude.json`，缺省回退 home。Codex 的 `process_manager/chat_processes.json` 无等价物，相关分支删除。

- [ ] **Step 1: 写失败的测试**

追加到 `test/ai-chat-database.test.mjs`：

```javascript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDeviceWorkspaces } from "../server/ai-chat-catalog.mjs";

test("workspaces come from the absolute-path keys of ~/.claude.json projects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "taskboard-config-"));
  const configPath = path.join(root, ".claude.json");
  await writeFile(configPath, JSON.stringify({
    projects: {
      [root]: { lastSessionId: "6f1c2d34-5678-4abc-9def-0123456789ab" },
      "relative/not/absolute": { lastSessionId: "x" },
    },
  }));

  const workspaces = await loadDeviceWorkspaces(configPath, { listProjects: () => [] });
  assert.equal(workspaces.get(root), root);
  assert.equal(workspaces.has("relative/not/absolute"), false);
});

test("a missing or malformed config yields no workspaces instead of throwing", async () => {
  const empty = await loadDeviceWorkspaces("/nonexistent/.claude.json", { listProjects: () => [] });
  assert.equal(empty.size, 0);
});
```

第二个用例锁死「配置缺失不得抛」—— 原 Codex 实现对 `state.json` 缺失是静默容错的，这个行为必须保留，否则没装过 Claude Code 的机器上目录接口会 500。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/ai-chat-database.test.mjs`
Expected: FAIL —— 现有 `loadDeviceWorkspaces` 解析的是 `local-projects`，取不到以绝对路径为 key 的项目。

- [ ] **Step 3: 实现**

```javascript
export async function loadDeviceWorkspaces(claudeConfigPath, database) {
  const workspaces = new Map();
  try {
    const config = JSON.parse(await readFile(claudeConfigPath, "utf8"));
    const projects = config?.projects;
    if (projects && typeof projects === "object" && !Array.isArray(projects)) {
      for (const key of Object.keys(projects)) {
        const resolved = await existingDirectory(key);
        if (resolved) workspaces.set(key, resolved);
      }
    }
  } catch { /* no Claude Code config on this device */ }
  // 保留既有的 database 映射合并逻辑（taskctl project map 写入的显式映射优先）
  return workspaces;
}
```

`existingDirectory`（`server/ai-chat-catalog.mjs:12`）已经做了绝对路径校验与 `realpath`，直接复用 —— 相对路径 key 会被它过滤掉，正是第一个用例断言的行为。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/ai-chat-database.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/ai-chat-catalog.mjs server/app.mjs test/ai-chat-database.test.mjs
git commit -m "feat(ai-chat): discover workspaces from the Claude Code config"
```

## Task 6: 前端文案与全量验收

**Files:**
- Modify: `web/src/components/AiChat.tsx:2032,2033,2148,2175,2234,2236,2358,2360,2509`
- Test: `test/ai-chat-ui.test.mjs`、`test/ai-chat-state.test.mjs`

**Interfaces:**
- Consumes: 前面所有 Task
- Produces: 无（终结 Task）

文案改动（`AiChat.tsx`）：

| 位置 | 现文案 | 改为 |
| --- | --- | --- |
| 2032/2033 | `Codex AI 对话` | `Claude AI 对话` |
| 2148 | `Codex 正在处理` | `Claude 正在处理` |
| 2175 | `Codex 会在新对话创建时记住当前项目。` | `Claude 会在新对话创建时记住当前项目。` |
| 2234 | `询问 Codex` | `询问 Claude` |
| 2236 | `发送给 Codex 的消息` | `发送给 Claude 的消息` |
| 2358 | `应如何批准 Codex 操作？` | `应如何批准 Claude 操作？` |
| 2360 | `https://developers.openai.com/codex/security` | `https://docs.claude.com/en/docs/claude-code/iam` |
| 2509 | `本次消息允许 Codex 访问工作区之外的文件和命令。` | `本次消息允许 Claude 访问工作区之外的文件和命令。` |

`AiChat.tsx:117` 的 MIME `application/x-codex-taskboard-composer-fragment` **不改** —— 它是剪贴板 wire value，与嵌入层的 composer 协议对接。

- [ ] **Step 1: 改测试里对应的文案断言，运行确认失败**

Run: `node --test test/ai-chat-ui.test.mjs`
Expected: FAIL（断言仍指向旧文案）

- [ ] **Step 2: 改实现，运行确认通过**

Run: `node --test test/ai-chat-ui.test.mjs test/ai-chat-state.test.mjs`
Expected: PASS

- [ ] **Step 3: 残留检查**

Run:
```bash
grep -rn -i "codex" server web/src/components/AiChat.tsx \
  | grep -v "codexProjectId" | grep -v "codexThreadId" | grep -v "codex_thread_id" \
  | grep -v "codex-agent" | grep -v "x-codex-taskboard-composer-fragment"
```
Expected: 空输出。

- [ ] **Step 4: 全量验收**

```bash
npm run typecheck && npm run build
npm test 2>&1 | grep -E "^✖ " | sed -E 's/\([0-9.]+ms\)//' | sort -u > /tmp/p3-fails.txt
diff /tmp/base-fails.txt /tmp/p3-fails.txt
```

Expected: typecheck 与 build PASS；失败集比基线**少 4 项**（`test/ai-chat-state.test.mjs`、`test/ai-chat-ui.test.mjs`、`Codex turns use stdin, explicit resume ids, server-owned cwd and sanitized visible events`、`loopback AI API freezes server-owned origin and rejects injected execution fields`），且**无任何新增失败**。

- [ ] **Step 5: 真实端到端验证（不可省略）**

```bash
TASKBOARD_HOST=127.0.0.1 npm start
```

浏览器打开 <http://127.0.0.1:47823>，在某个映射了工作区的项目里开一个 AI Chat 对话，发一句「运行 `echo hello` 并回复 DONE」。确认：

1. 界面出现 `command_execution` 条目，命令文本为 `echo hello`
2. 出现 `agent_message` 条目，内容为 `DONE`
3. 对话落库的 session id 与 `~/.claude/projects/<slug>/` 下新增的 `<session-id>.jsonl` 同名 —— 这是「`--session-id` 预生成真的被 Claude Code 采纳」的独立证据，不能只看 Taskboard 自己的回显
4. 追问第二句，确认走 `--resume` 而非新建会话（`~/.claude/projects/` 下不应再多一个 jsonl）

- [ ] **Step 6: Commit**

```bash
git add web/src/components/AiChat.tsx test/ai-chat-ui.test.mjs test/ai-chat-state.test.mjs
git commit -m "docs(ai-chat): rebrand the chat panel for Claude"
```

## 风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| `--session-id` 传入已存在的 UUID 会报错还是复用？未实测 | 首轮可能失败 | Task 3 Step 6 后单独跑一次真实 `claude -p --session-id <新 UUID>` 确认；若拒绝复用，改为首轮不传、从 `system/init` 回读（退回 Codex 那套时序） |
| `--effort max` 可能需要特定模型/订阅 | 选了 max 的对话失败 | 静态表已列出，但 Task 6 端到端只验证默认档；max 档由用户按需验证 |
| Skill 扫描的 plugin 路径 `~/.claude/plugins/cache/*/*/skills/` 层级依版本而变 | plugin skills 漏扫 | 扫描失败静默跳过（已在实现里 try/catch），不影响 repo/user 两个主来源 |
| 前端按 `itemId` 关联 tool_use 与 tool_result | 若前端假设 Codex 的 id 格式，条目可能不合并 | Task 6 Step 5 的第 1 条即验证合并结果；不合并则在归一化层补 id 前缀映射 |
