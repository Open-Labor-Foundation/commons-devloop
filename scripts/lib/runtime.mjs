import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const CODEX_HOME_COPY_FILES = ["config.toml", ".codex-global-state.json"];
const CODEX_HOME_SHARED_FILES = ["auth.json"];
const CODEX_SESSION_RELATIVE_DIR = "sessions";
let ghGitAuthReady = false;
const GIT_CONFIG_LOCK_RETRY_PATTERNS = [
  "could not lock config file .git/config",
  "unable to write upstream branch configuration",
  "is already checked out at",
  "cannot lock ref 'refs/remotes/",
  "unable to update local ref"
];

export function runCommand(command, options = {}) {
  return execSync(command, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 20,
    shell: "/bin/sh"
  }).trim();
}

export function ensureSafeGitDirectory(repoDir) {
  runCommand(`git config --global --add safe.directory ${JSON.stringify(repoDir)}`);
}

export function ensureGitHubGitAuth() {
  if (ghGitAuthReady) {
    return;
  }

  try {
    runCommand("gh auth setup-git");
    ghGitAuthReady = true;
  } catch {}
}

export function prepareIsolatedCodexHome(prefix = "commons-devloop-codex-") {
  const sourceHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  for (const name of CODEX_HOME_COPY_FILES) {
    const source = path.join(sourceHome, name);
    const target = path.join(codexHome, name);
    try {
      const stat = fs.statSync(source);
      if (stat.isFile()) {
        fs.copyFileSync(source, target);
      }
    } catch {}
  }

  for (const name of CODEX_HOME_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    const target = path.join(codexHome, name);
    try {
      const stat = fs.statSync(source);
      if (stat.isFile()) {
        fs.symlinkSync(source, target);
      }
    } catch {
      try {
        fs.copyFileSync(source, target);
      } catch {}
    }
  }

  return codexHome;
}

export function cleanupIsolatedCodexHome(codexHome) {
  if (!codexHome) {
    return;
  }

  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
  } catch {}
}

export function runCommandToFile(command, { cwd, logPath, env = {} }) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const result = spawnSync("/bin/sh", ["-lc", command], {
    cwd,
    env: {
      ...process.env,
      ...env
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });

  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  fs.writeFileSync(logPath, combined ? `${combined}\n` : "");

  if (result.status !== 0) {
    const error = new Error(`Command failed (${result.status}): ${command}`);
    error.output = combined;
    error.status = result.status;
    error.command = command;
    throw error;
  }

  return combined;
}

