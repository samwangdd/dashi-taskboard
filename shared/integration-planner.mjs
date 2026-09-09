import { createHash } from "node:crypto";

// 快照必须由可信适配器归一化；规划不读取评论中的命令或授权，也不产生外部副作用。
export function planIntegration(snapshot) {
  snapshot = canonical(snapshot);
  const revision = createHash("sha256").update(JSON.stringify(snapshot) ?? "null").digest("hex");
  const covered = mr => ["included", "equivalent", "empty"].includes(mr.inclusion);
  const invalid = invalidSnapshot(snapshot);
  if (invalid) return { status: "invalid", revision, reasons: [invalid], candidates: [], conflictEdges: [], dependencyEdges: [], nextAction: { type: "report", reason: invalid }, claims: { allowed: [], skipped: [] } };
  const candidates = snapshot.mergeRequests.map(mr => ({
    id: mr.id,
    state: mr.targetSha !== snapshot.target.sha ? "stale"
      : covered(mr) ? "covered_or_empty"
      : mr.dependsOn.some(id => !snapshot.mergeRequests.some(parent => parent.id === id && covered(parent))) ? "dependency_wait"
      : mr.draft || !mr.discussionsResolved || mr.review !== "approved" ? "draft_or_review_wait"
      : mr.git === "conflict" ? "conflict"
        : mr.git === "behind" ? "needs_rebase"
          : mr.ci !== "passed" || mr.runtimeEvidence !== "passed" || mr.mergeability !== "mergeable" ? "external_evidence_wait" : "merge_ready",
    reasons: [
      ...(mr.targetSha !== snapshot.target.sha ? ["stale_target"] : []),
      ...(covered(mr) ? [`target_${mr.inclusion}`] : []),
      ...(mr.dependsOn.some(id => !snapshot.mergeRequests.some(parent => parent.id === id && covered(parent))) ? ["dependency_not_integrated"] : []),
      ...(mr.draft ? ["draft"] : []),
      ...(!mr.discussionsResolved ? ["unresolved_discussions"] : []),
      ...(mr.review !== "approved" ? ["review_pending"] : []),
      ...(mr.git === "conflict" ? ["git_conflict"] : mr.git === "behind" ? ["target_sync_required"] : []),
      ...(mr.ci !== "passed" ? [`ci_${mr.ci}`] : []),
      ...(mr.runtimeEvidence !== "passed" ? ["runtime_evidence_missing"] : []),
      ...(mr.mergeability !== "mergeable" ? [`provider_${mr.mergeability}`] : []),
    ],
  }));
  const conflictEdges = [];
  for (let i = 0; i < snapshot.mergeRequests.length; i++) {
    for (const right of snapshot.mergeRequests.slice(i + 1)) {
      const left = snapshot.mergeRequests[i];
      const files = left.changedFiles.filter(file => right.changedFiles.includes(file));
      const domains = left.domains.filter(domain => right.domains.includes(domain));
      if (files.length || domains.length) conflictEdges.push({ left: left.id, right: right.id, files, domains });
    }
  }
  const claims = { allowed: [], skipped: [] };
  const open = snapshot.mergeRequests.filter(mr => !covered(mr));
  const freeze = open.some(mr => mr.changedFiles.length > 30 || mr.domains.length > 3
    || mr.changedFiles.some(file => (snapshot.policy.sharedFoundations ?? []).some(prefix => file === prefix || file.startsWith(`${prefix}/`))));
  for (const issue of snapshot.issues.filter(issue => issue.status === "todo")) {
    const parent = snapshot.mergeRequests.find(mr => mr.id === issue.reviewFinding?.parentMr);
    const active = snapshot.issues.filter(other => other.status === "in_progress");
    const activeLimit = snapshot.policy.maxActivePerDomain ?? 1;
    const domainFull = issue.domains.some(domain => active.filter(other => other.domains.includes(domain)).length >= activeLimit)
      || issue.plannedFiles.some(file => active.filter(other => other.plannedFiles.includes(file)).length >= activeLimit);
    const reason = parent && !covered(parent) ? (issue.reviewFinding.blocking ? (issue.reviewFinding.separate ? "stacked_dependency_wait" : "return_to_parent_mr") : "backlog_until_parent_integrated")
      : domainFull ? "active_domain_limit"
      : freeze ? "cross_cutting_wave" : open.length >= (snapshot.policy.maxOpenMergeRequests ?? 3) ? "target_wip_limit"
      : !issue.domains.length && !issue.plannedFiles.length ? "missing_write_set"
        : issue.blockedBy.some(id => !snapshot.issues.some(parent => parent.id === id && (parent.status === "done" || parent.integrated === true))) ? "dependency_wait"
          : open.some(mr => mr.domains.some(d => issue.domains.includes(d)) || mr.changedFiles.some(f => issue.plannedFiles.includes(f))) ? "conflict_domain_busy" : null;
    if (reason) claims.skipped.push({ id: issue.id, reason });
    else claims.allowed.push(issue.id);
  }
  const actions = { merge_ready: "merge", conflict: "resolve_conflict", needs_rebase: "sync_target", covered_or_empty: "close_covered" };
  const head = candidates.find(c => c.state === "merge_ready")
    ?? candidates.find(c => c.state === "conflict") ?? candidates.find(c => c.state === "needs_rebase") ?? candidates.find(c => c.state === "covered_or_empty");
  return {
    status: "ready", revision, projectId: snapshot.project.id, target: snapshot.target, candidates, conflictEdges,
    dependencyEdges: snapshot.mergeRequests.flatMap(mr => mr.dependsOn.map(to => ({ from: mr.id, to }))),
    nextAction: head ? (head.state === "merge_ready" && !freeze && authorized(snapshot)
      ? { type: "merge", candidateId: head.id, method: snapshot.policy.authority.method }
      : { type: "report", candidateId: head.id, proposedAction: actions[head.state],
          reason: freeze ? "cross_cutting_wave" : head.state === "merge_ready" ? "missing_authorization" : head.state })
      : candidates.some(c => c.state !== "covered_or_empty") ? { type: "report", reason: "waiting_for_evidence_or_dependency" } : { type: "no_action" },
    backpressure: { openMergeRequests: open.length, freeze },
    claims,
  };
}

