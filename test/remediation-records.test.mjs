import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRepoState, loadServiceState, recordRemediationFailure, saveServiceState } from "../scripts/lib/state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  }).trim();
}

function writeConfig(configPath, workspaceDir, repoKey) {
  const yaml = `version: 2

repo:
  key: ${repoKey}
  github_slug: example/${repoKey}
  default_branch: main
  workspace_dir: ${JSON.stringify(workspaceDir)}

lifecycle:
  enabled: true
  target_mode: open
  target_name: all-open-issues
  pause_when_target_complete: false
  pause_when_budget_exhausted: false
  max_parallel_prs: 1
  max_runs_per_day: 1

issue_source:
  labels: []

dispatcher:
  enabled: false
  poll_interval_seconds: 5
  primary_max_workers: 1
  secondary_max_workers: 0

models:
  dispatcher:
    primary:
      name: gpt-5.3-codex-spark
      reasoning_effort: high
    secondary:
      name: gpt-5.4
      reasoning_effort: medium
  reviewer:
    name: gpt-5.4
    reasoning_effort: medium

validation:
  enabled: true
  context: validate
  poll_interval_seconds: 30
  max_concurrent: 1
  commands:
    - printf 'induced validator failure\\n' >&2; exit 1
  post_status: false

reviewer:
  enabled: false
  poll_interval_seconds: 60
  max_concurrent: 1
  post_mode: comment

runner_manager:
  enabled: false

pr_manager:
  enabled: true
  interval_seconds: 30
  merge_concurrency: 1

monitor:
  enabled: false
  poll_interval_seconds: 30

safety:
  pr_only: true
  auto_merge: false
  protected_branches:
    - main
  protected_paths: []
  allow_force_push: false
  require_clean_worktree_before_run: false

budgets:
  max_estimated_credits_per_day: null
  pause_reason_on_budget: budget exhausted

branches:
  work_branch_prefix: autonomous/
  pr_base_branch: main

roles:
  enabled:
    autonomous: false
    dispatcher: false
    validator: true
    reviewer: false
    runner-manager: false
    pr-manager: true
    monitor: false
    dashboard: false

dashboard:
  enabled: false
  port: 4700
  expose_issue_details: false
  expose_pr_links: false
`;
  fs.writeFileSync(configPath, yaml);
}

function initTempGitRepo(rootDir) {
  const originDir = path.join(rootDir, "origin.git");
  const workspaceDir = path.join(rootDir, "workspace");

  run("git", ["init", "--bare", originDir]);
  fs.mkdirSync(workspaceDir, { recursive: true });
  run("git", ["init", "--initial-branch=main"], { cwd: workspaceDir });
  run("git", ["config", "user.name", "Test User"], { cwd: workspaceDir });
  run("git", ["config", "user.email", "test@example.com"], { cwd: workspaceDir });
  fs.writeFileSync(path.join(workspaceDir, "README.md"), "base\n");
  run("git", ["add", "README.md"], { cwd: workspaceDir });
  run("git", ["commit", "-m", "Initial commit"], { cwd: workspaceDir });
  run("git", ["remote", "add", "origin", originDir], { cwd: workspaceDir });
  run("git", ["push", "-u", "origin", "main"], { cwd: workspaceDir });

  run("git", ["checkout", "-b", "feature/remediation-failure"], { cwd: workspaceDir });
  fs.writeFileSync(path.join(workspaceDir, "README.md"), "base\nfailing change\n");
  run("git", ["add", "README.md"], { cwd: workspaceDir });
  run("git", ["commit", "-m", "Feature change"], { cwd: workspaceDir });
  run("git", ["push", "-u", "origin", "feature/remediation-failure"], { cwd: workspaceDir });

  const headSha = run("git", ["rev-parse", "HEAD"], { cwd: workspaceDir });
  run("git", [`--git-dir=${originDir}`, "update-ref", "refs/pull/123/head", headSha]);

  return { originDir, workspaceDir, headSha };
}

test("recordRemediationFailure creates durable records and increments attempts", () => {
  const repoState = { repoKey: "demo" };

  const first = recordRemediationFailure(repoState, {
    service: "validator",
    prNumber: 17,
    sha: "abc123",
    failureSummary: "validator failed",
    runLog: "/tmp/run.log",
    status: "open"
  });

  assert.equal(first.attempts, 1);
  assert.equal(repoState.remediationRecords.length, 1);

  const second = recordRemediationFailure(repoState, {
    service: "validator",
    prNumber: 17,
    sha: "abc123",
    failureSummary: "validator failed again",
    runLog: "/tmp/run-2.log",
    status: "open"
  });

  assert.equal(second.attempts, 2);
  assert.equal(repoState.remediationRecords.length, 1);
  assert.equal(repoState.remediationRecords[0].failureSummary, "validator failed again");
  assert.equal(repoState.remediationRecords[0].runLog, "/tmp/run-2.log");
});

test("validator failure writes a remediation record to repo state", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ae-remediation-test-"));

  try {
    const repoKey = "remediation-test";
    const stateDir = path.join(tempRoot, "state");
    const configPath = path.join(tempRoot, "repo.yaml");
    const { workspaceDir, headSha } = initTempGitRepo(tempRoot);
    writeConfig(configPath, workspaceDir, repoKey);

    saveServiceState(stateDir, repoKey, "pr-manager", {
      openPrs: [
        {
          number: 123,
          title: "Failing PR",
          headRefName: "feature/remediation-failure",
          headRefOid: headSha,
          headRepository: repoKey,
          headRepositoryOwner: "example",
          isCrossRepository: false,
          maintainerCanModify: false,
          baseRefName: "main",
          url: "https://example.test/pulls/123",
          isDraft: false,
          mergeStateStatus: "CLEAN",
          labels: []
        }
      ]
    });

    execFileSync(
      process.execPath,
      ["scripts/engine-role.mjs", "--role", "validator"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          AE_MODE: "once",
          AE_REPO_CONFIG: configPath,
          AE_STATE_DIR: stateDir
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const repoState = loadRepoState(stateDir, repoKey);
    const validatorState = loadServiceState(stateDir, repoKey, "validator");
    const record = repoState.remediationRecords.find(
      (entry) => entry.service === "validator" && entry.prNumber === 123 && entry.sha === headSha
    );

    assert.ok(record, "expected remediation record for failing validator run");
    assert.equal(record.status, "open");
    assert.equal(record.attempts, 1);
    assert.equal(record.headRepository, repoKey);
    assert.equal(record.headRepositoryOwner, "example");
    assert.match(record.failureSummary, /command failed/i);
    assert.ok(record.runLog, "expected remediation record to include run log path");
    assert.ok(fs.existsSync(record.runLog), "expected remediation run log file to exist");
    assert.equal(validatorState.prs[123].result, "failure");
    assert.equal(validatorState.prs[123].sha, headSha);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
