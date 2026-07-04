import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupServiceArtifacts } from "./runtime.mjs";

test("cleanupServiceArtifacts removes stale worktrees and keeps requested entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ae-runtime-cleanup-"));
  const worktreeRoot = path.join(root, "worktrees");
  const runLogRoot = path.join(root, "run-logs");
  const outputRoot = path.join(root, "outputs");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.mkdirSync(runLogRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const keepWorktree = path.join(worktreeRoot, "pr-1");
  const removeWorktree = path.join(worktreeRoot, "pr-2");
  const oldRunLog = path.join(runLogRoot, "old.log");
  const newRunLog = path.join(runLogRoot, "new.log");
  const oldOutput = path.join(outputRoot, "old.md");

  fs.mkdirSync(keepWorktree);
  fs.mkdirSync(removeWorktree);
  fs.writeFileSync(oldRunLog, "old\n");
  fs.writeFileSync(newRunLog, "new\n");
  fs.writeFileSync(oldOutput, "old-output\n");

  const threeDaysAgo = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000));
  fs.utimesSync(oldRunLog, threeDaysAgo, threeDaysAgo);
  fs.utimesSync(oldOutput, threeDaysAgo, threeDaysAgo);

  const result = cleanupServiceArtifacts({
    worktreeRoot,
    runLogRoot,
    outputRoot,
    keepWorktrees: ["pr-1"],
    worktreeMaxAgeHours: 0,
    runLogMaxAgeDays: 2,
    outputMaxAgeDays: 2
  });

  assert.deepEqual(result.removedWorktrees, ["pr-2"]);
  assert.deepEqual(result.removedRunLogs, ["old.log"]);
  assert.deepEqual(result.removedOutputs, ["old.md"]);
  assert.equal(fs.existsSync(keepWorktree), true);
  assert.equal(fs.existsSync(removeWorktree), false);
  assert.equal(fs.existsSync(oldRunLog), false);
  assert.equal(fs.existsSync(newRunLog), true);

  fs.rmSync(root, { recursive: true, force: true });
});
