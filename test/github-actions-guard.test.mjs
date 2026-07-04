import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNoAutoTriggeredGithubActions,
  findAutoTriggeredGithubActions
} from "../scripts/lib/github-actions-guard.mjs";

function createWorkspace(workflowContent) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ae-actions-guard-"));
  const workflows = path.join(workspace, ".github", "workflows");
  fs.mkdirSync(workflows, { recursive: true });
  fs.writeFileSync(path.join(workflows, "ci.yml"), workflowContent);
  return workspace;
}

test("GitHub Actions guard allows manual-only workflows", () => {
  const workspace = createWorkspace([
    "name: CI",
    "on:",
    "  workflow_dispatch:",
    ""
  ].join("\n"));

  assert.deepEqual(findAutoTriggeredGithubActions(workspace), []);
  assert.doesNotThrow(() => assertNoAutoTriggeredGithubActions({
    repo: { workspace_dir: workspace },
    safety: { disallow_github_actions_auto_triggers: true }
  }));
});

test("GitHub Actions guard rejects push and pull_request triggers", () => {
  const workspace = createWorkspace([
    "name: CI",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "    branches: [main]",
    ""
  ].join("\n"));

  assert.deepEqual(
    findAutoTriggeredGithubActions(workspace).map((finding) => finding.events),
    [["push", "pull_request"]]
  );
  assert.throws(
    () => assertNoAutoTriggeredGithubActions({
      repo: { workspace_dir: workspace },
      safety: { disallow_github_actions_auto_triggers: true }
    }),
    /GitHub Actions auto-trigger guard failed/
  );
});
