# Dashi Taskboard — Claude Code 适配设计

- 日期：2026-08-05
- Fork：`chuspeeism/dashi-taskboard` → `samwangdd/dashi-taskboard`（`upstream` 保留原仓库）
- 范围决策：**CLI / Skill 层完整适配**，不移植桌面 App 注入

## 1. 目标与非目标

### 目标

让 Taskboard 在浏览器中运行、由 **Claude Code CLI** 驱动，取得与原仓库在 Codex 下等价的能力：

1. Claude Code 通过 Skill + `taskctl` 读写 issue，并把每次变更归属到当前 Claude 会话
2. Taskboard 内置的 AI Chat 以 `claude` 为后端子进程（原为 `codex exec`）
3. 项目/工作区列表来自 Claude Code 的本机状态，而非 `~/.codex/state.json`
4. 命名与环境变量脱离 Codex

### 非目标

- **不移植桌面 App 嵌入**：`scripts/codex-injector.mjs`、`scripts/codex-injector-runtime.mjs`、`inject/codex-taskboard.user.js`（约 2800 行）保持原样不改，`npm run codex*` 脚本继续可用于 Codex。是否可能嵌入 Claude 桌面版，需要独立侦查，不在本设计内。
- **不做双 provider 抽象**：本次是替换而非并存。依据仓库 `AGENTS.md` 第 2/4 条（最小直接改动、不做投机性扩展）；需要 Codex 后端时使用 upstream。
- **不改 Cloudflare / D1 命名**（`codex-taskboard-db`）：纯改名收益低，且会与已部署实例脱钩。

## 2. Codex → Claude Code 能力映射

全部在本机 `claude --help`、`~/.claude.json` 上实测确认。

| 用途 | Codex（现状） | Claude Code |
| --- | --- | --- |
| 单轮执行 + 结构化输出 | `codex exec --json … -` | `claude -p --output-format stream-json --input-format stream-json` |
| 续接会话 | `resume <thread-id>` | `--resume <session-id>` |
| 指定会话 ID | 不支持，须跑完回读 | **`--session-id <uuid>`（可预先指定）** |
| 模型 | `-m <model>` | `--model opus\|sonnet\|fable\|haiku` |
| 推理强度 | `-c model_reasoning_effort="…"` | `--effort <level>` |
| 审批策略 | `-c approvals_reviewer="…"` | `--permission-mode <mode>` + `--allowedTools` |
| 附加目录 | `--add-dir` | `--add-dir`（同名） |
| 增量输出 | JSONL 事件流 | `--include-partial-messages` |
| 本机项目列表 | `~/.codex/state.json` → `local-projects` | `~/.claude.json` → `projects`（key 为绝对路径） |
| Skill 枚举 | `codex app-server --stdio` | 文件系统扫描（见 §5.3） |
| 模型列表 | `codex debug models` | 静态别名表（见 §5.3） |
| 会话记录 | Codex 内部 | `~/.claude/projects/<slug>/<session-id>.jsonl` |

## 3. 会话归属机制（唯一需要新设计的部分）

`CODEX_THREAD_ID` 在 Claude Code 中没有等价环境变量。分两条路径，各自独立解决：

### 3.1 Claude Code → Taskboard（Skill 调 `taskctl`）

**方案：SessionStart hook 注入 session_id 作为 additionalContext。**

- Claude Code 的 SessionStart hook 收到含 `session_id` 的 payload，以 additionalContext 形式回传给模型
- Skill 据此在每次变更调用上带 `--thread-id <session-id>`
- `taskctl` 的 `resolveThreadId()` 已支持 `--thread-id`（`cli/taskctl.mjs:684`），仅需把 fallback 环境变量从 `CODEX_THREAD_ID` 改名

被否方案：

- 读 `~/.claude.json` 的 `projects[cwd].lastSessionId` — 并发会话会串号
- 要求用户手动传 — 不可靠

代价：使用者需安装一个 hook（走 `update-config` skill 落到 `settings.json`）。

### 3.2 Taskboard AI Chat → Claude Code（Taskboard 主动 spawn）

不需要 hook。Taskboard 自己生成 UUID，用 `--session-id <uuid>` 启动首轮、`--resume <uuid>` 续接。归属在源头确定，比 Codex「跑完回读 thread id」的现状更简单。

## 4. Skill 落位

