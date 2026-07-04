import test from "node:test";
import assert from "node:assert/strict";
import { branchUpdateConcurrencyForConfig, selectPrManagerActions } from "./pr-manager-plan.mjs";

function buildConfig(overrides = {}) {
  return {
    lifecycle: {
      max_parallel_prs: 10,
      ...(overrides.lifecycle ?? {})
    },
    pr_manager: {
      merge_concurrency: 1,
      ...(overrides.pr_manager ?? {})
    }
  };
}

function buildPr(number, readiness) {
  return {
    number,
    localGate: {
      readiness
    }
  };
}

test("branch update concurrency defaults to the lifecycle PR cap", () => {
  assert.equal(branchUpdateConcurrencyForConfig(buildConfig()), 10);
});

test("explicit branch update concurrency overrides the lifecycle cap", () => {
  assert.equal(
    branchUpdateConcurrencyForConfig(
      buildConfig({
        pr_manager: {
          update_branch_concurrency: 3
        }
      })
    ),
    3
  );
});

test("pr-manager updates all behind branches before attempting merges", () => {
  const actions = selectPrManagerActions(buildConfig(), [
    buildPr(1480, "update_branch"),
    buildPr(1481, "update_branch"),
    buildPr(1482, "merge"),
    buildPr(1483, "merge")
  ]);

  assert.equal(actions.pauseMergesForUpdates, true);
  assert.deepEqual(actions.updateBatch.map((pr) => pr.number), [1480, 1481]);
  assert.deepEqual(actions.mergeBatch, []);
});

test("pr-manager merges only after behind branches are cleared", () => {
  const actions = selectPrManagerActions(buildConfig(), [
    buildPr(1482, "merge"),
    buildPr(1483, "merge")
  ]);

  assert.equal(actions.pauseMergesForUpdates, false);
  assert.deepEqual(actions.updateBatch, []);
  assert.deepEqual(actions.mergeBatch.map((pr) => pr.number), [1482]);
});
