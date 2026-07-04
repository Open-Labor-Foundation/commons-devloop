import path from "node:path";
import { resolveConfigPath, loadConfig } from "./lib/config.mjs";
import {
  loadControlState,
  loadRepoState,
  resolveStackIdentity,
  saveControlState,
  saveRepoState
} from "./lib/state.mjs";
import { log } from "./lib/logger.mjs";

function usage() {
  process.stderr.write(
    "Usage: node scripts/control.mjs <status|pause|resume|disable|enable|identity|env> [reason]\n"
  );
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

const action = process.argv[2];
if (!action) {
  usage();
  process.exit(1);
}

const config = loadConfig(resolveConfigPath());
const stateDir = process.env.AE_STATE_DIR ?? "/engine/state";
const stackIdentity = resolveStackIdentity(stateDir, config.repo.key);
const repoRoot = path.join(stackIdentity.stateRoot, "repos", config.repo.key);
const statePaths = {
  stateRoot: stackIdentity.stateRoot,
  repoRoot,
  meta: path.join(repoRoot, "meta"),
  logs: path.join(repoRoot, "logs"),
  worktrees: path.join(repoRoot, "worktrees"),
  outputs: path.join(repoRoot, "outputs"),
  runLogs: path.join(repoRoot, "run-logs")
};

switch (action) {
  case "identity":
    process.stdout.write(
      `${JSON.stringify(
        {
          ...stackIdentity,
          paths: statePaths
        },
        null,
        2
      )}\n`
    );
    break;
  case "env":
    process.stdout.write(`export AE_STACK_ID=${shellQuote(stackIdentity.stackId)}\n`);
    process.stdout.write(`export COMPOSE_PROJECT_NAME=${shellQuote(stackIdentity.stackId)}\n`);
    process.stdout.write(`export AE_STACK_STATE_ROOT=${shellQuote(stackIdentity.stateRoot)}\n`);
    break;
  default: {
    const repoState = loadRepoState(stateDir, config.repo.key);
    const controlState = loadControlState(stateDir, config.repo.key);
    switch (action) {
      case "status":
        log("info", "repo status", {
          repoKey: config.repo.key,
          stack: stackIdentity,
          statePaths,
          repoState,
          controlState
        });
        break;
      case "pause":
        controlState.manualPause = {
          reason: process.argv.slice(3).join(" ") || "manual pause",
          requestedAt: new Date().toISOString()
        };
        repoState.status = "paused_manual";
        repoState.pauseReason = controlState.manualPause.reason;
        saveControlState(stateDir, config.repo.key, controlState);
        saveRepoState(stateDir, config.repo.key, repoState);
        log("info", "repo paused", {
          repoKey: config.repo.key,
          stackId: stackIdentity.stackId,
          pauseReason: repoState.pauseReason
        });
        break;
      case "resume":
        controlState.manualPause = null;
        repoState.status = "ready";
        repoState.pauseReason = null;
        repoState.targetComplete = false;
        saveControlState(stateDir, config.repo.key, controlState);
        saveRepoState(stateDir, config.repo.key, repoState);
        log("info", "repo resumed", { repoKey: config.repo.key, stackId: stackIdentity.stackId });
        break;
      case "disable":
        repoState.status = "disabled";
        repoState.pauseReason = process.argv.slice(3).join(" ") || "disabled by operator";
        saveRepoState(stateDir, config.repo.key, repoState);
        log("info", "repo disabled", {
          repoKey: config.repo.key,
          stackId: stackIdentity.stackId,
          pauseReason: repoState.pauseReason
        });
        break;
      case "enable":
        repoState.status = "ready";
        repoState.pauseReason = null;
        repoState.targetComplete = false;
        saveRepoState(stateDir, config.repo.key, repoState);
        log("info", "repo enabled", { repoKey: config.repo.key, stackId: stackIdentity.stackId });
        break;
      default:
        usage();
        process.exit(1);
    }
  }
}
