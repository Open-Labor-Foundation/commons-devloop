import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadConfig } from "./config.mjs";
import { resolveStackIdentity } from "./state.mjs";

export const DEFAULT_READINESS_PROFILE = "qa";
export const DEFAULT_READINESS_PROFILES_FILE = "config/deployment-readiness.yaml";

const REQUIRED_SERVICES = [
  "autonomous",
  "dispatcher",
  "validator",
  "reviewer",
  "runner-manager",
  "pr-manager",
  "monitor",
  "dashboard"
];

const COMPOSE_PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function resolvePathFromRoot(repoRoot, value) {
  if (!value) {
    return null;
  }
  return path.resolve(repoRoot, String(value));
}

function readFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function normalizeProfileEntry(name, entry) {
  const profile = asObject(entry);
  return {
    ...profile,
    name: String(profile.name ?? name ?? DEFAULT_READINESS_PROFILE)
  };
}

function profileConfigValue(profile, snakeKey, camelKey) {
  return profile[snakeKey] ?? profile[camelKey];
}

export function buildDefaultReadinessProfile({ repoRoot = process.cwd(), env = process.env, overrides = {} } = {}) {
  const inheritEnv = overrides.inherit_env === true;
  const configFile = inheritEnv ? env.AE_REPO_CONFIG_FILE || "commons-devloop.yaml" : "commons-devloop.yaml";
  const configPath = inheritEnv
    ? env.AE_REPO_CONFIG || path.join("config", "repos", configFile)
    : path.join("config", "repos", configFile);
  return {
    name: DEFAULT_READINESS_PROFILE,
    config: configPath,
    target_path: inheritEnv ? env.AE_TARGET_REPO_PATH || repoRoot : repoRoot,
    state_dir: inheritEnv ? env.AE_STATE_DIR || "/engine/state" : "/engine/state",
    dashboard_port: inheritEnv ? env.AE_DASHBOARD_PORT : null,
    stack_id: inheritEnv ? env.AE_STACK_ID : null,
    compose_project_name: inheritEnv ? env.COMPOSE_PROJECT_NAME : null,
    inherit_env: inheritEnv,
    ...overrides
  };
}

export function loadReadinessProfilesFile(filePath, { repoRoot = process.cwd() } = {}) {
  const absolutePath = resolvePathFromRoot(repoRoot, filePath);
  const raw = readFileIfExists(absolutePath);
  if (raw == null) {
    throw new Error(`Readiness profiles file does not exist: ${absolutePath}`);
  }

  const parsed = YAML.parse(raw);
  const profilesNode = parsed?.profiles ?? parsed;
  let profiles = [];

  if (Array.isArray(profilesNode)) {
    profiles = profilesNode.map((profile, index) =>
      normalizeProfileEntry(profile?.name ?? `profile-${index + 1}`, profile)
    );
  } else if (profilesNode && typeof profilesNode === "object") {
    profiles = Object.entries(profilesNode).map(([name, profile]) => normalizeProfileEntry(name, profile));
  }

  if (profiles.length === 0) {
    throw new Error(`Readiness profiles file has no profiles: ${absolutePath}`);
  }

  return profiles;
}

export function resolveReadinessProfiles({
  repoRoot = process.cwd(),
  env = process.env,
  profilesFile = null,
  selectedProfiles = [],
  overrides = {}
} = {}) {
  const defaultProfilesPath = path.join(repoRoot, DEFAULT_READINESS_PROFILES_FILE);
  const requestedProfilesFile = profilesFile
    ? resolvePathFromRoot(repoRoot, profilesFile)
    : fs.existsSync(defaultProfilesPath)
      ? defaultProfilesPath
      : null;

  let profiles = requestedProfilesFile
    ? loadReadinessProfilesFile(requestedProfilesFile, { repoRoot })
    : [buildDefaultReadinessProfile({ repoRoot, env, overrides })];

  const selected = new Set(asArray(selectedProfiles).map((name) => String(name)));
  if (selected.size > 0) {
    profiles = profiles.filter((profile) => selected.has(profile.name));
    const found = new Set(profiles.map((profile) => profile.name));
    const missing = [...selected].filter((name) => !found.has(name));
    if (missing.length > 0) {
      throw new Error(`Unknown readiness profile: ${missing.join(", ")}`);
    }
  }

  return profiles;
}

