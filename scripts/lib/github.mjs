import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const DEFAULT_GH_TIMEOUT_MS = Number(process.env.AE_GH_TIMEOUT_MS ?? 15000);
const DEFAULT_GH_RETRY_COUNT = Number(process.env.AE_GH_RETRY_COUNT ?? 3);
const DEFAULT_ISSUE_LIST_LIMIT = Number(process.env.AE_ISSUE_LIST_LIMIT ?? 1000);
const DEFAULT_PR_LIST_LIMIT = Number(process.env.AE_PR_LIST_LIMIT ?? 1000);
const DEFAULT_BACKLOG_FILE_SYNC_INTERVAL_MS = Number(process.env.AE_BACKLOG_FILE_SYNC_INTERVAL_MS ?? 30000);
const backlogFileSyncByWorkspace = new Map();
const TRANSIENT_GH_PATTERNS = [
  "ETIMEDOUT",
  "timed out",
  "TLS handshake timeout",
  "connection refused",
  "connection reset",
  "temporary failure",
  "network is unreachable",
  "i/o timeout"
];

function maybeSimulateGhFailure(args) {
  const primary = String(args?.[0] ?? "");
  const secondary = String(args?.[1] ?? "");

  if (process.env.AE_GH_FAIL_PR_LIST === "1" && primary === "pr" && secondary === "list") {
    throw new Error("Simulated gh pr list failure");
  }

  if (process.env.AE_GH_FAIL_ISSUE_LIST === "1" && primary === "issue" && secondary === "list") {
    throw new Error("Simulated gh issue list failure");
  }
}

function isTransientGhError(error) {
  const haystack = [
    error?.message,
    error?.stderr,
    error?.stdout
  ]
    .filter(Boolean)
    .join("\n");
  return TRANSIENT_GH_PATTERNS.some((pattern) => haystack.includes(pattern));
}

function gh(args, options = {}) {
  const { timeoutMs, retryCount, ...execOptions } = options;
  const finalTimeoutMs = timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  const finalRetryCount = retryCount ?? DEFAULT_GH_RETRY_COUNT;
  let lastError = null;

  maybeSimulateGhFailure(args);

  for (let attempt = 1; attempt <= finalRetryCount; attempt += 1) {
    try {
      return execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 20,
        timeout: finalTimeoutMs,
        ...execOptions
      }).trim();
    } catch (error) {
      lastError = error;
      if (!isTransientGhError(error) || attempt >= finalRetryCount) {
        throw error;
      }
    }
  }

  throw lastError;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 20,
    timeout: options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS,
    cwd: options.cwd
  }).trim();
}

function prepareBacklogWorkspaceGit(config) {
  const workspaceDir = String(config.repo.workspace_dir ?? "").trim();
  if (!workspaceDir) {
    return;
  }

  try {
    git(["config", "--global", "--add", "safe.directory", workspaceDir]);
  } catch {
    // Best-effort: the next git command will report the real failure if this matters.
  }

  try {
    gh(["auth", "setup-git"], { timeoutMs: 5000, retryCount: 1 });
  } catch {
    // Best-effort: read-only backlog operations and already-configured git remotes still work.
  }
}

function splitRepoSlug(githubSlug) {
  const [owner, repo] = String(githubSlug).split("/", 2);
  return { owner, repo };
}

function normalizePullRequestMetadata(pr) {
  if (!pr || typeof pr !== "object") {
    return pr;
  }

  return {
    ...pr,
    headRepository: pr.headRepository?.name ?? pr.headRepository ?? null,
    headRepositoryOwner: pr.headRepositoryOwner?.login ?? pr.headRepositoryOwner ?? null,
    isCrossRepository: Boolean(pr.isCrossRepository),
    maintainerCanModify: pr.maintainerCanModify == null ? null : Boolean(pr.maintainerCanModify)
  };
}

function matchesIssueFilters(config, issue) {
  const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => label.name) : [];

  if (config.lifecycle.target_mode === "milestone" && issue.milestone?.title !== config.lifecycle.target_name) {
    return false;
  }

  if (config.lifecycle.target_mode === "label" && !labels.includes(config.lifecycle.target_name)) {
    return false;
  }

  if (config.issue_source.labels.length > 0 && !config.issue_source.labels.every((label) => labels.includes(label))) {
    return false;
  }

  if (config.issue_source.required_issue_prefix && !String(issue.title).startsWith(config.issue_source.required_issue_prefix)) {
    return false;
  }

  if (
    config.issue_source.allow_manual_issue_numbers.length > 0 &&
    !config.issue_source.allow_manual_issue_numbers.includes(Number(issue.number))
  ) {
    return false;
  }

  if (config.dispatcher.skip_issue_numbers.includes(Number(issue.number))) {
    return false;
  }

  return true;
}

