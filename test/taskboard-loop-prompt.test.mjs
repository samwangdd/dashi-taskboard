import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTaskboardAutomationPrompt } from "../shared/taskboard-automation.mjs";
import {
  TASKBOARD_BASE_INSTRUCTIONS,
  buildTaskboardLoopPrompt,
  isAbsoluteWorkspacePath,
} from "../shared/taskboard-loop-prompt.mjs";
import {
  DEFAULT_CODING_WORKFLOW_CONFIG,
  codingWorkflowAutomationInstructions,
  codingWorkflowLoopInstructions,
} from "../shared/coding-workflow.mjs";

const LOOP_INPUT = {
  intervalMinutes: 60,
  projectName: "sync-spells",
  taskboardProjectId: "3b617e90-8ce2-4b79-82e3-81f29c437d0b",
  workspacePath: "/Users/sammore/codeLab/sync-spells",
  skillPath: "/Users/sammore/skills/manage-taskboard/SKILL.md",
};

const AUTOMATION_REQUEST = {
  ...LOOP_INPUT,
  id: "taskboard",
  action: "automation",
  requestId: "req-1",
  operation: "ensure-active",
  codexProjectId: "codex-project",
  enabledByUser: true,
  quotaAware: false,
  model: "gpt-5.5",
  reasoningEffort: "high",
};

test("the loop prompt keeps the shared taskboard instructions verbatim", () => {
  const prompt = buildTaskboardLoopPrompt(LOOP_INPUT);
  const lines = prompt.split("\n");

  assert.equal(
    lines[0],
    `[$manage-taskboard](${LOOP_INPUT.skillPath}) e-taskboard 每 60 分钟检查任务面板中的「sync-spells」项目（项目 ID：${LOOP_INPUT.taskboardProjectId}，项目目录：${LOOP_INPUT.workspacePath}）。`,
  );
  for (const instruction of TASKBOARD_BASE_INSTRUCTIONS) {
    assert.ok(
      lines.includes(instruction),
      `loop prompt is missing the shared instruction: ${instruction}`,
    );
  }
  assert.ok(prompt.includes("每次仅处理一个符合依赖条件的 todo"));
  assert.ok(prompt.includes("不要直接标记为 done"));
});

test("the loop prompt claims todo by status and visibly yields claimed work", () => {
  const prompt = buildTaskboardLoopPrompt(LOOP_INPUT);

  assert.ok(prompt.includes("A todo remains claimable even when threadId has a value"));
  assert.ok(prompt.includes("continue only when its threadId belongs to the current session"));
  assert.ok(prompt.includes("emit a visible report instead of ending silently"));
  assert.doesNotMatch(prompt, /send_message_to_thread/);
});

test("the loop prompt honours the requested interval", () => {
  for (const intervalMinutes of [5, 10, 15, 30, 60]) {
    const prompt = buildTaskboardLoopPrompt({ ...LOOP_INPUT, intervalMinutes });
    assert.ok(
      prompt.includes(`每 ${intervalMinutes} 分钟检查任务面板`),
      `loop prompt should state the ${intervalMinutes} minute interval`,
    );
  }
});

test("the loop prompt never leaks codex model slugs", () => {
  const prompt = buildTaskboardLoopPrompt(LOOP_INPUT);

  assert.doesNotMatch(prompt, /gpt-/);
  for (const slug of Object.values(DEFAULT_CODING_WORKFLOW_CONFIG)) {
    if (typeof slug !== "string") continue;
    assert.ok(!prompt.includes(slug), `loop prompt should not name the model ${slug}`);
  }
  assert.ok(prompt.includes("configSnapshot.orchestratorModel"));
  assert.ok(prompt.includes("run.configSnapshot"));
});

test("the loop prompt rounds follow the project coding config", () => {
  const prompt = buildTaskboardLoopPrompt({
    ...LOOP_INPUT,
    codingConfig: { standardRounds: 2, escalationRounds: 3 },
  });

  assert.ok(prompt.includes("默认前 2 轮使用标准模型，仍失败时最多再派发 3 轮升级模型"));
  assert.ok(!prompt.includes("前 3 轮"));
});

