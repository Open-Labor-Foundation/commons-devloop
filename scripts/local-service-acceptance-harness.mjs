import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { loadRepoState, loadServiceState } from "./lib/state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const ROLE_SCRIPT = path.join(REPO_ROOT, "scripts", "engine-role.mjs");
const DEPLOY_SCRIPT = path.join(REPO_ROOT, "scripts", "deploy-branch-to-host.sh");
const ISSUE_NUMBER = 13;
const PR_NUMBER = 17;
const REQUIRED_STAGE_SEQUENCE = [
  "issue-intake",
  "pr-creation",
  "local-review",
  "local-validation",
  "remediation",
  "revalidation",
  "local-merge"
];

function parseArgs(argv) {
  const options = {
    branchDeployment: false,
    json: false,
    keepTemp: false,
    workDir: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--branch-deployment":
        options.branchDeployment = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--keep-temp":
        options.keepTemp = true;
        break;
      case "--work-dir":
        options.workDir = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/local-service-acceptance-harness.mjs [options]

Options:
  --branch-deployment
                  Deploy a repo-focused branch checkout locally and run the
                  smoke harness from that deployed checkout.
  --json            Print the final summary as JSON.
  --keep-temp       Leave the temporary harness workspace on disk.
  --work-dir PATH   Reuse a specific temporary harness workspace.
  --help            Show this help text.
`);
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mode != null) {
    fs.chmodSync(filePath, mode);
  }
}

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 20,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 20,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"]
  }).trim();
}

function runRole(role, env) {
  const result = spawnSync(process.execPath, [ROLE_SCRIPT, "--role", role], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env
  });

  if (result.status !== 0) {
    throw new Error(`${role} failed: ${result.stderr || result.stdout || "unknown error"}`);
  }

  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function recordStage(stages, name, details = {}) {
  stages.push({
    name,
    ...details
  });
}

function withConfigContext(configPath, callback) {
  const previousConfigPath = process.env.AE_REPO_CONFIG;
  const previousStackId = process.env.AE_STACK_ID;
  process.env.AE_REPO_CONFIG = configPath;
  process.env.AE_STACK_ID = path.parse(configPath).name;
  try {
    return callback();
  } finally {
    if (previousConfigPath == null) {
      delete process.env.AE_REPO_CONFIG;
    } else {
      process.env.AE_REPO_CONFIG = previousConfigPath;
    }
    if (previousStackId == null) {
      delete process.env.AE_STACK_ID;
    } else {
      process.env.AE_STACK_ID = previousStackId;
    }
  }
}

function waitFor(predicate, description, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function createRepoSnapshot(sourceRepo) {
  fs.cpSync(REPO_ROOT, sourceRepo, {
    recursive: true,
    filter: (entryPath) => path.basename(entryPath) !== ".git"
  });
}

function initialiseSnapshotRepo(sourceRepo) {
  runGit(["init"], { cwd: sourceRepo });
  runGit(["config", "user.name", "Acceptance Harness"], { cwd: sourceRepo });
  runGit(["config", "user.email", "acceptance-harness@example.com"], { cwd: sourceRepo });
  runGit(["add", "."], { cwd: sourceRepo });
  runGit(["commit", "-m", "snapshot harness branch"], { cwd: sourceRepo });
  runGit(["branch", "-M", "repo/local-service-acceptance"], { cwd: sourceRepo });
  runGit(["remote", "add", "origin", "https://example.test/autonomous-engine.git"], { cwd: sourceRepo });
}

function findNodeModulesDir(startDir) {
  let currentDir = startDir;
  while (true) {
    const candidate = path.join(currentDir, "node_modules");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function prepareDeployedCheckoutRuntime(deployedRepo) {
  const nodeModulesDir = findNodeModulesDir(REPO_ROOT);
  if (nodeModulesDir != null) {
    fs.symlinkSync(nodeModulesDir, path.join(deployedRepo, "node_modules"), "dir");
    return {
      dependencyStrategy: "symlink",
      nodeModulesDir
    };
  }

  runCommand("npm", ["ci"], { cwd: deployedRepo });
  return {
    dependencyStrategy: "npm-ci",
    nodeModulesDir: null
  };
}

function createTargetRepo(tempRoot) {
  const originDir = path.join(tempRoot, "target-origin.git");
  const workspaceDir = path.join(tempRoot, "target-workspace");

  runGit(["init", "--bare", originDir]);
  runGit(["clone", originDir, workspaceDir]);
  runGit(["config", "user.name", "Acceptance Harness"], { cwd: workspaceDir });
  runGit(["config", "user.email", "acceptance-harness@example.com"], { cwd: workspaceDir });
  writeFile(path.join(workspaceDir, "README.md"), "# acceptance target\n");
  runGit(["add", "README.md"], { cwd: workspaceDir });
  runGit(["commit", "-m", "seed target repo"], { cwd: workspaceDir });
  runGit(["branch", "-M", "main"], { cwd: workspaceDir });
  runGit(["push", "-u", "origin", "main"], { cwd: workspaceDir });

  return { originDir, workspaceDir };
}

function createConfig(configPath, workspaceDir) {
  writeFile(
    configPath,
    `version: 2

repo:
  key: acceptance-target
  github_slug: example/acceptance-target
  default_branch: main
  workspace_dir: ${JSON.stringify(workspaceDir)}

lifecycle:
  enabled: true
  target_mode: open
  target_name: local-service-acceptance
  pause_when_target_complete: false
  pause_when_budget_exhausted: false
  max_parallel_prs: 1
  max_runs_per_day: 2

issue_source:
  labels:
    - codex-ready

dispatcher:
  enabled: true
  poll_interval_seconds: 5
  primary_max_workers: 1
  secondary_max_workers: 0

models:
  dispatcher:
    primary:
      name: gpt-5.4
      reasoning_effort: medium
      pause_threshold_used_percent: 80
      weekly_pause_threshold_used_percent: 80
      reserve_burn_window_minutes: 300
      nominal_burn_per_lane_hour: 1
    secondary:
      name: gpt-5.4
      reasoning_effort: medium
      pause_threshold_used_percent: 80
      weekly_pause_threshold_used_percent: 80
      reserve_burn_window_minutes: 300
      nominal_burn_per_lane_hour: 1
  reviewer:
    name: gpt-5.4
    reasoning_effort: medium

validation:
  enabled: true
  context: validate
  poll_interval_seconds: 5
  max_concurrent: 1
  bootstrap_commands: []
  commands:
    - test -f harness-fixed.txt
  post_status: false

reviewer:
  enabled: true
  poll_interval_seconds: 5
  max_concurrent: 1
  post_mode: review

runner_manager:
  enabled: false
  required_labels: []
  runner_labels: []
  image_name: acceptance
  container_prefix: acceptance
  max_runners: 0
  poll_interval_seconds: 20
  launch_cooldown_seconds: 30
  mount_docker_socket: false
  mount_workspace: false
  dry_run: true

pr_manager:
  enabled: true
  interval_seconds: 5
  merge_concurrency: 1

monitor:
  enabled: false
  poll_interval_seconds: 30

safety:
  pr_only: true
  auto_merge: true
  protected_branches:
    - main
  protected_paths: []
  allow_force_push: false
  require_clean_worktree_before_run: false

budgets:
  max_estimated_credits_per_day: 10
  pause_reason_on_budget: budget exhausted

branches:
  work_branch_prefix: autonomous/
  pr_base_branch: main

roles:
  enabled:
    autonomous: true
    dispatcher: true
    validator: true
    reviewer: true
    runner-manager: false
    pr-manager: true
    monitor: false
    dashboard: false

dashboard:
  enabled: false
  port: 4700
  expose_issue_details: false
  expose_pr_links: false
`
  );
}

function createHarnessGitHubState(ghStatePath) {
  writeFile(
    ghStatePath,
    `${JSON.stringify({
      issues: [
        {
          number: ISSUE_NUMBER,
          title: "LS-12: local-only end-to-end acceptance harness",
          body: "Acceptance harness smoke issue.",
          url: `https://example.test/issues/${ISSUE_NUMBER}`,
          state: "open",
          labels: [{ name: "codex-ready" }],
          milestone: null,
          assignees: []
        }
      ],
      pullRequests: [],
      mergedPrs: [],
      statuses: [],
      reviews: [],
      comments: [],
      counters: {
        issueRuns: 0,
        remediationRuns: 0
      }
    }, null, 2)}\n`
  );
}

function createMockCommands(binDir) {
  writeFile(
    path.join(binDir, "gh"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const statePath = process.env.AE_HARNESS_GH_STATE;
const originDir = process.env.AE_HARNESS_TARGET_ORIGIN;
const tempRoot = process.env.AE_HARNESS_TEMP_ROOT;
const logPath = process.env.AE_HARNESS_GH_LOG;

if (logPath) {
  fs.appendFileSync(logPath, \`\${args.join(" ")}\\n\`);
}

function loadState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
}

function git(gitArgs, cwd = null) {
  return execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function getFlag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function parseFormValues() {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-f") {
      const [key, value] = String(args[index + 1] ?? "").split("=", 2);
      values[key] = value ?? "";
      index += 1;
    }
  }
  return values;
}

function mergePullRequest(pr) {
  const mergeDir = fs.mkdtempSync(path.join(tempRoot, "gh-merge-"));
  git(["clone", originDir, mergeDir]);
  git(["config", "user.name", "Acceptance Harness"], mergeDir);
  git(["config", "user.email", "acceptance-harness@example.com"], mergeDir);
  git(["checkout", pr.baseRefName], mergeDir);
  git(["fetch", "origin", pr.headRefName], mergeDir);
  git(["merge", "--squash", \`origin/\${pr.headRefName}\`], mergeDir);
  git(["commit", "-m", \`Merge pull request #\${pr.number} from \${pr.headRefName}\`], mergeDir);
  git(["push", "origin", \`HEAD:\${pr.baseRefName}\`], mergeDir);
  try {
    git(["push", "origin", "--delete", pr.headRefName], mergeDir);
  } catch {}
  const mergedSha = git(["rev-parse", "HEAD"], mergeDir);
  fs.rmSync(mergeDir, { recursive: true, force: true });
  return mergedSha;
}

if (args[0] === "auth") {
  process.exit(0);
}

if (args[0] === "api" && String(args[1] ?? "").includes("/actions/runs")) {
  process.stdout.write(JSON.stringify({ workflow_runs: [] }));
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "list") {
  const state = loadState();
  process.stdout.write(JSON.stringify(state.issues.filter((issue) => issue.state === "open")));
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "view") {
  const issueNumber = Number(args[2]);
  const state = loadState();
  const issue = state.issues.find((entry) => Number(entry.number) === issueNumber);
  process.stdout.write(JSON.stringify(issue ?? null));
  process.exit(issue ? 0 : 1);
}

if (args[0] === "issue" && args[1] === "close") {
  const issueNumber = Number(args[2]);
  const state = loadState();
  const issue = state.issues.find((entry) => Number(entry.number) === issueNumber);
  if (!issue) {
    process.exit(1);
  }
  issue.state = "closed";
  issue.closedAt = new Date().toISOString();
  issue.closeComment = getFlag("--comment");
  saveState(state);
  process.stdout.write(JSON.stringify({ closed: true, number: issueNumber }));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  const state = loadState();
  const prState = getFlag("--state") ?? "open";
  const items = prState === "merged"
    ? state.mergedPrs
    : state.pullRequests.filter((entry) => entry.state === "open");
  process.stdout.write(JSON.stringify(items));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "comment") {
  const state = loadState();
  state.comments.push({
    prNumber: Number(args[2]),
    body: fs.readFileSync(getFlag("--body-file"), "utf8").trim()
  });
  saveState(state);
  process.stdout.write("ok");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "review") {
  const state = loadState();
  state.reviews.push({
    prNumber: Number(args[2]),
    body: fs.readFileSync(getFlag("--body-file"), "utf8").trim()
  });
  saveState(state);
  process.stdout.write("ok");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "merge") {
  const state = loadState();
  const prNumber = Number(args[2]);
  const pr = state.pullRequests.find((entry) => Number(entry.number) === prNumber && entry.state === "open");
  if (!pr) {
    process.exit(1);
  }
  const mergedSha = mergePullRequest(pr);
  pr.state = "merged";
  pr.mergedAt = new Date().toISOString();
  pr.mergedSha = mergedSha;
  state.mergedPrs.unshift({
    number: pr.number,
    title: pr.title,
    mergedAt: pr.mergedAt,
    url: pr.url,
    mergeStateStatus: pr.mergeStateStatus
  });
  state.pullRequests = state.pullRequests.filter((entry) => Number(entry.number) !== prNumber);
  saveState(state);
  process.stdout.write(JSON.stringify({ merged: true, sha: mergedSha }));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "update-branch") {
  process.stdout.write(JSON.stringify({ updated: true }));
  process.exit(0);
}

if (args[0] === "api" && args[1] === "--method" && args[2] === "PUT" && /\\/pulls\\/\\d+\\/update-branch$/.test(String(args[3] ?? ""))) {
  process.stdout.write(JSON.stringify({ updated: true }));
  process.exit(0);
}

if (args[0] === "api" && /\\/statuses\\//.test(String(args[1] ?? ""))) {
  const state = loadState();
  const values = parseFormValues();
  state.statuses.push({
    sha: String(args[1]).split("/").at(-1),
    state: values.state ?? null,
    context: values.context ?? null,
    description: values.description ?? null
  });
  saveState(state);
  process.stdout.write(JSON.stringify({ ok: true }));
  process.exit(0);
}

process.stderr.write(\`Unhandled gh invocation: \${args.join(" ")}\\n\`);
process.exit(1);
`,
    0o755
  );

  writeFile(
    path.join(binDir, "codex"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const prompt = String(args.at(-1) ?? "");
const logPath = process.env.AE_HARNESS_CODEX_LOG;
const statePath = process.env.AE_HARNESS_GH_STATE;
const originDir = process.env.AE_HARNESS_TARGET_ORIGIN;
const worktreeIndex = args.indexOf("-C");
const worktreeDir = worktreeIndex >= 0 ? args[worktreeIndex + 1] : process.cwd();

if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
}

function git(gitArgs, cwd = worktreeDir) {
  return execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function loadState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
}

function writeHarnessFile(fileName, content) {
  fs.writeFileSync(path.join(worktreeDir, fileName), content);
}

function ensureCommit(message) {
  git(["config", "user.name", "Acceptance Harness"]);
  git(["config", "user.email", "acceptance-harness@example.com"]);
  git(["add", "."]);
  git(["commit", "-m", message]);
  const branchName = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  git(["push", "origin", \`HEAD:\${branchName}\`]);
  return {
    branchName,
    sha: git(["rev-parse", "HEAD"])
  };
}

function updatePullRef(prNumber, sha) {
  git(["--git-dir", originDir, "update-ref", \`refs/pull/\${prNumber}/head\`, sha], worktreeDir);
}

if (prompt.includes("Review the current branch against origin/")) {
  process.stdout.write("No actionable findings.\\nVERDICT: APPROVE\\n");
  process.exit(0);
}

if (prompt.includes("Remediation mode: this is a branch-fix run for an existing pull request")) {
  const state = loadState();
  writeHarnessFile("harness-fixed.txt", "fixed\\n");
  const commit = ensureCommit("Fix local validation failure");
  const pr = state.pullRequests.find((entry) => Number(entry.number) === ${PR_NUMBER} && entry.state === "open");
  if (!pr) {
    process.stderr.write("Missing open PR for remediation\\n");
    process.exit(1);
  }
  pr.headRefOid = commit.sha;
  state.counters.remediationRuns += 1;
  saveState(state);
  updatePullRef(pr.number, commit.sha);
  process.stdout.write(\`remediated \${commit.sha}\\n\`);
  process.exit(0);
}

const state = loadState();
writeHarnessFile("issue-${ISSUE_NUMBER}.md", "# acceptance issue\\n");
const commit = ensureCommit("Implement acceptance issue");
state.pullRequests.push({
  number: ${PR_NUMBER},
  title: "LS-12 acceptance harness smoke PR",
  headRefName: commit.branchName,
  headRefOid: commit.sha,
  baseRefName: "main",
  url: "https://example.test/pr/${PR_NUMBER}",
  labels: [{ name: "automerge" }],
  isDraft: false,
  mergeStateStatus: "BLOCKED",
  headRepository: "acceptance-target",
  headRepositoryOwner: "example",
  isCrossRepository: false,
  maintainerCanModify: false,
  state: "open"
});
state.counters.issueRuns += 1;
saveState(state);
updatePullRef(${PR_NUMBER}, commit.sha);
process.stdout.write("created pull request\\n");
`,
    0o755
  );
}

function buildSummary({ tempRoot, ghStatePath, stateDir, configPath, originDir, stages }) {
  const ghState = readJson(ghStatePath);
  const repoState = withConfigContext(configPath, () => loadRepoState(stateDir, "acceptance-target"));
  const validatorState = withConfigContext(configPath, () => loadServiceState(stateDir, "acceptance-target", "validator"));
  const reviewerState = withConfigContext(configPath, () => loadServiceState(stateDir, "acceptance-target", "reviewer"));
  const prManagerState = withConfigContext(configPath, () => loadServiceState(stateDir, "acceptance-target", "pr-manager"));

  const mergedPr = ghState.mergedPrs.find((entry) => Number(entry.number) === PR_NUMBER) ?? null;
  const issueFileMerged =
    spawnSync("git", ["--git-dir", originDir, "cat-file", "-e", `refs/heads/main:issue-${ISSUE_NUMBER}.md`], { encoding: "utf8" }).status === 0;
  const fixedFileMerged =
    spawnSync("git", ["--git-dir", originDir, "cat-file", "-e", "refs/heads/main:harness-fixed.txt"], { encoding: "utf8" }).status === 0;

  return {
    tempRoot,
    issueNumber: ISSUE_NUMBER,
    prNumber: PR_NUMBER,
    prUrl: mergedPr?.url ?? `https://example.test/pr/${PR_NUMBER}`,
    stageSequence: stages.map((stage) => stage.name),
    stages,
    merged: Boolean(mergedPr),
    issueClosed: ghState.issues.find((entry) => Number(entry.number) === ISSUE_NUMBER)?.state === "closed",
    mergeStateStatus: mergedPr?.mergeStateStatus ?? null,
    issueRuns: ghState.counters.issueRuns,
    remediationRuns: ghState.counters.remediationRuns,
    reviewCount: ghState.reviews.length,
    statusUpdates: ghState.statuses.length,
    finalValidatorResult: validatorState.prs?.[String(PR_NUMBER)]?.result ?? null,
    finalReviewerResult: reviewerState.prs?.[String(PR_NUMBER)]?.result ?? null,
    remediationRecordStatuses: (repoState.remediationRecords ?? []).map((record) => ({
      prNumber: record.prNumber,
      service: record.service,
      status: record.status
    })),
    localMergeWithoutGitHubHostedCompute:
      Boolean(mergedPr) &&
      mergedPr.mergeStateStatus === "BLOCKED" &&
      !fs.readFileSync(path.join(tempRoot, "gh.log"), "utf8").includes("/actions/runs"),
    mergedFiles: {
      issueFile: issueFileMerged,
      fixedFile: fixedFileMerged
    },
    prManagerSummary: prManagerState.summary
  };
}

function assertState(summary) {
  if (JSON.stringify(summary.stageSequence) !== JSON.stringify(REQUIRED_STAGE_SEQUENCE)) {
    throw new Error(`Expected stage sequence ${REQUIRED_STAGE_SEQUENCE.join(" -> ")}, saw ${summary.stageSequence.join(" -> ")}`);
  }
  if (!summary.merged) {
    throw new Error("Acceptance harness did not merge the PR");
  }
  if (!summary.issueClosed) {
    throw new Error(`Expected issue #${summary.issueNumber} to be closed after merge`);
  }
  if (summary.issueRuns !== 1) {
    throw new Error(`Expected 1 issue run, saw ${summary.issueRuns}`);
  }
  if (summary.remediationRuns !== 1) {
    throw new Error(`Expected 1 remediation run, saw ${summary.remediationRuns}`);
  }
  if (summary.finalValidatorResult !== "success") {
    throw new Error(`Expected final validator result to be success, saw ${summary.finalValidatorResult}`);
  }
  if (summary.finalReviewerResult !== "success") {
    throw new Error(`Expected final reviewer result to be success, saw ${summary.finalReviewerResult}`);
  }
  if (!summary.localMergeWithoutGitHubHostedCompute) {
    throw new Error("Acceptance harness did not prove local merge without GitHub-hosted compute");
  }
  if (!summary.mergedFiles.issueFile || !summary.mergedFiles.fixedFile) {
    throw new Error("Expected issue and remediation files to be merged into main");
  }
}

function runBranchDeploymentHarness(tempRoot) {
  const sourceRepo = path.join(tempRoot, "branch-source");
  const deployedRepo = path.join(tempRoot, "branch-host", "autonomous-engine");
  const deployedTargetRepo = path.join(tempRoot, "deployed-target-repo");
  const envFile = path.join(tempRoot, "branch-deployment.env");

  createRepoSnapshot(sourceRepo);
  initialiseSnapshotRepo(sourceRepo);
  fs.mkdirSync(deployedTargetRepo, { recursive: true });
  writeFile(
    envFile,
    `AE_TARGET_REPO_PATH=${deployedTargetRepo}
AE_REPO_CONFIG_FILE=commons-devloop.yaml
`
  );

  runCommand("bash", [
    DEPLOY_SCRIPT,
    "--transport",
    "local",
    "--source-repo",
    sourceRepo,
    "--remote-repo-path",
    deployedRepo,
    "--env-file",
    envFile,
    "--skip-launch"
  ]);

  const runtime = prepareDeployedCheckoutRuntime(deployedRepo);
  const smokeSummary = JSON.parse(
    runCommand(process.execPath, [path.join(deployedRepo, "scripts", "local-service-acceptance-harness.mjs"), "--json"], {
      cwd: deployedRepo
    })
  );
  const sourceCommit = runGit(["rev-parse", "HEAD"], { cwd: sourceRepo });
  const deployedCommit = runGit(["rev-parse", "HEAD"], { cwd: deployedRepo });

  return {
    tempRoot,
    mode: "branch-deployment",
    branchName: runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: sourceRepo }),
    sourceCommit,
    deployedCommit,
    deployedCommitMatchesSource: sourceCommit === deployedCommit,
    deployedRepo,
    deployedTargetRepo,
    dependencyStrategy: runtime.dependencyStrategy,
    nodeModulesDir: runtime.nodeModulesDir,
    smokeSummary
  };
}

function assertBranchDeploymentState(summary) {
  if (!summary.deployedCommitMatchesSource) {
    throw new Error("Branch deployment smoke did not preserve the source commit");
  }
  assertState(summary.smokeSummary);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ae-local-acceptance-"));

  if (options.branchDeployment) {
    const summary = runBranchDeploymentHarness(tempRoot);
    assertBranchDeploymentState(summary);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(`Repo-focused branch deployment smoke passed.
Deployed checkout ${summary.branchName} at ${summary.deployedCommit}.
Smoke PR ${summary.smokeSummary.prUrl} merged after local remediation.
Workspace: ${tempRoot}
`);
    }

    if (!options.keepTemp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    return;
  }

  const stateDir = path.join(tempRoot, "state");
  const configPath = path.join(tempRoot, "config.yaml");
  const ghStatePath = path.join(tempRoot, "gh-state.json");
  const binDir = path.join(tempRoot, "bin");
  const ghLogPath = path.join(tempRoot, "gh.log");
  const codexLogPath = path.join(tempRoot, "codex.log");
  const { originDir, workspaceDir } = createTargetRepo(tempRoot);
  const stages = [];

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  createConfig(configPath, workspaceDir);
  createHarnessGitHubState(ghStatePath);
  createMockCommands(binDir);

  const env = {
    ...process.env,
    AE_MODE: "once",
    AE_REPO_CONFIG: configPath,
    AE_STACK_ID: path.parse(configPath).name,
    AE_STATE_DIR: stateDir,
    AE_HARNESS_GH_STATE: ghStatePath,
    AE_HARNESS_TARGET_ORIGIN: originDir,
    AE_HARNESS_TEMP_ROOT: tempRoot,
    AE_HARNESS_GH_LOG: ghLogPath,
    AE_HARNESS_CODEX_LOG: codexLogPath,
    PATH: `${binDir}:${process.env.PATH ?? ""}`
  };

  runRole("autonomous", env);
  recordStage(stages, "issue-intake", { issueNumber: ISSUE_NUMBER });
  runRole("dispatcher", env);
  const createdPr = waitFor(
    () => readJson(ghStatePath).pullRequests.find((entry) => Number(entry.number) === PR_NUMBER && entry.state === "open"),
    "initial pull request creation"
  );
  recordStage(stages, "pr-creation", {
    prNumber: createdPr.number,
    prUrl: createdPr.url,
    headRefName: createdPr.headRefName
  });

  runRole("pr-manager", env);
  runRole("reviewer", env);
  recordStage(stages, "local-review", { prNumber: PR_NUMBER, result: "success" });
  runRole("validator", env);
  const firstValidationResult = withConfigContext(configPath, () => loadServiceState(stateDir, "acceptance-target", "validator"));
  recordStage(stages, "local-validation", {
    prNumber: PR_NUMBER,
    result: firstValidationResult.prs?.[String(PR_NUMBER)]?.result ?? null
  });

  const originalSha = readJson(ghStatePath).pullRequests.find((entry) => Number(entry.number) === PR_NUMBER)?.headRefOid;

  runRole("dispatcher", env);
  const remediatedPr = waitFor(
    () => {
      const pr = readJson(ghStatePath).pullRequests.find((entry) => Number(entry.number) === PR_NUMBER && entry.state === "open");
      return pr && pr.headRefOid !== originalSha ? pr : null;
    },
    "remediation push"
  );
  recordStage(stages, "remediation", {
    prNumber: PR_NUMBER,
    previousHeadSha: originalSha,
    headSha: remediatedPr.headRefOid
  });

  runRole("pr-manager", env);
  runRole("reviewer", env);
  runRole("validator", env);
  const finalValidationResult = withConfigContext(configPath, () => loadServiceState(stateDir, "acceptance-target", "validator"));
  recordStage(stages, "revalidation", {
    prNumber: PR_NUMBER,
    result: finalValidationResult.prs?.[String(PR_NUMBER)]?.result ?? null
  });
  runRole("pr-manager", env);
  runRole("pr-manager", env);

  const mergedPr = readJson(ghStatePath).mergedPrs.find((entry) => Number(entry.number) === PR_NUMBER) ?? null;
  recordStage(stages, "local-merge", {
    prNumber: PR_NUMBER,
    prUrl: mergedPr?.url ?? `https://example.test/pr/${PR_NUMBER}`,
    mergeStateStatus: mergedPr?.mergeStateStatus ?? null
  });
  const summary = buildSummary({ tempRoot, ghStatePath, stateDir, configPath, originDir, stages });
  assertState(summary);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`Local acceptance harness passed.
PR ${summary.prUrl} merged after remediation with mergeStateStatus=${summary.mergeStateStatus}.
Workspace: ${tempRoot}
`);
  }

  if (!options.keepTemp) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