function resolveBacklogPath(config) {
  const targetName = String(config.lifecycle.target_name ?? "").trim();
  if (!targetName) {
    throw new Error("backlog_file target_name is required");
  }
  return path.isAbsolute(targetName)
    ? targetName
    : path.join(config.repo.workspace_dir, targetName);
}

function maybeSyncBacklogWorkspace(config, options = {}) {
  if (process.env.AE_BACKLOG_FILE_SYNC === "0") {
    return;
  }

  const workspaceDir = String(config.repo.workspace_dir ?? "").trim();
  const baseBranch = String(config.branches?.base_branch ?? "main").trim() || "main";
  if (!workspaceDir) {
    return;
  }
  prepareBacklogWorkspaceGit(config);

  const now = Date.now();
  const lastSync = backlogFileSyncByWorkspace.get(workspaceDir) ?? 0;
  if (!options.force && now - lastSync < DEFAULT_BACKLOG_FILE_SYNC_INTERVAL_MS) {
    return;
  }
  backlogFileSyncByWorkspace.set(workspaceDir, now);

  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspaceDir });
    if (branch !== baseBranch) {
      return;
    }

    if (git(["status", "--porcelain"], { cwd: workspaceDir })) {
      return;
    }

    git(["fetch", "origin", baseBranch], { cwd: workspaceDir });
    git(["merge", "--ff-only", `origin/${baseBranch}`], { cwd: workspaceDir });
  } catch {
    // Backlog-file reads must remain available even when the target checkout cannot sync.
  }
}

function updateBacklogIssueStatus(raw, issueNumber, nextStatus) {
  const lines = String(raw).split(/\r?\n/);
  const issueStart = lines.findIndex((line) => line.match(new RegExp(`^\\s*-\\s+sequence:\\s*${issueNumber}\\s*$`)));
  if (issueStart === -1) {
    throw new Error(`backlog_file issue not found in manifest: ${issueNumber}`);
  }

  let issueEnd = lines.length;
  for (let index = issueStart + 1; index < lines.length; index += 1) {
    if (/^\s*-\s+sequence:\s*\d+\s*$/.test(lines[index])) {
      issueEnd = index;
      break;
    }
  }

  let issueId = `issue-${issueNumber}`;
  let statusLine = -1;
  for (let index = issueStart; index < issueEnd; index += 1) {
    const idMatch = lines[index].match(/^\s+id:\s*(.+?)\s*$/);
    if (idMatch) {
      issueId = idMatch[1].trim();
    }
    if (/^\s+status:\s*/.test(lines[index])) {
      statusLine = index;
    }
  }

  if (statusLine === -1) {
    throw new Error(`backlog_file issue has no status field: ${issueNumber}`);
  }

  const currentStatus = lines[statusLine].replace(/^\s+status:\s*/, "").trim();
  if (currentStatus === nextStatus) {
    return { changed: false, issueId, raw: String(raw) };
  }

  const indent = lines[statusLine].match(/^(\s*)/)?.[1] ?? "    ";
  lines[statusLine] = `${indent}status: ${nextStatus}`;
  return { changed: true, issueId, raw: lines.join("\n") };
}

export function markBacklogIssueDone(config, issueNumber) {
  if (config.lifecycle.target_mode !== "backlog_file") {
    return null;
  }

  const workspaceDir = String(config.repo.workspace_dir ?? "").trim();
  const baseBranch = String(config.branches?.base_branch ?? "main").trim() || "main";
  if (!workspaceDir) {
    throw new Error("backlog_file workspace_dir is required");
  }
  prepareBacklogWorkspaceGit(config);

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspaceDir });
  if (branch !== baseBranch) {
    throw new Error(`backlog_file workspace is on ${branch}, expected ${baseBranch}`);
  }

  if (git(["status", "--porcelain"], { cwd: workspaceDir })) {
    throw new Error("backlog_file workspace has uncommitted changes");
  }

  maybeSyncBacklogWorkspace(config, { force: true });
  const manifestPath = resolveBacklogPath(config);
  const raw = fs.readFileSync(manifestPath, "utf8");
  const result = updateBacklogIssueStatus(raw, issueNumber, "done");
  if (!result.changed) {
    return result;
  }

  fs.writeFileSync(manifestPath, result.raw);
  const manifestRelativePath = path.relative(workspaceDir, manifestPath);
  git(["add", manifestRelativePath], { cwd: workspaceDir });
  git([
    "-c",
    "user.name=commons-devloop",
    "-c",
    "user.email=commons-devloop@users.noreply.github.com",
    "commit",
    "-m",
    `Mark ${result.issueId} done in backlog manifest`
  ], { cwd: workspaceDir });
  git(["push", "origin", baseBranch], { cwd: workspaceDir });
  return result;
}

