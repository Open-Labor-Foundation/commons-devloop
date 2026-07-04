import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveConfigPath,
  loadConfig,
  loadRawConfig,
  saveRawConfig,
  getDispatcherLanes
} from "./lib/config.mjs";
import {
  loadControlState,
  loadRepoState,
  resolveStackIdentity,
  loadServiceConfig,
  loadServiceState,
  readServiceLogTail,
  saveControlState,
  saveRepoState,
  saveServiceState,
  syncDerivedServiceConfigs
} from "./lib/state.mjs";
import { getMergedPullRequests, listOpenIssuesForTarget, listOpenPullRequests } from "./lib/github.mjs";
import { log } from "./lib/logger.mjs";
import { readLatestCodexRateLimit, readRecentUsageLimitOverride } from "./lib/codex-rate-limit.mjs";
import { resolveLaneApiKey, setLaneApiKey, laneApiKeyStatus } from "./lib/secrets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDistDir = path.join(__dirname, "..", "dashboard", "dist");
const configPath = resolveConfigPath();
const stateDir = process.env.AE_STATE_DIR ?? "/engine/state";
const SERVICES = [
  "autonomous",
  "dispatcher",
  "validator",
  "reviewer",
  "runner-manager",
  "pr-manager",
  "monitor"
];
const REQUIRED_READINESS_SERVICES = [...SERVICES, "dashboard"];
const REVIEW_SERVICES = ["validator", "reviewer"];
const MODEL_OPTIONS = ["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.5", "qwen2.5-coder:3b", "qwen2.5-coder:7b", "qwen2.5-coder:14b", "qwen2.5-coder:32b"];
const LOCAL_MODEL_OPTIONS = new Set(["qwen2.5-coder", "qwen2.5-coder:3b", "qwen2.5-coder:7b", "qwen2.5-coder:14b", "qwen2.5-coder:32b"]);
const REASONING_OPTIONS = ["low", "medium", "high", "local"];
const VALID_REQUEUE_ACTIONS = ["pending", "clear"];
const DASHBOARD_GH_TIMEOUT_MS = Number(process.env.AE_DASHBOARD_GH_TIMEOUT_MS ?? 1500);
const githubCache = {
  targetIssues: [],
  openPrs: [],
  mergedPrs: [],
  errors: {},
  updatedAt: null
};

function serviceEnabledInConfig(config, service) {
  return config.roles.enabled?.[service] !== false;
}

function serviceDesiredEnabled(config, controlState, service) {
  return serviceEnabledInConfig(config, service) && controlState.desiredServices?.[service] !== false;
}

function ensureDesiredServiceDefaults(config, controlState) {
  controlState.desiredServices = controlState.desiredServices ?? {};
  let changed = false;
  for (const service of SERVICES) {
    if (controlState.desiredServices[service] == null) {
      controlState.desiredServices[service] = serviceEnabledInConfig(config, service);
      changed = true;
    }
  }
  return changed;
}

function comparableServiceState(state) {
  if (!state || typeof state !== "object") {
    return state;
  }
  const { updatedAt, ...rest } = state;
  return rest;
}

function buildPersistedServiceState(rawState, entryState) {
  const lifecycle = String(entryState?.lifecycle ?? "stopped");
  return {
    ...rawState,
    alive: lifecycle === "running" || lifecycle === "stopping",
    enabled: entryState?.desiredEnabled !== false,
    configEnabled: entryState?.configEnabled !== false,
    desiredEnabled: entryState?.desiredEnabled !== false,
    lifecycle,
    summary: entryState?.summary ?? rawState?.summary ?? null,
    containerName: entryState?.containerName ?? null,
    containerStatus: entryState?.containerStatus ?? null,
    containerRunning: Boolean(entryState?.containerRunning),
    containerAvailable: entryState?.containerAvailable !== false,
    containerFound: Boolean(entryState?.containerFound),
    lifecycleSource: entryState?.lifecycleSource ?? null
  };
}

function buildRepoServiceEntry(serviceState) {
  return {
    alive: Boolean(serviceState?.alive),
    enabled: serviceState?.enabled !== false,
    updatedAt: serviceState?.updatedAt ?? null,
    summary: serviceState?.summary ?? null,
    lifecycle: serviceState?.lifecycle ?? null,
    configEnabled: serviceState?.configEnabled ?? null,
    desiredEnabled: serviceState?.desiredEnabled ?? serviceState?.enabled ?? null,
    containerStatus: serviceState?.containerStatus ?? null,
    lifecycleSource: serviceState?.lifecycleSource ?? null
  };
}

function syncPersistedServiceModel(config, controlState, services) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  let repoChanged = false;

  for (const service of SERVICES) {
    const rawState = loadServiceState(stateDir, config.repo.key, service);
    const nextState = buildPersistedServiceState(rawState, services[service]?.state);
    if (JSON.stringify(comparableServiceState(rawState)) !== JSON.stringify(comparableServiceState(nextState))) {
      saveServiceState(stateDir, config.repo.key, service, nextState);
      nextState.updatedAt = new Date().toISOString();
    } else {
      nextState.updatedAt = rawState.updatedAt ?? null;
    }

    const currentRepoEntry = repoState.services?.[service] ?? null;
    const nextRepoEntry = buildRepoServiceEntry(nextState);
    if (JSON.stringify(currentRepoEntry) !== JSON.stringify(nextRepoEntry)) {
      repoState.services = {
        ...(repoState.services ?? {}),
        [service]: nextRepoEntry
      };
      repoChanged = true;
    }
  }

  if (repoChanged) {
    saveRepoState(stateDir, config.repo.key, repoState);
  }

  return repoState;
}

function getConfig() {
  const config = loadConfig(configPath);
  syncDerivedServiceConfigs(stateDir, config);
  return config;
}

function getConfigVersion() {
  const raw = fs.readFileSync(configPath, "utf8");
  return crypto.createHash("sha1").update(raw).digest("hex");
}

const STATIC_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function readHtml() {
  return fs.readFileSync(path.join(dashboardDistDir, "index.html"), "utf8");
}

/**
 * Serves a built dashboard static asset (dashboard/dist/**) if the request
 * path maps to a real file there. Returns true if it handled the request.
 * Path is resolved and checked against dashboardDistDir to prevent
 * traversal outside the build output directory.
 */
function serveStaticAsset(pathname, res) {
  const relativePath = pathname.replace(/^\/+/, "");
  if (!relativePath) {
    return false;
  }
  const resolved = path.resolve(dashboardDistDir, relativePath);
  if (resolved !== dashboardDistDir && !resolved.startsWith(`${dashboardDistDir}${path.sep}`)) {
    return false;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return false;
  }
  const ext = path.extname(resolved);
  res.writeHead(200, {
    "content-type": STATIC_MIME_TYPES[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store, max-age=0, must-revalidate" : "public, max-age=31536000, immutable"
  });
  res.end(fs.readFileSync(resolved));
  return true;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clamp(parsed, min, max);
}

function asNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clamp(parsed, min, max);
}

function computeLaneTargets(primaryMaxWorkers, secondaryMaxWorkers) {
  const primary = Math.max(0, Number(primaryMaxWorkers ?? 0));
  const secondary = Math.max(0, Number(secondaryMaxWorkers ?? 0));
  const total = primary + secondary;
  return {
    total,
    secondary,
    primary,
    activeLaneCount: total <= 0 ? 0 : primary > 0 && secondary > 0 ? 2 : 1
  };
}

function targetWorkersForLane(lane) {
  return lane.enabled === false ? 0 : Math.max(0, Number(lane.max_workers ?? 0));
}

function computeLaneTargetsFromLanes(lanes) {
  const targets = Object.fromEntries(lanes.map((lane) => [lane.key, targetWorkersForLane(lane)]));
  const total = Object.values(targets).reduce((sum, target) => sum + target, 0);
  return {
    total,
    targets,
    primary: targets.primary ?? 0,
    secondary: targets.secondary ?? 0,
    local: targets.local ?? 0,
    activeLaneCount: Object.values(targets).filter((target) => target > 0).length
  };
}

function pauseBelowRemainingPercent(usedPercent) {
  if (!Number.isFinite(Number(usedPercent))) {
    return null;
  }
  return clamp(100 - Number(usedPercent), 0, 100);
}

function getTimeLeftMinutes(isoValue) {
  if (!isoValue) {
    return null;
  }
  const millis = Date.parse(isoValue) - Date.now();
  if (!Number.isFinite(millis)) {
    return null;
  }
  return Math.max(0, millis / 60000);
}

function computeDynamicReserve(snapshot, baseReserveRemainingPercent, burnWindowMinutes) {
  if (!snapshot || snapshot.remainingPercent == null) {
    return baseReserveRemainingPercent;
  }

  if (!burnWindowMinutes || burnWindowMinutes <= 0) {
    return baseReserveRemainingPercent;
  }

  const timeLeftMinutes = getTimeLeftMinutes(snapshot.resetsAt);
  if (timeLeftMinutes == null || timeLeftMinutes > burnWindowMinutes) {
    return baseReserveRemainingPercent;
  }

  const factor = clamp(timeLeftMinutes / burnWindowMinutes, 0, 1);
  return Math.round(baseReserveRemainingPercent * factor * 10) / 10;
}

function formatReset(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatTelemetryAge(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  return `${ageHours}h ago`;
}

function chooseLatestSnapshot(...candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const candidateTimestamp = Number(candidate.timestamp ?? candidate.telemetryAt ?? 0);
    const bestTimestamp = Number(best?.timestamp ?? best?.telemetryAt ?? 0);
    if (!best || candidateTimestamp > bestTimestamp) {
      best = candidate;
    }
  }
  return best;
}

function readLaneSnapshot(modelName) {
  if (modelName === "gpt-5.3-codex-spark") {
    return chooseLatestSnapshot(
      readLatestCodexRateLimit({ model: modelName }),
      readLatestCodexRateLimit({ limitName: "GPT-5.3-Codex-Spark" }),
      readLatestCodexRateLimit({ limitId: "codex_bengalfox" })
    );
  }

  const modelSnapshot = readLatestCodexRateLimit({ model: modelName });
  if (modelSnapshot) {
    return modelSnapshot;
  }

  return null;
}

function getLaneUsageOverride(dispatcherState, laneName, modelName) {
  const items = Array.isArray(dispatcherState?.items) ? dispatcherState.items : [];
  const targetItem = items.find((item) => item?.assigned_lane === laneName && item?.assigned_model === modelName && item?.log)
    ?? items.find((item) => item?.status === "failed" && item?.assigned_model === modelName && item?.log);
  if (!targetItem?.log) {
    return null;
  }

  return readRecentUsageLimitOverride({
    model: modelName,
    logPath: targetItem.log
  });
}

function applyUsageOverride(snapshot, override) {
  if (!override) {
    return snapshot;
  }

  return {
    ...(snapshot ?? {}),
    usedPercent: override.usedPercent,
    remainingPercent: override.remainingPercent,
    resetsAt: override.resetsAt ?? snapshot?.resetsAt ?? null,
    timestamp: override.telemetryAt ?? Date.now(),
    overriddenByUsageLimit: true,
    overrideSource: override.source
  };
}

function getServicePollSeconds(serviceConfig = {}) {
  return Number(
    serviceConfig.pollIntervalSeconds
      ?? serviceConfig.intervalSeconds
      ?? 30
  );
}

function normalizeServiceState(state, serviceConfig = {}) {
  if (!state || typeof state !== "object") {
    return state;
  }

  const updatedAt = Date.parse(String(state.updatedAt ?? ""));
  if (!state.alive || !Number.isFinite(updatedAt)) {
    return state;
  }

  const staleThresholdMs = Math.max(90_000, getServicePollSeconds(serviceConfig) * 3_000);
  const ageMs = Date.now() - updatedAt;
  if (ageMs <= staleThresholdMs) {
    return state;
  }

  return {
    ...state,
    alive: false,
    stale: true,
    staleAgeSeconds: Math.floor(ageMs / 1000),
    summary: state.summary ? `${state.summary} [stale]` : "stale heartbeat"
  };
}

function readServiceContainerState(service) {
  try {
    const raw = runDocker([
      "inspect",
      serviceContainerName(service),
      "--format",
      "{{json .State}}"
    ]);
    const state = JSON.parse(raw);
    return {
      available: true,
      found: true,
      status: state.Status ?? null,
      running: Boolean(state.Running),
      restarting: Boolean(state.Restarting),
      exitCode: Number.isFinite(state.ExitCode) ? state.ExitCode : null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No such object")) {
      return {
        available: true,
        found: false,
        status: "missing",
        running: false,
        restarting: false,
        exitCode: null
      };
    }

    return {
      available: false,
      found: false,
      status: null,
      running: false,
      restarting: false,
      exitCode: null,
      error: message
    };
  }
}

