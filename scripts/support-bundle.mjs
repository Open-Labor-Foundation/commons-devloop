#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import YAML from "yaml";

import { loadConfig, loadRawConfig } from "./lib/config.mjs";
import { resolveStackIdentity, getRepoPaths } from "./lib/state.mjs";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = "commons-devloop.support-bundle.v1";
const DEFAULT_LOG_LINES = 200;
const REDACTED_VALUE = "[REDACTED]";
const VALID_FORMATS = ["json", "zip", "tar"];

const KEY_REPLACERS = [
  /token/i,
  /secret/i,
  /password/i,
  /api[_-]?key/i,
  /access[_-]?token/i,
  /auth[_-]?token/i,
  /client[_-]?secret/i
];

function isSecretKey(name) {
  return KEY_REPLACERS.some((pattern) => pattern.test(String(name ?? "")));
}

function redactTokenPatterns(value) {
  let text = String(value);
  const replacements = [
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gi,
    /\bsk-[A-Za-z0-9]{20,}\b/gi,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g,
    /\bauthorization\s*[:=]\s*[^\s]+/gi,
    /([A-Za-z0-9_]*)(?:_)?(token|secret|password|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*[^\r\n\s]+/gi
  ];

  for (const pattern of replacements) {
    text = text.replace(pattern, (match) => {
      if (match.includes("=") || match.includes(":")) {
        const separator = match.includes("=") ? "=" : ":";
        return match.split(separator)[0] + `${separator}${REDACTED_VALUE}`;
      }
      return REDACTED_VALUE;
    });
  }
  return text;
}

export function redactText(value) {
  return redactTokenPatterns(value);
}

function redactValue(value, key) {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, key));
  }
  if (typeof value !== "string") {
    if (typeof value === "object") {
      return redactObject(value);
    }
    return value;
  }

  const redacted = redactTokenPatterns(value);
  return isSecretKey(key) ? REDACTED_VALUE : redacted;
}

export function redactObject(value) {
  if (value == null || typeof value !== "object") {
    return redactValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) {
      result[key] = REDACTED_VALUE;
      continue;
    }
    result[key] = redactValue(item, key);
  }
  return result;
}

function usage() {
  process.stderr.write(`Usage: node scripts/support-bundle.mjs [options]

Options:
  --config PATH         Repo config file path (required, or AE_REPO_CONFIG)
  --state-dir PATH      State root (defaults to AE_STATE_DIR or /engine/state)
  --env-file PATH       .env file to summarize and redact (defaults to .env)
  --repo-key KEY        Repo key override when config has no key
  --logs-lines COUNT    Number of lines per log file (default: ${DEFAULT_LOG_LINES})
  --out PATH            Write support bundle to a file
  --format json|zip|tar Output format (default: json)
  --json                Alias for --format json
  --zip                 Alias for --format zip
  --tar                 Alias for --format tar
  --help                Show this help text

Environment:
  AE_REPO_CONFIG
  AE_STATE_DIR
  AE_STACK_ID
  AE_ENGINE_IMAGE
  AE_DASHBOARD_PORT
  AE_RELEASE_VERSION
`);
}

