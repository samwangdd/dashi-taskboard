# Claude Code 适配 P1+P2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 fork 后的 Taskboard 脱离 Codex 品牌与环境变量，并让 Claude Code 会话能通过 Skill + `taskctl` 读写 issue，且每次变更正确归属到当前 Claude session。

**Architecture:** 两阶段。P1 是纯品牌/配置层的机械替换（env 前缀、包名、文档、agent 显示名与图标、面向用户的品牌文案）。P2 建立会话归属闭环：`taskctl` 的 env fallback 改名、新增一个 SessionStart hook 脚本把 `session_id` 以 additionalContext 注入模型、Skill 落到 sync-spells。嵌入层（注入器及其 DOM/query 契约）全程零改动。

**Tech Stack:** Node.js ≥22.5（原生 `node:test`、`node:sqlite`）、React 19 + Vite 8、TypeScript 7。测试全部是 `node --test`，断言方式包含对源码文本的正则断言。

## 执行状态（2026-08-05）

分支 `feat/claude-code-adaptation`，6 个提交。

| Task | 状态 | 备注 |
| --- | --- | --- |
| 1 env 前缀 | ✅ `1a46a0f` | |
| 2 agent 身份 | ✅ `adca7f2` | 实际改的是 3 处 `AGENT_ACTOR` 引用（plan 漏了 `server/app.mjs:499`）；`server/index.mjs` 启动日志也是漏项，在 Task 8 补上 |
| 3 品牌/文档 | ✅ `41960e7` | `package.json` 用 `git apply --cached` 只暂存 `name` hunk，未触碰工作区里在途的 `--replace` 改动 |
| 4 taskctl 归属 | ✅ `28d9f5f` | |
| 5 SessionStart hook | ✅ `4c2e907` | 脚本 + 3 个单测，stdin/stdout 契约已端到端验证 |
| 6 注册 hook 到 settings | ⏸ 待用户授权 | 修改 `settings.json` 属 harness 配置变更，须走 `update-config` 并取得显式授权 |
| 7 Skill 落 sync-spells | ⚠️ 已就地适配，**未做 subagent 基线测试** | 见下方说明 |
| 8 归属文案 + 验收 | ✅ `61b3449` | typecheck PASS、build PASS、失败集与基线零差异 |

### Task 7 的两点偏离

1. **skill 目录在执行时已存在**：`skill-category/workflow/manage-taskboard/` 在本 session 期间由本机某个分发机制创建（git 未跟踪，同期仓库里也出现了 `.agents/`、`.cursor/`、`.kiro/` 三个 skill 镜像目录），内容是上游 Codex 版 + `version: 1.0.0` + `agents/openai.yaml`。因此改为**就地编辑适配**而非覆盖写入，`agents/openai.yaml`（Codex/OpenAI 接口元数据，含 `$manage-taskboard` 调用语法）**原样保留未删**，需用户决定是否清理。
2. **未执行 `superpowers:writing-skills` 要求的 RED 基线**：该流程依赖 subagent 压力测试，与本 session「未经用户请求不得调 Agent」的约束冲突。替代验证：本 skill 是上游生产中已验证 skill 的移植，对其声称的 CLI 契约做了真实服务端到端验证 —— `TASKBOARD_URL` 路由、`TASKBOARD_SESSION_ID` → `threadId`、默认受理人 `Claude Agent`、`--if-version` 递增、过期版本 exit 5 + `VERSION_CONFLICT`、缺归属 exit 2 + 新错误文案，全部实测通过。subagent 检索/应用场景测试仍是缺口。

`spells` profile 绑定未做（`use/bind` 是替换语义，误操作会丢基础 skill），需用户自行决定。

## Global Constraints

