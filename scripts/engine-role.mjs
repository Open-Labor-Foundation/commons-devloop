import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { resolveConfigPath, loadConfig, getDispatcherLanes } from "./lib/config.mjs";
import { resolveLaneApiKey } from "./lib/secrets.mjs";
import { ensureGithubAppAuth } from "./lib/github-app-auth.mjs";
import {
  appendServiceLog,
  buildServicePaths,
  ensureRemediationRecords,
  loadControlState,
  loadPullRequestQueueState,
  loadRepoState,
  recordRemediationFailure,
  loadServiceState,
  saveControlState,
  saveRepoState,
  saveServiceState,
  storePullRequestQueueState,
  syncDerivedServiceConfigs
} from "./lib/state.mjs";
import {
  checkGhAuth,
  closeIssue,
  closePullRequest,
  markBacklogIssueDone,
  mergePullRequest,
  getIssueDetails,
  getMergedPullRequests,
  listOpenIssuesForTarget,
  listOpenPullRequests,
  listQueuedWorkflowJobs,
  postCommitStatus,
  postPullRequestComment,
  postPullRequestReview,
  updatePullRequestBranch
} from "./lib/github.mjs";
import {
  evaluatePullRequestReadiness,
  normalizePullRequestRecord
} from "./lib/pr-readiness.mjs";
import { assertNoAutoTriggeredGithubActions } from "./lib/github-actions-guard.mjs";
import { selectPrManagerActions } from "./lib/pr-manager-plan.mjs";
import { summarizeOpenPullRequests } from "./lib/pull-request-stats.mjs";
import {
  cleanupServiceArtifacts,
  cleanupIsolatedCodexHome,
  commandExists,
  ensureCleanWorktree,
  prepareIsolatedCodexHome,
  prepareBranchWorktree,
  preparePullRequestWorktree,
  runCommand,
  runCommandToFile,
  safeSlug,
  syncCodexSessionHistory,
  writeJsonFile
} from "./lib/runtime.mjs";
import { log } from "./lib/logger.mjs";

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_LANE_RUNNER_PATH = path.join(ENGINE_DIR, "local-lane-runner.mjs");

const VALID_ROLES = new Set([
  "autonomous",
  "dispatcher",
  "validator",
  "reviewer",
  "runner-manager",
  "pr-manager",
  "monitor"
]);
const dispatcherWorkers = new Map();
const PROCESS_STARTED_AT = new Date().toISOString();
const SERVICE_FAILURE_BACKOFF_INITIAL_MS = 5 * 60 * 1000;
const SERVICE_FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const DISPATCHER_LAUNCH_LOCK_TTL_MS = 30 * 60 * 1000;

function parseArgs() {
  const roleIndex = process.argv.indexOf("--role");
  const role = roleIndex >= 0 ? process.argv[roleIndex + 1] : null;
  if (!role || !VALID_ROLES.has(role)) {
    throw new Error(`--role must be one of: ${Array.from(VALID_ROLES).join(", ")}`);
  }
  return { role };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveIntegerEnv(name) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function getLoopIntervalOverrideSeconds(role) {
  const specificEnvMap = {
    autonomous: "AE_AUTONOMOUS_LOOP_INTERVAL_SECONDS",
    dispatcher: "AE_DISPATCHER_LOOP_INTERVAL_SECONDS",
    validator: "AE_VALIDATOR_LOOP_INTERVAL_SECONDS",
    reviewer: "AE_REVIEWER_LOOP_INTERVAL_SECONDS",
    "runner-manager": "AE_RUNNER_MANAGER_LOOP_INTERVAL_SECONDS",
    "pr-manager": "AE_PR_MANAGER_LOOP_INTERVAL_SECONDS",
    monitor: "AE_MONITOR_LOOP_INTERVAL_SECONDS"
  };

  const specific = parsePositiveIntegerEnv(specificEnvMap[role] ?? "");
  if (specific != null) {
    return specific;
  }

  // Backward compatibility: treat the legacy global override as autonomous-only.
  if (role === "autonomous") {
    return parsePositiveIntegerEnv("AE_LOOP_INTERVAL_SECONDS");
  }

  return null;
}

function getPrFailureCountForAttempt(record, headSha) {
  if (!record || record.sha !== headSha || record.result !== "failure") {
    return 1;
  }
  return Math.max(0, Number(record.failure_count ?? 0)) + 1;
}

function computeServiceRetryDelayMs(failureCount) {
  const failures = Math.max(1, Number(failureCount ?? 1));
  return Math.min(
    SERVICE_FAILURE_BACKOFF_MAX_MS,
    SERVICE_FAILURE_BACKOFF_INITIAL_MS * (2 ** (failures - 1))
  );
}

function computeServiceNextRetryAt(lastAttemptAt, failureCount) {
  const baseTime = Date.parse(lastAttemptAt);
  if (!Number.isFinite(baseTime)) {
    return null;
  }
  return new Date(baseTime + computeServiceRetryDelayMs(failureCount)).toISOString();
}

function retryWindowStillActive(record, now = Date.now()) {
  if (!record || record.result !== "failure" || !record.next_retry_at) {
    return false;
  }
  const nextRetry = Date.parse(record.next_retry_at);
  return Number.isFinite(nextRetry) && nextRetry > now;
}

function formatRetryReason(prefix, record) {
  if (retryWindowStillActive(record)) {
    return `${prefix}; retry after ${record.next_retry_at}`;
  }
  return prefix;
}

function createServicePrRecord({
  existing,
  pr,
  result,
  runLog,
  outputPath = null,
  error = null,
  model = null,
  reasoningEffort = null,
  lastAttemptAt = new Date().toISOString()
}) {
  const failureCount = result === "failure"
    ? getPrFailureCountForAttempt(existing, pr.headRefOid)
    : 0;

  return {
    title: pr.title,
    sha: pr.headRefOid,
    result,
    updated_at: new Date().toISOString(),
    run_log: runLog,
    output_path: outputPath,
    branch: pr.headRefName,
    error,
    model,
    reasoning_effort: reasoningEffort,
    failure_count: failureCount,
    failure_summary: result === "failure" ? error : null,
    last_attempt_at: lastAttemptAt,
    next_retry_at: result === "failure"
      ? computeServiceNextRetryAt(lastAttemptAt, failureCount)
      : null,
    remediation_status: result === "failure" ? "retry_waiting" : "none"
  };
}

function getRoleIntervalSeconds(role, config) {
  switch (role) {
    case "autonomous":
      return config.monitor?.poll_interval_seconds ?? 30;
    case "dispatcher":
      return config.dispatcher?.poll_interval_seconds ?? 30;
    case "validator":
      return config.validation?.poll_interval_seconds ?? 30;
    case "reviewer":
      return config.reviewer?.poll_interval_seconds ?? 120;
    case "runner-manager":
      return config.runner_manager?.poll_interval_seconds ?? 20;
    case "pr-manager":
      return config.pr_manager?.interval_seconds ?? 30;
    case "monitor":
      return config.monitor?.poll_interval_seconds ?? 30;
    default:
      return 30;
  }
}

function computeActiveLoopIntervalSeconds(role, config, stateDir) {
  const configured = getRoleIntervalSeconds(role, config);

  if (role === "dispatcher") {
    const dispatcherState = loadServiceState(stateDir, config.repo.key, "dispatcher");
    const queued = Array.isArray(dispatcherState.items)
      ? dispatcherState.items.filter((item) => item.status === "queued").length
      : 0;
    const openPrs = loadPullRequestQueueState(stateDir, config.repo.key).prs.length;
    if (queued > 0 || openPrs > 0) {
      return Math.min(configured, 5);
    }
    return configured;
  }

  if (role === "validator" || role === "reviewer" || role === "pr-manager") {
    const openPrs = loadPullRequestQueueState(stateDir, config.repo.key).prs.length;
    if (openPrs > 0) {
      return Math.min(configured, 5);
    }
  }

  return configured;
}

function roleEnabled(config, controlState, role) {
  return config.roles.enabled[role] !== false && controlState.desiredServices?.[role] !== false;
}

function determineRepoPause(config, repoState, controlState) {
  if (!config.lifecycle.enabled || repoState.status === "disabled") {
    return { paused: true, status: "disabled", reason: repoState.pauseReason ?? "config disabled" };
  }

  if (controlState.manualPause) {
    return { paused: true, status: "paused_manual", reason: controlState.manualPause.reason };
  }

  if (String(repoState.status).startsWith("paused")) {
    return { paused: true, status: repoState.status, reason: repoState.pauseReason };
  }

  return { paused: false, status: repoState.status, reason: null };
}

function clearRecoveredFailureState(repoState) {
  if (repoState.status === "failed_attention_needed") {
    repoState.status = "running";
    repoState.pauseReason = null;
  }
}

function updateRepoStateService(repoState, role, serviceState) {
  const nextEntry = {
    alive: Boolean(serviceState.alive),
    enabled: serviceState.enabled,
    updatedAt: serviceState.updatedAt ?? new Date().toISOString(),
    summary: serviceState.summary ?? null,
    lifecycle: serviceState.lifecycle ?? (serviceState.enabled === false ? "disabled" : serviceState.alive ? "running" : "stopped"),
    configEnabled: serviceState.configEnabled ?? null,
    desiredEnabled: serviceState.desiredEnabled ?? serviceState.enabled ?? null,
    containerStatus: serviceState.containerStatus ?? null,
    lifecycleSource: serviceState.lifecycleSource ?? null
  };
  const currentEntry = repoState.services?.[role];
  repoState.services = {
    ...(repoState.services ?? {}),
    [role]: nextEntry
  };
  return JSON.stringify(currentEntry ?? null) !== JSON.stringify(nextEntry);
}

function persistRoleState(stateDir, repoKey, role, repoState, serviceState) {
  saveServiceState(stateDir, repoKey, role, serviceState);
  updateRepoStateService(repoState, role, serviceState);
  saveRepoState(stateDir, repoKey, repoState);
}

function summarizeFailure(error, fallbackMessage = "Unknown failure") {
  const details = [error?.message, error?.output]
    .map((value) => String(value ?? "").trim())
    .find(Boolean);
  if (!details) {
    return fallbackMessage;
  }
  const firstLine = details
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? fallbackMessage).slice(0, 280);
}

function maybeRunServiceGarbageCollection(config, stateDir, serviceName, servicePaths, options = {}) {
  if (config.retention?.enabled === false) {
    return;
  }

  const result = cleanupServiceArtifacts({
    worktreeRoot: servicePaths.worktreeRoot,
    runLogRoot: servicePaths.runLogRoot,
    outputRoot: options.includeOutputs ? servicePaths.outputRoot : null,
    keepWorktrees: options.keepWorktrees ?? [],
    worktreeMaxAgeHours: options.worktreeMaxAgeHours ?? config.retention?.worktree_max_age_hours ?? 6,
    runLogMaxAgeDays: config.retention?.run_log_max_age_days ?? 2,
    outputMaxAgeDays: options.includeOutputs ? (config.retention?.output_max_age_days ?? 2) : null
  });

  const removedWorktreeCount = result.removedWorktrees.length;
  const removedRunLogCount = result.removedRunLogs.length;
  const removedOutputCount = result.removedOutputs.length;
  if (removedWorktreeCount === 0 && removedRunLogCount === 0 && removedOutputCount === 0) {
    return;
  }

  appendServiceLog(
    stateDir,
    config.repo.key,
    serviceName,
    `garbage collection removed ${removedWorktreeCount} worktree(s), ${removedRunLogCount} run log(s), ${removedOutputCount} output file(s)`
  );
}

function cachedIssuesFromDispatcherState(dispatcherState) {
  const items = Array.isArray(dispatcherState?.items) ? dispatcherState.items : [];
  return items
    .map((item) => ({
      number: item.number,
      title: item.title,
      url: item.url ?? null,
      labels: [],
      milestone: null
    }))
    .sort((left, right) => Number(left.number) - Number(right.number));
}

function getIssueQueue(config, stateDir, serviceName) {
  try {
    return {
      issues: listOpenIssuesForTarget(config).sort((left, right) => Number(left.number) - Number(right.number)),
      source: "github",
      error: null
    };
  } catch (error) {
    const cached = cachedIssuesFromDispatcherState(loadServiceState(stateDir, config.repo.key, "dispatcher"));
    appendServiceLog(
      stateDir,
      config.repo.key,
      serviceName,
      `GitHub issue sync failed; using cached queue: ${error.message}`
    );
    return {
      issues: cached,
      source: cached.length > 0 ? "dispatcher-cache" : "empty-cache",
      error: error.message
    };
  }
}

