import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LEGACY_REPO_STATE_SUFFIX = ".json";
const STACKS_DIRNAME = "stacks";
const MAX_STACK_ID_LENGTH = 48;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function trimTrailingHyphens(value) {
  return value.replace(/-+$/g, "");
}

function sanitizeStackId(value, fallback = "default") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/g, "");
  const sanitized = trimTrailingHyphens(normalized);
  const candidate = sanitized || fallback;
  if (candidate.length <= MAX_STACK_ID_LENGTH) {
    return candidate;
  }
  const hash = crypto.createHash("sha1").update(candidate).digest("hex").slice(0, 8);
  const prefix = trimTrailingHyphens(candidate.slice(0, MAX_STACK_ID_LENGTH - hash.length - 1));
  return `${prefix || fallback}-${hash}`;
}

function resolveConfigStem(env = process.env) {
  const configPath = env.AE_REPO_CONFIG;
  if (!configPath) {
    return null;
  }
  const parsed = path.parse(configPath);
  return parsed.name || null;
}

function resolveGitBranch(cwd = process.cwd()) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export function resolveStackIdentity(stateDir, repoKey, cwd = process.cwd(), env = process.env) {
  const explicitStackId = env.AE_STACK_ID?.trim();
  const gitBranch = resolveGitBranch(cwd);
  const configStem = resolveConfigStem(env);
  const source =
    explicitStackId != null && explicitStackId !== ""
      ? "env"
      : gitBranch
        ? "git-branch"
        : configStem
          ? "repo-config"
          : "repo-key";
  const rawValue =
    explicitStackId != null && explicitStackId !== ""
      ? explicitStackId
      : gitBranch ?? configStem ?? repoKey;
  const stackId = sanitizeStackId(rawValue, sanitizeStackId(repoKey, "default"));
  return {
    repoKey,
    source,
    rawValue,
    stackId,
    stateRoot: path.join(stateDir, STACKS_DIRNAME, stackId)
  };
}

function scopedStateDir(stateDir, repoKey) {
  return resolveStackIdentity(stateDir, repoKey).stateRoot;
}

function repoRootDir(baseStateDir, repoKey) {
  return path.join(baseStateDir, "repos", repoKey);
}

function legacyRepoStatePath(baseStateDir, repoKey) {
  return path.join(baseStateDir, "repos", `${repoKey}${LEGACY_REPO_STATE_SUFFIX}`);
}

function repoMetaDir(baseStateDir, repoKey) {
  return path.join(repoRootDir(baseStateDir, repoKey), "meta");
}

function repoLogsDir(baseStateDir, repoKey) {
  return path.join(repoRootDir(baseStateDir, repoKey), "logs");
}

function repoWorktreesDir(baseStateDir, repoKey) {
  return path.join(repoRootDir(baseStateDir, repoKey), "worktrees");
}

function repoOutputsDir(baseStateDir, repoKey) {
  return path.join(repoRootDir(baseStateDir, repoKey), "outputs");
}

function repoRunLogsDir(baseStateDir, repoKey) {
  return path.join(repoRootDir(baseStateDir, repoKey), "run-logs");
}

function repoStatePath(baseStateDir, repoKey) {
  return path.join(repoRootDir(baseStateDir, repoKey), "repo-state.json");
}

function repoControlPath(baseStateDir, repoKey) {
  return path.join(repoMetaDir(baseStateDir, repoKey), "control.json");
}

function serviceStatePath(baseStateDir, repoKey, serviceName) {
  return path.join(repoMetaDir(baseStateDir, repoKey), `${serviceName}.json`);
}

function serviceConfigPath(baseStateDir, repoKey, serviceName) {
  return path.join(repoMetaDir(baseStateDir, repoKey), `${serviceName}-config.json`);
}

function serviceLogPath(baseStateDir, repoKey, serviceName) {
  return path.join(repoLogsDir(baseStateDir, repoKey), `${serviceName}.log`);
}

function ensureScopedStateDir(stateDir, repoKey) {
  const scopedDir = scopedStateDir(stateDir, repoKey);
  ensureDir(path.join(scopedDir, "repos"));
  return scopedDir;
}

function readFirstExistingJson(filePaths, fallback) {
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
      return readJson(filePath, fallback);
    }
  }
  return fallback;
}