- 环境变量前缀统一为 `TASKBOARD_*`，**不得**使用 `CLAUDE_*`（Claude Code 官方命名空间）。
- 受理人 actor id / wire value `codex-agent` **保持不变**；只改显示名为 `Claude Agent`。
- SQLite **列名**保持不变；不为纯改名引入 schema 变更（`ALTER TABLE` / 建表改动）。重标记既有行显示名的 `UPDATE` 语句不属此列，Task 2 Step 5 明确允许。
- 以下文件**零改动**：`scripts/codex-injector.mjs`、`scripts/codex-injector-runtime.mjs`、`inject/codex-taskboard.user.js`、`scripts/codex-rate-limits.mjs`、`wrangler.jsonc`、`cloud/migrations/*`、`test/inject.test.mjs`、`test/injector.test.mjs`。
- 嵌入层标识符零改动：`web/src/App.tsx` 全部 Codex 引用、`web/src/api.ts:269-276` 的 `codexProjectId`/`codexThreadId` query 参数、`web/src/types.ts:112` 的 `codexThreadId`、`web/src/styles.css` 全部 `codex-*` / `--codex-*` 选择器与自定义属性。
- 不做 Codex/Claude 双 provider 兼容，不保留旧 env 名的 fallback。
- 每个 Task 结束时只暂存该 Task 涉及的文件；**禁止 `git add -A`**（工作区存在与本计划无关的 `scripts/codex-injector.mjs`、`test/injector.test.mjs`、`package.json` 在途改动）。
- 验收命令：`npm run check`（= `npm run typecheck && npm run build && npm test`）。
- ⚠️ **上游 `main` 的测试套件本身是红的：17 个用例在未改动的 HEAD 上即失败**（执行 Task 1-3 时实测确认）。因此验收标准**不是**「`npm test` 全绿」，而是「失败集与 `main` 基线逐字节一致，无新增失败」。取基线的方法：

  ```bash
  git worktree add -q /tmp/dtb-base main
  ln -sfn "$PWD/node_modules" /tmp/dtb-base/node_modules
  (cd /tmp/dtb-base && node --test 2>&1 | grep -E "^✖ " | sed -E 's/\([0-9.]+ms\)//' | sort -u) > /tmp/base-fails.txt
  rm -f /tmp/dtb-base/node_modules && git worktree remove --force /tmp/dtb-base
  ```

  已知的 17 个既有失败集中在：AI Chat（`ai-chat-state`、`ai-chat-ui`、`Codex turns use stdin…`、`loopback AI API…`）、附件与评论 UI、workflow 画布、automation 菜单、`configured server proxies business APIs…`、`workflow capabilities come from the live Codex skill and MCP catalogs`。其中 AI Chat 那一批正是 P3 要重写的范围。
- `typecheck` 与 `build` 在 HEAD 上是绿的，这两项必须保持绿。

---

## P1 — 品牌与配置层

### Task 1: 环境变量前缀改为 `TASKBOARD_*`

**Files:**
- Modify: `server/app.mjs:1272,1292,1295,1300,1303`
- Modify: `cli/taskctl.mjs:190,309,768,771,780,781`
- Test: `test/cli.test.mjs:64,72`
- Test: `test/cloud-companion.test.mjs:673,701,712,727,728`

**Interfaces:**
- Consumes: 无（首个 Task）
- Produces: 环境变量名 `TASKBOARD_DATA_DIR`、`TASKBOARD_PORT`、`TASKBOARD_HOST`、`TASKBOARD_URL`、`TASKBOARD_COMPANION_URL`。后续 Task 3 的 README 环境变量表必须与此一致。

- [ ] **Step 1: 改测试里的环境变量名（先让测试失败）**

`test/cli.test.mjs` 第 64、72 行：

```javascript
test("TASKBOARD_URL overrides the service origin", async () => {
  let requestedUrl;
  const result = await run(
    ["project", "list", "--json"],
    async (url) => {
      requestedUrl = url;
      return response({ projects: [] });
    },
    { env: { TASKBOARD_URL: "https://tasks.example.test/" } },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(requestedUrl.toString(), "https://tasks.example.test/api/projects");
});
```

`test/cloud-companion.test.mjs`：把 5 处 `CODEX_TASKBOARD_COMPANION_URL` / `CODEX_TASKBOARD_URL` 键名改成 `TASKBOARD_COMPANION_URL` / `TASKBOARD_URL`，值不变。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/cli.test.mjs test/cloud-companion.test.mjs`
Expected: FAIL —— `TASKBOARD_URL overrides the service origin` 请求到 `http://127.0.0.1:47823/api/projects` 而非 `https://tasks.example.test/api/projects`（新键名尚未被读取，落回默认 origin）。

- [ ] **Step 3: 改服务端与 CLI 的读取点**

`server/app.mjs`：

```javascript
  const configuredDataDirectory = options.dataDirectory ?? process.env.TASKBOARD_DATA_DIR;
```

```javascript
export function resolvePort(value = process.env.TASKBOARD_PORT ?? "47823") {
```

