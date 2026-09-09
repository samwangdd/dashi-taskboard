import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { collectIntegrationSnapshot, integrationProviderRevision } from "./integration-snapshot.mjs";
import { executeIntegration } from "../shared/integration-execution.mjs";
import { planIntegration, renderIntegrationCard } from "../shared/integration-planner.mjs";

const exec = promisify(execFile);
const gitCommands = new Set(["remote", "cat-file", "merge-base", "diff", "cherry", "merge-tree", "rev-parse"]);

export function integrationDecision(plan) {
  if (plan.status !== "ready") return { action: "report", claimIssueId: null, nextAction: plan.nextAction };
  const claimIssueId = plan.claims.allowed[0] ?? null;
  if (plan.nextAction.type === "merge" || plan.nextAction.proposedAction) return { action: "integrate", claimIssueId, nextAction: plan.nextAction };
  return { action: claimIssueId ? "claim" : plan.nextAction.type === "no_action" ? "no_action" : "report", claimIssueId, nextAction: plan.nextAction };
}

export async function runIntegrationPlan(api, projectId, targetBranch, options = {}) {
  const runtime = integrationRuntime(api, projectId, targetBranch, options);
  try {
    const plan = planIntegration(await runtime.readSnapshot());
    return { plan, decision: integrationDecision(plan), card: renderIntegrationCard(plan) };
  } finally { await runtime.close(); }
}

export async function runIntegrationExecute(api, projectId, targetBranch, revision, options = {}) {
  const runtime = integrationRuntime(api, projectId, targetBranch, options);
  let lock, lockPath;
  try {
    // 同设备上同项目只允许一条集成写链；陈旧锁留给操作者核查，不自动抢占。
    lockPath = path.join(os.tmpdir(), `taskboard-integration-${createHash("sha256").update(projectId).digest("hex")}.lock`);
    lock = await open(lockPath, "wx", 0o600);
    return await executeIntegration(revision, runtime);
  } catch (error) {
    return { status: "execution_error", message: error.code === "EEXIST" ? "integration_busy" : error.message, requiresReplan: true };
  } finally {
    if (lock) { await lock.close(); await rm(lockPath); }
    await runtime.close();
  }
}

