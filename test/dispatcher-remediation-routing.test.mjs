import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadRepoState, loadServiceState } from "../scripts/lib/state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLE_SCRIPT = path.join(REPO_ROOT, "scripts/engine-role.mjs");
const ISSUE_NUMBER = 11;
const PR_NUMBER = 17;
const PR_BRANCH = "autonomous/11-ls-10-dispatcher-remediation-routing-to-existing-pr-branches";
const PR_SHA = "abc123def456";
const REMEDIATED_SHA = "fedcba654321";
const FORK_OWNER = "octocat";
const FORK_REPO = "autonomous-engine-fork";
const FORK_BRANCH = "feature/repair-existing-pr";
const FORK_REMOTE = "pr-head-octocat-autonomous-engine-fork";

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mode != null) {
    fs.chmodSync(filePath, mode);
  }
}

function withConfigPath(configPath, callback) {
  const previousConfigPath = process.env.AE_REPO_CONFIG;
  const previousStackId = process.env.AE_STACK_ID;
  process.env.AE_REPO_CONFIG = configPath;
  process.env.AE_STACK_ID = path.parse(configPath).name;
  try {
    return callback();
  } finally {
    if (previousConfigPath == null) {
      delete process.env.AE_REPO_CONFIG;
    } else {
      process.env.AE_REPO_CONFIG = previousConfigPath;
    }
    if (previousStackId == null) {
      delete process.env.AE_STACK_ID;
    } else {
      process.env.AE_STACK_ID = previousStackId;
    }
  }
}

