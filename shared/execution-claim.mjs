import { ApiError, assertPlainObject, assertAllowedKeys, parseVersion, parseStatus, stringField, validateProjectId } from "./api-fields.mjs";
import { parseAgentSession, parseThreadBinding } from "./task-input.mjs";

export const EXECUTION_PROTOCOL = 1;
export const DEFAULT_EXECUTION_POLICY = { dependencyUnlockStatuses: ["done"], holdLabels: ["hold"], excludeParentSummaries: true };
export function parseExecutionPolicy(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "policy"]));
  assertPlainObject(body.policy);
  assertAllowedKeys(body.policy, new Set(["dependencyUnlockStatuses", "holdLabels", "excludeParentSummaries"]));
  const { dependencyUnlockStatuses, holdLabels, excludeParentSummaries } = body.policy;
  if (!Array.isArray(dependencyUnlockStatuses) || !dependencyUnlockStatuses.length || dependencyUnlockStatuses.some(value => !["done", "canceled", "in_review"].includes(value))) throw new ApiError(400, "INVALID_FIELD", "Dependency unlock statuses must be done, canceled, or in_review");
  if (!Array.isArray(holdLabels) || holdLabels.some(value => typeof value !== "string" || !value.length || value.length > 100) || typeof excludeParentSummaries !== "boolean") throw new ApiError(400, "INVALID_FIELD", "Invalid execution policy");
  return { version: parseVersion(body.version), policy: { dependencyUnlockStatuses: [...new Set(dependencyUnlockStatuses)], holdLabels: [...new Set(holdLabels)], excludeParentSummaries } };
}
export function executionStateFromRow(row) {
  return row.execution_state ? JSON.parse(row.execution_state) : null;
}
export function parseExecutionOwner(value) {
  assertPlainObject(value);
  if (value.platform === "codex") {
    const { platform, ...identity } = value;
    const binding = parseThreadBinding(identity);
    if (!binding?.codexProjectId) throw new ApiError(400, "EXECUTION_IDENTITY_REQUIRED", "Complete Codex identity is required");
    return { platform, ...binding };
  }
  return parseAgentSession(value);
}
export function parseCloudExecutionOwner(value) {
  if (value?.platform === "codex" && value.workspaceKey) {
    if (!/^sha256:[a-f0-9]{64}$/.test(value.workspaceKey)) throw new ApiError(400, "INVALID_FIELD", "Invalid workspace identity key");
    const { workspaceKey, ...identity } = value;
    const parsed = parseExecutionOwner({ ...identity, workspacePath: "cloud-workspace" });
    const { workspacePath, ...owner } = parsed;
    return { ...owner, workspaceKey };
  }
  if (value?.sessionKey) {
    if (!/^sha256:[a-f0-9]{64}$/.test(value.sessionKey)) throw new ApiError(400, "INVALID_FIELD", "Invalid session identity key");
    const { sessionKey, ...identity } = value;
    parseExecutionOwner({ ...identity, sessionId: "cloud-session" });
    return { ...identity, sessionKey };
  }
  return parseExecutionOwner(value);
}