function readLocalRuntimeProbe(lane) {
  if (!lane.runtimeHealthUrl) {
    return null;
  }

  try {
    const raw = execFileSync("curl", ["-fsS", "--max-time", "2", lane.runtimeHealthUrl], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parsed = JSON.parse(raw);
    const loadedModels = Array.isArray(parsed?.models)
      ? parsed.models.map((model) => String(model?.name ?? model?.model ?? "")).filter(Boolean)
      : [];
    const modelReady = loadedModels.length === 0
      ? null
      : loadedModels.some((name) => name === lane.model || name.split(":")[0] === lane.model);
    return {
      reachable: true,
      modelReady,
      loadedModels
    };
  } catch (error) {
    return {
      reachable: false,
      modelReady: false,
      loadedModels: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildServiceEntry(config, controlState, service) {
  const rawState = loadServiceState(stateDir, config.repo.key, service);
  const serviceConfig = loadServiceConfig(stateDir, config.repo.key, service, {});
  const state = normalizeServiceState(rawState, serviceConfig);
  const configEnabled = serviceEnabledInConfig(config, service);
  const desiredEnabled = serviceDesiredEnabled(config, controlState, service);
  const containerState = readServiceContainerState(service);
  let lifecycle = "stopped";
  let summary = state?.summary ?? null;

  if (!configEnabled) {
    lifecycle = "disabled";
    summary = `${service} disabled by config`;
  } else if (containerState.available) {
    if (containerState.status === "running") {
      lifecycle = desiredEnabled ? "running" : "stopping";
      summary = desiredEnabled
        ? (state?.alive ? summary : `${service} running`)
        : `${service} stop requested`;
    } else if (containerState.status === "created" || containerState.status === "restarting") {
      lifecycle = "starting";
      summary = summary ?? `${service} container ${containerState.status}`;
    } else {
      lifecycle = "stopped";
      summary = (
        containerState.status === "missing"
          ? `${service} stopped`
          : `${service} container ${containerState.status}`
      );
    }
  } else {
    const alive = Boolean(state?.alive);
    if (alive && desiredEnabled) {
      lifecycle = "running";
    } else if (alive && !desiredEnabled) {
      lifecycle = "stopping";
      summary = summary ?? `${service} stop requested`;
    } else if (!alive && desiredEnabled) {
      lifecycle = "starting";
      summary = summary ?? `${service} enabled; waiting for heartbeat`;
    }
  }

  return {
    state: {
      ...state,
      enabled: desiredEnabled,
      configEnabled,
      desiredEnabled,
      lifecycle,
      summary,
      containerName: serviceContainerName(service),
      containerStatus: containerState.status,
      containerRunning: containerState.running,
      containerAvailable: containerState.available,
      containerFound: containerState.found,
      lifecycleSource: containerState.available ? "docker" : "heartbeat"
    },
    config: serviceConfig,
    logTail: readServiceLogTail(
      stateDir,
      config.repo.key,
      service,
      12,
      rawState.sessionStartedAt ?? null
    )
  };
}

export function buildLaneControl(config) {
  const lanes = getDispatcherLanes(config);
  const targets = computeLaneTargetsFromLanes(lanes);
  const laneControls = lanes.map((lane) => ({
    key: lane.key,
    label: lane.label,
    provider: lane.provider,
    enabled: lane.enabled !== false,
    model: lane.name,
    reasoningEffort: lane.reasoning_effort,
    targetConcurrency: targets.targets[lane.key] ?? 0,
    pauseBelowRemainingPercent: pauseBelowRemainingPercent(lane.pause_threshold_used_percent),
    weeklyPauseBelowRemainingPercent: pauseBelowRemainingPercent(lane.weekly_pause_threshold_used_percent),
    reserveWindowHours: Math.round(Number(lane.reserve_burn_window_minutes ?? 0) / 60),
    nominalBurnPerLaneHour: Number(lane.nominal_burn_per_lane_hour ?? 0),
    providerConcurrencyBudgetUnits: Number(lane.provider_concurrency_budget_units ?? 0),
    requestCostUnits: Number(lane.request_cost_units ?? 0),
    runtimeService: lane.runtime_service ?? "",
    runtimeEndpoint: lane.runtime_endpoint ?? "",
    runtimeHealthUrl: lane.runtime_health_url ?? "",
    runtimeImage: lane.runtime_image ?? "",
    runtimeCommand: lane.runtime_command ?? "",
    localProvider: lane.local_provider ?? "",
    numThread: Number(lane.num_thread ?? 0),
    numCtx: Number(lane.num_ctx ?? 0),
    autoPull: Boolean(lane.auto_pull)
  }));
  const laneByKey = Object.fromEntries(laneControls.map((lane) => [lane.key, lane]));

  return {
    totalConcurrency: targets.total,
    activeLaneCount: targets.activeLaneCount,
    primaryTargetConcurrency: targets.primary,
    secondaryTargetConcurrency: targets.secondary,
    localTargetConcurrency: targets.local,
    lanes: laneControls,
    primary: laneByKey.primary,
    secondary: laneByKey.secondary,
    local: laneByKey.local,
    reviewer: {
      model: config.models.reviewer.name,
      reasoningEffort: config.models.reviewer.reasoning_effort
    }
  };
}

export function buildPolicyControl(config) {
  const laneControl = buildLaneControl(config);
  return {
    repo: {
      key: String(config.repo.key ?? ""),
      githubSlug: String(config.repo.github_slug ?? ""),
      defaultBranch: String(config.repo.default_branch ?? ""),
      workspaceDir: String(config.repo.workspace_dir ?? "")
    },
    lifecycle: {
      enabled: Boolean(config.lifecycle.enabled),
      targetMode: String(config.lifecycle.target_mode ?? "open"),
      targetName: String(config.lifecycle.target_name ?? ""),
      maxParallelPrs: Number(config.lifecycle.max_parallel_prs ?? 1),
      maxRunsPerDay: Number(config.lifecycle.max_runs_per_day ?? 1),
      pauseWhenTargetComplete: Boolean(config.lifecycle.pause_when_target_complete),
      pauseWhenBudgetExhausted: Boolean(config.lifecycle.pause_when_budget_exhausted)
    },
    issueSource: {
      labels: (config.issue_source.labels ?? []).join("\n"),
      requiredIssuePrefix: String(config.issue_source.required_issue_prefix ?? ""),
      allowManualIssueNumbers: (config.issue_source.allow_manual_issue_numbers ?? []).join("\n")
    },
    dispatcher: {
      enabled: Boolean(config.dispatcher.enabled),
      pollIntervalSeconds: Number(config.dispatcher.poll_interval_seconds ?? 30),
      primaryTargetConcurrency: laneControl.primaryTargetConcurrency,
      secondaryTargetConcurrency: laneControl.secondaryTargetConcurrency,
      localTargetConcurrency: laneControl.localTargetConcurrency,
      skipIssueNumbers: (config.dispatcher.skip_issue_numbers ?? []).join("\n"),
      lanes: laneControl.lanes,
      primary: laneControl.primary,
      secondary: laneControl.secondary,
      local: laneControl.local
    },
    validation: {
      enabled: Boolean(config.validation.enabled),
      context: String(config.validation.context ?? "validate"),
      pollIntervalSeconds: Number(config.validation.poll_interval_seconds ?? 30),
      maxConcurrent: Number(config.validation.max_concurrent ?? 1),
      postStatus: Boolean(config.validation.post_status),
      workingDirectory: String(config.validation.working_directory ?? ""),
      bootstrapCommands: (config.validation.bootstrap_commands ?? []).join("\n"),
      commands: (config.validation.commands ?? []).join("\n")
    },
    reviewer: {
      enabled: Boolean(config.reviewer.enabled),
      pollIntervalSeconds: Number(config.reviewer.poll_interval_seconds ?? 120),
      maxConcurrent: Number(config.reviewer.max_concurrent ?? 1),
      model: config.models.reviewer.name,
      reasoningEffort: config.models.reviewer.reasoning_effort,
      postMode: config.reviewer.post_mode,
      instructionsPath: String(config.reviewer.instructions_path ?? "")
    },
    prManager: {
      enabled: Boolean(config.pr_manager.enabled),
      intervalSeconds: Number(config.pr_manager.interval_seconds ?? 30),
      mergeConcurrency: Number(config.pr_manager.merge_concurrency ?? 1),
      updateBranchConcurrency: Number(config.pr_manager.update_branch_concurrency ?? 1),
      autoMergeLabel: String(config.pr_manager.auto_merge_label ?? "")
    },
    runnerManager: {
      enabled: Boolean(config.runner_manager.enabled),
      scope: String(config.runner_manager.scope ?? "repo"),
      requiredLabels: (config.runner_manager.required_labels ?? []).join("\n"),
      runnerLabels: (config.runner_manager.runner_labels ?? []).join("\n"),
      runnerGroup: String(config.runner_manager.runner_group ?? ""),
      imageName: String(config.runner_manager.image_name ?? ""),
      containerPrefix: String(config.runner_manager.container_prefix ?? ""),
      maxRunners: Number(config.runner_manager.max_runners ?? 1),
      pollIntervalSeconds: Number(config.runner_manager.poll_interval_seconds ?? 20),
      launchCooldownSeconds: Number(config.runner_manager.launch_cooldown_seconds ?? 180),
      network: String(config.runner_manager.network ?? ""),
      dryRun: Boolean(config.runner_manager.dry_run),
      mountDockerSocket: Boolean(config.runner_manager.mount_docker_socket),
      mountWorkspace: Boolean(config.runner_manager.mount_workspace)
    },
    monitor: {
      enabled: Boolean(config.monitor.enabled),
      pollIntervalSeconds: Number(config.monitor.poll_interval_seconds ?? 30)
    },
    safety: {
      prOnly: Boolean(config.safety.pr_only),
      autoMerge: Boolean(config.safety.auto_merge),
      protectedBranches: (config.safety.protected_branches ?? []).join("\n"),
      protectedPaths: (config.safety.protected_paths ?? []).join("\n"),
      allowForcePush: Boolean(config.safety.allow_force_push),
      requireCleanWorktreeBeforeRun: Boolean(config.safety.require_clean_worktree_before_run)
    },
    budgets: {
      maxEstimatedCreditsPerDay:
        config.budgets.max_estimated_credits_per_day == null
          ? ""
          : String(config.budgets.max_estimated_credits_per_day),
      pauseReasonOnBudget: String(config.budgets.pause_reason_on_budget ?? "")
    },
    branches: {
      workBranchPrefix: String(config.branches.work_branch_prefix ?? "autonomous/"),
      prBaseBranch: String(config.branches.pr_base_branch ?? "main")
    },
    roles: {
      autonomous: Boolean(config.roles.enabled.autonomous),
      dispatcher: Boolean(config.roles.enabled.dispatcher),
      validator: Boolean(config.roles.enabled.validator),
      reviewer: Boolean(config.roles.enabled.reviewer),
      runnerManager: Boolean(config.roles.enabled["runner-manager"]),
      prManager: Boolean(config.roles.enabled["pr-manager"]),
      monitor: Boolean(config.roles.enabled.monitor),
      dashboard: Boolean(config.roles.enabled.dashboard)
    },
    dashboard: {
      enabled: Boolean(config.dashboard.enabled),
      port: Number(config.dashboard.port ?? 4700),
      exposeIssueDetails: Boolean(config.dashboard.expose_issue_details),
      exposePrLinks: Boolean(config.dashboard.expose_pr_links)
    },
    retention: {
      enabled: config.retention?.enabled !== false,
      worktreeMaxAgeHours: Number(config.retention?.worktree_max_age_hours ?? 6),
      runLogMaxAgeDays: Number(config.retention?.run_log_max_age_days ?? 2),
      outputMaxAgeDays: Number(config.retention?.output_max_age_days ?? 2)
    }
  };
}

export function buildLaneTelemetry(config, dispatcherState) {
  const laneControl = buildLaneControl(config);
  const openPrCount = Number(dispatcherState?.openPrCount ?? 0);
  const activeOpenPrCount = Number(dispatcherState?.activeOpenPrCount ?? openPrCount);
  const draftOpenPrCount = Number(
    dispatcherState?.draftOpenPrCount ?? Math.max(0, openPrCount - activeOpenPrCount)
  );
  const items = Array.isArray(dispatcherState?.items) ? dispatcherState.items : [];

  function laneThrottleReason(configuredTarget, activeTarget) {
    if (configuredTarget <= 0 || activeTarget > 0) {
      return null;
    }
    if (activeOpenPrCount >= Number(config.lifecycle.max_parallel_prs ?? Number.MAX_SAFE_INTEGER)) {
      return `Held at 0 because active open PR count (${activeOpenPrCount}) reached the repo cap (${config.lifecycle.max_parallel_prs}).`;
    }
    if (draftOpenPrCount > 0) {
      return `Held at 0 by the current dispatcher cycle (${draftOpenPrCount} draft PRs are open but do not consume active PR capacity).`;
    }
    return "Held at 0 by the current dispatcher cycle.";
  }

  const telemetryLanes = laneControl.lanes.map((lane) => {
    const activeTarget = dispatcherState?.lanes?.[lane.key]?.targetConcurrency ?? lane.targetConcurrency;
    const running = items.filter((item) => item.status === "running" && item.assigned_lane === lane.key).length;
    const base = {
      key: lane.key,
      label: lane.label,
      provider: lane.provider,
      model: lane.model,
      reasoningEffort: lane.reasoningEffort,
      targetConcurrency: lane.targetConcurrency,
      activeTargetConcurrency: activeTarget,
      running,
      pauseBelowRemainingPercent: lane.pauseBelowRemainingPercent,
      weeklyPauseBelowRemainingPercent: lane.weeklyPauseBelowRemainingPercent,
      reserveWindowHours: lane.reserveWindowHours,
      nominalBurnPerLaneHour: lane.nominalBurnPerLaneHour,
      throttleReason: laneThrottleReason(lane.targetConcurrency, activeTarget),
      pauseReason:
        dispatcherState?.summary?.startsWith("repo paused:")
          ? dispatcherState.summary
          : null
    };

    if (lane.provider === "local_container") {
      const containerState = lane.runtimeService ? readServiceContainerState(lane.runtimeService) : null;
      const runtimeProbe = readLocalRuntimeProbe(lane);
      const runtimeStatus = lane.targetConcurrency <= 0
        ? "disabled"
        : containerState?.running && runtimeProbe?.modelReady === false && !lane.autoPull
          ? "missing-model"
          : containerState?.running && runtimeProbe?.reachable === false
            ? "unreachable"
          : containerState?.running
            ? running > 0 ? "busy" : "ready"
          : containerState?.status === "missing"
            ? "unavailable"
            : containerState?.status ?? "unavailable";
      return {
        ...base,
        remainingPercent: null,
        weeklyRemainingPercent: null,
        effectiveReserveRemainingPercent: null,
        reset: "-",
        weeklyReset: "-",
        telemetryAt: new Date().toISOString(),
        telemetryAge: "local",
        runtimeService: lane.runtimeService,
        runtimeEndpoint: lane.runtimeEndpoint,
        runtimeHealthUrl: lane.runtimeHealthUrl,
        runtimeImage: lane.runtimeImage,
        localProvider: lane.localProvider,
        numThread: lane.numThread,
        numCtx: lane.numCtx,
        autoPull: lane.autoPull,
        runtimeStatus,
        runtimeHealth: runtimeStatus === "ready" || runtimeStatus === "busy" ? "healthy" : runtimeStatus,
        containerFound: Boolean(containerState?.found),
        containerStatus: containerState?.status ?? null,
        modelReady: runtimeProbe?.modelReady ?? null,
        loadedModels: runtimeProbe?.loadedModels ?? [],
        localResourceSummary: lane.targetConcurrency <= 0
          ? "Local lane is configured with 0 workers."
          : runtimeStatus === "missing-model"
            ? `Local runtime is running, but ${lane.model} is not loaded.`
          : runtimeStatus === "unreachable"
            ? "Local runtime container is running, but its health endpoint is not reachable."
          : containerState?.running
            ? "Local runtime container is running."
            : "Local runtime container is not running."
      };
    }

    if (lane.provider === "openai_compatible") {
      // Featherless-style providers have no daily/weekly usage window — the
      // only real ceiling is concurrency, derived from the plan's unit
      // budget and the selected model's per-request unit cost. Reusing the
      // hosted_codex quota-window fields here would fabricate a "remaining
      // percent" that does not exist for this provider.
      const maxSupportedConcurrency = lane.requestCostUnits > 0
        ? Math.floor(lane.providerConcurrencyBudgetUnits / lane.requestCostUnits)
        : null;
      return {
        ...base,
        remainingPercent: null,
        weeklyRemainingPercent: null,
        effectiveReserveRemainingPercent: null,
        reset: "-",
        weeklyReset: "-",
        telemetryAt: null,
        telemetryAge: "no usage window",
        providerConcurrencyBudgetUnits: lane.providerConcurrencyBudgetUnits,
        requestCostUnits: lane.requestCostUnits,
        maxSupportedConcurrency
      };
    }

    const snapshot = applyUsageOverride(
      readLaneSnapshot(lane.model),
      getLaneUsageOverride(dispatcherState, lane.key, lane.model)
    );
    const effectiveReserve = computeDynamicReserve(
      snapshot,
      lane.pauseBelowRemainingPercent,
      lane.reserveWindowHours * 60
    );
    return {
      ...base,
      remainingPercent: snapshot?.remainingPercent ?? null,
      weeklyRemainingPercent: snapshot?.secondaryRemainingPercent ?? null,
      effectiveReserveRemainingPercent: effectiveReserve,
      reset: formatReset(snapshot?.resetsAt),
      weeklyReset: formatReset(snapshot?.secondaryResetsAt),
      telemetryAt: snapshot?.timestamp ?? null,
      telemetryAge: formatTelemetryAge(snapshot?.timestamp)
    };
  });
  const byKey = Object.fromEntries(telemetryLanes.map((lane) => [lane.key, lane]));

  return {
    lanes: telemetryLanes,
    primary: byKey.primary,
    secondary: byKey.secondary,
    local: byKey.local
  };
}

function deriveRepoStatus(repoState, controlState, dispatcherState, autonomousState) {
  if (controlState.manualPause) {
    return {
      status: "paused_manual",
      pauseReason: controlState.manualPause.reason ?? repoState.pauseReason ?? "manually paused"
    };
  }

  const dispatcherAlive = Boolean(dispatcherState?.alive);
  const autonomousAlive = Boolean(autonomousState?.alive);
  const items = dispatcherAlive && Array.isArray(dispatcherState?.items) ? dispatcherState.items : [];
  const runningCount = items.filter((item) => item.status === "running").length;
  const queuedCount = items.filter((item) => item.status === "queued").length;
  if (runningCount > 0 || queuedCount > 0) {
    return {
      status: "running",
      pauseReason: runningCount > 0 ? "active worker lanes" : "work queued"
    };
  }

  if (repoState.status === "running" && !dispatcherAlive && !autonomousAlive) {
    return {
      status: "ready",
      pauseReason: "execution services stopped"
    };
  }

  return {
    status: repoState.status,
    pauseReason: repoState.pauseReason
  };
}

function buildOperationsCards(repoState, controlState, services, targetIssues, openPrs, mergedPrs, effectiveRepoState) {
  return [
    {
      label: "Repo Status",
      value: effectiveRepoState.status,
      sub: effectiveRepoState.pauseReason ?? "ready for work"
    },
    {
      label: "Manual Pause",
      value: controlState.manualPause ? "On" : "Off",
      sub: controlState.manualPause?.reason ?? "not set"
    },
    {
      label: "Target Issues",
      value: String(targetIssues.length),
      sub: "matching current target filters"
    },
    {
      label: "Open PRs",
      value: String(openPrs.length),
      sub: "currently in repo"
    },
    {
      label: "Merged PRs",
      value: String(mergedPrs.length),
      sub: "recent merged history"
    },
    {
      label: "Running Services",
      value: String(
        Object.values(services).filter((entry) => entry.state?.lifecycle === "running").length
      ),
      sub: "visible local roles"
    }
  ];
}

function addReadinessConcern(collection, code, message, detail = null) {
  collection.push({ code, message, detail });
}

function buildTargetRepoMountStatus(config) {
  const workspacePath = config.repo?.workspace_dir ?? null;
  if (!workspacePath) {
    return {
      status: "unknown",
      tone: "warn",
      label: "Workspace path unavailable",
      path: null,
      detail: "No target repo workspace path is configured."
    };
  }

  try {
    if (!fs.existsSync(workspacePath)) {
      return {
        status: "missing",
        tone: "bad",
        label: "Target repo not mounted",
        path: workspacePath,
        detail: "The configured target repo workspace path does not exist."
      };
    }
    const stat = fs.statSync(workspacePath);
    if (!stat.isDirectory()) {
      return {
        status: "invalid",
        tone: "bad",
        label: "Target repo mount invalid",
        path: workspacePath,
        detail: "The configured target repo workspace path is not a directory."
      };
    }
    return {
      status: "mounted",
      tone: "good",
      label: "Target repo mounted",
      path: workspacePath,
      detail: fs.existsSync(path.join(workspacePath, ".git"))
        ? "Workspace directory is present with Git metadata."
        : "Workspace directory is present."
    };
  } catch (error) {
    return {
      status: "unreadable",
      tone: "bad",
      label: "Target repo mount unreadable",
      path: workspacePath,
      detail: error.message
    };
  }
}

function githubVisibilityStatus({ enabled, error, count, label }) {
  if (!enabled) {
    return {
      status: "disabled",
      tone: "warn",
      label: `${label} hidden`,
      count,
      detail: "Dashboard visibility is disabled by config."
    };
  }
  if (error) {
    return {
      status: "degraded",
      tone: "warn",
      label: `${label} cached`,
      count,
      detail: error
    };
  }
  return {
    status: "visible",
    tone: "good",
    label: `${label} visible`,
    count,
    detail: `${count} item${count === 1 ? "" : "s"} visible from the latest refresh.`
  };
}

function serviceReadinessItem(config, services, service) {
  if (service === "dashboard") {
    const configEnabled = config.roles.enabled?.dashboard !== false;
    return {
      service,
      label: "Dashboard",
      lifecycle: configEnabled ? "running" : "disabled",
      tone: configEnabled ? "good" : "bad",
      configEnabled,
      desiredEnabled: configEnabled,
      summary: configEnabled ? "dashboard is serving this readiness panel" : "dashboard disabled by config",
      statusSource: "dashboard process"
    };
  }

  const entry = services[service] ?? {};
  const state = entry.state ?? {};
  const lifecycle = state.lifecycle ?? "unknown";
  const configEnabled = state.configEnabled !== false && config.roles.enabled?.[service] !== false;
  const desiredEnabled = state.desiredEnabled !== false;
  const tone = lifecycle === "running" ? "good" : lifecycle === "starting" ? "warn" : "bad";
  const statusSource = state.containerAvailable
    ? `docker: ${state.containerStatus || "unknown"}`
    : state.lifecycleSource
      ? `${state.lifecycleSource} state`
      : "state unavailable";

  return {
    service,
    label: service.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
    lifecycle,
    tone,
    configEnabled,
    desiredEnabled,
    summary: state.summary ?? null,
    statusSource
  };
}

function buildRequiredServiceReadiness(config, services, blockers, warnings) {
  const items = REQUIRED_READINESS_SERVICES.map((service) => serviceReadinessItem(config, services, service));
  const summary = {
    total: items.length,
    running: items.filter((item) => item.lifecycle === "running").length,
    starting: items.filter((item) => item.lifecycle === "starting").length,
    stopped: items.filter((item) => item.lifecycle === "stopped").length,
    disabled: items.filter((item) => item.lifecycle === "disabled").length,
    degraded: items.filter((item) => item.tone === "warn").length
  };

  for (const item of items) {
    if (!item.configEnabled) {
      addReadinessConcern(blockers, `service-${item.service}-disabled`, `${item.label} is disabled by config.`, item.summary);
      continue;
    }
    if (!item.desiredEnabled) {
      addReadinessConcern(blockers, `service-${item.service}-desired-off`, `${item.label} is desired off.`, item.summary);
      continue;
    }
    if (item.lifecycle === "running") {
      continue;
    }
    const target = item.lifecycle === "starting" ? warnings : blockers;
    addReadinessConcern(target, `service-${item.service}-${item.lifecycle}`, `${item.label} is ${item.lifecycle}.`, item.summary);
  }

  return { summary, items };
}

export function buildDeploymentReadiness({
  config,
  configVersion,
  stack,
  dashboardPort,
  services,
  targetIssues,
  openPrs,
  mergedPrs,
  githubCache
}) {
  const blockers = [];
  const warnings = [];
  const targetRepoMount = buildTargetRepoMountStatus(config);
  if (targetRepoMount.tone === "bad") {
    addReadinessConcern(blockers, "target-repo-mount", targetRepoMount.label, targetRepoMount.detail);
  } else if (targetRepoMount.tone === "warn") {
    addReadinessConcern(warnings, "target-repo-mount", targetRepoMount.label, targetRepoMount.detail);
  }

  const githubErrors = githubCache?.errors ?? {};
  const githubVisibility = {
    issues: githubVisibilityStatus({
      enabled: Boolean(config.dashboard.expose_issue_details),
      error: githubErrors.targetIssues,
      count: Array.isArray(targetIssues) ? targetIssues.length : 0,
      label: "Issues"
    }),
    pullRequests: githubVisibilityStatus({
      enabled: Boolean(config.dashboard.expose_pr_links),
      error: githubErrors.openPrs,
      count: Array.isArray(openPrs) ? openPrs.length : 0,
      label: "Pull requests"
    }),
    mergedPullRequests: githubVisibilityStatus({
      enabled: true,
      error: githubErrors.mergedPrs,
      count: Array.isArray(mergedPrs) ? mergedPrs.length : 0,
      label: "Merged PRs"
    }),
    updatedAt: githubCache?.updatedAt ?? null
  };

  for (const [key, visibility] of Object.entries(githubVisibility)) {
    if (visibility?.tone === "warn") {
      addReadinessConcern(warnings, `github-${key}`, visibility.label, visibility.detail);
    }
  }

  const requiredServices = buildRequiredServiceReadiness(config, services, blockers, warnings);

  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "degraded" : "ready";
  const tone = status === "ready" ? "good" : status === "degraded" ? "warn" : "bad";
  const summary =
    status === "ready"
      ? "Current stack is ready to run."
      : status === "degraded"
        ? "Current stack can run, but readiness concerns need attention."
        : "Current stack should not run until blockers are resolved.";

  return {
    status,
    label: status.charAt(0).toUpperCase() + status.slice(1),
    tone,
    summary,
    blockers,
    warnings,
    config: {
      valid: true,
      schemaVersion: config.version ?? null,
      currentVersion: configVersion,
      path: configPath
    },
    identity: {
      repoKey: config.repo.key,
      githubSlug: config.repo.github_slug,
      defaultBranch: config.repo.default_branch,
      stackId: stack.stackId,
      stackSource: stack.source,
      stateRoot: stack.stateRoot,
      dashboardPort
    },
    targetRepoMount,
    githubVisibility,
    requiredServices
  };
}

function readFileTail(filePath, count = 8) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  try {
    return fs.readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-count);
  } catch {
    return [];
  }
}

function normalizePullRequestRecord(pr) {
  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid ?? null,
    baseRefName: pr.baseRefName ?? null,
    url: pr.url ?? null,
    isDraft: Boolean(pr.isDraft),
    mergeStateStatus: pr.mergeStateStatus ?? null,
    labels: Array.isArray(pr.labels) ? pr.labels : []
  };
}

function normalizeMergedPullRequestRecord(pr) {
  if (!pr) {
    return null;
  }

  return {
    number: pr.number,
    title: pr.title ?? null,
    mergedAt: pr.mergedAt ?? pr.merged_at ?? null,
    url: pr.url ?? null,
    source: pr.source ?? null
  };
}

function buildMergedPullRequests(services, githubMergedPrs) {
  const localMergedPrs = Array.isArray(services["pr-manager"]?.state?.mergedPrs)
    ? services["pr-manager"].state.mergedPrs
    : [];
  const combined = [
    ...localMergedPrs.map((pr) => ({ ...pr, source: "local" })),
    ...(Array.isArray(githubMergedPrs) ? githubMergedPrs : []).map((pr) => ({ ...pr, source: "github" }))
  ];
  const deduped = new Map();

  for (const entry of combined) {
    const normalized = normalizeMergedPullRequestRecord(entry);
    if (!normalized?.number || deduped.has(normalized.number)) {
      continue;
    }
    deduped.set(normalized.number, normalized);
  }

  return Array.from(deduped.values())
    .sort((left, right) => Date.parse(right.mergedAt ?? 0) - Date.parse(left.mergedAt ?? 0))
    .slice(0, 12);
}

function getLocalServicePrRecord(serviceState, prNumber) {
  const prs = serviceState?.prs;
  if (!prs || typeof prs !== "object") {
    return null;
  }
  return prs[prNumber] ?? prs[String(prNumber)] ?? null;
}

function recordMatchesHead(record, headSha) {
  if (!record) {
    return false;
  }
  if (!headSha || !record.sha) {
    return true;
  }
  return record.sha === headSha;
}

function localGateForPr(record, headSha) {
  if (!recordMatchesHead(record, headSha)) {
    return "pending";
  }
  return record?.result === "success" ? "success" : record?.result === "failure" ? "failure" : "pending";
}

function reviewerGateRequired(config) {
  return config.reviewer.enabled !== false;
}

function mergeAllowedForPr(config, pr) {
  if (!config.safety.auto_merge) {
    return false;
  }

  const labels = Array.isArray(pr.labels) ? pr.labels.map((label) => label.name) : [];
  if (config.pr_manager.auto_merge_label && !labels.includes(config.pr_manager.auto_merge_label)) {
    return false;
  }

  return true;
}

function evaluatePullRequestReadiness(config, pr, validatorState, reviewerState) {
  const validatorRecord = getLocalServicePrRecord(validatorState, pr.number);
  const reviewerRecord = getLocalServicePrRecord(reviewerState, pr.number);
  const validateState = localGateForPr(validatorRecord, pr.headRefOid);
  const reviewerStateValue = reviewerGateRequired(config)
    ? localGateForPr(reviewerRecord, pr.headRefOid)
    : "skipped";
  const mergeState = String(pr.mergeStateStatus ?? "").toUpperCase();

  let readiness = "waiting";
  let reason = "waiting for local validation";

  if (pr.isDraft) {
    readiness = "blocked";
    reason = "draft pull request";
  } else if (mergeState === "DIRTY") {
    readiness = "blocked";
    reason = "merge conflicts";
  } else if (mergeState === "BEHIND") {
    readiness = "update_branch";
    reason = "branch behind base";
  } else if (validateState === "failure") {
    readiness = "blocked";
    reason = "local validator failed";
  } else if (reviewerStateValue === "failure") {
    readiness = "blocked";
    reason = "local reviewer failed";
  } else if (validateState !== "success") {
    readiness = "waiting";
    reason = "waiting for local validation";
  } else if (reviewerStateValue !== "success" && reviewerStateValue !== "skipped") {
    readiness = "waiting";
    reason = "waiting for local review";
  } else if (!mergeAllowedForPr(config, pr)) {
    readiness = "blocked";
    reason = config.safety.auto_merge
      ? "missing required merge label"
      : "local merge disabled by repo config";
  } else {
    readiness = "merge";
    reason = "local validator and reviewer are green";
  }

  return {
    readiness,
    reason,
    validateState,
    reviewerState: reviewerStateValue
  };
}

export function classifyRemediationStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "none") {
    return null;
  }

  if (normalized.includes("retry_waiting") || (normalized.includes("retry") && normalized.includes("wait"))) {
    return {
      key: "waiting-retry",
      label: "Waiting to retry",
      tone: "warn"
    };
  }

  if (normalized === "retry_running") {
    return {
      key: "remediation-running",
      label: "Retry running",
      tone: "warn"
    };
  }
  if (normalized.includes("running")) {
    return {
      key: "remediation-running",
      label: "Remediation running",
      tone: "warn"
    };
  }

  if (normalized.includes("queue") || normalized.includes("pending") || normalized.includes("scheduled")) {
    return {
      key: "remediation-queued",
      label: "Remediation queued",
      tone: "warn"
    };
  }

  if (normalized.includes("blocked")) {
    return {
      key: "blocked",
      label: "Blocked",
      tone: "bad"
    };
  }

  return {
    key: "remediation",
    label: `Remediation: ${value}`,
    tone: "warn"
  };
}

