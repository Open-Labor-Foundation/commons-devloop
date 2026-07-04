import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_SCRIPT = path.join(REPO_ROOT, "scripts", "check-local-lane.mjs");

function startOllamaStub({ models = [] }) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: String(server.address().port)
      });
    });
  });
}

function writeConfig(configPath, {
  runtimeEndpoint = "http://local-model:11434/v1",
  runtimeHealthUrl = "http://local-model:11434/api/tags"
} = {}) {
  fs.writeFileSync(configPath, `version: 2
repo:
  key: host-fallback
  github_slug: owner/repo
  default_branch: main
lifecycle:
  enabled: true
  target_mode: open
  target_name: all-open-issues
  pause_when_target_complete: true
  pause_when_budget_exhausted: true
  max_parallel_prs: 1
  max_runs_per_day: 16
issue_source:
  labels: []
dispatcher:
  enabled: true
  local_max_workers: 1
models:
  dispatcher:
    local:
      enabled: true
      name: qwen2.5-coder:7b
      max_workers: 1
      runtime_endpoint: ${runtimeEndpoint}
      runtime_health_url: ${runtimeHealthUrl}
      local_provider: ollama
validation:
  enabled: true
  commands:
    - npm test
safety:
  pr_only: true
  auto_merge: false
  protected_branches:
    - main
`);
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

test("check-local-lane can inspect Ollama through docker compose exec", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-check-local-lane-compose-"));
  const configPath = path.join(tempDir, "repo.yaml");
  const binDir = path.join(tempDir, "bin");
  writeConfig(configPath);
  writeExecutable(
    path.join(binDir, "docker"),
    `#!/bin/sh
printf 'NAME               ID              SIZE      MODIFIED\\n'
printf 'qwen2.5-coder:7b   abc123          4.7 GB    now\\n'
`
  );

  const result = await execFileAsync("node", [CHECK_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      AE_REPO_CONFIG: configPath
    }
  });

  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.lanes[0].endpoint, "compose://local-model");
});

test("check-local-lane can fall back to a configured Ollama HTTP endpoint", async () => {
  const { server, port } = await startOllamaStub({ models: ["qwen2.5-coder:7b"] });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-check-local-lane-http-"));
  const configPath = path.join(tempDir, "repo.yaml");
  const binDir = path.join(tempDir, "bin");
  const baseUrl = `http://127.0.0.1:${port}`;
  writeConfig(configPath, {
    runtimeEndpoint: `${baseUrl}/v1`,
    runtimeHealthUrl: `${baseUrl}/api/tags`
  });
  writeExecutable(
    path.join(binDir, "docker"),
    `#!/bin/sh
printf 'compose unavailable\\n' >&2
exit 1
`
  );

  try {
    const result = await execFileAsync("node", [CHECK_SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        AE_REPO_CONFIG: configPath
      }
    });
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.lanes[0].endpoint, baseUrl);
  } finally {
    server.close();
  }
});
