import { taskboardStorage } from "./storage";
import type { WorkflowOption } from "./types";
import { CODING_WORKFLOW_ID, CODING_WORKFLOW_NAME } from "../../shared/coding-workflow.mjs";

export const WORKFLOW_STATE_KEY_PREFIX = "taskboard.workflow.workspace.";
export const INITIAL_WORKFLOW_ID = "issue-delivery";
export const INITIAL_WORKFLOW_NAME = "议题处理与交付";
export const DEFAULT_WORKFLOW_OPTIONS: WorkflowOption[] = [
  { id: INITIAL_WORKFLOW_ID, name: INITIAL_WORKFLOW_NAME },
  { id: CODING_WORKFLOW_ID, name: CODING_WORKFLOW_NAME },
];

function withBuiltInCodingWorkflow(workflows: WorkflowOption[]): WorkflowOption[] {
  return workflows.some((workflow) => workflow.id === CODING_WORKFLOW_ID)
    ? workflows
    : [...workflows, { id: CODING_WORKFLOW_ID, name: CODING_WORKFLOW_NAME }];
}

export function workflowStorageKey(projectId: string): string {
  return `${WORKFLOW_STATE_KEY_PREFIX}${projectId}`;
}

export function readLegacyWorkflowWorkspace(projectId: string): unknown | null {
  try {
    const raw = taskboardStorage.getItem(workflowStorageKey(projectId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearLegacyWorkflowWorkspace(projectId: string): void {
  taskboardStorage.removeItem(workflowStorageKey(projectId));
}

export function workflowOptionsFromWorkspace(workspace: unknown): WorkflowOption[] {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    return DEFAULT_WORKFLOW_OPTIONS;
  }
  const tabs = (workspace as { tabs?: unknown }).tabs;
  if (!Array.isArray(tabs)) return DEFAULT_WORKFLOW_OPTIONS;
  const workflows = tabs.filter((workflow): workflow is WorkflowOption => (
    workflow !== null
      && typeof workflow === "object"
      && typeof (workflow as Partial<WorkflowOption>).id === "string"
      && (workflow as Partial<WorkflowOption>).id!.length > 0
      && typeof (workflow as Partial<WorkflowOption>).name === "string"
      && (workflow as Partial<WorkflowOption>).name!.length > 0
  ));
  return workflows.length > 0 ? withBuiltInCodingWorkflow(workflows) : DEFAULT_WORKFLOW_OPTIONS;
}