function createMockCommands(binDir) {
  writeFile(
    path.join(binDir, "git"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const logPath = process.env.AE_TEST_GIT_LOG;
const seedDir = process.env.AE_TEST_WORKTREE_SEED_DIR;
if (logPath) {
  fs.appendFileSync(logPath, \`\${args.join(" ")}\\n\`);
}
if (args[0] === "config" || args[0] === "fetch" || args[0] === "status") {
  process.exit(0);
}
if (args[0] === "remote" && args[1] === "get-url") {
  process.exit(1);
}
if (args[0] === "remote" && (args[1] === "add" || args[1] === "set-url")) {
  process.exit(0);
}
if (args[0] === "branch" && args[1] === "--set-upstream-to") {
  process.exit(0);
}
if (args[0] === "worktree" && args[1] === "remove") {
  fs.rmSync(args.at(-1), { recursive: true, force: true });
  process.exit(0);
}
if (args[0] === "worktree" && args[1] === "add") {
  const targetDir = args[2] === "--detach" ? args[3] : args[4];
  fs.mkdirSync(targetDir, { recursive: true });
  if (seedDir && fs.existsSync(seedDir)) {
    fs.cpSync(seedDir, targetDir, { recursive: true, force: true });
  }
  process.exit(0);
}
process.exit(0);
`,
    0o755
  );

  writeFile(
    path.join(binDir, "gh"),
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const logPath = process.env.AE_TEST_GH_LOG;
if (logPath) {
  fs.appendFileSync(logPath, \`\${args.join(" ")}\\n\`);
}
if (process.env.AE_GH_FAIL_PR_LIST === "1" && args[0] === "pr" && args[1] === "list") {
  console.error("simulated pr list failure");
  process.exit(1);
}
if (args[0] === "auth") {
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(JSON.stringify([
    {
      number: ${ISSUE_NUMBER},
      title: "LS-10: dispatcher remediation routing to existing PR branches",
      milestone: null,
      labels: [{ name: "codex-ready" }],
      url: "https://example.test/issues/${ISSUE_NUMBER}",
      updatedAt: "2026-04-03T00:00:00.000Z"
    }
  ]));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    number: ${ISSUE_NUMBER},
    title: "LS-10: dispatcher remediation routing to existing PR branches",
    body: "Route failed PRs back into dispatcher as remediation work on the same PR branch.",
    url: "https://example.test/issues/${ISSUE_NUMBER}",
    labels: [{ name: "codex-ready" }],
    milestone: null,
    assignees: []
  }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([
    {
      number: ${PR_NUMBER},
      title: "Existing remediation PR",
      headRefName: "${PR_BRANCH}",
      headRefOid: "${PR_SHA}",
      baseRefName: "main",
      url: "https://example.test/pr/${PR_NUMBER}",
      headRepository: { name: "test-repo" },
      headRepositoryOwner: { login: "example" },
      isCrossRepository: false,
      maintainerCanModify: false,
      labels: [],
      isDraft: false,
      mergeStateStatus: "CLEAN"
    }
  ]));
  process.exit(0);
}
process.stdout.write("[]");
`,
    0o755
  );

  writeFile(
    path.join(binDir, "codex"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const logPath = process.env.AE_TEST_CODEX_LOG;
const prompt = process.argv.at(-1) ?? "";
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
}
if (/Remediation intent: patch the existing PR branch in place\\./i.test(prompt)) {
  const seedDir = process.env.AE_TEST_WORKTREE_SEED_DIR;
  const repairedSha = process.env.AE_TEST_REMEDIATED_SHA;
  const prManagerStatePath = process.env.AE_TEST_PR_MANAGER_STATE_PATH;
  if (seedDir) {
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(path.join(seedDir, "remediation-fixed.txt"), "fixed\\n");
  }
  fs.writeFileSync(path.join(process.cwd(), "remediation-fixed.txt"), "fixed\\n");
  if (prManagerStatePath && repairedSha) {
    const state = JSON.parse(fs.readFileSync(prManagerStatePath, "utf8"));
    const pr = state?.pullRequestQueue?.prs?.[0];
    if (pr) {
      pr.headRefOid = repairedSha;
    }
    fs.writeFileSync(prManagerStatePath, JSON.stringify(state, null, 2) + "\\n");
  }
}
process.stdout.write("remediation run complete\\n");
`,
    0o755
  );
}

function readLastCodexPrompt(codexLogPath) {
  const lines = fs.readFileSync(codexLogPath, "utf8").trim().split("\n").filter(Boolean);
  const args = JSON.parse(lines.at(-1));
  return args.at(-1);
}

function createConfig(configPath, workspaceDir, options = {}) {
  const validationEnabled = options.validationEnabled ?? false;
  const validatorRoleEnabled = options.validatorRoleEnabled ?? validationEnabled;
  const validationCommands = options.validationCommands ?? ["printf validator-ok"];
  writeFile(
    configPath,
    `version: 2

repo:
  key: test-repo
  github_slug: example/test-repo
  default_branch: main
  workspace_dir: ${JSON.stringify(workspaceDir)}

lifecycle:
  enabled: true
  target_mode: open
  target_name: all-open-issues
  pause_when_target_complete: false
  pause_when_budget_exhausted: false
  max_parallel_prs: 1
  max_runs_per_day: 2

issue_source:
  labels: []

dispatcher:
  enabled: true
  poll_interval_seconds: 5
  primary_max_workers: 1
  secondary_max_workers: 0

models:
  dispatcher:
    primary:
      name: gpt-5.4
      reasoning_effort: medium
      pause_threshold_used_percent: 80
      weekly_pause_threshold_used_percent: 80
      reserve_burn_window_minutes: 300
      nominal_burn_per_lane_hour: 1
    secondary:
      name: gpt-5.4
      reasoning_effort: medium
      pause_threshold_used_percent: 80
      weekly_pause_threshold_used_percent: 80
      reserve_burn_window_minutes: 300
      nominal_burn_per_lane_hour: 1
  reviewer:
    name: gpt-5.4
    reasoning_effort: medium

validation:
  enabled: ${validationEnabled ? "true" : "false"}
  context: validate
  poll_interval_seconds: 30
  max_concurrent: 1
  commands:
${validationCommands.map((command) => `    - ${command}`).join("\n")}
  post_status: false

reviewer:
  enabled: false
  poll_interval_seconds: 30
  max_concurrent: 1
  post_mode: comment

runner_manager:
  enabled: false
  required_labels: []
  runner_labels: []
  image_name: test
  container_prefix: test
  max_runners: 0
  poll_interval_seconds: 30
  launch_cooldown_seconds: 30
  mount_docker_socket: false
  mount_workspace: false
  dry_run: true

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
  max_estimated_credits_per_day: 10
  pause_reason_on_budget: budget exhausted

branches:
  work_branch_prefix: autonomous/
  pr_base_branch: main

roles:
  enabled:
    autonomous: false
    dispatcher: true
    validator: ${validatorRoleEnabled ? "true" : "false"}
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
`
  );
}

function seedPrQueueState(stateDir, options = {}) {
  const pullRequest = {
    number: PR_NUMBER,
    title: "Existing remediation PR",
    headRefName: options.pullRequest?.headRefName ?? PR_BRANCH,
    headRefOid: options.pullRequest?.headRefOid ?? PR_SHA,
    headRepository: options.pullRequest?.headRepository ?? "test-repo",
    headRepositoryOwner: options.pullRequest?.headRepositoryOwner ?? "example",
    isCrossRepository: options.pullRequest?.isCrossRepository ?? false,
    maintainerCanModify: options.pullRequest?.maintainerCanModify ?? false,
    baseRefName: "main",
    url: `https://example.test/pr/${PR_NUMBER}`,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    labels: []
  };

  writeFile(
    path.join(stateDir, "repos", "test-repo", "meta", "pr-manager.json"),
    `${JSON.stringify({
      service: "pr-manager",
      alive: true,
      enabled: true,
      pullRequestQueue: {
        prs: [pullRequest],
        source: "github",
        updatedAt: "2026-04-03T00:00:00.000Z",
        lastSyncAt: "2026-04-03T00:00:00.000Z",
        lastSyncError: null
      }
    }, null, 2)}\n`
  );

  return pullRequest;
}

function seedState(stateDir, options = {}) {
  const pullRequest = seedPrQueueState(stateDir, options);
  const runLog = path.join(stateDir, "validator.log");
  fs.writeFileSync(
    runLog,
    options.runLogContent ?? "some-file.md:3 error MD022/blanks-around-headings Headings should be surrounded by blank lines\n"
  );
  const remediationRecord = {
    service: "validator",
    prNumber: PR_NUMBER,
    sha: pullRequest.headRefOid,
    branch: pullRequest.headRefName,
    headRepository: options.remediationRecord?.headRepository ?? pullRequest.headRepository,
    headRepositoryOwner: options.remediationRecord?.headRepositoryOwner ?? pullRequest.headRepositoryOwner,
    isCrossRepository: options.remediationRecord?.isCrossRepository ?? pullRequest.isCrossRepository,
    maintainerCanModify: options.remediationRecord?.maintainerCanModify ?? pullRequest.maintainerCanModify,
    failureSummary: "local validator failed",
    runLog,
    status: "open",
    attempts: 1,
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z"
  };

  writeFile(
    path.join(stateDir, "repos", "test-repo", "meta", "dispatcher.json"),
    `${JSON.stringify({
      service: "dispatcher",
      alive: true,
      enabled: true,
      items: [
        {
          number: ISSUE_NUMBER,
          title: "LS-10: dispatcher remediation routing to existing PR branches",
          url: `https://example.test/issues/${ISSUE_NUMBER}`,
          branch: pullRequest.headRefName,
          status: "completed",
          pr_url: `https://example.test/pr/${PR_NUMBER}`
        }
      ]
    }, null, 2)}\n`
  );

  writeFile(
    path.join(stateDir, "repos", "test-repo", "repo-state.json"),
    `${JSON.stringify({
      repoKey: "test-repo",
      status: "running",
      pauseReason: null,
      lastRoleRunAt: null,
      lastTargetCheckAt: null,
      targetComplete: false,
      runsToday: 0,
      services: {},
      remediationRecords: [remediationRecord],
      lastUpdatedAt: "2026-04-03T00:00:00.000Z"
    }, null, 2)}\n`
  );
}

test("local validator failure is re-dispatched on the same PR branch", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-dispatcher-remediation-e2e-"));
  const binDir = path.join(tempDir, "bin");
  const stateDir = path.join(tempDir, "state");
  const workspaceDir = path.join(tempDir, "workspace");
  const seedDir = path.join(tempDir, "branch-seed");
  const configPath = path.join(tempDir, "config.yaml");
  const ghLogPath = path.join(tempDir, "gh.log");
  const gitLogPath = path.join(tempDir, "git.log");
  const codexLogPath = path.join(tempDir, "codex.log");
  const prManagerStatePath = path.join(
    stateDir,
    "stacks",
    path.parse(configPath).name,
    "repos",
    "test-repo",
    "meta",
    "pr-manager.json"
  );

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(seedDir, { recursive: true });
  createMockCommands(binDir);
  createConfig(configPath, workspaceDir, {
    validationEnabled: true,
    validationCommands: ["test -f remediation-fixed.txt"]
  });
  seedPrQueueState(stateDir);

  const env = {
    ...process.env,
    AE_MODE: "once",
    AE_REPO_CONFIG: configPath,
    AE_STATE_DIR: stateDir,
    AE_TEST_GH_LOG: ghLogPath,
    AE_TEST_GIT_LOG: gitLogPath,
    AE_TEST_CODEX_LOG: codexLogPath,
    AE_TEST_WORKTREE_SEED_DIR: seedDir,
    AE_TEST_PR_MANAGER_STATE_PATH: prManagerStatePath,
    AE_TEST_REMEDIATED_SHA: REMEDIATED_SHA,
    PATH: `${binDir}:${process.env.PATH ?? ""}`
  };

  const validatorResult = spawnSync(process.execPath, [ROLE_SCRIPT, "--role", "validator"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env
  });
  assert.equal(validatorResult.status, 0, validatorResult.stderr);

  let repoState = withConfigPath(configPath, () => loadRepoState(stateDir, "test-repo"));
  let record = repoState.remediationRecords.find(
    (entry) => entry.service === "validator" && entry.prNumber === PR_NUMBER && entry.sha === PR_SHA
  );
  assert.ok(record, "expected validator remediation record before dispatch");
  assert.equal(record.status, "open");
  assert.equal(record.branch, PR_BRANCH);

  const dispatcherResult = spawnSync(process.execPath, [ROLE_SCRIPT, "--role", "dispatcher"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env
  });
  assert.equal(dispatcherResult.status, 0, dispatcherResult.stderr);

  const gitLog = fs.readFileSync(gitLogPath, "utf8");
  assert.match(
    gitLog,
    new RegExp(`fetch origin \\+${PR_BRANCH.replaceAll("/", "\\/")}:refs\\/remotes\\/origin\\/${PR_BRANCH.replaceAll("/", "\\/")}`)
  );
  assert.match(
    gitLog,
    new RegExp(`worktree add -B ${PR_BRANCH.replaceAll("/", "\\/")} .* refs\\/remotes\\/origin\\/${PR_BRANCH.replaceAll("/", "\\/")}`)
  );

  const codexPrompt = readLastCodexPrompt(codexLogPath);
  assert.match(codexPrompt, /Remediation mode: this is a branch-fix run for an existing pull request, not a new issue flow/i);
  assert.match(codexPrompt, /Remediation intent: patch the existing PR branch in place/i);
  assert.match(codexPrompt, /Reuse the existing pull request #17/);
  assert.match(codexPrompt, /Current head SHA: abc123def456/);
  assert.match(codexPrompt, /Failure log reference: .*pr-17-abc123def456\.log/);
  assert.match(codexPrompt, /Preserve the existing PR linkage back to issue #11/i);
  assert.match(codexPrompt, /Do not switch to a different branch or create a new worktree/i);
  assert.match(codexPrompt, /do not create a new branch, do not open a new PR/i);

  const dispatcherState = withConfigPath(configPath, () => loadServiceState(stateDir, "test-repo", "dispatcher"));
  assert.equal(dispatcherState.items[0].branch, PR_BRANCH);
  assert.equal(dispatcherState.items[0].pr_url, `https://example.test/pr/${PR_NUMBER}`);
  assert.ok(dispatcherState.items[0].payload_path, "expected remediation payload path");

  const remediationPayload = JSON.parse(fs.readFileSync(dispatcherState.items[0].payload_path, "utf8"));
  assert.equal(remediationPayload.mode, "remediation");
  assert.equal(remediationPayload.intent, "remediate_pull_request");
  assert.equal(remediationPayload.remediation.intent, "patch_existing_pull_request_branch");
  assert.equal(remediationPayload.remediation.worker_action, "branch_fix");
  assert.equal(remediationPayload.remediation.issue_flow, "reuse_existing_pull_request");
  assert.equal(remediationPayload.pull_request.number, PR_NUMBER);
  assert.equal(remediationPayload.pull_request.head_sha, PR_SHA);
  assert.equal(remediationPayload.failure.summary, "Command failed (1): test -f remediation-fixed.txt");
  assert.match(remediationPayload.failure.log_reference, /pr-17-abc123def456\.log$/);
  assert.equal(remediationPayload.constraints.patch_existing_pr_branch, true);
  assert.equal(remediationPayload.constraints.allow_branch_switching, false);
  assert.equal(remediationPayload.constraints.allow_new_branch, false);
  assert.equal(remediationPayload.constraints.allow_new_worktree, false);
  assert.equal(remediationPayload.constraints.allow_new_issue_flow, false);
  assert.equal(remediationPayload.constraints.allow_new_pr, false);

  repoState = withConfigPath(configPath, () => loadRepoState(stateDir, "test-repo"));
  record = repoState.remediationRecords.find(
    (entry) => entry.service === "validator" && entry.prNumber === PR_NUMBER && entry.sha === PR_SHA
  );
  assert.ok(record, "expected validator remediation record after dispatch");
  assert.equal(record.status, "completed");
  assert.equal(record.branch, PR_BRANCH);

  const secondValidatorResult = spawnSync(process.execPath, [ROLE_SCRIPT, "--role", "validator"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env
  });
  assert.equal(secondValidatorResult.status, 0, secondValidatorResult.stderr);

  const validatorState = withConfigPath(configPath, () => loadServiceState(stateDir, "test-repo", "validator"));
  assert.equal(validatorState.prs[PR_NUMBER].result, "success");
  assert.equal(validatorState.prs[PR_NUMBER].sha, REMEDIATED_SHA);
  assert.equal(validatorState.prs[PR_NUMBER].failure_summary, null);
});

