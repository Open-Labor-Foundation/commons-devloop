import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_SCRIPT = path.join(REPO_ROOT, "scripts", "local-service-acceptance-harness.mjs");

test("local acceptance harness covers issue to merge without GitHub-hosted compute", () => {
  const result = spawnSync(process.execPath, [HARNESS_SCRIPT, "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);

  assert.equal(summary.issueNumber, 13);
  assert.equal(summary.prNumber, 17);
  assert.deepEqual(summary.stageSequence, [
    "issue-intake",
    "pr-creation",
    "local-review",
    "local-validation",
    "remediation",
    "revalidation",
    "local-merge"
  ]);
  assert.equal(summary.merged, true);
  assert.equal(summary.issueClosed, true);
  assert.equal(summary.mergeStateStatus, "BLOCKED");
  assert.equal(summary.issueRuns, 1);
  assert.equal(summary.remediationRuns, 1);
  assert.equal(summary.reviewCount, 2);
  assert.equal(summary.finalReviewerResult, "success");
  assert.equal(summary.finalValidatorResult, "success");
  assert.equal(summary.localMergeWithoutGitHubHostedCompute, true);
  assert.deepEqual(summary.mergedFiles, {
    issueFile: true,
    fixedFile: true
  });
});

test("branch deployment smoke runs the same issue-to-merge flow from a deployed checkout", () => {
  const result = spawnSync(process.execPath, [HARNESS_SCRIPT, "--branch-deployment", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);

  assert.equal(summary.mode, "branch-deployment");
  assert.equal(summary.deployedCommitMatchesSource, true);
  assert.equal(summary.smokeSummary.issueNumber, 13);
  assert.equal(summary.smokeSummary.prNumber, 17);
  assert.deepEqual(summary.smokeSummary.stageSequence, [
    "issue-intake",
    "pr-creation",
    "local-review",
    "local-validation",
    "remediation",
    "revalidation",
    "local-merge"
  ]);
  assert.equal(summary.smokeSummary.merged, true);
  assert.equal(summary.smokeSummary.issueClosed, true);
  assert.equal(summary.smokeSummary.localMergeWithoutGitHubHostedCompute, true);
});