```javascript
    throw new Error("TASKBOARD_PORT must be an integer between 1 and 65535");
```

```javascript
export function resolveHost(value = process.env.TASKBOARD_HOST ?? "0.0.0.0") {
```

```javascript
    throw new Error("TASKBOARD_HOST must be 127.0.0.1 or 0.0.0.0");
```

`cli/taskctl.mjs`：

```javascript
    baseUrl: usesCompanionControl || env.TASKBOARD_COMPANION_URL !== undefined
```

```javascript
  const baseUrl = normalizeBaseUrl(explicitBaseUrl ?? env.TASKBOARD_URL ?? DEFAULT_API_URL);
```

```javascript
    throw usageError("TASKBOARD_URL must be a valid URL");
```

```javascript
    throw usageError("TASKBOARD_URL must use http or https");
```

```javascript
  const rawUrl = env.TASKBOARD_COMPANION_URL
    ?? env.TASKBOARD_URL
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/cli.test.mjs test/cloud-companion.test.mjs`
Expected: PASS

- [ ] **Step 5: 确认没有遗留的旧前缀（注入器与其测试除外）**

Run:
```bash
grep -rn "CODEX_TASKBOARD_" --include="*.mjs" --include="*.md" . \
  | grep -v node_modules | grep -v dist \
  | grep -v scripts/codex-injector.mjs \
  | grep -v test/inject.test.mjs | grep -v test/injector.test.mjs \
  | grep -v docs/superpowers
```
Expected: 只剩 `README.md` 与 `docs/cloud-collaboration.md`（由 Task 3 处理）、以及 `skills/manage-taskboard/references/cli.md`（上游文件，按设计保留不改）。

- [ ] **Step 6: Commit**

```bash
git add server/app.mjs cli/taskctl.mjs test/cli.test.mjs test/cloud-companion.test.mjs
git commit -m "refactor: rename taskboard env prefix to TASKBOARD_"
```

---

### Task 2: Agent 显示名与头像资产

**Files:**
- Modify: `server/app.mjs:46-51`
- Modify: `web/src/actors.ts:3,6,18`
- Modify: `web/src/components/ActorAvatar.tsx:19`
- Modify: `web/src/components/TaskDetail.tsx:33,565`
- Modify: `web/src/components/TaskEditor.tsx`（`CODEX_AGENT_ACTOR` 引用处）
- Create: `web/public/agent-logo.svg`
- Delete: `web/public/codex-agent-logo.png`
- Modify: `server/database.mjs`（新增一条重标记既有 agent 行的迁移）
- Test: `test/actor-identity.test.mjs:32,56`
- Test: `test/issue-assignee.test.mjs:25,38`
- Test: `test/server.test.mjs:845,849,870,1537,1554,1559,1572,1614`
- Test: `test/cloud-companion.test.mjs:156,197`
- Test: `test/cloud-migration.test.mjs:225,229`
- Test: `test/cloud-shared-worker.test.mjs:103`
- Modify: `cloud/src/index.mjs:361,381`

**Interfaces:**
- Consumes: 无
- Produces: 常量 `AGENT_ACTOR`（原 `CODEX_AGENT_ACTOR`），形状 `{ type: "agent", id: "codex-agent", name: "Claude Agent", avatarUrl: null }`；头像资源路径 `/agent-logo.svg`。

> `id` 仍为 `codex-agent` —— 它是 wire value，见 Global Constraints。

- [ ] **Step 1: 准备头像资产**

```bash
cp node_modules/@lobehub/icons-static-svg/icons/claudecode-color.svg web/public/agent-logo.svg
git rm web/public/codex-agent-logo.png
```

改用 SVG 而非 PNG：资产自带（424 字节、单 path、品牌色 `#D97757`），无需引入 SVG→PNG 光栅化工具链，且缩放更清晰。`.actor-avatar-agent-image { object-fit: contain }` 对 SVG 同样生效。

- [ ] **Step 2: 改测试（先让测试失败）**

`test/actor-identity.test.mjs` 第 32 行：

```javascript
  assert.match(avatarSource, /src="\/agent-logo\.svg"/);
```

第 55-59 行整个用例替换为：

```javascript
test("agent avatar asset is an inline-safe SVG logo", async () => {
  const logo = await readFile(new URL("../web/public/agent-logo.svg", import.meta.url), "utf8");
  assert.match(logo, /^<svg\b/);
  assert.match(logo, /viewBox="0 0 24 24"/);
  assert.match(logo, /#D97757/);
});
```