function migrateJson(primaryPath, filePaths, fallback) {
  const migrated = readFirstExistingJson(filePaths, fallback);
  if (migrated !== fallback) {
    writeJson(primaryPath, migrated);
  }
  return migrated;
}

function migrateTextFile(primaryPath, filePaths) {
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
      ensureDir(path.dirname(primaryPath));
      fs.copyFileSync(filePath, primaryPath);
      return;
    }
  }
}

export function ensureRepoDirs(stateDir, repoKey) {
  const scopedDir = ensureScopedStateDir(stateDir, repoKey);
  ensureDir(repoRootDir(scopedDir, repoKey));
  ensureDir(repoMetaDir(scopedDir, repoKey));
  ensureDir(repoLogsDir(scopedDir, repoKey));
  ensureDir(repoWorktreesDir(scopedDir, repoKey));
  ensureDir(repoOutputsDir(scopedDir, repoKey));
  ensureDir(repoRunLogsDir(scopedDir, repoKey));
}

export function getRepoPaths(stateDir, repoKey) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  return {
    stateRoot: scopedDir,
    root: repoRootDir(scopedDir, repoKey),
    meta: repoMetaDir(scopedDir, repoKey),
    logs: repoLogsDir(scopedDir, repoKey),
    worktrees: repoWorktreesDir(scopedDir, repoKey),
    outputs: repoOutputsDir(scopedDir, repoKey),
    runLogs: repoRunLogsDir(scopedDir, repoKey),
    repoState: repoStatePath(scopedDir, repoKey),
    control: repoControlPath(scopedDir, repoKey)
  };
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeServicePrRecord(record) {
  if (!record || typeof record !== "object") {
    return record;
  }

  return {
    ...record,
    failure_count: Number.isFinite(Number(record.failure_count)) ? Number(record.failure_count) : 0,
    failure_summary: record.failure_summary == null ? null : String(record.failure_summary),
    last_attempt_at: record.last_attempt_at ?? null,
    next_retry_at: record.next_retry_at ?? null,
    remediation_status: record.remediation_status == null ? "none" : String(record.remediation_status)
  };
}

function normalizeRemediationRecord(record) {
  if (!record || typeof record !== "object") {
    return record;
  }

  return {
    ...record,
    service: String(record.service ?? "").trim(),
    prNumber: Number.isInteger(Number(record.prNumber)) ? Number(record.prNumber) : null,
    sha: String(record.sha ?? "").trim(),
    branch: record.branch == null ? null : String(record.branch).trim() || null,
    headRepository: record.headRepository == null ? null : String(record.headRepository).trim() || null,
    headRepositoryOwner: record.headRepositoryOwner == null ? null : String(record.headRepositoryOwner).trim() || null,
    failureSummary: record.failureSummary == null ? null : String(record.failureSummary),
    runLog: record.runLog == null ? null : String(record.runLog),
    status: String(record.status ?? "open"),
    attempts: Number.isFinite(Number(record.attempts)) && Number(record.attempts) > 0
      ? Number(record.attempts)
      : 1,
    isCrossRepository: Boolean(record.isCrossRepository),
    maintainerCanModify: record.maintainerCanModify == null ? null : Boolean(record.maintainerCanModify),
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null
  };
}

function normalizeServiceState(state) {
  if (!state || typeof state !== "object") {
    return state;
  }

  const prs = state.prs;
  if (!prs || typeof prs !== "object" || Array.isArray(prs)) {
    return state;
  }

  return {
    ...state,
    prs: Object.fromEntries(
      Object.entries(prs).map(([prNumber, record]) => [prNumber, normalizeServicePrRecord(record)])
    )
  };
}

function normalizeRepoState(repoState, fallback) {
  const nextState = {
    ...fallback,
    ...repoState
  };
  nextState.remediationRecords = Array.isArray(nextState.remediationRecords)
    ? nextState.remediationRecords.map((record) => normalizeRemediationRecord(record)).filter(Boolean)
    : [];
  nextState.services = nextState.services && typeof nextState.services === "object"
    ? nextState.services
    : {};
  return nextState;
}

