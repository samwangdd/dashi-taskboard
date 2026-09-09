import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../cli/taskctl.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("CLI hydrates a missing MR commit in isolation and executes only an exact authorized revision", { skip: process.platform === "win32" ? "POSIX executable fixtures; portable planner/adapter tests run on Windows" : false }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "integration-command-"));
  const oldPath = process.env.PATH;
  try {
    const upstream = path.join(dir, "upstream"), checkout = path.join(dir, "checkout"), bin = path.join(dir, "bin");
    await mkdir(upstream); await mkdir(bin);
    git(upstream, "init", "-b", "integration");
    git(upstream, "config", "user.name", "Fixture"); git(upstream, "config", "user.email", "fixture@example.com");
    await writeFile(path.join(upstream, "a.txt"), "base\n"); git(upstream, "add", "a.txt"); git(upstream, "commit", "-m", "base");
    const base = git(upstream, "rev-parse", "HEAD");
    git(dir, "clone", "--no-local", upstream, checkout);
    git(upstream, "checkout", "-b", "feature/source");
    await writeFile(path.join(upstream, "a.txt"), "source\n"); git(upstream, "commit", "-am", "source");
    const source = git(upstream, "rev-parse", "HEAD");
    git(checkout, "config", "user.name", "Fixture"); git(checkout, "config", "user.email", "fixture@example.com");
    git(checkout, "remote", "set-url", "origin", "https://gitlab.example/team/repo.git");
    git(checkout, "config", `url.${upstream}.insteadOf`, "https://gitlab.example/team/repo.git");
    assert.throws(() => git(checkout, "--no-replace-objects", "cat-file", "-e", `${source}^{commit}`));
    git(checkout, "update-ref", `refs/replace/${source}`, base);
    const before = git(checkout, "show-ref");
    const detail = { iid: 1, sha: source, source_branch: "feature/source", target_branch: "integration", updated_at: "v1", draft: false, blocking_discussions_resolved: true, detailed_merge_status: "mergeable", head_pipeline: { sha: source, status: "success" } };
    const writes = path.join(dir, "writes");
    const advance = path.join(dir, "advance-target"), retarget = path.join(dir, "retarget"), retargetOnPush = path.join(dir, "retarget-on-push");
    git(upstream, "branch", "main", base);
    await writeFile(path.join(bin, "glab"), `#!${process.execPath}\nconst fs = require('node:fs'); const cp=require('node:child_process'); const args = process.argv.slice(2); const e=args.find(a=>a.startsWith('projects/')); const target=cp.execFileSync('git',['rev-parse','refs/heads/integration'],{cwd:${JSON.stringify(upstream)},env:{...process.env,PATH:${JSON.stringify(oldPath)}},encoding:'utf8'}).trim(); const detail={...${JSON.stringify(detail)},state:target===${JSON.stringify(base)}?'opened':'merged'}; if(fs.existsSync(${JSON.stringify(retarget)})){detail.target_branch='main';detail.state='opened';} if(args.includes('PUT')) { fs.appendFileSync(${JSON.stringify(writes)},'write\\n'); process.exit(1); } let result; if(e.includes('repository/branches')) result={protected:false,commit:{id:target}}; else if(e.endsWith('/changes')) result={...detail,overflow:false,changes:[{old_path:'a.txt',new_path:'a.txt'}]}; else if(e.endsWith('/approvals')) result={approved:true}; else if(e.includes('merge_requests?')) result=[detail]; else result=detail; console.log(JSON.stringify(result));\n`, { mode: 0o755 });
    await writeFile(path.join(bin, "git"), `#!${process.execPath}\nconst cp=require('node:child_process'); const fs=require('node:fs'); const args=process.argv.slice(2); if(args.includes('push')){if(fs.existsSync(${JSON.stringify(advance)})) cp.execFileSync('git',['update-ref','refs/heads/integration',${JSON.stringify(source)}],{cwd:${JSON.stringify(upstream)},env:{...process.env,PATH:${JSON.stringify(oldPath)}}}); if(fs.existsSync(${JSON.stringify(retargetOnPush)})) fs.writeFileSync(${JSON.stringify(retarget)},'retargeted');} if(args.includes('remote') && args.includes('get-url')) console.log('https://gitlab.example/team/repo.git'); else { const result=cp.spawnSync('git',args,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(oldPath)}}}); process.exit(result.status??1); }\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    const policy = { runtimeEvidence: { "1": { sourceSha: source, targetSha: base, result: "passed", evidenceRef: "verified-fixture" } } };
    const invoke = async (args, readPolicy = async () => policy) => {
      let out = "", err = "";
      const code = await main(args, {
        env: { CODEX_TASKBOARD_URL: "http://127.0.0.1:4321" },
        stdout: { write: s => out += s }, stderr: { write: s => err += s },
        readIntegrationPolicy: readPolicy,
        fetch: async url => new Response(JSON.stringify(String(url).endsWith("/api/projects") ? { projects: [{ id: "p", workspacePath: checkout }] } : { tasks: [{ id: "i", version: 1, status: "in_review", labels: [], relations: {}, developmentContext: { branch: "feature/source" } }] })),
      });
      assert.equal(code, 0, err); return JSON.parse(out);
    };
    let plan = await invoke(["integration", "plan", "--project", "p", "--target", "integration"]);
    assert.equal(plan.plan.status, "ready", JSON.stringify(plan));
    assert.equal(plan.plan.candidates[0].state, "merge_ready");
    assert.equal(plan.plan.nextAction.type, "report");
    assert.equal(git(checkout, "show-ref"), before);
    assert.throws(() => git(checkout, "--no-replace-objects", "cat-file", "-e", `${source}^{commit}`));
    policy.authority = { projectId: "p", targetBranch: "integration", mode: "merge", method: "merge", maxActions: 1, transport: "git-cas-push", allowForceWithLease: true };
    plan = await invoke(["integration", "plan", "--project", "p", "--target", "integration"]);
    let policyReads = 0;
    const revoked = await invoke(["integration", "execute", "--project", "p", "--target", "integration", "--revision", plan.plan.revision], async () => ++policyReads > 1 ? {} : policy);
    assert.notEqual(revoked.status, "integrated");
    await writeFile(advance, "advance");
    const raced = await invoke(["integration", "execute", "--project", "p", "--target", "integration", "--revision", plan.plan.revision]);
    assert.equal(raced.status, "execution_error");
    assert.equal(git(upstream, "rev-parse", "refs/heads/integration"), source);
    await rm(advance);
    git(upstream, "update-ref", "refs/heads/integration", base);
    await writeFile(retargetOnPush, "retarget");
    const execution = await invoke(["integration", "execute", "--project", "p", "--target", "integration", "--revision", plan.plan.revision]);
    assert.equal(execution.status, "integrated", JSON.stringify(execution));
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(writes));
    assert.equal(git(upstream, "rev-parse", "refs/heads/integration"), execution.acceptedSha);
    assert.equal(git(upstream, "rev-list", "--parents", "-n1", execution.acceptedSha), `${execution.acceptedSha} ${base} ${source}`);
    assert.equal(git(checkout, "show-ref"), before);
    assert.equal(git(upstream, "rev-parse", "refs/heads/main"), base);
    assert.equal(execution.mergeRequestState, "integration_pending_provider_state");
    assert.equal(git(upstream, "show", `${execution.acceptedSha}:a.txt`), "source");
  } finally { process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true }); }
});