function readOptionValue(argv, index, arg) {
  const eqIndex = arg.indexOf("=");
  if (eqIndex !== -1) {
    return {
      value: arg.slice(eqIndex + 1),
      nextIndex: index
    };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return {
    value,
    nextIndex: index + 1
  };
}

export function parseArgs(argv, env = process.env) {
  const options = {
    configPath: env.AE_REPO_CONFIG ?? null,
    stateDir: env.AE_STATE_DIR ?? "/engine/state",
    envFile: ".env",
    repoKey: null,
    out: null,
    format: "json",
    logsLines: DEFAULT_LOG_LINES,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--config": {
        const result = readOptionValue(argv, index, arg);
        options.configPath = result.value;
        index = result.nextIndex;
        break;
      }
      case "--state-dir": {
        const result = readOptionValue(argv, index, arg);
        options.stateDir = result.value;
        index = result.nextIndex;
        break;
      }
      case "--env-file": {
        const result = readOptionValue(argv, index, arg);
        options.envFile = result.value;
        index = result.nextIndex;
        break;
      }
      case "--repo-key": {
        const result = readOptionValue(argv, index, arg);
        options.repoKey = result.value;
        index = result.nextIndex;
        break;
      }
      case "--logs-lines": {
        const result = readOptionValue(argv, index, arg);
        const count = Number(result.value);
        options.logsLines = Number.isFinite(count) && count > 0 ? Math.floor(count) : options.logsLines;
        index = result.nextIndex;
        break;
      }
      case "--out":
        {
          const result = readOptionValue(argv, index, arg);
          options.out = result.value;
          index = result.nextIndex;
        }
        break;
      case "--format": {
        const result = readOptionValue(argv, index, arg);
        if (!VALID_FORMATS.includes(result.value)) {
          throw new Error(`Unsupported format: ${result.value}`);
        }
        options.format = result.value;
        index = result.nextIndex;
        break;
      }
      case "--json":
        options.format = "json";
        break;
      case "--zip":
        options.format = "zip";
        break;
      case "--tar":
        options.format = "tar";
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function validateOptions(options) {
  if (!options.configPath) {
    throw new Error("Missing required input: --config or AE_REPO_CONFIG");
  }

  if (!VALID_FORMATS.includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }

  if (!["json", "zip", "tar"].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseEnvFile(filePath, repoRoot) {
  const summary = {
    source: path.relative(repoRoot, filePath).split(path.sep).join("/"),
    present: false,
    redactedLines: [],
    entries: {}
  };

  const raw = safeReadFile(filePath);
  if (raw == null) {
    return summary;
  }

  summary.present = true;
  summary.redactedLines = raw.split(/\r?\n/).map((line) => {
    const match = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) {
      return redactText(line);
    }

    const [, exportPrefix, key, value] = match;
    const redactedValue = isSecretKey(key) ? REDACTED_VALUE : redactText(value.trim());
    const sanitizedValue = redactedValue || "";
    const keyPrefix = `${exportPrefix ?? ""}${key}=`;
    const quote = value.startsWith("\"") && value.endsWith("\"")
      ? "\""
      : value.startsWith("'") && value.endsWith("'")
        ? "'"
        : "";
    const nextValue = redactedValue === REDACTED_VALUE && quote === "" ? REDACTED_VALUE : `${quote}${sanitizedValue}${quote}`;
    summary.entries[key] = redactedValue;
    return `${keyPrefix}${nextValue}`;
  });
  return summary;
}

function loadConfigSummary(configPath, repoRoot, env) {
  const absoluteConfigPath = path.resolve(repoRoot, configPath);
  const raw = safeReadFile(absoluteConfigPath);
  const summary = {
    source: path.relative(repoRoot, absoluteConfigPath).split(path.sep).join("/"),
    exists: raw != null,
    raw: null,
    normalized: null,
    parseError: null
  };

  if (raw == null) {
    summary.parseError = "Config file not found";
    return summary;
  }

  try {
    const parsed = loadRawConfig(absoluteConfigPath);
    summary.raw = redactObject(parsed);
    try {
      summary.normalized = redactObject(loadConfig(absoluteConfigPath, { env }));
    } catch {
      summary.normalized = null;
    }
  } catch (error) {
    summary.parseError = error.message;
  }
  return summary;
}

function readGitInfo(repoRoot) {
  try {
    const commit = execSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    const status = execSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return {
      commit,
      dirty: status.length > 0
    };
  } catch {
    return {
      commit: null,
      dirty: null
    };
  }
}

function readComposeMetadata(repoRoot) {
  const composePath = path.join(repoRoot, "compose.yaml");
  const raw = safeReadFile(composePath);
  if (raw == null) {
    return null;
  }

  try {
    const parsed = YAML.parse(raw);
    const services = parsed?.services;
    if (!services || typeof services !== "object") {
      return null;
    }

    const imageMetadata = {};
    for (const [serviceName, serviceValue] of Object.entries(services)) {
      const image = serviceValue?.image;
      if (typeof image === "string" && image) {
        imageMetadata[serviceName] = image;
      }
    }

    return {
      source: "compose.yaml",
      services: imageMetadata
    };
  } catch {
    return null;
  }
}

function readPackageMetadata(repoRoot) {
  const packagePath = path.join(repoRoot, "package.json");
  const raw = safeReadFile(packagePath);
  if (raw == null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      name: parsed.name ?? null,
      version: parsed.version ?? null,
      private: parsed.private ?? null
    };
  } catch {
    return null;
  }
}

function readTail(pathToLog, lines, summary) {
  const raw = safeReadFile(pathToLog);
  if (raw == null) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((entry) => entry.trim() !== "")
    .slice(-lines)
    .map(redactText);
}

function collectRecentLogs(logDir, lines) {
  const summary = [];
  let files = [];
  try {
    files = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return summary;
  }

  for (const entry of files) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".log")) {
      continue;
    }
    const logPath = path.join(logDir, entry.name);
    const content = readTail(logPath, lines);
    summary.push({
      path: path.relative(path.dirname(logDir), logPath).split(path.sep).join("/"),
      lines: content,
      lineCount: content.length
    });
  }

  return summary;
}