export function loadRepoState(stateDir, repoKey) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  const primaryPath = repoStatePath(scopedDir, repoKey);
  const unscopedRepoState = repoStatePath(stateDir, repoKey);
  const legacyPath = legacyRepoStatePath(stateDir, repoKey);
  const fallback = {
    repoKey,
    status: "ready",
    pauseReason: null,
    lastRoleRunAt: null,
    lastTargetCheckAt: null,
    targetComplete: false,
    runsToday: 0,
    services: {},
    remediationRecords: [],
    lastUpdatedAt: null
  };

  if (fs.existsSync(primaryPath)) {
    return normalizeRepoState(readJson(primaryPath, fallback), fallback);
  }

  if (fs.existsSync(unscopedRepoState) || fs.existsSync(legacyPath)) {
    const migrated = normalizeRepoState(
      readFirstExistingJson([unscopedRepoState, legacyPath], fallback),
      fallback
    );
    writeJson(primaryPath, migrated);
    return migrated;
  }

  return fallback;
}

export function saveRepoState(stateDir, repoKey, nextState) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  const primaryPath = repoStatePath(scopedDir, repoKey);
  const existing = fs.existsSync(primaryPath)
    ? normalizeRepoState(readJson(primaryPath, {}), {
        repoKey,
        status: "ready",
        pauseReason: null,
        lastRoleRunAt: null,
        lastTargetCheckAt: null,
        targetComplete: false,
        runsToday: 0,
        services: {},
        remediationRecords: [],
        lastUpdatedAt: null
      })
    : null;
  const normalized = normalizeRepoState(nextState, {
    repoKey,
    status: "ready",
    pauseReason: null,
    lastRoleRunAt: null,
    lastTargetCheckAt: null,
    targetComplete: false,
    runsToday: 0,
    services: {},
    remediationRecords: [],
    lastUpdatedAt: null
  });

  const preservingTargetCompletion =
    existing?.targetComplete === true &&
    String(existing?.status ?? "").startsWith("paused") &&
    normalized.targetComplete !== true &&
    normalized.status === "running";

  const merged = {
    ...(existing ?? {}),
    ...normalized,
    services: {
      ...(existing?.services ?? {}),
      ...(normalized.services ?? {})
    },
    remediationRecords: Array.isArray(normalized.remediationRecords)
      ? normalized.remediationRecords
      : (existing?.remediationRecords ?? [])
  };

  if (preservingTargetCompletion) {
    merged.status = existing.status;
    merged.pauseReason = existing.pauseReason;
    merged.targetComplete = existing.targetComplete;
    merged.lastTargetCheckAt = existing.lastTargetCheckAt ?? normalized.lastTargetCheckAt;
  }

  writeJson(primaryPath, {
    ...merged,
    lastUpdatedAt: new Date().toISOString()
  });
}

export function ensureRemediationRecords(repoState) {
  repoState.remediationRecords = Array.isArray(repoState?.remediationRecords)
    ? repoState.remediationRecords.map((record) => normalizeRemediationRecord(record)).filter(Boolean)
    : [];
  return repoState.remediationRecords;
}

export function recordRemediationFailure(repoState, recordInput) {
  const records = ensureRemediationRecords(repoState);
  const service = String(recordInput?.service ?? "").trim();
  const prNumber = Number(recordInput?.prNumber);
  const sha = String(recordInput?.sha ?? "").trim();
  const now = new Date().toISOString();

  if (!service) {
    throw new Error("recordRemediationFailure requires service");
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("recordRemediationFailure requires a positive prNumber");
  }
  if (!sha) {
    throw new Error("recordRemediationFailure requires sha");
  }

  const existing = records.find(
    (record) =>
      String(record?.service ?? "") === service &&
      Number(record?.prNumber) === prNumber &&
      String(record?.sha ?? "") === sha
  );

  if (existing) {
    existing.failureSummary = String(recordInput.failureSummary ?? existing.failureSummary ?? "").trim() || null;
    existing.runLog = String(recordInput.runLog ?? existing.runLog ?? "").trim() || null;
    existing.branch = String(recordInput.branch ?? existing.branch ?? "").trim() || null;
    existing.headRepository = String(recordInput.headRepository ?? existing.headRepository ?? "").trim() || null;
    existing.headRepositoryOwner = String(recordInput.headRepositoryOwner ?? existing.headRepositoryOwner ?? "").trim() || null;
    existing.status = String(recordInput.status ?? existing.status ?? "open");
    existing.attempts = Math.max(1, Number(existing.attempts ?? 0) + 1);
    existing.isCrossRepository = recordInput.isCrossRepository == null
      ? Boolean(existing.isCrossRepository)
      : Boolean(recordInput.isCrossRepository);
    existing.maintainerCanModify = recordInput.maintainerCanModify == null
      ? (existing.maintainerCanModify == null ? null : Boolean(existing.maintainerCanModify))
      : Boolean(recordInput.maintainerCanModify);
    existing.updatedAt = now;
    return existing;
  }

  const nextRecord = {
    service,
    prNumber,
    sha,
    branch: String(recordInput.branch ?? "").trim() || null,
    headRepository: String(recordInput.headRepository ?? "").trim() || null,
    headRepositoryOwner: String(recordInput.headRepositoryOwner ?? "").trim() || null,
    failureSummary: String(recordInput.failureSummary ?? "").trim() || null,
    runLog: String(recordInput.runLog ?? "").trim() || null,
    status: String(recordInput.status ?? "open"),
    attempts: Math.max(1, Number(recordInput.attempts ?? 1)),
    isCrossRepository: Boolean(recordInput.isCrossRepository),
    maintainerCanModify: recordInput.maintainerCanModify == null ? null : Boolean(recordInput.maintainerCanModify),
    createdAt: now,
    updatedAt: now
  };
  records.push(nextRecord);
  return nextRecord;
}

