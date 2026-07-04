import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadRepoState, loadServiceState, saveServiceState } from "../scripts/lib/state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD_SCRIPT = path.join(REPO_ROOT, "scripts", "dashboard-server.mjs");
const SERVICE_NAMES = [
  "autonomous",
  "dispatcher",
  "validator",
  "reviewer",
  "runner-manager",
  "pr-manager",
  "monitor"
];

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mode != null) {
    fs.chmodSync(filePath, mode);
  }
}

function createMockCommands(binDir, dockerStatePath) {
  writeFile(
    path.join(binDir, "docker"),
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.AE_TEST_DOCKER_STATE;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : {};

function save() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function statusFor(name) {
  return state[name] ?? null;
}

if (args[0] === "inspect") {
  const name = args[1];
  const status = statusFor(name);
  if (!status) {
    process.stderr.write(\`Error: No such object: \${name}\\n\`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    Status: status,
    Running: status === "running",
    Restarting: status === "restarting",
    ExitCode: status === "exited" ? 0 : null
  }));
  process.exit(0);
}

if (args[0] === "start") {
  state[args[1]] = "running";
  save();
  process.exit(0);
}

if (args[0] === "stop") {
  state[args[1]] = "exited";
  save();
  process.exit(0);
}

if (args[0] === "restart") {
  state[args[1]] = "running";
  save();
  process.exit(0);
}

process.stderr.write(\`Unsupported docker args: \${args.join(" ")}\\n\`);
process.exit(1);
`,
    0o755
  );

  writeFile(
    path.join(binDir, "gh"),
    `#!/usr/bin/env node
process.stdout.write("[]");
`,
    0o755
  );
}

function createConfig(configPath, workspaceDir, port) {
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
    - printf validator-ok
  post_status: true

reviewer:
  enabled: true
  poll_interval_seconds: 30
  max_concurrent: 1
  post_mode: comment

runner_manager:
  enabled: true
  required_labels: []
  runner_labels: []
  image_name: test
  container_prefix: test
  max_runners: 1
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

dashboard:
  enabled: true
  port: ${port}
  expose_issue_details: false
  expose_pr_links: false
`
  );
}

function requestJson(method, port, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: payload == null
          ? {}
          : {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload)
            }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const parsed = raw.trim() ? JSON.parse(raw) : null;
          resolve({ statusCode: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload != null) {
      req.write(payload);
    }
    req.end();
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson("GET", port, "/health");
      if (response.statusCode === 200) {
        return;
      }
    } catch {
      // Keep polling until the server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("dashboard server did not become ready");
}

async function createDashboardFixture(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-dashboard-runner-manager-"));
  const binDir = path.join(tempDir, "bin");
  const stateDir = path.join(tempDir, "state");
  const workspaceDir = path.join(tempDir, "workspace");
  const configPath = path.join(tempDir, "config.yaml");
  const dockerStatePath = path.join(tempDir, "docker-state.json");
  const port = 25000 + Math.floor(Math.random() * 10_000);
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const dockerState = Object.fromEntries(
    SERVICE_NAMES.map((service) => [`commons-devloop-${service}-1`, "exited"])
  );
  fs.writeFileSync(dockerStatePath, JSON.stringify(dockerState, null, 2));
  createMockCommands(binDir, dockerStatePath);
  createConfig(configPath, workspaceDir, port);

  const proc = spawn(process.execPath, [DASHBOARD_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AE_REPO_CONFIG: configPath,
      AE_STATE_DIR: stateDir,
      AE_DASHBOARD_PORT: String(port),
      AE_TEST_DOCKER_STATE: dockerStatePath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  t.after(() => {
    proc.kill("SIGTERM");
  });

  await waitForServer(port);

  return {
    stateDir,
    port,
    stderr
  };
}

test("dashboard keeps runner-manager in the standard service model and persists lifecycle state", async (t) => {
  const fixture = await createDashboardFixture(t);

  const initial = await requestJson("GET", fixture.port, "/api/state");
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.body.services["runner-manager"].state.lifecycle, "stopped");
  assert.equal(initial.body.services["runner-manager"].state.desiredEnabled, true);
  assert.equal(initial.body.controlState.desiredServices["runner-manager"], true);
  assert.equal(Object.hasOwn(initial.body, "license"), false);

  const initialServiceState = loadServiceState(fixture.stateDir, "test-repo", "runner-manager");
  assert.equal(initialServiceState.enabled, true);
  assert.equal(initialServiceState.alive, false);
  assert.equal(initialServiceState.lifecycle, "stopped");
  assert.match(initialServiceState.summary, /stopped|container exited/);

  const initialRepoState = loadRepoState(fixture.stateDir, "test-repo");
  assert.equal(initialRepoState.services["runner-manager"].lifecycle, "stopped");
  assert.equal(initialRepoState.services["runner-manager"].enabled, true);

  const stopResponse = await requestJson("POST", fixture.port, "/api/service/runner-manager/stop", {});
  assert.equal(stopResponse.statusCode, 200);

  const stopped = await requestJson("GET", fixture.port, "/api/state");
  assert.equal(stopped.body.services["runner-manager"].state.lifecycle, "stopped");
  assert.equal(stopped.body.services["runner-manager"].state.desiredEnabled, false);

  const stoppedServiceState = loadServiceState(fixture.stateDir, "test-repo", "runner-manager");
  assert.equal(stoppedServiceState.enabled, false);
  assert.equal(stoppedServiceState.alive, false);
  assert.equal(stoppedServiceState.lifecycle, "stopped");

  const startResponse = await requestJson("POST", fixture.port, "/api/service/runner-manager/start", {});
  assert.equal(startResponse.statusCode, 200);

  const started = await requestJson("GET", fixture.port, "/api/state");
  assert.equal(started.body.services["runner-manager"].state.lifecycle, "running");
  assert.equal(started.body.services["runner-manager"].state.desiredEnabled, true);

  const startedServiceState = loadServiceState(fixture.stateDir, "test-repo", "runner-manager");
  assert.equal(startedServiceState.enabled, true);
  assert.equal(startedServiceState.alive, true);
  assert.equal(startedServiceState.lifecycle, "running");
  assert.doesNotMatch(startedServiceState.summary ?? "", /stopped|exited/);
  assert.match(startedServiceState.summary ?? "", /running|queued job/);

  const startedRepoState = loadRepoState(fixture.stateDir, "test-repo");
  assert.equal(startedRepoState.services["runner-manager"].lifecycle, "running");
  assert.equal(startedRepoState.services["runner-manager"].enabled, true);

  const resetResponse = await requestJson("POST", fixture.port, "/api/service/runner-manager/reset", {});
  assert.equal(resetResponse.statusCode, 200);
  assert.equal(resetResponse.body.action, "reset");

  const reset = await requestJson("GET", fixture.port, "/api/state");
  assert.equal(reset.body.services["runner-manager"].state.lifecycle, "running");
  assert.equal(reset.body.services["runner-manager"].state.desiredEnabled, true);

  const resetServiceState = loadServiceState(fixture.stateDir, "test-repo", "runner-manager");
  assert.equal(resetServiceState.enabled, true);
  assert.equal(resetServiceState.alive, true);
  assert.equal(resetServiceState.lifecycle, "running");
  assert.match(resetServiceState.summary ?? "", /running|reset requested|queued job/);
}, { timeout: 20_000 });

test("dashboard exposes PR requeue actions for validator and reviewer records", async (t) => {
  const fixture = await createDashboardFixture(t);

  const validatorState = loadServiceState(fixture.stateDir, "test-repo", "validator");
  validatorState.prs = {
    101: {
      title: "stuck validator PR",
      sha: "validator-sha-a",
      result: "failure",
      updated_at: "2026-04-18T00:00:00.000Z",
      run_log: "/tmp/validator.log",
      failure_summary: "validator failed",
      failure_count: 3,
      last_attempt_at: "2026-04-18T00:00:01.000Z",
      next_retry_at: "2026-04-20T00:00:00.000Z",
      remediation_status: "retry_waiting"
    },
    202: {
      title: "healthy validator PR",
      sha: "validator-sha-b",
      result: "success",
      updated_at: "2026-04-18T00:00:00.500Z",
      run_log: "/tmp/validator-success.log",
      failure_summary: null,
      failure_count: 0,
      last_attempt_at: "2026-04-18T00:00:00.500Z",
      next_retry_at: null,
      remediation_status: "none"
    }
  };
  saveServiceState(fixture.stateDir, "test-repo", "validator", validatorState);

  const reviewerState = loadServiceState(fixture.stateDir, "test-repo", "reviewer");
  reviewerState.prs = {
    303: {
      title: "stuck reviewer PR",
      sha: "reviewer-sha-a",
      result: "failure",
      updated_at: "2026-04-18T00:00:00.000Z",
      run_log: "/tmp/reviewer.log",
      failure_summary: "reviewer failed",
      failure_count: 2,
      last_attempt_at: "2026-04-18T00:00:01.000Z",
      next_retry_at: "2026-04-20T00:00:00.000Z",
      remediation_status: "retry_waiting"
    },
    404: {
      title: "other reviewer PR",
      sha: "reviewer-sha-b",
      result: "success",
      updated_at: "2026-04-18T00:00:00.500Z",
      run_log: "/tmp/reviewer-success.log",
      failure_summary: null,
      failure_count: 0,
      last_attempt_at: "2026-04-18T00:00:00.500Z",
      next_retry_at: null,
      remediation_status: "none"
    }
  };
  saveServiceState(fixture.stateDir, "test-repo", "reviewer", reviewerState);

  const pendingResponse = await requestJson("POST", fixture.port, "/api/requeue/validator/pending", {
    prNumber: 101
  });
  assert.equal(pendingResponse.statusCode, 200);

  const afterPendingValidator = loadServiceState(fixture.stateDir, "test-repo", "validator");
  assert.equal(afterPendingValidator.prs[101].result, "pending");
  assert.equal(afterPendingValidator.prs[101].remediation_status, "retry_running");
  assert.equal(afterPendingValidator.prs[101].next_retry_at, null);
  assert.equal(afterPendingValidator.prs[101].failure_count, 3);
  assert.equal(afterPendingValidator.prs[101].failure_summary, "validator failed");
  assert.deepEqual(afterPendingValidator.prs[202], validatorState.prs[202]);

  const clearResponse = await requestJson("POST", fixture.port, "/api/requeue/reviewer/clear", {
    prNumber: 303
  });
  assert.equal(clearResponse.statusCode, 200);

  const afterClearReviewer = loadServiceState(fixture.stateDir, "test-repo", "reviewer");
  assert.equal(Object.hasOwn(afterClearReviewer.prs, "303"), false);
  assert.deepEqual(afterClearReviewer.prs[404], reviewerState.prs[404]);
}, { timeout: 20_000 });

test("dashboard rejects invalid requeue inputs", async (t) => {
  const fixture = await createDashboardFixture(t);

  const invalidServiceResponse = await requestJson("POST", fixture.port, "/api/requeue/dispatcher/pending", {
    prNumber: 101
  });
  assert.equal(invalidServiceResponse.statusCode, 404);

  const invalidPrResponse = await requestJson("POST", fixture.port, "/api/requeue/validator/pending", {
    prNumber: -7
  });
  assert.equal(invalidPrResponse.statusCode, 400);

  const missingPrResponse = await requestJson("POST", fixture.port, "/api/requeue/validator/pending", {
    prNumber: 555
  });
  assert.equal(missingPrResponse.statusCode, 404);
}, { timeout: 20_000 });