function normalizeBacklogIssue(config, manifestPath, entry) {
  const number = Number(entry.sequence ?? entry.number);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`backlog_file issue has invalid sequence: ${JSON.stringify(entry)}`);
  }

  const id = String(entry.id ?? `issue-${number}`).trim();
  const title = String(entry.title ?? id).trim();
  const status = String(entry.status ?? "todo").trim();
  const file = String(entry.file ?? "").trim();
  const issuePath = (() => {
    if (!file) {
      return null;
    }
    if (path.isAbsolute(file)) {
      return file;
    }
    const repoRelative = path.resolve(config.repo.workspace_dir, file);
    if (fs.existsSync(repoRelative)) {
      return repoRelative;
    }
    return path.resolve(path.dirname(manifestPath), file);
  })();
  const body = issuePath && fs.existsSync(issuePath)
    ? fs.readFileSync(issuePath, "utf8")
    : "";
  const dependencies = Array.isArray(entry.depends_on)
    ? entry.depends_on.map((dependency) => String(dependency).trim()).filter(Boolean)
    : [];

  return {
    number,
    title: `${id}: ${title}`,
    body,
    url: issuePath ? `file://${issuePath}` : `backlog://${id}`,
    labels: [{ name: "backlog-file" }],
    milestone: { title: String(config.lifecycle.target_name ?? "backlog_file") },
    assignees: [],
    state: status === "done" ? "CLOSED" : "OPEN",
    source: "backlog_file",
    backlog_id: id,
    backlog_status: status,
    backlog_file: issuePath,
    depends_on: dependencies
  };
}

function parseInlineList(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBacklogManifest(raw) {
  try {
    const parsed = YAML.parse(raw);
    if (Array.isArray(parsed?.issues)) {
      return parsed.issues;
    }
  } catch {}

  const issues = [];
  let current = null;
  for (const line of String(raw).split(/\r?\n/)) {
    const sequenceMatch = line.match(/^\s*-\s+sequence:\s*(\d+)\s*$/);
    if (sequenceMatch) {
      if (current) {
        issues.push(current);
      }
      current = { sequence: Number(sequenceMatch[1]) };
      continue;
    }
    if (!current) {
      continue;
    }

    const propertyMatch = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!propertyMatch) {
      continue;
    }
    const [, key, rawValue] = propertyMatch;
    const value = rawValue.trim();
    current[key] = key === "depends_on" ? parseInlineList(value) : value;
  }
  if (current) {
    issues.push(current);
  }
  return issues;
}

function listBacklogIssuesForTarget(config) {
  const issues = listAllBacklogIssuesForTarget(config);
  return issues
    .filter((issue) => isOpenBacklogIssue(issue))
    .filter((issue) => dependenciesAreDone(issue, issues))
    .filter((issue) => matchesIssueFilters(config, issue));
}

function listAllBacklogIssuesForTarget(config) {
  maybeSyncBacklogWorkspace(config);
  const manifestPath = resolveBacklogPath(config);
  const rawIssues = parseBacklogManifest(fs.readFileSync(manifestPath, "utf8"));
  return rawIssues
    .map((entry) => normalizeBacklogIssue(config, manifestPath, entry))
    .filter((issue) => matchesIssueFilters(config, issue));
}

function isOpenBacklogIssue(issue) {
  return !["done", "closed"].includes(String(issue.backlog_status).toLowerCase());
}

function dependenciesAreDone(issue, allIssues) {
  const dependencies = Array.isArray(issue.depends_on) ? issue.depends_on : [];
  if (dependencies.length === 0) {
    return true;
  }

  const statusById = new Map(
    allIssues.map((entry) => [
      String(entry.backlog_id ?? "").trim(),
      String(entry.backlog_status ?? "").trim().toLowerCase()
    ])
  );
  return dependencies.every((dependency) => ["done", "closed"].includes(statusById.get(String(dependency).trim())));
}

