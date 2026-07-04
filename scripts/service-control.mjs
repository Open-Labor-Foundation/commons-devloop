import { resolveConfigPath, loadConfig } from "./lib/config.mjs";
import {
  loadControlState,
  loadServiceConfig,
  loadServiceState,
  saveServiceState,
  saveControlState
} from "./lib/state.mjs";

const VALID_SERVICES = [
  "dispatcher",
  "validator",
  "reviewer",
  "runner-manager",
  "pr-manager",
  "monitor"
];
const REVIEW_SERVICES = [
  "validator",
  "reviewer"
];
const VALID_REQUEUE_ACTIONS = [
  "pending",
  "clear"
];

function usage() {
  process.stderr.write(
    "Usage: node scripts/service-control.mjs <status|start|stop|config:get|requeue> <service> [prNumber action]\n"
  );
}

function parsePositiveInt(value) {
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function ensureKnownService(service) {
  if (VALID_SERVICES.includes(service)) {
    return;
  }
  usage();
  process.exit(1);
}

function ensureKnownRequeueService(service) {
  if (REVIEW_SERVICES.includes(service)) {
    return;
  }
  process.stderr.write(`service ${service} does not support PR requeue operations\n`);
  usage();
  process.exit(1);
}

function ensureKnownRequeueAction(action) {
  if (VALID_REQUEUE_ACTIONS.includes(action)) {
    return;
  }
  process.stderr.write(`requeue action must be one of: ${VALID_REQUEUE_ACTIONS.join(", ")}\n`);
  usage();
  process.exit(1);
}

function setReviewRecordPending(config, stateDir, service, prNumber) {
  const serviceState = loadServiceState(stateDir, config.repo.key, service);
  const key = String(prNumber);
  const record = serviceState?.prs?.[key];

  if (!record) {
    process.stderr.write(`no ${service} record found for PR #${prNumber}\n`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  serviceState.prs[key] = {
    ...record,
    result: "pending",
    next_retry_at: null,
    remediation_status: "retry_running",
    updated_at: now,
    last_attempt_at: record.last_attempt_at ?? now
  };
  saveServiceState(stateDir, config.repo.key, service, serviceState);
  process.stdout.write(`set ${service} PR #${prNumber} to pending\n`);
}

function clearReviewRecord(config, stateDir, service, prNumber) {
  const serviceState = loadServiceState(stateDir, config.repo.key, service);
  const key = String(prNumber);
  if (!serviceState?.prs || !Object.hasOwn(serviceState.prs, key)) {
    process.stderr.write(`no ${service} record found for PR #${prNumber}\n`);
    process.exit(1);
  }

  delete serviceState.prs[key];
  saveServiceState(stateDir, config.repo.key, service, serviceState);
  process.stdout.write(`cleared ${service} PR #${prNumber}\n`);
}

const action = process.argv[2];
const service = process.argv[3];
if (!action || !service) {
  usage();
  process.exit(1);
}
ensureKnownService(service);

const config = loadConfig(resolveConfigPath());
const stateDir = process.env.AE_STATE_DIR ?? "/engine/state";

if (action === "requeue") {
  const prNumber = parsePositiveInt(process.argv[4]);
  const requeueAction = process.argv[5];
  ensureKnownRequeueService(service);
  ensureKnownRequeueAction(requeueAction);

  if (!prNumber) {
    usage();
    process.exit(1);
  }

  if (requeueAction === "pending") {
    setReviewRecordPending(config, stateDir, service, prNumber);
  } else {
    clearReviewRecord(config, stateDir, service, prNumber);
  }
  process.exit(0);
}

switch (action) {
  case "status":
    process.stdout.write(
      `${JSON.stringify(
        {
          service,
          state: loadServiceState(stateDir, config.repo.key, service),
          config: loadServiceConfig(stateDir, config.repo.key, service, {})
        },
        null,
        2
      )}\n`
    );
    break;
  case "start": {
    const controlState = loadControlState(stateDir, config.repo.key);
    controlState.desiredServices = {
      ...(controlState.desiredServices ?? {}),
      [service]: true
    };
    saveControlState(stateDir, config.repo.key, controlState);
    process.stdout.write(`started ${service}\n`);
    break;
  }
  case "stop": {
    const controlState = loadControlState(stateDir, config.repo.key);
    controlState.desiredServices = {
      ...(controlState.desiredServices ?? {}),
      [service]: false
    };
    saveControlState(stateDir, config.repo.key, controlState);
    process.stdout.write(`stopped ${service}\n`);
    break;
  }
  case "config:get":
    process.stdout.write(
      `${JSON.stringify(loadServiceConfig(stateDir, config.repo.key, service, {}), null, 2)}\n`
    );
    break;
  default:
    usage();
    process.exit(1);
}