export function buildCheckRecord(serviceName, record, headSha) {
  const current = recordMatchesHead(record, headSha);
  const failureSummary = record?.failure_summary ?? record?.error ?? null;
  const remediation = classifyRemediationStatus(record?.remediation_status);
  const result = !current
    ? "pending"
    : record?.result === "failure"
      ? "failure"
      : record?.result === "success"
        ? "success"
        : "pending";
  const label = result === "success"
    ? "Passed"
    : result === "failure"
      ? "Failed"
      : "Pending";
  const tone = result === "success" ? "good" : result === "failure" ? "bad" : "warn";
  const shouldShowExcerpt = Boolean(
    current
    && record?.run_log
    && (result === "failure" || failureSummary || remediation)
  );

  return {
    service: serviceName,
    current,
    result,
    label,
    tone,
    title: record?.title ?? null,
    updatedAt: current ? (record?.updated_at ?? null) : null,
    branch: current ? (record?.branch ?? null) : null,
    failureSummary: current ? failureSummary : null,
    failureCount: current && Number(record?.failure_count) > 0 ? Number(record.failure_count) : null,
    lastAttemptAt: current ? (record?.last_attempt_at ?? record?.updated_at ?? null) : null,
    nextRetryAt: current ? (record?.next_retry_at ?? null) : null,
    remediationStatus: current ? (record?.remediation_status ?? null) : null,
    remediation,
    runLog: current ? (record?.run_log ?? null) : null,
    runLogExcerpt: shouldShowExcerpt ? readFileTail(record.run_log, 6) : [],
    outputPath: current ? (record?.output_path ?? null) : null,
    model: current ? (record?.model ?? null) : null,
    reasoningEffort: current ? (record?.reasoning_effort ?? null) : null
  };
}