`test/issue-assignee.test.mjs` 第 25、38 行：

```javascript
  assert.match(editorSource, /AGENT_ACTOR/);
```

```javascript
  assert.match(avatarSource, /agent-logo\.svg/);
```

`test/server.test.mjs`：把 7 处断言字符串 `"Codex Agent"` 改为 `"Claude Agent"` —— 第 845、1554 行的 `creatorName`，第 849、1559、1614 行的 `name`，第 870、1572 行的 `authorName`；第 1537 行用例名改为 `taskctl issue creation and comments use the Claude Agent identity`。`creatorId` / `authorId` 的 `"codex-agent"` 断言**保持不变**。

`test/cloud-companion.test.mjs` 第 156、197 行、`test/cloud-migration.test.mjs` 第 225、229 行的 `creatorName` / `'Codex Agent'` 改为 `Claude Agent`；`test/cloud-shared-worker.test.mjs` 第 103 行改为 `/Claude Agent/`。

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/actor-identity.test.mjs test/issue-assignee.test.mjs test/server.test.mjs`
Expected: FAIL —— `agent avatar asset is an inline-safe SVG logo` 报 `ENOENT` 或断言失败前的 `src="/codex-agent-logo.png"` 不匹配；server 测试报 `expected 'Claude Agent' to equal 'Codex Agent'`。

- [ ] **Step 4: 改实现**

`server/app.mjs:46-51`：

```javascript
const AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Claude Agent",
  avatarUrl: null,
};
```

同文件第 551 行的引用改为 `AGENT_ACTOR`。

`web/src/actors.ts`：

```typescript
export const AGENT_ACTOR: ActorIdentity = {
  type: "agent",
  id: "codex-agent",
  name: "Claude Agent",
  avatarUrl: null,
};
```

第 18 行：`return target === "codex-agent" ? AGENT_ACTOR : currentUser;`

`web/src/components/ActorAvatar.tsx:19`：

```tsx
          src="/agent-logo.svg"
```

`web/src/components/TaskDetail.tsx` 第 33、565 行与 `web/src/components/TaskEditor.tsx` 中的 `CODEX_AGENT_ACTOR` 全部改为 `AGENT_ACTOR`。

`cloud/src/index.mjs` 第 361、381 行：

```javascript
      name: `Claude Agent (${username})`,
```

```javascript
    name: `Claude Agent (${actor.username})`,
```

- [ ] **Step 5: 新增一条迁移，重标记既有 agent 行**

`server/database.mjs`，紧跟第 443 行那条 `UPDATE comments … 'Codex Agent'` 之后追加（**不修改历史迁移本身**，它针对的是更早的遗留行）：

```javascript
    this.database.exec(`
      UPDATE tasks SET creator_name = 'Claude Agent'
      WHERE creator_type = 'agent' AND creator_name = 'Codex Agent'
    `);
    this.database.exec(`
      UPDATE tasks SET assignee_name = 'Claude Agent'
      WHERE assignee_type = 'agent' AND assignee_name = 'Codex Agent'
    `);
    this.database.exec(`
      UPDATE comments SET author_name = 'Claude Agent'
      WHERE author_type = 'agent' AND author_name = 'Codex Agent'
    `);
```

避免既有库里旧行显示 `Codex Agent`、新行显示 `Claude Agent` 的混杂标签。

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test test/actor-identity.test.mjs test/issue-assignee.test.mjs test/server.test.mjs test/cloud-companion.test.mjs test/cloud-migration.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/app.mjs server/database.mjs cloud/src/index.mjs \
  web/src/actors.ts web/src/components/ActorAvatar.tsx \
  web/src/components/TaskDetail.tsx web/src/components/TaskEditor.tsx \
  web/public/agent-logo.svg web/public/codex-agent-logo.png \
  test/actor-identity.test.mjs test/issue-assignee.test.mjs test/server.test.mjs \
  test/cloud-companion.test.mjs test/cloud-migration.test.mjs test/cloud-shared-worker.test.mjs
git commit -m "refactor: rename the default agent identity to Claude Agent"
```

---

### Task 3: 包名、文档与品牌文案