export function loadControlState(stateDir, repoKey) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  const primaryPath = repoControlPath(scopedDir, repoKey);
  const fallback = {
    manualPause: null,
    desiredServices: {}
  };
  if (fs.existsSync(primaryPath)) {
    return readJson(primaryPath, fallback);
  }
  return migrateJson(primaryPath, [repoControlPath(stateDir, repoKey)], fallback);
}

export function saveControlState(stateDir, repoKey, nextState) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  writeJson(repoControlPath(scopedDir, repoKey), nextState);
}

export function loadServiceState(stateDir, repoKey, serviceName) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  const primaryPath = serviceStatePath(scopedDir, repoKey, serviceName);
  const fallback = {
    service: serviceName,
    alive: false,
    enabled: true,
    updatedAt: null
  };
  if (fs.existsSync(primaryPath)) {
    return normalizeServiceState(readJson(primaryPath, fallback));
  }
  return normalizeServiceState(
    migrateJson(primaryPath, [serviceStatePath(stateDir, repoKey, serviceName)], fallback)
  );
}

export function saveServiceState(stateDir, repoKey, serviceName, nextState) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  writeJson(
    serviceStatePath(scopedDir, repoKey, serviceName),
    normalizeServiceState({
      ...nextState,
      service: serviceName,
      updatedAt: new Date().toISOString()
    })
  );
}

export function loadServiceConfig(stateDir, repoKey, serviceName, fallback = {}) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  const primaryPath = serviceConfigPath(scopedDir, repoKey, serviceName);
  if (fs.existsSync(primaryPath)) {
    return readJson(primaryPath, fallback);
  }
  return migrateJson(primaryPath, [serviceConfigPath(stateDir, repoKey, serviceName)], fallback);
}

export function saveServiceConfig(stateDir, repoKey, serviceName, config) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  writeJson(serviceConfigPath(scopedDir, repoKey, serviceName), config);
}

export function appendServiceLog(stateDir, repoKey, serviceName, message) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(serviceLogPath(scopedDir, repoKey, serviceName), `${line}\n`);
  return line;
}

function parseLogTimestamp(line) {
  const match = /^\[([0-9T:.\-+Z]+)\]/.exec(String(line));
  if (!match) {
    return null;
  }
  const timestamp = Date.parse(match[1]);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function readServiceLogTail(stateDir, repoKey, serviceName, count = 20, sinceIso = null) {
  ensureRepoDirs(stateDir, repoKey);
  const scopedDir = scopedStateDir(stateDir, repoKey);
  const filePath = serviceLogPath(scopedDir, repoKey, serviceName);
  if (!fs.existsSync(filePath)) {
    migrateTextFile(filePath, [serviceLogPath(stateDir, repoKey, serviceName)]);
  }
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean);

  if (!sinceIso) {
    return lines.slice(-count);
  }

  const since = Date.parse(String(sinceIso));
  if (!Number.isFinite(since)) {
    return lines.slice(-count);
  }

  const filtered = [];
  let keepContinuation = false;
  for (const line of lines) {
    const lineTimestamp = parseLogTimestamp(line);
    if (lineTimestamp != null) {
      keepContinuation = lineTimestamp >= since;
      if (keepContinuation) {
        filtered.push(line);
      }
      continue;
    }

    if (keepContinuation) {
      filtered.push(line);
    }
  }

  return filtered.slice(-count);
}

