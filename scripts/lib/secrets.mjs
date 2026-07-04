/**
 * secrets.mjs
 *
 * Per-repo, per-lane API key storage for openai_compatible dispatcher lanes
 * (e.g. a Featherless.ai key entered through the dashboard settings UI).
 * Lives under state/repos/<repo-key>/secrets.json — already-gitignored
 * runtime state, never the tracked YAML config — so a key entered via the
 * UI is never at risk of ending up in a commit.
 *
 * Resolution order, matching the same precedent already used for
 * commons-board's provider settings: a stored value (settable via the
 * dashboard) takes priority over the env var named by the lane's
 * api_key_env, so an operator can override a Docker-level env var from the
 * UI without restarting the stack.
 */

import fs from "node:fs";
import path from "node:path";

function secretsFilePath(stateDir, repoKey) {
  return path.join(stateDir, "repos", repoKey, "secrets.json");
}

function loadSecretsFile(stateDir, repoKey) {
  const filePath = secretsFilePath(stateDir, repoKey);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSecretsFile(stateDir, repoKey, secrets) {
  const filePath = secretsFilePath(stateDir, repoKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(secrets, null, 2)}\n`, "utf8", { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/** Returns the resolved API key for a lane, or "" if neither a stored value nor the env var is set. */
export function resolveLaneApiKey(stateDir, repoKey, lane) {
  const secrets = loadSecretsFile(stateDir, repoKey);
  const stored = secrets.laneApiKeys?.[lane.key];
  if (typeof stored === "string" && stored.trim()) {
    return stored.trim();
  }
  const envVar = String(lane.api_key_env ?? "").trim();
  if (envVar && process.env[envVar]) {
    return String(process.env[envVar]).trim();
  }
  return "";
}

/** Stores (or clears, when apiKey is empty) a lane's API key for the dashboard settings UI. */
export function setLaneApiKey(stateDir, repoKey, laneKey, apiKey) {
  const secrets = loadSecretsFile(stateDir, repoKey);
  secrets.laneApiKeys = secrets.laneApiKeys && typeof secrets.laneApiKeys === "object" ? secrets.laneApiKeys : {};
  const trimmed = String(apiKey ?? "").trim();
  if (trimmed) {
    secrets.laneApiKeys[laneKey] = trimmed;
  } else {
    delete secrets.laneApiKeys[laneKey];
  }
  saveSecretsFile(stateDir, repoKey, secrets);
}

/** Reports which lanes have a stored key without ever returning the key material itself. */
export function laneApiKeyStatus(stateDir, repoKey, lanes) {
  const secrets = loadSecretsFile(stateDir, repoKey);
  const stored = secrets.laneApiKeys && typeof secrets.laneApiKeys === "object" ? secrets.laneApiKeys : {};
  return Object.fromEntries(
    lanes.map((lane) => [
      lane.key,
      {
        configured: Boolean(resolveLaneApiKey(stateDir, repoKey, lane)),
        source: stored[lane.key] ? "stored" : (lane.api_key_env && process.env[lane.api_key_env] ? "env" : "none")
      }
    ])
  );
}
