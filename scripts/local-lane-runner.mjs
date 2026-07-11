import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";

const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_PULL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CHAT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_OLLAMA_DIAGNOSTIC_TIMEOUT_MS = 3000;
const DEFAULT_OLLAMA_NUM_CTX = 8192;
const DEFAULT_OLLAMA_KEEP_ALIVE = "5m";
const DEFAULT_MAX_NO_PROGRESS_TURNS = 3;
const MAX_OBSERVATION_CHARS = 8000;
const MAX_FILE_CHARS = 2500;
const DEFAULT_RESEARCH_SUMMARY_OBSERVATION_CHARS = 600;
// Raised from 350: this budget now spends on HTML-stripped body text (see
// htmlToCleanText) instead of raw markup, so the same char count carries far
// more real content per source.
const DEFAULT_RESEARCH_EVIDENCE_OBSERVATION_CHARS = 1500;
// Cap applied to a fetched page's cleaned (tag/script/style-stripped) text,
// before the smaller per-source research-evidence budget trims it further.
// Only used for output shellObservation detects as HTML -- ordinary command
// output still goes through compactCommandOutput's smaller raw budget.
const DEFAULT_HTML_OUTPUT_CHARS = 6000;
const MAX_ITERATIONS = 20;
// Once this few iterations remain, stop demanding more authority-source
// research and force a transition to writing -- otherwise a research-heavy
// issue can spend its entire budget gathering evidence and never leave
// itself enough turns to write the required files at all.
const DEFAULT_FORCE_WRITE_ITERATIONS_REMAINING = 6;
const LOW_QUALITY_PATTERNS = [
  { pattern: /\bexample\.com\b/i, reason: "example.com placeholder source" },
  { pattern: /\bplaceholder\b/i, reason: "placeholder text" },
  { pattern: /\blorem ipsum\b/i, reason: "lorem ipsum filler" },
  { pattern: /\bTBD\b|\bTODO\b/i, reason: "unfinished TODO/TBD text" },
  { pattern: /\bScenario\s+1\b/i, reason: "generic scenario label" },
  { pattern: /\bDescription of Scenario\b/i, reason: "generic scenario description" },
  { pattern: /\bResearch Topic\s+1\b/i, reason: "generic research topic" },
  { pattern: /\bFunction\s+1\b/i, reason: "generic function label" },
  { pattern: /\bResult\s+1\b/i, reason: "generic result label" },
  { pattern: /\bevidenceType1\b/i, reason: "generic evidence label" },
  { pattern: /\bDeployment Note\s+1\b/i, reason: "generic deployment note" },
  { pattern: /\bCommercialization Note\s+1\b/i, reason: "generic commercialization note" }
];
const REPO_GUIDANCE_FILES = [".github/copilot-instructions.md"];

function env(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function stripV1(endpoint) {
  return String(endpoint || "").replace(/\/v1\/?$/, "");
}

function joinUrl(base, urlPath) {
  return `${String(base).replace(/\/+$/, "")}/${String(urlPath).replace(/^\/+/, "")}`;
}

function truncate(text, maxChars = MAX_OBSERVATION_CHARS) {
  const value = String(text ?? "");
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function readTextIfExists(worktree, relativePath, maxChars = 1200) {
  const filePath = path.join(worktree, relativePath);
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return truncate(fs.readFileSync(filePath, "utf8"), maxChars);
}

function looksLikeHtml(text) {
  const sample = String(text ?? "").slice(0, 3000);
  if (/^\s*(<!doctype html|<html)/i.test(sample)) {
    return true;
  }
  // Models often pipe the fetch through grep/head themselves (e.g.
  // `curl ... | grep -i foo`). For a minified single-line page, grep's
  // "matching line" can be nearly the whole document but start mid-markup
  // (observed live: `</style></head><body...`), so it never matches the
  // doc-start check above. Treat any recognizable HTML structural tag
  // appearing anywhere in the sample as HTML too.
  return /<\/?(?:html|head|body|div|span|script|style|meta|title|table|tr|td|a|p|section|nav|footer|header)\b/i.test(sample);
}

// Strips <script>/<style> blocks and all remaining tags, pulling out
// title/description plus the leftover body text. Runs against the FULL raw
// response (no prior truncation) -- for a real page, everything worth
// reading (standards text, workflow descriptions) lives well past the first
// ~1200 bytes of <head> boilerplate, so cleaning has to happen before any
// hard character cut, not after.
function htmlToCleanText(raw) {
  const text = String(raw ?? "");
  const withoutScripts = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const title = withoutScripts.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const description = withoutScripts.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i)?.[1] ??
    withoutScripts.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i)?.[1];
  const body = withoutScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return [
    title ? `title: ${title.replace(/\s+/g, " ").trim()}` : "",
    description ? `description: ${description.replace(/\s+/g, " ").trim()}` : "",
    body
  ].filter(Boolean).join("\n");
}

function compactCommandOutput(text) {
  const raw = String(text ?? "");
  if (looksLikeHtml(raw)) {
    // Deliberately no `|| raw` fallback here: once looksLikeHtml is true,
    // showing raw markup is never useful, even when extraction legitimately
    // yields little or nothing (e.g. a `head -N`-truncated fetch that only
    // captured <head> meta tags with no <title>/description/body text --
    // observed live against a real irs.gov fetch). Falling back to raw in
    // that case just re-exposes the exact tag soup this function exists to
    // strip, and can mislead the model into treating meta-tag attribute
    // values as real content.
    const clean = htmlToCleanText(raw);
    return truncate(clean, Number(env("AE_LOCAL_CODER_HTML_OUTPUT_CHARS", DEFAULT_HTML_OUTPUT_CHARS)));
  }
  return truncate(raw, Number(env("AE_LOCAL_CODER_COMMAND_OUTPUT_CHARS", 1200)));
}

function compactSearchOutput(text) {
  return truncate(text, Number(env("AE_LOCAL_CODER_SEARCH_OUTPUT_CHARS", 2500)));
}

function compactScalar(value, maxChars = 140) {
  if (value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => compactScalar(entry, maxChars)).filter((entry) => entry != null && entry !== "");
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, compactScalar(entry, maxChars)]));
  }
  return truncate(String(value), maxChars);
}

function summarizeResearchSummaryContent(relativePath, content) {
  if (!/evaluation\/research-summary\.json$/i.test(String(relativePath ?? ""))) {
    return null;
  }
  try {
    const body = JSON.parse(content);
    const sources = Array.isArray(body.authoritative_sources)
      ? body.authoritative_sources
      : Array.isArray(body.authority_sources)
        ? body.authority_sources
        : [];
    const workflowStages = normalizeArray(body.workflow_stages).slice(0, 6).map((entry) => (
      typeof entry === "string"
        ? entry
        : {
            name: entry?.name ?? entry?.stage ?? null,
            source_classes: entry?.source_classes ?? null,
            evidence: entry?.evidence ?? entry?.artifacts ?? null
          }
    ));
    return JSON.stringify({
      file: relativePath,
      agent_slug: body.agent_slug ?? body.slug ?? null,
      workflow_phase_group: body.workflow_phase_group ?? body.resolved_workflow_phase_group ?? null,
      industry_profile: body.industry_profile ?? body.resolved_industry_profile ?? null,
      authoritative_sources: sources.slice(0, Number(env("AE_LOCAL_CODER_RESEARCH_SUMMARY_SOURCE_LIMIT", 3))).map((source) => compactScalar({
        title: source?.title ?? null,
        publisher: source?.publisher ?? null,
        url: source?.url ?? source?.location ?? null,
        source_class: source?.source_class ?? null,
        authority_rationale: source?.authority_rationale ?? source?.authority_reason ?? null,
        workflow_stage: source?.workflow_stage ?? null,
        practical_use_in_pack: source?.practical_use_in_pack ?? null
      })),
      workflow_stages: compactScalar(workflowStages),
      decision_boundaries: compactScalar(normalizeArray(body.decision_boundaries).slice(0, 6)),
      domain_failure_modes: compactScalar(normalizeArray(body.domain_failure_modes).slice(0, 6)),
      unresolved_ambiguity: compactScalar(body.unresolved_ambiguity ?? body.unresolved_ambiguities ?? null)
    }, null, 2);
  } catch {
    return null;
  }
}

function compactReadFileContent(relativePath, content) {
  const researchSummary = summarizeResearchSummaryContent(relativePath, content);
  if (researchSummary) {
    return truncate(researchSummary, Number(env(
      "AE_LOCAL_CODER_RESEARCH_SUMMARY_OBSERVATION_CHARS",
      DEFAULT_RESEARCH_SUMMARY_OBSERVATION_CHARS
    )));
  }
  return truncate(content, MAX_FILE_CHARS);
}