**Files:**
- Modify: `package.json:2`
- Modify: `README.md`（标题、Skill 章节、注入器章节、环境变量表、LAN 段落）
- Modify: `AGENTS.md:11`
- Modify: `docs/cloud-collaboration.md:105,133,138`
- Modify: `web/index.html:9`
- Modify: `web/src/api.ts:77`
- Modify: `web/src/components/ProjectAutomationMenu.tsx:202`

**Interfaces:**
- Consumes: Task 1 定义的 `TASKBOARD_*` 变量名
- Produces: README 环境变量表，供使用者与后续 Task 7 的 Skill 文档引用

- [ ] **Step 1: 改包名**

`package.json` 第 2 行：

```json
  "name": "claude-taskboard",
```

- [ ] **Step 2: 改 README**

- 标题 `# Codex Taskboard` → `# Claude Taskboard`
- 首段改写为：本地优先的 issue board，在浏览器中运行，由 Claude Code CLI 驱动；同一套 HTTP API 同时服务 React UI 与 `taskctl`。
- 环境变量表（第 107-112 行）四个变量名改为 `TASKBOARD_HOST` / `TASKBOARD_PORT` / `TASKBOARD_DATA_DIR` / `TASKBOARD_URL`，默认值与 Purpose 不变。
- 第 45 行、第 114 行正文里的 `CODEX_TASKBOARD_URL` 改为 `TASKBOARD_URL`。
- 「Install the Codex Skill」章节（第 47-56 行）替换为指向 sync-spells 的说明（Task 7 会写入确切路径，本 Step 先留下章节标题 `## Install the Skill` 与一句「Skill 由 sync-spells 分发，见 Task 7」——**Task 7 必须回来补完这段，Task 3 不算完成该章节**）。
- 「Embed in Codex」章节（第 58-103 行）**内容不改**，仅在章节标题下加一行说明：该章节及 `npm run codex*` 脚本是上游的 Codex 桌面端嵌入能力，本 fork 未适配 Claude 桌面版，保留原样可继续对 Codex 使用；其中 `CODEX_TASKBOARD_HOST=…` 示例改为 `TASKBOARD_HOST=…`（注入器通过 `spawn` 继承环境，不引用变量名，故仍可用）。

- [ ] **Step 3: 改 cloud 文档**

`docs/cloud-collaboration.md` 第 105、133 行的 `CODEX_TASKBOARD_HOST` → `TASKBOARD_HOST`；第 138 行的 `CODEX_TASKBOARD_URL` → `TASKBOARD_URL`、`CODEX_TASKBOARD_COMPANION_URL` → `TASKBOARD_COMPANION_URL`。

- [ ] **Step 4: 改 B 类品牌文案**

`web/index.html` 第 9 行：

```html
      content="A focused issue board for turning plans into finished work with Claude Code."
```

`web/src/api.ts` 第 77 行：

```typescript
        message: "无法连接本地 Taskboard 服务，请确认 npm start 正在运行。",
```

原文案让用户「重新通过 Taskboard 启动 Codex」，在 CLI 形态下不成立。

`web/src/components/ProjectAutomationMenu.tsx` 第 202 行：

```tsx
              ? "API Key 模式不支持读取订阅额度"
```

- [ ] **Step 5: 修订 `AGENTS.md` 第 11 条，消除与全局 TDD 规则的冲突**

上游 `AGENTS.md:11` 现文写着本规则「supersedes the earlier standing instruction that every feature must be developed test-first」。fork 后这是我们自己的文件，把该句替换为：

```markdown
The primary objective is to make the requested function work. Focus on the feature implementation itself and avoid over-design; safety, guardrails, and testing must not dominate the work or turn the feature into a surrounding engineering project. Develop features test-first: write the failing test, make it pass, then refactor. This ordering constrains scope, not test-first discipline — do not add speculative guardrails, legacy-compatibility shims, or defensive fallbacks beyond the requested path.
```

保留原第 1-10 条与第 12-13 条不动。改动理由：本 fork 的适配全部落在已有测试覆盖的既有行为上，扩测成本极低；同时全局 CLAUDE.md 强制 TDD，两条规则并存会让后续执行者无从判断。

- [ ] **Step 6: 验证构建与全量测试**

Run: `npm run check`
Expected: PASS（typecheck + 前端生产构建 + 全部测试）

- [ ] **Step 7: Commit**