function integrationRuntime(api, projectId, requestedTarget, options) {
  let cwd, env, objectDir, currentSnapshot, policySignature, originUrl;
  const provider = async (endpoint, host) => {
    const args = ["api", "--hostname", host, "--method", "GET", endpoint];
    const result = await command("glab", args, cwd);
    try { return JSON.parse(result.stdout); } catch { throw new Error("malformed_provider_json"); }
  };
  const git = async (args, accepted = [0]) => {
    if (!gitCommands.has(args[0])) throw new Error("git_command_not_allowed");
    const safeArgs = ["--no-replace-objects", "-c", "core.fsmonitor=false", ...args];
    try {
      const result = await command("git", safeArgs, cwd, accepted, env);
      if (args[0] === "remote") originUrl = result.stdout.trim();
      return result;
    }
    catch (error) {
      if (args[0] !== "cat-file" || !/^[a-f0-9]{40,64}\^\{commit\}$/.test(args[2] ?? "")) throw new Error(`${args[0]}:${error.message}`);
      const shallow = await command("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "rev-parse", "--is-shallow-repository"], cwd, [0], env);
      if (shallow.stdout.trim() !== "false") throw new Error("missing_commit_in_shallow_repository");
      // 只把 provider 指定的对象加载到临时对象库；没有 refspec 目标，也不写 FETCH_HEAD 或运行维护。
      await command("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "fetch.writeCommitGraph=false", "-c", "gc.auto=0", "fetch", "--no-write-fetch-head", "--no-tags", "--no-auto-maintenance", "--no-recurse-submodules", originUrl, args[2].split("^")[0]], cwd, [0], env);
      return command("git", safeArgs, cwd, accepted, env);
    }
  };
  const readSnapshot = async () => {
    try {
      const { projects } = await api.request("GET", "/api/projects");
      const project = projects.find(project => project.id === projectId);
      if (!project) throw new Error("unknown_project");
      const { tasks } = await api.request("GET", `/api/tasks?projectId=${encodeURIComponent(projectId)}`);
      if (!Array.isArray(tasks) || tasks.length > 1000) throw new Error("taskboard_snapshot_budget_exceeded");
      const policy = await (options.readPolicy ?? readPolicy)(projectId);
      policySignature = JSON.stringify(policy);
      const target = requestedTarget ?? policy.targetBranch;
      if (!project.workspacePath) throw new Error("missing_repository_mapping");
      const mapped = await realpath(project.workspacePath);
      if (cwd && mapped !== cwd) throw new Error("repository_mapping_changed");
      cwd = mapped;
      if (!objectDir) {
        const common = await command("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
        objectDir = await mkdtemp(path.join(os.tmpdir(), "taskboard-integration-objects-"));
        env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_OBJECT_DIRECTORY: objectDir,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: [path.join(common.stdout.trim(), "objects"), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(path.delimiter) };
      }
      let snapshot = await collectIntegrationSnapshot(target, { project: { ...project, workspacePath: cwd }, issues: tasks, policy, git, provider });
      const { tasks: latest } = await api.request("GET", `/api/tasks?projectId=${encodeURIComponent(projectId)}`);
      if (JSON.stringify(latest) !== JSON.stringify(tasks)) snapshot = { error: "taskboard_changed_during_snapshot" };
      if (JSON.stringify(await (options.readPolicy ?? readPolicy)(projectId)) !== policySignature) snapshot = { error: "policy_changed_during_snapshot" };
      const { projects: latestProjects } = await api.request("GET", "/api/projects");
      if (latestProjects.find(item => item.id === projectId)?.workspacePath !== project.workspacePath) snapshot = { error: "repository_mapping_changed" };
      currentSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      return { error: error.code === "ENOENT" ? "repository_or_tool_unavailable" : error.message };
    }
  };
  const endpoint = () => `projects/${encodeURIComponent(currentSnapshot.repository.projectPath)}`;
  return {
    readSnapshot,
    merge: async request => {
      const mergedTree = (await command("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "merge-tree", "--write-tree", request.targetSha, request.sourceSha], cwd, [0], env)).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(mergedTree)) throw new Error("invalid_merge_tree");
      const parents = ["-p", request.targetSha, ...(request.method === "merge" ? ["-p", request.sourceSha] : [])];
      const acceptedSha = (await command("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "commit-tree", mergedTree, ...parents, "-m", `Integrate MR ${request.candidateId}`], cwd, [0], env)).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(acceptedSha)) throw new Error("invalid_integration_commit");
      await git(["merge-base", "--is-ancestor", request.targetSha, acceptedSha]);
      if ((await git(["rev-parse", `${acceptedSha}^{tree}`])).stdout.trim() !== mergedTree) throw new Error("integration_tree_mismatch");
      if (JSON.stringify(await (options.readPolicy ?? readPolicy)(projectId)) !== policySignature) throw new Error("policy_changed_before_merge");
      const { projects } = await api.request("GET", "/api/projects");
      const mapped = projects.find(project => project.id === projectId)?.workspacePath;
      if (!mapped || await realpath(mapped) !== cwd) throw new Error("repository_mapping_changed");
      const remote = (await command("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "remote", "get-url", "origin"], cwd)).stdout.trim();
      if (remote !== originUrl) throw new Error("repository_remote_changed");
      const root = endpoint(), host = currentSnapshot.repository.host;
      const detail = await provider(`${root}/merge_requests/${request.candidateId}`, host);
      const approvals = await provider(`${root}/merge_requests/${request.candidateId}/approvals`, host);
      const candidate = currentSnapshot.mergeRequests.find(mr => mr.id === request.candidateId);
      if (detail.state !== "opened" || detail.sha !== request.sourceSha || detail.target_branch !== request.targetBranch
        || integrationProviderRevision(detail, approvals) !== candidate.providerRevision) throw new Error("provider_changed_before_merge");
      const target = await provider(`${root}/repository/branches/${encodeURIComponent(request.targetBranch)}`, host);
      if (target.protected !== false || target.commit?.id !== request.targetSha) throw new Error("target_changed_before_merge");
      // lease 只作用于这个完整 ref；新提交已证明是旧 target 的后代，MR retarget 无法改变写入目标。
      // 已核验的 CI/运行证据是执行门禁；不执行目标仓库可变的本地 hook 脚本。
      await command("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${objectDir}`, "push", "--porcelain", `--force-with-lease=refs/heads/${request.targetBranch}:${request.targetSha}`, originUrl, `${acceptedSha}:refs/heads/${request.targetBranch}`], cwd, [0], env);
      return { acceptedSha };
    },
    readTarget: async ({ targetBranch, acceptedSha }) => {
      if (!/^[a-f0-9]{40,64}$/.test(acceptedSha ?? "")) throw new Error("invalid_accepted_sha");
      const target = await provider(`${endpoint()}/repository/branches/${encodeURIComponent(targetBranch)}`, currentSnapshot.repository.host);
      const sha = target.commit?.id;
      if (typeof target.protected !== "boolean" || !/^[a-f0-9]{40,64}$/.test(sha ?? "")) throw new Error("invalid_target_sha");
      await git(["cat-file", "-e", `${sha}^{commit}`]);
      await git(["cat-file", "-e", `${acceptedSha}^{commit}`]);
      const detail = await provider(`${endpoint()}/merge_requests/${currentSnapshot.mergeRequests.find(mr => mr.id === planIntegration(currentSnapshot).nextAction.candidateId).id}`, currentSnapshot.repository.host);
      return { sha, containsAccepted: sha === acceptedSha && (await git(["merge-base", "--is-ancestor", acceptedSha, sha], [0, 1])).code === 0,
        mergeRequestState: detail.state === "merged" ? "merged" : "integration_pending_provider_state" };
    },
    close: async () => { if (objectDir) await rm(objectDir, { recursive: true, force: true }); },
  };
}

async function readPolicy(projectId) {
  try {
    const policies = JSON.parse(await readFile(path.join(os.homedir(), ".config", "codex-taskboard", "integration.json"), "utf8"));
    if (!policies || typeof policies !== "object" || Array.isArray(policies)) throw new Error("invalid_integration_policy_file");
    return policies[projectId] ?? {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("invalid_integration_policy_file");
  }
}

async function command(binary, args, cwd, accepted = [0], env = process.env) {
  try {
    const { stdout } = await exec(binary, args, { cwd, env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
    return { stdout, code: 0 };
  } catch (error) {
    if (accepted.includes(error.code) && !error.killed) return { stdout: error.stdout, code: error.code };
    // stderr 可能含 remote URL 或凭据；只向计划输出固定错误码。
    throw new Error(`${binary}_execution_error:${error.killed ? "timeout" : error.code ?? "failed"}`);
  }
}
