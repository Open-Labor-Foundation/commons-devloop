import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, getDispatcherLanes } from "../scripts/lib/config.mjs";

function writeConfig(content) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-lanes-config-"));
  const workspaceDir = path.join(tempDir, "target");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const configPath = path.join(tempDir, "repo.yaml");
  fs.writeFileSync(configPath, content.replaceAll("__WORKSPACE__", JSON.stringify(workspaceDir)));
  return configPath;
}

function baseConfig(extra) {
  return `version: 2

repo:
  key: test-repo
  github_slug: example/test-repo
  default_branch: main
  workspace_dir: __WORKSPACE__

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
${extra.dispatcher ?? "  primary_max_workers: 1\n  secondary_max_workers: 1"}
  skip_issue_numbers: []

models:
  dispatcher:
${extra.models}
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
`;
}

test("legacy dispatcher config normalizes to primary, secondary, and disabled local lanes", () => {
  const config = loadConfig(writeConfig(baseConfig({
    models: `    primary:
      name: gpt-5.3-codex-spark
      reasoning_effort: high
    secondary:
      name: gpt-5.4
      reasoning_effort: medium
`
  })));

  const lanes = getDispatcherLanes(config);
  assert.deepEqual(lanes.map((lane) => lane.key), ["primary", "secondary", "local"]);
  assert.equal(config.dispatcher.max_concurrency, 2);
  assert.equal(config.dispatcher.active_lane_count, 2);
  assert.equal(config.dispatcher.local_max_workers, 0);
  assert.equal(config.models.dispatcher.local.provider, "local_container");
  assert.equal(config.models.dispatcher.local.name, "qwen2.5-coder:7b");
  assert.equal(config.models.dispatcher.local.enabled, false);
});

test("lane-list dispatcher config enables a local container lane", () => {
  const config = loadConfig(writeConfig(baseConfig({
    dispatcher: "",
    models: `    lanes:
      - key: primary
        label: Primary lane
        provider: hosted_codex
        name: gpt-5.4
        reasoning_effort: medium
        max_workers: 1
      - key: local
        label: Local lane
        provider: local_container
        enabled: true
        name: qwen2.5-coder
        reasoning_effort: local
        max_workers: 1
        runtime_service: local-model
        runtime_endpoint: http://local-model:11434/v1
        num_thread: 24
        num_ctx: 32768
        runtime_command: "printf local"
`
  })));

  const lanes = getDispatcherLanes(config);
  const local = lanes.find((lane) => lane.key === "local");
  assert.equal(config.dispatcher.max_concurrency, 2);
  assert.equal(config.dispatcher.active_lane_count, 2);
  assert.equal(config.dispatcher.primary_max_workers, 1);
  assert.equal(config.dispatcher.secondary_max_workers, 0);
  assert.equal(config.dispatcher.local_max_workers, 1);
  assert.equal(local.provider, "local_container");
  assert.equal(local.name, "qwen2.5-coder");
  assert.equal(local.runtime_service, "local-model");
  assert.equal(local.num_thread, 24);
  assert.equal(local.num_ctx, 32768);
});

test("primary lane can run the Docker local model without enabling the separate local lane", () => {
  const config = loadConfig(writeConfig(baseConfig({
    dispatcher: "  primary_max_workers: 1\n  secondary_max_workers: 0\n  local_max_workers: 0",
    models: `    primary:
      name: qwen2.5-coder:7b
      reasoning_effort: local
    secondary:
      name: gpt-5.4
      reasoning_effort: medium
    local:
      enabled: false
      max_workers: 0
`
  })));

  const lanes = getDispatcherLanes(config);
  const primary = lanes.find((lane) => lane.key === "primary");
  const local = lanes.find((lane) => lane.key === "local");
  assert.equal(config.dispatcher.primary_max_workers, 1);
  assert.equal(config.dispatcher.secondary_max_workers, 0);
  assert.equal(config.dispatcher.local_max_workers, 0);
  assert.equal(config.dispatcher.max_concurrency, 1);
  assert.equal(primary.provider, "local_container");
  assert.equal(primary.runtime_service, "local-model");
  assert.equal(primary.runtime_endpoint, "http://local-model:11434/v1");
  assert.equal(primary.runtime_image, "ollama/ollama:latest");
  assert.equal(primary.local_provider, "ollama");
  assert.equal(primary.num_ctx, 0);
  assert.equal(local.enabled, false);
});

test("duplicate dispatcher lane keys are rejected", () => {
  assert.throws(() => loadConfig(writeConfig(baseConfig({
    dispatcher: "",
    models: `    lanes:
      - key: local
        provider: local_container
        max_workers: 0
      - key: local
        provider: local_container
        max_workers: 0
`
  }))), /duplicate dispatcher lane key: local/);
});

test("openai_compatible lane resolves a hosted endpoint without local_container defaults", () => {
  const config = loadConfig(writeConfig(baseConfig({
    dispatcher: "",
    models: `    lanes:
      - key: featherless
        label: Featherless lane
        provider: openai_compatible
        name: Qwen/Qwen3-32B
        reasoning_effort: medium
        max_workers: 1
        runtime_endpoint: https://api.featherless.ai/v1
        api_key_env: FEATHERLESS_API_KEY
`
  })));

  const lanes = getDispatcherLanes(config);
  const featherless = lanes.find((lane) => lane.key === "featherless");
  assert.equal(featherless.provider, "openai_compatible");
  assert.equal(featherless.runtime_endpoint, "https://api.featherless.ai/v1");
  assert.equal(featherless.api_key_env, "FEATHERLESS_API_KEY");
  // openai_compatible must not inherit local_container's Ollama-specific defaults.
  assert.equal(featherless.local_provider, "");
  assert.equal(featherless.runtime_service, "");
  assert.equal(featherless.num_thread, 0);
});

test("openai_compatible lane without runtime_endpoint is rejected when enabled with workers", () => {
  assert.throws(() => loadConfig(writeConfig(baseConfig({
    dispatcher: "",
    models: `    lanes:
      - key: featherless
        provider: openai_compatible
        name: Qwen/Qwen3-32B
        max_workers: 1
`
  }))), /openai_compatible dispatcher lane featherless requires runtime_endpoint/);
});

test("unsupported dispatcher lane provider is rejected", () => {
  assert.throws(() => loadConfig(writeConfig(baseConfig({
    dispatcher: "",
    models: `    lanes:
      - key: mystery
        provider: mystery_provider
        max_workers: 0
`
  }))), /unsupported dispatcher lane provider for mystery: mystery_provider/);
});
