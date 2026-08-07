import { AUTOMATION_MODELS } from "./taskboard-automation-options.mjs";

export const CODING_WORKFLOW_ID = "coding";
export const CODING_WORKFLOW_NAME = "Coding";
export const CODING_WORKFLOW_MODELS = Object.freeze([
  ...AUTOMATION_MODELS.map(({ label, slug }) => ({ label, slug })),
  { label: "Codex Spark", slug: "gpt-5.3-codex-spark" },
]);

const CODING_MODEL_SLUGS = new Set(CODING_WORKFLOW_MODELS.map((model) => model.slug));

export const DEFAULT_CODING_WORKFLOW_CONFIG = Object.freeze({
  orchestratorModel: "gpt-5.6-terra",
  implementerModel: "gpt-5.3-codex-spark",
  verifierModel: "gpt-5.6-terra",
  uiVerifierModel: "gpt-5.6-luna",
  escalationImplementerModel: "gpt-5.6-terra",
  standardRounds: 3,
  escalationRounds: 1,
});

const CONFIG_MODEL_FIELDS = [
  "orchestratorModel",
  "implementerModel",
  "verifierModel",
  "uiVerifierModel",
  "escalationImplementerModel",
];

export function normalizeCodingWorkflowConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Coding workflow config must be an object");
  }
  const unknownField = Object.keys(value).find((field) => (
    !CONFIG_MODEL_FIELDS.includes(field)
    && field !== "standardRounds"
    && field !== "escalationRounds"
  ));
  if (unknownField) throw new TypeError(`Unknown coding workflow config field: ${unknownField}`);

  const config = { ...DEFAULT_CODING_WORKFLOW_CONFIG, ...value };
  for (const field of CONFIG_MODEL_FIELDS) {
    if (!CODING_MODEL_SLUGS.has(config[field])) {
      throw new TypeError(`Unsupported coding workflow model for ${field}: ${config[field]}`);
    }
  }
  if (!Number.isInteger(config.standardRounds) || config.standardRounds < 1 || config.standardRounds > 10) {
    throw new TypeError("standardRounds must be an integer from 1 to 10");
  }
  if (!Number.isInteger(config.escalationRounds) || config.escalationRounds < 1 || config.escalationRounds > 3) {
    throw new TypeError("escalationRounds must be an integer from 1 to 3");
  }
  return config;
}

export function implementerModelForRound(config, round) {
  const normalized = normalizeCodingWorkflowConfig(config);
  return round <= normalized.standardRounds
    ? normalized.implementerModel
    : normalized.escalationImplementerModel;
}

export function maximumImplementationRounds(config) {
  const normalized = normalizeCodingWorkflowConfig(config);
  return normalized.standardRounds + normalized.escalationRounds;
}

export function codingWorkflowAutomationInstructions(configValue) {
  const config = normalizeCodingWorkflowConfig(configValue);
  return [
    "当 todo 议题的 workflowId 为 coding 时，使用内置 Coding 协议，不走普通议题交付路径：",
    `1. 认领到 in_progress 后读取 Taskboard 自动创建的 coding run，并按 configSnapshot.orchestratorModel 派发 orchestrator（默认 ${config.orchestratorModel}）。`,
    "2. 在实现前冻结 verification contract。contract 只能包含任务验收、工作流配置和仓库已有的局部检查；变更 contract 必须产生新版本。",
    `3. 按 run.configSnapshot 派发 implementer；默认前 ${config.standardRounds} 轮使用 ${config.implementerModel}，仍失败时最多再派发 ${config.escalationRounds} 轮 ${config.escalationImplementerModel}。`,
    "4. implementer 必须通过 taskctl coding check 运行 unit、integration 和 contract 明确要求的 typecheck；命令必须使用 {files}，禁止全量测试、全量 typecheck 和全量 build。",
    `5. verifier 模型取 run.configSnapshot；默认非 UI 使用 ${config.verifierModel}，UI 使用 ${config.uiVerifierModel}。verifier 读取引擎证据，不重复运行 implementer 已跑的命令。`,
    "6. 每次角色切换前用 taskctl coding handoff 写入 handoff；正文遵循 handoff skill 的 objective、references、next action、suggested skills 结构。失败 verdict 由引擎持久化并返回下一 implementer 模型；不要额外调用 orchestrator 充当传话人。",
    "7. 所有验证项通过后调用 taskctl coding commit。Taskboard 只提交本轮记录文件并自动将议题移到 in_review；不要再次询问是否 commit，不 push，不创建 PR。",
    "8. 达到最大轮次仍失败时，Taskboard 自动将议题移到 blocked。零改动通过时不创建空 commit，直接进入 in_review。",
    "9. 中间轮次只写 coding run artifact；仅进入 in_review 或 blocked 时添加用户可见总结。用户打回后恢复同一 run 并追加新 commit。",
  ].join("\n");
}
