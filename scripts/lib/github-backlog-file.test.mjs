import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { getIssueDetails, listOpenIssuesForTarget, markBacklogIssueDone } from "./github.mjs";

function writeBacklogFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ae-backlog-file-"));
  const docsDir = path.join(root, "docs", "issues");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "GM-001.md"), "# GM-001\n");
  fs.writeFileSync(path.join(docsDir, "GM-002.md"), "# GM-002\n");
  fs.writeFileSync(path.join(docsDir, "GM-003.md"), "# GM-003\n");
  fs.writeFileSync(path.join(root, "issue-manifest.yaml"), [
    "version: 1",
    "issues:",
    "  - sequence: 1",
    "    id: GM-001",
    "    title: First completed item",
    "    status: done",
    "    depends_on: []",
    "    file: docs/issues/GM-001.md",
    "  - sequence: 2",
    "    id: GM-002",
    "    title: Ready item",
    "    status: todo",
    "    depends_on: [GM-001]",
    "    file: docs/issues/GM-002.md",
    "  - sequence: 3",
    "    id: GM-003",
    "    title: Blocked by open dependency",
    "    status: todo",
    "    depends_on: [GM-002]",
    "    file: docs/issues/GM-003.md",
    ""
  ].join("\n"));
  return root;
}

function buildConfig(workspaceDir) {
  return {
    repo: {
      workspace_dir: workspaceDir,
      github_slug: "example/repo"
    },
    branches: {
      base_branch: "main"
    },
    lifecycle: {
      target_mode: "backlog_file",
      target_name: "issue-manifest.yaml"
    },
    issue_source: {
      labels: [],
      required_issue_prefix: "",
      allow_manual_issue_numbers: []
    },
    dispatcher: {
      skip_issue_numbers: []
    }
  };
}

test("backlog_file queue includes only open dependency-ready items", () => {
  process.env.AE_BACKLOG_FILE_SYNC = "0";
  const workspaceDir = writeBacklogFixture();
  const issues = listOpenIssuesForTarget(buildConfig(workspaceDir));
  assert.deepEqual(issues.map((issue) => issue.backlog_id), ["GM-002"]);
});

test("backlog_file details can load completed items for superseded conflict checks", () => {
  process.env.AE_BACKLOG_FILE_SYNC = "0";
  const workspaceDir = writeBacklogFixture();
  const issue = getIssueDetails(buildConfig(workspaceDir), 1);
  assert.equal(issue.backlog_id, "GM-001");
  assert.equal(issue.state, "CLOSED");
});

test("backlog_file mark done updates manifest and pushes bookkeeping commit", () => {
  delete process.env.AE_BACKLOG_FILE_SYNC;
  const workspaceDir = writeBacklogFixture();
  const originDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-backlog-origin-"));
  const git = (args, cwd = workspaceDir) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  git(["init", "-b", "main"]);
  git(["add", "."]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  git(["init", "--bare", originDir], originDir);
  git(["remote", "add", "origin", originDir]);
  git(["push", "-u", "origin", "main"]);

  const result = markBacklogIssueDone(buildConfig(workspaceDir), 2);
  const manifest = fs.readFileSync(path.join(workspaceDir, "issue-manifest.yaml"), "utf8");

  assert.equal(result.changed, true);
  assert.equal(result.issueId, "GM-002");
  assert.match(manifest, /id: GM-002\n    title: Ready item\n    status: done/);
  assert.match(git(["log", "--oneline", "--max-count=1"]), /Mark GM-002 done in backlog manifest/);
});
