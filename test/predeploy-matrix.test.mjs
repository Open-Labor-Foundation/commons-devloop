import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluatePredeployMatrix } from "../scripts/predeploy-matrix.mjs";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createRepoConfig(root, name = "repo.yaml") {
  const configPath = path.join(root, "config", "repos", name);
  writeFile(configPath, `version: 2
repo:
  key: fixture
  github_slug: example/fixture
  default_branch: main
lifecycle:
  enabled: true
  target_mode: open
  target_name: fixture
  pause_when_target_complete: true
  pause_when_budget_exhausted: true
  max_parallel_prs: 1
  max_runs_per_day: 1
issue_source:
  labels: []
models:
  dispatcher:
    primary:
      name: gpt-5.4
      reasoning_effort: medium
      pause_threshold_used_percent: 80
      weekly_pause_threshold_used_percent: 80
      reserve_burn_window_minutes: 300
      nominal_burn_per_lane_hour: 3
    secondary:
      name: gpt-5.4
      reasoning_effort: medium
      pause_threshold_used_percent: 80
      weekly_pause_threshold_used_percent: 80
      reserve_burn_window_minutes: 300
      nominal_burn_per_lane_hour: 3
  reviewer:
    name: gpt-5.4
    reasoning_effort: medium
validation:
  commands:
    - true
safety:
  pr_only: true
  auto_merge: false
  protected_branches:
    - main
  protected_paths: []
  allow_force_push: false
  require_clean_worktree_before_run: true
dashboard:
  enabled: true
  port: 4999
  expose_issue_details: false
  expose_pr_links: false
`);
  return configPath;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ae-predeploy-matrix-"));
  const target = path.join(root, "target");
  fs.mkdirSync(target, { recursive: true });
  createRepoConfig(root);
  return { root, target };
}

test("predeploy check validates the default QA readiness profile", () => {
  const { root, target } = createFixture();
  const matrixPath = path.join(root, "matrix.yaml");
  writeFile(matrixPath, `version: 1
gates:
  require_phases: [qa]
profiles:
  - name: qa
    phase: qa
    repo_config: config/repos/repo.yaml
    stack_id: fixture-qa
    dashboard_port: 4800
    target_repo_path: ${JSON.stringify(target)}
`);

  const summary = evaluatePredeployMatrix(matrixPath, { requireTargets: true });

  assert.equal(summary.ok, true);
  assert.equal(summary.check, "deployment-readiness");
  assert.equal(summary.profileCount, 1);
  assert.deepEqual(summary.phases, ["qa"]);
  assert.deepEqual(summary.profiles.map((profile) => profile.stackId), ["fixture-qa"]);
  assert.deepEqual(summary.profiles.map((profile) => profile.dashboardPort), [4800]);
  assert.deepEqual(summary.profiles[0].requiredServices, [
    "autonomous",
    "dispatcher",
    "validator",
    "reviewer",
    "runner-manager",
    "pr-manager",
    "monitor",
    "dashboard"
  ]);
});

test("predeploy check still supports optional variant profiles", () => {
  const { root, target } = createFixture();
  const matrixPath = path.join(root, "matrix.yaml");
  writeFile(matrixPath, `version: 1
profiles:
  - name: qa
    phase: qa
    repo_config: config/repos/repo.yaml
    stack_id: fixture-qa
    dashboard_port: 4800
    target_repo_path: ${JSON.stringify(target)}
  - name: variant-a
    phase: a
    repo_config: config/repos/repo.yaml
    stack_id: fixture-a
    dashboard_port: 4810
    target_repo_path: ${JSON.stringify(target)}
`);

  const summary = evaluatePredeployMatrix(matrixPath, { requireTargets: true });

  assert.equal(summary.ok, true);
  assert.equal(summary.profileCount, 2);
  assert.deepEqual(summary.phases, ["a", "qa"]);
  assert.deepEqual(summary.profiles.map((profile) => profile.name), ["qa", "variant-a"]);
});

test("predeploy matrix fails duplicate runtime identities", () => {
  const { root } = createFixture();
  const matrixPath = path.join(root, "matrix.yaml");
  writeFile(matrixPath, `version: 1
profiles:
  - name: variant-a
    phase: a
    repo_config: config/repos/repo.yaml
    stack_id: duplicate
    dashboard_port: 4800
  - name: variant-b
    phase: b
    repo_config: config/repos/repo.yaml
    stack_id: duplicate
    dashboard_port: 4800
`);

  const summary = evaluatePredeployMatrix(matrixPath);

  assert.equal(summary.ok, false);
  assert.match(summary.failures.join("\n"), /duplicate stack identity: duplicate/);
  assert.match(summary.failures.join("\n"), /duplicate compose project name: duplicate/);
  assert.match(summary.failures.join("\n"), /duplicate dashboard port: 4800/);
});

test("predeploy check fails disabled required service defaults", () => {
  const { root } = createFixture();
  const configPath = path.join(root, "config", "repos", "repo.yaml");
  fs.appendFileSync(configPath, `roles:
  enabled:
    dispatcher: false
`);
  const matrixPath = path.join(root, "matrix.yaml");
  writeFile(matrixPath, `version: 1
profiles:
  - name: qa
    phase: qa
    repo_config: config/repos/repo.yaml
    stack_id: fixture-qa
    dashboard_port: 4800
`);

  const summary = evaluatePredeployMatrix(matrixPath);

  assert.equal(summary.ok, false);
  assert.match(summary.failures.join("\n"), /disabled required service defaults: dispatcher/);
});