function invalidSnapshot(value) {
  if (!value || typeof value !== "object") return "missing_snapshot";
  if (value.error) return String(value.error);
  if (!value.project?.id || !value.project.activityRevision || !value.target?.branch || !value.target.sha) return "missing_identity";
  if (!Array.isArray(value.issues) || !Array.isArray(value.mergeRequests) || !value.policy) return "malformed_snapshot";
  const strings = list => Array.isArray(list) && list.every(item => typeof item === "string" && item.length > 0);
  const record = item => item !== null && typeof item === "object" && !Array.isArray(item);
  if (!record(value.policy)
    || (value.policy.sharedFoundations !== undefined && !strings(value.policy.sharedFoundations))
    || (value.policy.protectedBranches !== undefined && !strings(value.policy.protectedBranches))
    || (value.policy.domains !== undefined && (!record(value.policy.domains) || Object.values(value.policy.domains).some(list => !strings(list))))
    || (value.policy.authority !== undefined && !record(value.policy.authority))) return "invalid_policy";
  if (value.issues.some(issue => !record(issue)) || value.mergeRequests.some(mr => !record(mr))) return "malformed_graph_entry";
  if (!value.issues.length && !value.mergeRequests.length) return "empty_snapshot";
  if (value.mergeRequests.length > 100 || value.issues.length > 1000) return "snapshot_budget_exceeded";
  if (new Set(value.mergeRequests.map(mr => mr.id)).size !== value.mergeRequests.length) return "duplicate_merge_request";
  if (value.mergeRequests.some(mr => !mr.id || !mr.sourceBranch || !mr.sourceSha || !mr.targetSha || !mr.providerRevision
    || mr.targetBranch !== value.target.branch || !strings(mr.changedFiles) || !strings(mr.domains) || !strings(mr.dependsOn)
    || typeof mr.draft !== "boolean" || typeof mr.discussionsResolved !== "boolean"
    || !["passed", "failed", "missing", "pending"].includes(mr.ci)
    || !["passed", "missing"].includes(mr.runtimeEvidence)
    || !["approved", "pending"].includes(mr.review)
    || !["mergeable", "conflict", "unknown"].includes(mr.mergeability)
    || !["clean", "behind", "conflict"].includes(mr.git)
    || !["included", "equivalent", "empty", "absent"].includes(mr.inclusion))) return "malformed_merge_request";
  if (value.issues.some(issue => !issue.id || !strings(issue.domains) || !strings(issue.plannedFiles) || !strings(issue.blockedBy))) return "malformed_issue";
  for (const key of ["maxOpenMergeRequests", "maxActivePerDomain"]) {
    if (value.policy[key] !== undefined && (!Number.isSafeInteger(value.policy[key]) || value.policy[key] < 1)) return "invalid_wip_policy";
  }
  return null;
}

// Provider 列表顺序不是业务顺序；规范化后 revision 与唯一 head 不受分页顺序影响。
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => String(a?.id ?? JSON.stringify(a)).localeCompare(String(b?.id ?? JSON.stringify(b)), "en", { numeric: true }));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function authorized(snapshot) {
  const authority = snapshot.policy.authority;
  return authority?.mode === "merge" && authority.transport === "git-cas-push" && authority.allowForceWithLease === true && authority.projectId === snapshot.project.id
    && authority.targetBranch === snapshot.target.branch && authority.maxActions === 1
    && ["merge", "squash"].includes(authority.method)
    && !/^(main|master|prod|production|release)(?:$|[\/-])/i.test(snapshot.target.branch)
    && !(snapshot.policy.protectedBranches ?? []).includes(snapshot.target.branch);
}

export function renderIntegrationCard(plan) {
  return `<!-- integration-readiness:v1 -->\n${JSON.stringify(plan, null, 2)}\n`;
}
