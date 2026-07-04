import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadServiceState } from "../scripts/lib/state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLE_SCRIPT = path.join(REPO_ROOT, "scripts/engine-role.mjs");

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mode != null) {
    fs.chmodSync(filePath, mode);
  }
}

function loadServiceStateForConfig(stateDir, repoKey, serviceName, configPath) {
  const previousConfigPath = process.env.AE_REPO_CONFIG;
  const previousStackId = process.env.AE_STACK_ID;
  process.env.AE_REPO_CONFIG = configPath;
  process.env.AE_STACK_ID = path.parse(configPath).name;
  try {
    return loadServiceState(stateDir, repoKey, serviceName);
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
const args = process.argv.slice(2);
const logPath = process.env.AE_TEST_GIT_LOG;
if (logPath) {
  fs.appendFileSync(logPath, \`\${args.join(" ")}\\n\`);
}
if (args[0] === "config" || args[0] === "fetch" || args[0] === "status") {
  process.exit(0);
}
if (args[0] === "worktree" && args[1] === "remove") {
  fs.rmSync(args.at(-1), { recursive: true, force: true });
  process.exit(0);
}
if (args[0] === "worktree" && args[1] === "add") {
  const targetDir = args[2] === "--detach" ? args[3] : args[4];
  fs.mkdirSync(targetDir, { recursive: true });
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
if (args[0] === "api") {
  process.stdout.write("{}");
  process.exit(0);
}
if (args[0] === "pr" && (args[1] === "comment" || args[1] === "review")) {
  process.stdout.write("ok");
  process.exit(0);
}
process.stdout.write("[]");
`,
    0o755
  );

  writeFile(
    path.join(binDir, "codex"),
    `#!/usr/bin/env node
process.stdout.write("No actionable findings.\\n");
`,
    0o755
  );
}

function createConfig(configPath, workspaceDir, options = {}) {
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
  max_parallel_prs: 2
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
  enabled: true
  context: validate
  poll_interval_seconds: 30
  max_concurrent: 1
  bootstrap_commands: []
  commands:
${validationCommands.map((command) => `    - ${command}`).join("\n")}
  post_status: true

reviewer:
  enabled: true
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
  enabled: true
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
    autonomous: true
    dispatcher: true
    validator: true
    reviewer: true
    runner-manager: false
    pr-manager: true
    monitor: true
    dashboard: false

dashboard:
  enabled: false
  port: 4700
  expose_issue_details: false
  expose_pr_links: false
`
  );
}

function seedPullRequestQueue(stateDir) {
  writeFile(
    path.join(stateDir, "repos", "test-repo", "meta", "pr-manager.json"),
    `${JSON.stringify({
      service: "pr-manager",
      alive: true,
      enabled: true,
      pullRequestQueue: {
        prs: [
          {
            number: 17,
            title: "Cached PR",
            headRefName: "feature/local-queue",
            headRefOid: "abcdef1234567890",
            baseRefName: "main",
            url: "https://example.test/pr/17",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            labels: []
          }
        ],
        source: "github",
        updatedAt: "2026-04-03T00:00:00.000Z",
        lastSyncAt: "2026-04-03T00:00:00.000Z",
        lastSyncError: null
      }
    }, null, 2)}\n`
  );
}

function runRoleInFixture(role, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ae-${role}-queue-`));
  const binDir = path.join(tempDir, "bin");
  const stateDir = path.join(tempDir, "state");
  const workspaceDir = path.join(tempDir, "workspace");
  const configPath = path.join(tempDir, "config.yaml");
  const ghLogPath = path.join(tempDir, "gh.log");
  const gitLogPath = path.join(tempDir, "git.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  createMockCommands(binDir);
  createConfig(configPath, workspaceDir, options);
  seedPullRequestQueue(stateDir);

  const result = spawnSync(process.execPath, [ROLE_SCRIPT, "--role", role], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AE_MODE: "once",
      AE_REPO_CONFIG: configPath,
      AE_STATE_DIR: stateDir,
      AE_GH_FAIL_PR_LIST: "1",
      AE_TEST_GH_LOG: ghLogPath,
      AE_TEST_GIT_LOG: gitLogPath,
      ...(options.env ?? {}),
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    }
  });

  return {
    tempDir,
    stateDir,
    configPath,
    ghLog: fs.existsSync(ghLogPath) ? fs.readFileSync(ghLogPath, "utf8") : "",
    gitLog: fs.existsSync(gitLogPath) ? fs.readFileSync(gitLogPath, "utf8") : "",
    result
  };
}

test("validator schedules from the cached local PR queue during gh list failures", () => {
  const fixture = runRoleInFixture("validator");
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.doesNotMatch(fixture.ghLog, /\bpr list\b/);
  assert.match(fixture.ghLog, /\bapi\b.*\/statuses\/abcdef1234567890\b/);

  const validatorState = loadServiceStateForConfig(fixture.stateDir, "test-repo", "validator", fixture.configPath);
  assert.equal(validatorState.progress.source, "pr-manager-cache");
  assert.equal(validatorState.prs["17"].result, "success");
  assert.match(validatorState.summary, /scheduled from pr-manager-cache/);
});

test("reviewer schedules from the cached local PR queue during gh list failures", () => {
  const fixture = runRoleInFixture("reviewer");
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.doesNotMatch(fixture.ghLog, /\bpr list\b/);
  assert.match(fixture.ghLog, /\bpr comment 17\b/);

  const reviewerState = loadServiceStateForConfig(fixture.stateDir, "test-repo", "reviewer", fixture.configPath);
  assert.equal(reviewerState.progress.source, "pr-manager-cache");
  assert.equal(reviewerState.prs["17"].result, "success");
  assert.match(reviewerState.summary, /scheduled from pr-manager-cache/);
});

test("validator failure records retry backoff state instead of hot-looping immediately", () => {
  const fixture = runRoleInFixture("validator", {
    validationCommands: ["sh -lc 'echo induced-validator-failure >&2; exit 1'"]
  });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);

  const validatorState = loadServiceStateForConfig(fixture.stateDir, "test-repo", "validator", fixture.configPath);
  const record = validatorState.prs["17"];
  assert.equal(record.result, "failure");
  assert.equal(record.failure_count, 1);
  assert.equal(record.failure_summary, "Command failed (1): sh -lc 'echo induced-validator-failure >&2; exit 1'");
  assert.equal(record.remediation_status, "retry_waiting");
  assert.ok(record.last_attempt_at);
  assert.ok(record.next_retry_at);
  assert.ok(Date.parse(record.next_retry_at) > Date.parse(record.last_attempt_at));
});
