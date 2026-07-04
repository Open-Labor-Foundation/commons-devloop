import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDeploymentReadiness } from "../scripts/lib/deployment-readiness.mjs";
import { runPredeployCheck } from "../scripts/predeploy-check.mjs";

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ae-predeploy-"));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeRepoConfig(root, fileName, { repoKey = "fixture", dashboardPort = 4700 } = {}) {
  writeFile(
    path.join(root, "config", "repos", fileName),
    `version: 2

repo:
  key: ${repoKey}
  github_slug: owner/${repoKey}
  default_branch: main

lifecycle:
  enabled: true
  target_mode: open
  target_name: all-open-issues
  pause_when_target_complete: true
  pause_when_budget_exhausted: true
  max_parallel_prs: 1
  max_runs_per_day: 12

issue_source:
  labels:
    - codex-ready

models:
  dispatcher:
    primary:
      name: gpt-5.4
      reasoning_effort: high
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
    - npm test

safety:
  pr_only: true
  auto_merge: false
  protected_branches:
    - main
  protected_paths: []
  allow_force_push: false
  require_clean_worktree_before_run: true

dashboard:
  port: ${dashboardPort}
  expose_issue_details: true
  expose_pr_links: true
`
  );
}

test("default qa readiness profile passes for a valid repo config", () => {
  const root = makeTempRoot();
  writeRepoConfig(root, "commons-devloop.yaml", { repoKey: "commons-devloop" });

  const result = checkDeploymentReadiness({
    repoRoot: root,
    env: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].name, "qa");
  assert.equal(result.profiles[0].stackId, "commons-devloop");
  assert.equal(result.profiles[0].composeProjectName, "commons-devloop");
  assert.equal(result.profiles[0].dashboardPort, 4700);
  assert.deepEqual(result.errors, []);

  fs.rmSync(root, { recursive: true, force: true });
});

test("duplicate stack identity, compose project name, and dashboard port fail readiness", () => {
  const root = makeTempRoot();
  const qaTarget = path.join(root, "targets", "qa");
  const variantTarget = path.join(root, "targets", "variant");
  fs.mkdirSync(qaTarget, { recursive: true });
  fs.mkdirSync(variantTarget, { recursive: true });
  writeRepoConfig(root, "qa.yaml", { repoKey: "qa-repo", dashboardPort: 4700 });
  writeRepoConfig(root, "variant.yaml", { repoKey: "variant-repo", dashboardPort: 4700 });

  const result = checkDeploymentReadiness({
    repoRoot: root,
    env: {},
    profiles: [
      {
        name: "qa",
        config: "config/repos/qa.yaml",
        target_path: qaTarget,
        stack_id: "shared-stack",
        compose_project_name: "shared-stack"
      },
      {
        name: "variant",
        config: "config/repos/variant.yaml",
        target_path: variantTarget,
        stack_id: "shared-stack",
        compose_project_name: "shared-stack"
      }
    ]
  });

  assert.equal(result.ok, false);
  const errors = result.errors.join("\n");
  assert.match(errors, /Duplicate stack id "shared-stack"/);
  assert.match(errors, /Duplicate compose project name "shared-stack"/);
  assert.match(errors, /Duplicate dashboard port "4700"/);
  assert.equal(result.profiles[0].ok, false);
  assert.equal(result.profiles[1].ok, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test("predeploy CLI emits JSON output", () => {
  const root = makeTempRoot();
  writeRepoConfig(root, "commons-devloop.yaml", { repoKey: "autonomous-engine" });

  const result = runPredeployCheck(["--json"], {
    repoRoot: root,
    env: {}
  });
  const parsed = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.profiles[0].name, "qa");

  fs.rmSync(root, { recursive: true, force: true });
});
