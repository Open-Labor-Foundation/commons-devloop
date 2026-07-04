import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { prepareBranchWorktree } from "../scripts/lib/runtime.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function buildRepoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ae-branch-worktree-"));
  const originDir = path.join(root, "origin.git");
  const workDir = path.join(root, "work");
  const worktreeRoot = path.join(root, "worktrees");

  git(["init", "--bare", "--initial-branch=main", originDir], root);
  git(["clone", originDir, workDir], root);
  git(["config", "user.email", "test@example.invalid"], workDir);
  git(["config", "user.name", "Test"], workDir);
  fs.writeFileSync(path.join(workDir, "README.md"), "hello\n");
  git(["add", "README.md"], workDir);
  git(["commit", "-m", "initial"], workDir);
  git(["push", "origin", "main"], workDir);

  // Mirrors labor-commons' real deployed remote config: origin.fetch is scoped
  // to main only, not the usual "+refs/heads/*:refs/remotes/origin/*" wildcard
  // a plain clone would otherwise leave in place for every other branch.
  git(["config", "--replace-all", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"], workDir);

  const branchName = "autonomous/2-some-remediation-branch";
  git(["checkout", "-b", branchName], workDir);
  fs.writeFileSync(path.join(workDir, "change.md"), "change\n");
  git(["add", "change.md"], workDir);
  git(["commit", "-m", "remediation work"], workDir);
  git(["push", "origin", branchName], workDir);
  git(["checkout", "main"], workDir);

  return { root, workDir, worktreeRoot, branchName };
}

test("prepareBranchWorktree sets up tracking for a remediation branch when origin.fetch is scoped to main only", () => {
  const { workDir, worktreeRoot, branchName } = buildRepoFixture();

  const targetDir = prepareBranchWorktree({
    repoDir: workDir,
    worktreeRoot,
    branchName,
    baseBranch: "main",
    startPoint: branchName,
    repoSlug: "example-owner/example-repo"
  });

  assert.ok(fs.existsSync(targetDir));
  const upstream = git(["rev-parse", "--abbrev-ref", `${branchName}@{upstream}`], targetDir);
  assert.equal(upstream, `origin/${branchName}`);
});