export function listOpenIssuesForTarget(config, options = {}) {
  if (config.lifecycle.target_mode === "backlog_file") {
    return listBacklogIssuesForTarget(config);
  }

  const limit = Math.max(1, Number(options.limit ?? DEFAULT_ISSUE_LIST_LIMIT));
  const result = JSON.parse(
    gh([
      "issue",
      "list",
      "--repo",
      config.repo.github_slug,
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,title,milestone,labels,url,updatedAt"
    ], options)
  );

  return result.filter((issue) => matchesIssueFilters(config, issue));
}

export function getIssueDetails(config, issueNumber, options = {}) {
  if (config.lifecycle.target_mode === "backlog_file") {
    const issue = listAllBacklogIssuesForTarget(config)
      .find((entry) => Number(entry.number) === Number(issueNumber));
    if (!issue) {
      throw new Error(`backlog_file issue not found: ${issueNumber}`);
    }
    return issue;
  }

  return JSON.parse(
    gh([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      config.repo.github_slug,
      "--json",
      "number,title,body,url,labels,milestone,assignees,state"
    ], options)
  );
}

export function closeIssue(config, issueNumber, comment = "") {
  const args = [
    "issue",
    "close",
    String(issueNumber),
    "--repo",
    config.repo.github_slug
  ];
  if (comment) {
    args.push("--comment", comment);
  }
  return gh(args);
}

export function listOpenPullRequests(config, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? DEFAULT_PR_LIST_LIMIT));
  return JSON.parse(
    gh([
      "pr",
      "list",
      "--repo",
      config.repo.github_slug,
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      // `mergeStateStatus` is retained only for branch metadata like conflicts/behind.
      // Local gate readiness must not depend on hosted check success.
      "number,title,headRefName,headRefOid,baseRefName,url,labels,isDraft,mergeStateStatus,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify"
    ], options)
  )
    .map((pr) => normalizePullRequestMetadata(pr))
    .sort((left, right) => Number(left.number) - Number(right.number));
}

export function listQueuedWorkflowJobs(config) {
  const { owner, repo } = splitRepoSlug(config.repo.github_slug);
  try {
    const runs = JSON.parse(
      gh([
        "api",
        `repos/${owner}/${repo}/actions/runs`,
        "-F",
        "status=queued",
        "-F",
        "per_page=50"
      ])
    );
    return Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  } catch {
    return [];
  }
}

export function postCommitStatus(config, sha, payload) {
  const { owner, repo } = splitRepoSlug(config.repo.github_slug);
  return JSON.parse(
    gh([
      "api",
      `repos/${owner}/${repo}/statuses/${sha}`,
      "-X",
      "POST",
      "-f",
      `state=${payload.state}`,
      "-f",
      `context=${payload.context}`,
      "-f",
      `description=${payload.description ?? ""}`,
      "-f",
      `target_url=${payload.target_url ?? ""}`
    ])
  );
}

export function postPullRequestComment(config, prNumber, bodyFilePath) {
  return gh([
    "pr",
    "comment",
    String(prNumber),
    "--repo",
    config.repo.github_slug,
    "--body-file",
    bodyFilePath
  ]);
}

export function postPullRequestReview(config, prNumber, bodyFilePath) {
  return gh([
    "pr",
    "review",
    String(prNumber),
    "--repo",
    config.repo.github_slug,
    "--comment",
    "--body-file",
    bodyFilePath
  ]);
}

export function closePullRequest(config, prNumber, comment = "") {
  const args = [
    "pr",
    "close",
    String(prNumber),
    "--repo",
    config.repo.github_slug
  ];
  if (comment) {
    args.push("--comment", comment);
  }
  return gh(args);
}

export function enableAutoMerge(config, prNumber) {
  return gh([
    "pr",
    "merge",
    String(prNumber),
    "--repo",
    config.repo.github_slug,
    "--auto",
    "--squash"
  ]);
}

export function mergePullRequest(config, prNumber) {
  return gh([
    "pr",
    "merge",
    String(prNumber),
    "--repo",
    config.repo.github_slug,
    "--squash",
    "--delete-branch"
  ]);
}

export function updatePullRequestBranch(config, prNumber) {
  return gh([
    "api",
    "--method",
    "PUT",
    `repos/${config.repo.github_slug}/pulls/${String(prNumber)}/update-branch`
  ]);
}

export function getMergedPullRequests(config, limit = 5, options = {}) {
  try {
    return JSON.parse(
      gh([
        "pr",
        "list",
        "--repo",
        config.repo.github_slug,
        "--state",
        "merged",
        "--limit",
        String(limit),
        "--json",
        "number,title,mergedAt,url"
      ], options)
    );
  } catch {
    return [];
  }
}

export function checkGhAuth() {
  try {
    gh(["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}