function computeLanePlan(config, issueCount, openPrs, remediationCount = 0) {
  const lanes = getDispatcherLanes(config);
  const configuredTargets = Object.fromEntries(
    lanes.map((lane) => [
      lane.key,
      lane.enabled === false ? 0 : Math.max(0, Number(lane.max_workers ?? 0))
    ])
  );
  const targetConcurrency = Object.values(configuredTargets)
    .reduce((total, target) => total + target, 0);
  const openPrSummary = summarizeOpenPullRequests(openPrs);
  const remainingNewPrSlots = Math.max(
    0,
    Number(config.lifecycle.max_parallel_prs ?? 0) - openPrSummary.active
  );
  const issueSlots = Math.min(issueCount, remediationCount + remainingNewPrSlots);

  return {
    issueSlots,
    targetConcurrency,
    configuredTargets,
    primaryTarget: configuredTargets.primary ?? 0,
    secondaryTarget: configuredTargets.secondary ?? 0,
    openPrSummary
  };
}

function maybePauseForCompletion(config, repoState, issues, openPrCount = 0) {
  if (!config.lifecycle.pause_when_target_complete) {
    return false;
  }

  if (issues.length > 0 || openPrCount > 0) {
    return false;
  }

  if (config.lifecycle.target_mode === "milestone" || config.lifecycle.target_mode === "label") {
    repoState.status = "paused_milestone";
    repoState.pauseReason = `target ${config.lifecycle.target_mode} '${config.lifecycle.target_name}' is complete`;
    repoState.targetComplete = true;
    return true;
  }

  repoState.status = "paused_target_complete";
  repoState.pauseReason = `target ${config.lifecycle.target_mode} '${config.lifecycle.target_name}' is complete`;
  repoState.targetComplete = true;
  return true;
}

function runAutonomousRole(config, stateDir) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  clearRecoveredFailureState(repoState);
  const controlState = loadControlState(stateDir, config.repo.key);
  const serviceState = loadServiceState(stateDir, config.repo.key, "autonomous");
  serviceState.sessionStartedAt = PROCESS_STARTED_AT;
  serviceState.enabled = roleEnabled(config, controlState, "autonomous");
  serviceState.alive = true;
  const issueQueue = getIssueQueue(config, stateDir, "autonomous");
  const issues = issueQueue.issues;
  const openPrs = loadCachedOpenPullRequests(stateDir, config.repo.key);
  const openPrCount = summarizeOpenPullRequests(openPrs).active;
  repoState.lastRoleRunAt = new Date().toISOString();
  repoState.lastTargetCheckAt = repoState.lastRoleRunAt;
  repoState.targetComplete = false;
  repoState.pauseReason = issueQueue.source === "github" ? null : repoState.pauseReason;
  repoState.status = "running";

  if (maybePauseForCompletion(config, repoState, issues, openPrCount)) {
    serviceState.summary = `target complete, ${issues.length} matching issue(s) remain`;
    saveServiceState(stateDir, config.repo.key, "autonomous", serviceState);
    updateRepoStateService(repoState, "autonomous", serviceState);
    saveRepoState(stateDir, config.repo.key, repoState);
    return;
  }

  if (
    config.lifecycle.pause_when_budget_exhausted &&
    config.budgets.max_estimated_credits_per_day != null &&
    repoState.runsToday >= config.budgets.max_estimated_credits_per_day
  ) {
    repoState.status = "paused_budget";
    repoState.pauseReason = config.budgets.pause_reason_on_budget;
  }

  controlState.desiredServices = controlState.desiredServices ?? {};
  for (const role of VALID_ROLES) {
    controlState.desiredServices[role] = config.roles.enabled[role] !== false;
  }
  serviceState.summary = `repo running, ${issues.length} target issue(s) visible via ${issueQueue.source}`;
  saveServiceState(stateDir, config.repo.key, "autonomous", serviceState);
  updateRepoStateService(repoState, "autonomous", serviceState);
  saveControlState(stateDir, config.repo.key, controlState);
  saveRepoState(stateDir, config.repo.key, repoState);
}

function buildDispatcherBranchName(config, issue) {
  return `${config.branches.work_branch_prefix}${issue.number}-${safeSlug(issue.title)}`;
}

function extractIssueNumberFromBranch(config, branchName) {
  const prefix = String(config.branches.work_branch_prefix ?? "").trim();
  const branch = String(branchName ?? "").trim();
  if (!prefix || !branch.startsWith(prefix)) {
    return null;
  }

  const suffix = branch.slice(prefix.length);
  const match = suffix.match(/^([0-9]+)/);
  if (!match) {
    return null;
  }

  const issueNumber = Number.parseInt(match[1], 10);
  return Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

function dirtyMergeState(pr) {
  return String(pr?.mergeStateStatus ?? "").toUpperCase() === "DIRTY";
}

function autoCloseSupersededConflictsEnabled(config) {
  return Boolean(config.pr_manager?.auto_close_superseded_conflicts);
}

function buildSupersededConflictComment(issueNumber) {
  return [
    `Closed automatically because issue #${issueNumber} is already closed and this PR now has merge conflicts.`,
    "",
    "The autonomous engine is treating this as superseded by the PR that closed the issue."
  ].join("\n");
}

function closeSupersededConflictPullRequests(config, stateDir, prs) {
  if (!autoCloseSupersededConflictsEnabled(config)) {
    return [];
  }

  const closed = [];
  for (const pr of prs) {
    if (!dirtyMergeState(pr)) {
      continue;
    }

    const issueNumber = extractIssueNumberFromBranch(config, pr.headRefName);
    if (issueNumber == null) {
      continue;
    }

    let issue;
    try {
      issue = getIssueDetails(config, issueNumber);
    } catch (error) {
      appendServiceLog(
        stateDir,
        config.repo.key,
        "pr-manager",
        `superseded conflict check skipped for #${pr.number}; issue #${issueNumber} lookup failed: ${error.message}`
      );
      continue;
    }

    if (String(issue?.state ?? "").toUpperCase() !== "CLOSED") {
      continue;
    }

    try {
      closePullRequest(config, pr.number, buildSupersededConflictComment(issueNumber));
      closed.push({
        number: pr.number,
        issueNumber,
        action: "closed_superseded_conflict",
        at: new Date().toISOString()
      });
      appendServiceLog(
        stateDir,
        config.repo.key,
        "pr-manager",
        `closed superseded conflicted PR #${pr.number}; issue #${issueNumber} is already closed`
      );
    } catch (error) {
      appendServiceLog(
        stateDir,
        config.repo.key,
        "pr-manager",
        `superseded conflict close failed for #${pr.number}: ${error.message}`
      );
    }
  }

  return closed;
}

function buildRemediationPayload(issue, remediation, launch, payloadPath) {
  const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => label.name) : [];
  const headRepositorySlug =
    remediation?.head_repository_owner && remediation?.head_repository
      ? `${remediation.head_repository_owner}/${remediation.head_repository}`
      : null;

  return {
    mode: "remediation",
    intent: "remediate_pull_request",
    payload_path: payloadPath,
    remediation: {
      intent: "patch_existing_pull_request_branch",
      worker_action: "branch_fix",
      issue_flow: "reuse_existing_pull_request",
      patch_target: remediation.branch ?? null
    },
    issue: {
      number: issue.number,
      title: issue.title,
      url: issue.url ?? null,
      labels,
      milestone: issue.milestone?.title ?? null,
      body: issue.body ?? null
    },
    pull_request: {
      number: remediation.pr_number,
      url: remediation.pr_url ?? null,
      branch: remediation.branch ?? null,
      head_sha: remediation.sha ?? null,
      head_repository_owner: remediation.head_repository_owner ?? null,
      head_repository: remediation.head_repository ?? null,
      head_repository_slug: headRepositorySlug,
      is_cross_repository: remediation.is_cross_repository ?? false,
      maintainer_can_modify: remediation.maintainer_can_modify ?? null
    },
    failure: {
      summary: remediation.failureSummary ?? null,
      log_reference: remediation.runLog ?? null,
      failing_services: Array.isArray(remediation.services) ? remediation.services : []
    },
    constraints: {
      current_worktree_only: true,
      patch_existing_pr_branch: true,
      reuse_existing_pr: true,
      allow_branch_switching: false,
      allow_new_branch: false,
      allow_new_worktree: false,
      allow_new_issue_flow: false,
      allow_new_pr: false,
      push_target: remediation.branch ?? null,
      push_repository: headRepositorySlug
    },
    launch: {
      lane: launch.lane,
      model: launch.model,
      reasoning_effort: launch.reasoningEffort
    }
  };
}

function readFailureLogExcerpt(runLogPath, maxChars = 4000) {
  if (!runLogPath) {
    return "";
  }
  try {
    const content = fs.readFileSync(runLogPath, "utf8").trim();
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch {
    return "";
  }
}

function buildIssuePrompt(config, issue, launch, remediation = null, payloadPath = null) {
  const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => label.name).join(", ") : "";
  const milestone = issue.milestone?.title ?? "";
  const isBacklogFileIssue = issue.source === "backlog_file";
  const issueDisplayName = isBacklogFileIssue
    ? `${issue.backlog_id ?? `#${issue.number}`} from ${issue.backlog_file ?? config.lifecycle.target_name}`
    : `GitHub issue #${issue.number}`;
  const headRepositorySlug =
    remediation?.head_repository_owner && remediation?.head_repository
      ? `${remediation.head_repository_owner}/${remediation.head_repository}`
      : null;
  const header = remediation
    ? `Work ${issueDisplayName} in this repository and carry it through on the existing pull request.`
    : `Work ${issueDisplayName} in this repository and carry it through to a pull request.`;
  const failureLogExcerpt = remediation ? readFailureLogExcerpt(remediation.runLog) : "";
  const prContext = remediation
    ? `
Existing pull request context:
- Remediation mode: this is a branch-fix run for an existing pull request, not a new issue flow.
- Remediation intent: patch the existing PR branch in place.
- Repair PR #${remediation.pr_number} on branch ${remediation.branch}.
- Reuse the existing pull request${remediation.pr_url ? `: ${remediation.pr_url}` : ""}.
- Current head SHA: ${remediation.sha ?? "(unknown)"}.
- Failure summary: ${remediation.failureSummary ?? "(none recorded)"}.
- Failure log reference: ${remediation.runLog ?? "(none recorded)"}.
- Recorded remediation payload: ${payloadPath ?? "(not recorded)"}.
- Preserve the existing branch owner${headRepositorySlug ? ` in ${headRepositorySlug}` : ""}.
- Preserve branch ownership and PR association.
- Patch the existing PR branch in the current worktree and push commits back to that branch only.
- Do not switch to a different branch or create a new worktree.
- Do not create a new branch, do not open a new PR, and do not start a new issue flow.
- If the failure is a mechanical lint/formatting violation (e.g. markdownlint spacing rules like MD022/MD032), prefer running that tool's own auto-fix command as a "commands" action (installing it first if needed, e.g. "npm install -g markdownlint-cli2 && markdownlint-cli2 --fix <the exact files the failure log names>") over manually re-typing file content -- it fixes whitespace-only violations deterministically in one step instead of repeated read/verify cycles.
${failureLogExcerpt
  ? `
Failure log excerpt (the actual tool output that failed -- fix exactly what this reports, in the files it names, rather than re-researching the topic):
\`\`\`
${failureLogExcerpt}
\`\`\`
`
  : ""}`
    : "";
  const prExecutionRequirement = remediation
    ? `- Reuse the existing pull request #${remediation.pr_number} on branch ${remediation.branch}; push commits back to the existing upstream branch${headRepositorySlug ? ` in ${headRepositorySlug}` : ""}; do not create a new branch or PR.`
    : `- Open a GitHub pull request against ${config.branches.pr_base_branch}.`;
  const sourceOfTruthRequirement = isBacklogFileIssue
    ? `Treat the repo-local backlog item ${issue.backlog_id ?? `#${issue.number}`} and its source file as the source of truth.`
    : "Treat the GitHub issue as the source of truth.";
  const prLinkRequirement = remediation
    ? `Preserve the existing PR linkage back to ${isBacklogFileIssue ? `backlog item ${issue.backlog_id ?? `#${issue.number}`}` : `issue #${issue.number}`}; do not create or link a replacement PR.`
    : isBacklogFileIssue
      ? `Reference backlog item ${issue.backlog_id ?? `#${issue.number}`} in the PR title or body.`
      : `Link the PR back to issue #${issue.number}.`;
  const issueBodyContext = remediation
    ? `Original issue body (background only -- this describes the initial implementation task, already done; do not redo its research requirements, only act on the remediation task above):
${issue.body || "(no issue body provided)"}`
    : `Issue body:
${issue.body || "(no issue body provided)"}`;
  return `${header}
${prContext}
Issue title:
${issue.title}

Issue URL:
${issue.url}

Issue labels:
${labels || "(none)"}

Issue milestone:
${milestone || "(none)"}

${issueBodyContext}

Execution requirements:
- ${sourceOfTruthRequirement}
- Work in the current git worktree and current branch only.
- ${remediation ? "Treat the remediation payload details above as additional required context for fixing the existing PR." : "Use the current branch for the implementation work."}
- Make the smallest complete set of changes that resolves the issue.
- Run relevant repository validation locally before finishing.
- Commit the changes.
${prExecutionRequirement}
- ${prLinkRequirement}
- In the final response, provide the PR URL and a concise implementation summary.

Operating constraints:
- Use model lane ${launch.lane} with model ${launch.model}.
- Do not leave the branch or PR half-finished.
- If blocked, explain the blocker clearly in the final response and in the PR body if one was opened.
`;
}