export function deriveMovementState(pr, localGate, checks) {
  const failingCheck = [checks.validator, checks.reviewer].find((check) => check.result === "failure") ?? null;
  const remediation = [checks.validator, checks.reviewer]
    .map((check) => check.remediation)
    .find(Boolean) ?? null;
  const nextRetryAt = failingCheck?.nextRetryAt ?? null;
  const hasFutureRetry = Number.isFinite(Date.parse(String(nextRetryAt ?? ""))) && Date.parse(nextRetryAt) > Date.now();

  if (remediation?.key === "waiting-retry" && hasFutureRetry) {
    return {
      key: "waiting-retry",
      label: "Waiting to retry",
      tone: remediation.tone,
      detail: failingCheck?.failureSummary ?? `${failingCheck?.service ?? "local"} will retry automatically.`,
      nextRetryAt
    };
  }

  if (remediation?.key === "remediation-running") {
    return {
      key: "remediation-running",
      label: remediation.label,
      tone: remediation.tone,
      detail: failingCheck?.failureSummary ?? `${failingCheck?.service ?? "local"} failure is being repaired locally.`,
      nextRetryAt: null
    };
  }

  if (remediation?.key === "waiting-retry" && failingCheck && hasFutureRetry) {
    return {
      key: "waiting-retry",
      label: "Waiting to retry",
      tone: remediation.tone,
      detail: failingCheck.failureSummary ?? `${failingCheck.service} will retry automatically.`,
      nextRetryAt
    };
  }

  if (remediation?.key === "remediation-queued" || remediation?.key === "remediation") {
    return {
      key: "remediation-queued",
      label: "Remediation queued",
      tone: remediation.tone,
      detail: failingCheck?.failureSummary ?? `${failingCheck?.service ?? "local"} failure is queued for local remediation.`,
      nextRetryAt: null
    };
  }

  if (failingCheck && hasFutureRetry) {
    return {
      key: "waiting-retry",
      label: "Waiting to retry",
      tone: "warn",
      detail: failingCheck.failureSummary ?? `${failingCheck.service} will retry automatically.`,
      nextRetryAt
    };
  }

  if (failingCheck) {
    return {
      key: "blocked",
      label: "Blocked",
      tone: "bad",
      detail: failingCheck.failureSummary ?? `${failingCheck.service} failed.`,
      nextRetryAt
    };
  }

  if (localGate.readiness === "merge") {
    return {
      key: "ready",
      label: "Ready locally",
      tone: "good",
      detail: localGate.reason,
      nextRetryAt: null
    };
  }

  if (localGate.readiness === "update_branch") {
    return {
      key: "update-branch",
      label: "Update branch",
      tone: "warn",
      detail: localGate.reason,
      nextRetryAt: null
    };
  }

  if (localGate.readiness === "blocked") {
    return {
      key: "blocked",
      label: "Blocked",
      tone: "bad",
      detail: localGate.reason,
      nextRetryAt: null
    };
  }

  return {
    key: "waiting-local",
    label: "Waiting on local checks",
    tone: "warn",
    detail: localGate.reason,
    nextRetryAt: null
  };
}

function buildPrDrillDown(config, services, openPrs, githubErrors) {
  const prManagerOpenPrs = Array.isArray(services["pr-manager"]?.state?.openPrs)
    ? services["pr-manager"].state.openPrs
    : [];
  const sourcePrs = (githubErrors.openPrs || !config.dashboard.expose_pr_links)
    ? prManagerOpenPrs
    : openPrs;
  const validatorState = services.validator?.state ?? {};
  const reviewerState = services.reviewer?.state ?? {};

  return sourcePrs
    .map((pr) => normalizePullRequestRecord(pr))
    .sort((left, right) => Number(left.number) - Number(right.number))
    .map((pr) => {
      const checks = {
        validator: buildCheckRecord("validator", getLocalServicePrRecord(validatorState, pr.number), pr.headRefOid),
        reviewer: buildCheckRecord("reviewer", getLocalServicePrRecord(reviewerState, pr.number), pr.headRefOid)
      };
      const localGate = evaluatePullRequestReadiness(config, pr, validatorState, reviewerState);
      const localGateTone = localGate.readiness === "merge"
        ? "good"
        : localGate.readiness === "blocked"
          ? "bad"
          : "warn";

      return {
        ...pr,
        movement: deriveMovementState(pr, localGate, checks),
        localGate: {
          ...localGate,
          label: localGate.readiness === "merge"
            ? "Ready locally"
            : localGate.readiness === "update_branch"
              ? "Update branch"
              : localGate.readiness === "blocked"
                ? "Blocked"
                : "Waiting",
          tone: localGateTone
        },
        checks
      };
    });
}

