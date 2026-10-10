import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const boardColumnSource = await readFile(new URL("../web/src/components/BoardColumn.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const labelPickerSource = await readFile(new URL("../web/src/components/LabelPicker.tsx", import.meta.url), "utf8");
const contextMenuSource = await readFile(new URL("../web/src/components/TaskContextMenu.tsx", import.meta.url), "utf8");
const cardSource = await readFile(new URL("../web/src/components/TaskCard.tsx", import.meta.url), "utf8");
const filterSource = await readFile(new URL("../web/src/taskFilters.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
const composerSource = await readFile(new URL("../web/src/components/InlineMediaComposer.tsx", import.meta.url), "utf8");

function taskStatuses() {
  const match = typesSource.match(/export const TASK_STATUSES = (\[[\s\S]*?\]) as const/);
  assert.ok(match);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

test("text selection is reserved for editable fields", () => {
  assert.match(styles, /body \{[^}]*user-select: none/);
  assert.match(styles, /input,[\s\S]*?textarea,[\s\S]*?\[contenteditable="true"\][\s\S]*?user-select: text/);
});

test("native select options remain readable in dark theme", () => {
  assert.match(styles, /:root\[data-theme="dark"\] select \{[\s\S]*?color-scheme: dark/);
  assert.match(styles, /:root\[data-theme="dark"\] select option \{[\s\S]*?background-color: var\(--surface-raised\);[\s\S]*?color: var\(--text-primary\)/);
  assert.match(styles, /:root\[data-theme="dark"\] select option:checked \{[\s\S]*?background-color: var\(--surface-active\)/);
});

test("the complete issue status set shares one ordered source", () => {
  assert.deepEqual(taskStatuses(), [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
    "canceled",
  ]);
  assert.match(boardColumnSource, /backlog: \{ label: "待立项", tone: "backlog" \}/);
  assert.match(boardColumnSource, /todo: \{ label: "等待认领", tone: "todo" \}/);
  assert.match(boardColumnSource, /in_progress: \{ label: "处理中", tone: "progress" \}/);
  assert.match(boardColumnSource, /in_review: \{ label: "等你确认", tone: "review" \}/);
  assert.match(boardColumnSource, /blocked: \{ label: "遇到阻碍", tone: "blocked" \}/);
  assert.match(boardColumnSource, /done: \{ label: "完成", tone: "done" \}/);
  assert.match(boardColumnSource, /canceled: \{ label: "取消", tone: "canceled" \}/);
  assert.doesNotMatch(cardSource, /STATUS_ORDER/);
  assert.match(detailSource, /TASK_STATUSES\.map\(\(status\) =>/);
  assert.match(editorSource, /TASK_STATUSES\.map\(\(value\) =>/);
  assert.match(contextMenuSource, /TASK_STATUSES\.map\(\(status, index\) =>/);
});

test("review, blocked and canceled statuses round-trip through filter URLs", () => {
  const statuses = taskStatuses();
  const selected = ["in_review", "blocked", "canceled"];
  const url = new URL("http://taskboard.local/");
  url.searchParams.set("status", selected.join(","));
  const restored = url.searchParams.get("status").split(",").filter((status) => statuses.includes(status));

  assert.deepEqual(restored, selected);
  assert.match(filterSource, /filters\.statuses\.join\(","\)/);
  assert.match(filterSource, /\.split\(","\)\.filter\(isTaskStatus\)/);
  assert.match(filterSource, /TASK_STATUSES\.includes\(value as TaskStatus\)/);
});

test("common issue mutations enter a Linear-style undo queue", () => {
  assert.match(appSource, /const undoStackRef = useRef<UndoOperation\[]>/);
  assert.match(appSource, /event\.key\.toLowerCase\(\) === "z"/);
  assert.match(appSource, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(appSource, /function pushUndo/);
  assert.match(appSource, /function performUndo[\s\S]*?await operation\.undo\(\)/);
  assert.match(appSource, /void performUndo\(\)/);
  assert.match(appSource, /moveTask\(task, destination, beforeTaskId, true\)/);
  assert.match(appSource, /className="toast undo-toast"/);
  assert.match(appSource, />\s*\{text\("撤回", "Undo"\)\} <kbd>\{undoShortcut\}<\/kbd>/);
  assert.match(appSource, /restoreTaskRequest\(archived\)/);
  assert.match(apiSource, /export async function restoreTask/);
});

test("issues expose processing conversations without manual binding", () => {
  assert.match(detailSource, /onOpenInHarness\(currentTask, harness\)/);
  assert.match(detailSource, /AGENT_HARNESSES\.map/);
  assert.doesNotMatch(appSource, /detail-thread-button/);
  assert.doesNotMatch(detailSource, /输入对话 ID|解除 Codex 对话绑定|>绑定</);
  assert.doesNotMatch(editorSource, /对话 ID|linkedThreadId/);
  assert.match(detailSource, /currentTask\.threadBinding \|\| currentTask\.legacyLocalThreadId/);
  assert.doesNotMatch(detailSource, /currentTask\.threadIds/);
  assert.match(detailSource, /agentKind=\{comment\.authorAgentKind\}/);
  assert.match(detailSource, /agentKind=\{currentTask\.threadAgentKind\}/);
  assert.match(detailSource, /const threadAgentChanged = currentTask\.threadAgentKind !== task\.threadAgentKind/);
  assert.match(detailSource, /resumeCommandForAgent\(agentKind, threadId\)/);
  assert.match(detailSource, /const canOpenConversation = canOpenConversationInAgent\(agentKind\)/);
  assert.match(detailSource, /comment\.authorAgentKind === "claude-code"[\s\S]*?onOpenInHarness\(currentTask, "claude-desktop", threadId\)/);
  assert.match(appSource, /getClaudeDesktopSession\(conversationId\)/);
  assert.match(appSource, /claudeDesktopConversationUrl\(resolvedConversationId\)/);
  assert.match(appSource, /conversationId: resolvedConversationId/);
  assert.doesNotMatch(appSource, /Kiro CLI in Orca requires a local project workspace/);
  assert.match(detailSource, /className="detail-harness-menu-trigger"/);
  assert.match(detailSource, /<HarnessChevron \/>/);
  assert.doesNotMatch(detailSource, /className="conversation-thread-id">\{threadId\}/);
  assert.doesNotMatch(detailSource, /shortThreadId/);
  assert.doesNotMatch(detailSource, /detail-property-label">Codex/);
  assert.match(detailSource, /comment\.threadBinding \|\| comment\.legacyLocalThreadId/);
  assert.match(detailSource, /onOpenLegacyLocalThread\(comment\.legacyLocalThreadId!\)/);
  assert.doesNotMatch(detailSource, /compact/);
  assert.doesNotMatch(styles, /issue-conversation-link\.compact/);
  assert.match(detailSource, /\.\.\.developmentOptions\.map\(\(context\) => \(\{/);
  assert.match(detailSource, /context\.type === "branch"[\s\S]*?<BranchIcon[\s\S]*?<LinearIcon name="folder"/);
  assert.match(detailSource, /developmentContext/);
  assert.doesNotMatch(detailSource, /placeholder="绑定分支/);
  assert.doesNotMatch(contextMenuSource, /打开关联 Codex 对话/);
  assert.match(contextMenuSource, /onOpenInThread/);
});

test("issue creation and detail share one searchable, creatable label picker", () => {
  assert.match(editorSource, /<LabelPicker/);
  assert.match(detailSource, /<LabelPicker/);
  assert.match(appSource, /<TaskDetail[\s\S]*?availableLabels=\{availableLabels\}/);
  assert.match(detailSource, /selectedLabels=\{currentTask\.labels\}/);
  assert.match(detailSource, /saveTask\(\{ labels: nextLabels \}, "labels"\)/);
  assert.doesNotMatch(detailSource, /标签，以逗号分隔|function saveLabels|labels\.split/);
  assert.match(labelPickerSource, /availableLabels\.filter/);
  assert.match(labelPickerSource, /selectedLabels\.includes\(label\)/);
  assert.match(labelPickerSource, /text\(`创建 “\$\{normalizedSearch\}”`, `Create “\$\{normalizedSearch\}”`\)/);
  assert.match(labelPickerSource, /labelPresentation\(normalizedSearch, language\)\.color/);
  assert.match(labelPickerSource, /aria-multiselectable="true"/);
  assert.match(styles, /\.detail-label-picker \.label-popover/);
});