function updateDispatcherState(config, stateDir, mutate) {
  const serviceState = loadServiceState(stateDir, config.repo.key, "dispatcher");
  serviceState.items = Array.isArray(serviceState.items) ? serviceState.items : [];
  mutate(serviceState);
  saveServiceState(stateDir, config.repo.key, "dispatcher", serviceState);
  return serviceState;
}

function resetDispatcherItemExecutionState(item, status = "queued") {
  item.status = status;
  item.pid = null;
  item.started_at = null;
  item.finished_at = null;
  item.exit_code = null;
  item.signal = null;
  item.assigned_model = null;
  item.assigned_lane = null;
  item.reasoning_effort = null;
  item.last_error = null;
  item.payload_path = null;
}

function buildOpenRemediationMap(repoState, openPullRequests = []) {
  const remediationByBranch = new Map();
  const prsByNumber = new Map(
    (Array.isArray(openPullRequests) ? openPullRequests : []).map((pr) => [Number(pr.number), pr])
  );

  for (const record of ensureRemediationRecords(repoState)) {
    if (String(record?.status ?? "").trim().toLowerCase() !== "open") {
      continue;
    }

    const pr = prsByNumber.get(Number(record.prNumber));
    if (!pr) {
      continue;
    }
    if (String(record.sha ?? "").trim() !== String(pr.headRefOid ?? "").trim()) {
      continue;
    }

    const branch = String(record.branch ?? pr.headRefName ?? "").trim();
    if (!branch) {
      continue;
    }

    const existing = remediationByBranch.get(branch);
    if (existing) {
      existing.services.add(String(record.service ?? "").trim());
      if (record.updatedAt && (!existing.updatedAt || record.updatedAt > existing.updatedAt)) {
        existing.updatedAt = record.updatedAt;
        existing.failureSummary = record.failureSummary ?? existing.failureSummary ?? null;
        existing.runLog = record.runLog ?? existing.runLog ?? null;
      }
      continue;
    }

    remediationByBranch.set(branch, {
      pr_number: Number(pr.number),
      pr_url: pr.url ?? null,
      branch,
      sha: pr.headRefOid ?? null,
      head_repository: record.headRepository ?? pr.headRepository ?? null,
      head_repository_owner: record.headRepositoryOwner ?? pr.headRepositoryOwner ?? null,
      is_cross_repository: record.isCrossRepository ?? pr.isCrossRepository ?? false,
      maintainer_can_modify: record.maintainerCanModify ?? pr.maintainerCanModify ?? null,
      services: new Set([String(record.service ?? "").trim()].filter(Boolean)),
      failureSummary: record.failureSummary ?? null,
      runLog: record.runLog ?? null,
      updatedAt: record.updatedAt ?? null
    });
  }

  return new Map(
    Array.from(remediationByBranch.entries()).map(([branch, remediation]) => [
      branch,
      {
        ...remediation,
        services: Array.from(remediation.services).sort()
      }
    ])
  );
}

function updateRemediationRecordStatus(repoState, remediation, status, metadata = {}) {
  const records = ensureRemediationRecords(repoState);
  const now = new Date().toISOString();
  let changed = false;

  for (const record of records) {
    if (Number(record?.prNumber) !== Number(remediation?.pr_number)) {
      continue;
    }
    if (String(record?.sha ?? "").trim() !== String(remediation?.sha ?? "").trim()) {
      continue;
    }

    record.branch = String(record.branch ?? remediation.branch ?? "").trim() || null;
    record.status = status;
    record.updatedAt = now;
    if (metadata.assigned_lane != null) {
      record.assigned_lane = metadata.assigned_lane;
    }
    if (metadata.assigned_model != null) {
      record.assigned_model = metadata.assigned_model;
    }
    if (metadata.dispatch_started_at != null) {
      record.dispatch_started_at = metadata.dispatch_started_at;
    }
    if (metadata.dispatch_finished_at != null) {
      record.dispatch_finished_at = metadata.dispatch_finished_at;
    }
    if (metadata.dispatch_exit_code !== undefined) {
      record.dispatch_exit_code = metadata.dispatch_exit_code;
    }
    changed = true;
  }

  return changed;
}

function persistRemediationStatus(config, stateDir, remediation, status, metadata = {}) {
  if (!remediation) {
    return;
  }

  const repoState = loadRepoState(stateDir, config.repo.key);
  if (!updateRemediationRecordStatus(repoState, remediation, status, metadata)) {
    return;
  }
  saveRepoState(stateDir, config.repo.key, repoState);
}

function buildDispatcherLaunchLockPath(stateDir, repoKey, item) {
  const servicePaths = buildServicePaths(stateDir, repoKey, "dispatcher");
  fs.mkdirSync(servicePaths.outputRoot, { recursive: true });
  return path.join(servicePaths.outputRoot, `issue-${item.number}.lock.json`);
}

function readDispatcherLaunchLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function dispatcherLaunchLockIsActive(lockPath, now = Date.now()) {
  const lock = readDispatcherLaunchLock(lockPath);
  if (!lock?.createdAt) {
    return false;
  }
  const createdAt = Date.parse(lock.createdAt);
  const processStartedAt = Date.parse(PROCESS_STARTED_AT);
  return Number.isFinite(createdAt)
    && Number.isFinite(processStartedAt)
    && createdAt >= processStartedAt
    && (now - createdAt) < DISPATCHER_LAUNCH_LOCK_TTL_MS;
}

function releaseDispatcherLaunchLock(lockPath) {
  if (!lockPath) {
    return;
  }
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {}
}

function acquireDispatcherLaunchLock(stateDir, repoKey, item) {
  const lockPath = buildDispatcherLaunchLockPath(stateDir, repoKey, item);
  try {
    fs.writeFileSync(lockPath, JSON.stringify({
      issueNumber: item.number,
      branch: item.branch,
      createdAt: new Date().toISOString(),
      processPid: process.pid
    }, null, 2), { flag: "wx" });
    return lockPath;
  } catch (error) {
    if (error?.code === "EEXIST" && !dispatcherLaunchLockIsActive(lockPath)) {
      releaseDispatcherLaunchLock(lockPath);
      fs.writeFileSync(lockPath, JSON.stringify({
        issueNumber: item.number,
        branch: item.branch,
        createdAt: new Date().toISOString(),
        processPid: process.pid
      }, null, 2), { flag: "wx" });
      return lockPath;
    }
    return null;
  }
}

function reconcileDispatcherItems(config, stateDir, repoState, serviceState, issues, openPullRequests = []) {
  const previousByNumber = new Map(
    (Array.isArray(serviceState.items) ? serviceState.items : []).map((item) => [Number(item.number), item])
  );
  const openBranches = new Set(
    (Array.isArray(openPullRequests) ? openPullRequests : []).map((pr) => String(pr.headRefName ?? "").trim())
  );
  const openRemediationByBranch = buildOpenRemediationMap(repoState, openPullRequests);
  const nextItems = issues.map((issue) => {
    const previous = previousByNumber.get(Number(issue.number)) ?? {};
    const merged = {
      number: issue.number,
      title: issue.title,
      url: issue.url ?? null,
      branch: previous.branch ?? buildDispatcherBranchName(config, issue),
      status: previous.status ?? "queued",
      log: previous.log ?? null,
      worktree: previous.worktree ?? null,
      pid: previous.pid ?? null,
      started_at: previous.started_at ?? null,
      finished_at: previous.finished_at ?? null,
      exit_code: previous.exit_code ?? null,
      signal: previous.signal ?? null,
      assigned_model: previous.assigned_model ?? null,
      assigned_lane: previous.assigned_lane ?? null,
      assigned_provider: previous.assigned_provider ?? null,
      reasoning_effort: previous.reasoning_effort ?? null,
      pr_url: previous.pr_url ?? null,
      last_error: previous.last_error ?? null,
      payload_path: previous.payload_path ?? null,
      prompt_path: previous.prompt_path ?? null,
      runtime_service: previous.runtime_service ?? null,
      runtime_endpoint: previous.runtime_endpoint ?? null,
      runtime_image: previous.runtime_image ?? null,
      local_provider: previous.local_provider ?? null,
      auto_pull: previous.auto_pull ?? false,
      remediation: previous.remediation ?? null
    };
    const launchLockPath = buildDispatcherLaunchLockPath(stateDir, config.repo.key, merged);
    const launchLockActive = dispatcherLaunchLockIsActive(launchLockPath);

    const child = dispatcherWorkers.get(issue.number);
    if (merged.status === "running") {
      if ((!child || child.exitCode != null || child.killed) && !launchLockActive) {
        resetDispatcherItemExecutionState(merged);
      }
    }

    if (merged.status !== "running" && launchLockActive) {
      merged.status = "running";
      merged.pid = previous.pid ?? null;
      merged.started_at = previous.started_at ?? readDispatcherLaunchLock(launchLockPath)?.createdAt ?? null;
      merged.finished_at = null;
      merged.exit_code = null;
      merged.signal = null;
    }

    if (
      (merged.status === "failed" || merged.status === "completed") &&
      !openBranches.has(String(merged.branch ?? "").trim())
    ) {
      resetDispatcherItemExecutionState(merged);
    }

    const remediation = openRemediationByBranch.get(String(merged.branch ?? "").trim()) ?? null;
    merged.remediation = remediation;
    if (remediation) {
      merged.pr_url = remediation.pr_url ?? merged.pr_url ?? null;
      if (merged.status !== "running") {
        resetDispatcherItemExecutionState(merged, "queued");
      }
    }

    return merged;
  });

  serviceState.items = nextItems;
  return nextItems;
}

function computeDispatcherTargets(config, issueCount, openPrs, remediationCount = 0) {
  const lanePlan = computeLanePlan(config, issueCount, openPrs, remediationCount);
  let remainingSlots = Math.min(lanePlan.issueSlots, lanePlan.targetConcurrency);
  const targets = {};

  for (const lane of getDispatcherLanes(config)) {
    const configuredTarget = lanePlan.configuredTargets[lane.key] ?? 0;
    const target = Math.min(configuredTarget, remainingSlots);
    targets[lane.key] = target;
    remainingSlots -= target;
  }

  targets.primary ??= 0;
  targets.secondary ??= 0;
  targets.local ??= 0;
  return targets;
}

function loadCachedOpenPullRequests(stateDir, repoKey) {
  return loadPullRequestQueueState(stateDir, repoKey).prs;
}

function loadOpenPullRequestsForLocalServices(config, stateDir, serviceName) {
  const cached = loadCachedOpenPullRequests(stateDir, config.repo.key);
  if (cached.length > 0) {
    return { prs: cached, source: "pr-manager-cache" };
  }

  try {
    const prs = listOpenPullRequests(config).map((pr) => normalizePullRequestRecord(pr));
    if (prs.length > 0) {
      appendServiceLog(
        stateDir,
        config.repo.key,
        serviceName,
        `pr-manager cache empty; using direct GitHub PR list (${prs.length} open)`
      );
      return { prs, source: "github-direct" };
    }
  } catch (error) {
    appendServiceLog(
      stateDir,
      config.repo.key,
      serviceName,
      `pr-manager cache empty; direct GitHub PR list failed: ${error.message}`
    );
  }

  appendServiceLog(
    stateDir,
    config.repo.key,
    serviceName,
    "pr-manager cache empty; waiting for local PR queue refresh"
  );
  return { prs: [], source: "pr-manager-cache-empty" };
}

function getRunningCountByLane(items, lane) {
  return items.filter((item) => item.status === "running" && item.assigned_lane === lane).length;
}

function isRemediationItem(item) {
  return Boolean(item?.remediation);
}

