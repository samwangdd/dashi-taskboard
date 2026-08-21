import { codingWorkflowLoopInstructions } from "./coding-workflow.mjs";

/**
 * The browser bundles this module, so it must stay free of node builtins: vite
 * externalizes `node:*` rather than failing the build, which turns a missing
 * builtin into a runtime throw the moment someone clicks copy.
 */

const LOOP_INTERVAL_MINUTES = new Set([5, 10, 15, 30, 60]);

/**
 * Delivery rules shared by the Codex automation prompt and the copyable loop
 * prompt. Only the opening line (which carries the interval and project) and the
 * coding protocol differ between the two, so everything else lives here once.
 */
export const TASKBOARD_BASE_INSTRUCTIONS = Object.freeze([
  "从返回的 todo 中只选择依赖已完成的议题：relations.blockedBy 为空，或其中每个依赖的 status 都严格等于 done。无依赖的 todo 仍可并行处理。若有 todo 但全部被未完成依赖阻塞，本轮直接结束，不暂停自动化，也不创建或打开新的任务会话。",
  "每次仅处理一个符合依赖条件的 todo：选定后先用 issue get 读取最新议题内容，并用 comment list 读取全部评论。根据描述和最新评论判断是否允许开始；若其中写明等待、暂不执行或当前不应开始，立即跳过并报告，不改状态。评论也包含已完成后被打回的返工要求。",
  "完成 issue get 和 comment list 后、移动状态前，必须再次运行 issue get，并复核 relations.blockedBy 仍为空或其中每个依赖的 status 都严格等于 done。若依赖条件不再满足，立即跳过并结束本轮，不改状态，也不暂停自动化。",
  "确认允许开始后，必须在读取代码、下载附件、分析或实施前，使用刚读取的 version 将 todo 移到 in_progress。todo 即使 threadId 有值仍可认领，因为 threadId 只记录最近一次修改议题的会话，不是占用锁。写入成功前不得继续，且不得认领 status 不是 todo 的议题。",
  "若移动状态时因 version 陈旧发生冲突，重新运行 issue get 和 comment list；仅当议题仍为可认领的 todo、未归档且描述和最新评论未变化时，使用最新 version 重试一次。若议题已被认领、状态或要求已变化、已归档、服务或 API 发生永久错误，或重试仍失败，立即跳过、退出并报告；不得抢占或循环重试。",
  "issue get 后必须用 status 判断占用状态。todo 无论历史 threadId 是否有值都可认领。若议题已是 in_progress，仅当 threadId 属于当前会话时才可继续；否则保持不变、让路给所属会话并输出可见报告，不得静默结束。不得依赖任何宿主专有的跨会话投递能力。",
  "若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。",
  "执行完成并验证后，先用 comment add 记录关键改动、验证结果、执行结果和剩余风险，再使用最新 version 将议题移动到 in_review；不要直接标记为 done。",
  "凡涉及 UI verified，必须在 issue comments 中附上实现截图。",
  "每次运行结束时，简洁汇报本次是否成功认领、处理的议题 ID、最终状态，以及因版本冲突、状态变化、没有 todo 或其他原因而跳过的情况。",
  "先检查议题 workflowId；只有非 coding 议题才执行上一条普通交付规则。",
]);

/**
 * The rule the copy button gates on, exported so the gate and the builder can
 * never drift: whatever the gate lets through, the builder accepts. Device
 * workspace paths are hand-typed, so a relative path is a realistic input.
 */
export function isAbsoluteWorkspacePath(value) {
  return typeof value === "string"
    && value.trim() === value
    && value.startsWith("/")
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function buildTaskboardLoopPromptOpening(request) {
  return `[$manage-taskboard](${request.skillPath}) e-taskboard 每 ${request.intervalMinutes} 分钟检查任务面板中的「${request.projectName}」项目（项目 ID：${request.taskboardProjectId}，项目目录：${request.workspacePath}）。`;
}

/**
 * The prompt behind the "复制 loop prompt" button: same delivery rules as the
 * Codex automation, but vendor-neutral so it can be pasted into any agent. Unlike
 * the automation path it follows the project's saved coding config.
 */
export function buildTaskboardLoopPrompt(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Loop prompt input must be an object");
  }
  if (!LOOP_INTERVAL_MINUTES.has(input.intervalMinutes)) {
    throw new TypeError(`Unsupported loop prompt interval: ${input.intervalMinutes}`);
  }
  for (const field of ["projectName", "taskboardProjectId"]) {
    const value = input[field];
    if (
      typeof value !== "string"
      || value.trim() !== value
      || value.length === 0
      || value.length > 256
    ) {
      throw new TypeError(`Loop prompt input is missing ${field}`);
    }
  }
  for (const field of ["workspacePath", "skillPath"]) {
    if (!isAbsoluteWorkspacePath(input[field])) {
      throw new TypeError(`Loop prompt input is missing an absolute ${field}`);
    }
  }

  return [
    buildTaskboardLoopPromptOpening(input),
    ...TASKBOARD_BASE_INSTRUCTIONS,
    codingWorkflowLoopInstructions(input.codingConfig),
  ].join("\n");
}