function buildProfileEnv(baseEnv, profile, configPath, dashboardPort) {
  const profileEnv = {
    ...(profile.inherit_env === true ? baseEnv : {}),
    ...asObject(profile.env),
    AE_REPO_CONFIG: configPath
  };
  const stateDir = profileConfigValue(profile, "state_dir", "stateDir");
  const workspaceDir = profileConfigValue(profile, "workspace_dir", "workspaceDir");
  const stackId = profileConfigValue(profile, "stack_id", "stackId");
  const composeProjectName = profileConfigValue(profile, "compose_project_name", "composeProjectName");

  if (stateDir != null) {
    profileEnv.AE_STATE_DIR = String(stateDir);
  }
  if (workspaceDir != null) {
    profileEnv.AE_WORKSPACE_DIR = String(workspaceDir);
  }
  if (stackId != null) {
    profileEnv.AE_STACK_ID = String(stackId);
  }
  if (composeProjectName != null) {
    profileEnv.COMPOSE_PROJECT_NAME = String(composeProjectName);
  }
  if (dashboardPort != null) {
    profileEnv.AE_DASHBOARD_PORT = String(dashboardPort);
  }

  return profileEnv;
}

function addProfileError(profileResult, message) {
  profileResult.errors.push(message);
  profileResult.ok = false;
}

function addCollisionErrors(result, key, label) {
  const byValue = new Map();
  for (const profile of result.profiles) {
    const value = profile[key];
    if (value == null || value === "") {
      continue;
    }
    const bucket = byValue.get(value) ?? [];
    bucket.push(profile);
    byValue.set(value, bucket);
  }

  for (const [value, profiles] of byValue.entries()) {
    if (profiles.length < 2) {
      continue;
    }
    const names = profiles.map((profile) => profile.name).join(", ");
    const message = `Duplicate ${label} "${value}" used by profiles: ${names}`;
    result.errors.push(message);
    for (const profile of profiles) {
      addProfileError(profile, message);
    }
  }
}

function validateTargetPath(profileResult) {
  if (!profileResult.targetPath) {
    addProfileError(profileResult, "target path is required");
    return;
  }
  if (!fs.existsSync(profileResult.targetPath)) {
    addProfileError(profileResult, `target path does not exist: ${profileResult.targetPath}`);
    return;
  }
  const stat = fs.statSync(profileResult.targetPath);
  if (!stat.isDirectory()) {
    addProfileError(profileResult, `target path is not a directory: ${profileResult.targetPath}`);
  }
}

function validateDashboardPort(profileResult) {
  if (!Number.isInteger(profileResult.dashboardPort)) {
    addProfileError(profileResult, "dashboard port must be an integer");
    return;
  }
  if (profileResult.dashboardPort < 1 || profileResult.dashboardPort > 65535) {
    addProfileError(profileResult, `dashboard port is outside 1-65535: ${profileResult.dashboardPort}`);
  }
}

function validateComposeProjectName(profileResult) {
  if (!profileResult.composeProjectName) {
    addProfileError(profileResult, "compose project name is required");
    return;
  }
  if (!COMPOSE_PROJECT_NAME_PATTERN.test(profileResult.composeProjectName)) {
    addProfileError(
      profileResult,
      `compose project name must match ${COMPOSE_PROJECT_NAME_PATTERN}: ${profileResult.composeProjectName}`
    );
  }
}

function validateRequiredServices(profileResult, config) {
  for (const service of REQUIRED_SERVICES) {
    if (config.roles.enabled?.[service] !== true) {
      addProfileError(profileResult, `required service is not enabled by default: ${service}`);
    }
  }
}