function compactResearchEvidenceForObservation(output) {
  const raw = String(output ?? "");
  const clean = htmlToCleanText(raw);
  // Same reasoning as compactCommandOutput: no `|| raw` fallback -- a
  // legitimately sparse/empty extraction from a meta-tag-only fetch should
  // stay sparse, not silently re-expose raw markup.
  return truncate(clean, Number(env(
    "AE_LOCAL_CODER_RESEARCH_EVIDENCE_OBSERVATION_CHARS",
    DEFAULT_RESEARCH_EVIDENCE_OBSERVATION_CHARS
  )));
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDurationNs(value) {
  const ns = Number(value);
  if (!Number.isFinite(ns) || ns <= 0) {
    return null;
  }
  const ms = ns / 1_000_000;
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function summarizeOllamaModels(models) {
  return normalizeArray(models).map((entry) => {
    const details = entry?.details ?? {};
    return {
      name: entry?.name ?? entry?.model ?? null,
      size: formatBytes(entry?.size),
      vram: formatBytes(entry?.size_vram),
      family: details.family ?? null,
      parameter_size: details.parameter_size ?? null,
      quantization: details.quantization_level ?? null,
      expires_at: entry?.expires_at ?? null
    };
  });
}

function summarizeOllamaChatStats(stats) {
  if (!stats || typeof stats !== "object") {
    return null;
  }
  return {
    done: stats.done === true,
    done_reason: stats.done_reason ?? null,
    total: formatDurationNs(stats.total_duration),
    load: formatDurationNs(stats.load_duration),
    prompt_eval: formatDurationNs(stats.prompt_eval_duration),
    eval: formatDurationNs(stats.eval_duration),
    prompt_tokens: Number.isFinite(Number(stats.prompt_eval_count)) ? Number(stats.prompt_eval_count) : null,
    response_tokens: Number.isFinite(Number(stats.eval_count)) ? Number(stats.eval_count) : null
  };
}

async function fetchJson(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      // Check status before parsing: a gateway/proxy in front of the API can
      // return an HTML error page on failure, and a raw JSON.parse crash on
      // that ("Unexpected token '<'...") is far less useful than the actual
      // HTTP status this reports instead.
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${response.status} ${response.statusText}: response was not valid JSON: ${text.slice(0, 500)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOptionalJson(url, options = {}) {
  try {
    return { ok: true, body: await fetchJson(url, options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function logOllamaRuntimeSnapshot(baseUrl, label = "runtime") {
  if (!baseUrl || !parseBoolean(env("AE_LOCAL_CODER_LOG_OLLAMA_DIAGNOSTICS", "1"), true)) {
    return;
  }

  const timeoutMs = Number(env("AE_LOCAL_CODER_DIAGNOSTIC_TIMEOUT_MS", DEFAULT_OLLAMA_DIAGNOSTIC_TIMEOUT_MS));
  const [version, running] = await Promise.all([
    fetchOptionalJson(joinUrl(baseUrl, "/api/version"), { timeoutMs }),
    fetchOptionalJson(joinUrl(baseUrl, "/api/ps"), { timeoutMs })
  ]);

  const payload = {
    label,
    version: version.ok ? version.body?.version ?? null : `unavailable: ${version.error}`,
    running_models: running.ok
      ? summarizeOllamaModels(running.body?.models ?? [])
      : `unavailable: ${running.error}`
  };
  process.stdout.write(`\n[lane-coder ollama ${label}]\n${JSON.stringify(payload, null, 2)}\n`);
}

async function fetchOllamaChatStream(url, body, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS);
  const startedAt = Date.now();
  let lastDiagnosticsAt = 0;
  let diagnosticsInFlight = false;
  let receivedCharacters = 0;
  let lastContentAt = 0;
  const heartbeatMs = Number(env("AE_LOCAL_CODER_HEARTBEAT_MS", 15000));
  const heartbeat = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    if (receivedCharacters > 0) {
      const idleSeconds = lastContentAt > 0 ? Math.round((Date.now() - lastContentAt) / 1000) : 0;
      const idleSuffix = idleSeconds > Math.round(heartbeatMs / 1000) ? `, ${idleSeconds}s since last chunk` : "";
      process.stdout.write(
        `\n[lane-coder ollama] stream active ${elapsedSeconds}s, received ${receivedCharacters} chars${idleSuffix}\n`
      );
    } else {
      process.stdout.write(`\n[lane-coder ollama] awaiting first streamed token ${elapsedSeconds}s\n`);
    }
    const diagnosticsIntervalMs = Number(env("AE_LOCAL_CODER_DIAGNOSTIC_INTERVAL_MS", 60000));
    if (
      options.baseUrl &&
      diagnosticsIntervalMs > 0 &&
      elapsedMs - lastDiagnosticsAt >= diagnosticsIntervalMs &&
      !diagnosticsInFlight
    ) {
      lastDiagnosticsAt = elapsedMs;
      diagnosticsInFlight = true;
      logOllamaRuntimeSnapshot(options.baseUrl, "runtime")
        .catch((error) => {
          process.stdout.write(`\n[lane-coder ollama runtime]\n${error.message}\n`);
        })
        .finally(() => {
          diagnosticsInFlight = false;
        });
    }
  }, heartbeatMs);
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finalStats = null;

    function consumeLine(line) {
      if (!line.trim()) {
        return;
      }
      const parsed = JSON.parse(line);
      if (parsed?.error) {
        throw new Error(`Ollama stream error: ${parsed.error}`);
      }
      const piece = String(parsed?.message?.content ?? "");
      if (piece) {
        content += piece;
        receivedCharacters = content.length;
        lastContentAt = Date.now();
        process.stdout.write(piece);
      }
      if (parsed?.done) {
        finalStats = parsed;
      }
    }

    await postJsonStream(url, body, timeoutMs, (value) => {
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        consumeLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
    buffer += decoder.decode();
    if (buffer.trim()) {
      consumeLine(buffer);
    }
    const stats = summarizeOllamaChatStats(finalStats);
    if (stats) {
      process.stdout.write(`\n[lane-coder ollama stats]\n${JSON.stringify(stats, null, 2)}\n`);
    }
    return content;
  } finally {
    clearInterval(heartbeat);
  }
}

function postJsonStream(url, body, timeoutMs, onChunk) {
  const payload = JSON.stringify(body);
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      request.destroy(new Error(`Ollama chat timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const request = client.request(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          finish(new Error(`${response.statusCode} ${response.statusMessage}: ${text.slice(0, 500)}`));
        });
        response.on("error", finish);
        return;
      }
      response.on("data", onChunk);
      response.on("end", () => finish());
      response.on("error", finish);
    });
    request.on("error", finish);
    request.end(payload);
  });
}

async function ensureOllamaModel({ baseUrl, model, autoPull }) {
  const tags = await fetchJson(joinUrl(baseUrl, "/api/tags"));
  const models = Array.isArray(tags?.models) ? tags.models : [];
  process.stdout.write(`\n[lane-coder ollama inventory]\n${JSON.stringify({
    requested_model: model,
    loaded_models: summarizeOllamaModels(models)
  }, null, 2)}\n`);
  const found = models.some((entry) => {
    const name = String(entry?.name ?? entry?.model ?? "");
    return name === model || name.split(":")[0] === model;
  });

  if (found) {
    return;
  }

  if (!autoPull) {
    throw new Error(`Local model '${model}' is not loaded. Pull it with: docker compose --profile local-lane exec local-model ollama pull ${model}`);
  }

  process.stdout.write(`\n[lane-coder ollama pull]\nPulling ${model}. This can take a while.\n`);
  await fetchJson(joinUrl(baseUrl, "/api/pull"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model, stream: false }),
    timeoutMs: Number(env("AE_LOCAL_MODEL_PULL_TIMEOUT_MS", DEFAULT_PULL_TIMEOUT_MS))
  });
}

async function ensureLmStudioReady({ endpoint, model }) {
  const modelsUrl = joinUrl(String(endpoint).replace(/\/+$/, ""), "/models");
  const body = await fetchJson(modelsUrl);
  const models = Array.isArray(body?.data) ? body.data : [];
  if (model && models.length > 0 && !models.some((entry) => String(entry?.id ?? "") === model)) {
    process.stderr.write(`Warning: local model '${model}' was not listed by LM Studio; continuing because the runtime is reachable.\n`);
  }
}

function runCommand(command, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, signal, stdout, stderr });
    });
  });
}

function resolveWorktreePath(worktree, relativePath) {
  const resolved = path.resolve(worktree, String(relativePath ?? ""));
  const root = path.resolve(worktree);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes worktree: ${relativePath}`);
  }
  if (resolved.includes(`${path.sep}.git${path.sep}`) || resolved.endsWith(`${path.sep}.git`)) {
    throw new Error(`Path targets .git internals: ${relativePath}`);
  }
  return resolved;
}

function readFileObservation(worktree, relativePath) {
  const filePath = resolveWorktreePath(worktree, relativePath);
  const content = fs.readFileSync(filePath, "utf8");
  return {
    path: relativePath,
    chars: content.length,
    authority_urls: /evaluation\/research-summary\.json$/i.test(String(relativePath ?? ""))
      ? extractUrls(content).filter(openAuthoritySourceUrl).slice(0, Number(env("AE_LOCAL_CODER_RESEARCH_SUMMARY_URL_LIMIT", 12)))
      : [],
    content: compactReadFileContent(relativePath, content)
  };
}

function stableActionEntry(entry) {
  if (entry == null || typeof entry !== "object") {
    return entry;
  }
  return Object.keys(entry)
    .sort()
    .reduce((sorted, key) => {
      sorted[key] = entry[key];
      return sorted;
    }, {});
}

function actionFingerprint(action) {
  return JSON.stringify({
    reads: normalizeArray(action.read_files ?? action.reads).map(String),
    searches: normalizeArray(action.searches ?? action.search).map(stableActionEntry),
    commands: normalizeArray(action.commands ?? action.command).map((entry) => typeof entry === "string" ? entry : stableActionEntry(entry)),
    write_files: normalizeArray(action.write_files ?? action.writes).map((entry) => ({
      path: entry?.path ?? "",
      content: String(entry?.content ?? "")
    })),
    unified_diff: String(action.unified_diff ?? ""),
    done: action.done === true
  });
}

function actionWritesRepository(action) {
  return Boolean(action.unified_diff) || normalizeArray(action.write_files ?? action.writes).length > 0;
}

function observationShowsProgress(observation) {
  if (!observation || observation.rejected || observation.skipped || observation.error) {
    return false;
  }
  if (observation.type === "write_file" || observation.type === "unified_diff") {
    return true;
  }
  if (observation.type === "read_file") {
    return Boolean(observation.content);
  }
  if (observation.type === "search") {
    return observation.status === 0 && Boolean(String(observation.stdout ?? "").trim());
  }
  if (observation.type === "command") {
    return observation.status === 0 && Boolean(String(observation.stdout ?? observation.stderr ?? "").trim());
  }
  return false;
}

async function shellObservation(worktree, command) {
  const result = await runCommand("sh", ["-lc", String(command)], {
    cwd: worktree,
    timeoutMs: Number(env("AE_LOCAL_CODER_COMMAND_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS))
  });
  return {
    command,
    status: result.status,
    stdout: compactCommandOutput(result.stdout),
    stderr: compactCommandOutput(result.stderr)
  };
}

async function searchObservation(worktree, entry) {
  const query = String(entry?.query ?? entry ?? "").trim();
  if (!query) {
    return { query, status: 1, stdout: "", stderr: "empty query" };
  }
  const args = ["-n", "--hidden", "--glob", "!.git"];
  if (entry?.glob) {
    args.push("--glob", String(entry.glob));
  }
  args.push(query, ".");
  const result = await runCommand("rg", args, {
    cwd: worktree,
    timeoutMs: Number(env("AE_LOCAL_CODER_COMMAND_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS))
  });
  return {
    query,
    glob: entry?.glob ?? null,
    status: result.status,
    stdout: compactSearchOutput(result.stdout),
    stderr: compactCommandOutput(result.stderr)
  };
}

function qualityProgress(qualityState) {
  const requiredAuthoritySources = Number(env("AE_AUTHORITY_RESEARCH_MIN_SOURCES", 6));
  const hasBlockedCommands = normalizeArray(qualityState.failedCommands).length > 0;
  const authorityResearchOutstanding = qualityState.requiresAuthorityResearch &&
    !qualityState.authorityResearchWaived &&
    qualityState.authorityResearchEvidence.length < requiredAuthoritySources;
  return {
    target_path: qualityState.targetPath || null,
    authority_source_urls_collected: qualityState.authorityResearchEvidence.length,
    required_authority_source_urls: qualityState.requiresAuthorityResearch ? requiredAuthoritySources : 0,
    blocked_commands: normalizeArray(qualityState.failedCommands).slice(-8),
    repo_source_pattern_files: normalizeArray(qualityState.sourcePatternFiles).slice(0, 8),
    next_required_action: authorityResearchOutstanding && hasBlockedCommands
      ? "Stop guessing deep source URLs. Search or read related repository research-summary/manifest files under the related industry prefix to identify proven public authority URL patterns, then run curl -sSL against distinct government, education, nonprofit, or open-access authority URLs that return body content."
      : authorityResearchOutstanding
        ? "Run curl -sSL against distinct public authority URLs from the issue, repo guardrails, or public authority search results until the required source count is met. Fetch body content; headers-only requests do not count."
      : "Write the implementation."
  };
}

function normalizeArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function extractUrls(text) {
  return Array.from(String(text ?? "").matchAll(/https?:\/\/[^\s"'<>),]+/gi))
    .map((match) => match[0].replace(/[.;]+$/, ""));
}

function publicSourceUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return Boolean(host)
      && !host.endsWith(".local")
      && host !== "localhost"
      && !/^127\./.test(host)
      && !/^10\./.test(host)
      && !/^192\.168\./.test(host)
      && !/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      && !/example\.(com|org|net)$/i.test(host);
  } catch {
    return false;
  }
}

function openAuthoritySourceUrl(url) {
  if (!publicSourceUrl(url)) {
    return false;
  }
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host.endsWith(".gov") ||
      host.endsWith(".mil") ||
      host.endsWith(".edu") ||
      host.endsWith(".int") ||
      host.endsWith(".org");
  } catch {
    return false;
  }
}

// Fully opt-in via AE_AUTHORITY_RESEARCH_KEYWORDS (comma-separated, set from
// this repo's own quality_gates.authority_research.trigger_keywords config --
// see config.mjs). Empty (the default for every repo) means this never
// triggers; the engine itself has no built-in notion of what "authority
// research" means for any given repo.
function requiresAuthorityResearch(issueBrief = {}) {
  const keywords = String(env("AE_AUTHORITY_RESEARCH_KEYWORDS", ""))
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);
  if (keywords.length === 0) {
    return false;
  }
  const text = [
    issueBrief.requested_change,
    issueBrief.authority_sources,
    issueBrief.acceptance_criteria,
    issueBrief.materialization_expectations,
    issueBrief.deployment_expectations
  ].join("\n").toLowerCase();
  const pattern = new RegExp(keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  return pattern.test(text);
}

function recordAuthorityResearchEvidence(qualityState, observation) {
  if (!qualityState?.requiresAuthorityResearch || !["command", "read_file", "search"].includes(observation?.type)) {
    return;
  }
  const observedText = [
    observation.command,
    observation.path,
    observation.query,
    normalizeArray(observation.authority_urls).join("\n"),
    observation.content,
    observation.stdout,
    observation.stderr
  ].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
  if (!observedText) {
    return;
  }
  const urls = extractUrls(observedText).filter(openAuthoritySourceUrl);
  for (const url of urls) {
    if (!qualityState.authorityResearchEvidence.includes(url)) {
      qualityState.authorityResearchEvidence.push(url);
    }
  }
}

function recordFailedCommand(qualityState, command) {
  if (!command || !qualityState?.failedCommands) {
    return;
  }
  if (!qualityState.failedCommands.includes(command)) {
    qualityState.failedCommands.push(command);
  }
}

function commandFailedBefore(qualityState, command) {
  return Boolean(command && qualityState?.failedCommands?.includes(command));
}

function localCoderNoOpCommand(command) {
  return /^(echo|printf)\b/i.test(String(command ?? "").trim());
}

function commandNeedsEvidenceOutput(command) {
  const value = String(command ?? "").trim();
  return /\bcurl\b/i.test(value) || /\bwget\b/i.test(value);
}

function commandMinesPdfSourceUrls(command) {
  const value = String(command ?? "").toLowerCase();
  return /\b(grep|rg)\b/.test(value) &&
    /research-summary\.json|manifest\.ya?ml/.test(value) &&
    /\\?\.pdf|\.pdf/.test(value);
}

function commandDumpsPdfUrl(command) {
  const value = String(command ?? "");
  if (!commandNeedsEvidenceOutput(value)) {
    return false;
  }
  const urls = extractUrls(value);
  if (!urls.some((url) => /\.pdf(?:$|[?#])/i.test(url))) {
    return false;
  }
  return !/[|>]/.test(value);
}

function outputLooksHeadersOnly(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => (
    /^HTTP\/\d(?:\.\d)?\s+\d+/i.test(line) ||
    /^[A-Za-z0-9!#$%&'*+.^_`|~-]+:\s/.test(line)
  ));
}

function researchEvidenceOutput(observation) {
  return [observation?.stdout, observation?.stderr]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function rejectedCommandObservation(observation, error) {
  return {
    ...observation,
    stdout: observation?.stdout ? truncate(observation.stdout, Number(env("AE_LOCAL_CODER_REJECTED_OUTPUT_CHARS", 300))) : observation?.stdout,
    stderr: observation?.stderr ? truncate(observation.stderr, Number(env("AE_LOCAL_CODER_REJECTED_OUTPUT_CHARS", 300))) : observation?.stderr,
    rejected: true,
    error
  };
}

function outputLooksBinaryDocument(output) {
  const value = String(output ?? "").trim();
  if (/^(%PDF-|PK\x03\x04|\x89PNG|GIF8|RIFF)/s.test(value)) {
    return true;
  }
  const sample = value.slice(0, 1200);
  if (!sample) {
    return false;
  }
  const suspicious = Array.from(sample).filter((char) => {
    const code = char.charCodeAt(0);
    return char === "\uFFFD" || (code < 32 && !["\n", "\r", "\t"].includes(char));
  }).length;
  return suspicious / sample.length > 0.03;
}

function outputLooksBlockedOrUnavailable(output) {
  const value = String(output ?? "").toLowerCase();
  return /request resembles an abusive automated request/.test(value) ||
    /access denied|forbidden|blocked by|temporarily unavailable|currently unavailable/.test(value) ||
    /\b404\b|page not found|not found \|/.test(value) ||
    /enable javascript|captcha|cloudflare ray id/.test(value) ||
    // Real block/challenge pages observed in production against public
    // authority sources (Cloudflare JS challenge, and explicit bot-policy
    // rejections) that the patterns above didn't cover.
    /just a moment/.test(value) ||
    /unable to authorize your request/.test(value) ||
    /automated retrieval program|bot activity.{0,40}(prohibited|not permitted)|are you a (human|robot)|verify you are a human/.test(value) ||
    /the page you.{0,5}re looking for was not found/.test(value);
}

function researchEvidenceHasBody(observation) {
  const output = researchEvidenceOutput(observation);
  if (!output || outputLooksHeadersOnly(output) || outputLooksBinaryDocument(output) || outputLooksBlockedOrUnavailable(output)) {
    return false;
  }
  const text = output.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length >= Number(env("AE_LOCAL_CODER_MIN_RESEARCH_BODY_CHARS", 120));
}

function assessContentQuality(relativePath, content, qualityState = {}) {
  const issues = [];
  const text = String(content ?? "");
  for (const entry of LOW_QUALITY_PATTERNS) {
    if (entry.pattern.test(text)) {
      issues.push(entry.reason);
    }
  }
  if (
    qualityState.requiresAuthorityResearch &&
    !qualityState.authorityResearchWaived &&
    String(relativePath ?? "").startsWith(String(qualityState.targetPath ?? "")) &&
    qualityState.authorityResearchEvidence.length < Number(env("AE_AUTHORITY_RESEARCH_MIN_SOURCES", 6))
  ) {
    issues.push("authority-source research has not been performed with public authority sources before writing");
  }
  return issues;
}

function buildQualityState(issueBrief = {}) {
  return {
    targetPath: String(issueBrief.target_path ?? ""),
    requiresAuthorityResearch: requiresAuthorityResearch(issueBrief),
    authorityResearchEvidence: [],
    failedCommands: [],
    sourcePatternFiles: [],
    // Sticky: once the iteration budget runs low, waive the authority-source
    // minimum for the rest of this run rather than flip-flopping the
    // requirement turn to turn.
    authorityResearchWaived: false
  };
}

async function changedFiles(worktree) {
  const result = await runCommand("git", ["diff", "--name-only", "HEAD"], { cwd: worktree });
  if (result.status !== 0) {
    throw new Error(`git diff failed during quality validation: ${truncate(result.stderr || result.stdout, 4000)}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}


async function validateLocalCoderQuality(worktree, issueBrief, qualityState) {
  const issues = [];
  const files = await changedFiles(worktree);
  for (const file of files) {
    const filePath = resolveWorktreePath(worktree, file);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      issues.push(...assessContentQuality(file, fs.readFileSync(filePath, "utf8"), {
        ...qualityState,
        requiresAuthorityResearch: false
      }).map((issue) => `${file}: ${issue}`));
    }
  }

  if (
    qualityState.requiresAuthorityResearch &&
    !qualityState.authorityResearchWaived &&
    qualityState.authorityResearchEvidence.length < Number(env("AE_AUTHORITY_RESEARCH_MIN_SOURCES", 6))
  ) {
    issues.push(`only ${qualityState.authorityResearchEvidence.length} public authority source URL(s) were researched; at least ${Number(env("AE_AUTHORITY_RESEARCH_MIN_SOURCES", 6))} are required`);
  }

  if (issues.length > 0) {
    throw new Error(`Lane coder quality gate failed:\n- ${issues.join("\n- ")}`);
  }
}

// Models frequently emit real (unescaped) newlines/tabs inside a JSON string
// value when the content itself is multi-line markdown, which is invalid
// JSON syntax ("Bad control character in string literal") even though the
// intent is clear. Escaping raw control characters that appear between
// quotes (tracking string/escape state, not just replacing everywhere so we
// don't touch whitespace between tokens) recovers these without needing the
// model to get it right.
const VALID_JSON_STRING_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function escapeControlCharactersInStrings(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (inString && !escaped && char === "\\") {
      // A backslash the model didn't mean as a JSON escape (e.g. a raw regex
      // like "audit\|liaison" from a grep command) leaves invalid JSON that
      // JSON.parse rejects outright. Only pass real escapes through; treat
      // anything else as a literal backslash the model intended.
      if (VALID_JSON_STRING_ESCAPES.has(chars[i + 1])) {
        escaped = true;
        result += char;
        continue;
      }
      result += "\\\\";
      continue;
    }
    if (inString && !escaped && char === '"') {
      inString = false;
      result += char;
      continue;
    }
    if (!inString && char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (inString && !escaped) {
      if (char === "\n") {
        result += "\\n";
        continue;
      }
      if (char === "\r") {
        result += "\\r";
        continue;
      }
      if (char === "\t") {
        result += "\\t";
        continue;
      }
    }
    escaped = false;
    result += char;
  }
  return result;
}

function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  // Anchored to the whole response, not a bare /.../ scan: a spec-pack
  // response's own write_files content frequently embeds a real markdown
  // code fence (e.g. a directory-tree example inside a generated
  // deployment/package.md), and an unanchored match hijacked the extraction
  // by matching from that embedded fence to the next one, producing a
  // garbage fragment instead of the real JSON. Observed live on labor-commons
  // issue #1: a fully well-formed, complete response (verified separately
  // with a plain JSON.parse) failed here for exactly this reason.
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const trimmed = candidate.slice(start, end + 1);
      try {
        return JSON.parse(trimmed);
      } catch {
        return JSON.parse(escapeControlCharactersInStrings(trimmed));
      }
    }
    throw new Error(`Lane coder response was not valid JSON: ${truncate(raw, 1000)}`);
  }
}

async function applyUnifiedDiff(worktree, diff) {
  const child = spawn("git", ["apply", "--whitespace=fix", "-"], {
    cwd: worktree,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(String(diff));
  const result = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ status: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on("exit", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
  if (result.status !== 0) {
    throw new Error(`git apply failed: ${truncate(result.stderr || result.stdout, 4000)}`);
  }
}

let markdownlintCli2InstallPromise = null;

function ensureMarkdownlintCli2Installed() {
  if (!markdownlintCli2InstallPromise) {
    markdownlintCli2InstallPromise = (async () => {
      const check = await runCommand("markdownlint-cli2", ["--version"], { timeoutMs: 10000 });
      if (check.status === 0) {
        return true;
      }
      const install = await runCommand("npm", ["install", "-g", "markdownlint-cli2"], { timeoutMs: 60000 });
      return install.status === 0;
    })();
  }
  return markdownlintCli2InstallPromise;
}

/** Best-effort: a missing/unfixable install never blocks the run, it just leaves content as-is. */
async function autoFixMarkdownFiles(worktree, relativePaths) {
  const installed = await ensureMarkdownlintCli2Installed();
  if (!installed) {
    return false;
  }
  const result = await runCommand("markdownlint-cli2", ["--fix", ...relativePaths], {
    cwd: worktree,
    timeoutMs: 20000
  });
  return result.status === 0 || result.status === 1;
}

/** Sweeps every markdown file that differs from base -- committed or not, from this run or an earlier one -- so nothing slips through unfixed. */
async function autoFixMarkdownDiffAgainstBase(worktree, baseBranch) {
  const diffResult = await runCommand(
    "git",
    ["diff", "--name-only", `origin/${baseBranch}`, "--", "*.md"],
    { cwd: worktree }
  );
  const untrackedResult = await runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", "*.md"],
    { cwd: worktree }
  );
  const files = Array.from(new Set(
    [diffResult.stdout, untrackedResult.stdout]
      .flatMap((output) => output.split("\n"))
      .map((line) => line.trim())
      .filter(Boolean)
  ));
  if (files.length === 0) {
    return;
  }
  await autoFixMarkdownFiles(worktree, files);
}

async function executeAction(worktree, action, qualityState = {}) {
  const observations = [];
  const reads = normalizeArray(action.read_files ?? action.reads);
  const searches = normalizeArray(action.searches ?? action.search);
  const commands = normalizeArray(action.commands ?? action.command);
  const writes = normalizeArray(action.write_files ?? action.writes);
  const summary = {
    reads: reads.length,
    searches: searches.length,
    commands: commands.length,
    writes: writes.length,
    unifiedDiff: Boolean(action.unified_diff),
    done: action.done === true
  };
  process.stdout.write(`\n[lane-coder action]\n${JSON.stringify(summary, null, 2)}\n`);

  for (const relativePath of reads.slice(0, 12)) {
    try {
      const observation = { type: "read_file", ...readFileObservation(worktree, relativePath) };
      recordAuthorityResearchEvidence(qualityState, observation);
      observations.push(observation);
    } catch (error) {
      observations.push({ type: "read_file", path: relativePath, error: error.message });
    }
  }

  for (const entry of searches.slice(0, 8)) {
    const observation = { type: "search", ...(await searchObservation(worktree, entry)) };
    recordAuthorityResearchEvidence(qualityState, observation);
    observations.push(observation);
  }

  // Deliberately does NOT require reads.length === 0 && searches.length === 0
  // (as an earlier version did): a model response that bundles a curl guess
  // together with an unrelated search/read action defeated that condition
  // every time, since the fallback never got a pure command-only action to
  // trigger on. Observed live: the coder kept pairing fresh authority-URL
  // guesses with searches in the same action across many attempts, so this
  // guardrail — despite failedCommands already crossing the threshold —
  // never actually fired. Gate purely on the failure count instead.
  const sourceDiscoveryRequired = qualityState.requiresAuthorityResearch &&
    qualityState.authorityResearchEvidence.length < Number(env("AE_AUTHORITY_RESEARCH_MIN_SOURCES", 6)) &&
    normalizeArray(qualityState.failedCommands).length >= Number(env("AE_LOCAL_CODER_SOURCE_PATTERN_AFTER_FAILURES", 2));

  for (const entry of commands.slice(0, 6)) {
    const command = typeof entry === "string" ? entry : entry?.cmd ?? entry?.command;
    if (!command) {
      continue;
    }
    if (sourceDiscoveryRequired && commandNeedsEvidenceOutput(command)) {
      observations.push({
        type: "source_strategy",
        command,
        skipped: true,
        rejected: true,
        error: "multiple authority URL commands have already failed; read/search repository source pattern files before trying more deep URL guesses",
        source_pattern_files: normalizeArray(qualityState.sourcePatternFiles).slice(0, 8),
        suggested_action: {
          read_files: normalizeArray(qualityState.sourcePatternFiles).slice(0, 4),
          searches: [
            { query: "authority_sources", glob: "agents/catalog/industry-overlays/**/evaluation/research-summary.json" },
            { query: "source_audit", glob: "agents/catalog/industry-overlays/**/evaluation/research-summary.json" }
          ]
        }
      });
      recordFailedCommand(qualityState, command);
      continue;
    }
    if (qualityState.requiresAuthorityResearch && localCoderNoOpCommand(command)) {
      observations.push({
        type: "command",
        command,
        skipped: true,
        rejected: true,
        error: "echo/printf commands do not count as authority-source research; use curl or another command that inspects public source URLs"
      });
      recordFailedCommand(qualityState, command);
      continue;
    }
    if (commandFailedBefore(qualityState, command)) {
      observations.push({
        type: "command",
        command,
        skipped: true,
        rejected: true,
        error: "command failed earlier in this run; use a corrected command or a different source"
      });
      continue;
    }
    if (qualityState.requiresAuthorityResearch && commandMinesPdfSourceUrls(command)) {
      observations.push({
        type: "source_strategy",
        command,
        skipped: true,
        rejected: true,
        error: "repo source discovery must read structured source records, not mine PDF URLs; read research-summary.json files or search for source titles, publishers, source_class, authority_rationale, and non-PDF URLs"
      });
      recordFailedCommand(qualityState, command);
      continue;
    }
    if (qualityState.requiresAuthorityResearch && commandNeedsEvidenceOutput(command)) {
      const commandUrls = extractUrls(command);
      if (commandUrls.length > 0 && !commandUrls.some(openAuthoritySourceUrl)) {
        observations.push({
          type: "command",
          command,
          skipped: true,
          rejected: true,
          error: "research command does not target a government or open-access authority URL; avoid ordinary commercial public pages"
        });
        recordFailedCommand(qualityState, command);
        continue;
      }
      if (commandDumpsPdfUrl(command)) {
        observations.push({
          type: "command",
          command,
          skipped: true,
          rejected: true,
          error: "PDF authority URLs must be converted into small text snippets before use; do not fetch raw PDF bytes directly"
        });
        recordFailedCommand(qualityState, command);
        continue;
      }
    }
    const observation = { type: "command", ...(await shellObservation(worktree, command)) };
    if (observation.status !== 0) {
      recordFailedCommand(qualityState, command);
    }
    if (
      qualityState.requiresAuthorityResearch &&
      observation.status === 0 &&
      commandNeedsEvidenceOutput(command) &&
      !String(observation.stdout ?? "").trim() &&
      !String(observation.stderr ?? "").trim()
    ) {
      observations.push(rejectedCommandObservation(
        observation,
        "research command returned no evidence; use curl -sSL with a government, education, nonprofit, or open-access authority URL that returns source content"
      ));
      recordFailedCommand(qualityState, command);
      continue;
    }
    if (
      qualityState.requiresAuthorityResearch &&
      observation.status === 0 &&
      commandNeedsEvidenceOutput(command) &&
      outputLooksBinaryDocument(researchEvidenceOutput(observation))
    ) {
      observations.push(rejectedCommandObservation(
        observation,
        "research command returned raw binary/document bytes; extract small text snippets from the authority source instead of dumping PDFs or archives"
      ));
      recordFailedCommand(qualityState, command);
      continue;
    }
    if (
      qualityState.requiresAuthorityResearch &&
      observation.status === 0 &&
      commandNeedsEvidenceOutput(command) &&
      outputLooksBlockedOrUnavailable(researchEvidenceOutput(observation))
    ) {
      observations.push(rejectedCommandObservation(
        observation,
        "research command returned an access-denied or unavailable page; choose a source URL that returns usable authority content"
      ));
      recordFailedCommand(qualityState, command);
      continue;
    }
    if (
      qualityState.requiresAuthorityResearch &&
      observation.status === 0 &&
      commandNeedsEvidenceOutput(command) &&
      !researchEvidenceHasBody(observation)
    ) {
      observations.push(rejectedCommandObservation(
        observation,
        "research command returned only headers/status metadata; use curl -sSL without -I against a public authority URL and capture source content"
      ));
      recordFailedCommand(qualityState, command);
      continue;
    }
    recordAuthorityResearchEvidence(qualityState, observation);
    if (qualityState.requiresAuthorityResearch && commandNeedsEvidenceOutput(command)) {
      observation.stdout = observation.stdout ? compactResearchEvidenceForObservation(observation.stdout) : observation.stdout;
      observation.stderr = observation.stderr ? compactResearchEvidenceForObservation(observation.stderr) : observation.stderr;
    }
    observations.push(observation);
  }

  if (action.unified_diff) {
    try {
      await applyUnifiedDiff(worktree, action.unified_diff);
      observations.push({ type: "unified_diff", applied: true });
    } catch (error) {
      // A malformed/corrupt patch must not crash the whole run -- treat it as a
      // rejected action so the model can retry with write_files instead, the
      // same way a rejected command or quality-gate failure is recoverable.
      observations.push({
        type: "unified_diff",
        applied: false,
        rejected: true,
        error: truncate(error.message, Number(env("AE_LOCAL_CODER_REJECTED_OUTPUT_CHARS", 300)))
      });
    }
  }

  const writtenMarkdownPaths = [];
  for (const entry of writes.slice(0, 20)) {
    const relativePath = entry?.path;
    if (!relativePath) {
      continue;
    }
    const qualityIssues = assessContentQuality(relativePath, entry.content, qualityState);
    if (qualityIssues.length > 0) {
      observations.push({
        type: "quality_gate",
        path: relativePath,
        rejected: true,
        issues: qualityIssues
      });
      continue;
    }
    const filePath = resolveWorktreePath(worktree, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(entry.content ?? ""), "utf8");
    observations.push({ type: "write_file", path: relativePath, bytes: Buffer.byteLength(String(entry.content ?? "")) });
    if (relativePath.toLowerCase().endsWith(".md")) {
      writtenMarkdownPaths.push(relativePath);
    }
  }

  // Blank-line-around-headings/lists spacing (MD022/MD032) is a purely
  // mechanical, deterministic formatting rule, not a content judgment -- the
  // model reliably gets it wrong across every spec pack regardless of
  // prompting, so auto-fix it directly rather than relying on the model to
  // notice or self-correct.
  if (writtenMarkdownPaths.length > 0) {
    const fixed = await autoFixMarkdownFiles(worktree, writtenMarkdownPaths);
    if (fixed) {
      observations.push({ type: "markdown_auto_fix", applied: true, files: writtenMarkdownPaths });
    }
  }

  process.stdout.write(`\n[lane-coder observations]\n${truncate(JSON.stringify(observations, null, 2), MAX_OBSERVATION_CHARS)}\n`);
  return observations;
}

async function gitStatus(worktree) {
  const result = await runCommand("git", ["status", "--short", "--untracked-files=all"], { cwd: worktree });
  return result.stdout.trim();
}

async function requireCommandSuccess(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${truncate(result.stderr || result.stdout, 4000)}`);
  }
  return result;
}

// Opt-in via this repo's own repo.catalog.overlay_root config (see
// config.mjs / AE_CATALOG_OVERLAY_ROOT). The directory one level below the
// configured root (e.g. the "section" in {overlay_root}/{section}/{slug}/
// {spec_filename}) is treated as "related" -- same-section siblings are the
// topically closest neighbors, rather than the target's own (for a new
// entry, empty) directory. Repos with no catalog.overlay_root configured
// fall straight through to the generic parent-directory behavior below.
function deriveRelatedFilePrefix(targetPath) {
  const parts = String(targetPath ?? "")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  const overlayRoot = String(env("AE_CATALOG_OVERLAY_ROOT", "")).replace(/^\/+|\/+$/g, "");
  if (overlayRoot) {
    const rootParts = overlayRoot.split("/").filter(Boolean);
    const matchesRoot = rootParts.length > 0 && rootParts.every((part, i) => parts[i] === part);
    if (matchesRoot && parts.length > rootParts.length + 1) {
      return parts.slice(0, rootParts.length + 1).join("/");
    }
  }
  if (parts.length > 1) {
    return parts.slice(0, -1).join("/");
  }
  return "";
}

// Opt-in via this repo's own repo.catalog.source_pattern_filenames config
// (see config.mjs / AE_CATALOG_SOURCE_PATTERN_FILENAMES) -- filenames this
// repo considers "source/reference material" worth surfacing to the coder
// as context (e.g. a research-summary or manifest file convention specific
// to that repo). Empty (the default) means this returns nothing.
function collectSourcePatternFiles(allFiles, targetPath) {
  const patternNames = String(env("AE_CATALOG_SOURCE_PATTERN_FILENAMES", ""))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (patternNames.length === 0) {
    return [];
  }
  const targetBase = String(targetPath ?? "").replace(/\/+$/, "");
  const relatedPrefix = deriveRelatedFilePrefix(targetPath);
  const overlayRoot = String(env("AE_CATALOG_OVERLAY_ROOT", "")).replace(/^\/+|\/+$/g, "");
  const limit = Number(env("AE_LOCAL_CODER_SOURCE_PATTERN_FILE_LIMIT", 8));
  const escaped = patternNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"));
  const sourcePattern = new RegExp(`(^|/)(${escaped.join("|")})$`);
  const related = [];
  const broad = [];
  for (const file of allFiles) {
    if (!sourcePattern.test(file) || (targetBase && file.startsWith(`${targetBase}/`))) {
      continue;
    }
    if (relatedPrefix && file.startsWith(`${relatedPrefix}/`)) {
      related.push(file);
    } else if (overlayRoot && file.startsWith(`${overlayRoot}/`)) {
      broad.push(file);
    }
  }
  const priority = (file) => file.endsWith(patternNames[0]) ? 0 : 1;
  return [...related.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b)), ...broad.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))]
    .slice(0, limit);
}

// Opt-in via this repo's own repo.catalog config (spec_filename,
// exemplar_keys, first_entry_exemplar_key -- see config.mjs /
// AE_CATALOG_SPEC_FILENAME, AE_CATALOG_EXEMPLAR_KEYS,
// AE_CATALOG_FIRST_ENTRY_EXEMPLAR_KEY). Finds a rich same-section sibling
// file matching this repo's own catalog-entry filename convention and hands
// the coder the specific top-level keys this repo flagged as needing a
// concrete depth/structure exemplar to imitate (some models reliably imitate
// a full example but under-produce equivalent depth from instructions alone).
// Picking the LONGEST sibling in the section is a cheap proxy for "the
// richest example". Returns null (the default for every repo) unless a
// catalog layout and at least one exemplar key are configured.
function collectSiblingSpecExemplar(worktree, allFiles, targetPath) {
  const specFilename = String(env("AE_CATALOG_SPEC_FILENAME", "")).trim();
  const exemplarKeys = String(env("AE_CATALOG_EXEMPLAR_KEYS", ""))
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const firstEntryKey = String(env("AE_CATALOG_FIRST_ENTRY_EXEMPLAR_KEY", "")).trim();
  if (!specFilename || (exemplarKeys.length === 0 && !firstEntryKey)) {
    return null;
  }
  const targetBase = String(targetPath ?? "").replace(/\/+$/, "");
  const relatedPrefix = deriveRelatedFilePrefix(targetPath);
  if (!relatedPrefix) {
    return null;
  }
  const specFilenamePattern = new RegExp(`(^|/)${specFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const candidates = allFiles.filter(
    (file) =>
      file.startsWith(`${relatedPrefix}/`) &&
      specFilenamePattern.test(file) &&
      !(targetBase && file.startsWith(`${targetBase}/`))
  );
  let best = null;
  for (const relativePath of candidates) {
    const filePath = path.join(worktree, relativePath);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    if (!best || content.length > best.content.length) {
      best = { path: relativePath, content };
    }
  }
  if (!best) {
    return null;
  }
  // Injecting the whole file bloats context past the compaction threshold and
  // makes the coder loop re-reading it, so keep this small and targeted to
  // just the keys this repo configured as needing an exemplar.
  const keyBlocks = exemplarKeys
    .map((key) => extractIndentedBlock(best.content, new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m")))
    .filter(Boolean);
  const firstEntryBlock = firstEntryKey
    ? extractFirstListEntryBlock(best.content, new RegExp(`^\\s*${firstEntryKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"))
    : null;
  if (keyBlocks.length === 0 && !firstEntryBlock) {
    return null;
  }
  const parts = [`# depth/structure exemplar from ${best.path} (a different entry -- match its depth and field shape, not its content)`];
  for (const block of keyBlocks) {
    parts.push(block.trimEnd());
  }
  if (firstEntryBlock) {
    parts.push(`# ${firstEntryKey} entry shape:`);
    parts.push(firstEntryBlock.trimEnd());
  }
  return {
    path: best.path,
    content: truncate(parts.join("\n"), Number(env("AE_LOCAL_CODER_EXEMPLAR_CHARS", 4000)))
  };
}

// Capture a YAML key line plus every following line more deeply indented than
// it (its multi-line value or nested list), stopping at the next line whose
// indentation is <= the key's. Handles both the quoted multi-line
// specialty_boundary value and the adjacent_specialties list.
function extractIndentedBlock(content, keyRegex) {
  const lines = String(content ?? "").split("\n");
  const startIndex = lines.findIndex((line) => keyRegex.test(line));
  if (startIndex < 0) {
    return null;
  }
  const keyIndent = lines[startIndex].match(/^\s*/)[0].length;
  const captured = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      captured.push(line);
      continue;
    }
    const indent = line.match(/^\s*/)[0].length;
    // Continue for deeper-indented lines (a nested/multi-line value) and for
    // list items at the SAME indent as the key (valid YAML: a sequence whose
    // "- item" lines align with their parent key, as adjacent_specialties uses).
    if (indent < keyIndent || (indent === keyIndent && !/^\s*-\s/.test(line))) {
      break;
    }
    captured.push(line);
  }
  return captured.join("\n");
}

// Capture the key line plus just the FIRST list entry beneath it (a "- ..."
// item and its nested fields), for showing one authority_sources entry's field
// shape without dumping the whole list.
function extractFirstListEntryBlock(content, keyRegex) {
  const lines = String(content ?? "").split("\n");
  const startIndex = lines.findIndex((line) => keyRegex.test(line));
  if (startIndex < 0) {
    return null;
  }
  const keyIndent = lines[startIndex].match(/^\s*/)[0].length;
  const captured = [lines[startIndex]];
  let entryIndent = null;
  let sawEntry = false;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      captured.push(line);
      continue;
    }
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= keyIndent && !/^\s*-\s/.test(line)) {
      break;
    }
    const isEntryStart = /^\s*-\s/.test(line);
    if (isEntryStart) {
      if (sawEntry) {
        break; // stop at the second entry
      }
      sawEntry = true;
      entryIndent = indent;
    } else if (sawEntry && indent <= entryIndent) {
      break;
    }
    captured.push(line);
  }
  return sawEntry ? captured.join("\n") : null;
}

function collectAuthoritySourceCandidates(worktree, sourcePatternFiles) {
  const candidates = [];
  const seen = new Set();
  const limit = Number(env("AE_LOCAL_CODER_SOURCE_CANDIDATE_LIMIT", 8));
  for (const relativePath of sourcePatternFiles) {
    if (candidates.length >= limit) {
      break;
    }
    const filePath = path.join(worktree, relativePath);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const content = truncate(fs.readFileSync(filePath, "utf8"), Number(env("AE_LOCAL_CODER_SOURCE_PATTERN_READ_CHARS", 20000)));
    for (const url of extractUrls(content).filter(openAuthoritySourceUrl)) {
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      candidates.push({ url, source_file: relativePath });
      if (candidates.length >= limit) {
        break;
      }
    }
  }
  return candidates;
}

async function buildInitialContext(worktree, issueBrief = {}) {
  const [status, files, packageJson, readme] = await Promise.all([
    runCommand("git", ["status", "--short", "--untracked-files=all"], { cwd: worktree }),
    runCommand("git", ["ls-files"], { cwd: worktree }),
    fs.existsSync(path.join(worktree, "package.json"))
      ? Promise.resolve({ stdout: fs.readFileSync(path.join(worktree, "package.json"), "utf8"), stderr: "", status: 0 })
      : Promise.resolve({ stdout: "", stderr: "", status: 0 }),
    fs.existsSync(path.join(worktree, "README.md"))
      ? Promise.resolve({ stdout: fs.readFileSync(path.join(worktree, "README.md"), "utf8"), stderr: "", status: 0 })
      : Promise.resolve({ stdout: "", stderr: "", status: 0 })
  ]);
  const allFiles = files.stdout.split(/\r?\n/).filter(Boolean);
  const relatedPrefix = deriveRelatedFilePrefix(issueBrief.target_path);
  const relatedFiles = relatedPrefix
    ? allFiles
      .filter((file) => file.startsWith(`${relatedPrefix}/`))
      .slice(0, Number(env("AE_LOCAL_CODER_RELATED_FILE_LIMIT", 10)))
    : [];
  const sourcePatternFiles = collectSourcePatternFiles(allFiles, issueBrief.target_path);
  const authoritySourceCandidates = collectAuthoritySourceCandidates(worktree, sourcePatternFiles);
  const siblingSpecExemplar = collectSiblingSpecExemplar(worktree, allFiles, issueBrief.target_path);
  const repoGuidance = buildRepoGuidanceContext(worktree);
  const nonPdfAuthorityCandidates = authoritySourceCandidates
    .map((entry) => entry.url)
    .filter((url) => !/\.pdf(?:$|[?#])/i.test(url))
    .slice(0, Number(env("AE_LOCAL_CODER_NON_PDF_SOURCE_CANDIDATE_LIMIT", 6)));

  return {
    git_status: truncate(status.stdout, 4000),
    // The real current date, injected directly rather than relying on the model
    // to run `date`. Observed repeatedly (Qwen3-Coder and DeepSeek-V3.2 alike):
    // the coder ignores a "run date -u" instruction and writes a plausible-but-
    // wrong date recalled from training data, producing spec.yaml files whose
    // stale_after has already passed on the day they're created. Giving it the
    // date as data removes the dependency on tool-following behavior entirely.
    current_date_utc: new Date().toISOString().slice(0, 10),
    target_path: issueBrief.target_path ?? null,
    required_first_steps: requiresAuthorityResearch(issueBrief)
      ? [
          sourcePatternFiles.length > 0
            ? `Read or search structured source pattern files before broad URL guessing: ${sourcePatternFiles.slice(0, 4).join(", ")}.`
            : "Search the repository for existing structured source records before broad URL guessing.",
          nonPdfAuthorityCandidates.length > 0
            ? `Use these repo-derived non-PDF authority candidates first with curl -sSL before trying PDFs: ${nonPdfAuthorityCandidates.join(", ")}.`
            : "Prefer non-PDF authority pages first; PDF sources are acceptable only when converted to small text snippets, never dumped as raw bytes."
        ]
      : [],
    files: allFiles.slice(0, Number(env("AE_LOCAL_CODER_FILE_LIST_LIMIT", 10))),
    related_file_prefix: relatedPrefix || null,
    related_files: relatedFiles,
    source_pattern_files: sourcePatternFiles,
    source_pattern_instruction: sourcePatternFiles.length > 0
      ? "If authority source URL commands fail, read or search these repository files to find proven public authority source patterns before trying more URLs. These files are dynamic repo context, not hardcoded sources."
      : "If authority source URL commands fail, search repository research-summary.json and manifest.yaml files for proven public authority source patterns before trying more URLs.",
    authority_source_candidates_from_repo_patterns: authoritySourceCandidates,
    sibling_spec_exemplar: siblingSpecExemplar,
    repo_quality_contract: repoGuidance,
    total_tracked_files: allFiles.length,
    package_json: truncate(packageJson.stdout, Number(env("AE_LOCAL_CODER_PACKAGE_JSON_CHARS", 300))),
    readme: truncate(readme.stdout, Number(env("AE_LOCAL_CODER_README_CHARS", 300)))
  };
}

function summarizeInitialContext(initialContext, issueBrief) {
  return {
    issue_number: issueBrief.issue_number || null,
    target_path: issueBrief.target_path,
    full_prompt_chars: issueBrief.full_prompt_chars,
    brief_chars: JSON.stringify(issueBrief).length,
    git_status_chars: initialContext.git_status.length,
    listed_files: initialContext.files.length,
    related_file_prefix: initialContext.related_file_prefix,
    related_files: initialContext.related_files.length,
    source_pattern_files: initialContext.source_pattern_files.length,
    authority_source_candidates_from_repo_patterns: initialContext.authority_source_candidates_from_repo_patterns.length,
    repo_guidance_files: initialContext.repo_quality_contract?.reference_files?.length ?? 0,
    total_tracked_files: initialContext.total_tracked_files,
    package_json_chars: initialContext.package_json.length,
    readme_chars: initialContext.readme.length
  };
}

// Delivery-contract guidance is entirely repo-dependent (what "complete" output
// looks like differs per target repo) and must never be hardcoded into this
// shared engine. The only guidance the coder gets is whatever the target repo
// itself documents in .github/copilot-instructions.md -- same convention the
// reviewer role already uses. If a repo has no such file, the coder gets no
// fabricated format assumptions and works from the issue body alone.
function buildRepoGuidanceContext(worktree) {
  const existingGuidanceFiles = REPO_GUIDANCE_FILES.filter((file) => fs.existsSync(path.join(worktree, file)));
  const copilotInstructions = readTextIfExists(
    worktree,
    ".github/copilot-instructions.md",
    Number(env("AE_LOCAL_CODER_GUIDANCE_FILE_CHARS", 8000))
  );
  return {
    source: "target repository Codex/review guidance",
    reference_files: existingGuidanceFiles,
    copilot_review_instructions: copilotInstructions,
    delivery_contract_summary: copilotInstructions
      ? ["Treat the issue body as source of truth.", "Follow copilot_review_instructions above for this repo's required output format and completeness bar."]
      : ["Treat the issue body as source of truth.", "No repo-specific delivery contract is configured; use the smallest complete change that resolves the issue."]
  };
}

function qualityRequirements(issueBrief, qualityState) {
  const requirements = [
    "Do not use placeholders, example.com, generic labels, TODO/TBD, or invented source records.",
    "When an issue asks for authority sources, perform source research with command actions before writing files. Use public sources retrieved or inspected during the run; do not invent URLs.",
    "Choose authority sources from the issue, repository patterns, and the specialty domain. Prefer primary public authorities and standards bodies over secondary explainers."
  ];
  requirements.push("Follow the target repo's own delivery contract in .github/copilot-instructions.md when present; it defines what a complete, correct submission looks like for this specific repo.");
  if (qualityState.requiresAuthorityResearch) {
    requirements.push(`At least ${Number(env("AE_AUTHORITY_RESEARCH_MIN_SOURCES", 6))} government, education, nonprofit, or open-access authority source URLs must be researched through commands before writes under the target package are accepted.`);
    requirements.push("curl or wget research commands must fetch usable source body content; headers-only responses, raw binary/PDF dumps, and ordinary commercial public pages do not count.");
  }
  return requirements;
}

function totalMessageChars(messages) {
  return messages.reduce((sum, message) => sum + String(message?.content ?? "").length, 0);
}

function compactRepoQualityContract(contract = {}) {
  return {
    source: contract.source ?? null,
    reference_files: normalizeArray(contract.reference_files),
    copilot_review_instructions: contract.copilot_review_instructions ?? null,
    delivery_contract_summary: normalizeArray(contract.delivery_contract_summary).slice(0, 5)
  };
}

function compactObservationForContext(observation) {
  const observationChars = Number(env("AE_LOCAL_CODER_COMPACT_OBSERVATION_CHARS", 220));
  const compactedContent = observation?.type === "read_file"
    ? undefined
    : observation?.content ? truncate(observation.content, observationChars) : undefined;
  const compacted = {
    type: observation?.type ?? null,
    path: observation?.path ?? null,
    query: observation?.query ?? null,
    glob: observation?.glob ?? null,
    command: observation?.command ?? null,
    status: observation?.status ?? null,
    rejected: observation?.rejected === true || undefined,
    skipped: observation?.skipped === true || undefined,
    error: observation?.error ?? null,
    issues: normalizeArray(observation?.issues).slice(0, 8),
    authority_urls: normalizeArray(observation?.authority_urls).slice(0, 6),
    content: compactedContent,
    stdout: observation?.stdout ? truncate(observation.stdout, observationChars) : undefined,
    stderr: observation?.stderr ? truncate(observation.stderr, observationChars) : undefined
  };
  return Object.fromEntries(Object.entries(compacted).filter(([, value]) => {
    if (value == null || value === "") {
      return false;
    }
    return !Array.isArray(value) || value.length > 0;
  }));
}

function followupInstruction({ observations, status, authorityResearchDone, qualityState, iterationsRemaining, forcedByBudget }) {
  const budgetSuffix = Number.isFinite(iterationsRemaining)
    ? ` (${iterationsRemaining} iteration${iterationsRemaining === 1 ? "" : "s"} remaining in this run.)`
    : "";
  if (observations.some((observation) => observation.type === "repeat_action")) {
    return `Your last action repeated earlier work and was rejected. Do not repeat the same read/search/command set or any blocked command. Gather different authority evidence from a different public authority host/path, search the repo for a better source direction, or write the implementation under ${qualityState.targetPath || "the target path"}.${budgetSuffix}`;
  }
  if (forcedByBudget) {
    return `There is not enough of the iteration budget left to keep researching${budgetSuffix} Stop gathering new authority sources now and write the required files under ${qualityState.targetPath || "the target path"} using whatever evidence has already been gathered, even if it feels incomplete -- a partially-sourced package that gets written beats one that never gets written. Set done true once written.`;
  }
  if (status) {
    return `Continue if more work is needed. Set done true only when the implementation is complete.${budgetSuffix}`;
  }
  if (authorityResearchDone) {
    return `Authority-source research is complete with ${qualityState.authorityResearchEvidence.length} public authority URL(s). Do not run more research-only reads, searches, or source commands. Write the implementation under ${qualityState.targetPath || "the target path"}.${budgetSuffix}`;
  }
  return `No repository changes are present yet. Continue with new authority-source evidence or write the implementation under ${qualityState.targetPath || "the target path"}.${budgetSuffix}`;
}

function compactIssueBriefForContext(issueBrief = {}) {
  const compactChars = Number(env("AE_LOCAL_CODER_COMPACT_BRIEF_FIELD_CHARS", 1200));
  return {
    title: issueBrief.title ?? "",
    issue_number: issueBrief.issue_number ?? "",
    target_path: issueBrief.target_path ?? null,
    specialty_boundary: truncate(issueBrief.specialty_boundary ?? "", compactChars),
    constrained_research_contract: truncate(issueBrief.constrained_research_contract ?? "", compactChars),
    operational_build_brief: truncate(issueBrief.operational_build_brief ?? "", compactChars),
    requested_change: truncate(issueBrief.requested_change ?? "", compactChars),
    authority_sources: truncate(issueBrief.authority_sources ?? "", compactChars),
    evaluation_expectations: truncate(issueBrief.evaluation_expectations ?? "", compactChars),
    acceptance_criteria: truncate(issueBrief.acceptance_criteria ?? "", compactChars),
    materialization_expectations: truncate(issueBrief.materialization_expectations ?? "", compactChars)
  };
}

function buildCompactConversationPayload({
  issueBrief,
  initialContext,
  qualityState,
  observations,
  status,
  instruction
}) {
  return {
    issue_brief: compactIssueBriefForContext(issueBrief),
    current_date_utc: initialContext.current_date_utc ?? null,
    working_context: {
      target_path: qualityState.targetPath || initialContext.target_path || null,
      related_file_prefix: initialContext.related_file_prefix ?? null,
      source_pattern_files: normalizeArray(initialContext.source_pattern_files).slice(0, 6),
      source_pattern_instruction: initialContext.source_pattern_instruction ?? null,
      authority_source_candidates_from_repo_patterns: normalizeArray(initialContext.authority_source_candidates_from_repo_patterns).slice(0, 4),
      sibling_spec_exemplar: initialContext.sibling_spec_exemplar ?? null,
      repo_quality_contract: compactRepoQualityContract(initialContext.repo_quality_contract)
    },
    quality_requirements: qualityRequirements(issueBrief, qualityState),
    quality_progress: qualityProgress(qualityState),
    researched_authority_urls: normalizeArray(qualityState.authorityResearchEvidence).slice(0, 14),
    blocked_commands: normalizeArray(qualityState.failedCommands).slice(-10),
    recent_observations: normalizeArray(observations).slice(-12).map(compactObservationForContext),
    git_status: status,
    instruction
  };
}

function buildStartupContext(initialContext = {}, issueBrief = {}, qualityState = {}) {
  return {
    git_status: initialContext.git_status,
    current_date_utc: initialContext.current_date_utc ?? null,
    target_path: qualityState.targetPath || initialContext.target_path || issueBrief.target_path || null,
    required_first_steps: normalizeArray(initialContext.required_first_steps).slice(0, 3),
    related_file_prefix: initialContext.related_file_prefix ?? null,
    source_pattern_files: normalizeArray(initialContext.source_pattern_files).slice(0, 6),
    source_pattern_instruction: initialContext.source_pattern_instruction ?? null,
    authority_source_candidates_from_repo_patterns: normalizeArray(initialContext.authority_source_candidates_from_repo_patterns).slice(0, 4),
    sibling_spec_exemplar: initialContext.sibling_spec_exemplar ?? null,
    repo_quality_contract: compactRepoQualityContract(initialContext.repo_quality_contract),
    total_tracked_files: initialContext.total_tracked_files ?? null
  };
}

function maybeCompactConversation({
  messages,
  issueBrief,
  initialContext,
  qualityState,
  observations,
  status,
  instruction
}) {
  const threshold = Number(env("AE_LOCAL_CODER_CONTEXT_COMPACT_CHARS", 26000));
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return;
  }
  const beforeChars = totalMessageChars(messages);
  if (beforeChars <= threshold) {
    return;
  }
  const compactPayload = buildCompactConversationPayload({
    issueBrief,
    initialContext,
    qualityState,
    observations,
    status,
    instruction
  });
  messages.splice(
    0,
    messages.length,
    { role: "system", content: systemPrompt(qualityState) },
    { role: "user", content: JSON.stringify(compactPayload, null, 2) }
  );
  process.stdout.write(`\n[lane-coder context-compact]\n${JSON.stringify({
    threshold_chars: threshold,
    before_chars: beforeChars,
    after_chars: totalMessageChars(messages),
    messages: messages.length,
    researched_authority_urls: compactPayload.researched_authority_urls.length,
    recent_observations: compactPayload.recent_observations.length
  }, null, 2)}\n`);
}

function extractSection(text, heading, nextHeadings = []) {
  const startPattern = new RegExp(`(^|\\n)## ${heading}\\n`, "i");
  const start = text.search(startPattern);
  if (start < 0) {
    return "";
  }
  const afterStart = text.slice(start).replace(startPattern, "");
  const nextIndexes = nextHeadings
    .map((next) => afterStart.search(new RegExp(`\\n## ${next}\\n`, "i")))
    .filter((index) => index >= 0);
  const end = nextIndexes.length > 0 ? Math.min(...nextIndexes) : afterStart.length;
  return afterStart.slice(0, end).trim();
}

// Derive the spec target_path from an issue's "Queue Agent Slug" using the
// repo's configured catalog layout. labor-commons issues carry a
// "::"-delimited slug (e.g. industry-overlays::{section}::{agent}) and no
// filesystem path, so the old-layout regex below finds nothing and target_path
// would be null -- which silently disables section-based sibling harvesting.
function deriveTargetPathFromSlug(prompt) {
  const overlayRoot = String(env("AE_CATALOG_OVERLAY_ROOT", "")).replace(/\/+$/, "");
  const specFilename = String(env("AE_CATALOG_SPEC_FILENAME", "")).trim();
  if (!overlayRoot || !specFilename) {
    return null;
  }
  const slug = extractSection(prompt, "Queue Agent Slug", ["Agent Name"]).trim();
  if (!slug) {
    return null;
  }
  const slugPrefix = String(env("AE_CATALOG_SLUG_PREFIX", "")).trim();
  let segments = slug.split("::").map((part) => part.trim()).filter(Boolean);
  if (slugPrefix && segments[0] === slugPrefix) {
    segments = segments.slice(1);
  }
  if (segments.length < 2) {
    return null;
  }
  return `${overlayRoot}/${segments.join("/")}/${specFilename}`;
}

function buildIssueBrief(prompt) {
  const targetPath =
    prompt.match(/agents\/catalog\/industry-overlays\/[^\s`]+/)?.[0] ??
    deriveTargetPathFromSlug(prompt) ??
    null;
  const brief = {
    title: env("AE_ISSUE_TITLE", ""),
    issue_number: env("AE_ISSUE_NUMBER", ""),
    target_path: targetPath,
    specialty_boundary: extractSection(prompt, "Specialty Boundary", ["Semantic Definition Profile"]),
    constrained_research_contract: extractSection(prompt, "Constrained Research Contract", ["Operational Build Brief"]),
    operational_build_brief: extractSection(prompt, "Operational Build Brief", ["Required Semantic Inclusions"]),
    requested_change: extractSection(prompt, "Requested Change", ["Authority Sources"]),
    authority_sources: extractSection(prompt, "Authority Sources", ["Evaluation And Accuracy Expectations"]),
    evaluation_expectations: extractSection(prompt, "Evaluation And Accuracy Expectations", ["Materialization Expectations"]),
    acceptance_criteria: extractSection(prompt, "Acceptance Criteria", ["Risks And Unknowns"]),
    materialization_expectations: extractSection(prompt, "Materialization Expectations", ["Acceptance Criteria"]),
    execution_requirements: extractSection(prompt, "Execution requirements", ["Operating constraints"]),
    operating_constraints: extractSection(prompt, "Operating constraints", []),
    full_prompt_chars: prompt.length
  };
  return JSON.parse(JSON.stringify(brief, (key, value) => {
    if (typeof value === "string") {
      return truncate(value, Number(env("AE_LOCAL_CODER_BRIEF_FIELD_CHARS", 2000)));
    }
    return value;
  }));
}

async function chatWithOllama({ baseUrl, model, messages }) {
  const options = {
    temperature: Number(env("AE_LOCAL_CODER_TEMPERATURE", 0.2)),
    num_ctx: Number(env("AE_LOCAL_CODER_NUM_CTX", DEFAULT_OLLAMA_NUM_CTX))
  };
  const keepAlive = env("AE_LOCAL_CODER_KEEP_ALIVE", env("AE_LOCAL_MODEL_KEEP_ALIVE", DEFAULT_OLLAMA_KEEP_ALIVE));
  const numThread = parsePositiveInteger(env("AE_LOCAL_CODER_NUM_THREAD", ""));
  if (numThread) {
    options.num_thread = numThread;
  }
  const messageChars = messages.map((message) => String(message?.content ?? "").length);
  process.stdout.write(`\n[lane-coder ollama request]\n${JSON.stringify({
    model,
    endpoint: joinUrl(baseUrl, "/api/chat"),
    stream: parseBoolean(env("AE_LOCAL_CODER_STREAM", "1"), true),
    format: env("AE_LOCAL_CODER_OLLAMA_FORMAT", "json"),
    keep_alive: keepAlive,
    messages: messages.length,
    message_chars: messageChars,
    total_message_chars: messageChars.reduce((sum, value) => sum + value, 0),
    options
  }, null, 2)}\n`);
  await logOllamaRuntimeSnapshot(baseUrl, "before-chat");
  return await fetchOllamaChatStream(
    joinUrl(baseUrl, "/api/chat"),
    {
      model,
      stream: parseBoolean(env("AE_LOCAL_CODER_STREAM", "1"), true),
      format: env("AE_LOCAL_CODER_OLLAMA_FORMAT", "json"),
      keep_alive: keepAlive,
      messages,
      options
    },
    {
      baseUrl,
      timeoutMs: Number(env("AE_LOCAL_CODER_CHAT_TIMEOUT_MS", DEFAULT_CHAT_TIMEOUT_MS))
    }
  );
}

async function chatWithLmStudio({ endpoint, model, messages }) {
  // Without an explicit max_tokens, the provider's own default output cap
  // applies — observed live truncating a real response mid-string (a raw,
  // unterminated JSON string literal cut off mid-sentence around ~4-5K
  // output tokens), which is unrecoverable by any response-repair logic
  // since the content genuinely never finished generating. A full spec-pack
  // response writing several files needs more headroom than most chat
  // providers default to.
  const body = await fetchJson(joinUrl(endpoint, "/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env("OPENAI_API_KEY", "local-model")}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number(env("AE_LOCAL_CODER_TEMPERATURE", 0.2)),
      max_tokens: Number(env("AE_LOCAL_CODER_MAX_TOKENS", 16000))
    }),
    timeoutMs: Number(env("AE_LOCAL_CODER_CHAT_TIMEOUT_MS", DEFAULT_CHAT_TIMEOUT_MS))
  });
  return String(body?.choices?.[0]?.message?.content ?? "");
}

// The engine has no built-in notion of any repo's schema, field names, or
// content conventions. All of that belongs in the target repo's own
// .github/copilot-instructions.md, which is already read generically and
// handed to the coder as initial_context.repo_quality_contract /
// working_context.repo_quality_contract, described below as binding -- a
// repo that wants schema-specific rules (field shapes, citation
// preferences, date-field handling, slug-verification requirements, etc.)
// puts them there, not in this engine. The only conditional section here is
// the authority-research process block, included solely when this repo
// opted into that gate (repo.quality_gates.authority_research -- see
// config.mjs); it describes only the generic mechanics of the gate itself,
// never what counts as a "source" for any particular repo.
function systemPrompt(qualityState = {}) {
  const researchRules = qualityState.requiresAuthorityResearch
    ? `
- This repo requires authority-source research before writing package files (see initial_context.repo_quality_contract for what counts as a valid source here). Run command actions to retrieve and verify sources before writing.
- If initial_context.authority_source_candidates_from_repo_patterns or working_context.authority_source_candidates_from_repo_patterns is populated, prefer building from those URLs: they are drawn from already-researched related repository content and are pre-vetted candidates.
- Keep command output small. Prefer targeted source snippets, titles, or repository searches over dumping full web pages, PDFs, archives, or full large files.
- If multiple source URLs fail, stop inventing deep URLs. Search or read related repository files near the target path to find proven URL patterns, then fetch those.
- Do not use echo or printf as research. Research commands must inspect real source URLs or repository evidence.
- Use curl -sSL for source checks. Headers-only requests, empty responses, and raw binary/PDF dumps are not evidence.
- Only cite a URL that is either (a) taken from the provided repo-derived candidates, or (b) one you have fetched successfully (HTTP 200) with curl during this run. Do NOT write a plausible-looking URL from memory that you have not confirmed.`
    : "";
  return `You are AE Lane Coder, a coding agent running inside a repository worktree.
You are not Codex and you must not rely on Codex.
Use the local tools exposed by this runner by replying with one JSON object only.

Allowed JSON fields:
- "read_files": array of repository-relative paths to inspect.
- "searches": array of strings or {"query":"text","glob":"optional glob"} objects.
- "commands": array of shell commands to run in the worktree.
- "write_files": array of {"path":"repo-relative path","content":"complete file content"}.
- "unified_diff": a git-apply compatible unified diff.
- "done": boolean. Set true only when the requested code change is implemented.
- "summary": short note about what changed or what you need next.

Rules:
- This run has a hard, finite iteration budget (each follow-up message states how many iterations remain). Research is only useful if it leaves enough turns to actually write the required files -- budget accordingly rather than researching indefinitely.
- The target repository guidance supplied in initial_context.repo_quality_contract or working_context.repo_quality_contract is binding. Use it as the local equivalent of the repo's Codex instructions and audit contract -- it is the authoritative source for this repo's schema, field conventions, and content requirements, not this prompt.
- Prefer reading/searching before writing unless the required edit is obvious.
- For the first response on a new issue, return a small read/search/command action to inspect the repository shape and requirements; do not try to produce the whole implementation from startup context alone.
- If a command fails, do not repeat the same command. Correct the syntax or choose a different command.
- Write only under the target_path from the user context unless explicitly asked to modify shared config.
- If initial_context.sibling_spec_exemplar or working_context.sibling_spec_exemplar is present, it is a real, currently-accepted example from the same area of the repo. Match its depth and structure (do not copy its content -- your task is different, but match its level of specificity and completeness, including every structural section it has).
- Never use placeholders, example.com, generic "Scenario 1" style labels, or TODO/TBD text.${researchRules}
- When writing a file, provide the complete desired content for that file.
- Keep changes focused on the issue.
- Do not edit .git internals.
- Return valid JSON only.`;
}

// A single transient failure from the model call (429 concurrency limit, a
// 502/503/504 gateway hiccup, a raw network-level "fetch failed") previously
// propagated straight out of the iteration loop and killed the entire run —
// discarding every read/search/write accumulated so far, forcing the
// dispatcher to restart the whole issue from iteration 1. Since this shared
// account sits near its concurrency ceiling most of the time, that made a
// full multi-file spec-pack task very unlikely to ever finish. Retrying the
// call itself (not the JSON-parsing of its response, which extractJsonObject
// already tolerates) with backoff keeps the accumulated conversation history
// intact across what is usually a 10-30 second external blip.
function isRetryableChatError(error) {
  const message = String(error?.message ?? "");
  return /^42\d\s/.test(message) ||
    /^5\d\d\s/.test(message) ||
    /fetch failed/i.test(message) ||
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message);
}

async function chatWithRetry(chat) {
  const maxRetries = Number(env("AE_LOCAL_CODER_CHAT_MAX_RETRIES", 6));
  const baseDelayMs = Number(env("AE_LOCAL_CODER_CHAT_RETRY_BASE_MS", 3000));
  const maxDelayMs = Number(env("AE_LOCAL_CODER_CHAT_RETRY_MAX_MS", 30000));
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await chat();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryableChatError(error)) {
        throw error;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      process.stdout.write(
        `\n[lane-coder chat retry]\n${JSON.stringify({
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          error: truncate(error.message, 300)
        }, null, 2)}\n`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function runLaneCoder({ provider, model, endpoint, baseUrl, worktree, prompt }) {
  const issueBrief = buildIssueBrief(prompt);
  const qualityState = buildQualityState(issueBrief);
  const initialContext = await buildInitialContext(worktree, issueBrief);
  qualityState.sourcePatternFiles = normalizeArray(initialContext.source_pattern_files);
  process.stdout.write(`\n[lane-coder context]\n${JSON.stringify(summarizeInitialContext(initialContext, issueBrief), null, 2)}\n`);
  const messages = [
    { role: "system", content: systemPrompt(qualityState) },
    {
      role: "user",
      content: JSON.stringify({
        issue_brief: compactIssueBriefForContext(issueBrief),
        initial_context: buildStartupContext(initialContext, issueBrief, qualityState),
        quality_requirements: qualityRequirements(issueBrief, qualityState)
      }, null, 2)
    }
  ];

  const chat = provider === "ollama"
    ? () => chatWithOllama({ baseUrl, model, messages })
    : () => chatWithLmStudio({ endpoint, model, messages });

  const noOpActionFingerprints = new Set();
  const maxNoProgressTurns = Number(env("AE_LOCAL_CODER_MAX_NO_PROGRESS_TURNS", DEFAULT_MAX_NO_PROGRESS_TURNS));
  const maxIterations = Number(env("AE_LOCAL_CODER_MAX_ITERATIONS", MAX_ITERATIONS));
  const forceWriteIterationsRemaining = Number(env(
    "AE_LOCAL_CODER_FORCE_WRITE_ITERATIONS_REMAINING",
    DEFAULT_FORCE_WRITE_ITERATIONS_REMAINING
  ));
  let consecutiveNoProgressTurns = 0;
  let forcedFinalWriteAttempted = false;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    process.stderr.write(`Lane coder iteration ${iteration}\n`);
    const response = await chatWithRetry(chat);
    process.stdout.write(`\n[lane-coder response ${iteration}]\n${response}\n`);
    let action;
    let parseError = null;
    try {
      action = extractJsonObject(response);
    } catch (error) {
      // A response that still isn't valid JSON after every repair attempt
      // (extractJsonObject's own fallbacks) must not crash the whole run --
      // every other action failure (corrupt diff, rejected write, blocked
      // command) is already a recoverable turn; an unparseable response is
      // the one thing that wasn't, and it's thrown away three different
      // observed ways in production. Treat it the same as any other
      // rejected action instead.
      action = {};
      parseError = error;
    }
    const fingerprint = actionFingerprint(action);
    let repeatedNoOpAction = false;
    let observations;
    if (parseError) {
      observations = [{
        type: "parse_error",
        rejected: true,
        error: truncate(parseError.message, 500),
        instruction: "The previous response could not be parsed as JSON and was not executed. Return exactly one valid JSON object with no leading or trailing text. If a string value needs a literal backslash (for example from a regex), escape it as two backslash characters, not one."
      }];
      process.stdout.write(`\n[lane-coder action]\n${JSON.stringify({
        parseError: true,
        writes: 0,
        unifiedDiff: false,
        done: false
      }, null, 2)}\n`);
      process.stdout.write(`\n[lane-coder observations]\n${JSON.stringify(observations, null, 2)}\n`);
    } else if (!actionWritesRepository(action) && action.done !== true && noOpActionFingerprints.has(fingerprint)) {
      repeatedNoOpAction = true;
      observations = [{
        type: "repeat_action",
        rejected: true,
        blocked_commands: normalizeArray(qualityState.failedCommands).slice(-8),
        instruction: "This repeats a previous read/search/command action and was not executed. Return a different action. Do not emit any blocked command again."
      }];
      process.stdout.write(`\n[lane-coder action]\n${JSON.stringify({
        repeated: true,
        writes: 0,
        unifiedDiff: false,
        done: false
      }, null, 2)}\n`);
      process.stdout.write(`\n[lane-coder observations]\n${JSON.stringify(observations, null, 2)}\n`);
    } else {
      observations = await executeAction(worktree, action, qualityState);
      if (!actionWritesRepository(action) && action.done !== true) {
        noOpActionFingerprints.add(fingerprint);
      }
    }
    const status = await gitStatus(worktree);
    const rejectedNoWriteAction = !actionWritesRepository(action) && observations.some((observation) => observation.rejected);
    const madeProgress = Boolean(status) || observations.some(observationShowsProgress);
    consecutiveNoProgressTurns = madeProgress ? 0 : consecutiveNoProgressTurns + 1;

    if (consecutiveNoProgressTurns >= maxNoProgressTurns) {
      // Before giving up, if nothing has been written to the worktree yet, spend
      // one final turn forcing a write with whatever context is already gathered.
      // The common failure otherwise is a run that researches (and gets research
      // commands rejected) until it trips this counter, producing NOTHING --
      // strictly worse than a spec written from the exemplar + sources already in
      // context. Only escalate to a hard stop if that forced write also fails.
      if (!status && !forcedFinalWriteAttempted) {
        forcedFinalWriteAttempted = true;
        consecutiveNoProgressTurns = 0;
        noOpActionFingerprints.clear();
        const targetPathForWrite = qualityState.targetPath || initialContext.target_path || issueBrief.target_path || "the target path";
        messages.push({
          role: "user",
          content: JSON.stringify({
            forced_final_write: true,
            instruction:
              `You are out of research turns and have written nothing. Stop all reads, searches, and commands. In THIS turn, return a write_files action that writes the complete file at ${targetPathForWrite}. ` +
              "If a sibling_spec_exemplar was provided, match its depth and structure. Use whatever research/sources you have already gathered. A complete file written now is required; partial sourcing is acceptable."
          })
        });
        process.stdout.write(`\n[lane-coder forced-final-write]\n${JSON.stringify({ target_path: targetPathForWrite }, null, 2)}\n`);
        continue;
      }
      const noProgressSummary = {
        consecutive_no_progress_turns: consecutiveNoProgressTurns,
        max_no_progress_turns: maxNoProgressTurns,
        failed_commands: normalizeArray(qualityState.failedCommands).slice(-8),
        instruction: "stopping local coder run after repeated rejected or empty actions with no repository changes"
      };
      process.stdout.write(`\n[lane-coder no-progress-stop]\n${JSON.stringify(noProgressSummary, null, 2)}\n`);
      throw new Error(`Lane coder stopped after ${consecutiveNoProgressTurns} consecutive no-progress turns`);
    }

    if (!repeatedNoOpAction) {
      messages.push({
        role: "assistant",
        content: JSON.stringify(rejectedNoWriteAction
          ? {
              rejected_action: true,
              summary: "The previous action was rejected and produced no repository changes."
            }
          : action)
      });
    }
    const iterationsRemaining = maxIterations - iteration;
    const authorityResearchMet = qualityState.authorityResearchEvidence.length >=
      Number(env("AE_AUTHORITY_RESEARCH_MIN_SOURCES", 6));
    const forcedByBudget = !authorityResearchMet && !status && iterationsRemaining <= forceWriteIterationsRemaining;
    if (forcedByBudget) {
      qualityState.authorityResearchWaived = true;
    }
    const authorityResearchDone = qualityState.requiresAuthorityResearch &&
      (authorityResearchMet || qualityState.authorityResearchWaived);
    const instruction = followupInstruction({
      observations,
      status,
      authorityResearchDone,
      qualityState,
      iterationsRemaining,
      forcedByBudget: qualityState.authorityResearchWaived && !authorityResearchMet
    });
    messages.push({
      role: "user",
      content: JSON.stringify({
        observations,
        git_status: status,
        quality_progress: qualityProgress(qualityState),
        instruction
      }, null, 2)
    });
    maybeCompactConversation({
      messages,
      issueBrief,
      initialContext,
      qualityState,
      observations,
      status,
      instruction
    });

    if (action.done === true && status) {
      await validateLocalCoderQuality(worktree, issueBrief, qualityState);
      process.stdout.write(`\nLane coder completed with changes:\n${status}\n`);
      return;
    }
  }

  const status = await gitStatus(worktree);
  if (status) {
    await validateLocalCoderQuality(worktree, issueBrief, qualityState);
    process.stdout.write(`\nLane coder reached the iteration limit with changes:\n${status}\n`);
    return;
  }
  throw new Error("Lane coder finished without producing repository changes");
}

async function finalizeLocalPullRequest(worktree) {
  if (!parseBoolean(env("AE_LOCAL_CODER_CREATE_PR", "1"), true)) {
    return;
  }

  const issueNumber = env("AE_ISSUE_NUMBER", "");
  const issueTitle = env("AE_ISSUE_TITLE", `Issue #${issueNumber}`).trim();
  const branchName = env("AE_BRANCH_NAME", "");
  const baseBranch = env("AE_PR_BASE_BRANCH", "main");
  if (!issueNumber || !branchName) {
    throw new Error("AE_ISSUE_NUMBER and AE_BRANCH_NAME are required to create the local coder PR");
  }

  // The per-write auto-fix in executeAction only covers files the model
  // rewrote in the *current* session -- a remediation run that leaves an
  // already-broken file untouched (e.g. it was written by an earlier,
  // separate coder invocation before this auto-fix existed) never gets
  // fixed there. The validator checks the PR's whole diff against base, so
  // sweep that same full diff here, once, right before the final commit.
  await autoFixMarkdownDiffAgainstBase(worktree, baseBranch);

  const status = await gitStatus(worktree);
  if (status) {
    await requireCommandSuccess("git", ["add", "-A"], { cwd: worktree });
    await requireCommandSuccess("git", ["config", "user.name", env("AE_GIT_AUTHOR_NAME", "AE Lane Coder")], { cwd: worktree });
    await requireCommandSuccess("git", ["config", "user.email", env("AE_GIT_AUTHOR_EMAIL", "ae-lane-coder@example.invalid")], { cwd: worktree });
    await requireCommandSuccess("git", ["commit", "-m", `Resolve issue #${issueNumber}`], { cwd: worktree });
  }

  // Force-push deliberately: this is the coder's own dedicated one-shot
  // branch for this issue, not a shared/collaborative one, and the
  // dispatcher hands out a brand-new worktree (rebuilt from main) on every
  // attempt rather than reusing the previous attempt's local branch state.
  // A plain push non-fast-forwards the moment any earlier attempt --
  // including one that hit the iteration limit without finishing -- already
  // pushed something under this same branch name, which otherwise silently
  // discards this run's work with a rejected push (observed live on
  // labor-commons issue #11).
  await requireCommandSuccess("git", ["push", "--force", "-u", "origin", `HEAD:${branchName}`], {
    cwd: worktree,
    timeoutMs: Number(env("AE_LOCAL_CODER_GIT_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS))
  });

  // `gh pr view <branch>` returns the most recent PR for that head branch
  // regardless of state -- a CLOSED PR from an earlier, abandoned attempt on
  // this same branch name (observed live: labor-commons issue #11's PR #36,
  // closed when its stale branch was deleted during a git-history cleanup)
  // otherwise looks identical to a genuinely still-open PR here, so every
  // subsequent run silently no-ops instead of opening a fresh PR -- the
  // dispatcher then keeps re-dispatching the issue forever since no open PR
  // ever actually appears. Only short-circuit on an OPEN PR.
  const existing = await runCommand("gh", ["pr", "view", branchName, "--json", "url,state", "--jq", "if .state == \"OPEN\" then .url else \"\" end"], {
    cwd: worktree,
    timeoutMs: Number(env("AE_LOCAL_CODER_GH_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS))
  });
  if (existing.status === 0 && existing.stdout.trim()) {
    process.stdout.write(`\nLane coder PR already exists: ${existing.stdout.trim()}\n`);
    return;
  }

  // If this repo's own issue_source.required_issue_prefix (see config.mjs)
  // already gives every matched issue title a repo-chosen prefix, keep it
  // verbatim rather than double-prefixing with a generic "Resolve #N:".
  const requiredPrefix = String(env("AE_ISSUE_REQUIRED_PREFIX", ""));
  const title = requiredPrefix && issueTitle.startsWith(requiredPrefix)
    ? issueTitle
    : `Resolve #${issueNumber}: ${issueTitle}`;
  const provider = env("AE_LANE_PROVIDER", "");
  const model = env("AE_LANE_MODEL", "");
  const body = [
    `Closes #${issueNumber}.`,
    "",
    `Created by AE Lane Coder using ${model || "the configured model"}${provider ? ` (${provider})` : ""}.`
  ].join("\n");
  const created = await requireCommandSuccess(
    "gh",
    ["pr", "create", "--base", baseBranch, "--head", branchName, "--title", title, "--body", body],
    {
      cwd: worktree,
      timeoutMs: Number(env("AE_LOCAL_CODER_GH_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS))
    }
  );
  process.stdout.write(`\nLane coder PR created: ${created.stdout.trim()}\n`);
}

async function main() {
  const provider = env("AE_LOCAL_MODEL_PROVIDER", "ollama");
  const model = env("AE_LANE_MODEL", env("AE_LOCAL_MODEL_NAME", "qwen2.5-coder:7b"));
  const endpoint = env("AE_LOCAL_MODEL_ENDPOINT", "http://local-model:11434/v1");
  const healthUrl = env("AE_LOCAL_MODEL_HEALTH_URL", "");
  const worktree = env("AE_WORKTREE");
  const promptPath = env("AE_ISSUE_PROMPT_PATH");
  const autoPull = parseBoolean(env("AE_LOCAL_MODEL_AUTO_PULL"), false);

  if (!worktree) {
    throw new Error("AE_WORKTREE is required");
  }
  if (!promptPath) {
    throw new Error("AE_ISSUE_PROMPT_PATH is required");
  }

  const prompt = fs.readFileSync(promptPath, "utf8");

  if (provider === "ollama") {
    const baseUrl = healthUrl ? healthUrl.replace(/\/api\/tags\/?$/, "") : stripV1(endpoint);
    await ensureOllamaModel({ baseUrl, model, autoPull });
    await runLaneCoder({ provider, model, endpoint, baseUrl, worktree, prompt });
    await finalizeLocalPullRequest(worktree);
    return;
  }

  if (provider === "lmstudio") {
    await ensureLmStudioReady({ endpoint, model });
    await runLaneCoder({ provider, model, endpoint, baseUrl: endpoint, worktree, prompt });
    await finalizeLocalPullRequest(worktree);
    return;
  }

  if (provider === "openai_compatible") {
    // A hosted API (Featherless.ai, etc.) has no local container to wait on
    // readiness for, so there is no ensureXReady step here — the chat call
    // itself is the reachability check, and runLaneCoder's non-ollama
    // branch already authenticates with the real resolved API key via the
    // OPENAI_API_KEY env var engine-role.mjs sets.
    await runLaneCoder({ provider, model, endpoint, baseUrl: endpoint, worktree, prompt });
    await finalizeLocalPullRequest(worktree);
    return;
  }

  throw new Error(`Unsupported local model provider: ${provider}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
