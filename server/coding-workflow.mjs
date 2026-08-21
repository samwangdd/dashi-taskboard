import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ApiError } from "./database.mjs";
import { CODING_WORKFLOW_ID } from "../shared/coding-workflow.mjs";

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);
const OUTPUT_LIMIT = 65_536;
const GIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15 * 60_000;
const AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sameFiles(left, right) {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

async function runGit(workspacePath, args, options = {}) {
  try {
    return await execFile("git", ["-C", workspacePath, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT,
      ...options,
    });
  } catch (error) {
    throw new ApiError(409, "GIT_COMMAND_FAILED", `Git command failed: git ${args.join(" ")}`, {
      exitCode: Number.isInteger(error.code) ? error.code : null,
      stderr: typeof error.stderr === "string" ? error.stderr.slice(0, OUTPUT_LIMIT) : "",
    });
  }
}

function normalizeRelativeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new ApiError(400, "SCOPED_FILES_REQUIRED", "Coding checks require at least one scoped file");
  }
  return [...new Set(files.map((file) => {
    if (typeof file !== "string" || file.length === 0 || file.length > 2_048 || file.includes("\0")) {
      throw new ApiError(400, "INVALID_FILE", "Coding check file is invalid");
    }
    const normalized = path.normalize(file);
    if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw new ApiError(400, "INVALID_FILE", "Coding check files must stay inside the development context");
    }
    return normalized;
  }))];
}

export class CodingWorkflowService {
  constructor(database) {
    this.database = database;
  }

  async workspaceForTask(task) {
    if (!task.developmentContext) {
      throw new ApiError(409, "DEVELOPMENT_CONTEXT_REQUIRED", "Coding workflow requires a branch or worktree");
    }
    const project = this.database.getProject(task.projectId);
    const configuredPath = task.developmentContext.type === "worktree"
      ? task.developmentContext.path
      : project?.workspacePath;
    if (!configuredPath) {
      throw new ApiError(409, "WORKSPACE_REQUIRED", "The selected development context has no local workspace");
    }
    let workspacePath;
    try {
      workspacePath = await realpath(configuredPath);
    } catch {
      throw new ApiError(409, "WORKSPACE_UNAVAILABLE", "The selected development context is not accessible");
    }
    const { stdout: rootOutput } = await runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
    const repositoryRoot = await realpath(rootOutput.trim());
    if (repositoryRoot !== workspacePath) {
      throw new ApiError(409, "WORKSPACE_NOT_ROOT", "Coding workflow development context must be a Git repository root");
    }
    if (task.developmentContext.type === "branch") {
      const { stdout } = await runGit(workspacePath, ["branch", "--show-current"]);
      if (stdout.trim() !== task.developmentContext.branch) {
        throw new ApiError(409, "BRANCH_MISMATCH", "The project workspace is not on the task branch");
      }
    }
    return workspacePath;
  }

  async assertClaimable(task) {
    if (task.workflowId !== CODING_WORKFLOW_ID) return null;
    const workspacePath = await this.workspaceForTask(task);
    const { stdout: status } = await runGit(
      workspacePath,
      ["status", "--porcelain", "--untracked-files=all"],
    );
    if (status.trim()) {
      throw new ApiError(409, "DEVELOPMENT_CONTEXT_DIRTY", "Coding workflow requires a clean development context");
    }
    const { stdout } = await runGit(workspacePath, ["rev-parse", "HEAD"]);
    return { workspacePath, startRevision: stdout.trim() };
  }

  async createOrResumeRun(task, prepared) {
    if (task.workflowId !== CODING_WORKFLOW_ID) return null;
    const claim = prepared ?? await this.assertClaimable(task);
    return this.database.createOrResumeCodingRun(task.id, claim.startRevision);
  }