test("the loop prompt falls back to the default coding config", () => {
  const prompt = buildTaskboardLoopPrompt(LOOP_INPUT);

  assert.ok(prompt.includes(
    `默认前 ${DEFAULT_CODING_WORKFLOW_CONFIG.standardRounds} 轮使用标准模型`,
  ));
  assert.ok(prompt.includes(
    `最多再派发 ${DEFAULT_CODING_WORKFLOW_CONFIG.escalationRounds} 轮升级模型`,
  ));
});

test("the gate and the builder agree on what an absolute directory is", () => {
  for (const value of ["/Users/sammore/codeLab", "/"]) {
    assert.equal(isAbsoluteWorkspacePath(value), true, `${value} should be absolute`);
  }
  for (const value of ["", "  ", "codeLab/sync-spells", "./sync-spells", "~/codeLab", undefined]) {
    assert.equal(isAbsoluteWorkspacePath(value), false, `${String(value)} should not be absolute`);
    assert.throws(
      () => buildTaskboardLoopPrompt({ ...LOOP_INPUT, workspacePath: value }),
      TypeError,
      `the builder should reject the same value the gate rejects: ${String(value)}`,
    );
  }
});

test("the loop prompt rejects an incomplete context", () => {
  for (const missing of ["projectName", "taskboardProjectId", "workspacePath", "skillPath"]) {
    assert.throws(
      () => buildTaskboardLoopPrompt({ ...LOOP_INPUT, [missing]: undefined }),
      TypeError,
      `buildTaskboardLoopPrompt should reject a missing ${missing}`,
    );
  }
  assert.throws(
    () => buildTaskboardLoopPrompt({ ...LOOP_INPUT, intervalMinutes: 7 }),
    TypeError,
  );
});

test("the coding loop instructions drop model names but keep the protocol steps", () => {
  const loop = codingWorkflowLoopInstructions();
  const automation = codingWorkflowAutomationInstructions();

  assert.equal(loop.split("\n").length, automation.split("\n").length);
  assert.doesNotMatch(loop, /gpt-/);
  for (const step of [
    "2. 在实现前冻结 verification contract",
    "4. implementer 必须通过 taskctl coding check",
    "6. 每次角色切换前用 taskctl coding handoff 写入 handoff",
    "7. 所有验证项通过后调用 taskctl coding commit",
    "8. 达到最大轮次仍失败时",
    "9. 中间轮次只写 coding run artifact",
  ]) {
    assert.ok(loop.includes(step), `coding loop instructions should keep step: ${step}`);
  }
  assert.ok(loop.includes("默认非 UI 使用标准 verifier 模型，UI 使用 UI verifier 模型"));
});

test("the automation and copyable loop keep the shared instructions verbatim", () => {
  const shared = TASKBOARD_BASE_INSTRUCTIONS.join("\n");
  const automation = buildTaskboardAutomationPrompt(AUTOMATION_REQUEST);
  const loop = buildTaskboardLoopPrompt(LOOP_INPUT);

  assert.ok(automation.includes(shared));
  assert.ok(loop.includes(shared));
  assert.ok(automation.includes("本轮所有 taskctl 操作都使用完整命令前缀"));
  assert.ok(automation.includes(codingWorkflowAutomationInstructions()));
});

test("the automation prompt keeps naming models while the loop prompt does not", () => {
  const automation = buildTaskboardAutomationPrompt(AUTOMATION_REQUEST);

  assert.ok(automation.includes(DEFAULT_CODING_WORKFLOW_CONFIG.orchestratorModel));
  assert.ok(!buildTaskboardLoopPrompt(LOOP_INPUT).includes(
    DEFAULT_CODING_WORKFLOW_CONFIG.orchestratorModel,
  ));
});