test("dispatcher routes remediation onto the existing PR branch", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-dispatcher-remediation-"));
  const binDir = path.join(tempDir, "bin");
  const stateDir = path.join(tempDir, "state");
  const workspaceDir = path.join(tempDir, "workspace");
  const configPath = path.join(tempDir, "config.yaml");
  const ghLogPath = path.join(tempDir, "gh.log");
  const gitLogPath = path.join(tempDir, "git.log");
  const codexLogPath = path.join(tempDir, "codex.log");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  createMockCommands(binDir);
  createConfig(configPath, workspaceDir);
  seedState(stateDir);

  const result = spawnSync(process.execPath, [ROLE_SCRIPT, "--role", "dispatcher"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AE_MODE: "once",
      AE_REPO_CONFIG: configPath,
      AE_STATE_DIR: stateDir,
      AE_TEST_GH_LOG: ghLogPath,
      AE_TEST_GIT_LOG: gitLogPath,
      AE_TEST_CODEX_LOG: codexLogPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    }
  });

  assert.equal(result.status, 0, result.stderr);

  const gitLog = fs.readFileSync(gitLogPath, "utf8");
  assert.match(
    gitLog,
    new RegExp(`fetch origin \\+${PR_BRANCH.replaceAll("/", "\\/")}:refs\\/remotes\\/origin\\/${PR_BRANCH.replaceAll("/", "\\/")}`)
  );
  assert.match(
    gitLog,
    new RegExp(`worktree add -B ${PR_BRANCH.replaceAll("/", "\\/")} .* refs\\/remotes\\/origin\\/${PR_BRANCH.replaceAll("/", "\\/")}`)
  );
  assert.match(
    gitLog,
    new RegExp(`branch --set-upstream-to origin\\/${PR_BRANCH.replaceAll("/", "\\/")} ${PR_BRANCH.replaceAll("/", "\\/")}`)
  );

  const codexPrompt = readLastCodexPrompt(codexLogPath);
  assert.match(codexPrompt, /Remediation mode: this is a branch-fix run for an existing pull request, not a new issue flow/i);
  assert.match(codexPrompt, /Reuse the existing pull request #17/);
  assert.match(codexPrompt, /Current head SHA: abc123def456/);
  assert.match(codexPrompt, /Recorded remediation payload: .*issue-11-pr-17-abc123def456\.json/);
  assert.match(codexPrompt, /Preserve the existing PR linkage back to issue #11/i);
  assert.match(codexPrompt, /do not create a new branch, do not open a new PR/i);
  assert.match(codexPrompt, /Failure log excerpt/i);
  assert.match(codexPrompt, /some-file\.md:3 error MD022\/blanks-around-headings/);
  assert.match(codexPrompt, /prefer running that tool's own auto-fix command/i);
  assert.match(codexPrompt, /Original issue body \(background only.*already done.*do not redo its research requirements/is);
  assert.ok(
    codexPrompt.indexOf("Remediation mode:") < codexPrompt.indexOf("Original issue body"),
    "remediation context must appear before the original issue body, not buried after it"
  );

  const dispatcherState = withConfigPath(configPath, () => loadServiceState(stateDir, "test-repo", "dispatcher"));
  assert.equal(dispatcherState.items[0].pr_url, `https://example.test/pr/${PR_NUMBER}`);
  assert.match(dispatcherState.items[0].payload_path, /issue-11-pr-17-abc123def456\.json$/);

  const repoState = withConfigPath(configPath, () => loadRepoState(stateDir, "test-repo"));
  assert.equal(repoState.remediationRecords[0].branch, PR_BRANCH);
  assert.equal(repoState.remediationRecords[0].headRepositoryOwner, "example");
  assert.equal(repoState.remediationRecords[0].headRepository, "test-repo");
});

test("dispatcher preserves fork branch ownership when remediation uses cached PR state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-dispatcher-remediation-fork-"));
  const binDir = path.join(tempDir, "bin");
  const stateDir = path.join(tempDir, "state");
  const workspaceDir = path.join(tempDir, "workspace");
  const configPath = path.join(tempDir, "config.yaml");
  const ghLogPath = path.join(tempDir, "gh.log");
  const gitLogPath = path.join(tempDir, "git.log");
  const codexLogPath = path.join(tempDir, "codex.log");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  createMockCommands(binDir);
  createConfig(configPath, workspaceDir);
  seedState(stateDir, {
    pullRequest: {
      headRefName: FORK_BRANCH,
      headRepository: FORK_REPO,
      headRepositoryOwner: FORK_OWNER,
      isCrossRepository: true,
      maintainerCanModify: true
    }
  });

  const result = spawnSync(process.execPath, [ROLE_SCRIPT, "--role", "dispatcher"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AE_MODE: "once",
      AE_GH_FAIL_PR_LIST: "1",
      AE_REPO_CONFIG: configPath,
      AE_STATE_DIR: stateDir,
      AE_TEST_GH_LOG: ghLogPath,
      AE_TEST_GIT_LOG: gitLogPath,
      AE_TEST_CODEX_LOG: codexLogPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    }
  });

  assert.equal(result.status, 0, result.stderr);

  const gitLog = fs.readFileSync(gitLogPath, "utf8");
  assert.match(
    gitLog,
    new RegExp(`remote add ${FORK_REMOTE} https:\\/\\/github\\.com\\/${FORK_OWNER}\\/${FORK_REPO}\\.git`)
  );
  assert.match(
    gitLog,
    new RegExp(`fetch ${FORK_REMOTE} \\+${FORK_BRANCH.replaceAll("/", "\\/")}:refs\\/remotes\\/${FORK_REMOTE}\\/${FORK_BRANCH.replaceAll("/", "\\/")}`)
  );
  assert.match(
    gitLog,
    new RegExp(`branch --set-upstream-to ${FORK_REMOTE}\\/${FORK_BRANCH.replaceAll("/", "\\/")} ${FORK_BRANCH.replaceAll("/", "\\/")}`)
  );

  const codexPrompt = readLastCodexPrompt(codexLogPath);
  assert.match(codexPrompt, /Remediation mode: this is a branch-fix run for an existing pull request, not a new issue flow/i);
  assert.match(codexPrompt, new RegExp(`push commits back to the existing upstream branch in ${FORK_OWNER}\\/${FORK_REPO}`, "i"));
  assert.match(codexPrompt, new RegExp(`Recorded remediation payload: .*issue-11-pr-17-${PR_SHA}\\.json`));
  assert.match(codexPrompt, /Preserve the existing PR linkage back to issue #11/i);
  assert.doesNotMatch(codexPrompt, /Push the branch to origin/);

  const repoState = withConfigPath(configPath, () => loadRepoState(stateDir, "test-repo"));
  assert.equal(repoState.remediationRecords[0].branch, FORK_BRANCH);
  assert.equal(repoState.remediationRecords[0].headRepositoryOwner, FORK_OWNER);
  assert.equal(repoState.remediationRecords[0].headRepository, FORK_REPO);
});
