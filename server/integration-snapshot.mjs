import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// 响应包含不影响合并的动态展示字段；revision 只绑定调度所需事实及 provider 更新时间。
export const integrationProviderRevision = (detail, approvals) => hash({ sha: detail.sha, updatedAt: detail.updated_at,
  source: detail.source_branch, target: detail.target_branch, draft: detail.draft,
  discussionsResolved: detail.blocking_discussions_resolved, mergeability: detail.detailed_merge_status,
  pipeline: detail.head_pipeline ? { id: detail.head_pipeline.id, sha: detail.head_pipeline.sha, status: detail.head_pipeline.status } : null,
  approved: approvals.approved, approvalsLeft: approvals.approvals_left,
});
const shaPattern = /^[a-f0-9]{40,64}$/;
const openMembership = (list, targetBranch) => {
  if (!Array.isArray(list) || list.length >= 100) throw new Error("provider_snapshot_budget_exceeded");
  return list.map(item => {
    if (!Number.isSafeInteger(item.iid) || item.iid < 1 || !shaPattern.test(item.sha ?? "") || item.target_branch !== targetBranch) {
      throw new Error("malformed_merge_request_list");
    }
    return `${item.iid}\u0000${item.sha}\u0000${item.target_branch}`;
  }).sort();
};

// Git 和 provider 的证据只在本快照内有效；任何读取失败都保留错误，不降级为空队列。
export async function collectIntegrationSnapshot(targetBranch, { project, issues, policy = {}, provider, git }) {
  try {
    if (!project?.workspacePath) throw new Error("missing_repository_mapping");
    if (!targetBranch || targetBranch.startsWith("-") || /[\s\x00-\x1f]/.test(targetBranch)) throw new Error("ambiguous_target");
    const remote = (await git(["remote", "get-url", "origin"])).stdout.trim();
    const match = remote.match(/^(?:git@|https:\/\/|ssh:\/\/git@)([^/:]+)[:/]([^?#]+?)(?:\.git)?$/);
    if (!match) throw new Error("unsupported_gitlab_remote");
    const host = match[1];
    const root = `projects/${encodeURIComponent(match[2])}`;
    const read = endpoint => provider(`${root}/${endpoint}`, host);
    const branchEndpoint = `repository/branches/${encodeURIComponent(targetBranch)}`;
    const branch = await read(branchEndpoint);
    const targetSha = branch?.commit?.id;
    if (typeof branch?.protected !== "boolean") throw new Error("invalid_target_protection");
    if (!shaPattern.test(targetSha ?? "")) throw new Error("invalid_target_sha");
    const list = await read(`merge_requests?state=opened&per_page=100&target_branch=${encodeURIComponent(targetBranch)}`);
    const initialMembership = openMembership(list, targetBranch);
    const requests = [];
    for (const item of list) {
      if (!Number.isSafeInteger(item.iid) || item.iid < 1) throw new Error("malformed_merge_request_id");
      const endpoint = `merge_requests/${item.iid}`;
      const detail = await read(endpoint);
      const changes = await read(`${endpoint}/changes`);
      const approvals = await read(`${endpoint}/approvals`);
      if (!shaPattern.test(detail.sha ?? "") || detail.sha !== changes.sha || changes.overflow !== false
        || !Array.isArray(changes.changes) || changes.changes.some(c => typeof c.old_path !== "string" || typeof c.new_path !== "string")
        || typeof detail.draft !== "boolean" || typeof detail.blocking_discussions_resolved !== "boolean"
        || typeof approvals.approved !== "boolean" || detail.target_branch !== targetBranch || !detail.updated_at) throw new Error("malformed_or_truncated_provider_data");
      const files = [...new Set(changes.changes.flatMap(c => [c.old_path, c.new_path]))].sort();
      const source = detail.sha;
      await git(["cat-file", "-e", `${targetSha}^{commit}`]);
      await git(["cat-file", "-e", `${source}^{commit}`]);
      const included = (await git(["merge-base", "--is-ancestor", source, targetSha], [0, 1])).code === 0;
      const empty = (await git(["diff", "--quiet", targetSha, source, "--"], [0, 1])).code === 0;
      const cherry = included || empty ? null : await git(["cherry", targetSha, source]);
      const equivalent = cherry && cherry.stdout.trim().length > 0 && cherry.stdout.trim().split("\n").every(line => /^- [a-f0-9]{40,64}$/.test(line));
      let inclusion = included ? "included" : empty ? "empty" : equivalent ? "equivalent" : "absent";
      let gitState = "clean";
      if (inclusion === "absent") {
        const merge = await git(["merge-tree", "--write-tree", targetSha, source], [0, 1]);
        const targetTree = merge.code === 0 ? await git(["rev-parse", `${targetSha}^{tree}`]) : null;
        if (targetTree?.code === 0 && merge.stdout.trim() === targetTree.stdout.trim()) {
          inclusion = "equivalent";
        } else {
          const current = (await git(["merge-base", "--is-ancestor", targetSha, source], [0, 1])).code === 0;
          gitState = merge.code === 1 ? "conflict" : current ? "clean" : "behind";
        }
      }
      const issue = issues.find(task => task.developmentContext?.branch === detail.source_branch);
      const domains = Object.entries(policy.domains ?? {}).filter(([, prefixes]) => prefixes.some(prefix => files.some(file => file === prefix || file.startsWith(`${prefix}/`)))).map(([name]) => name);
      const pipeline = detail.head_pipeline;
      const evidence = policy.runtimeEvidence?.[String(item.iid)];
      requests.push({ id: String(item.iid), sourceBranch: detail.source_branch, sourceSha: source,
        targetBranch, targetSha, providerRevision: integrationProviderRevision(detail, approvals), changedFiles: files, domains, dependsOn: [],
        issueId: issue?.id ?? null,
        draft: detail.draft, discussionsResolved: detail.blocking_discussions_resolved,
        review: approvals.approved ? "approved" : "pending",
        ci: pipeline?.sha !== source ? "missing" : pipeline.status === "success" ? "passed" : ["failed", "canceled"].includes(pipeline.status) ? "failed" : "pending",
        // 只接受设备本地策略中明确登记且绑定双 SHA 的证据；评论与 MR 文案不能自行升级为通过。
        runtimeEvidence: evidence?.sourceSha === source && evidence.targetSha === targetSha && evidence.result === "passed" && typeof evidence.evidenceRef === "string" && evidence.evidenceRef.trim() ? "passed" : "missing",
        mergeability: detail.detailed_merge_status === "mergeable" ? "mergeable" : detail.detailed_merge_status === "conflict" ? "conflict" : "unknown",
        git: gitState, inclusion,
      });
    }
    const integratedIssues = new Set(requests.filter(mr => mr.inclusion !== "absent").map(mr => mr.issueId));
    const dependencies = [...new Set(issues.flatMap(task => (task.relations?.blockedBy ?? []).filter(dep => dep.status !== "done").map(dep => dep.id)))];
    if (dependencies.length > 50) throw new Error("dependency_snapshot_budget_exceeded");
    for (const id of dependencies) {
      if (requests.some(mr => mr.issueId === id)) continue;
      const parentBranch = issues.find(task => task.id === id)?.developmentContext?.branch;
      if (!parentBranch) continue;
      const merged = await read(`merge_requests?state=merged&per_page=100&source_branch=${encodeURIComponent(parentBranch)}&target_branch=${encodeURIComponent(targetBranch)}`);
      if (!Array.isArray(merged) || merged.length >= 100) throw new Error("invalid_dependency_snapshot");
      for (const parent of merged) {
        const accepted = parent.squash_commit_sha ?? parent.merge_commit_sha;
        if (!shaPattern.test(accepted ?? "")) continue;
        await git(["cat-file", "-e", `${accepted}^{commit}`]);
        if ((await git(["merge-base", "--is-ancestor", accepted, targetSha], [0, 1])).code === 0) {
          integratedIssues.add(id);
          break;
        }
      }
    }
    for (const mr of requests) {
      const issue = issues.find(task => task.id === mr.issueId);
      mr.dependsOn = (issue?.relations?.blockedBy ?? []).filter(dep => dep.status !== "done" && !integratedIssues.has(dep.id))
        .map(dep => requests.find(parent => parent.issueId === dep.id)?.id ?? `issue:${dep.id}`);
    }
    for (const mr of requests) {
      const detail = await read(`merge_requests/${mr.id}`);
      const approvals = await read(`merge_requests/${mr.id}/approvals`);
      if (integrationProviderRevision(detail, approvals) !== mr.providerRevision) throw new Error(`provider_changed_during_snapshot:${mr.id}`);
    }
    const finalList = await read(`merge_requests?state=opened&per_page=100&target_branch=${encodeURIComponent(targetBranch)}`);
    if (JSON.stringify(openMembership(finalList, targetBranch)) !== JSON.stringify(initialMembership)) {
      throw new Error("open_merge_requests_changed_during_snapshot");
    }
    const finalBranch = await read(branchEndpoint);
    if (typeof finalBranch?.protected !== "boolean" || finalBranch.protected !== branch.protected || finalBranch?.commit?.id !== targetSha) throw new Error("target_changed_during_snapshot");
    return {
      project: { id: project.id, activityRevision: hash(issues.map(t => [t.id, t.version, t.activityKey, t.threadId, t.developmentContext])) },
      repository: { host, projectPath: match[2] },
      target: { branch: targetBranch, sha: targetSha },
      // 首次 rollout 只报告；仓库文件、issue 文本或命令参数不能开启自动合并。
      policy: {
        ...policy,
        ...(branch.protected ? { protectedBranches: [...new Set([...(policy.protectedBranches ?? []), targetBranch])] } : {}),
      },
      issues: issues.map(task => ({ id: task.id, status: task.status, integrated: integratedIssues.has(task.id),
        domains: policy.plannedWork?.[task.id]?.domains ?? (task.labels ?? []).filter(label => label.startsWith("area:")).map(label => label.slice(5)),
        plannedFiles: policy.plannedWork?.[task.id]?.files ?? [],
        blockedBy: (task.relations?.blockedBy ?? []).map(dep => dep.id),
        ...(policy.plannedWork?.[task.id]?.reviewFinding ? { reviewFinding: policy.plannedWork[task.id].reviewFinding } : {}),
      })), mergeRequests: requests,
    };
  } catch (error) {
    return { error: error.message || "snapshot_execution_error" };
  }
}