- **不放 fork 仓库**，落 `sync-spells/skill-category/workflow/manage-taskboard/`，与 `task-run`、`jira-handoff` 同级（符合 `PROFILES.md` 中 Workflow 的定义：有序步骤 + 外部系统 + 任务交接）
- fork 仓库内上游那份 `skills/manage-taskboard/` **原样保留不改**，以降低与 upstream 的 diff；README 改为指向 sync-spells
- 内容改动：`CODEX_THREAD_ID` → §3.1 的 hook 机制；「Codex Agent」默认受理人改名；`Codex needs to…` 等描述改写
- 流程约束：创建必须先走 `superpowers:writing-skills`（RED→GREEN）；category 落位与 profile 归属交由 `sync-spells-maintainer`

## 5. 改动范围

### 5.1 命名与配置（机械替换，低风险）

| 项 | 现状 | 目标 |
| --- | --- | --- |
| 环境变量前缀 | `CODEX_TASKBOARD_*` | `TASKBOARD_*` |
| 包名 | `codex-taskboard` | `claude-taskboard` |
| CLI 名 | `taskctl` | 不变 |
| 默认受理人**显示名** | `Codex Agent` | `Claude Agent` |
| 受理人 **actor id / wire value** | `codex-agent` | **不变** |
| UI 资源 | `codex-agent-logo.png`、`codex-app-icon.png` | `agent-logo.png`、`app-icon.png`，图像取自 `@lobehub/icons-static-svg` 的 `claudecode-color.svg`（现有依赖，无需新增） |

`TASKBOARD_*` 而非 `CLAUDE_TASKBOARD_*`：`CLAUDE_*` 是 Claude Code 官方命名空间，避免占用。

`codex-agent` 这个 actor id 保持不变的理由：它是 wire value —— 出现在 `web/src/types.ts` 的 `AssigneeTarget` 类型、`server/app.mjs:543` 的请求校验、SQLite 既有行、`cloud/src/index.mjs:360` 的云端 actor 拼装，共约 30 处。改它需要同步改 API 契约、写数据迁移、动云端，与 §1 的最小改动原则冲突，收益仅为字面美观。与 §5.4 保持 SQLite 列名不变是同一取舍。

注入器内部的 `window.__CODEX_TASKBOARD_*` 全局变量同样不改（§5.5 注入器零改动）。服务端读取 env 的位置仅 `server/app.mjs:1272/1292/1300` 与 `cli/taskctl.mjs:190/309/780`；注入器通过 `spawn` 继承环境、不引用这些变量名（`scripts/codex-injector.mjs:121`），因此改名不会破坏它。

Web 层的 Codex 引用必须分成两类，只改第二类：

**A 类 — 嵌入层契约，一律不动**（与 `inject/codex-taskboard.user.js` 及注入器构成协议，按 §5.5 零改动）：

- `web/src/App.tsx` 全部 52 处（`inCodex`、`codexProjectId`、`host === "codex"`、`codex://threads/` 深链、自动化桥）
- `web/src/api.ts:269-276` 的 `codexProjectId` / `codexThreadId` query 参数、`web/src/types.ts:112` 的 `codexThreadId`
- `web/src/styles.css` 全部 17 处（`--codex-titlebar-left-inset`、`.codex-context`、`.codex-sidebar-expand-button`、`.codex-link-row`）

**B 类 — 面向用户的可见文案，需改写**：

- `web/index.html:9` meta description（`…with Codex` → `…with Claude Code`）
- `web/src/api.ts:77`「请重新通过 Taskboard 启动 Codex。」
- `web/src/components/TaskFilterMenu.tsx:60,61,192,193`「Codex 已处理」「尚未由 Codex 处理」「Codex 对话」
- `web/src/components/WorkflowInspector.tsx:812`「记录执行该议题的 Codex 对话」
- `web/src/components/ProjectAutomationMenu.tsx:202`「API Key 模式不支持读取 Codex App 额度」

B 类中「Codex 对话」一组语义上就是会话归属，**随 §5.2 一起改（P2 阶段）**，不放在 P1；其余 B 类文案属纯品牌层，放 P1。

其余涉及文件：`package.json`、`README.md`、`docs/cloud-collaboration.md`、`server/app.mjs`、`cli/taskctl.mjs`、`web/public/*`、`cloud/src/index.mjs`（仅显示名文案；D1 数据库名 `codex-taskboard-db` 与 `wrangler.jsonc` 按 §1 非目标保持不变）。

### 5.2 `taskctl` 会话归属

`cli/taskctl.mjs`（约 10 处 Codex 引用）：`resolveThreadId()` 的 env fallback 改名，错误文案改写。

