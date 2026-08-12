import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const menuSource = await readFile(
  new URL("../web/src/components/CopyLoopPromptMenu.tsx", import.meta.url),
  "utf8",
);
const automationMenuSource = await readFile(
  new URL("../web/src/components/ProjectAutomationMenu.tsx", import.meta.url),
  "utf8",
);
const anchorSource = await readFile(
  new URL("../web/src/components/usePopoverAnchor.ts", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("the copy trigger sits right of the automation trigger and left of the create button", () => {
  assert.match(
    appSource,
    /<ProjectAutomationMenu[\s\S]*?<CopyLoopPromptMenu[\s\S]*?header-create-button/,
  );
  assert.match(appSource, /<CopyLoopPromptMenu/);
});

test("the copy trigger reuses the automation capsule with the Linear copy icon", () => {
  assert.match(menuSource, /className="copy-loop-prompt-trigger no-drag"/);
  assert.match(menuSource, /<LinearIcon name="copy" \/>/);
  assert.match(menuSource, /复制 loop prompt/);
  assert.match(menuSource, /aria-haspopup="dialog"/);
  assert.match(menuSource, /aria-expanded=\{open\}/);
  assert.match(menuSource, /createPortal/);
  assert.match(styles, /\.project-automation-trigger,\s*\n\.copy-loop-prompt-trigger \{/);
  assert.match(styles, /\.copy-loop-prompt-trigger > svg/);
});

test("the copy menu only offers the interval, never a model or effort", () => {
  assert.match(menuSource, /\[5, 10, 15, 30, 60\]/);
  assert.match(menuSource, /<span>间隔<\/span>/);
  assert.doesNotMatch(menuSource, /AUTOMATION_MODELS|EFFORT_LABELS|reasoningEffort/);
  assert.doesNotMatch(menuSource, /CODING_WORKFLOW_MODELS/);
  assert.doesNotMatch(menuSource, /orchestratorModel|verifierModel|implementerModel/);
});

test("the chosen interval is persisted per project on this device", () => {
  assert.match(menuSource, /const LOOP_PROMPT_INTERVAL_KEY = "taskboard\.loopPromptInterval\.v1"/);
  assert.match(menuSource, /const DEFAULT_LOOP_INTERVAL_MINUTES = 60/);
  assert.match(menuSource, /localStorage\.getItem\(LOOP_PROMPT_INTERVAL_KEY\)/);
  assert.match(menuSource, /localStorage\.setItem\(LOOP_PROMPT_INTERVAL_KEY, JSON\.stringify\(next\)\)/);
  assert.match(menuSource, /INTERVAL_MINUTES_OPTIONS\.includes/);
  assert.match(menuSource, /catch \{/);
});

test("the copy menu builds the prompt through the shared loop builder", () => {
  assert.match(menuSource, /buildTaskboardLoopPrompt/);
  assert.match(menuSource, /from "\.\.\/\.\.\/\.\.\/shared\/taskboard-automation\.mjs"/);
  assert.doesNotMatch(menuSource, /e-taskboard 每/);
  assert.doesNotMatch(menuSource, /每次仅处理一个 todo/);
});

test("the copy menu is gated on the skill path and workspace path only", () => {
  assert.match(menuSource, /任务面板还没有读取到 Skill 路径/);
  assert.match(menuSource, /请先在项目设置里填写项目目录/);
  assert.doesNotMatch(menuSource, /codexProjectId|仅可在 Codex App 中使用|embedded/);
  assert.match(menuSource, /const unavailableReason =/);
  assert.match(menuSource, /disabled=\{Boolean\(unavailableReason\)\}/);
});

test("copying closes the popover, restores focus, and announces through the app toast", () => {
  assert.match(menuSource, /onCopy: \(prompt: string\) => void/);
  assert.match(menuSource, /onCopy\(/);
  assert.match(menuSource, /setOpen\(false\)/);
  assert.match(menuSource, /triggerRef\.current\?\.focus\(\)/);
  assert.match(appSource, /<CopyLoopPromptMenu[\s\S]*?onCopy=\{[\s\S]*?copyText\(/);
  assert.match(appSource, /loop prompt 已复制/);
});

test("the copy menu passes the live coding config so the rounds match the board", () => {
  assert.match(menuSource, /codingConfig/);
  assert.match(appSource, /<CopyLoopPromptMenu[\s\S]*?codingConfig=\{codingWorkflowSettings\?\.config/);
});

test("both popovers share one anchor hook instead of duplicating the listeners", () => {
  assert.match(anchorSource, /export function usePopoverAnchor/);
  assert.match(anchorSource, /getBoundingClientRect/);
  assert.match(anchorSource, /document\.addEventListener\("pointerdown", closeFromOutside\)/);
  assert.match(anchorSource, /event\.key === "Escape"/);
  assert.match(anchorSource, /window\.addEventListener\("resize"/);
  assert.match(anchorSource, /window\.addEventListener\("scroll", closeFromViewportChange, true\)/);
  assert.match(anchorSource, /useLayoutEffect/);
  assert.doesNotMatch(anchorSource, /event\.key === "Tab"/);

  for (const source of [menuSource, automationMenuSource]) {
    assert.match(source, /usePopoverAnchor/);
    assert.doesNotMatch(source, /window\.addEventListener\("resize"/);
    assert.doesNotMatch(source, /getBoundingClientRect/);
  }
});
