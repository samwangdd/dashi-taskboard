import type { CodingWorkflowConfig } from "./coding-workflow.d.mts";

export type AutomationIntervalMinutes = 5 | 10 | 15 | 30 | 60;

export interface TaskboardLoopPromptInput {
  intervalMinutes: AutomationIntervalMinutes;
  projectName: string;
  taskboardProjectId: string;
  workspacePath: string;
  skillPath: string;
  codingConfig?: Partial<CodingWorkflowConfig>;
}

export const TASKBOARD_BASE_INSTRUCTIONS: readonly string[];

export function isAbsoluteWorkspacePath(value: unknown): boolean;
export function buildTaskboardLoopPromptOpening(request: {
  skillPath: string;
  intervalMinutes: number;
  projectName: string;
  taskboardProjectId: string;
  workspacePath: string;
}): string;
export function buildTaskboardLoopPrompt(input: TaskboardLoopPromptInput): string;
