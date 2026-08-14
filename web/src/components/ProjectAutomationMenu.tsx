import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AUTOMATION_MODELS,
  getAutomationModel,
  withAutomationModel,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../../shared/taskboard-automation-options.mjs";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";
import {
  CODING_WORKFLOW_MODELS,
  DEFAULT_CODING_WORKFLOW_CONFIG,
} from "../../../shared/coding-workflow.mjs";
import type { CodingWorkflowSettings, WorkflowOption } from "../types";
import { usePopoverAnchor } from "./usePopoverAnchor";

type AutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type IntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: IntervalMinutes;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
  quota?: {
    state: AutomationQuotaState;
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key";
  };
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationState>;
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  codingSettings: CodingWorkflowSettings | null;
  codingPending: boolean;
  codingError: string | null;
  workflows: WorkflowOption[];
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
  onCodingChange: (
    changes: Pick<CodingWorkflowSettings, "defaultWorkflowId" | "config">,
  ) => void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
};

const EFFORT_LABELS: Record<AutomationReasoningEffort, readonly [string, string]> = {
  low: ["轻度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高 (xhigh)", "Extra high (xhigh)"],
  max: ["最高", "Maximum"],
  ultra: ["极高 (ultra)", "Ultra"],
};

export function ProjectAutomationMenu({
  automation,
  pending,
  error,
  unavailableReason,
  codingSettings,
  codingPending,
  codingError,
  workflows,
  onOpen,
  onChange,
  onCodingChange,
}: ProjectAutomationMenuProps) {
  const { locale, text } = useTaskboardI18n();
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const closeMenu = useCallback(() => setOpen(false), []);
  const { triggerRef, menuRef, position, resetPosition } = usePopoverAnchor(open, closeMenu);
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const [codingDraft, setCodingDraft] = useState(() => ({
    defaultWorkflowId: null as string | null,
    config: { ...DEFAULT_CODING_WORKFLOW_CONFIG },
  }));
  const status = automation?.status ?? "PAUSED";
  const quota = automation?.quota;
  const stateLabel = !automation?.enabledByUser
    ? text("已暂停", "Paused")
    : automation.quotaAware && quota?.state === "blocked"
      ? text("额度暂停", "Paused by quota")
      : automation.quotaAware && quota?.state === "unavailable"
        ? text("额度不可用", "Quota unavailable")
        : automation.quotaAware && (!quota || quota.state === "unknown")
          ? text("额度未知", "Quota unknown")
          : status === "ACTIVE"
            ? text("运行中", "Running")
            : text("已暂停", "Paused");
  const disabled = pending || Boolean(unavailableReason);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...DEFAULT_OPTIONS, ...automation });
    setCodingDraft({
      defaultWorkflowId: codingSettings?.defaultWorkflowId ?? null,
      config: { ...DEFAULT_CODING_WORKFLOW_CONFIG, ...codingSettings?.config },
    });
  }, [codingSettings, open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft({ ...DEFAULT_OPTIONS, ...automation });
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    setDraft(next);
    onChange(next);
  };

  const submitCodingChange = (next: typeof codingDraft) => {
    if (codingPending || !codingSettings) return;
    setCodingDraft(next);
    onCodingChange(next);
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={text("自动认领待办设置", "Auto-claim settings")}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>{text("自动认领待办", "Auto-claim tasks")}</strong>
        <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
          {stateLabel}
        </span>
      </div>
      <div className="project-automation-switch">
        <span>{text("自动认领开关", "Auto-claim")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.enabledByUser}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            enabledByUser: !draft.enabledByUser,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="project-automation-switch">
        <span>{text("根据额度启用/关闭", "Use quota limits")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.quotaAware ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.quotaAware}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            quotaAware: !draft.quotaAware,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {draft.quotaAware && (
        <div className={`project-automation-quota is-${quota?.state ?? "unknown"}`}>
          {quota?.state === "available" && text("当前额度可用", "Quota is available")}
          {quota?.state === "blocked" && (
            quota.resetsAt
              ? text(
                `额度已用尽，预计 ${formatResetTime(quota.resetsAt, locale)} 恢复`,
                `Quota is exhausted. Expected reset: ${formatResetTime(quota.resetsAt, locale)}.`,
              )
              : text("额度已用尽，自动认领已暂停", "Quota is exhausted. Auto-claim is paused.")
          )}
          {quota?.state === "unavailable" && (
            quota.reason === "api-key"
              ? text(
                "API Key 模式不支持读取订阅额度",
                "API key mode cannot read subscription quota.",
              )
              : text("当前账户无法读取额度", "This account cannot read quota information.")
          )}
          {(!quota || quota.state === "unknown") && text(
            "额度状态未知，自动认领已暂停",
            "Quota status is unknown. Auto-claim is paused.",
          )}
        </div>
      )}
      <label className="project-automation-field">
        <span>{text("间隔", "Interval")}</span>
        <select
          value={draft.intervalMinutes}
          disabled={disabled}
          onChange={(event) => submitChange({
            ...draft,
            intervalMinutes: Number(event.target.value) as IntervalMinutes,
          })}
        >
          {[5, 10, 15, 30, 60].map((minutes) => (
            <option key={minutes} value={minutes}>{text(`${minutes} 分钟`, `${minutes} min`)}</option>
          ))}
        </select>
      </label>
      <label className="project-automation-field">
        <span>{text("模型", "Model")}</span>
        <select
          value={draft.model}
          disabled={disabled}
          onChange={(event) => submitChange(withAutomationModel(draft, event.target.value as AutomationModel))}
        >
          {AUTOMATION_MODELS.map((model) => (
            <option key={model.slug} value={model.slug}>{model.label}</option>
          ))}
        </select>
      </label>
      <label className="project-automation-field">
        <span>{text("推理强度", "Reasoning effort")}</span>
        <select
          value={draft.reasoningEffort}
          disabled={disabled}
          onChange={(event) => submitChange({
            ...draft,
            reasoningEffort: event.target.value as AutomationReasoningEffort,
          })}
        >
          {getAutomationModel(draft.model).efforts.map((effort) => (
            <option key={effort} value={effort}>{text(...EFFORT_LABELS[effort])}</option>
          ))}
        </select>
      </label>
      <div className="project-automation-menu-heading project-coding-heading">
        <strong>Coding 工作流</strong>
        <span>{codingPending ? "保存中" : "内置"}</span>
      </div>
      <label className="project-automation-field">
        <span>默认工作流</span>
        <select
          value={codingDraft.defaultWorkflowId ?? ""}
          disabled={codingPending || !codingSettings}
          onChange={(event) => submitCodingChange({
            ...codingDraft,
            defaultWorkflowId: event.target.value || null,
          })}
        >
          <option value="">不预选</option>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
          ))}
        </select>
      </label>
      {([
        ["orchestratorModel", "Orchestrator"],
        ["implementerModel", "Implementer"],
        ["verifierModel", "代码 Verifier"],
        ["uiVerifierModel", "UI Verifier"],
        ["escalationImplementerModel", "升级 Implementer"],
      ] as const).map(([field, label]) => (
        <label className="project-automation-field" key={field}>
          <span>{label}</span>
          <select
            value={codingDraft.config[field]}
            disabled={codingPending || !codingSettings}
            onChange={(event) => submitCodingChange({
              ...codingDraft,
              config: { ...codingDraft.config, [field]: event.target.value },
            })}
          >
            {CODING_WORKFLOW_MODELS.map((model) => (
              <option key={model.slug} value={model.slug}>{model.label}</option>
            ))}
          </select>
        </label>
      ))}
      <label className="project-automation-field">
        <span>普通模型轮次</span>
        <select
          value={codingDraft.config.standardRounds}
          disabled={codingPending || !codingSettings}
          onChange={(event) => submitCodingChange({
            ...codingDraft,
            config: { ...codingDraft.config, standardRounds: Number(event.target.value) },
          })}
        >
          {[1, 2, 3, 4, 5].map((rounds) => <option key={rounds} value={rounds}>{rounds}</option>)}
        </select>
      </label>
      <label className="project-automation-field">
        <span>强模型轮次</span>
        <select
          value={codingDraft.config.escalationRounds}
          disabled={codingPending || !codingSettings}
          onChange={(event) => submitCodingChange({
            ...codingDraft,
            config: { ...codingDraft.config, escalationRounds: Number(event.target.value) },
          })}
        >
          {[1, 2, 3].map((rounds) => <option key={rounds} value={rounds}>{rounds}</option>)}
        </select>
      </label>
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
      {codingError && <p className="project-automation-error" role="alert">{codingError}</p>}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}
        onClick={() => {
          if (!open) {
            resetPosition();
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <TaskboardIcon name={status === "ACTIVE" ? "automationPause" : "automationPlay"} />
        <span>{status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}</span>
      </button>
      {menu}
    </>
  );
}

function formatResetTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1_000));
}
