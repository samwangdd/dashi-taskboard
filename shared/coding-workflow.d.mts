export interface CodingWorkflowConfig {
  orchestratorModel: string;
  implementerModel: string;
  verifierModel: string;
  uiVerifierModel: string;
  escalationImplementerModel: string;
  standardRounds: number;
  escalationRounds: number;
}

export const CODING_WORKFLOW_ID: "coding";
export const CODING_WORKFLOW_NAME: "Coding";
export const CODING_WORKFLOW_MODELS: readonly Readonly<{
  label: string;
  slug: string;
}>[];
export const DEFAULT_CODING_WORKFLOW_CONFIG: Readonly<CodingWorkflowConfig>;

export function normalizeCodingWorkflowConfig(value?: Partial<CodingWorkflowConfig>): CodingWorkflowConfig;
export function implementerModelForRound(config: CodingWorkflowConfig, round: number): string;
export function maximumImplementationRounds(config: CodingWorkflowConfig): number;
export function codingWorkflowAutomationInstructions(config?: Partial<CodingWorkflowConfig>): string;
