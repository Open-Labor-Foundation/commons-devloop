import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePullRequestReadiness } from "./pr-readiness.mjs";

function buildConfig(overrides = {}) {
  return {
    reviewer: {
      enabled: true,
      ...(overrides.reviewer ?? {})
    },
    safety: {
      auto_merge: true,
      ...(overrides.safety ?? {})
    },
    pr_manager: {
      auto_merge_label: "automerge",
      ...(overrides.pr_manager ?? {})
    }
  };
}

function buildPr(overrides = {}) {
  return {
    number: 7,
    headRefOid: "abc123",
    isDraft: false,
    mergeStateStatus: "BLOCKED",
    labels: [{ name: "automerge" }],
    ...overrides
  };
}

function buildState(result, sha = "abc123") {
  return {
    prs: {
      7: { result, sha }
    }
  };
}

test("green local validator and reviewer can make a PR merge-ready without GitHub Actions success", () => {
  const readiness = evaluatePullRequestReadiness(
    buildConfig(),
    buildPr({ mergeStateStatus: "BLOCKED" }),
    buildState("success"),
    buildState("success")
  );

  assert.equal(readiness.readiness, "merge");
  assert.equal(readiness.reason, "local validator and reviewer are green");
  assert.equal(readiness.mergeState, "BLOCKED");
});

test("behind branches still require an update before merge", () => {
  const readiness = evaluatePullRequestReadiness(
    buildConfig(),
    buildPr({ mergeStateStatus: "BEHIND" }),
    buildState("success"),
    buildState("success")
  );

  assert.equal(readiness.readiness, "update_branch");
  assert.equal(readiness.reason, "branch behind base");
});

test("merge conflicts still block local merge readiness", () => {
  const readiness = evaluatePullRequestReadiness(
    buildConfig(),
    buildPr({ mergeStateStatus: "DIRTY" }),
    buildState("success"),
    buildState("success")
  );

  assert.equal(readiness.readiness, "blocked");
  assert.equal(readiness.reason, "merge conflicts");
});

test("local validator failures still block readiness even when GitHub merge state looks clean", () => {
  const readiness = evaluatePullRequestReadiness(
    buildConfig(),
    buildPr({ mergeStateStatus: "CLEAN" }),
    buildState("failure"),
    buildState("success")
  );

  assert.equal(readiness.readiness, "blocked");
  assert.equal(readiness.reason, "local validator failed");
});

test("pending local reviewer records keep readiness waiting instead of failed", () => {
  const readiness = evaluatePullRequestReadiness(
    buildConfig(),
    buildPr({ mergeStateStatus: "CLEAN" }),
    buildState("success"),
    buildState("pending")
  );

  assert.equal(readiness.readiness, "waiting");
  assert.equal(readiness.reason, "waiting for local review");
  assert.equal(readiness.reviewerState, "pending");
});

test("retry-aware failure formatting is preserved when local gates fail", () => {
  const readiness = evaluatePullRequestReadiness(
    buildConfig(),
    buildPr({ mergeStateStatus: "CLEAN" }),
    {
      prs: {
        7: {
          result: "failure",
          sha: "abc123",
          next_retry_at: "2026-04-03T20:15:00.000Z"
        }
      }
    },
    buildState("success"),
    {
      formatFailureReason(reason, record) {
        return `${reason}; retry after ${record.next_retry_at}`;
      }
    }
  );

  assert.equal(readiness.readiness, "blocked");
  assert.equal(readiness.reason, "local validator failed; retry after 2026-04-03T20:15:00.000Z");
});

test("disabled local merge reports repo-config blocking instead of GitHub auto-merge wording", () => {
  const readiness = evaluatePullRequestReadiness(
    buildConfig({ safety: { auto_merge: false } }),
    buildPr({ mergeStateStatus: "CLEAN" }),
    buildState("success"),
    buildState("success")
  );

  assert.equal(readiness.readiness, "blocked");
  assert.equal(readiness.reason, "local merge disabled by repo config");
});
