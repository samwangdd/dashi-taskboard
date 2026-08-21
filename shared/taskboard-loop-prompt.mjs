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
  "When workflowId is null, use the full description and comments to judge whether the issue has explicit code implementation requirements; this judgment may only produce a suggestion and must not use title keywords. If it does, skip the issue and report a workflow configuration error that recommends taskctl coding claim; you must not silently change workflowId or continue through ordinary delivery.",
  "确认允许开始后，必须在读取代码、下载附件、分析或实施前，使用刚读取的 version 将仍可认领的 todo 移到 in_progress；写入成功前不得继续。不得认领已被其他会话绑定或其他 Agent 领取的议题。",
  "若因 version 陈旧发生版本冲突，重新运行 issue get 和 comment list；仅当仍为可认领 todo、未绑定其他会话、未归档且描述和最新评论未变化时，用最新 version 重试一次。若已被认领、状态或要求已变、已归档、服务或永久 API 错误，或重试仍失败，立即跳过该议题、退出并报告；不得抢占或循环重试。",
  "若首次 issue get 返回 threadId，议题已绑定原会话：不要在当前自动化会话认领；使用 Codex send_message_to_thread 向原会话发送继续处理指令，由原会话按上述协议判断和认领，然后结束当前自动化会话。若没有 threadId，则在当前自动化会话处理。",
  "若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。",
  "执行完成并验证后，先用 comment add 记录关键改动、验证结果、执行结果和剩余风险，再使用最新 version 将议题移动到 in_review；不要直接标记为 done。",
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