function localRuntimeAvailable(launch) {
  if (launch.provider !== "local_container" || launch.runtimeCommand) {
    return true;
  }
  if (!launch.runtimeHealthUrl || !commandExists("curl")) {
    return true;
  }

  const result = spawnSync("curl", ["-fsS", "--max-time", "2", launch.runtimeHealthUrl], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) {
    return false;
  }
  if ((launch.localProvider ?? "ollama") !== "ollama" || launch.autoPull) {
    return true;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    return models.some((entry) => {
      const name = String(entry?.name ?? entry?.model ?? "");
      return name === launch.model || name.split(":")[0] === launch.model;
    });
  } catch {
    return true;
  }
}

function chooseLaunchLane(config, items, laneTargets) {
  const candidates = getDispatcherLanes(config)
    .map((lane) => ({
      lane: lane.key,
      label: lane.label,
      provider: lane.provider,
      model: lane.name,
      reasoningEffort: lane.reasoning_effort,
      runtimeService: lane.runtime_service,
      runtimeEndpoint: lane.runtime_endpoint,
      runtimeHealthUrl: lane.runtime_health_url,
      runtimeCommand: lane.runtime_command,
      runtimeImage: lane.runtime_image,
      localProvider: lane.local_provider,
      apiKeyEnv: lane.api_key_env,
      numThread: Number(lane.num_thread ?? 0),
      numCtx: Number(lane.num_ctx ?? 0),
      keepAlive: lane.keep_alive ?? "",
      autoPull: Boolean(lane.auto_pull),
      running: getRunningCountByLane(items, lane.key),
      target: laneTargets[lane.key] ?? 0
    }))
    .filter((candidate) => candidate.target > candidate.running)
    .filter((candidate) => localRuntimeAvailable(candidate))
    .sort((left, right) => {
      const leftDeficit = left.target - left.running;
      const rightDeficit = right.target - right.running;
      if (rightDeficit !== leftDeficit) {
        return rightDeficit - leftDeficit;
      }
      return left.lane.localeCompare(right.lane);
    });

  return candidates[0] ?? null;
}

function persistDispatcherSummary(config, stateDir) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  const serviceState = loadServiceState(stateDir, config.repo.key, "dispatcher");
  const items = Array.isArray(serviceState.items) ? serviceState.items : [];
  const queue = items
    .filter((item) => item.status === "running")
    .map((item) => ({
      number: item.number,
      title: item.title,
      lane: item.assigned_lane,
      model: item.assigned_model,
      reasoning_effort: item.reasoning_effort,
      url: item.url
    }));
  const openPrs = loadCachedOpenPullRequests(stateDir, config.repo.key);
  const openPrSummary = summarizeOpenPullRequests(openPrs);
  const queuedCount = items.filter((item) => item.status === "queued").length;
  const runningCount = items.filter((item) => item.status === "running").length;
  serviceState.summary =
    `${items.length} target issues, ${runningCount} running, ${queuedCount} queued, ` +
    `${openPrSummary.total} open PRs (${openPrSummary.active} active, ${openPrSummary.drafts} draft)`;
  serviceState.queue = queue;
  serviceState.openPrCount = openPrs.length;
  serviceState.activeOpenPrCount = openPrSummary.active;
  serviceState.draftOpenPrCount = openPrSummary.drafts;
  serviceState.progress = {
    totalIssues: items.length,
    running: runningCount,
    queued: queuedCount,
    openPrs: openPrs.length,
    activeOpenPrs: openPrSummary.active,
    draftOpenPrs: openPrSummary.drafts,
    runningIssues: queue.map((item) => ({
      number: item.number,
      lane: item.lane,
      model: item.model
    }))
  };
  saveServiceState(stateDir, config.repo.key, "dispatcher", serviceState);
  updateRepoStateService(repoState, "dispatcher", serviceState);
  saveRepoState(stateDir, config.repo.key, repoState);
}

function buildDispatcherLaneState(config, laneTargets) {
  return Object.fromEntries(
    getDispatcherLanes(config).map((lane) => [
      lane.key,
      {
        label: lane.label,
        provider: lane.provider,
        model: lane.name,
        reasoning_effort: lane.reasoning_effort,
        targetConcurrency: laneTargets[lane.key] ?? 0,
        runtime_service: lane.runtime_service ?? null,
        runtime_endpoint: lane.provider === "local_container" ? lane.runtime_endpoint : null,
        runtime_image: lane.provider === "local_container" ? lane.runtime_image : null,
        local_provider: lane.provider === "local_container" ? lane.local_provider : null,
        num_thread: lane.provider === "local_container" ? Number(lane.num_thread ?? 0) : 0,
        num_ctx: lane.provider === "local_container" ? Number(lane.num_ctx ?? 0) : 0,
        keep_alive: lane.provider === "local_container" ? String(lane.keep_alive ?? "") : "",
        auto_pull: lane.provider === "local_container" ? Boolean(lane.auto_pull) : false
      }
    ])
  );
}

function buildCodexArgs(launch, worktree, issuePrompt) {
  const args = [
    "--search",
    "exec",
    "-m",
    launch.model,
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    worktree,
    issuePrompt
  ];

  if (launch.reasoningEffort && launch.reasoningEffort !== "local") {
    args.splice(4, 0, "-c", `model_reasoning_effort=${launch.reasoningEffort}`);
  }

  return args;
}

function buildLocalLaneEnv(config, stateDir, baseEnv, launch, item, issue, worktree, promptPath, remediationPayloadPath) {
  const isOpenAiCompatible = launch.provider === "openai_compatible";
  // isOpenAiCompatible must win outright: a lane that started life as
  // local_container and was later switched to openai_compatible through the
  // dashboard keeps its old local_provider value (the Settings UI hides that
  // field rather than clearing it), so checking local_provider first would
  // silently misroute a hosted-API lane through the local Ollama/LM Studio
  // dispatch path.
  const localModelProvider = isOpenAiCompatible ? "openai_compatible" : (launch.localProvider || "ollama");

  const env = {
    ...baseEnv,
    AE_LANE_PROVIDER: launch.provider,
    AE_LANE_KEY: launch.lane,
    AE_LANE_MODEL: launch.model,
    AE_WORKTREE: worktree,
    AE_ISSUE_NUMBER: String(item.number),
    AE_ISSUE_TITLE: issue.title ?? "",
    AE_ISSUE_REQUIRED_PREFIX: String(config.issue_source.required_issue_prefix ?? ""),
    AE_BRANCH_NAME: item.branch,
    AE_PR_BASE_BRANCH: config.branches.pr_base_branch,
    // Repo-specific catalog layout, used to derive a target_path from an
    // issue's Queue Agent Slug when the issue body carries no filesystem
    // path, and to drive the optional sibling-exemplar/source-pattern
    // context-harvesting in local-lane-runner.mjs. Empty for repos that
    // don't use a catalog-overlay layout -- every one of these features is
    // dead code for such repos, not just unused config.
    AE_CATALOG_OVERLAY_ROOT: String(config.repo.catalog?.overlay_root ?? ""),
    AE_CATALOG_SPEC_FILENAME: String(config.repo.catalog?.spec_filename ?? ""),
    AE_CATALOG_SLUG_PREFIX: String(config.repo.catalog?.slug_prefix ?? ""),
    AE_CATALOG_EXEMPLAR_KEYS: (Array.isArray(config.repo.catalog?.exemplar_keys) ? config.repo.catalog.exemplar_keys : []).join(","),
    AE_CATALOG_FIRST_ENTRY_EXEMPLAR_KEY: String(config.repo.catalog?.first_entry_exemplar_key ?? ""),
    AE_CATALOG_SOURCE_PATTERN_FILENAMES: (Array.isArray(config.repo.catalog?.source_pattern_filenames) ? config.repo.catalog.source_pattern_filenames : []).join(","),
    // Opt-in quality gate -- see config.mjs's quality_gates.authority_research
    // comment. Empty keywords means the gate never engages.
    AE_AUTHORITY_RESEARCH_KEYWORDS: (Array.isArray(config.quality_gates?.authority_research?.trigger_keywords) ? config.quality_gates.authority_research.trigger_keywords : []).join(","),
    AE_AUTHORITY_RESEARCH_MIN_SOURCES: String(config.quality_gates?.authority_research?.min_sources ?? 6),
    AE_ISSUE_PROMPT_PATH: promptPath,
    AE_REMEDIATION_PAYLOAD_PATH: remediationPayloadPath ?? "",
    AE_LOCAL_MODEL_SERVICE: launch.runtimeService ?? "",
    AE_LOCAL_MODEL_ENDPOINT: launch.runtimeEndpoint ?? "",
    AE_LOCAL_MODEL_HEALTH_URL: launch.runtimeHealthUrl ?? "",
    AE_LOCAL_MODEL_PROVIDER: localModelProvider,
    AE_LOCAL_MODEL_AUTO_PULL: launch.autoPull ? "1" : "0"
  };

  if (Number(launch.numThread) > 0) {
    env.AE_LOCAL_CODER_NUM_THREAD = String(Math.trunc(Number(launch.numThread)));
  }
  if (Number(launch.numCtx) > 0) {
    env.AE_LOCAL_CODER_NUM_CTX = String(Math.trunc(Number(launch.numCtx)));
  }
  if (launch.keepAlive) {
    env.AE_LOCAL_CODER_KEEP_ALIVE = String(launch.keepAlive);
  }

  if (launch.runtimeEndpoint) {
    env.OPENAI_BASE_URL = env.OPENAI_BASE_URL || launch.runtimeEndpoint;
    env.OPENAI_API_BASE = env.OPENAI_API_BASE || launch.runtimeEndpoint;
    // openai_compatible lanes resolve a real key (dashboard-stored value first,
    // then the env var named by the lane's api_key_env); local_container lanes
    // (Ollama/LM Studio without auth) fall back to a dummy bearer token.
    const resolvedKey = isOpenAiCompatible
      ? resolveLaneApiKey(stateDir, config.repo.key, { key: launch.lane, api_key_env: launch.apiKeyEnv })
      : "";
    env.OPENAI_API_KEY = env.OPENAI_API_KEY || resolvedKey || "local-model";
  }

  return env;
}

function spawnDispatcherWorker(config, stateDir, item, issue, launch, worktree, issuePrompt, promptPath, remediationPayloadPath, codexHome) {
  const baseEnv = {
    ...process.env
  };
  if (codexHome) {
    baseEnv.CODEX_HOME = codexHome;
  }

  if (launch.provider === "local_container" || launch.provider === "openai_compatible") {
    const env = buildLocalLaneEnv(config, stateDir, baseEnv, launch, item, issue, worktree, promptPath, remediationPayloadPath);
    if (launch.runtimeCommand) {
      return spawn("sh", ["-lc", launch.runtimeCommand], {
        cwd: worktree,
        stdio: ["ignore", "pipe", "pipe"],
        env
      });
    }

    return spawn(
      "node",
      [LOCAL_LANE_RUNNER_PATH],
      {
        cwd: config.repo.workspace_dir,
        stdio: ["ignore", "pipe", "pipe"],
        env
      }
    );
  }

  return spawn(
    "codex",
    buildCodexArgs(launch, worktree, issuePrompt),
    {
      cwd: config.repo.workspace_dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: baseEnv
    }
  );
}

