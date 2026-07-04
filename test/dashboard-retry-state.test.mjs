import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

test("retry_waiting keeps the dashboard movement in a visible retry window", async () => {
  process.env.AE_REPO_CONFIG ??= path.resolve("config/repos/commons-devloop.yaml");
  process.env.AE_DASHBOARD_NO_LISTEN = "1";
  const { buildCheckRecord, deriveMovementState } = await import("../scripts/dashboard-server.mjs");

  const nextRetryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const checks = {
    validator: buildCheckRecord(
      "validator",
      {
        sha: "abc123",
        result: "failure",
        failure_summary: "validator exploded",
        failure_count: 2,
        next_retry_at: nextRetryAt,
        remediation_status: "retry_waiting"
      },
      "abc123"
    ),
    reviewer: buildCheckRecord("reviewer", null, "abc123")
  };

  const movement = deriveMovementState(
    { number: 17 },
    { readiness: "blocked", reason: "local validator failed" },
    checks
  );

  assert.equal(checks.validator.remediation?.key, "waiting-retry");
  assert.equal(movement.key, "waiting-retry");
  assert.equal(movement.label, "Waiting to retry");
  assert.equal(movement.nextRetryAt, nextRetryAt);
  assert.match(movement.detail, /validator exploded/);
});