export function buildServicePaths(stateDir, repoKey, serviceName) {
  const repoPaths = getRepoPaths(stateDir, repoKey);
  const baseName = serviceName.replaceAll("/", "-");
  return {
    configPath: serviceConfigPath(repoPaths.stateRoot, repoKey, baseName),
    statePath: serviceStatePath(repoPaths.stateRoot, repoKey, baseName),
    logPath: serviceLogPath(repoPaths.stateRoot, repoKey, baseName),
    worktreeRoot: path.join(repoPaths.worktrees, baseName),
    runLogRoot: path.join(repoPaths.runLogs, baseName),
    outputRoot: path.join(repoPaths.outputs, baseName)
  };
}

export function normalizePullRequestRecord(pr) {
  if (!pr) {
    return null;
  }

  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid ?? null,
    headRepository: pr.headRepository?.name ?? pr.headRepository ?? null,
    headRepositoryOwner: pr.headRepositoryOwner?.login ?? pr.headRepositoryOwner ?? null,
    isCrossRepository: Boolean(pr.isCrossRepository),
    maintainerCanModify: pr.maintainerCanModify == null ? null : Boolean(pr.maintainerCanModify),
    baseRefName: pr.baseRefName ?? null,
    url: pr.url ?? null,
    isDraft: Boolean(pr.isDraft),
    mergeStateStatus: pr.mergeStateStatus ?? null,
    labels: Array.isArray(pr.labels) ? pr.labels : []
  };
}

export function loadPullRequestQueueState(stateDir, repoKey) {
  const prManagerState = loadServiceState(stateDir, repoKey, "pr-manager");
  const snapshot = prManagerState?.pullRequestQueue;
  const cachedPrs = Array.isArray(snapshot?.prs)
    ? snapshot.prs
    : Array.isArray(prManagerState?.openPrs)
      ? prManagerState.openPrs
      : [];
  const prs = cachedPrs
    .map((pr) => normalizePullRequestRecord(pr))
    .filter(Boolean)
    .sort((left, right) => Number(left.number) - Number(right.number));

  return {
    prs,
    source: snapshot?.source ?? (prs.length > 0 ? "pr-manager-cache" : "pr-manager-cache-empty"),
    updatedAt: snapshot?.updatedAt ?? prManagerState?.updatedAt ?? null,
    lastSyncAt: snapshot?.lastSyncAt ?? prManagerState?.lastSyncAt ?? null,
    lastSyncError: snapshot?.lastSyncError ?? prManagerState?.lastSyncError ?? null
  };
}

export function storePullRequestQueueState(serviceState, prs, metadata = {}) {
  const previous = serviceState?.pullRequestQueue ?? {};
  const hasMetadata = (key) => Object.prototype.hasOwnProperty.call(metadata, key);
  const normalizedPrs = prs
    .map((pr) => normalizePullRequestRecord(pr))
    .filter(Boolean)
    .sort((left, right) => Number(left.number) - Number(right.number));
  const snapshot = {
    prs: normalizedPrs,
    source: hasMetadata("source") ? metadata.source : previous.source ?? "pr-manager-cache",
    updatedAt: new Date().toISOString(),
    lastSyncAt: hasMetadata("lastSyncAt") ? metadata.lastSyncAt : previous.lastSyncAt ?? null,
    lastSyncError: hasMetadata("lastSyncError") ? metadata.lastSyncError : previous.lastSyncError ?? null
  };

  serviceState.pullRequestQueue = snapshot;
  serviceState.openPrs = normalizedPrs;
  serviceState.queueSource = snapshot.source;
  serviceState.lastSyncAt = snapshot.lastSyncAt;
  serviceState.lastSyncError = snapshot.lastSyncError;
  return snapshot;
}