export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function removePath(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function shouldDeleteEntry(entryPath, maxAgeMs, nowMs) {
  if (maxAgeMs == null) {
    return true;
  }

  try {
    const stat = fs.statSync(entryPath);
    return (nowMs - stat.mtimeMs) >= maxAgeMs;
  } catch {
    return false;
  }
}

function cleanupEntrySet(rootDir, {
  keepNames = [],
  maxAgeMs = null,
  directoriesOnly = false,
  filesOnly = false
} = {}) {
  const removed = [];
  if (!rootDir || !fs.existsSync(rootDir)) {
    return removed;
  }

  const keep = new Set(
    Array.from(keepNames ?? [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  );
  const nowMs = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    const entryName = String(entry.name ?? "").trim();
    if (!entryName || keep.has(entryName)) {
      continue;
    }
    if (directoriesOnly && !entry.isDirectory()) {
      continue;
    }
    if (filesOnly && !entry.isFile()) {
      continue;
    }

    const entryPath = path.join(rootDir, entryName);
    if (!shouldDeleteEntry(entryPath, maxAgeMs, nowMs)) {
      continue;
    }

    if (removePath(entryPath)) {
      removed.push(entryName);
    }
  }

  return removed;
}

export function cleanupServiceArtifacts({
  worktreeRoot = null,
  runLogRoot = null,
  outputRoot = null,
  keepWorktrees = [],
  worktreeMaxAgeHours = null,
  runLogMaxAgeDays = null,
  outputMaxAgeDays = null
} = {}) {
  const worktreeMaxAgeMs = worktreeMaxAgeHours == null
    ? null
    : Math.max(0, Number(worktreeMaxAgeHours)) * 60 * 60 * 1000;
  const runLogMaxAgeMs = runLogMaxAgeDays == null
    ? null
    : Math.max(0, Number(runLogMaxAgeDays)) * 24 * 60 * 60 * 1000;
  const outputMaxAgeMs = outputMaxAgeDays == null
    ? null
    : Math.max(0, Number(outputMaxAgeDays)) * 24 * 60 * 60 * 1000;

  return {
    removedWorktrees: cleanupEntrySet(worktreeRoot, {
      keepNames: keepWorktrees,
      maxAgeMs: worktreeMaxAgeMs,
      directoriesOnly: true
    }),
    removedRunLogs: cleanupEntrySet(runLogRoot, {
      maxAgeMs: runLogMaxAgeMs,
      filesOnly: true
    }),
    removedOutputs: cleanupEntrySet(outputRoot, {
      maxAgeMs: outputMaxAgeMs,
      filesOnly: true
    })
  };
}

function sleepBlocking(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stringifyCommandError(error) {
  const values = [error?.message, error?.stderr, error?.stdout, error?.output];
  return values
    .map((value) => {
      if (value == null) {
        return "";
      }
      return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    })
    .join("\n");
}

function isRetryableGitWorktreeError(error) {
  const haystack = stringifyCommandError(error);
  return GIT_CONFIG_LOCK_RETRY_PATTERNS.some((pattern) => haystack.includes(pattern));
}

function runGitWorktreeCommand(command, { cwd, retries = 4, delayMs = 250, onRetry } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return runCommand(command, { cwd });
    } catch (error) {
      lastError = error;
      if (!isRetryableGitWorktreeError(error) || attempt >= retries) {
        throw error;
      }
      onRetry?.(attempt, error);
      sleepBlocking(delayMs * attempt);
    }
  }
  throw lastError;
}

export function ensureCleanWorktree(repoDir) {
  ensureSafeGitDirectory(repoDir);
  const status = runCommand("git status --porcelain", { cwd: repoDir });
  if (status.trim()) {
    throw new Error("Target repo worktree is not clean");
  }
}

export function syncCodexSessionHistory(
  codexHome,
  targetHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
) {
  if (!codexHome || !targetHome || codexHome === targetHome) {
    return;
  }

  const sourceRoot = path.join(codexHome, CODEX_SESSION_RELATIVE_DIR);
  const targetRoot = path.join(targetHome, CODEX_SESSION_RELATIVE_DIR);

  if (!fs.existsSync(sourceRoot)) {
    return;
  }

  const stack = [sourceRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const sourcePath = path.join(current, entry.name);
      const relativePath = path.relative(sourceRoot, sourcePath);
      const targetPath = path.join(targetRoot, relativePath);

      if (entry.isDirectory()) {
        try {
          fs.mkdirSync(targetPath, { recursive: true });
        } catch {}
        stack.push(sourcePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
      } catch {}
    }
  }
}

function splitRepoSlug(repoSlug) {
  const [owner, repo] = String(repoSlug ?? "").trim().split("/", 2);
  return {
    owner: owner || null,
    repo: repo || null
  };
}

function buildRemoteTrackingRef(remoteName, branchName) {
  return `refs/remotes/${remoteName}/${branchName}`;
}

function resolveHeadRemote({ repoSlug = null, headRepositoryOwner = null, headRepository = null }) {
  const baseRepo = splitRepoSlug(repoSlug);
  const owner = String(headRepositoryOwner ?? "").trim() || null;
  const repo = String(headRepository ?? "").trim() || null;

  if (!owner || !repo || (owner === baseRepo.owner && repo === baseRepo.repo)) {
    return {
      name: "origin",
      url: null
    };
  }

  return {
    name: `pr-head-${safeSlug(`${owner}-${repo}`) || "remote"}`,
    url: `https://github.com/${owner}/${repo}.git`
  };
}

function ensureGitRemote(repoDir, remote) {
  if (!remote?.name || !remote.url) {
    return remote;
  }

  try {
    const currentUrl = runCommand(`git remote get-url ${JSON.stringify(remote.name)}`, { cwd: repoDir });
    if (currentUrl !== remote.url) {
      runCommand(
        `git remote set-url ${JSON.stringify(remote.name)} ${JSON.stringify(remote.url)}`,
        { cwd: repoDir }
      );
    }
  } catch {
    runCommand(
      `git remote add ${JSON.stringify(remote.name)} ${JSON.stringify(remote.url)}`,
      { cwd: repoDir }
    );
  }

  return remote;
}

// `git branch --set-upstream-to` refuses to track a ref that resolves fine via
// rev-parse/for-each-ref but doesn't match one of the remote's *configured*
// fetch refspecs ("is not a branch") -- this repo's origin is configured with
// a narrow `+refs/heads/main:refs/remotes/origin/main` refspec (not the usual
// wildcard), so every other branch needs its own refspec entry registered
// before tracking can be set up, even though the ref itself already exists.
function ensureRemoteFetchRefspec(repoDir, remoteName, branchName) {
  const refspec = `+refs/heads/${branchName}:refs/remotes/${remoteName}/${branchName}`;
  let existing = [];
  try {
    existing = runCommand(`git config --get-all ${JSON.stringify(`remote.${remoteName}.fetch`)}`, { cwd: repoDir })
      .split("\n")
      .filter(Boolean);
  } catch {}
  if (!existing.includes(refspec)) {
    runCommand(
      `git config --add ${JSON.stringify(`remote.${remoteName}.fetch`)} ${JSON.stringify(refspec)}`,
      { cwd: repoDir }
    );
  }
}

export function prepareBranchWorktree({
  repoDir,
  worktreeRoot,
  branchName,
  baseBranch,
  startPoint = null,
  startPointHeadRepository = null,
  startPointHeadRepositoryOwner = null,
  repoSlug = null
}) {
  ensureGitHubGitAuth();
  ensureSafeGitDirectory(repoDir);
  const targetDir = path.join(worktreeRoot, safeSlug(branchName));
  const resolvedStartPoint = String(startPoint ?? "").trim() || String(baseBranch).trim();
  fs.mkdirSync(worktreeRoot, { recursive: true });

  try {
    runGitWorktreeCommand(`git worktree remove --force ${JSON.stringify(targetDir)}`, { cwd: repoDir });
  } catch {}
  try {
    runCommand("git worktree prune", { cwd: repoDir });
  } catch {}

  if (String(startPoint ?? "").trim()) {
    const remote = ensureGitRemote(
      repoDir,
      resolveHeadRemote({
        repoSlug,
        headRepositoryOwner: startPointHeadRepositoryOwner,
        headRepository: startPointHeadRepository
      })
    );
    const remoteTrackingRef = buildRemoteTrackingRef(remote.name, resolvedStartPoint);
    ensureRemoteFetchRefspec(repoDir, remote.name, resolvedStartPoint);
    runGitWorktreeCommand(
      `git fetch ${JSON.stringify(remote.name)} ${JSON.stringify(`+${resolvedStartPoint}:${remoteTrackingRef}`)}`,
      { cwd: repoDir }
    );
    runGitWorktreeCommand(
      `git worktree add -B ${JSON.stringify(branchName)} ${JSON.stringify(targetDir)} ${JSON.stringify(remoteTrackingRef)}`,
      { cwd: repoDir }
    );
    ensureSafeGitDirectory(targetDir);
    const upstreamRef = `${remote.name}/${resolvedStartPoint}`;
    runGitWorktreeCommand(
      `git branch --set-upstream-to ${JSON.stringify(upstreamRef)} ${JSON.stringify(branchName)}`,
      { cwd: targetDir }
    );
    return targetDir;
  }

  // Fetch into a stable remote-tracking ref rather than plain "git fetch origin <branch>",
  // which only updates FETCH_HEAD and leaves origin/<branch> unresolvable when this checkout
  // has never seen that branch before (e.g. a remediation branch pushed by a different worktree).
  const remediationTrackingRef = buildRemoteTrackingRef("origin", resolvedStartPoint);
  ensureRemoteFetchRefspec(repoDir, "origin", resolvedStartPoint);
  runGitWorktreeCommand(
    `git fetch origin ${JSON.stringify(`+${resolvedStartPoint}:${remediationTrackingRef}`)}`,
    { cwd: repoDir }
  );
  runGitWorktreeCommand(
    `git worktree add -B ${JSON.stringify(branchName)} ${JSON.stringify(targetDir)} ${JSON.stringify(remediationTrackingRef)}`,
    { cwd: repoDir }
  );
  ensureSafeGitDirectory(targetDir);
  runGitWorktreeCommand(
    `git branch --set-upstream-to ${JSON.stringify(`origin/${resolvedStartPoint}`)} ${JSON.stringify(branchName)}`,
    { cwd: targetDir }
  );
  return targetDir;
}

export function preparePullRequestWorktree({
  repoDir,
  worktreeRoot,
  prNumber,
  baseBranch,
  headRefName,
  headRepository = null,
  headRepositoryOwner = null,
  repoSlug = null
}) {
  ensureGitHubGitAuth();
  ensureSafeGitDirectory(repoDir);
  const targetDir = path.join(worktreeRoot, `pr-${String(prNumber)}`);
  const pullHeadRef = buildRemoteTrackingRef("origin", `pull-${String(prNumber)}-head`);
  fs.mkdirSync(worktreeRoot, { recursive: true });

  try {
    runGitWorktreeCommand(`git worktree remove --force ${JSON.stringify(targetDir)}`, { cwd: repoDir });
  } catch {}
  try {
    runCommand("git worktree prune", { cwd: repoDir });
  } catch {}

  // Fetch the PR head into a stable local ref so the detached worktree always opens on the PR tip,
  // not whichever ref happened to occupy FETCH_HEAD after a multi-ref fetch.
  runGitWorktreeCommand(
    `git fetch origin ${JSON.stringify(`+${baseBranch}:${buildRemoteTrackingRef("origin", baseBranch)}`)} ${JSON.stringify(`+pull/${prNumber}/head:${pullHeadRef}`)}`,
    { cwd: repoDir }
  );
  runGitWorktreeCommand(`git worktree add --detach ${JSON.stringify(targetDir)} ${JSON.stringify(pullHeadRef)}`, { cwd: repoDir });
  const remote = ensureGitRemote(
    targetDir,
    resolveHeadRemote({
      repoSlug,
      headRepositoryOwner,
      headRepository
    })
  );
  const remoteTrackingRef = buildRemoteTrackingRef(remote.name, headRefName);
  runCommand(`git fetch origin ${JSON.stringify(baseBranch)}`, { cwd: targetDir });
  runGitWorktreeCommand(
    `git fetch ${JSON.stringify(remote.name)} ${JSON.stringify(`+${headRefName}:${remoteTrackingRef}`)}`,
    { cwd: targetDir }
  );
  ensureSafeGitDirectory(targetDir);
  return targetDir;
}

export function commandExists(command) {
  try {
    runCommand(`command -v ${command}`);
    return true;
  } catch {
    return false;
  }
}

export function safeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