function startDispatcherItem(config, stateDir, item, launch, laneTargets) {
  const servicePaths = buildServicePaths(stateDir, config.repo.key, "dispatcher");
  fs.mkdirSync(servicePaths.worktreeRoot, { recursive: true });
  fs.mkdirSync(servicePaths.runLogRoot, { recursive: true });
  fs.mkdirSync(servicePaths.outputRoot, { recursive: true });
  const launchLockPath = acquireDispatcherLaunchLock(stateDir, config.repo.key, item);
  if (!launchLockPath) {
    appendServiceLog(
      stateDir,
      config.repo.key,
      "dispatcher",
      `issue #${item.number} launch skipped because a live launch lock already exists`
    );
    return false;
  }

  let issue;
  let worktree;
  try {
    issue = getIssueDetails(config, item.number);
    worktree = prepareBranchWorktree({
      repoDir: config.repo.workspace_dir,
      worktreeRoot: servicePaths.worktreeRoot,
      branchName: item.branch,
      baseBranch: config.branches.pr_base_branch,
      startPoint: item.remediation?.branch ?? null,
      startPointHeadRepository: item.remediation?.head_repository ?? null,
      startPointHeadRepositoryOwner: item.remediation?.head_repository_owner ?? null,
      repoSlug: config.repo.github_slug
    });
  } catch (error) {
    releaseDispatcherLaunchLock(launchLockPath);
    throw error;
  }
  const logPath = path.join(
    servicePaths.runLogRoot,
    `issue-${item.number}-${safeSlug(issue.title)}.log`
  );
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(`START ${new Date().toISOString()}\n`);
  logStream.on("error", (error) => {
    appendServiceLog(
      stateDir,
      config.repo.key,
      "dispatcher",
      `issue #${item.number} log stream error: ${error.message}`
    );
  });
  const safeLogWrite = (chunk) => {
    if (!logStream.destroyed && !logStream.writableEnded) {
      logStream.write(chunk);
    }
  };
  const codexHome = launch.provider !== "hosted_codex"
    ? null
    : prepareIsolatedCodexHome(`commons-devloop-dispatcher-${item.number}-`);
  const remediationPayloadPath = item.remediation
    ? path.join(
      servicePaths.outputRoot,
      `issue-${item.number}-pr-${item.remediation.pr_number}-${safeSlug(String(item.remediation.sha ?? "").slice(0, 12) || item.remediation.branch || "remediation")}.json`
    )
    : null;

  if (remediationPayloadPath) {
    writeJsonFile(
      remediationPayloadPath,
      buildRemediationPayload(issue, item.remediation, launch, remediationPayloadPath)
    );
  }

  const issuePrompt = buildIssuePrompt(config, issue, launch, item.remediation, remediationPayloadPath);
  const promptPath = path.join(servicePaths.outputRoot, `issue-${item.number}-${safeSlug(issue.title)}-prompt.md`);
  fs.writeFileSync(promptPath, issuePrompt);
  const child = spawnDispatcherWorker(
    config,
    stateDir,
    item,
    issue,
    launch,
    worktree,
    issuePrompt,
    promptPath,
    remediationPayloadPath,
    codexHome
  );

  child.stdout.on("data", safeLogWrite);
  child.stderr.on("data", safeLogWrite);
  dispatcherWorkers.set(item.number, child);
  item.status = "running";
  item.pid = child.pid;
  item.log = logPath;
  item.worktree = worktree;
  item.started_at = new Date().toISOString();
  item.finished_at = null;
  item.exit_code = null;
  item.signal = null;
  item.assigned_model = launch.model;
  item.assigned_lane = launch.lane;
  item.assigned_provider = launch.provider;
  item.reasoning_effort = launch.reasoningEffort;
  item.last_error = null;
  item.pr_url = item.remediation?.pr_url ?? item.pr_url ?? null;
  item.payload_path = remediationPayloadPath;
  item.prompt_path = promptPath;
  item.runtime_service = launch.runtimeService ?? null;
  item.runtime_endpoint = launch.runtimeEndpoint ?? null;
  item.runtime_image = launch.runtimeImage ?? null;
  item.local_provider = launch.localProvider ?? null;
  item.num_thread = launch.numThread ?? 0;
  item.num_ctx = launch.numCtx ?? 0;
  item.auto_pull = launch.autoPull ?? false;

  updateDispatcherState(config, stateDir, (serviceState) => {
    const items = Array.isArray(serviceState.items) ? serviceState.items : [];
    const target =
      items.find((entry) => Number(entry.number) === Number(item.number)) ??
      (() => {
        items.push(item);
        return item;
      })();
    target.status = "running";
    target.pid = child.pid;
    target.log = logPath;
    target.worktree = worktree;
    target.started_at = new Date().toISOString();
    target.finished_at = null;
    target.exit_code = null;
    target.signal = null;
    target.assigned_model = launch.model;
    target.assigned_lane = launch.lane;
    target.assigned_provider = launch.provider;
    target.reasoning_effort = launch.reasoningEffort;
    target.last_error = null;
    target.pr_url = item.remediation?.pr_url ?? target.pr_url ?? null;
    target.payload_path = remediationPayloadPath;
    target.prompt_path = promptPath;
    target.runtime_service = launch.runtimeService ?? null;
    target.runtime_endpoint = launch.runtimeEndpoint ?? null;
    target.runtime_image = launch.runtimeImage ?? null;
    target.local_provider = launch.localProvider ?? null;
    target.num_thread = launch.numThread ?? 0;
    target.num_ctx = launch.numCtx ?? 0;
    target.auto_pull = launch.autoPull ?? false;
    serviceState.items = items;
    serviceState.lanes = buildDispatcherLaneState(config, laneTargets);
  });
  persistRemediationStatus(config, stateDir, item.remediation, "running", {
    assigned_lane: launch.lane,
    assigned_model: launch.model,
    dispatch_started_at: item.started_at
  });
  appendServiceLog(
    stateDir,
    config.repo.key,
    "dispatcher",
    `issue #${item.number} started on pid ${child.pid} model=${launch.model} lane=${launch.lane}`
  );
  persistDispatcherSummary(config, stateDir);

  child.on("exit", (code, signal) => {
    dispatcherWorkers.delete(item.number);
    updateDispatcherState(config, stateDir, (serviceState) => {
      const items = Array.isArray(serviceState.items) ? serviceState.items : [];
      const target = items.find((entry) => Number(entry.number) === Number(item.number));
      if (target) {
        target.status = code === 0 ? "completed" : "failed";
        target.exit_code = code;
        target.signal = signal;
        target.finished_at = new Date().toISOString();
        target.pid = null;
        target.last_error = code === 0 ? null : `worker exited code=${code} signal=${signal}`;
      }
    });
    appendServiceLog(
      stateDir,
      config.repo.key,
      "dispatcher",
      `issue #${item.number} exited code=${code} signal=${signal}`
    );
    releaseDispatcherLaunchLock(launchLockPath);
    persistRemediationStatus(config, stateDir, item.remediation, code === 0 ? "completed" : "dispatch_failed", {
      dispatch_finished_at: new Date().toISOString(),
      dispatch_exit_code: code
    });
    safeLogWrite(`\nEND ${new Date().toISOString()} code=${code} signal=${signal}\n`);
    setTimeout(() => {
      if (!logStream.destroyed && !logStream.writableEnded) {
        logStream.end();
      }
    }, 100);
    if (codexHome) {
      syncCodexSessionHistory(codexHome);
      cleanupIsolatedCodexHome(codexHome);
    }
    persistDispatcherSummary(config, stateDir);
  });

  child.on("error", (error) => {
    appendServiceLog(
      stateDir,
      config.repo.key,
      "dispatcher",
      `issue #${item.number} spawn error: ${error.message}`
    );
    releaseDispatcherLaunchLock(launchLockPath);
    if (codexHome) {
      cleanupIsolatedCodexHome(codexHome);
    }
  });

  return true;
}

function runDispatcherRole(config, stateDir) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  clearRecoveredFailureState(repoState);
  const controlState = loadControlState(stateDir, config.repo.key);
  const serviceState = loadServiceState(stateDir, config.repo.key, "dispatcher");
  serviceState.sessionStartedAt = PROCESS_STARTED_AT;
  const serviceEnabled = roleEnabled(config, controlState, "dispatcher");
  serviceState.enabled = serviceEnabled;
  serviceState.alive = serviceEnabled;

  if (!serviceEnabled) {
    serviceState.summary = "dispatcher disabled";
    saveServiceState(stateDir, config.repo.key, "dispatcher", serviceState);
    updateRepoStateService(repoState, "dispatcher", serviceState);
    saveRepoState(stateDir, config.repo.key, repoState);
    return;
  }

  try {
    assertNoAutoTriggeredGithubActions(config);
  } catch (error) {
    serviceState.enabled = false;
    serviceState.alive = false;
    serviceState.summary = error.message;
    appendServiceLog(stateDir, config.repo.key, "dispatcher", error.message);
    saveServiceState(stateDir, config.repo.key, "dispatcher", serviceState);
    updateRepoStateService(repoState, "dispatcher", serviceState);
    saveRepoState(stateDir, config.repo.key, repoState);
    return;
  }

  const issueQueue = getIssueQueue(config, stateDir, "dispatcher");
  const issues = issueQueue.issues;
  const prQueue = (() => {
    try {
      return {
        prs: listOpenPullRequests(config),
        source: "github",
        error: null
      };
    } catch (error) {
      const cached = loadCachedOpenPullRequests(stateDir, config.repo.key);
      appendServiceLog(
        stateDir,
        config.repo.key,
        "dispatcher",
        `GitHub PR sync failed; using cached PR queue: ${error.message}`
      );
      return {
        prs: cached,
        source: cached.length > 0 ? "pr-manager-cache" : "empty-cache",
        error: error.message
      };
    }
  })();
  const prs = prQueue.prs;
  const items = reconcileDispatcherItems(config, stateDir, repoState, serviceState, issues, prs);
  const remediationCount = items.filter((item) => isRemediationItem(item)).length;
  const laneTargets = computeDispatcherTargets(config, items.length, prs, remediationCount);
  const maxRunning = Object.values(laneTargets).reduce((total, target) => total + Number(target ?? 0), 0);
  const servicePaths = buildServicePaths(stateDir, config.repo.key, "dispatcher");

  fs.mkdirSync(servicePaths.worktreeRoot, { recursive: true });
  fs.mkdirSync(servicePaths.runLogRoot, { recursive: true });
  fs.mkdirSync(servicePaths.outputRoot, { recursive: true });
  maybeRunServiceGarbageCollection(config, stateDir, "dispatcher", servicePaths, {
    keepWorktrees: items
      .filter((item) => item.status === "running")
      .map((item) => safeSlug(item.branch)),
    worktreeMaxAgeHours: 0,
    includeOutputs: true
  });

  serviceState.items = items;
  saveServiceState(stateDir, config.repo.key, "dispatcher", serviceState);

  const lanesRequiringCodex = getDispatcherLanes(config)
    .filter((lane) => (laneTargets[lane.key] ?? 0) > 0)
    .filter((lane) => lane.provider !== "local_container");
  if (lanesRequiringCodex.length > 0 && !commandExists("codex")) {
    throw new Error("codex CLI is not available");
  }

  while (items.filter((item) => item.status === "running").length < maxRunning) {
    const next =
      items.find((item) => item.status === "queued" && isRemediationItem(item)) ??
      items.find((item) => item.status === "queued");
    if (!next) {
      break;
    }

    const launch = chooseLaunchLane(config, items, laneTargets);
    if (!launch) {
      break;
    }

    const started = startDispatcherItem(config, stateDir, next, launch, laneTargets);
    if (!started) {
      break;
    }
  }

  serviceState.lanes = buildDispatcherLaneState(config, laneTargets);
  serviceState.items = items;
  saveServiceState(stateDir, config.repo.key, "dispatcher", serviceState);
  const laneSummary = getDispatcherLanes(config)
    .map((lane) => `${lane.key}=${laneTargets[lane.key] ?? 0}`)
    .join(" ");
  appendServiceLog(
    stateDir,
    config.repo.key,
    "dispatcher",
    `queue=${issues.length} open_prs=${prs.length} ${laneSummary} issues=${issueQueue.source} prs=${prQueue.source}`
  );
  persistDispatcherSummary(config, stateDir);
}

