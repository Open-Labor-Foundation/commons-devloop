import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD_SCRIPT = path.join(REPO_ROOT, "scripts", "dashboard-server.mjs");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
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

models:
  dispatcher:
    lanes:
      - key: primary
        label: Primary lane
        provider: hosted_codex
        name: gpt-5.4
        reasoning_effort: medium
        max_workers: 1
      - key: featherless
        label: Featherless lane
        provider: openai_compatible
        enabled: false
        name: Qwen/Qwen3-32B
        reasoning_effort: medium
        max_workers: 0
        runtime_endpoint: https://api.featherless.ai/v1
        api_key_env: TEST_FEATHERLESS_KEY
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

function requestJson(method, port, pathname, { body = null, token = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (payload != null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (token != null) {
      headers.authorization = `Bearer ${token}`;
    }
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        const parsed = raw.trim() ? JSON.parse(raw) : null;
        resolve({ statusCode: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function requestRaw(method, port, pathname, { token = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token != null ? { authorization: `Bearer ${token}` } : {};
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: raw, contentType: res.headers["content-type"] }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson("GET", port, "/health");
      if (response.statusCode === 200) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("dashboard server did not become ready");
}

async function createDashboardFixture(t, extraEnv = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-dashboard-auth-"));
  const stateDir = path.join(tempDir, "state");
  const workspaceDir = path.join(tempDir, "workspace");
  const configPath = path.join(tempDir, "config.yaml");
  const port = 26000 + Math.floor(Math.random() * 10_000);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  createConfig(configPath, workspaceDir, port);

  const proc = spawn(process.execPath, [DASHBOARD_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AE_REPO_CONFIG: configPath,
      AE_STATE_DIR: stateDir,
      AE_DASHBOARD_PORT: String(port),
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => proc.kill("SIGTERM"));
  await waitForServer(port);
  return { stateDir, port };
}

test("without AE_DASHBOARD_TOKEN, requests succeed unauthenticated (backward compatible)", async (t) => {
  const fixture = await createDashboardFixture(t);
  const state = await requestJson("GET", fixture.port, "/api/state");
  assert.equal(state.statusCode, 200);
});

test("with AE_DASHBOARD_TOKEN set, /health is exempt but /api/state requires a valid bearer token", async (t) => {
  const fixture = await createDashboardFixture(t, { AE_DASHBOARD_TOKEN: "secret-token-123" });

  const health = await requestJson("GET", fixture.port, "/health");
  assert.equal(health.statusCode, 200);

  const noAuth = await requestJson("GET", fixture.port, "/api/state");
  assert.equal(noAuth.statusCode, 401);

  const badAuth = await requestJson("GET", fixture.port, "/api/state", { token: "wrong-token" });
  assert.equal(badAuth.statusCode, 401);

  const goodAuth = await requestJson("GET", fixture.port, "/api/state", { token: "secret-token-123" });
  assert.equal(goodAuth.statusCode, 200);
});

test("with AE_DASHBOARD_TOKEN set, the app shell (/ and /assets/*) still loads without a token", async (t) => {
  // Regression: the app shell must be reachable pre-auth, or the browser can
  // never load the page that's supposed to prompt for the token in the
  // first place — the token screen would be unreachable.
  const fixture = await createDashboardFixture(t, { AE_DASHBOARD_TOKEN: "secret-token-123" });

  const index = await requestRaw("GET", fixture.port, "/");
  assert.equal(index.statusCode, 200);
  assert.match(index.contentType, /text\/html/);
  assert.match(index.body, /<div id="root">/);

  const scriptMatch = index.body.match(/src="(\/assets\/[^"]+\.js)"/);
  assert.ok(scriptMatch, "expected an /assets/*.js reference in the served index.html");
  const asset = await requestRaw("GET", fixture.port, scriptMatch[1]);
  assert.equal(asset.statusCode, 200);

  // But the actual data/control endpoints the app calls still require the token.
  const state = await requestJson("GET", fixture.port, "/api/state");
  assert.equal(state.statusCode, 401);
});

test("GET /api/lanes/keys reports lane key status without ever returning key material", async (t) => {
  // Must be set before the server subprocess is spawned — env is inherited
  // at spawn time, not read dynamically afterward.
  const fixture = await createDashboardFixture(t, { TEST_FEATHERLESS_KEY: "env-key-value" });
  const result = await requestJson("GET", fixture.port, "/api/lanes/keys");
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.lanes.featherless, { configured: true, source: "env" });
  assert.equal(JSON.stringify(result.body).includes("env-key-value"), false);
});

test("POST /api/lanes/:key/key stores a key that a later GET reflects as stored", async (t) => {
  const fixture = await createDashboardFixture(t);

  const setResult = await requestJson("POST", fixture.port, "/api/lanes/featherless/key", {
    body: { apiKey: "dashboard-entered-key" }
  });
  assert.equal(setResult.statusCode, 200);
  assert.equal(setResult.body.ok, true);
  assert.equal(JSON.stringify(setResult.body).includes("dashboard-entered-key"), false);

  const statusResult = await requestJson("GET", fixture.port, "/api/lanes/keys");
  assert.deepEqual(statusResult.body.lanes.featherless, { configured: true, source: "stored" });
});

test("POST /api/lanes/:key/key rejects an unknown lane", async (t) => {
  const fixture = await createDashboardFixture(t);
  const result = await requestJson("POST", fixture.port, "/api/lanes/does-not-exist/key", {
    body: { apiKey: "whatever" }
  });
  assert.equal(result.statusCode, 404);
});
