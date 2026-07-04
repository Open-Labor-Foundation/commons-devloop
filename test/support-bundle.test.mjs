import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import {
  buildSupportBundle,
  redactText,
  parseArgs
} from "../scripts/support-bundle.mjs";

const REDACTED_VALUE = "[REDACTED]";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixtureStateDirectory() {
  const root = makeTempDir("ae-bundle-fixture");
  const stackId = "fixture-stack";
  const repoKey = "fixture";

  const configPath = path.join(root, "config", "repos", "fixture.yaml");
  const stateDir = path.join(root, "state");
  const repoStateRoot = path.join(stateDir, "stacks", stackId, "repos", repoKey);
  const metaPath = path.join(repoStateRoot, "meta");
  const logsPath = path.join(repoStateRoot, "logs");
  const worktreePath = path.join(repoStateRoot, "worktrees", "dispatcher", "payload.txt");

  writeFile(
    configPath,
    YAML.stringify({
      repo: {
        key: repoKey,
        github_slug: "owner/fixture",
        default_branch: "main"
      },
      lifecycle: {},
      issue_source: {},
      safety: {},
      validation: {
        commands: ["echo ok"]
      },
      api_key: "sk-verysecret1234567890123",
      notes: "fixture-config"
    })
  );

  writeJson(path.join(stateDir, "repos", `${repoKey}.json`), {
    repoKey,
    status: "running",
    pauseReason: null
  });

  writeJson(path.join(repoStateRoot, "repo-state.json"), {
    repoKey,
    status: "running",
    services: {
      dispatcher: {
        alive: true
      }
    }
  });

  writeJson(path.join(repoStateRoot, "meta", "dispatcher.json"), {
    service: "dispatcher",
    alive: true,
    enabled: true,
    updatedAt: "2026-04-18T12:00:00.000Z"
  });

  writeJson(path.join(metaPath, "dispatcher-config.json"), {
    owner: "owner",
    repo: "fixture",
    baseBranch: "main",
    pollIntervalSeconds: 30
  });

  writeFile(path.join(logsPath, "dispatcher.log"), [
    "[2026-04-18T12:00:00.000Z] validator started",
    "[2026-04-18T12:00:01.000Z] token=ghp_aaaaaaaaaaaaaaaaaaaa",
    "[2026-04-18T12:00:02.000Z] completed"
  ].join("\n"));

  writeFile(worktreePath, "should not be included");

  writeFile(
    path.join(root, ".env"),
    `AE_STACK_ID=${stackId}
GH_TOKEN=ghp_secretplaceholder1234567890
PUBLIC_NOTE=ok`
  );

  writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "autonomous-engine-support-bundle-test",
      version: "1.2.3",
      private: true
    }, null, 2)
  );

  writeFile(
    path.join(root, "compose.yaml"),
    YAML.stringify({
      services: {
        dispatcher: { image: "autonomous-engine:local" }
      }
    })
  );

  return {
    root,
    stackId,
    repoKey,
    configPath: configPath,
    stateDir: path.join(root, "state"),
    envFile: path.join(root, ".env")
  };
}

test("redacts common token-like secrets in env, config, and logs", () => {
  const fixture = createFixtureStateDirectory();
  try {
    const bundle = buildSupportBundle({
      repoRoot: fixture.root,
      configPath: fixture.configPath,
      stateDir: fixture.stateDir,
      envFile: fixture.envFile,
      env: { ...process.env, AE_STACK_ID: "fixture-stack" },
      logsLines: 50
    });

    assert.equal(bundle.config.summary.raw.api_key, REDACTED_VALUE);
    assert.equal(bundle.env.present, true);
    assert.equal(bundle.env.entries.GH_TOKEN, REDACTED_VALUE);
    assert.equal(bundle.recentLogs.some((entry) => entry.lines.some((line) => line.includes(REDACTED_VALUE))), true);
    assert.match(bundle.env.redactedLines.join("\n"), new RegExp(REDACTED_VALUE, "g"));
    assert.equal(bundle.env.redactedLines.some((line) => line.includes("ghp_secretplaceholder1234567890")), false);
    assert.equal(bundle.config.summary.raw.api_key.includes("sk-verysecret"), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("buildSupportBundle summarizes a fixture state directory", () => {
  const fixture = createFixtureStateDirectory();
  try {
    const bundle = buildSupportBundle({
      repoRoot: fixture.root,
      configPath: fixture.configPath,
      stateDir: fixture.stateDir,
      envFile: fixture.envFile,
      env: { ...process.env, AE_STACK_ID: fixture.stackId },
      logsLines: 25
    });

    assert.equal(bundle.stackIdentity.repoKey, fixture.repoKey);
    assert.equal(bundle.stackIdentity.stackId, fixture.stackId);
    assert.equal(bundle.services.states.dispatcher.alive, true);
    assert.equal(bundle.services.configs.dispatcher.pollIntervalSeconds, 30);
    assert.equal(bundle.recentLogs.length > 0, true);
    assert.equal(bundle.worktrees.included, false);
    assert.equal(Array.isArray(bundle.warnings), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("parseArgs supports alias formats", () => {
  const options = parseArgs([
    "--config",
    "/tmp/config.yaml",
    "--state-dir",
    "/tmp/state",
    "--zip",
    "--logs-lines",
    "50"
  ], {
    AE_REPO_CONFIG: "/tmp/repo.yaml"
  });

  assert.equal(options.format, "zip");
  assert.equal(options.stateDir, "/tmp/state");
  assert.equal(options.logsLines, 50);
});

