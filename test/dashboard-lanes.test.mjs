import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";

function writeConfig() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-dashboard-lanes-"));
  const workspaceDir = path.join(tempDir, "target");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const configPath = path.join(tempDir, "repo.yaml");
  fs.writeFileSync(configPath, `version: 2

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
  max_parallel_prs: 3
  max_runs_per_day: 3

issue_source:
  labels: []

dispatcher:
  enabled: true
  poll_interval_seconds: 5
  skip_issue_numbers: []

models:
  dispatcher:
    lanes:
      - key: primary
        label: Primary lane
        provider: hosted_codex
        name: gpt-5.4
        reasoning_effort: medium
        max_workers: 1
      - key: secondary
        label: Secondary lane
        provider: hosted_codex
        name: gpt-5.3-codex-spark
        reasoning_effort: high
        max_workers: 0
      - key: local
        label: Local lane
        provider: local_container
        enabled: true
        name: qwen2.5-coder
        reasoning_effort: local
        max_workers: 1
        runtime_service: local-model
        runtime_endpoint: http://local-model:11434/v1
        num_ctx: 32768
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
  require_clean_worktree_before_run: false
`);
  return configPath;
}

const configPath = writeConfig();
const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-dashboard-lanes-bin-"));
fs.writeFileSync(path.join(mockBinDir, "docker"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "inspect") {
  process.stderr.write("Error: No such object\\n");
  process.exit(1);
}
process.exit(0);
`);
fs.chmodSync(path.join(mockBinDir, "docker"), 0o755);
fs.writeFileSync(path.join(mockBinDir, "curl"), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ models: [{ name: "qwen2.5-coder" }] }));
`);
fs.chmodSync(path.join(mockBinDir, "curl"), 0o755);
process.env.AE_REPO_CONFIG = configPath;
process.env.AE_DASHBOARD_NO_LISTEN = "1";
process.env.PATH = `${mockBinDir}${path.delimiter}${process.env.PATH}`;
const { buildLaneControl, buildLaneTelemetry, buildPolicyControl } = await import("../scripts/dashboard-server.mjs");

test("dashboard lane control exposes dynamic lane array and legacy lane mirrors", () => {
  const config = loadConfig(configPath);
  const control = buildLaneControl(config);

  assert.deepEqual(control.lanes.map((lane) => lane.key), ["primary", "secondary", "local"]);
  assert.equal(control.totalConcurrency, 2);
  assert.equal(control.activeLaneCount, 2);
  assert.equal(control.primary.model, "gpt-5.4");
  assert.equal(control.secondary.targetConcurrency, 0);
  assert.equal(control.local.provider, "local_container");
  assert.equal(control.local.runtimeService, "local-model");
  assert.equal(control.local.numCtx, 32768);
});

test("dashboard lane telemetry includes local runtime fields", () => {
  const config = loadConfig(configPath);
  const telemetry = buildLaneTelemetry(config, {
    lanes: {
      local: { targetConcurrency: 1 }
    },
    items: [
      {
        status: "running",
        assigned_lane: "local",
        assigned_model: "qwen2.5-coder"
      }
    ]
  });

  assert.equal(telemetry.lanes.length, 3);
  assert.equal(telemetry.local.key, "local");
  assert.equal(telemetry.local.provider, "local_container");
  assert.equal(telemetry.local.running, 1);
  assert.equal(telemetry.local.runtimeService, "local-model");
  assert.ok(["busy", "unavailable", "running", "disabled", "ready"].includes(telemetry.local.runtimeStatus));
});

test("dashboard policy control exposes editable repo identity", () => {
  const config = loadConfig(configPath);
  const control = buildPolicyControl(config);

  assert.deepEqual(control.repo, {
    key: "test-repo",
    githubSlug: "example/test-repo",
    defaultBranch: "main",
    workspaceDir: path.join(path.dirname(configPath), "target")
  });
});
