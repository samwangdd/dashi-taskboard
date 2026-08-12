import type { CodingWorkflowConfig } from "./coding-workflow.d.mts";
import type {
  AutomationModel,
  AutomationReasoningEffort,
} from "./taskboard-automation-options.d.mts";

export type AutomationIntervalMinutes = 5 | 10 | 15 | 30 | 60;

export interface TaskboardAutomationHostRequest {
  id: string;
  action: "automation";
  requestId: string;
  operation: "ensure-active" | "pause" | "list" | "apply-policy";
  taskboardProjectId: string;
  codexProjectId: string;
  projectName: string;
  workspacePath: string;
  skillPath: string;
  automationId?: string;
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: AutomationIntervalMinutes;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

export interface TaskboardLoopPromptInput {
  intervalMinutes: AutomationIntervalMinutes;
  projectName: string;
  taskboardProjectId: string;
  workspacePath: string;
  skillPath: string;
  codingConfig?: Partial<CodingWorkflowConfig>;
}

export const TASKBOARD_BASE_INSTRUCTIONS: readonly string[];

export function parseTaskboardAutomationHostRequest(
  value: unknown,
): TaskboardAutomationHostRequest | null;
export function buildTaskboardAutomationName(request: TaskboardAutomationHostRequest): string;
export function buildTaskboardAutomationPrompt(request: TaskboardAutomationHostRequest): string;
export function buildTaskboardLoopPrompt(input: TaskboardLoopPromptInput): string;
export function buildTaskboardAutomationSpec(
  request: TaskboardAutomationHostRequest,
): Record<string, unknown>;
export function reconcileTaskboardAutomation(
  request: TaskboardAutomationHostRequest,
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown>>;
