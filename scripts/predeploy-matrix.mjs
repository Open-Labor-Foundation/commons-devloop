import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { loadConfig } from "./lib/config.mjs";
import { resolveStackIdentity } from "./lib/state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MATRIX_PATH = path.join(REPO_ROOT, "config", "predeploy.matrix.yaml");
const VALID_PHASES = new Set(["qa", "a", "b"]);
const STANDARD_SERVICE_DEFAULTS = [
  "autonomous",
  "dispatcher",
  "validator",
  "reviewer",
  "runner-manager",
  "pr-manager",
  "monitor",
  "dashboard"
];

function printUsage() {
  process.stdout.write(`Usage: node scripts/predeploy-matrix.mjs [options]

Options:
  --matrix PATH        Readiness profile YAML file. Defaults to config/predeploy.matrix.yaml.
  --profile NAME      Check one profile only. May be repeated.
  --phase PHASE       Check one phase only: qa, a, or b. May be repeated.
  --require-targets   Fail when a profile target_repo_path is missing or absent.
  --json              Print machine-readable JSON.
  --help              Show this help text.
`);
}

function parseArgs(argv) {
  const options = {
    matrixPath: DEFAULT_MATRIX_PATH,
    profiles: new Set(),
    phases: new Set(),
    requireTargets: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--matrix":
        options.matrixPath = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case "--profile":
        options.profiles.add(String(argv[index + 1] ?? "").trim());
        index += 1;
        break;
      case "--phase":
        options.phases.add(String(argv[index + 1] ?? "").trim().toLowerCase());
        index += 1;
        break;
      case "--require-targets":
        options.requireTargets = true;
        break;
      case "--json":
        options.json = true;
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

  for (const phase of options.phases) {
    if (!VALID_PHASES.has(phase)) {
      throw new Error(`Unsupported phase: ${phase}`);
    }
  }

  return options;
}

function readMatrix(matrixPath) {
  if (!fs.existsSync(matrixPath)) {
    throw new Error(`Missing deployment readiness profile file: ${matrixPath}`);
  }
  const parsed = YAML.parse(fs.readFileSync(matrixPath, "utf8"));
  if (!Array.isArray(parsed?.profiles)) {
    throw new Error("deployment readiness check must define a profiles list");
  }
  return parsed;
}

function expandEnv(value) {
  if (value == null) {
    return value;
  }
  return String(value).replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => process.env[key] ?? "");
}

function resolveRepoConfigPath(profile, matrixDir) {
  const configuredPath = expandEnv(profile.repo_config ?? profile.repoConfig);
  if (configuredPath) {
    return path.resolve(matrixDir, configuredPath);
  }

  const file = expandEnv(profile.repo_config_file ?? profile.repoConfigFile);
  if (!file) {
    throw new Error(`profile ${profile.name ?? "(unnamed)"} is missing repo_config_file`);
  }
  if (path.isAbsolute(file)) {
    return file;
  }
  return path.join(REPO_ROOT, "config", "repos", file);
}

function resolveOptionalPath(value, baseDir) {
  const expanded = expandEnv(value);
  if (!expanded) {
    return null;
  }
  return path.resolve(baseDir, expanded);
}