function readRunLogTail(logPath, count = 40) {
  if (!logPath || !fs.existsSync(logPath)) {
    return [];
  }

  try {
    return fs.readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-count);
  } catch {
    return [];
  }
}

function compareDispatcherActivity(left, right) {
  const leftTime = Date.parse(
    left?.started_at ?? left?.finished_at ?? left?.updated_at ?? 0
  );
  const rightTime = Date.parse(
    right?.started_at ?? right?.finished_at ?? right?.updated_at ?? 0
  );
  return rightTime - leftTime;
}

function formatWorkerStatusLabel(status, result, remediationStatus) {
  if (status === "running" || result === "pending" || remediationStatus === "retry_running") {
    return "live";
  }
  if (result === "success") {
    return "pass";
  }
  if (remediationStatus === "retry_waiting") {
    return "waiting retry";
  }
  if (result === "failure") {
    return "fail";
  }
  return status || result || "idle";
}

function buildCodexActivityEntry(item) {
  const startedAt = item.started_at ? new Date(item.started_at).toLocaleString() : null;
  const finishedAt = item.finished_at ? new Date(item.finished_at).toLocaleString() : null;
  const timing = item.status === "running"
    ? (startedAt ? `Started ${startedAt}` : "Running now")
    : finishedAt
      ? `Finished ${finishedAt}`
      : "Completed recently";

  return {
    key: `${item.status}:${item.number}:${item.assigned_lane ?? ""}:${item.assigned_model ?? ""}:${item.branch ?? ""}`,
    number: item.number,
    issueTitle: item.title,
    branch: item.branch,
    lane: item.assigned_lane ?? null,
    model: item.assigned_model ?? null,
    status: item.status,
    title: item.status === "running" ? `Issue #${item.number} in progress` : `Issue #${item.number} last activity`,
    summary: item.title,
    selectorLabel: `#${item.number} ${item.title} · ${formatWorkerStatusLabel(item.status)}`,
    meta: [
      item.assigned_model ? `Model ${item.assigned_model}` : null,
      item.assigned_lane ? `lane ${item.assigned_lane}` : null,
      timing
    ].filter(Boolean).join(" · "),
    logTail: readRunLogTail(item.log, 160)
  };
}

function compareReviewActivity(left, right) {
  const leftTime = Date.parse(left?.updated_at ?? left?.last_attempt_at ?? 0);
  const rightTime = Date.parse(right?.updated_at ?? right?.last_attempt_at ?? 0);
  return rightTime - leftTime;
}

function buildReviewActivityEntry(serviceKey, entry) {
  const updatedAt = entry.updated_at ? new Date(entry.updated_at).toLocaleString() : null;
  const retryAt = entry.next_retry_at ? new Date(entry.next_retry_at).toLocaleString() : null;
  const statusLabel = formatWorkerStatusLabel(entry.status ?? null, entry.result ?? null, entry.remediation_status ?? null);
  return {
    key: `${serviceKey}:${entry.number}:${entry.sha ?? ""}`,
    number: entry.number,
    title: entry.title,
    result: entry.result ?? null,
    statusLabel,
    selectorLabel: `#${entry.number} ${entry.title} · ${statusLabel}`,
    summary: entry.title,
    meta: [
      entry.result === "success" ? "Passed" : entry.remediation_status === "retry_running"
        ? "Retrying"
        : entry.remediation_status === "retry_waiting"
          ? "Waiting retry"
          : entry.result === "failure"
            ? "Failed"
            : "Pending",
      updatedAt ? `Updated ${updatedAt}` : null,
      retryAt ? `Retry ${retryAt}` : null,
      entry.failure_count > 0 ? `Attempts ${entry.failure_count}` : null
    ].filter(Boolean).join(" · "),
    logTail: readRunLogTail(entry.run_log, 48),
    error: entry.failure_summary ?? entry.error ?? null
  };
}

function buildReviewActivity(serviceState, serviceKey) {
  const entries = Object.values(serviceState?.prs ?? {})
    .filter((entry) => entry && entry.number != null)
    .sort(compareReviewActivity)
    .slice(0, 20)
    .map((entry) => buildReviewActivityEntry(serviceKey, entry));
  return {
    selected: entries[0] ?? null,
    workers: entries
  };
}

function buildCodexActivity(services) {
  const dispatcherState = services.dispatcher?.state ?? {};
  const items = Array.isArray(dispatcherState.items) ? dispatcherState.items : [];
  const running = items.filter((item) => item.status === "running").sort(compareDispatcherActivity);
  const recent = items
    .filter((item) => item.status === "completed" || item.status === "failed")
    .sort(compareDispatcherActivity)
    .slice(0, 12);
  const workers = [...running, ...recent].map((item) => buildCodexActivityEntry(item));
  const selected = workers[0] ?? null;

  if (!selected) {
    return {
      title: "No active coder worker",
      summary: "No dispatcher run has started yet.",
      meta: "The next dispatched issue will stream its run log here.",
      logTail: [],
      workers: []
    };
  }

  return {
    ...selected,
    workers
  };
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function safeExec(command, args, timeout = 2000) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        timeout
      }).trim()
    };
  } catch (error) {
    return {
      ok: false,
      error: error.stderr?.toString?.().trim() || error.message
    };
  }
}