```bash
git add package.json README.md AGENTS.md docs/cloud-collaboration.md \
  web/index.html web/src/api.ts web/src/components/ProjectAutomationMenu.tsx
git commit -m "docs: rebrand taskboard for Claude Code"
```

---

## P2 — 会话归属闭环

### Task 4: `taskctl` 会话归属环境变量

**Files:**
- Modify: `cli/taskctl.mjs:682-693`
- Test: `test/cli.test.mjs:28,468,476`

**Interfaces:**
- Consumes: Task 1 的 `TASKBOARD_*` 命名约定
- Produces: 环境变量 `TASKBOARD_SESSION_ID` 作为 `--thread-id` 的 fallback；错误文案 `conversation attribution requires --thread-id or TASKBOARD_SESSION_ID`。Task 5 的 hook 与 Task 7 的 Skill 都依赖这两个名字。

- [ ] **Step 1: 改测试（先让测试失败）**

`test/cli.test.mjs` 第 28 行 `run()` 默认 env：

```javascript
    env: { TASKBOARD_SESSION_ID: "thread-current" },
```

第 468、476 行的错误文案断言：

```javascript
  assert.match(issueResult.stderr.error.message, /--thread-id or TASKBOARD_SESSION_ID/);
```

```javascript
  assert.match(commentResult.stderr.error.message, /--thread-id or TASKBOARD_SESSION_ID/);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/cli.test.mjs`
Expected: FAIL —— 大量用例报 `Codex conversation attribution requires --thread-id or CODEX_THREAD_ID`（新 env 名未被读取，归属解析直接抛错）。

- [ ] **Step 3: 改实现**

`cli/taskctl.mjs:682-693`：

```javascript
function resolveThreadId(options, overrides) {
  const env = overrides.env ?? process.env;
  const value = options["thread-id"] ?? env.TASKBOARD_SESSION_ID;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw usageError("conversation attribution requires --thread-id or TASKBOARD_SESSION_ID");
  }
  const threadId = value.trim();
  if (threadId.length > 256) {
    throw usageError("--thread-id and TASKBOARD_SESSION_ID cannot exceed 256 characters");
  }
  return threadId;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/cli.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/taskctl.mjs test/cli.test.mjs
git commit -m "feat: attribute taskctl mutations through TASKBOARD_SESSION_ID"
```

---

### Task 5: SessionStart hook 脚本

**Files:**
- Create: `scripts/claude-session-context.mjs`
- Test: `test/session-context.test.mjs`

**Interfaces:**
- Consumes: Task 4 的 `--thread-id` 参数名
- Produces: 导出 `buildSessionContext(payload)` → 返回 `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: string } }`，`session_id` 缺失或超长时返回 `null`。Task 6 注册该脚本为 hook 命令。

- [ ] **Step 1: 写失败的测试**

Create `test/session-context.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionContext } from "../scripts/claude-session-context.mjs";

test("a SessionStart payload becomes taskctl attribution context", () => {
  const output = buildSessionContext({
    session_id: "6f1c2d34-5678-4abc-9def-0123456789ab",
    hook_event_name: "SessionStart",
    source: "startup",
  });

  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /--thread-id 6f1c2d34-5678-4abc-9def-0123456789ab/,
  );
});

test("a payload without a session id produces no context", () => {
  assert.equal(buildSessionContext({ hook_event_name: "SessionStart" }), null);
  assert.equal(buildSessionContext({ session_id: "   " }), null);
  assert.equal(buildSessionContext(null), null);
});

test("an oversized session id is rejected", () => {
  assert.equal(buildSessionContext({ session_id: "a".repeat(257) }), null);
});
```

257 与 Task 4 中 `taskctl` 的 256 字符上限对齐：hook 不产出 `taskctl` 会拒收的值。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/session-context.test.mjs`
Expected: FAIL with `Cannot find module … scripts/claude-session-context.mjs`

- [ ] **Step 3: 写实现**

Create `scripts/claude-session-context.mjs`:

```javascript
#!/usr/bin/env node
import { readFileSync } from "node:fs";

const MAX_SESSION_ID_LENGTH = 256;

export function buildSessionContext(payload) {
  const raw = payload?.session_id;
  if (typeof raw !== "string") return null;
  const sessionId = raw.trim();
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Taskboard 会话归属：当前 Claude Code session id 为 ${sessionId}。`
        + ` 用 taskctl 做任何 issue / relation / comment 变更时，附带 --thread-id ${sessionId}。`,
    },
  };
}

function isDirectRun() {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === new URL(`file://${entry}`).href;
}

