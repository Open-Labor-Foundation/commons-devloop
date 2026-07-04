import test from "node:test";
import assert from "node:assert/strict";
import { storePullRequestQueueState } from "../scripts/lib/state.mjs";

test("storePullRequestQueueState clears previous sync errors when metadata provides null", () => {
  const serviceState = {
    pullRequestQueue: {
      prs: [],
      source: "github",
      lastSyncAt: "2026-04-23T00:00:00.000Z",
      lastSyncError: "previous GraphQL failure"
    }
  };

  const snapshot = storePullRequestQueueState(serviceState, [], {
    source: "github",
    lastSyncAt: "2026-04-23T01:00:00.000Z",
    lastSyncError: null
  });

  assert.equal(snapshot.lastSyncError, null);
  assert.equal(serviceState.lastSyncError, null);
  assert.equal(snapshot.lastSyncAt, "2026-04-23T01:00:00.000Z");
});