function withProfileEnv(profile, repoConfigPath, callback) {
  const envUpdates = {
    ...(profile.env && typeof profile.env === "object" ? profile.env : {}),
    AE_REPO_CONFIG: repoConfigPath,
    AE_STACK_ID: String(profile.stack_id ?? profile.stackId ?? profile.name ?? "").trim(),
    AE_DASHBOARD_PORT: profile.dashboard_port == null ? undefined : String(profile.dashboard_port)
  };

  const targetRepoPath = expandEnv(profile.target_repo_path ?? profile.targetRepoPath);
  if (targetRepoPath) {
    envUpdates.AE_TARGET_REPO_PATH = targetRepoPath;
  }

  const workspaceDir = expandEnv(profile.workspace_dir ?? profile.workspaceDir);
  if (workspaceDir) {
    envUpdates.AE_WORKSPACE_DIR = workspaceDir;
  }

  const previous = new Map();
  for (const [key, value] of Object.entries(envUpdates)) {
    previous.set(key, process.env[key]);
    if (value == null || value === "") {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function normalizeProfile(profile, matrixDir) {
  const name = String(profile?.name ?? "").trim();
  if (!name) {
    throw new Error("predeploy profile is missing name");
  }
  const phase = String(profile.phase ?? "qa").trim().toLowerCase();
  if (!VALID_PHASES.has(phase)) {
    throw new Error(`profile ${name} has unsupported phase: ${phase}`);
  }
  return {
    ...profile,
    name,
    phase,
    enabled: profile.enabled !== false,
    repoConfigPath: resolveRepoConfigPath(profile, matrixDir)
  };
}

function findDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return null;
}

function normalizeRequiredServices(value, ownerName) {
  if (value == null) {
    return [...STANDARD_SERVICE_DEFAULTS];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${ownerName} required_services must be a list`);
  }
  const services = value.map((service) => String(service).trim()).filter(Boolean);
  const unknown = services.find((service) => !STANDARD_SERVICE_DEFAULTS.includes(service));
  if (unknown) {
    throw new Error(`${ownerName} requires unknown service default: ${unknown}`);
  }
  return [...new Set(services)];
}

export function evaluatePredeployMatrix(matrixPath = DEFAULT_MATRIX_PATH, options = {}) {
  const absoluteMatrixPath = path.resolve(matrixPath);
  const matrixDir = path.dirname(absoluteMatrixPath);
  const matrix = readMatrix(absoluteMatrixPath);
  const profileFilter = new Set(options.profiles ?? []);
  const phaseFilter = new Set(options.phases ?? []);
  const requireTargets = Boolean(options.requireTargets);

  const profiles = matrix.profiles
    .map((profile) => normalizeProfile(profile, matrixDir))
    .filter((profile) => profile.enabled)
    .filter((profile) => profileFilter.size === 0 || profileFilter.has(profile.name))
    .filter((profile) => phaseFilter.size === 0 || phaseFilter.has(profile.phase));

  const failures = [];
  const warnings = [];
  if (profiles.length === 0) {
    failures.push("no enabled profiles matched the requested filters");
  }

  const duplicateName = findDuplicate(profiles.map((profile) => profile.name));
  if (duplicateName) {
    failures.push(`duplicate profile name: ${duplicateName}`);
  }

  const requiredPhases = Array.isArray(matrix.gates?.require_phases)
    ? matrix.gates.require_phases.map((phase) => String(phase).toLowerCase())
    : [];
  for (const phase of requiredPhases) {
    if (!VALID_PHASES.has(phase)) {
      failures.push(`matrix requires unsupported phase: ${phase}`);
    } else if (!profiles.some((profile) => profile.phase === phase)) {
      failures.push(`missing required predeploy phase: ${phase}`);
    }
  }

  const results = profiles.map((profile) => {
    const profileWarnings = [];
    if (!fs.existsSync(profile.repoConfigPath)) {
      failures.push(`profile ${profile.name} repo config does not exist: ${profile.repoConfigPath}`);
      return {
        name: profile.name,
        phase: profile.phase,
        repoConfigPath: profile.repoConfigPath,
        ok: false,
        warnings: profileWarnings
      };
    }

    return withProfileEnv(profile, profile.repoConfigPath, () => {
      const config = loadConfig(profile.repoConfigPath);
      const stateDir = resolveOptionalPath(profile.state_dir ?? profile.stateDir ?? process.env.AE_STATE_DIR ?? "state", REPO_ROOT);
      const stack = resolveStackIdentity(stateDir, config.repo.key);
      const targetRepoPath = resolveOptionalPath(profile.target_repo_path ?? profile.targetRepoPath ?? process.env.AE_TARGET_REPO_PATH, REPO_ROOT);
      const dashboardPort = Number(config.dashboard.port);
      const requiredServices = normalizeRequiredServices(
        profile.required_services ?? profile.requiredServices ?? matrix.gates?.required_services ?? matrix.gates?.requiredServices,
        `profile ${profile.name}`
      );
      const disabledRequiredServices = requiredServices.filter((service) => config.roles?.enabled?.[service] !== true);

      if (!profile.stack_id && !profile.stackId) {
        profileWarnings.push("profile has no explicit stack_id; using profile name");
      }
      if (disabledRequiredServices.length > 0) {
        failures.push(
          `profile ${profile.name} has disabled required service defaults: ${disabledRequiredServices.join(", ")}`
        );
      }
      if (!targetRepoPath) {
        const message = `profile ${profile.name} has no target_repo_path`;
        if (requireTargets || profile.require_target_path === true || profile.requireTargetPath === true) {
          failures.push(message);
        } else {
          profileWarnings.push(message);
        }
      } else if (!fs.existsSync(targetRepoPath)) {
        const message = `profile ${profile.name} target_repo_path does not exist: ${targetRepoPath}`;
        if (requireTargets || profile.require_target_path === true || profile.requireTargetPath === true) {
          failures.push(message);
        } else {
          profileWarnings.push(message);
        }
      }

      if (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65535) {
        failures.push(`profile ${profile.name} has invalid dashboard port: ${config.dashboard.port}`);
      }

      return {
        name: profile.name,
        phase: profile.phase,
        ok: true,
        repoConfigPath: profile.repoConfigPath,
        repoKey: config.repo.key,
        githubSlug: config.repo.github_slug,
        targetMode: config.lifecycle.target_mode,
        targetName: config.lifecycle.target_name,
        stackId: stack.stackId,
        stateRoot: stack.stateRoot,
        composeProjectName: String(profile.compose_project_name ?? profile.composeProjectName ?? stack.stackId),
        dashboardPort,
        targetRepoPath,
        requiredServices,
        warnings: profileWarnings
      };
    });
  });

  const duplicateStack = findDuplicate(results.map((profile) => profile.stackId).filter(Boolean));
  if (duplicateStack) {
    failures.push(`duplicate stack identity: ${duplicateStack}`);
  }

  const duplicateComposeProject = findDuplicate(results.map((profile) => profile.composeProjectName).filter(Boolean));
  if (duplicateComposeProject) {
    failures.push(`duplicate compose project name: ${duplicateComposeProject}`);
  }

  const enabledDashboardPorts = results
    .filter((profile) => Number.isInteger(profile.dashboardPort))
    .map((profile) => profile.dashboardPort);
  const duplicateDashboardPort = findDuplicate(enabledDashboardPorts);
  if (duplicateDashboardPort) {
    failures.push(`duplicate dashboard port: ${duplicateDashboardPort}`);
  }

  for (const profile of results) {
    warnings.push(...(profile.warnings ?? []).map((warning) => `${profile.name}: ${warning}`));
  }

  return {
    ok: failures.length === 0,
    check: "deployment-readiness",
    matrixPath: absoluteMatrixPath,
    checkedAt: new Date().toISOString(),
    profileCount: results.length,
    phases: [...new Set(results.map((profile) => profile.phase))].sort(),
    profiles: results,
    warnings,
    failures
  };
}

function renderHuman(summary) {
  const lines = [];
  lines.push(`Deployment readiness ${summary.ok ? "passed" : "failed"}: ${summary.profileCount} profile(s) checked`);
  for (const profile of summary.profiles) {
    lines.push(
      `- ${profile.name} [${profile.phase}] repo=${profile.githubSlug ?? "-"} stack=${profile.stackId ?? "-"} dashboard=${profile.dashboardPort ?? "-"}`
    );
  }
  for (const warning of summary.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const failure of summary.failures) {
    lines.push(`failure: ${failure}`);
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = evaluatePredeployMatrix(options.matrixPath, {
      profiles: options.profiles,
      phases: options.phases,
      requireTargets: options.requireTargets
    });
    process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : renderHuman(summary));
    process.exit(summary.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