function runValidatorRole(config, stateDir) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  clearRecoveredFailureState(repoState);
  const controlState = loadControlState(stateDir, config.repo.key);
  const serviceState = loadServiceState(stateDir, config.repo.key, "validator");
  serviceState.sessionStartedAt = PROCESS_STARTED_AT;
  const serviceEnabled = roleEnabled(config, controlState, "validator");
  serviceState.enabled = serviceEnabled;
  serviceState.alive = serviceEnabled;
  serviceState.prs = serviceState.prs ?? {};

  if (!serviceEnabled) {
    serviceState.summary = "validator disabled";
    persistRoleState(stateDir, config.repo.key, "validator", repoState, serviceState);
    return;
  }

  if (config.safety.require_clean_worktree_before_run) {
    ensureCleanWorktree(config.repo.workspace_dir);
  }

  const { prs, source } = loadOpenPullRequestsForLocalServices(config, stateDir, "validator");
  const servicePaths = buildServicePaths(stateDir, config.repo.key, "validator");
  fs.mkdirSync(servicePaths.worktreeRoot, { recursive: true });
  fs.mkdirSync(servicePaths.runLogRoot, { recursive: true });
  maybeRunServiceGarbageCollection(config, stateDir, "validator", servicePaths, {
    worktreeMaxAgeHours: 0
  });

  let completed = 0;
  let scheduled = 0;
  let waitingRetry = 0;
  const now = Date.now();
  serviceState.summary = `starting validation sweep for ${prs.length} PR(s) from ${source}`;
  serviceState.progress = {
    phase: "starting",
    source,
    total: prs.length,
    scheduled: 0,
    completed: 0,
    waitingRetry: 0,
    currentPrNumber: null
  };
  persistRoleState(stateDir, config.repo.key, "validator", repoState, serviceState);
  for (const pr of prs) {
    if (scheduled >= config.validation.max_concurrent) {
      break;
    }

    const existing = serviceState.prs[pr.number];
    if (existing?.sha === pr.headRefOid && existing?.result === "success") {
      continue;
    }
    if (existing?.sha === pr.headRefOid && retryWindowStillActive(existing, now)) {
      waitingRetry += 1;
      serviceState.prs[pr.number] = {
        ...existing,
        remediation_status: "retry_waiting"
      };
      continue;
    }

    scheduled += 1;
    serviceState.summary = `validating PR #${pr.number} (${scheduled}/${Math.min(prs.length, config.validation.max_concurrent)})`;
    serviceState.progress = {
      phase: "running",
      source,
      total: prs.length,
      scheduled,
      completed,
      waitingRetry,
      currentPrNumber: pr.number
    };
    persistRoleState(stateDir, config.repo.key, "validator", repoState, serviceState);

    const runLog = path.join(
      servicePaths.runLogRoot,
      `pr-${pr.number}-${safeSlug(pr.headRefOid.slice(0, 12))}.log`
    );
    const worktree = preparePullRequestWorktree({
      repoDir: config.repo.workspace_dir,
      worktreeRoot: servicePaths.worktreeRoot,
      prNumber: pr.number,
      baseBranch: pr.baseRefName ?? config.branches.pr_base_branch,
      headRefName: pr.headRefName,
      headRepository: pr.headRepository ?? null,
      headRepositoryOwner: pr.headRepositoryOwner ?? null,
      repoSlug: config.repo.github_slug
    });
    const cwd = config.validation.working_directory
      ? path.join(worktree, config.validation.working_directory)
      : worktree;
    const lastAttemptAt = new Date().toISOString();
    serviceState.prs[pr.number] = {
      ...(existing ?? {}),
      title: pr.title,
      sha: pr.headRefOid,
      branch: pr.headRefName,
      run_log: runLog,
      result: "pending",
      updated_at: lastAttemptAt,
      last_attempt_at: lastAttemptAt,
      next_retry_at: null,
      failure_count: existing?.sha === pr.headRefOid && existing?.result === "failure"
        ? Number(existing.failure_count ?? 0)
        : 0,
      remediation_status: "retry_running",
      failure_summary: null,
      error: null
    };
    persistRoleState(stateDir, config.repo.key, "validator", repoState, serviceState);

    try {
      for (const command of config.validation.bootstrap_commands ?? []) {
        const stepLog = `${runLog}.${safeSlug(command)}.tmp`;
        const output = runCommandToFile(command, {
          cwd,
          logPath: stepLog,
          env: { AE_PR_BASE_BRANCH: config.branches.pr_base_branch }
        });
        fs.appendFileSync(runLog, `${command}\n${output}\n\n`);
        fs.rmSync(stepLog, { force: true });
      }
      for (const command of config.validation.commands) {
        const stepLog = `${runLog}.${safeSlug(command)}.tmp`;
        const output = runCommandToFile(command, {
          cwd,
          logPath: stepLog,
          env: { AE_PR_BASE_BRANCH: config.branches.pr_base_branch }
        });
        fs.appendFileSync(runLog, `${command}\n${output}\n\n`);
        fs.rmSync(stepLog, { force: true });
      }
      serviceState.prs[pr.number] = createServicePrRecord({
        existing,
        pr,
        result: "success",
        runLog,
        lastAttemptAt
      });
      completed += 1;

      if (config.validation.post_status) {
        postCommitStatus(config, pr.headRefOid, {
          state: "success",
          context: config.validation.context,
          description: "local validator passed",
          target_url: ""
        });
      }
    } catch (error) {
      serviceState.prs[pr.number] = createServicePrRecord({
        existing,
        pr,
        result: "failure",
        runLog,
        error: error.message,
        lastAttemptAt
      });

      if (config.validation.post_status) {
        postCommitStatus(config, pr.headRefOid, {
          state: "failure",
          context: config.validation.context,
          description: "local validator failed",
          target_url: ""
        });
      }

      if (error.output) {
        fs.appendFileSync(
          runLog,
          `${error.command ?? "failed-command"}\n${String(error.output).trim()}\n\n`
        );
      }

      recordRemediationFailure(repoState, {
        service: "validator",
        prNumber: pr.number,
        sha: pr.headRefOid,
        branch: pr.headRefName,
        headRepository: pr.headRepository ?? null,
        headRepositoryOwner: pr.headRepositoryOwner ?? null,
        failureSummary: summarizeFailure(error, "local validator failed"),
        runLog,
        status: "open",
        isCrossRepository: pr.isCrossRepository ?? false,
        maintainerCanModify: pr.maintainerCanModify ?? null
      });

      appendServiceLog(stateDir, config.repo.key, "validator", `pr #${pr.number} failed: ${error.message}`);
    } finally {
      persistRoleState(stateDir, config.repo.key, "validator", repoState, serviceState);
    }
  }

  serviceState.summary = `checked ${completed} PR(s), ${scheduled} scheduled from ${source}`;
  serviceState.progress = {
    phase: "complete",
    source,
    total: prs.length,
    scheduled,
    completed,
    waitingRetry,
    currentPrNumber: null
  };
  if (waitingRetry > 0) {
    serviceState.summary += `, ${waitingRetry} waiting for retry`;
  }
  persistRoleState(stateDir, config.repo.key, "validator", repoState, serviceState);
}

function buildReviewerPrompt(config) {
  if (!config.reviewer.instructions_path || !fs.existsSync(config.reviewer.instructions_path)) {
    return "Review this PR for bugs, regressions, risky assumptions, and missing tests.";
  }
  return fs.readFileSync(config.reviewer.instructions_path, "utf8");
}

// The reviewer's prose used to be purely advisory: whatever it wrote got
// posted as a comment, but the PR's tracked result was "success" as soon as
// the model call completed, regardless of what the review said -- a
// "don't merge this" comment never actually blocked a merge. Requiring a
// machine-parseable verdict line closes that gap; see the schema-conformance
// incident this was written to fix.
const REVIEWER_VERDICT_INSTRUCTION =
  'End your review with exactly one line of the form "VERDICT: APPROVE" or "VERDICT: REQUEST_CHANGES" (uppercase, no other text on that line). Use REQUEST_CHANGES if there are any actionable bugs, regressions, missing required elements, or schema/format violations. Use APPROVE only if there are none.';

function parseReviewerVerdict(output) {
  const match = /VERDICT:\s*(APPROVE|REQUEST_CHANGES)\b/i.exec(String(output ?? ""));
  // Fail closed: an unparseable or missing verdict is treated the same as
  // REQUEST_CHANGES, not as a silent pass.
  return match ? match[1].toUpperCase() : "REQUEST_CHANGES";
}

function extractReviewerOutput(result) {
  const stdout = String(result.stdout ?? "").trim();
  if (stdout) {
    return stdout;
  }

  const stderr = String(result.stderr ?? "");
  const marker = "\ncodex\n";
  const markerIndex = stderr.lastIndexOf(marker);
  if (markerIndex !== -1) {
    const extracted = stderr
      .slice(markerIndex + marker.length)
      .split("\n")
      .filter((line) => !/^\d{4}-\d{2}-\d{2}T.*\s(?:WARN|ERROR)\s/.test(line))
      .join("\n")
      .trim();
    if (extracted) {
      return extracted;
    }
  }

  return stderr.trim() || "No review findings produced.";
}

function runReviewerCodexExec({ worktree, baseBranch, model, reasoningEffort, reviewPrompt, logPath, env }) {
  const prompt = [
    `Review the current branch against origin/${baseBranch}.`,
    reviewPrompt.trim(),
    "Output requirements:",
    "- Return concise markdown suitable for a GitHub pull request comment.",
    "- Prioritize actionable bugs, regressions, risky assumptions, and missing tests.",
    "- If there are no actionable findings, say so explicitly."
  ].join("\n\n");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    model,
    "-c",
    `model_reasoning_effort=${reasoningEffort}`,
    "-C",
    worktree,
    prompt
  ];

  const result = spawnSync("codex", args, {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
    env
  });

  fs.appendFileSync(logPath, `\n$ codex ${args.join(" ")}\n`);
  if (result.stdout) {
    fs.appendFileSync(logPath, result.stdout);
  }
  if (result.stderr) {
    fs.appendFileSync(logPath, `\n[stderr]\n${result.stderr}\n`);
  }

  if (result.status !== 0) {
    const error = new Error(`codex review failed with exit code ${result.status}`);
    error.output = extractReviewerOutput(result);
    throw error;
  }

  return extractReviewerOutput(result);
}

function runReviewerCodexExecAsync({ worktree, baseBranch, model, reasoningEffort, reviewPrompt, logPath, env }) {
  const prompt = [
    `Review the current branch against origin/${baseBranch}.`,
    reviewPrompt.trim(),
    "Output requirements:",
    "- Return concise markdown suitable for a GitHub pull request comment.",
    "- Prioritize actionable bugs, regressions, risky assumptions, and missing tests.",
    "- If there are no actionable findings, say so explicitly.",
    `- ${REVIEWER_VERDICT_INSTRUCTION}`
  ].join("\n\n");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    model,
    "-c",
    `model_reasoning_effort=${reasoningEffort}`,
    "-C",
    worktree,
    prompt
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: worktree,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      fs.appendFileSync(logPath, `\n$ codex ${args.join(" ")}\n`);
      if (stdout) {
        fs.appendFileSync(logPath, stdout);
      }
      if (stderr) {
        fs.appendFileSync(logPath, `\n[stderr]\n${stderr}\n`);
      }
      reject(error);
    });
    child.on("close", (code) => {
      fs.appendFileSync(logPath, `\n$ codex ${args.join(" ")}\n`);
      if (stdout) {
        fs.appendFileSync(logPath, stdout);
      }
      if (stderr) {
        fs.appendFileSync(logPath, `\n[stderr]\n${stderr}\n`);
      }

      if (code !== 0) {
        const error = new Error(`codex review failed with exit code ${code}`);
        error.output = extractReviewerOutput({ stdout, stderr });
        reject(error);
        return;
      }

      resolve(extractReviewerOutput({ stdout, stderr }));
    });
  });
}

// codex exec gets its own filesystem access to the worktree (-C worktree)
// and inspects the diff itself; a plain chat-completions call has no repo
// access at all, so the diff has to be gathered here and embedded directly
// in the prompt instead.
async function runReviewerOpenAiCompatibleAsync({ worktree, baseBranch, model, reviewPrompt, logPath, runtimeEndpoint, apiKey }) {
  const diffResult = spawnSync(
    "git",
    ["diff", `origin/${baseBranch}...HEAD`],
    { cwd: worktree, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  const diff = String(diffResult.stdout ?? "").slice(0, 60000);

  const prompt = [
    `Review the current branch against origin/${baseBranch}.`,
    `Today's actual date is ${new Date().toISOString().slice(0, 10)} (UTC). Use this as "today" for any date reasoning. Do NOT rely on your own notion of the current date, and do NOT flag a date that is today or earlier as a "future date" error.`,
    reviewPrompt.trim(),
    "Scope of your review:",
    "- Structural/mechanical checks (schema shape, required fields, field placement, date-field validity, URL reachability, count/length thresholds, etc.) are already checked mechanically and authoritatively by the repo's own validation script, if it has one. Do NOT report any of these -- you cannot see that script's result and you will produce false positives. Never claim a field/section is \"extraneous\" or \"not in the schema\" (a contract shape is a minimum, not exhaustive), and never flag something as \"too few\" or \"below the required minimum\" -- counts are the validator's job, not yours.",
    "- Review ONLY semantic content quality that a mechanical check cannot judge: is the domain-specific content genuinely specific to this task's context (not generic boilerplate); are any cited sources/references topically appropriate and real; is anything stated factually wrong or internally contradictory; is the scope coherent. Judge the QUALITY of what is present, never the QUANTITY.",
    "Output requirements:",
    "- Return concise markdown suitable for a GitHub pull request comment.",
    "- Only REQUEST_CHANGES for a genuine semantic-content problem of the kind above. If the content is topically sound, APPROVE even if you would have written it differently.",
    "- If there are no actionable findings, say so explicitly.",
    `- ${REVIEWER_VERDICT_INSTRUCTION}`,
    "",
    "Diff to review:",
    "```diff",
    diff || "(no diff content captured)",
    "```"
  ].join("\n\n");

  const endpoint = String(runtimeEndpoint ?? "").replace(/\/+$/, "");
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 4000
    })
  });
  const text = await response.text();
  fs.appendFileSync(logPath, `\n$ POST ${endpoint}/chat/completions (model=${model})\n`);
  if (!response.ok) {
    fs.appendFileSync(logPath, `\n[http ${response.status}]\n${text.slice(0, 2000)}\n`);
    throw new Error(`openai-compatible review request failed: ${response.status} ${response.statusText}`);
  }
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    fs.appendFileSync(logPath, `\n[response was not valid JSON]\n${text.slice(0, 2000)}\n`);
    throw new Error("openai-compatible review response was not valid JSON");
  }
  const output = String(body?.choices?.[0]?.message?.content ?? "").trim();
  fs.appendFileSync(logPath, `\n${output}\n`);
  if (!output) {
    throw new Error("openai-compatible review returned an empty response");
  }
  return output;
}

