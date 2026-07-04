import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const sessionsRoot = path.join(codexHome, "sessions");
const tmpRoot = os.tmpdir();
const ACTIVE_CODEX_HOME_PREFIXES = [
  "commons-devloop-dispatcher-",
  "commons-devloop-reviewer-pr-"
];

function collectSessionFiles(rootDir, files) {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      try {
        const stats = fs.statSync(fullPath);
        files.push({ path: fullPath, mtimeMs: stats.mtimeMs });
      } catch {}
    }
  }
}

function listActiveSessionRoots() {
  let entries = [];
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => ACTIVE_CODEX_HOME_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .map((name) => path.join(tmpRoot, name, "sessions"));
}

function listRecentSessionFiles(maxFiles) {
  const files = [];
  collectSessionFiles(sessionsRoot, files);
  for (const root of listActiveSessionRoots()) {
    collectSessionFiles(root, files);
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .map((entry) => entry.path);
}

function matchRateLimit(rateLimit, { limitId, limitName }) {
  if (!rateLimit || typeof rateLimit !== "object") {
    return false;
  }

  if (limitId && rateLimit.limit_id === limitId) {
    return true;
  }

  if (limitName && rateLimit.limit_name === limitName) {
    return true;
  }

  return false;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sessionIncludesModel(lines, model) {
  if (!model) {
    return false;
  }

  const pattern = new RegExp(`"model"\\s*:\\s*"${escapeRegExp(model)}"`, "i");
  return lines.some((line) => pattern.test(line));
}

function parseCandidate(line, matcher, context = {}) {
  if (!line.includes("\"rate_limits\"")) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    const rateLimit = parsed?.payload?.rate_limits;
    const explicitMatch = matchRateLimit(rateLimit, matcher);
    const modelScopedGenericMatch =
      Boolean(matcher.model) &&
      context.sessionHasModel === true &&
      rateLimit?.limit_id === "codex";

    if (!explicitMatch && !modelScopedGenericMatch) {
      return null;
    }

    const timestamp = parsed?.timestamp ? Date.parse(parsed.timestamp) : NaN;
    const usedPercent = Number(rateLimit?.primary?.used_percent);
    const windowMinutes = Number(rateLimit?.primary?.window_minutes);
    const resetsAtEpoch = Number(rateLimit?.primary?.resets_at);
    const secondaryUsedPercent = Number(rateLimit?.secondary?.used_percent);
    const secondaryWindowMinutes = Number(rateLimit?.secondary?.window_minutes);
    const secondaryResetsAtEpoch = Number(rateLimit?.secondary?.resets_at);

    return {
      timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
      limitId: rateLimit?.limit_id ?? null,
      limitName: rateLimit?.limit_name ?? null,
      usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
      remainingPercent: Number.isFinite(usedPercent) ? Math.max(0, 100 - usedPercent) : null,
      windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
      resetsAt: Number.isFinite(resetsAtEpoch) ? new Date(resetsAtEpoch * 1000).toISOString() : null,
      resetsAtEpoch: Number.isFinite(resetsAtEpoch) ? resetsAtEpoch : null,
      secondaryUsedPercent: Number.isFinite(secondaryUsedPercent) ? secondaryUsedPercent : null,
      secondaryRemainingPercent: Number.isFinite(secondaryUsedPercent)
        ? Math.max(0, 100 - secondaryUsedPercent)
        : null,
      secondaryWindowMinutes: Number.isFinite(secondaryWindowMinutes) ? secondaryWindowMinutes : null,
      secondaryResetsAt: Number.isFinite(secondaryResetsAtEpoch)
        ? new Date(secondaryResetsAtEpoch * 1000).toISOString()
        : null,
      secondaryResetsAtEpoch: Number.isFinite(secondaryResetsAtEpoch) ? secondaryResetsAtEpoch : null,
      matchedBy: explicitMatch ? "limit" : "generic-model",
      model: matcher.model ?? null,
      raw: rateLimit
    };
  } catch {
    return null;
  }
}

function normalizeResetWindow(usedPercent, windowMinutes, resetsAtEpoch) {
  if (
    !Number.isFinite(usedPercent) ||
    !Number.isFinite(windowMinutes) ||
    !Number.isFinite(resetsAtEpoch)
  ) {
    return {
      usedPercent,
      remainingPercent: Number.isFinite(usedPercent) ? Math.max(0, 100 - usedPercent) : null,
      resetsAtEpoch
    };
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  if (nowEpoch < resetsAtEpoch) {
    return {
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetsAtEpoch
    };
  }

  const windowSeconds = Math.max(60, Math.floor(windowMinutes * 60));
  const elapsedWindows = Math.floor((nowEpoch - resetsAtEpoch) / windowSeconds) + 1;
  const nextResetEpoch = resetsAtEpoch + elapsedWindows * windowSeconds;

  return {
    usedPercent: 0,
    remainingPercent: 100,
    resetsAtEpoch: nextResetEpoch,
    inferred: true
  };
}

function normalizeCandidate(candidate) {
  if (!candidate) {
    return candidate;
  }

  const primary = normalizeResetWindow(
    candidate.usedPercent,
    candidate.windowMinutes,
    candidate.resetsAtEpoch
  );
  const secondary = normalizeResetWindow(
    candidate.secondaryUsedPercent,
    candidate.secondaryWindowMinutes,
    candidate.secondaryResetsAtEpoch
  );

  return {
    ...candidate,
    usedPercent: primary.usedPercent,
    remainingPercent: primary.remainingPercent,
    resetsAtEpoch: primary.resetsAtEpoch,
    resetsAt: Number.isFinite(primary.resetsAtEpoch)
      ? new Date(primary.resetsAtEpoch * 1000).toISOString()
      : candidate.resetsAt,
    secondaryUsedPercent: secondary.usedPercent,
    secondaryRemainingPercent: secondary.remainingPercent,
    secondaryResetsAtEpoch: secondary.resetsAtEpoch,
    secondaryResetsAt: Number.isFinite(secondary.resetsAtEpoch)
      ? new Date(secondary.resetsAtEpoch * 1000).toISOString()
      : candidate.secondaryResetsAt,
    inferredFromReset: Boolean(primary.inferred) || Boolean(secondary.inferred)
  };
}

function parseUsageLimitReset(text) {
  const match = String(text).match(/try again at ([0-9]{1,2}):([0-9]{2})\s*([AP]M)/i);
  if (!match) {
    return null;
  }

  const now = new Date();
  let hour = Number(match[1]) % 12;
  const minute = Number(match[2]);
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM") {
    hour += 12;
  }

  const reset = new Date(now);
  reset.setSeconds(0, 0);
  reset.setHours(hour, minute, 0, 0);
  if (reset.getTime() <= now.getTime()) {
    reset.setDate(reset.getDate() + 1);
  }
  return reset.toISOString();
}

export function readRecentUsageLimitOverride(options = {}) {
  const model = String(options.model ?? "").trim().toLowerCase();
  const logPath = options.logPath ? path.resolve(options.logPath) : null;
  const lookbackMs = Number(options.lookbackMs ?? 30 * 60 * 1000);

  if (!model || !logPath || !fs.existsSync(logPath)) {
    return null;
  }

  let text = "";
  let mtimeMs = 0;
  try {
    const stats = fs.statSync(logPath);
    mtimeMs = stats.mtimeMs;
    text = fs.readFileSync(logPath, "utf8");
  } catch {
    return null;
  }

  if (Date.now() - mtimeMs > lookbackMs) {
    return null;
  }

  const usageLimitLine = text
    .split("\n")
    .reverse()
    .find((line) => {
      const lower = line.toLowerCase();
      return lower.includes("you've hit your usage limit") && lower.includes(model);
    });
  if (!usageLimitLine) {
    return null;
  }

  return {
    source: "dispatcher-run-log",
    model,
    remainingPercent: 0,
    usedPercent: 100,
    resetsAt: parseUsageLimitReset(usageLimitLine),
    telemetryAt: mtimeMs
  };
}

export function readLatestCodexRateLimit(options = {}) {
  const matcher = {
    limitId:
      options.limitId
      ?? (options.model || options.limitName ? null : "codex"),
    limitName: options.limitName ?? null,
    model: options.model ?? null
  };
  const maxFiles = Number(options.maxFiles ?? 80);
  const maxLines = Number(options.maxLines ?? 160);
  const files = listRecentSessionFiles(maxFiles);
  let bestExplicit = null;
  let bestGeneric = null;

  for (const filePath of files) {
    let lines = [];

    try {
      lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    } catch {
      continue;
    }

    const sessionHasModel = sessionIncludesModel(lines.slice(-maxLines), matcher.model);
    const recentLines = lines.slice(-maxLines);

    for (const line of recentLines) {
      const candidate = parseCandidate(line, matcher, { sessionHasModel });
      if (!candidate) {
        continue;
      }

      const normalized = normalizeCandidate(candidate);
      if (normalized.matchedBy === "limit") {
        if (!bestExplicit || normalized.timestamp > bestExplicit.timestamp) {
          bestExplicit = normalized;
        }
        continue;
      }

      if (!bestGeneric || normalized.timestamp > bestGeneric.timestamp) {
        bestGeneric = normalized;
      }
    }
  }

  return bestExplicit ?? bestGeneric;
}