function collectServiceData(metaDir, logsLines) {
  const serviceStates = {};
  const serviceConfigs = {};
  let fileError = null;

  let entries = [];
  try {
    entries = fs.readdirSync(metaDir, { withFileTypes: true });
  } catch {
    return {
      states: {},
      configs: {},
      error: "Service metadata directory missing."
    };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const entryPath = path.join(metaDir, entry.name);
    const key = entry.name;
    const parsed = safeReadJson(entryPath, null);
    if (parsed == null) {
      fileError ??= `Failed to read ${entry.name}`;
      continue;
    }

    if (key === "control.json" || key === "repo-state.json") {
      continue;
    }
    if (key.endsWith("-config.json")) {
      const serviceName = key.slice(0, -"-config.json".length);
      serviceConfigs[serviceName] = redactObject(parsed);
      continue;
    }
    if (key.endsWith(".json")) {
      const serviceName = key.slice(0, -".json".length);
      serviceStates[serviceName] = redactObject(parsed);
    }
  }

  return {
    states: serviceStates,
    configs: serviceConfigs,
    error: fileError
  };
}

function collectWorktreeInfo(worktreeRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(worktreeRoot, { withFileTypes: true });
  } catch {
    return {
      included: false,
      entryCount: 0
    };
  }

  return {
    included: false,
    entryCount: entries.length
  };
}

function resolveRepoPaths(stateDir, repoKey, repoRoot, env) {
  const stateDirRoot = path.resolve(stateDir);
  const stackIdentity = resolveStackIdentity(stateDirRoot, repoKey, repoRoot, env);
  const stateRoot = path.resolve(stackIdentity.stateRoot);
  const repoRootPath = path.join(stateRoot, "repos", repoKey);
  return {
    stateRoot,
    root: repoRootPath,
    meta: path.join(repoRootPath, "meta"),
    logs: path.join(repoRootPath, "logs"),
    worktrees: path.join(repoRootPath, "worktrees"),
    outputs: path.join(repoRootPath, "outputs"),
    runLogs: path.join(repoRootPath, "run-logs"),
    repoState: path.join(repoRootPath, "repo-state.json"),
    control: path.join(repoRootPath, "meta", "control.json")
  };
}

function buildServiceData(bundleInput) {
  const {
    repoRoot,
    paths,
    env,
    logsLines
  } = bundleInput;
  const serviceFiles = collectServiceData(paths.meta);
  return {
    states: paths.meta ? serviceFiles.states : {},
    configs: paths.meta ? serviceFiles.configs : {},
    serviceErrors: paths.meta ? serviceFiles.error : null,
    recentLogs: collectRecentLogs(paths.logs, logsLines),
    controlState: redactObject(loadRepoControlStateSafe(paths.control)),
    repoState: redactObject(loadRepoStateSafe(paths.repoState)),
    worktrees: collectWorktreeInfo(paths.worktrees),
    pathHints: {
      repoRoot: path.relative(repoRoot, paths.root).split(path.sep).join("/"),
      logs: path.relative(repoRoot, paths.logs).split(path.sep).join("/"),
      meta: path.relative(repoRoot, paths.meta).split(path.sep).join("/"),
      runLogs: path.relative(repoRoot, paths.runLogs).split(path.sep).join("/")
    }
  };
}

function loadRepoStateSafe(filePath) {
  return safeReadJson(filePath, {
    status: "unavailable",
    services: {},
    remediationRecords: []
  });
}

function loadRepoControlStateSafe(filePath) {
  return safeReadJson(filePath, {
    manualPause: null,
    desiredServices: {}
  });
}