export function syncDerivedServiceConfigs(stateDir, config) {
  const repoKey = config.repo.key;
  const validatorPaths = buildServicePaths(stateDir, repoKey, "validator");
  const reviewerPaths = buildServicePaths(stateDir, repoKey, "reviewer");
  const dispatcherPaths = buildServicePaths(stateDir, repoKey, "dispatcher");
  const runnerManagerPaths = buildServicePaths(stateDir, repoKey, "runner-manager");
  const prManagerPaths = buildServicePaths(stateDir, repoKey, "pr-manager");
  const monitorPaths = buildServicePaths(stateDir, repoKey, "monitor");

  saveServiceConfig(stateDir, repoKey, "dispatcher", {
    pollIntervalSeconds: config.dispatcher.poll_interval_seconds,
    maxConcurrency: config.dispatcher.max_concurrency,
    activeLaneCount: config.dispatcher.active_lane_count,
    primaryMaxWorkers: config.dispatcher.primary_max_workers,
    secondaryMaxWorkers: config.dispatcher.secondary_max_workers,
    localMaxWorkers: config.dispatcher.local_max_workers,
    skipIssueNumbers: config.dispatcher.skip_issue_numbers,
    primaryModel: config.models.dispatcher.primary,
    secondaryModel: config.models.dispatcher.secondary,
    localModel: config.models.dispatcher.local,
    lanes: config.models.dispatcher.lanes,
    statePath: dispatcherPaths.statePath,
    logPath: dispatcherPaths.logPath
  });

  saveServiceConfig(stateDir, repoKey, "validator", {
    owner: config.repo.github_slug.split("/")[0],
    repo: config.repo.github_slug.split("/")[1],
    baseBranch: config.branches.pr_base_branch,
    context: config.validation.context,
    pollIntervalSeconds: config.validation.poll_interval_seconds,
    maxConcurrent: config.validation.max_concurrent,
    bootstrapCommands: config.validation.bootstrap_commands,
    commands: config.validation.commands,
    worktreeRoot: validatorPaths.worktreeRoot,
    runLogRoot: validatorPaths.runLogRoot,
    postStatus: config.validation.post_status
  });

  saveServiceConfig(stateDir, repoKey, "reviewer", {
    owner: config.repo.github_slug.split("/")[0],
    repo: config.repo.github_slug.split("/")[1],
    baseBranch: config.branches.pr_base_branch,
    pollIntervalSeconds: config.reviewer.poll_interval_seconds,
    maxConcurrent: config.reviewer.max_concurrent,
    model: config.models.reviewer.name,
    reasoningEffort: config.models.reviewer.reasoning_effort,
    postMode: config.reviewer.post_mode,
    instructionsPath: config.reviewer.instructions_path,
    worktreeRoot: reviewerPaths.worktreeRoot,
    runLogRoot: reviewerPaths.runLogRoot,
    outputRoot: reviewerPaths.outputRoot
  });

  saveServiceConfig(stateDir, repoKey, "runner-manager", {
    owner: config.repo.github_slug.split("/")[0],
    repo: config.repo.github_slug.split("/")[1],
    scope: config.runner_manager.scope,
    requiredLabels: config.runner_manager.required_labels,
    runnerLabels: config.runner_manager.runner_labels,
    runnerGroup: config.runner_manager.runner_group,
    imageName: config.runner_manager.image_name,
    containerPrefix: config.runner_manager.container_prefix,
    maxRunners: config.runner_manager.max_runners,
    pollIntervalSeconds: config.runner_manager.poll_interval_seconds,
    launchCooldownSeconds: config.runner_manager.launch_cooldown_seconds,
    network: config.runner_manager.network,
    mountDockerSocket: config.runner_manager.mount_docker_socket,
    mountWorkspace: config.runner_manager.mount_workspace,
    dryRun: config.runner_manager.dry_run,
    workspaceRoot: runnerManagerPaths.worktreeRoot
  });

  saveServiceConfig(stateDir, repoKey, "pr-manager", {
    intervalSeconds: config.pr_manager.interval_seconds,
    mergeConcurrency: config.pr_manager.merge_concurrency,
    updateBranchConcurrency: config.pr_manager.update_branch_concurrency,
    autoMergeEnabled: config.safety.auto_merge,
    autoMergeLabel: config.pr_manager.auto_merge_label
  });

  saveServiceConfig(stateDir, repoKey, "monitor", {
    pollIntervalSeconds: config.monitor.poll_interval_seconds,
    exposeIssueDetails: config.dashboard.expose_issue_details,
    exposePrLinks: config.dashboard.expose_pr_links
  });
}