function checkOneProfile(profile, { repoRoot, env }) {
  const name = String(profile.name || DEFAULT_READINESS_PROFILE);
  const inheritedEnv = profile.inherit_env === true ? env : {};
  const configInput = profileConfigValue(profile, "config", "configPath") || inheritedEnv.AE_REPO_CONFIG;
  const configPath =
    resolvePathFromRoot(repoRoot, configInput) ||
    path.join(repoRoot, "config", "repos", inheritedEnv.AE_REPO_CONFIG_FILE || "commons-devloop.yaml");
  const targetPath = resolvePathFromRoot(
    repoRoot,
    profileConfigValue(profile, "target_path", "targetPath") || inheritedEnv.AE_TARGET_REPO_PATH || repoRoot
  );
  const stateDir = path.resolve(
    repoRoot,
    profileConfigValue(profile, "state_dir", "stateDir") || inheritedEnv.AE_STATE_DIR || "/engine/state"
  );
  const requestedDashboardPort = profileConfigValue(profile, "dashboard_port", "dashboardPort");
  const profileEnv = buildProfileEnv(env, profile, configPath, requestedDashboardPort);
  const result = {
    name,
    ok: true,
    configPath,
    repoKey: null,
    githubSlug: null,
    targetPath,
    stateDir,
    stackId: null,
    stackSource: null,
    composeProjectName: null,
    dashboardPort: null,
    enabledServices: [],
    warnings: [],
    errors: []
  };

  if (!fs.existsSync(configPath)) {
    addProfileError(result, `config file does not exist: ${configPath}`);
    return result;
  }

  try {
    const config = loadConfig(configPath, { env: profileEnv });
    const dashboardPort =
      asInteger(requestedDashboardPort) ??
      asInteger(profileEnv.AE_DASHBOARD_PORT) ??
      config.dashboard.port;
    const stack = resolveStackIdentity(stateDir, config.repo.key, repoRoot, profileEnv);
    const composeProjectName =
      profileConfigValue(profile, "compose_project_name", "composeProjectName") ||
      profileEnv.COMPOSE_PROJECT_NAME ||
      stack.stackId;

    result.repoKey = config.repo.key;
    result.githubSlug = config.repo.github_slug;
    result.stackId = stack.stackId;
    result.stackSource = stack.source;
    result.composeProjectName = String(composeProjectName);
    result.dashboardPort = dashboardPort;
    result.enabledServices = REQUIRED_SERVICES.filter((service) => config.roles.enabled?.[service] === true);

    validateTargetPath(result);
    validateDashboardPort(result);
    validateComposeProjectName(result);
    validateRequiredServices(result, config);
  } catch (error) {
    addProfileError(result, `config validation failed: ${error.message}`);
  }

  return result;
}

export function checkDeploymentReadiness({ profiles, repoRoot = process.cwd(), env = process.env } = {}) {
  const resolvedProfiles = asArray(profiles).length > 0
    ? profiles
    : resolveReadinessProfiles({ repoRoot, env });
  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    profiles: resolvedProfiles.map((profile) => checkOneProfile(profile, { repoRoot, env })),
    warnings: [],
    errors: []
  };

  addCollisionErrors(result, "stackId", "stack id");
  addCollisionErrors(result, "composeProjectName", "compose project name");
  addCollisionErrors(result, "dashboardPort", "dashboard port");

  result.ok = result.profiles.every((profile) => profile.ok) && result.errors.length === 0;
  return result;
}

export function formatReadinessHuman(result) {
  const lines = [];
  const passed = result.ok ? "passed" : "failed";
  lines.push(`Deployment readiness check ${passed} for ${result.profiles.length} profile(s).`);

  for (const profile of result.profiles) {
    lines.push("");
    lines.push(`- ${profile.name}: ${profile.ok ? "ok" : "failed"}`);
    lines.push(`  config: ${profile.configPath}`);
    if (profile.repoKey) {
      lines.push(`  repo: ${profile.repoKey} (${profile.githubSlug})`);
    }
    if (profile.targetPath) {
      lines.push(`  target path: ${profile.targetPath}`);
    }
    if (profile.stackId) {
      lines.push(`  stack id: ${profile.stackId}`);
    }
    if (profile.composeProjectName) {
      lines.push(`  compose project: ${profile.composeProjectName}`);
    }
    if (profile.dashboardPort != null) {
      lines.push(`  dashboard port: ${profile.dashboardPort}`);
    }
    if (profile.enabledServices.length > 0) {
      lines.push(`  services: ${profile.enabledServices.join(", ")}`);
    }
    for (const warning of profile.warnings) {
      lines.push(`  warning: ${warning}`);
    }
    for (const error of profile.errors) {
      lines.push(`  error: ${error}`);
    }
  }

  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const error of result.errors) {
    lines.push(`error: ${error}`);
  }

  return `${lines.join("\n")}\n`;
}
