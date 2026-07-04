import { resolveConfigPath, loadConfig, getDispatcherLanes } from "./lib/config.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function stripV1(endpoint) {
  return String(endpoint || "").replace(/\/v1\/?$/, "");
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function parseOllamaList(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

async function fetchOllamaModelsViaCompose(lane) {
  const service = lane.runtime_service || "local-model";
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", "--profile", "local-lane", "exec", "-T", service, "ollama", "list"],
    {
      cwd: process.cwd(),
      timeout: 10000
    }
  );
  return {
    endpoint: `compose://${service}`,
    loadedModels: parseOllamaList(stdout)
  };
}

async function checkLane(lane) {
  const provider = lane.local_provider || "ollama";
  if (provider === "ollama") {
    const baseUrl = lane.runtime_health_url
      ? lane.runtime_health_url.replace(/\/api\/tags\/?$/, "")
      : stripV1(lane.runtime_endpoint);
    let endpoint = baseUrl;
    let loaded = [];
    let composeError = null;
    try {
      const result = await fetchOllamaModelsViaCompose(lane);
      endpoint = result.endpoint;
      loaded = result.loadedModels;
    } catch (error) {
      composeError = error;
    }
    if (loaded.length === 0 && !composeError) {
      return {
        key: lane.key,
        provider,
        endpoint,
        model: lane.name,
        ready: false,
        loadedModels: loaded
      };
    }
    if (composeError) {
      try {
        const body = await fetchJson(joinUrl(baseUrl, "/api/tags"));
        const models = Array.isArray(body?.models) ? body.models : [];
        loaded = models.map((model) => String(model?.name ?? model?.model ?? "")).filter(Boolean);
      } catch (fetchError) {
        throw new Error(
          `Unable to reach Ollama for lane ${lane.key}: compose check failed: ${composeError.message}; endpoint check failed: ${fetchError.message}`
        );
      }
    }
    const modelReady = loaded.some((name) => name === lane.name || name.split(":")[0] === lane.name);
    return {
      key: lane.key,
      provider,
      endpoint,
      model: lane.name,
      ready: modelReady,
      loadedModels: loaded
    };
  }

  if (provider === "lmstudio") {
    const body = await fetchJson(joinUrl(lane.runtime_endpoint, "/models"));
    const loaded = Array.isArray(body?.data)
      ? body.data.map((model) => String(model?.id ?? "")).filter(Boolean)
      : [];
    return {
      key: lane.key,
      provider,
      endpoint: lane.runtime_endpoint,
      model: lane.name,
      ready: loaded.length === 0 || loaded.includes(lane.name),
      loadedModels: loaded
    };
  }

  throw new Error(`Unsupported local provider: ${provider}`);
}

async function main() {
  const config = loadConfig(resolveConfigPath());
  const localLanes = getDispatcherLanes(config).filter((lane) => lane.provider === "local_container");
  if (localLanes.length === 0) {
    throw new Error("No local_container dispatcher lanes are configured");
  }

  const results = [];
  for (const lane of localLanes) {
    results.push(await checkLane(lane));
  }

  process.stdout.write(`${JSON.stringify({ ok: results.every((result) => result.ready), lanes: results }, null, 2)}\n`);
  if (results.some((result) => !result.ready)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