function parsePercent(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPercent(value) {
  if (value == null) {
    return "-";
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "-";
  }
  return `${parsed.toFixed(parsed >= 10 ? 1 : 2)}%`;
}

function readProcCpuTimes() {
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split(/\r?\n/)[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) {
      return null;
    }
    const idle = parts[3] + (parts[4] ?? 0);
    const total = parts.reduce((sum, value) => sum + value, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function sampleHostCpuPercent(sampleMs = 250) {
  const before = readProcCpuTimes();
  if (!before) {
    return null;
  }
  const gate = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(gate, 0, 0, sampleMs);
  const after = readProcCpuTimes();
  if (!after) {
    return null;
  }
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (totalDelta <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

function parseDockerStatsLines(output, cpuCount = os.cpus().length) {
  return String(output || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const row = JSON.parse(line);
        const rawCpuPercent = parsePercent(row.CPUPerc);
        const hostSharePercent = rawCpuPercent == null || !cpuCount
          ? null
          : rawCpuPercent / cpuCount;
        return {
          id: row.ID ?? row.Container ?? "",
          name: row.Name ?? row.Container ?? "container",
          cpu: row.CPUPerc ?? "-",
          cpuRawPercent: rawCpuPercent,
          cpuHostShare: formatPercent(hostSharePercent),
          cpuHostSharePercent: hostSharePercent,
          memory: row.MemUsage ?? "-",
          memoryPercent: row.MemPerc ?? "-",
          network: row.NetIO ?? "-",
          block: row.BlockIO ?? "-",
          pids: row.PIDs ?? "-"
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function collectDiskStats() {
  const paths = ["/", stateDir, process.env.AE_WORKSPACE_DIR ?? "/workspace/target-repo"];
  const result = safeExec("df", ["-kP", ...Array.from(new Set(paths))], 2000);
  if (!result.ok) {
    return { available: false, error: result.error, filesystems: [], blockDevices: collectBlockDevices() };
  }
  return {
    available: true,
    filesystems: result.stdout.split(/\r?\n/).slice(1).map((line) => {
      const parts = line.trim().split(/\s+/);
      const mount = parts.slice(5).join(" ") || parts[5] || "";
      return {
        filesystem: parts[0] ?? "",
        size: formatBytes(Number(parts[1]) * 1024),
        used: formatBytes(Number(parts[2]) * 1024),
        available: formatBytes(Number(parts[3]) * 1024),
        usePercent: parts[4] ?? "-",
        mount
      };
    }).filter((entry) => entry.mount),
    blockDevices: collectBlockDevices()
  };
}

function collectMountpoints(device) {
  const own = Array.isArray(device?.mountpoints)
    ? device.mountpoints
    : device?.mountpoint
      ? [device.mountpoint]
      : [];
  const childMounts = Array.isArray(device?.children)
    ? device.children.flatMap((child) => collectMountpoints(child))
    : [];
  return [...new Set([...own, ...childMounts].filter(Boolean))];
}

function collectBlockDevices() {
  const result = safeExec("lsblk", ["-bJ", "-o", "NAME,TYPE,SIZE,MODEL,ROTA,TRAN,MOUNTPOINTS,FSTYPE"], 2000);
  if (!result.ok) {
    return { available: false, error: result.error, devices: [] };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const devices = (Array.isArray(parsed?.blockdevices) ? parsed.blockdevices : [])
      .filter((device) => device?.type === "disk")
      .map((device) => ({
        name: device.name ?? "",
        size: formatBytes(Number(device.size)),
        model: String(device.model ?? "").trim() || "-",
        media: Number(device.rota) === 1 ? "HDD" : "SSD",
        transport: device.tran ?? "-",
        visibleMounts: collectMountpoints(device).join(", ") || "not visible from dashboard container"
      }));
    return { available: true, devices };
  } catch (error) {
    return { available: false, error: error.message, devices: [] };
  }
}

function readMemInfo() {
  try {
    return Object.fromEntries(
      fs.readFileSync("/proc/meminfo", "utf8")
        .split(/\r?\n/)
        .map((line) => line.match(/^([^:]+):\s+(\d+)\s+kB$/))
        .filter(Boolean)
        .map((match) => [match[1], Number(match[2]) * 1024])
    );
  } catch {
    return {};
  }
}

function collectMemoryStats() {
  const memInfo = readMemInfo();
  const total = memInfo.MemTotal ?? os.totalmem();
  const available = memInfo.MemAvailable ?? os.freemem();
  const free = memInfo.MemFree ?? os.freemem();
  const cache = (memInfo.Cached ?? 0) + (memInfo.SReclaimable ?? 0) + (memInfo.Buffers ?? 0);
  const used = Math.max(0, total - available);
  const swapTotal = memInfo.SwapTotal ?? 0;
  const swapFree = memInfo.SwapFree ?? 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);
  return {
    total: formatBytes(total),
    used: formatBytes(used),
    free: formatBytes(free),
    available: formatBytes(available),
    cache: formatBytes(cache),
    usedPercent: total > 0 ? Math.round((used / total) * 100) : null,
    swapTotal: formatBytes(swapTotal),
    swapUsed: formatBytes(swapUsed),
    swapFree: formatBytes(swapFree),
    swapUsedPercent: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0
  };
}

function buildResourceMonitor() {
  const cpuCount = os.cpus().length;
  const loadAverage = os.loadavg().map((value) => Number(value.toFixed(2)));
  const loadHostSharePercent = cpuCount > 0 ? (loadAverage[0] / cpuCount) * 100 : null;
  const sampledCpuPercent = sampleHostCpuPercent();
  const memory = collectMemoryStats();
  const dockerStats = safeExec("docker", ["stats", "--no-stream", "--format", "{{json .}}"], 4000);
  const dockerInfo = safeExec("docker", ["info", "--format", "{{json .}}"], 3000);
  let dockerSummary = {};
  if (dockerInfo.ok && dockerInfo.stdout) {
    try {
      const info = JSON.parse(dockerInfo.stdout);
      dockerSummary = {
        containers: info.Containers ?? null,
        containersRunning: info.ContainersRunning ?? null,
        images: info.Images ?? null,
        ncpu: info.NCPU ?? null,
        memTotal: info.MemTotal ? formatBytes(info.MemTotal) : null,
        serverVersion: info.ServerVersion ?? null
      };
    } catch {
      dockerSummary = {};
    }
  }

  const dockerCpuCount = Number(dockerSummary.ncpu ?? cpuCount);
  const containers = dockerStats.ok ? parseDockerStatsLines(dockerStats.stdout, dockerCpuCount) : [];
  const totalDockerRawCpuPercent = containers.reduce((sum, container) => (
    sum + (Number.isFinite(container.cpuRawPercent) ? container.cpuRawPercent : 0)
  ), 0);
  const totalDockerHostSharePercent = dockerCpuCount > 0 ? totalDockerRawCpuPercent / dockerCpuCount : null;
  const reportedContainers = containers.map((container) => {
    const { cpu, cpuRawPercent, ...reported } = container;
    return reported;
  });

  return {
    generatedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cpuCount,
      loadAverage,
      loadHostShare: formatPercent(loadHostSharePercent),
      loadHostSharePercent,
      sampledCpu: formatPercent(sampledCpuPercent),
      sampledCpuPercent,
      memory
    },
    docker: {
      available: dockerStats.ok,
      error: dockerStats.ok ? null : dockerStats.error,
      summary: {
        ...dockerSummary,
        totalHostShare: formatPercent(totalDockerHostSharePercent),
        totalHostSharePercent: totalDockerHostSharePercent
      },
      containers: reportedContainers
    },
    disk: collectDiskStats()
  };
}

export async function collectState() {
  const config = getConfig();
  const stack = resolveStackIdentity(stateDir, config.repo.key);
  const controlState = loadControlState(stateDir, config.repo.key);
  if (ensureDesiredServiceDefaults(config, controlState)) {
    saveControlState(stateDir, config.repo.key, controlState);
  }
  const services = Object.fromEntries(
    SERVICES.map((service) => [service, buildServiceEntry(config, controlState, service)])
  );
  const repoState = syncPersistedServiceModel(config, controlState, services);
  let targetIssues = githubCache.targetIssues;
  let openPrs = githubCache.openPrs;
  let mergedPrs = githubCache.mergedPrs;
  const githubErrors = {};

  if (config.dashboard.expose_issue_details) {
    try {
      targetIssues = listOpenIssuesForTarget(config, { timeoutMs: DASHBOARD_GH_TIMEOUT_MS });
      githubCache.targetIssues = targetIssues;
    } catch (error) {
      githubErrors.targetIssues = error.message;
    }
  } else {
    targetIssues = [];
  }

  if (config.dashboard.expose_pr_links) {
    try {
      openPrs = listOpenPullRequests(config, { timeoutMs: DASHBOARD_GH_TIMEOUT_MS });
      githubCache.openPrs = openPrs;
    } catch (error) {
      githubErrors.openPrs = error.message;
    }
  } else {
    openPrs = [];
  }

  try {
    mergedPrs = getMergedPullRequests(config, 5, { timeoutMs: DASHBOARD_GH_TIMEOUT_MS });
    githubCache.mergedPrs = mergedPrs;
  } catch (error) {
    githubErrors.mergedPrs = error.message;
  }

  githubCache.errors = githubErrors;
  githubCache.updatedAt = new Date().toISOString();
  const laneControl = buildLaneControl(config);
  const policyControl = buildPolicyControl(config);
  const laneTelemetry = buildLaneTelemetry(config, services.dispatcher?.state);
  const effectiveRepoState = {
    ...repoState,
    ...deriveRepoStatus(repoState, controlState, services.dispatcher?.state, services.autonomous?.state)
  };
  const prDrillDown = buildPrDrillDown(config, services, openPrs, githubErrors);
  const mergedPrHistory = buildMergedPullRequests(services, mergedPrs);
  const codexActivity = buildCodexActivity(services);
  const configVersion = getConfigVersion();
  const dashboardPort = Number.parseInt(process.env.AE_DASHBOARD_PORT ?? String(config.dashboard.port), 10);
  const deploymentReadiness = buildDeploymentReadiness({
    config,
    configVersion,
    stack,
    dashboardPort,
    services,
    targetIssues,
    openPrs,
    mergedPrs,
    githubCache: {
      updatedAt: githubCache.updatedAt,
      errors: githubErrors
    }
  });
  const reviewActivity = {
    validator: buildReviewActivity(services.validator?.state ?? {}, "validator"),
    reviewer: buildReviewActivity(services.reviewer?.state ?? {}, "reviewer")
  };

  return {
    generatedAt: new Date().toISOString(),
    configVersion,
    repo: config.repo,
    stack,
    lifecycle: config.lifecycle,
    repoState: effectiveRepoState,
    controlState,
    services,
    targetIssues,
    openPrs,
    mergedPrs: mergedPrHistory,
    githubCache: {
      updatedAt: githubCache.updatedAt,
      errors: githubErrors
    },
    operationsCards: buildOperationsCards(
      repoState,
      controlState,
      services,
      targetIssues,
      openPrs,
      mergedPrHistory,
      effectiveRepoState
    ),
    deploymentReadiness,
    prDrillDown,
    codexActivity,
    reviewActivity,
    resourceMonitor: buildResourceMonitor(),
    laneControl,
    policyControl,
    laneTelemetry,
    dashboardOptions: {
      models: MODEL_OPTIONS,
      reasoningEfforts: REASONING_OPTIONS,
      reviewerPostModes: ["comment", "review"],
      lifecycleTargetModes: ["open", "milestone", "label", "backlog_file"],
      runnerManagerScopes: ["repo", "org"]
    }
  };
}

function setRepoPause(paused, reason, config) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  const controlState = loadControlState(stateDir, config.repo.key);
  controlState.manualPause = paused
    ? {
        reason,
        requestedAt: new Date().toISOString()
      }
    : null;
  repoState.status = paused ? "paused_manual" : "ready";
  repoState.pauseReason = paused ? reason : null;
  saveControlState(stateDir, config.repo.key, controlState);
  saveRepoState(stateDir, config.repo.key, repoState);
}

function setServiceDesiredState(service, enabled, config) {
  if (!serviceEnabledInConfig(config, service)) {
    const error = new Error(`${service} is disabled by config`);
    error.statusCode = 409;
    throw error;
  }

  const controlState = loadControlState(stateDir, config.repo.key);
  ensureDesiredServiceDefaults(config, controlState);
  controlState.desiredServices = {
    ...(controlState.desiredServices ?? {}),
    [service]: enabled
  };
  saveControlState(stateDir, config.repo.key, controlState);
  applyDockerServiceState(service, enabled);
  const services = Object.fromEntries(
    SERVICES.map((serviceName) => [serviceName, buildServiceEntry(config, controlState, serviceName)])
  );
  syncPersistedServiceModel(config, controlState, services);
}

function resetServiceRuntime(service, config) {
  if (!serviceEnabledInConfig(config, service)) {
    const error = new Error(`${service} is disabled by config`);
    error.statusCode = 409;
    throw error;
  }

  const controlState = loadControlState(stateDir, config.repo.key);
  ensureDesiredServiceDefaults(config, controlState);
  if (controlState.desiredServices?.[service] === false) {
    const error = new Error(`${service} is stopped; start it before resetting`);
    error.statusCode = 409;
    throw error;
  }

  controlState.desiredServices = {
    ...(controlState.desiredServices ?? {}),
    [service]: true
  };
  saveControlState(stateDir, config.repo.key, controlState);
  runDocker(["restart", serviceContainerName(service)], 10_000);
  const rawState = loadServiceState(stateDir, config.repo.key, service);
  saveServiceState(stateDir, config.repo.key, service, {
    ...rawState,
    alive: true,
    enabled: true,
    desiredEnabled: true,
    lifecycle: "running",
    summary: `${service} reset requested`,
    lastResetAt: new Date().toISOString()
  });
  const services = Object.fromEntries(
    SERVICES.map((serviceName) => [serviceName, buildServiceEntry(config, controlState, serviceName)])
  );
  syncPersistedServiceModel(config, controlState, services);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function parsePositiveInteger(value) {
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function ensureReviewService(service) {
  if (REVIEW_SERVICES.includes(service)) {
    return;
  }
  const error = new Error(`${service} is not a review service`);
  error.statusCode = 404;
  throw error;
}

function ensureRequeueAction(action) {
  if (VALID_REQUEUE_ACTIONS.includes(action)) {
    return;
  }
  const error = new Error(`unsupported requeue action ${action}`);
  error.statusCode = 400;
  throw error;
}

function getServicePrRecord(serviceState, prNumber) {
  const key = String(prNumber);
  return serviceState?.prs?.[key] ?? null;
}

function setReviewRecordPending(serviceState, prNumber) {
  const key = String(prNumber);
  const record = getServicePrRecord(serviceState, key);
  if (!record) {
    const error = new Error(`no record found for PR #${prNumber}`);
    error.statusCode = 404;
    throw error;
  }

  const now = new Date().toISOString();
  serviceState.prs[key] = {
    ...record,
    result: "pending",
    remediation_status: "retry_running",
    updated_at: now,
    next_retry_at: null,
    last_attempt_at: record.last_attempt_at ?? now
  };
  return serviceState;
}

function clearReviewRecord(serviceState, prNumber) {
  const key = String(prNumber);
  if (!serviceState?.prs || !Object.hasOwn(serviceState.prs, key)) {
    const error = new Error(`no record found for PR #${prNumber}`);
    error.statusCode = 404;
    throw error;
  }

  delete serviceState.prs[key];
  return serviceState;
}

function requeueReviewServiceRecord(stateDirValue, repoKey, service, action, prNumber) {
  ensureReviewService(service);
  ensureRequeueAction(action);
  const serviceState = loadServiceState(stateDirValue, repoKey, service);
  if (!serviceState?.prs || typeof serviceState.prs !== "object") {
    serviceState.prs = {};
  }

  if (action === "pending") {
    setReviewRecordPending(serviceState, prNumber);
  } else {
    clearReviewRecord(serviceState, prNumber);
  }

  saveServiceState(stateDirValue, repoKey, service, serviceState);
}

function splitCommandList(value) {
  return String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeLaneUpdateEntry(entry, fallback = {}) {
  const key = String(entry?.key ?? fallback.key ?? "").trim();
  const model = String(entry?.model ?? entry?.name ?? fallback.name ?? "local");
  const hasEntryModel = entry?.model != null || entry?.name != null;
  return {
    key,
    label: String(entry?.label ?? fallback.label ?? `${key} lane`),
    provider: String(
      entry?.provider
        ?? (hasEntryModel ? (isLocalDispatcherModelName(model) ? "local_container" : "hosted_codex") : undefined)
        ?? fallback.provider
        ?? "hosted_codex"
    ),
    enabled: entry?.enabled == null ? fallback.enabled !== false : Boolean(entry.enabled),
    name: model,
    reasoning_effort: String(entry?.reasoningEffort ?? entry?.reasoning_effort ?? fallback.reasoning_effort ?? "medium"),
    max_workers: asInt(entry?.targetConcurrency ?? entry?.max_workers, fallback.max_workers ?? 0, 0, 24),
    pause_threshold_used_percent: entry?.pauseBelowRemainingPercent == null
      ? fallback.pause_threshold_used_percent
      : 100 - asInt(entry.pauseBelowRemainingPercent, 0, 0, 100),
    weekly_pause_threshold_used_percent: entry?.weeklyPauseBelowRemainingPercent == null
      ? fallback.weekly_pause_threshold_used_percent
      : 100 - asInt(entry.weeklyPauseBelowRemainingPercent, 0, 0, 100),
    reserve_burn_window_minutes: entry?.reserveWindowHours == null
      ? fallback.reserve_burn_window_minutes
      : asInt(entry.reserveWindowHours, 5, 1, 48) * 60,
    nominal_burn_per_lane_hour: asNumber(
      entry?.nominalBurnPerLaneHour ?? entry?.nominal_burn_per_lane_hour,
      fallback.nominal_burn_per_lane_hour ?? 0,
      0,
      20
    ),
    provider_concurrency_budget_units: asNumber(
      entry?.providerConcurrencyBudgetUnits ?? entry?.provider_concurrency_budget_units,
      fallback.provider_concurrency_budget_units ?? 0,
      0,
      100000
    ),
    request_cost_units: asNumber(
      entry?.requestCostUnits ?? entry?.request_cost_units,
      fallback.request_cost_units ?? 0,
      0,
      100000
    ),
    runtime_service: String(entry?.runtimeService ?? entry?.runtime_service ?? fallback.runtime_service ?? ""),
    runtime_endpoint: String(entry?.runtimeEndpoint ?? entry?.runtime_endpoint ?? fallback.runtime_endpoint ?? ""),
    runtime_health_url: String(entry?.runtimeHealthUrl ?? entry?.runtime_health_url ?? fallback.runtime_health_url ?? ""),
    runtime_image: String(entry?.runtimeImage ?? entry?.runtime_image ?? fallback.runtime_image ?? ""),
    runtime_command: String(entry?.runtimeCommand ?? entry?.runtime_command ?? fallback.runtime_command ?? ""),
    local_provider: String(entry?.localProvider ?? entry?.local_provider ?? fallback.local_provider ?? ""),
    num_thread: asInt(entry?.numThread ?? entry?.num_thread, fallback.num_thread ?? 0, 0, 128),
    num_ctx: asInt(entry?.numCtx ?? entry?.num_ctx, fallback.num_ctx ?? 0, 0, 131072),
    auto_pull: entry?.autoPull == null ? Boolean(fallback.auto_pull) : Boolean(entry.autoPull)
  };
}

function splitLineList(value) {
  return String(value ?? "")
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function splitIntegerList(value) {
  return [...new Set(
    splitLineList(value)
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
  )];
}

function isLocalDispatcherModelName(name) {
  return LOCAL_MODEL_OPTIONS.has(String(name ?? "").trim());
}

function applyModelSelectedProvider(lane) {
  if (!lane || typeof lane !== "object") {
    return;
  }
  if (isLocalDispatcherModelName(lane.name)) {
    lane.provider = "local_container";
    lane.enabled = true;
    lane.reasoning_effort = "local";
    lane.runtime_service = String(lane.runtime_service ?? "local-model").trim() || "local-model";
    lane.runtime_endpoint = String(lane.runtime_endpoint ?? "http://local-model:11434/v1").trim();
    lane.runtime_health_url = String(lane.runtime_health_url ?? "http://local-model:11434/api/tags").trim();
    lane.runtime_image = String(lane.runtime_image ?? "ollama/ollama:latest").trim();
    lane.runtime_command = String(lane.runtime_command ?? "").trim();
    lane.local_provider = String(lane.local_provider ?? "ollama").trim() || "ollama";
    lane.num_thread = asInt(lane.num_thread, 0, 0, 128);
    lane.num_ctx = asInt(lane.num_ctx, 0, 0, 131072);
    lane.auto_pull = Boolean(lane.auto_pull);
    lane.pause_threshold_used_percent = 100;
    lane.weekly_pause_threshold_used_percent = 100;
    lane.reserve_burn_window_minutes = Number(lane.reserve_burn_window_minutes ?? 300);
    lane.nominal_burn_per_lane_hour = 0;
    return;
  }
  if (lane.provider === "local_container") {
    lane.provider = "hosted_codex";
    if (lane.reasoning_effort === "local") {
      lane.reasoning_effort = "medium";
    }
  }
}

function applyPolicyUpdate(body) {
  const currentConfigVersion = getConfigVersion();
  if (body.configVersion && body.configVersion !== currentConfigVersion) {
    const error = new Error("stale dashboard settings; refresh before saving policies");
    error.statusCode = 409;
    throw error;
  }

  const parsed = loadRawConfig(configPath);
  parsed.lifecycle = parsed.lifecycle ?? {};
  parsed.issue_source = parsed.issue_source ?? {};
  parsed.dispatcher = parsed.dispatcher ?? {};
  parsed.validation = parsed.validation ?? {};
  parsed.reviewer = parsed.reviewer ?? {};
  parsed.pr_manager = parsed.pr_manager ?? {};
  parsed.runner_manager = parsed.runner_manager ?? {};
  parsed.monitor = parsed.monitor ?? {};
  parsed.safety = parsed.safety ?? {};
  parsed.budgets = parsed.budgets ?? {};
  parsed.branches = parsed.branches ?? {};
  parsed.roles = parsed.roles ?? {};
  parsed.roles.enabled = parsed.roles.enabled ?? {};
  parsed.dashboard = parsed.dashboard ?? {};
  parsed.retention = parsed.retention ?? {};
  parsed.repo = parsed.repo ?? {};
  parsed.models = parsed.models ?? {};
  parsed.models.dispatcher = parsed.models.dispatcher ?? {};
  parsed.models.dispatcher.primary = parsed.models.dispatcher.primary ?? {};
  parsed.models.dispatcher.secondary = parsed.models.dispatcher.secondary ?? {};
  parsed.models.dispatcher.local = parsed.models.dispatcher.local ?? {};
  parsed.models.reviewer = parsed.models.reviewer ?? {};

  parsed.repo.key = String(body.repoKey ?? parsed.repo.key ?? "").trim();
  parsed.repo.github_slug = String(body.repoGithubSlug ?? parsed.repo.github_slug ?? "").trim();
  parsed.repo.default_branch = String(body.repoDefaultBranch ?? parsed.repo.default_branch ?? "").trim();
  parsed.repo.workspace_dir = String(body.repoWorkspaceDir ?? parsed.repo.workspace_dir ?? "").trim() || null;
  if (!parsed.repo.key || !parsed.repo.github_slug || !parsed.repo.default_branch) {
    const error = new Error("repo key, GitHub repo, and default branch are required");
    error.statusCode = 400;
    throw error;
  }

  parsed.lifecycle.enabled = Boolean(body.lifecycleEnabled);
  parsed.lifecycle.target_mode = String(body.lifecycleTargetMode ?? parsed.lifecycle.target_mode ?? "open");
  parsed.lifecycle.target_name = String(body.lifecycleTargetName ?? parsed.lifecycle.target_name ?? "");
  parsed.lifecycle.max_parallel_prs = asInt(body.lifecycleMaxParallelPrs, parsed.lifecycle.max_parallel_prs ?? 1, 1, 50);
  parsed.lifecycle.max_runs_per_day = asInt(body.lifecycleMaxRunsPerDay, parsed.lifecycle.max_runs_per_day ?? 1, 1, 500);
  parsed.lifecycle.pause_when_target_complete = Boolean(body.lifecyclePauseWhenTargetComplete);
  parsed.lifecycle.pause_when_budget_exhausted = Boolean(body.lifecyclePauseWhenBudgetExhausted);

  parsed.issue_source.labels = splitLineList(body.issueSourceLabels);
  parsed.issue_source.required_issue_prefix =
    String(body.issueSourceRequiredIssuePrefix ?? parsed.issue_source.required_issue_prefix ?? "").trim() || null;
  parsed.issue_source.allow_manual_issue_numbers = splitIntegerList(body.issueSourceAllowManualIssueNumbers);

  parsed.dispatcher.enabled = Boolean(body.dispatcherEnabled);
  parsed.dispatcher.poll_interval_seconds = asInt(
    body.dispatcherPollIntervalSeconds,
    parsed.dispatcher.poll_interval_seconds ?? 30,
    5,
    600
  );

  const primaryTarget = asInt(body.primaryTargetConcurrency, 1, 0, 24);
  const secondaryTarget = asInt(body.secondaryTargetConcurrency, 0, 0, 24);
  const localTarget = asInt(body.localTargetConcurrency, 0, 0, 24);

  parsed.dispatcher.primary_max_workers = primaryTarget;
  parsed.dispatcher.secondary_max_workers = secondaryTarget;
  parsed.dispatcher.local_max_workers = localTarget;
  parsed.dispatcher.skip_issue_numbers = splitIntegerList(body.dispatcherSkipIssueNumbers);
  delete parsed.dispatcher.max_concurrency;
  delete parsed.dispatcher.secondary_lane_fraction;

  parsed.models.dispatcher.primary.name = String(
    body.primaryModel ?? parsed.models.dispatcher.primary.name ?? "gpt-5.3-codex-spark"
  );
  parsed.models.dispatcher.primary.reasoning_effort = String(
    body.primaryReasoningEffort ?? parsed.models.dispatcher.primary.reasoning_effort ?? "high"
  );
  parsed.models.dispatcher.primary.pause_threshold_used_percent = 100 - asInt(
    body.primaryPauseBelowRemainingPercent,
    10,
    0,
    100
  );
  parsed.models.dispatcher.primary.weekly_pause_threshold_used_percent = 100 - asInt(
    body.primaryWeeklyPauseBelowRemainingPercent,
    10,
    0,
    100
  );
  parsed.models.dispatcher.primary.reserve_burn_window_minutes = asInt(
    body.primaryReserveWindowHours,
    5,
    1,
    48
  ) * 60;
  parsed.models.dispatcher.primary.nominal_burn_per_lane_hour = asNumber(
    body.primaryNominalBurnPerLaneHour,
    3,
    0.5,
    20
  );
  applyModelSelectedProvider(parsed.models.dispatcher.primary);

  parsed.models.dispatcher.secondary.name = String(
    body.secondaryModel ?? parsed.models.dispatcher.secondary.name ?? "gpt-5.4"
  );
  parsed.models.dispatcher.secondary.reasoning_effort = String(
    body.secondaryReasoningEffort ?? parsed.models.dispatcher.secondary.reasoning_effort ?? "medium"
  );
  parsed.models.dispatcher.secondary.pause_threshold_used_percent = 100 - asInt(
    body.secondaryPauseBelowRemainingPercent,
    30,
    0,
    100
  );
  parsed.models.dispatcher.secondary.weekly_pause_threshold_used_percent = 100 - asInt(
    body.secondaryWeeklyPauseBelowRemainingPercent,
    30,
    0,
    100
  );
  parsed.models.dispatcher.secondary.reserve_burn_window_minutes = asInt(
    body.secondaryReserveWindowHours,
    5,
    1,
    48
  ) * 60;
  parsed.models.dispatcher.secondary.nominal_burn_per_lane_hour = asNumber(
    body.secondaryNominalBurnPerLaneHour,
    3,
    0.5,
    20
  );
  applyModelSelectedProvider(parsed.models.dispatcher.secondary);

  parsed.models.dispatcher.local.key = "local";
  parsed.models.dispatcher.local.label = "Local lane";
  parsed.models.dispatcher.local.provider = "local_container";
  parsed.models.dispatcher.local.enabled = Boolean(body.localEnabled);
  parsed.models.dispatcher.local.max_workers = localTarget;
  parsed.models.dispatcher.local.name = String(
    body.localModel ?? parsed.models.dispatcher.local.name ?? "qwen2.5-coder:7b"
  );
  parsed.models.dispatcher.local.reasoning_effort = String(
    body.localReasoningEffort ?? parsed.models.dispatcher.local.reasoning_effort ?? "local"
  );
  parsed.models.dispatcher.local.pause_threshold_used_percent = 100;
  parsed.models.dispatcher.local.weekly_pause_threshold_used_percent = 100;
  parsed.models.dispatcher.local.reserve_burn_window_minutes = 300;
  parsed.models.dispatcher.local.nominal_burn_per_lane_hour = asNumber(
    body.localNominalBurnPerLaneHour,
    parsed.models.dispatcher.local.nominal_burn_per_lane_hour ?? 0,
    0,
    20
  );
  parsed.models.dispatcher.local.runtime_service =
    String(body.localRuntimeService ?? parsed.models.dispatcher.local.runtime_service ?? "local-model").trim() || "local-model";
  parsed.models.dispatcher.local.runtime_endpoint =
    String(body.localRuntimeEndpoint ?? parsed.models.dispatcher.local.runtime_endpoint ?? "http://local-model:11434/v1").trim();
  parsed.models.dispatcher.local.runtime_health_url =
    String(body.localRuntimeHealthUrl ?? parsed.models.dispatcher.local.runtime_health_url ?? "http://local-model:11434/api/tags").trim();
  parsed.models.dispatcher.local.runtime_image =
    String(body.localRuntimeImage ?? parsed.models.dispatcher.local.runtime_image ?? "ollama/ollama:latest").trim();
  parsed.models.dispatcher.local.runtime_command =
    String(body.localRuntimeCommand ?? parsed.models.dispatcher.local.runtime_command ?? "").trim();
  parsed.models.dispatcher.local.local_provider =
    String(body.localProvider ?? parsed.models.dispatcher.local.local_provider ?? "ollama").trim() || "ollama";
  parsed.models.dispatcher.local.auto_pull = Boolean(body.localAutoPull);
  if (Array.isArray(body.dispatcherLanes)) {
    const currentByKey = new Map((parsed.models.dispatcher.lanes ?? []).map((lane) => [lane.key, lane]));
    const laneUpdates = body.dispatcherLanes
      .map((entry) => normalizeLaneUpdateEntry(entry, currentByKey.get(String(entry?.key ?? "").trim())))
      .filter((lane) => lane.key);
    for (const lane of laneUpdates) {
      applyModelSelectedProvider(lane);
    }
    const seen = new Set();
    for (const lane of laneUpdates) {
      if (seen.has(lane.key)) {
        const error = new Error(`duplicate lane key: ${lane.key}`);
        error.statusCode = 400;
        throw error;
      }
      seen.add(lane.key);
    }
    parsed.models.dispatcher.lanes = laneUpdates;
    parsed.models.dispatcher.primary = laneUpdates.find((lane) => lane.key === "primary") ?? parsed.models.dispatcher.primary;
    parsed.models.dispatcher.secondary = laneUpdates.find((lane) => lane.key === "secondary") ?? parsed.models.dispatcher.secondary;
    parsed.models.dispatcher.local = laneUpdates.find((lane) => lane.key === "local") ?? parsed.models.dispatcher.local;
  } else {
    parsed.models.dispatcher.lanes = [
      {
        key: "primary",
        label: "Primary lane",
        provider: "hosted_codex",
        enabled: true,
        max_workers: primaryTarget,
        ...parsed.models.dispatcher.primary
      },
      {
        key: "secondary",
        label: "Secondary lane",
        provider: "hosted_codex",
        enabled: true,
        max_workers: secondaryTarget,
        ...parsed.models.dispatcher.secondary
      },
      parsed.models.dispatcher.local
    ];
  }

  parsed.models.reviewer.name = String(body.reviewerModel ?? parsed.models.reviewer.name ?? "gpt-5.4");
  parsed.models.reviewer.reasoning_effort = String(
    body.reviewerReasoningEffort ?? parsed.models.reviewer.reasoning_effort ?? "medium"
  );
  parsed.reviewer.enabled = Boolean(body.reviewerEnabled);
  parsed.reviewer.poll_interval_seconds = asInt(
    body.reviewerPollIntervalSeconds,
    parsed.reviewer.poll_interval_seconds ?? 120,
    5,
    600
  );
  parsed.reviewer.max_concurrent = asInt(
    body.reviewerMaxConcurrent,
    parsed.reviewer.max_concurrent ?? 1,
    1,
    24
  );
  parsed.reviewer.post_mode = String(body.reviewerPostMode ?? parsed.reviewer.post_mode ?? "comment");
  parsed.reviewer.instructions_path =
    String(body.reviewerInstructionsPath ?? parsed.reviewer.instructions_path ?? "").trim() || null;

  parsed.validation.enabled = Boolean(body.validationEnabled);
  parsed.validation.context = String(body.validationContext ?? parsed.validation.context ?? "validate");
  parsed.validation.poll_interval_seconds = asInt(
    body.validationPollIntervalSeconds,
    parsed.validation.poll_interval_seconds ?? 30,
    5,
    600
  );
  parsed.validation.max_concurrent = asInt(
    body.validationMaxConcurrent,
    parsed.validation.max_concurrent ?? 1,
    1,
    24
  );
  parsed.validation.post_status = Boolean(body.validationPostStatus);
  parsed.validation.working_directory =
    String(body.validationWorkingDirectory ?? parsed.validation.working_directory ?? "").trim() || null;
  parsed.validation.bootstrap_commands = splitCommandList(body.validationBootstrapCommands);
  const validationCommands = splitCommandList(body.validationCommands);
  if (validationCommands.length === 0) {
    const error = new Error("validation commands cannot be empty");
    error.statusCode = 400;
    throw error;
  }
  parsed.validation.commands = validationCommands;

  parsed.pr_manager.enabled = Boolean(body.prManagerEnabled);
  parsed.pr_manager.interval_seconds = asInt(
    body.prManagerIntervalSeconds,
    parsed.pr_manager.interval_seconds ?? 30,
    5,
    600
  );
  parsed.pr_manager.merge_concurrency = asInt(
    body.prManagerMergeConcurrency,
    parsed.pr_manager.merge_concurrency ?? 1,
    1,
    24
  );
  parsed.pr_manager.update_branch_concurrency = asInt(
    body.prManagerUpdateBranchConcurrency,
    parsed.pr_manager.update_branch_concurrency ?? parsed.pr_manager.merge_concurrency ?? 1,
    1,
    24
  );
  parsed.pr_manager.auto_merge_label = String(body.prManagerAutoMergeLabel ?? parsed.pr_manager.auto_merge_label ?? "").trim() || null;

  parsed.runner_manager.enabled = Boolean(body.runnerManagerEnabled);
  parsed.runner_manager.scope = String(body.runnerManagerScope ?? parsed.runner_manager.scope ?? "repo");
  parsed.runner_manager.required_labels = splitLineList(body.runnerManagerRequiredLabels);
  parsed.runner_manager.runner_labels = splitLineList(body.runnerManagerRunnerLabels);
  parsed.runner_manager.runner_group =
    String(body.runnerManagerRunnerGroup ?? parsed.runner_manager.runner_group ?? "").trim();
  parsed.runner_manager.image_name =
    String(body.runnerManagerImageName ?? parsed.runner_manager.image_name ?? "").trim() || "commons-devloop/gh-runner:latest";
  parsed.runner_manager.container_prefix =
    String(body.runnerManagerContainerPrefix ?? parsed.runner_manager.container_prefix ?? "").trim() || null;
  parsed.runner_manager.max_runners = asInt(
    body.runnerManagerMaxRunners,
    parsed.runner_manager.max_runners ?? 2,
    1,
    50
  );
  parsed.runner_manager.poll_interval_seconds = asInt(
    body.runnerManagerPollIntervalSeconds,
    parsed.runner_manager.poll_interval_seconds ?? 20,
    5,
    600
  );
  parsed.runner_manager.launch_cooldown_seconds = asInt(
    body.runnerManagerLaunchCooldownSeconds,
    parsed.runner_manager.launch_cooldown_seconds ?? 180,
    10,
    3600
  );
  parsed.runner_manager.network =
    String(body.runnerManagerNetwork ?? parsed.runner_manager.network ?? "").trim();
  parsed.runner_manager.dry_run = Boolean(body.runnerManagerDryRun);
  parsed.runner_manager.mount_docker_socket = Boolean(body.runnerManagerMountDockerSocket);
  parsed.runner_manager.mount_workspace = Boolean(body.runnerManagerMountWorkspace);

  parsed.monitor.enabled = Boolean(body.monitorEnabled);
  parsed.monitor.poll_interval_seconds = asInt(
    body.monitorPollIntervalSeconds,
    parsed.monitor.poll_interval_seconds ?? 30,
    5,
    600
  );

  parsed.safety.pr_only = Boolean(body.safetyPrOnly);
  parsed.safety.auto_merge = Boolean(body.safetyAutoMerge);
  parsed.safety.protected_branches = splitLineList(body.safetyProtectedBranches);
  parsed.safety.protected_paths = splitLineList(body.safetyProtectedPaths);
  parsed.safety.allow_force_push = Boolean(body.safetyAllowForcePush);
  parsed.safety.require_clean_worktree_before_run = Boolean(body.safetyRequireCleanWorktreeBeforeRun);

  const maxEstimatedCreditsText = String(body.budgetMaxEstimatedCreditsPerDay ?? "").trim();
  parsed.budgets.max_estimated_credits_per_day =
    maxEstimatedCreditsText === ""
      ? null
      : asNumber(maxEstimatedCreditsText, parsed.budgets.max_estimated_credits_per_day ?? 0, 0);
  parsed.budgets.pause_reason_on_budget =
    String(body.budgetPauseReasonOnBudget ?? parsed.budgets.pause_reason_on_budget ?? "").trim() || "budget exhausted";

  parsed.branches.work_branch_prefix =
    String(body.branchesWorkBranchPrefix ?? parsed.branches.work_branch_prefix ?? "autonomous/").trim() || "autonomous/";
  parsed.branches.pr_base_branch =
    String(body.branchesPrBaseBranch ?? parsed.branches.pr_base_branch ?? "main").trim() || "main";

  parsed.roles.enabled.autonomous = Boolean(body.roleAutonomousEnabled);
  parsed.roles.enabled.dispatcher = Boolean(body.roleDispatcherEnabled);
  parsed.roles.enabled.validator = Boolean(body.roleValidatorEnabled);
  parsed.roles.enabled.reviewer = Boolean(body.roleReviewerEnabled);
  parsed.roles.enabled["runner-manager"] = Boolean(body.roleRunnerManagerEnabled);
  parsed.roles.enabled["pr-manager"] = Boolean(body.rolePrManagerEnabled);
  parsed.roles.enabled.monitor = Boolean(body.roleMonitorEnabled);
  parsed.roles.enabled.dashboard = Boolean(body.roleDashboardEnabled);

  parsed.dashboard.enabled = Boolean(body.dashboardEnabled);
  parsed.dashboard.port = asInt(
    body.dashboardPort,
    parsed.dashboard.port ?? 4700,
    1,
    65535
  );
  parsed.dashboard.expose_issue_details = Boolean(body.dashboardExposeIssueDetails);
  parsed.dashboard.expose_pr_links = Boolean(body.dashboardExposePrLinks);

  parsed.retention.enabled = Boolean(body.retentionEnabled);
  parsed.retention.worktree_max_age_hours = asInt(
    body.retentionWorktreeMaxAgeHours,
    parsed.retention.worktree_max_age_hours ?? 6,
    0,
    168
  );
  parsed.retention.run_log_max_age_days = asInt(
    body.retentionRunLogMaxAgeDays,
    parsed.retention.run_log_max_age_days ?? 2,
    0,
    30
  );
  parsed.retention.output_max_age_days = asInt(
    body.retentionOutputMaxAgeDays,
    parsed.retention.output_max_age_days ?? 2,
    0,
    30
  );

  saveRawConfig(configPath, parsed);
  const config = getConfig();
  return {
    config,
    configVersion: getConfigVersion(),
    policyControl: buildPolicyControl(config),
    laneControl: buildLaneControl(config),
    message: "policies updated"
  };
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store, max-age=0, must-revalidate"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function html(res, htmlContent) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, max-age=0, must-revalidate"
  });
  res.end(htmlContent);
}

function isValidDashboardToken(expected, provided) {
  if (!provided) return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function runDocker(args, timeout = 2000) {
  return execFileSync("docker", args, {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout
  }).trim();
}

function serviceContainerName(service) {
  const project = process.env.COMPOSE_PROJECT_NAME || "commons-devloop";
  return `${project}-${service}-1`;
}

function applyDockerServiceState(service, enabled) {
  if (enabled) {
    runDocker(["start", serviceContainerName(service)]);
    return;
  }

  runDocker(["stop", serviceContainerName(service)]);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (pathname === "/health") {
      json(res, 200, { ok: true });
      return;
    }

    // The app shell itself carries no secrets — it's the React bundle, not
    // data. It has to be servable pre-auth so the browser can load the page
    // that then prompts for a token and drives every subsequent /api/* call.
    if ((pathname === "/" || pathname === "/index.html") && req.method === "GET") {
      html(res, readHtml());
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/assets/") && serveStaticAsset(pathname, res)) {
      return;
    }

    const dashboardToken = process.env.AE_DASHBOARD_TOKEN;
    if (dashboardToken) {
      const [scheme, token] = (req.headers.authorization ?? "").split(" ");
      if (scheme !== "Bearer" || !isValidDashboardToken(dashboardToken, token)) {
        json(res, 401, { error: "a valid bearer token is required" });
        return;
      }
    }

    if (pathname === "/api/lanes/keys" && req.method === "GET") {
      const config = getConfig();
      json(res, 200, { lanes: laneApiKeyStatus(stateDir, config.repo.key, getDispatcherLanes(config)) });
      return;
    }

    const laneKeyMatch = /^\/api\/lanes\/([^/]+)\/key$/.exec(pathname);
    if (laneKeyMatch && req.method === "POST") {
      const [, laneKey] = laneKeyMatch;
      const config = getConfig();
      const lane = getDispatcherLanes(config).find((entry) => entry.key === laneKey);
      if (!lane) {
        json(res, 404, { error: "unknown lane" });
        return;
      }
      const body = await parseBody(req);
      setLaneApiKey(stateDir, config.repo.key, laneKey, body?.apiKey ?? "");
      json(res, 200, { ok: true, lane: laneApiKeyStatus(stateDir, config.repo.key, [lane])[laneKey] });
      return;
    }

    if (pathname === "/status" || pathname === "/api/state") {
      json(res, 200, await collectState());
      return;
    }

    if (pathname === "/api/config") {
      json(res, 200, getConfig());
      return;
    }

    if (req.method === "POST" && (pathname === "/api/settings/policies" || pathname === "/api/settings/lane-policy")) {
      const result = applyPolicyUpdate(await parseBody(req));
      json(res, 200, {
        ok: true,
        message: result.message,
        configVersion: result.configVersion,
        laneControl: result.laneControl,
        policyControl: result.policyControl
      });
      return;
    }

    const config = getConfig();

    if (req.method === "POST" && pathname === "/api/dispatcher/pause") {
      setRepoPause(true, "manual pause from dashboard", config);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/dispatcher/resume") {
      setRepoPause(false, null, config);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/dispatcher/start") {
      setServiceDesiredState("dispatcher", true, config);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/dispatcher/stop") {
      setServiceDesiredState("dispatcher", false, config);
      json(res, 200, { ok: true });
      return;
    }

    const requeueMatch = /^\/api\/requeue\/(.+)\/(pending|clear)$/.exec(pathname);
    if (req.method === "POST" && requeueMatch) {
      const [, service, action] = requeueMatch;
      const body = await parseBody(req);
      const prNumber = parsePositiveInteger(body?.prNumber);
      if (!prNumber) {
        const error = new Error("invalid or missing prNumber");
        error.statusCode = 400;
        throw error;
      }

      requeueReviewServiceRecord(stateDir, config.repo.key, service, action, prNumber);
      json(res, 200, {
        ok: true,
        service,
        prNumber,
        action
      });
      return;
    }

    const serviceMatch = /^\/api\/service\/(.+)\/(start|stop|reset)$/.exec(pathname);
    if (req.method === "POST" && serviceMatch) {
      const [, service, action] = serviceMatch;
      if (!SERVICES.includes(service)) {
        json(res, 404, { error: "unknown service" });
        return;
      }
      if (action === "reset") {
        resetServiceRuntime(service, config);
      } else {
        setServiceDesiredState(service, action === "start", config);
      }
      json(res, 200, { ok: true, service, action });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (error) {
    log("error", "dashboard request failed", { error: error.message, url: req.url });
    json(res, error.statusCode ?? 500, { error: error.message });
  }
});

if (process.env.AE_DASHBOARD_NO_LISTEN !== "1") {
  const port = Number.parseInt(process.env.AE_DASHBOARD_PORT ?? String(getConfig().dashboard.port), 10);
  server.listen(port, () => {
    const config = getConfig();
    log("info", "dashboard listening", { port, repoKey: config.repo.key });
  });
}