### 5.3 AI Chat 后端（最大一块）

- `server/ai-chat-process.mjs`：`buildCodexArgs` → 按 §2 重建参数；`normalizeCodexEvent` → 解析 Claude stream-json 事件；`spawnCodexTurn` 的可执行文件与 JSONL 契约
- `server/ai-chat-catalog.mjs`：
  - `loadDeviceWorkspaces()`：读 `~/.claude.json` 的 `projects`（key 即绝对路径，无需像 Codex 那样解析 `local-projects` 结构）
  - `listSkills()`：**由 `codex app-server --stdio` 换成文件系统扫描** — `~/.claude/skills/*/SKILL.md`、项目 `.claude/skills/*/SKILL.md`、plugin skills；解析 frontmatter 的 `name` / `description`
  - 模型列表：`codex debug models` 换成静态别名表（`opus` / `sonnet` / `fable` / `haiku`）
- `server/ai-chat.mjs`：`codexExecutable` → `claudeExecutable`，图片类型集合沿用
- `server/app.mjs`：约 75 处引用，主要是配置与路由装配

### 5.4 数据库字段

`server/database.mjs` 中的 `codexThreadId` 等标识符改为中性名（`sessionId`）。**SQLite 列名保持不变**，避免为纯改名引入迁移；`taskctl` 对外字段本就叫 `threadId`，无需变更 API 契约。

### 5.5 明确不动

`scripts/codex-injector.mjs`、`scripts/codex-injector-runtime.mjs`、`inject/codex-taskboard.user.js`、`scripts/codex-rate-limits.mjs`、`wrangler.jsonc`、`cloud/migrations/*`。

> 注意：当前工作区在 `scripts/codex-injector.mjs`、`test/injector.test.mjs`、`package.json` 上有未提交改动（`--replace` 选项相关），与本适配无关。提交时只暂存本任务文件，不得 `git add -A`。

## 6. 实施阶段

按「最小可用闭环优先」排序，每阶段独立可验证：

| 阶段 | 内容 | 产出的可观察能力 |
| --- | --- | --- |
| **P1** | §5.1 命名与配置（env 前缀、包名、README/docs、agent 显示名与图标、B 类品牌文案） | 服务以 `TASKBOARD_*` 启动，UI 品牌层无 Codex 字样 |
| **P2** | §5.2 + §4 Skill + SessionStart hook + B 类归属文案 | **最小可用闭环**：Claude Code 会话中读写 issue，变更带正确 session 归属 |
| **P3** | §5.3 AI Chat 后端 | Taskboard 内 AI Chat 由 `claude` 驱动，流式输出正常 |
| **P4** | §5.3 项目发现 + §5.4 字段 | 项目下拉列表来自 `~/.claude.json` |

P2 是价值分水岭：完成后 Taskboard 已可日常使用，P3/P4 是增强。

## 7. 测试策略

**按全局 CLAUDE.md 的强制 TDD 执行（先测后码）**，覆盖既有测试文件：

- `test/ai-chat-runner.test.mjs`：Claude 参数构造、stream-json 事件归一化
- `test/ai-chat-database.test.mjs`、`test/ai-chat-server.test.mjs`、`test/ai-chat-state.test.mjs`、`test/ai-chat-ui.test.mjs`
- `test/server.test.mjs`：env 前缀、装配
- `test/cloud-companion.test.mjs`：命名
- 新增：`~/.claude.json` 项目解析、skills 文件系统扫描

规则冲突处理：仓库 `AGENTS.md` 第 11 条声明「取代 test-first」。本次改动全部落在已有测试覆盖的既有行为上，扩测成本极低，不构成该条担心的「测试盖过功能」。**fork 后同步修订 `AGENTS.md` 第 11 条**，消除与全局规则的歧义。

验收命令：`npm run check`（typecheck + 前端生产构建 + 测试套件）。

## 8. 风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| Claude stream-json 事件结构与 Codex JSONL 差异大 | P3 改动量超预期 | 先写事件归一化测试，用真实 `claude -p` 输出做 fixture |
| `--effort` / `--permission-mode` 取值集合与 UI 现有选项不匹配 | AI Chat 设置项需重做 | P3 开始前用一次真实调用确认取值 |
| SessionStart hook 的 additionalContext 未被模型可靠使用 | 归属丢失 | P2 验证时以真实会话确认 `--thread-id` 落库 |
| upstream 后续更新与改名冲突 | 合并成本 | 改名集中在少数文件；注入器保持零改动以隔离主要冲突面 |