function reviewerPostFailureIsNonBlocking(errorOrMessage) {
  const message = String(errorOrMessage?.message ?? errorOrMessage ?? "");
  return /\bgh\s+pr\s+(comment|review)\b/.test(message);
}

async function runReviewerRole(config, stateDir) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  clearRecoveredFailureState(repoState);
  const controlState = loadControlState(stateDir, config.repo.key);
  const serviceState = loadServiceState(stateDir, config.repo.key, "reviewer");
  serviceState.sessionStartedAt = PROCESS_STARTED_AT;
  const serviceEnabled = roleEnabled(config, controlState, "reviewer");
  serviceState.enabled = serviceEnabled;
  serviceState.alive = serviceEnabled;
  serviceState.prs = serviceState.prs ?? {};

  if (!serviceEnabled) {
    serviceState.summary = "reviewer disabled";
    persistRoleState(stateDir, config.repo.key, "reviewer", repoState, serviceState);
    return;
  }

  const reviewerIsOpenAiCompatible = config.models.reviewer.provider === "openai_compatible";
  if (!reviewerIsOpenAiCompatible && !commandExists("codex")) {
    throw new Error("codex CLI is not available");
  }
  if (reviewerIsOpenAiCompatible && !config.models.reviewer.runtime_endpoint) {
    throw new Error("models.reviewer.runtime_endpoint is required when provider is openai_compatible");
  }

  const { prs, source } = loadOpenPullRequestsForLocalServices(config, stateDir, "reviewer");
  const servicePaths = buildServicePaths(stateDir, config.repo.key, "reviewer");
  fs.mkdirSync(servicePaths.worktreeRoot, { recursive: true });
  fs.mkdirSync(servicePaths.runLogRoot, { recursive: true });
  fs.mkdirSync(servicePaths.outputRoot, { recursive: true });
  maybeRunServiceGarbageCollection(config, stateDir, "reviewer", servicePaths, {
    worktreeMaxAgeHours: 0,
    includeOutputs: true
  });
  const prompt = buildReviewerPrompt(config);
  let completed = 0;
  let scheduled = 0;
  let waitingRetry = 0;
  const now = Date.now();
  serviceState.summary = `starting review sweep for ${prs.length} PR(s) from ${source}`;
  serviceState.progress = {
    phase: "starting",
    source,
    total: prs.length,
    scheduled: 0,
    completed: 0,
    waitingRetry: 0,
    currentPrNumber: null
  };
  persistRoleState(stateDir, config.repo.key, "reviewer", repoState, serviceState);
  const reviewTasks = [];
  for (const pr of prs) {
    if (scheduled >= config.reviewer.max_concurrent) {
      break;
    }

    const existing = serviceState.prs[pr.number];
    if (existing?.sha === pr.headRefOid && existing?.result === "success") {
      continue;
    }
    if (
      existing?.sha === pr.headRefOid &&
      existing?.result === "failure" &&
      reviewerPostFailureIsNonBlocking(existing.error) &&
      existing.output_path &&
      fs.existsSync(existing.output_path)
    ) {
      serviceState.prs[pr.number] = {
        ...existing,
        result: "success",
        error: null,
        failure_summary: null,
        next_retry_at: null,
        remediation_status: "none",
        post_error: existing.error
      };
      completed += 1;
      persistRoleState(stateDir, config.repo.key, "reviewer", repoState, serviceState);
      continue;
    }
    if (existing?.sha === pr.headRefOid && retryWindowStillActive(existing, now)) {
      waitingRetry += 1;
      serviceState.prs[pr.number] = {
        ...existing,
        remediation_status: "retry_waiting"
      };
      continue;
    }

    scheduled += 1;
    serviceState.summary = `reviewing PR #${pr.number} (${scheduled}/${Math.min(prs.length, config.reviewer.max_concurrent)})`;
    serviceState.progress = {
      phase: "running",
      source,
      total: prs.length,
      scheduled,
      completed,
      waitingRetry,
      currentPrNumber: pr.number
    };
    persistRoleState(stateDir, config.repo.key, "reviewer", repoState, serviceState);

    const worktree = preparePullRequestWorktree({
      repoDir: config.repo.workspace_dir,
      worktreeRoot: servicePaths.worktreeRoot,
      prNumber: pr.number,
      baseBranch: pr.baseRefName ?? config.branches.pr_base_branch,
      headRefName: pr.headRefName,
      headRepository: pr.headRepository ?? null,
      headRepositoryOwner: pr.headRepositoryOwner ?? null,
      repoSlug: config.repo.github_slug
    });
    const runLog = path.join(
      servicePaths.runLogRoot,
      `pr-${pr.number}-${safeSlug(pr.headRefOid.slice(0, 12))}.log`
    );
    const outputPath = path.join(
      servicePaths.outputRoot,
      `pr-${pr.number}-${safeSlug(pr.headRefOid.slice(0, 12))}.md`
    );
    const codexHome = reviewerIsOpenAiCompatible
      ? null
      : prepareIsolatedCodexHome(`commons-devloop-reviewer-pr-${pr.number}-`);
    const lastAttemptAt = new Date().toISOString();
    serviceState.prs[pr.number] = {
      ...(existing ?? {}),
      title: pr.title,
      sha: pr.headRefOid,
      branch: pr.headRefName,
      run_log: runLog,
      output_path: outputPath,
      result: "pending",
      updated_at: lastAttemptAt,
      last_attempt_at: lastAttemptAt,
      next_retry_at: null,
      failure_count: existing?.sha === pr.headRefOid && existing?.result === "failure"
        ? Number(existing.failure_count ?? 0)
        : 0,
      remediation_status: "retry_running",
      failure_summary: null,
      error: null,
      model: config.models.reviewer.name,
      reasoning_effort: config.models.reviewer.reasoning_effort
    };
    persistRoleState(stateDir, config.repo.key, "reviewer", repoState, serviceState);

    const reviewTask = reviewerIsOpenAiCompatible
      ? runReviewerOpenAiCompatibleAsync({
          worktree,
          baseBranch: pr.baseRefName ?? config.branches.pr_base_branch,
          model: config.models.reviewer.name,
          reviewPrompt: prompt,
          logPath: runLog,
          runtimeEndpoint: config.models.reviewer.runtime_endpoint,
          apiKey: resolveLaneApiKey(stateDir, config.repo.key, {
            key: "reviewer",
            api_key_env: config.models.reviewer.api_key_env
          })
        })
      : runReviewerCodexExecAsync({
          worktree,
          baseBranch: pr.baseRefName ?? config.branches.pr_base_branch,
          model: config.models.reviewer.name,
          reasoningEffort: config.models.reviewer.reasoning_effort,
          reviewPrompt: prompt,
          logPath: runLog,
          env: {
            ...process.env,
            CODEX_HOME: codexHome
          }
        });

    reviewTasks.push(
      reviewTask
        .then((output) => {
          fs.writeFileSync(outputPath, `${output}\n`);

          let postError = null;
          try {
            if (config.reviewer.post_mode === "comment") {
              postPullRequestComment(config, pr.number, outputPath);
            } else if (config.reviewer.post_mode === "review") {
              postPullRequestReview(config, pr.number, outputPath);
            }
          } catch (error) {
            if (!reviewerPostFailureIsNonBlocking(error)) {
              throw error;
            }
            postError = error;
            appendServiceLog(
              stateDir,
              config.repo.key,
              "reviewer",
              `pr #${pr.number} review output generated but posting failed: ${error.message}`
            );
          }

          const verdict = parseReviewerVerdict(output);
          if (verdict === "REQUEST_CHANGES") {
            const firstLine = output.split("\n").map((line) => line.trim()).find(Boolean) ?? "reviewer requested changes";
            const error = new Error(`reviewer requested changes: ${firstLine}`);
            error.output = output;
            throw error;
          }

          const record = createServicePrRecord({
            existing,
            pr,
            result: "success",
            runLog,
            outputPath,
            model: config.models.reviewer.name,
            reasoningEffort: config.models.reviewer.reasoning_effort,
            lastAttemptAt
          });
          if (postError) {
            record.post_error = postError.message;
          }
          serviceState.prs[pr.number] = record;
          completed += 1;
        })
        .catch((error) => {
          serviceState.prs[pr.number] = createServicePrRecord({
            existing,
            pr,
            result: "failure",
            runLog,
            outputPath,
            error: error.message,
            model: config.models.reviewer.name,
            reasoningEffort: config.models.reviewer.reasoning_effort,
            lastAttemptAt
          });
          recordRemediationFailure(repoState, {
            service: "reviewer",
            prNumber: pr.number,
            sha: pr.headRefOid,
            branch: pr.headRefName,
            headRepository: pr.headRepository ?? null,
            headRepositoryOwner: pr.headRepositoryOwner ?? null,
            failureSummary: summarizeFailure(error, "local reviewer failed"),
            runLog,
            status: "open",
            isCrossRepository: pr.isCrossRepository ?? false,
            maintainerCanModify: pr.maintainerCanModify ?? null
          });
          appendServiceLog(stateDir, config.repo.key, "reviewer", `pr #${pr.number} failed: ${error.message}`);
        })
        .finally(() => {
          syncCodexSessionHistory(codexHome);
          cleanupIsolatedCodexHome(codexHome);
          persistRoleState(stateDir, config.repo.key, "reviewer", repoState, serviceState);
        })
    );
  }

  await Promise.allSettled(reviewTasks);

  serviceState.summary = `reviewed ${completed} PR(s), ${scheduled} scheduled from ${source}`;
  serviceState.progress = {
    phase: "complete",
    source,
    total: prs.length,
    scheduled,
    completed,
    waitingRetry,
    currentPrNumber: null
  };
  if (waitingRetry > 0) {
    serviceState.summary += `, ${waitingRetry} waiting for retry`;
  }
  persistRoleState(stateDir, config.repo.key, "reviewer", repoState, serviceState);
}

function runRunnerManagerRole(config, stateDir) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  clearRecoveredFailureState(repoState);
  const controlState = loadControlState(stateDir, config.repo.key);
  const serviceState = loadServiceState(stateDir, config.repo.key, "runner-manager");
  serviceState.sessionStartedAt = PROCESS_STARTED_AT;
  const serviceEnabled = roleEnabled(config, controlState, "runner-manager");
  serviceState.enabled = serviceEnabled;
  serviceState.alive = serviceEnabled;

  if (!serviceEnabled) {
    serviceState.summary = "runner-manager disabled";
    saveServiceState(stateDir, config.repo.key, "runner-manager", serviceState);
    updateRepoStateService(repoState, "runner-manager", serviceState);
    saveRepoState(stateDir, config.repo.key, repoState);
    return;
  }

  const queuedJobs = listQueuedWorkflowJobs(config);
  let containers = [];
  let dockerAvailable = false;
  if (commandExists("docker")) {
    dockerAvailable = true;
    try {
      const raw = runCommand(
        `docker ps --format '{{json .}}' --filter name=${JSON.stringify(config.runner_manager.container_prefix)}`
      );
      containers = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      containers = [];
    }
  }

  serviceState.summary = `${queuedJobs.length} queued job(s), ${containers.length} runner container(s)`;
  serviceState.queuedJobs = queuedJobs.map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    event: job.event,
    head_branch: job.head_branch
  }));
  serviceState.containers = containers;
  serviceState.dryRun = config.runner_manager.dry_run;
  serviceState.dockerAvailable = dockerAvailable;
  saveServiceState(stateDir, config.repo.key, "runner-manager", serviceState);
  updateRepoStateService(repoState, "runner-manager", serviceState);
  saveRepoState(stateDir, config.repo.key, repoState);
}

