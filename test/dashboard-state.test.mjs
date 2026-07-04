import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AE_REPO_CONFIG ??= path.resolve("config/repos/commons-devloop.yaml");
process.env.AE_DASHBOARD_NO_LISTEN = "1";

const {
  buildDeploymentReadiness,
  classifyRemediationStatus,
  buildCheckRecord,
  deriveMovementState
} = await import("../scripts/dashboard-server.mjs");

const REQUIRED_DASHBOARD_SERVICES = [
  "autonomous",
  "dispatcher",
  "validator",
  "reviewer",
  "runner-manager",
  "pr-manager",
  "monitor"
];

function readinessConfig(workspaceDir) {
  return {
    version: 2,
    repo: {
      key: "fixture",
      github_slug: "owner/fixture",
      default_branch: "main",
      workspace_dir: workspaceDir
    },
    dashboard: {
      port: 4700,
      expose_issue_details: true,
      expose_pr_links: true
    },
    roles: {
      enabled: {
        autonomous: true,
        dispatcher: true,
        validator: true,
        reviewer: true,
        "runner-manager": true,
        "pr-manager": true,
        monitor: true,
        dashboard: true
      }
    }
  };
}

function readinessServices(lifecycle = "running", overrides = {}) {
  return Object.fromEntries(
    REQUIRED_DASHBOARD_SERVICES.map((service) => [
      service,
      {
        state: {
          lifecycle,
          configEnabled: true,
          desiredEnabled: true,
          summary: `${service} ${lifecycle}`,
          containerAvailable: true,
          containerStatus: lifecycle === "running" ? "running" : "exited"
        }
      }
    ]).map(([service, entry]) => [service, overrides[service] ?? entry])
  );
}

function readinessInput(overrides = {}) {
  let config = overrides.config ?? null;
  if (!config) {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-readiness-workspace-"));
    fs.mkdirSync(path.join(workspaceDir, ".git"));
    config = readinessConfig(workspaceDir);
  }
  return {
    config,
    configVersion: "1234567890abcdef",
    stack: {
      stackId: "fixture-stack",
      source: "repo-key",
      stateRoot: "/engine/state/stacks/fixture-stack"
    },
    dashboardPort: 4700,
    services: readinessServices(),
    targetIssues: [{ number: 53 }],
    openPrs: [{ number: 54 }],
    mergedPrs: [],
    githubCache: {
      updatedAt: "2026-04-18T12:00:00.000Z",
      errors: {}
    },
    ...overrides
  };
}

test("classifyRemediationStatus maps retry waiting to waiting-retry", () => {
  assert.deepEqual(classifyRemediationStatus("retry_waiting"), {
    key: "waiting-retry",
    label: "Waiting to retry",
    tone: "warn"
  });
});

test("buildCheckRecord suppresses zero failure attempts for green checks", () => {
  const check = buildCheckRecord("validator", {
    sha: "abc123",
    result: "success",
    failure_count: 0,
    updated_at: "2026-04-03T20:00:00.000Z"
  }, "abc123");

  assert.equal(check.result, "success");
  assert.equal(check.failureCount, null);
});

test("deriveMovementState keeps retry timing visible for retry_waiting failures", () => {
  const nextRetryAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const checks = {
    validator: {
      service: "validator",
      result: "failure",
      failureSummary: "validator failed on config validation",
      nextRetryAt,
      remediation: classifyRemediationStatus("retry_waiting")
    },
    reviewer: {
      service: "reviewer",
      result: "success",
      remediation: null
    }
  };

  const movement = deriveMovementState({}, {
    readiness: "blocked",
    reason: "local validator failed"
  }, checks);

  assert.equal(movement.key, "waiting-retry");
  assert.equal(movement.label, "Waiting to retry");
  assert.equal(movement.nextRetryAt, nextRetryAt);
  assert.match(movement.detail, /validator failed/);
});

test("buildDeploymentReadiness reports ready when config, mount, GitHub data, and services are healthy", () => {
  const input = readinessInput();
  const readiness = buildDeploymentReadiness(input);

  assert.equal(readiness.status, "ready");
  assert.equal(readiness.config.valid, true);
  assert.equal(readiness.config.currentVersion, "1234567890abcdef");
  assert.equal(readiness.identity.githubSlug, "owner/fixture");
  assert.equal(readiness.identity.stackId, "fixture-stack");
  assert.equal(readiness.identity.stateRoot, "/engine/state/stacks/fixture-stack");
  assert.equal(readiness.identity.dashboardPort, 4700);
  assert.equal(readiness.targetRepoMount.status, "mounted");
  assert.equal(readiness.githubVisibility.issues.status, "visible");
  assert.equal(readiness.githubVisibility.pullRequests.status, "visible");
  assert.equal(readiness.requiredServices.summary.running, 8);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.warnings, []);

  fs.rmSync(input.config.repo.workspace_dir, { recursive: true, force: true });
});

test("buildDeploymentReadiness blocks missing target mounts and stopped required services", () => {
  const missingWorkspace = path.join(os.tmpdir(), `ae-missing-${Date.now()}`);
  const services = readinessServices("running", {
    dispatcher: {
      state: {
        lifecycle: "stopped",
        configEnabled: true,
        desiredEnabled: true,
        summary: "dispatcher stopped",
        containerAvailable: true,
        containerStatus: "exited"
      }
    }
  });
  const readiness = buildDeploymentReadiness(readinessInput({
    config: readinessConfig(missingWorkspace),
    services,
    targetIssues: [],
    openPrs: [],
    githubCache: {
      updatedAt: "2026-04-18T12:00:00.000Z",
      errors: {
        targetIssues: "GitHub issue query timed out",
        openPrs: "GitHub PR query timed out"
      }
    }
  }));

  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.targetRepoMount.status, "missing");
  assert.equal(readiness.githubVisibility.issues.status, "degraded");
  assert.equal(readiness.githubVisibility.pullRequests.status, "degraded");
  assert.ok(readiness.blockers.some((concern) => concern.code === "target-repo-mount"));
  assert.ok(readiness.blockers.some((concern) => concern.code === "service-dispatcher-stopped"));
  assert.ok(readiness.warnings.some((concern) => concern.code === "github-issues"));
  assert.ok(readiness.warnings.some((concern) => concern.code === "github-pullRequests"));
});
