import { planIntegration } from "./integration-planner.mjs";

// 只有持久策略读取端可注入此执行器；CLI 的 report-only 路径不提供 provider 写适配器。
export async function executeIntegration(revision, { readSnapshot, merge, readTarget }) {
  let writeAttempted = false;
  try {
    const snapshot = await readSnapshot();
    const plan = planIntegration(snapshot);
    if (plan.revision !== revision) return { status: "stale", requiresReplan: true, plan };
    if (plan.status !== "ready" || plan.nextAction.type !== "merge") return { status: "not_authorized", plan };
    const candidate = snapshot.mergeRequests.find(mr => mr.id === plan.nextAction.candidateId);
    writeAttempted = true;
    const result = await merge({ projectId: snapshot.project.id, targetBranch: snapshot.target.branch,
      targetSha: snapshot.target.sha, candidateId: candidate.id, sourceSha: candidate.sourceSha, method: plan.nextAction.method });
    if (!result?.acceptedSha) throw new Error("Merge response did not identify an accepted commit");
    const target = await readTarget({ targetBranch: snapshot.target.branch, acceptedSha: result.acceptedSha });
    if (!target?.sha || target.sha === snapshot.target.sha || target.containsAccepted !== true) throw new Error("Remote target inclusion was not verified");
    return { status: "integrated", targetSha: target.sha, acceptedSha: result.acceptedSha, mergeRequestState: target.mergeRequestState ?? "unknown", requiresReplan: true };
  } catch (error) {
    return { status: "execution_error", message: error.message, writeAttempted, requiresReplan: true };
  }
}