function runPrManagerRole(config, stateDir) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  clearRecoveredFailureState(repoState);
  const controlState = loadControlState(stateDir, config.repo.key);
  const serviceState = loadServiceState(stateDir, config.repo.key, "pr-manager");
  serviceState.sessionStartedAt = PROCESS_STARTED_AT;
  const serviceEnabled = roleEnabled(config, controlState, "pr-manager");
  serviceState.enabled = serviceEnabled;
  serviceState.alive = serviceEnabled;

  if (!serviceEnabled) {
    serviceState.summary = "pr-manager disabled";
    saveServiceState(stateDir, config.repo.key, "pr-manager", serviceState);
    updateRepoStateService(repoState, "pr-manager", serviceState);
    saveRepoState(stateDir, config.repo.key, repoState);
    return;
  }

  try {
    assertNoAutoTriggeredGithubActions(config);
  } catch (error) {
    serviceState.enabled = false;
    serviceState.alive = false;
    serviceState.summary = error.message;
    appendServiceLog(stateDir, config.repo.key, "pr-manager", error.message);
    saveServiceState(stateDir, config.repo.key, "pr-manager", serviceState);
    updateRepoStateService(repoState, "pr-manager", serviceState);
    saveRepoState(stateDir, config.repo.key, repoState);
    return;
  }

  const previousOpenPrs = loadPullRequestQueueState(stateDir, config.repo.key).prs;
  const previousMergedPrs = Array.isArray(serviceState.mergedPrs) ? serviceState.mergedPrs : [];
  let prs = previousOpenPrs;
  let merged = previousMergedPrs;
  let queueSource = "cache";
  const validatorState = loadServiceState(stateDir, config.repo.key, "validator");
  const reviewerState = loadServiceState(stateDir, config.repo.key, "reviewer");

  try {
    prs = listOpenPullRequests(config).map((pr) => normalizePullRequestRecord(pr));
    merged = getMergedPullRequests(config, 5);
    queueSource = "github";
    serviceState.lastSyncAt = new Date().toISOString();
    serviceState.lastSyncError = null;
  } catch (error) {
    serviceState.lastSyncError = error.message;
    appendServiceLog(
      stateDir,
      config.repo.key,
      "pr-manager",
      `GitHub PR sync failed; using cached queue: ${error.message}`
    );
  }

  const autoClosed = queueSource === "github"
    ? closeSupersededConflictPullRequests(config, stateDir, prs)
    : [];
  const autoClosedPrNumbers = new Set(autoClosed.map((entry) => Number(entry.number)));
  if (autoClosedPrNumbers.size > 0) {
    prs = prs.filter((pr) => !autoClosedPrNumbers.has(Number(pr.number)));
  }

  const evaluatedPrs = prs.map((pr) => ({
    ...pr,
    localGate: evaluatePullRequestReadiness(config, pr, validatorState, reviewerState, {
      formatFailureReason: formatRetryReason
    })
  }));
  const prActions = selectPrManagerActions(config, evaluatedPrs);
  const mergeable = prActions.mergeable;
  const updatable = prActions.updatable;
  const mergedNow = [...autoClosed];

  for (const pr of prActions.updateBatch) {
    try {
      updatePullRequestBranch(config, pr.number);
      mergedNow.push({
        number: pr.number,
        action: "update_branch",
        at: new Date().toISOString()
      });
      appendServiceLog(stateDir, config.repo.key, "pr-manager", `updated branch for #${pr.number}`);
    } catch (error) {
      appendServiceLog(stateDir, config.repo.key, "pr-manager", `branch update failed for #${pr.number}: ${error.message}`);
    }
  }

  if (prActions.pauseMergesForUpdates) {
    appendServiceLog(
      stateDir,
      config.repo.key,
      "pr-manager",
      `deferred merges while syncing ${prActions.updateBatch.length} behind branch(es)`
    );
  }

  for (const pr of prActions.mergeBatch) {
    try {
      mergePullRequest(config, pr.number);
      const linkedIssueNumber = extractIssueNumberFromBranch(config, pr.headRefName);
      if (linkedIssueNumber != null) {
        if (config.lifecycle.target_mode === "backlog_file") {
          try {
            const result = markBacklogIssueDone(config, linkedIssueNumber);
            appendServiceLog(
              stateDir,
              config.repo.key,
              "pr-manager",
              result?.changed
                ? `marked ${result.issueId} done after merging PR #${pr.number}`
                : `backlog item #${linkedIssueNumber} already done after merging PR #${pr.number}`
            );
          } catch (error) {
            appendServiceLog(
              stateDir,
              config.repo.key,
              "pr-manager",
              `backlog mark-done failed for #${linkedIssueNumber} after merging PR #${pr.number}: ${error.message}`
            );
          }
        } else {
          try {
            closeIssue(
              config,
              linkedIssueNumber,
              `Closed automatically after local merge of PR #${pr.number}.`
            );
          } catch (error) {
            appendServiceLog(
              stateDir,
              config.repo.key,
              "pr-manager",
              `issue close failed for #${linkedIssueNumber} after merging PR #${pr.number}: ${error.message}`
            );
          }
        }
      }
      mergedNow.push({
        number: pr.number,
        action: "merged",
        at: new Date().toISOString()
      });
      appendServiceLog(stateDir, config.repo.key, "pr-manager", `merged #${pr.number} from local gate`);
    } catch (error) {
      appendServiceLog(stateDir, config.repo.key, "pr-manager", `merge failed for #${pr.number}: ${error.message}`);
    }
  }

  const mergedPrNumbers = new Set(
    mergedNow
      .filter((entry) => entry.action === "merged")
      .map((entry) => Number(entry.number))
      .filter((value) => Number.isInteger(value))
  );
  const remainingOpenPrs = mergedPrNumbers.size > 0
    ? prs.filter((pr) => !mergedPrNumbers.has(Number(pr.number)))
    : prs;
  const remainingEvaluatedPrs = mergedPrNumbers.size > 0
    ? evaluatedPrs.filter((pr) => !mergedPrNumbers.has(Number(pr.number)))
    : evaluatedPrs;

  const blocked = remainingEvaluatedPrs.filter((pr) => pr.localGate.readiness === "blocked").length;
  const waiting = remainingEvaluatedPrs.filter((pr) => pr.localGate.readiness === "waiting").length;
  serviceState.summary =
    `${remainingOpenPrs.length} open PR(s), ${Math.max(0, mergeable.length - mergedPrNumbers.size)} locally mergeable, ${updatable.length} behind, ${waiting} waiting, ${blocked} blocked locally`;
  storePullRequestQueueState(serviceState, remainingOpenPrs, {
    source: queueSource,
    lastSyncAt: serviceState.lastSyncAt ?? null,
    lastSyncError: serviceState.lastSyncError ?? null
  });
  serviceState.mergedPrs = merged;
  serviceState.progress = {
    source: queueSource,
    open: remainingOpenPrs.length,
    mergeable: Math.max(0, mergeable.length - mergedPrNumbers.size),
    waiting,
    blocked,
    updateBranch: updatable.length
  };
  serviceState.localGate = {
    mergeable: remainingEvaluatedPrs
      .filter((pr) => pr.localGate.readiness === "merge")
      .map((pr) => pr.number),
    waiting: remainingEvaluatedPrs
      .filter((pr) => pr.localGate.readiness === "waiting")
      .map((pr) => ({ number: pr.number, reason: pr.localGate.reason })),
    blocked: remainingEvaluatedPrs
      .filter((pr) => pr.localGate.readiness === "blocked")
      .map((pr) => ({ number: pr.number, reason: pr.localGate.reason })),
    updateBranch: updatable.map((pr) => pr.number)
  };
  serviceState.lastActions = mergedNow;
  saveServiceState(stateDir, config.repo.key, "pr-manager", serviceState);
  updateRepoStateService(repoState, "pr-manager", serviceState);
  saveRepoState(stateDir, config.repo.key, repoState);
}

function runMonitorRole(config, stateDir) {
  const repoState = loadRepoState(stateDir, config.repo.key);
  clearRecoveredFailureState(repoState);
  const controlState = loadControlState(stateDir, config.repo.key);
  const serviceState = loadServiceState(stateDir, config.repo.key, "monitor");
  serviceState.sessionStartedAt = PROCESS_STARTED_AT;
  const serviceEnabled = roleEnabled(config, controlState, "monitor");
  serviceState.enabled = serviceEnabled;
  serviceState.alive = serviceEnabled;

  if (!serviceEnabled) {
    serviceState.summary = "monitor disabled";
    saveServiceState(stateDir, config.repo.key, "monitor", serviceState);
    updateRepoStateService(repoState, "monitor", serviceState);
    saveRepoState(stateDir, config.repo.key, repoState);
    return;
  }

  serviceState.summary = `${Object.keys(repoState.services ?? {}).length} service snapshot(s)`;
  serviceState.repo = {
    status: repoState.status,
    pauseReason: repoState.pauseReason,
    lastTargetCheckAt: repoState.lastTargetCheckAt
  };
  serviceState.auth = {
    ghAuthenticated: checkGhAuth(),
    codexAvailable: commandExists("codex"),
    dockerAvailable: commandExists("docker")
  };
  saveServiceState(stateDir, config.repo.key, "monitor", serviceState);
  updateRepoStateService(repoState, "monitor", serviceState);
  saveRepoState(stateDir, config.repo.key, repoState);
}

function runRole(role, config, stateDir) {
  syncDerivedServiceConfigs(stateDir, config);
  const repoState = loadRepoState(stateDir, config.repo.key);
  const controlState = loadControlState(stateDir, config.repo.key);
  const pause = determineRepoPause(config, repoState, controlState);

  if (pause.paused && role !== "autonomous") {
    const serviceState = loadServiceState(stateDir, config.repo.key, role);
    serviceState.sessionStartedAt = PROCESS_STARTED_AT;
    serviceState.enabled = roleEnabled(config, controlState, role);
    serviceState.alive = serviceState.enabled;
    serviceState.summary = `repo paused: ${pause.reason}`;
    saveServiceState(stateDir, config.repo.key, role, serviceState);
    updateRepoStateService(repoState, role, serviceState);
    saveRepoState(stateDir, config.repo.key, {
      ...repoState,
      status: pause.status,
      pauseReason: pause.reason,
      lastRoleRunAt: new Date().toISOString()
    });
    return;
  }

  switch (role) {
    case "autonomous":
      runAutonomousRole(config, stateDir);
      return;
    case "dispatcher":
      runDispatcherRole(config, stateDir);
      return;
    case "validator":
      runValidatorRole(config, stateDir);
      return;
    case "reviewer":
      return runReviewerRole(config, stateDir);
    case "runner-manager":
      runRunnerManagerRole(config, stateDir);
      return;
    case "pr-manager":
      runPrManagerRole(config, stateDir);
      return;
    case "monitor":
      runMonitorRole(config, stateDir);
      return;
    default:
      throw new Error(`Unhandled role: ${role}`);
  }
}

async function main() {
  const { role } = parseArgs();
  const configPath = resolveConfigPath();
  const stateDir = process.env.AE_STATE_DIR ?? "/engine/state";
  const mode = process.env.AE_MODE ?? "loop";
  const overrideIntervalSeconds = getLoopIntervalOverrideSeconds(role);

  if (mode === "once") {
    const config = loadConfig(configPath);
    await ensureGithubAppAuth();
    await runRole(role, config, stateDir);
    return;
  }

  while (true) {
    try {
      const config = loadConfig(configPath);
      await ensureGithubAppAuth();
      await runRole(role, config, stateDir);
      const intervalSeconds = Number.isFinite(overrideIntervalSeconds) && overrideIntervalSeconds > 0
        ? overrideIntervalSeconds
        : computeActiveLoopIntervalSeconds(role, config, stateDir);
      await sleep(intervalSeconds * 1000);
    } catch (error) {
      let repoKey = "unknown";
      try {
        const config = loadConfig(configPath);
        repoKey = config.repo.key;
        const repoState = loadRepoState(stateDir, repoKey);
        repoState.status = "failed_attention_needed";
        repoState.pauseReason = `${role} failed: ${error.message}`;
        saveRepoState(stateDir, repoKey, repoState);
        appendServiceLog(stateDir, repoKey, role, `fatal error: ${error.message}`);
      } catch {}
      log("error", "role execution failed", { role, repoKey, error: error.message });
      const fallbackIntervalSeconds =
        Number.isFinite(overrideIntervalSeconds) && overrideIntervalSeconds > 0
          ? overrideIntervalSeconds
          : 30;
      await sleep(fallbackIntervalSeconds * 1000);
    }
  }
}

main().catch((error) => {
  log("error", "engine role startup failed", { error: error.message });
  process.exitCode = 1;
});