if (isDirectRun()) {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const output = buildSessionContext(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/session-context.test.mjs`
Expected: PASS

- [ ] **Step 5: 端到端确认 hook 的 stdin/stdout 契约**

Run:
```bash
echo '{"session_id":"abc-123","hook_event_name":"SessionStart","source":"startup"}' \
  | node scripts/claude-session-context.mjs
```
Expected: 单行 JSON，包含 `"hookEventName":"SessionStart"` 与 `--thread-id abc-123`。

Run:
```bash
echo 'not json' | node scripts/claude-session-context.mjs; echo "exit=$?"
```
Expected: 无输出，`exit=0`（hook 失败不得阻塞会话启动）。

- [ ] **Step 6: Commit**

```bash
git add scripts/claude-session-context.mjs test/session-context.test.mjs
git commit -m "feat: add a SessionStart hook that injects taskctl attribution context"
```

---

### Task 6: 注册 hook 到 Claude Code settings

**Files:**
- Modify: `~/.claude/settings.json`（用户级）

**Interfaces:**
- Consumes: Task 5 的 `scripts/claude-session-context.mjs` 绝对路径
- Produces: 生效的 SessionStart hook

> ⚠️ 这一步修改用户级配置，属于 harness 配置变更：**必须通过 `update-config` skill 执行，并取得用户显式授权**。不要手改 `settings.json`。

- [ ] **Step 1: 调用 update-config skill 落地配置**

目标配置形状（hook 只在本仓库工作区生效，避免污染其它项目）：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/sammore/codeLab/dashi-taskboard/scripts/claude-session-context.mjs"
          }
        ]
      }
    ]
  }
}
```

若用户希望限定作用域，改为写入本仓库的 `.claude/settings.json` 而非用户级 `~/.claude/settings.json`。**推荐写入仓库级**：Taskboard 归属只在这个项目里有意义。

- [ ] **Step 2: 在新会话中验证 hook 生效**

新开一个 Claude Code 会话（在本仓库目录下），确认上下文中出现 `Taskboard 会话归属：当前 Claude Code session id 为 …`。

Expected: 该行存在，且其中的 session id 与 `~/.claude.json` 里 `projects["/Users/sammore/codeLab/dashi-taskboard"].lastSessionId` 一致。

- [ ] **Step 3: 无需 commit**

用户级/仓库级 settings 变更由 `update-config` 处理；若落在仓库 `.claude/settings.json`，按该 skill 的指引决定是否提交。

---

### Task 7: Skill 落到 sync-spells

**Files:**
- Create: `$SYNCSPELLS_PATH/skill-category/workflow/manage-taskboard/SKILL.md`
- Create: `$SYNCSPELLS_PATH/skill-category/workflow/manage-taskboard/references/cli.md`
- Modify: `README.md`（补完 Task 3 Step 2 留下的 `## Install the Skill` 章节）
- 不改：`skills/manage-taskboard/*`（上游文件原样保留）

**Interfaces:**
- Consumes: Task 4 的 `--thread-id` / `TASKBOARD_SESSION_ID`、Task 5 注入的 additionalContext、Task 1 的 `TASKBOARD_URL`
- Produces: sync-spells 中可被 profile 引用的 `manage-taskboard` skill

> ⚠️ **必须先走 `superpowers:writing-skills`**（RED→GREEN），这是 CLAUDE.md 的硬约束：任何 skill 的创建都要经它。category 落位与 profile 归属交给 `sync-spells-maintainer` agent，不要手动编辑 profiles。

- [ ] **Step 1: 调用 writing-skills skill 创建 skill**

内容以 `skills/manage-taskboard/SKILL.md`（32 行）与 `skills/manage-taskboard/references/cli.md` 为基础，必须做的改写：

- frontmatter `description` 里的 `Use when Codex needs to…` → `Use when Claude Code needs to…`
- 第 22 行「Issues created through `taskctl` are assigned to Codex Agent by default」→ `Claude Agent`
- 第 23 行整条重写：
  > Let `taskctl` attribute every issue, relation, or comment mutation to the current Claude Code session. The SessionStart hook reports the session id in context; pass it as `--thread-id <session-id>`. Outside a hooked session, set `TASKBOARD_SESSION_ID`.
- 第 28 行「Codex self-verification alone is not sufficient」→ `Claude Code self-verification alone is not sufficient`
- `references/cli.md` 第 16 行 `CODEX_TASKBOARD_URL` → `TASKBOARD_URL`；第 62 行 `Codex Agent` → `Claude Agent`
- 其余工作流条款（乐观版本 `--if-version`、`in_review` 不得直接跳 `done`、附件内联图片语义）逐字保留

- [ ] **Step 2: 交由 sync-spells-maintainer 归类**

落位 `skill-category/workflow/manage-taskboard/`（与 `task-run`、`jira-handoff` 同级；依据 `PROFILES.md` 中 Workflow = 有序步骤 + 外部系统 + 任务交接）。profile 归属由该 agent 决定 —— 注意 `spells use/bind` 是替换语义，改前先 resolve 确认含基础 skill。

- [ ] **Step 3: 补完 README 的 Skill 章节**

```markdown
## Install the Skill

The `manage-taskboard` skill is distributed through sync-spells at
`skill-category/workflow/manage-taskboard/`. Activate it through a profile
rather than copying it into `~/.claude/skills/`.

The skill teaches Claude Code to inspect an issue, move it to `in_progress`
with an optimistic version, verify the work, and move it to `in_review`; it
moves the issue to `done` only after the user explicitly confirms acceptance.
```

- [ ] **Step 4: Commit README**

```bash
git add README.md
git commit -m "docs: point the skill section at sync-spells"
```

sync-spells 是独立的 iCloud git 仓库，其提交按该仓库的节奏单独处理（注意 iCloud 同步余波：`git status` 稳定后再一次性提交）。

---

### Task 8: 归属相关 UI 文案与全量验收

**Files:**
- Modify: `web/src/components/TaskFilterMenu.tsx:60,61,192,193`
- Modify: `web/src/components/WorkflowInspector.tsx:812`

**Interfaces:**
- Consumes: Task 4 建立的「会话 = Claude Code session」语义
- Produces: 无（终结 Task）

- [ ] **Step 1: 改文案**

`web/src/components/TaskFilterMenu.tsx`：

```tsx
  linked: "Claude 已处理",
  unlinked: "尚未由 Claude 处理",
```

```tsx
      category: "Claude 会话",
      keywords: "claude session thread task 已处理",
```

`web/src/components/WorkflowInspector.tsx` 第 812 行：

```tsx
                <span>记录执行该议题的 Claude 会话</span>
```

- [ ] **Step 2: 确认没有遗漏的品牌层残留**

Run:
```bash
grep -rn -i "codex" web/src server cli README.md docs/cloud-collaboration.md \
  --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.md" \
  | grep -v "codexProjectId" | grep -v "codexThreadId" \
  | grep -v "inCodex" | grep -v "codex-agent" \
  | grep -v '"codex"' | grep -v "codex://" \
  | grep -v "Embed in Codex" | grep -v "npm run codex"
```
Expected: 空输出。任何命中都要判断是 A 类嵌入契约（保留）还是漏改的 B 类文案（改掉）。

- [ ] **Step 3: 全量验收**

Run: `npm run check`
Expected: PASS —— typecheck 无错、前端生产构建成功、全部 `node --test` 用例通过。

- [ ] **Step 4: 手工确认最小可用闭环**

```bash
TASKBOARD_HOST=127.0.0.1 npm start
```

在浏览器打开 <http://127.0.0.1:47823>，确认：议题卡片上的 agent 头像是 Claude Code 图标、受理人显示 `Claude Agent`、筛选菜单显示「Claude 已处理」。

再在本仓库的 Claude Code 会话里让 Claude 用 `taskctl` 创建一个 issue，确认：

```bash
npm run taskctl -- issue list --project <id> --json
```

返回的 `threadId` 等于当前会话 id（即 Task 6 Step 2 验证过的那个值）。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TaskFilterMenu.tsx web/src/components/WorkflowInspector.tsx
git commit -m "docs: describe issue attribution as Claude sessions"
```

---

## 后续（不在本计划内）

P3（AI Chat 后端换 `claude -p --output-format stream-json`）与 P4（项目发现读 `~/.claude.json`、DB 字段标识符）是独立子系统，另立一份计划。P3 开始前需先用一次真实 `claude -p` 调用采集 stream-json 事件样本作为测试 fixture。