export function parseExecutionInput(body, ownerParser = parseExecutionOwner) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["protocol", "action", "owner", "version", "projectId", "requestId", "claimId", "status", "policyVersion"]));
  if (body.protocol !== EXECUTION_PROTOCOL) throw new ApiError(426, "EXECUTION_PROTOCOL_REQUIRED", "Upgrade taskctl: execution protocol 1 is required");
  if (!["claim", "resume", "release"].includes(body.action)) throw new ApiError(400, "INVALID_FIELD", "Unknown execution action");
  return { ...body, ...(body.action === "claim" ? { policyVersion: parseVersion(body.policyVersion) } : {}), version: parseVersion(body.version), owner: ownerParser(body.owner),
    ...(body.status === undefined ? {} : { status: parseStatus(body.status) }),
    ...(body.projectId === undefined ? {} : { projectId: validateProjectId(body.projectId) }),
    requestId: stringField(body.requestId, "requestId", { maxLength: 256 }),
    claimId: stringField(body.claimId, "claimId", { maxLength: 256 }) };
}
export function executionEligibility(task, projectId, policy = DEFAULT_EXECUTION_POLICY, policyVersion = 1) {
  const state = task.executionState;
  let reason = "eligible";
  if (task.projectId !== projectId) reason = "project_mismatch";
  else if (task.source === "jira") reason = "external_execution_unsupported";
  else if (task.archivedAt != null) reason = "archived";
  else if (state?.active) reason = "active_claim";
  else if (task.status === "in_progress") reason = "legacy_execution_requires_recovery";
  else if (task.status !== "todo") reason = "status_not_todo";
  else if (state?.hold || task.labels?.some(label => policy.holdLabels.includes(label))) reason = "hold";
  else if (task.relations?.blockedBy?.some((related) => !policy.dependencyUnlockStatuses.includes(related.status))) reason = "unresolved_dependency";
  else if (policy.excludeParentSummaries && task.relations?.subIssues?.length) reason = "parent_summary";
  return { protocol: EXECUTION_PROTOCOL, policy, policyVersion, eligible: reason === "eligible", reason, taskId: task.id, projectId: task.projectId, version: task.version, claimId: state?.active?.id ?? null };
}
function sameOwner(left, right) {
  return JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
}
export function assertExecutionOwner(task, owner, claimId) {
  const active = task.executionState?.active;
  if (!active || active.id !== claimId || !sameOwner(active.owner, owner)) {
    throw new ApiError(409, "EXECUTION_OWNER_CONFLICT", "Current claim id and owner are required");
  }
}
export function transitionExecution(task, input, claimId, timestamp, policy = DEFAULT_EXECUTION_POLICY, policyVersion = 1) {
  const owner = parseCloudExecutionOwner(input.owner);
  if (task.source === "jira") throw new ApiError(409, "EXECUTION_INELIGIBLE", "external_execution_unsupported");
  const state = structuredClone(task.executionState ?? { active: null, history: [], hold: false, origins: {
    threadBinding: task.threadBinding ?? null, agentSession: task.agentSession ?? null, legacyLocalThreadId: task.legacyLocalThreadId ?? null,
  } });
  if (input.action === "claim" && state.active?.requestId === input.requestId && sameOwner(state.active.owner, owner)) return { state, status: task.status, idempotent: true };
  if (task.version !== input.version) throw new ApiError(409, "VERSION_CONFLICT", "Task changed since eligibility was read");
  if (input.action === "claim") {
    if (state.history?.some(previous => previous.requestId === input.requestId)) throw new ApiError(409, "EXECUTION_REQUEST_FINISHED", "This request already ended; use a new requestId for new work");
    if (input.policyVersion !== policyVersion) throw new ApiError(409, "EXECUTION_POLICY_CONFLICT", "Project execution policy changed; refresh eligibility");
    const eligibility = executionEligibility(task, input.projectId, policy, policyVersion);
    if (!eligibility.eligible) throw new ApiError(409, "EXECUTION_INELIGIBLE", eligibility.reason, eligibility);
    if (!input.requestId) throw new ApiError(400, "INVALID_FIELD", "A stable requestId is required");
    state.active = { id: claimId, requestId: input.requestId, owner, startedAt: timestamp, progressAt: timestamp };
    return { state, status: "in_progress" };
  }
  assertExecutionOwner(task, owner, input.claimId);
  if (input.action === "resume") {
    if (task.status !== "in_progress") throw new ApiError(409, "EXECUTION_STATE_CONFLICT", "Active claim requires in_progress");
    state.active.progressAt = timestamp;
    return { state, status: task.status };
  }
  if (!["todo", "in_review", "blocked", "done", "canceled"].includes(input.status)) throw new ApiError(400, "INVALID_FIELD", "Release requires a non-executing status");
  state.history.push({ ...state.active, endedAt: timestamp, outcome: input.status });
  state.active = null;
  state.hold = false;
  return { state, status: input.status };
}
export function assertExecutionWrite(task, proof, targetStatus) {
  if (task.executionState?.active) {
    if (!proof) throw new ApiError(426, "EXECUTION_PROTOCOL_REQUIRED", "Use taskctl with --claim-id and current owner; release execution before handing off");
    assertExecutionOwner(task, parseCloudExecutionOwner(proof.owner), proof.claimId);
    if (targetStatus && targetStatus !== "in_progress") throw new ApiError(409, "EXECUTION_RELEASE_REQUIRED", "Use execution release for handoff");
  } else if (proof || targetStatus === "in_progress") {
    throw new ApiError(426, "EXECUTION_PROTOCOL_REQUIRED", "Use issue claim/resume; historical session metadata is not an execution claim");
  }
}

// Both stores recheck related rows and the policy version in the claim write.
export function claimRelationGuard(policy) {
  const statuses = policy.dependencyUnlockStatuses.map(value => `'${value}'`).join(",");
  return `AND NOT EXISTS (SELECT 1 FROM task_relations r JOIN tasks d ON d.id = r.source_task_id
    WHERE r.target_task_id = tasks.id AND r.relation_type = 'blocks' AND d.status NOT IN (${statuses}))
    ${policy.excludeParentSummaries ? "AND NOT EXISTS (SELECT 1 FROM task_relations r WHERE r.source_task_id = tasks.id AND r.relation_type = 'parent')" : ""}`;
}