export function buildSupportBundle(options) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const logsLines = Math.max(1, Number(options.logsLines) || DEFAULT_LOG_LINES);
  const stateDir = path.resolve(repoRoot, options.stateDir ?? "/engine/state");
  const configPath = options.configPath ?? null;
  const warnings = [];

  if (!configPath) {
    throw new Error("configPath is required");
  }

  const configSummary = loadConfigSummary(configPath, repoRoot, env);
  const resolvedConfigPath = path.resolve(repoRoot, configPath);
  const repoKey = (options.repoKey
    || configSummary.normalized?.repo?.key
    || configSummary.raw?.repo?.key
    || "unknown");
  const effectiveEnv = {
    ...env,
    AE_STACK_ID: env.AE_STACK_ID ?? null
  };

  if (configSummary.parseError) {
    warnings.push(`Config parse warning: ${configSummary.parseError}`);
  }
  if (!configSummary.exists) {
    warnings.push(`Config file is missing: ${configPath}`);
  }

  const stackIdentity = resolveStackIdentity(stateDir, repoKey, repoRoot, effectiveEnv);
  const paths = resolveRepoPaths(stateDir, repoKey, repoRoot, effectiveEnv);
  const serviceData = buildServiceData({
    repoRoot,
    paths,
    logsLines
  });
  const envSummary = parseEnvFile(path.resolve(repoRoot, options.envFile ?? ".env"), repoRoot);
  if (!envSummary.present) {
    warnings.push(`Env file is missing: ${envSummary.source}`);
  }

  const versionMetadata = {
    package: readPackageMetadata(repoRoot),
    compose: readComposeMetadata(repoRoot),
    git: readGitInfo(repoRoot),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };
  if (versionMetadata.package == null) {
    delete versionMetadata.package;
  }
  if (versionMetadata.compose == null) {
    delete versionMetadata.compose;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedOn: env.AE_HOSTNAME ?? os.hostname(),
    source: {
      repoRoot: path.relative(process.cwd(), repoRoot).split(path.sep).join("/") || ".",
      configPath: path.relative(repoRoot, resolvedConfigPath).split(path.sep).join("/"),
      envFile: envSummary.source,
      stateDir: path.relative(process.cwd(), stateDir).split(path.sep).join("/") || ".",
      logsLines
    },
    stackIdentity: {
      repoKey: stackIdentity.repoKey,
      stackId: stackIdentity.stackId,
      source: stackIdentity.source,
      rawValue: stackIdentity.rawValue,
      stateRoot: stackIdentity.stateRoot
    },
    config: {
      summary: configSummary,
      path: stackIdentity.stateRoot == null ? resolvedConfigPath : path.relative(repoRoot, resolvedConfigPath).split(path.sep).join("/")
    },
    env: envSummary,
    services: {
      states: serviceData.states,
      configs: serviceData.configs
    },
    repoState: serviceData.repoState,
    controlState: serviceData.controlState,
    recentLogs: serviceData.recentLogs,
    worktrees: serviceData.worktrees,
    imageMetadata: versionMetadata,
    paths: {
      repoRoot: path.relative(stackIdentity.stateRoot, paths.root),
      logs: path.relative(stackIdentity.stateRoot, paths.logs),
      meta: path.relative(stackIdentity.stateRoot, paths.meta),
      runLogs: path.relative(stackIdentity.stateRoot, paths.runLogs)
    },
    pathHints: serviceData.pathHints,
    warnings
  };
}

function archiveJson(bundle, format, outputPath, repoRoot) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-support-bundle-"));
  const payloadPath = path.join(tempDir, "support-bundle.json");
  fs.writeFileSync(payloadPath, `${JSON.stringify(bundle, null, 2)}\n`);
  const output = path.resolve(repoRoot, outputPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const command = format === "zip"
    ? ["-q", output, "support-bundle.json"]
    : ["-cf", output, "support-bundle.json"];
  const binary = format;

  try {
    const result = spawnSync(binary, command, {
      cwd: tempDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status !== 0) {
      const stderr = String(result.stderr || "");
      throw new Error(`${binary} exited ${result.status}: ${stderr.trim()}`);
    }
    return output;
  } catch (error) {
    throw new Error(`Unable to create ${format.toUpperCase()} support bundle. Is ${binary} installed?`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

function writeOutput(bundle, options, repoRoot) {
  const output = JSON.stringify(bundle, null, 2);
  if (options.format === "json") {
    if (!options.out) {
      return {
        text: `${output}\n`,
        path: null,
        outToStdout: true
      };
    }

    const destination = path.resolve(repoRoot, options.out);
    fs.writeFileSync(destination, `${output}\n`);
    return {
      text: null,
      path: destination,
      outToStdout: false
    };
  }

  const destination = path.resolve(repoRoot, options.out ?? `support-bundle.${options.format}`);
  return {
    path: archiveJson(bundle, options.format, destination, repoRoot),
    text: null,
    outToStdout: false
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      return;
    }
    validateOptions(options);
    const bundle = buildSupportBundle({
      ...options,
      repoRoot: process.cwd(),
      env: process.env
    });
    const result = writeOutput(bundle, options, process.cwd());
    if (result.path && options.format !== "json") {
      process.stdout.write(`${path.relative(process.cwd(), result.path) || path.basename(result.path)}\n`);
      return;
    }
    if (result.path && options.format === "json") {
      process.stdout.write(`${path.relative(process.cwd(), result.path) || path.basename(result.path)}\n`);
      return;
    }
    if (result.text != null) {
      process.stdout.write(result.text);
    }
  } catch (error) {
    process.stderr.write(`support-bundle: ${error.message}\n`);
    process.stderr.write("Run with --help for usage.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