  async bindAndClaim(task, input) {
    if (task.version !== input.version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion: input.version,
        actualVersion: task.version,
      });
    }
    if (task.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be claimed");
    }
    if (task.status !== "todo") {
      throw new ApiError(409, "TASK_NOT_TODO", "Bind Coding & Claim requires a todo task");
    }
    if (task.workflowId !== null) {
      throw new ApiError(409, "WORKFLOW_ALREADY_BOUND", "Task already has a workflow");
    }
    const developmentContext = input.developmentContext ?? task.developmentContext;
    const claim = await this.assertClaimable({
      ...task,
      workflowId: CODING_WORKFLOW_ID,
      developmentContext,
    });
    return this.database.bindCodingAndClaim(
      task.id,
      input.version,
      input.threadId,
      input.actor,
      claim.startRevision,
      developmentContext,
    );
  }

  async runScopedCheck(runId, input) {
    const run = this.#requireRun(runId);
    if (run.phase !== "implementing") {
      throw new ApiError(409, "INVALID_CODING_PHASE", "Scoped checks require an implementing run");
    }
    const task = this.database.getTask(run.taskId);
    const workspacePath = await this.workspaceForTask(task);
    const files = normalizeRelativeFiles(input.files);
    if (typeof input.command !== "string" || input.command.length === 0 || input.command.length > 8_192) {
      throw new ApiError(400, "INVALID_COMMAND", "Coding check command is invalid");
    }
    const markerCount = input.command.split("{files}").length - 1;
    if (markerCount !== 1) {
      throw new ApiError(400, "SCOPED_COMMAND_REQUIRED", "Coding check command must contain exactly one {files} marker");
    }
    if (!["unit", "integration", "typecheck"].includes(input.kind)) {
      throw new ApiError(400, "INVALID_CHECK_KIND", "Coding check kind must be unit, integration, or typecheck");
    }
    const command = input.command.replace("{files}", files.map(shellQuote).join(" "));
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const result = await exec(command, {
        cwd: workspacePath,
        shell: process.platform === "win32" ? process.env.ComSpec : process.env.SHELL || "/bin/sh",
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: OUTPUT_LIMIT,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      stdout = typeof error.stdout === "string" ? error.stdout : "";
      stderr = typeof error.stderr === "string" ? error.stderr : String(error.message ?? error);
      exitCode = Number.isInteger(error.code) ? error.code : 1;
    }
    const changedFiles = await this.changedFiles(workspacePath);
    return this.database.recordCodingCheck(run.id, {
      body: `${input.kind}: ${exitCode === 0 ? "pass" : "fail"}`,
      metadata: {
        kind: input.kind,
        command,
        files,
        exitCode,
        stdout: stdout.slice(0, OUTPUT_LIMIT),
        stderr: stderr.slice(0, OUTPUT_LIMIT),
        revision: await this.revision(workspacePath),
      },
    }, changedFiles);
  }

  async addHandoff(runId, input) {
    const run = this.#requireRun(runId);
    const allowedPhase = input.targetRole === "orchestrator" ? "ready_to_commit" : "implementing";
    if (!["implementer", "verifier", "ui-verifier", "orchestrator"].includes(input.targetRole)) {
      throw new ApiError(400, "INVALID_CODING_ROLE", "Coding handoff target role is invalid");
    }
    if (run.phase !== allowedPhase) {
      throw new ApiError(409, "INVALID_CODING_PHASE", `Handoff to ${input.targetRole} requires a ${allowedPhase} run`);
    }
    let changedFiles = null;
    if (input.sourceRole === "implementer" && ["verifier", "ui-verifier"].includes(input.targetRole)) {
      const task = this.database.getTask(run.taskId);
      const workspacePath = await this.workspaceForTask(task);
      changedFiles = await this.changedFiles(workspacePath);
    }
    const artifact = this.database.addCodingArtifact(run.id, {
      kind: "handoff",
      ...input,
    });
    if (changedFiles) {
      return {
        artifact,
        run: this.database.setCodingChangedFiles(run.id, changedFiles),
      };
    }
    return { artifact, run: this.database.getCodingRun(run.id) };
  }

  async changedFiles(workspacePath) {
    const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      runGit(workspacePath, ["diff", "--name-only", "-z", "HEAD"], { encoding: "buffer" }),
      runGit(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer" }),
    ]);
    return [...new Set([
      ...Buffer.from(tracked).toString("utf8").split("\0"),
      ...Buffer.from(untracked).toString("utf8").split("\0"),
    ].filter(Boolean))].sort();
  }

  async revision(workspacePath) {
    const { stdout } = await runGit(workspacePath, ["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async recordVerdict(runId, input) {
    if (!["pass", "fail", "inconclusive"].includes(input.result)) {
      throw new ApiError(400, "INVALID_VERDICT", "Coding verdict must be pass, fail, or inconclusive");
    }
    const result = this.database.recordCodingVerdict(runId, input);
    if (result.blocked) {
      const task = this.database.getTask(result.run.taskId);
      const moved = this.database.moveTask(task.id, task.version, "blocked", undefined, task.threadId ?? undefined);
      this.database.createComment(task.id, {
        body: `Coding 工作流在 ${result.run.round} 轮实现后仍未通过，已阻塞。详见 coding run ${result.run.id}。`,
        threadId: task.threadId,
        actor: AGENT_ACTOR,
      });
      return { ...result, task: moved };
    }
    return result;
  }

  async commit(runId, message) {
    if (typeof message !== "string" || message.trim().length === 0 || message.length > 240 || message.includes("\n")) {
      throw new ApiError(400, "INVALID_COMMIT_MESSAGE", "Commit message must be one non-empty line up to 240 characters");
    }
    let run = this.#requireRun(runId);
    const task = this.database.getTask(run.taskId);
    const workspacePath = await this.workspaceForTask(task);
    if (run.phase === "in_review") {
      return this.#finishReview(run, run.changedFiles, run.commitSha, true);
    }
    if (run.phase === "ready_to_commit") {
      const changedFiles = await this.changedFiles(workspacePath);
      if (!sameFiles(changedFiles, run.changedFiles)) {
        throw new ApiError(409, "VERIFIED_FILE_SET_CHANGED", "Changed files no longer match the verified allowlist", {
          verifiedFiles: run.changedFiles,
          currentFiles: changedFiles,
        });
      }
      run = this.database.beginCodingCommit(run.id, {
        parentRevision: await this.revision(workspacePath),
        changedFiles: run.changedFiles,
        message: message.trim(),
      });
    }
    if (run.phase !== "committing") {
      throw new ApiError(409, "INVALID_CODING_PHASE", "Coding commit requires a passed verification verdict");
    }
    const intent = this.database.getCodingCommitIntent(run.id);
    if (!intent) throw new ApiError(409, "COMMIT_INTENT_MISSING", "Coding commit intent is missing");
    const headRevision = await this.revision(workspacePath);
    let commitSha = null;
    if (intent.changedFiles.length === 0) {
      const changedFiles = await this.changedFiles(workspacePath);
      if (headRevision !== intent.parentRevision || changedFiles.length > 0) {
        throw new ApiError(409, "COMMIT_RECOVERY_CONFLICT", "No-code result no longer matches the persisted commit intent");
      }
    } else if (headRevision === intent.parentRevision) {
      const changedFiles = await this.changedFiles(workspacePath);
      if (!sameFiles(changedFiles, intent.changedFiles)) {
        throw new ApiError(409, "VERIFIED_FILE_SET_CHANGED", "Changed files no longer match the commit intent", {
          verifiedFiles: intent.changedFiles,
          currentFiles: changedFiles,
        });
      }
      await runGit(workspacePath, ["add", "--", ...intent.changedFiles]);
      await runGit(workspacePath, ["commit", "-m", intent.message]);
      commitSha = await this.revision(workspacePath);
    } else if (intent.changedFiles.length > 0) {
      const [{ stdout: parent }, { stdout: committed }, { stdout: committedMessage }] = await Promise.all([
        runGit(workspacePath, ["rev-parse", `${headRevision}^`]),
        runGit(workspacePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", headRevision], { encoding: "buffer" }),
        runGit(workspacePath, ["log", "-1", "--pretty=%B", headRevision]),
      ]);
      const committedFiles = Buffer.from(committed).toString("utf8").split("\0").filter(Boolean).sort();
      if (
        parent.trim() !== intent.parentRevision
        || !sameFiles(committedFiles, intent.changedFiles)
        || committedMessage.trim() !== intent.message
      ) {
        throw new ApiError(409, "COMMIT_RECOVERY_CONFLICT", "HEAD does not match the persisted Coding commit intent");
      }
      commitSha = headRevision;
    }
    return this.#finishReview(run, intent.changedFiles, commitSha, false);
  }

  #finishReview(run, changedFiles, commitSha, idempotent) {
    const updatedRun = run.phase === "committing"
      ? this.database.markCodingRunCommitted(run.id, { changedFiles, commitSha })
      : run;
    let task = this.database.getTask(updatedRun.taskId);
    if (task.status !== "in_review") {
      if (task.status !== "in_progress") {
        throw new ApiError(409, "TASK_STATUS_CONFLICT", "Coding task is no longer in progress");
      }
      task = this.database.moveTask(
        task.id,
        task.version,
        "in_review",
        undefined,
        task.threadId ?? undefined,
        AGENT_ACTOR,
      );
    }
    const body = commitSha
      ? `Coding 工作流验证通过并已自动提交 ${commitSha.slice(0, 12)}。请验收结果。`
      : "Coding 工作流验证通过；本次无需代码变更，请验收结果。";
    if (!this.database.listComments(task.id).some((comment) => comment.body === body)) {
      this.database.createComment(task.id, {
        body,
        threadId: task.threadId,
        actor: AGENT_ACTOR,
      });
    }
    return { run: updatedRun, task, idempotent };
  }

  #requireRun(runId) {
    const run = this.database.getCodingRun(runId);
    if (!run || run.id !== runId) {
      throw new ApiError(404, "CODING_RUN_NOT_FOUND", `Coding run '${runId}' does not exist`);
    }
    return run;
  }
}
