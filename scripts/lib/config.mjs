import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const REQUIRED_TOP_LEVEL = ["repo", "lifecycle", "issue_source", "safety"];
const DEFAULT_WORKSPACE_DIR = "/workspace/target-repo";
const DEFAULT_LOCAL_RUNTIME_SERVICE = "local-model";
const DEFAULT_LOCAL_RUNTIME_ENDPOINT = "http://local-model:11434/v1";
const DEFAULT_LOCAL_RUNTIME_HEALTH_URL = "http://local-model:11434/api/tags";
const DEFAULT_LOCAL_RUNTIME_IMAGE = "ollama/ollama:latest";
const LOCAL_DISPATCHER_MODELS = new Set(["qwen2.5-coder", "qwen2.5-coder:3b", "qwen2.5-coder:7b", "qwen2.5-coder:14b", "qwen2.5-coder:32b"]);

const DISPATCHER_LANE_DEFAULTS = {
  primary: {
    key: "primary",
    label: "Primary lane",
    provider: "hosted_codex",
    name: "gpt-5.3-codex-spark",
    reasoning_effort: "high",
    enabled: true,
    max_workers: 1,
    pause_threshold_used_percent: 90,
    weekly_pause_threshold_used_percent: 90,
    reserve_burn_window_minutes: 300,
    nominal_burn_per_lane_hour: 3
  },
  secondary: {
    key: "secondary",
    label: "Secondary lane",
    provider: "hosted_codex",
    name: "gpt-5.4",
    reasoning_effort: "medium",
    enabled: true,
    max_workers: 0,
    pause_threshold_used_percent: 70,
    weekly_pause_threshold_used_percent: 70,
    reserve_burn_window_minutes: 300,
    nominal_burn_per_lane_hour: 3
  },
  local: {
    key: "local",
    label: "Local lane",
    provider: "local_container",
    name: "qwen2.5-coder:7b",
    reasoning_effort: "local",
    enabled: false,
    max_workers: 0,
    pause_threshold_used_percent: 100,
    weekly_pause_threshold_used_percent: 100,
    reserve_burn_window_minutes: 300,
    nominal_burn_per_lane_hour: 0,
    runtime_service: DEFAULT_LOCAL_RUNTIME_SERVICE,
    runtime_endpoint: DEFAULT_LOCAL_RUNTIME_ENDPOINT,
    runtime_health_url: DEFAULT_LOCAL_RUNTIME_HEALTH_URL,
    runtime_image: DEFAULT_LOCAL_RUNTIME_IMAGE,
    runtime_command: "",
    local_provider: "ollama",
    num_thread: 0,
    num_ctx: 0,
    keep_alive: "",
    auto_pull: false
  }
};

function asBoolean(value, fallback = false) {
  return value == null ? fallback : Boolean(value);
}

function asInteger(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function asNumber(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, parsed);
}

function asStringArray(value, fallback = []) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function isLocalDispatcherModel(name) {
  return LOCAL_DISPATCHER_MODELS.has(String(name ?? "").trim());
}

function normalizeDispatcherLane(lane, defaults, overrides = {}) {
  const key = String(lane?.key ?? overrides.key ?? defaults.key).trim();
  if (!key) {
    throw new Error("dispatcher lane key is required");
  }
  const name = String(lane?.name ?? defaults.name);
  const explicitProvider = lane?.provider ?? overrides.provider;
  const provider = String(
    explicitProvider
      ?? (isLocalDispatcherModel(name) ? "local_container" : undefined)
      ?? defaults.provider
      ?? "hosted_codex"
  );
  const isLocal = provider === "local_container";

  return {
    key,
    label: String(lane?.label ?? overrides.label ?? defaults.label ?? `${key} lane`),
    provider,
    name,
    reasoning_effort: String(
      lane?.reasoning_effort
        ?? (isLocal ? DISPATCHER_LANE_DEFAULTS.local.reasoning_effort : undefined)
        ?? defaults.reasoning_effort
    ),
    enabled: asBoolean(lane?.enabled, overrides.enabled ?? defaults.enabled ?? true),
    max_workers: asInteger(lane?.max_workers ?? overrides.max_workers, defaults.max_workers ?? 0, 0),
    pause_threshold_used_percent: asNumber(
      lane?.pause_threshold_used_percent,
      defaults.pause_threshold_used_percent,
      0
    ),
    weekly_pause_threshold_used_percent: asNumber(
      lane?.weekly_pause_threshold_used_percent,
      defaults.weekly_pause_threshold_used_percent,
      0
    ),
    reserve_burn_window_minutes: asInteger(
      lane?.reserve_burn_window_minutes,
      defaults.reserve_burn_window_minutes,
      1
    ),
    nominal_burn_per_lane_hour: asNumber(
      lane?.nominal_burn_per_lane_hour,
      defaults.nominal_burn_per_lane_hour,
      0
    ),
    provider_concurrency_budget_units: asNumber(
      lane?.provider_concurrency_budget_units,
      defaults.provider_concurrency_budget_units ?? 0,
      0
    ),
    request_cost_units: asNumber(
      lane?.request_cost_units,
      defaults.request_cost_units ?? 0,
      0
    ),
    runtime_service: String(
      lane?.runtime_service
        ?? lane?.local_runtime?.service
        ?? defaults.runtime_service
        ?? (isLocal ? DEFAULT_LOCAL_RUNTIME_SERVICE : "")
    ),
    runtime_endpoint: String(
      lane?.runtime_endpoint
        ?? lane?.local_runtime?.endpoint
        ?? (isLocal ? process.env.AE_LOCAL_MODEL_ENDPOINT : undefined)
        ?? defaults.runtime_endpoint
        ?? (isLocal ? DEFAULT_LOCAL_RUNTIME_ENDPOINT : "")
    ),
    api_key_env: String(
      lane?.api_key_env
        ?? defaults.api_key_env
        ?? ""
    ),
    runtime_health_url: String(
      lane?.runtime_health_url
        ?? lane?.local_runtime?.health_url
        ?? (isLocal ? process.env.AE_LOCAL_MODEL_HEALTH_URL : undefined)
        ?? defaults.runtime_health_url
        ?? (isLocal ? DEFAULT_LOCAL_RUNTIME_HEALTH_URL : "")
    ),
    runtime_image: String(
      lane?.runtime_image
        ?? lane?.local_runtime?.image
        ?? (isLocal ? process.env.AE_LOCAL_MODEL_IMAGE : undefined)
        ?? defaults.runtime_image
        ?? (isLocal ? DEFAULT_LOCAL_RUNTIME_IMAGE : "")
    ),
    runtime_command: String(
      lane?.runtime_command
        ?? lane?.local_runtime?.command
        ?? (isLocal ? process.env.AE_LOCAL_LANE_COMMAND : undefined)
        ?? defaults.runtime_command
        ?? ""
    ),
    local_provider: String(
      lane?.local_provider
        ?? lane?.local_runtime?.provider
        ?? (isLocal ? process.env.AE_LOCAL_MODEL_PROVIDER : undefined)
        ?? defaults.local_provider
        ?? (isLocal ? "ollama" : "")
    ),
    num_thread: asInteger(
      lane?.num_thread
        ?? lane?.local_runtime?.num_thread
        ?? (isLocal ? process.env.AE_LOCAL_CODER_NUM_THREAD : undefined),
      defaults.num_thread ?? 0,
      0
    ),
    num_ctx: asInteger(
      lane?.num_ctx
        ?? lane?.local_runtime?.num_ctx
        ?? (isLocal ? process.env.AE_LOCAL_CODER_NUM_CTX : undefined),
      defaults.num_ctx ?? 0,
      0
    ),
    keep_alive: String(
      lane?.keep_alive
        ?? lane?.local_runtime?.keep_alive
        ?? (isLocal ? process.env.AE_LOCAL_CODER_KEEP_ALIVE : undefined)
        ?? defaults.keep_alive
        ?? ""
    ),
    auto_pull: asBoolean(
      lane?.auto_pull ?? lane?.local_runtime?.auto_pull,
      defaults.auto_pull ?? false
    )
  };
}

function targetWorkersForLane(lane) {
  return lane.enabled === false ? 0 : Math.max(0, Number(lane.max_workers ?? 0));
}

function normalizeDispatcherLanes(parsed, dispatcher) {
  const laneDefaults = DISPATCHER_LANE_DEFAULTS;
  const rawLanes = Array.isArray(parsed.models?.dispatcher?.lanes)
    ? parsed.models.dispatcher.lanes
    : null;
  const legacyLocal = parsed.models?.dispatcher?.local ?? parsed.local_lane ?? {};

  const lanes = rawLanes
    ? rawLanes.map((lane) => {
        const key = String(lane?.key ?? "").trim();
        const defaults = laneDefaults[key] ?? {
          ...laneDefaults.primary,
          key,
          label: `${key} lane`,
          max_workers: 0
        };
        return normalizeDispatcherLane(lane, defaults);
      })
    : [
        normalizeDispatcherLane(parsed.models?.dispatcher?.primary, laneDefaults.primary, {
          max_workers: dispatcher.primary_max_workers
        }),
        normalizeDispatcherLane(parsed.models?.dispatcher?.secondary, laneDefaults.secondary, {
          max_workers: dispatcher.secondary_max_workers
        }),
        normalizeDispatcherLane(legacyLocal, laneDefaults.local, {
          enabled: asBoolean(legacyLocal.enabled, false),
          max_workers: parsed.dispatcher?.local_max_workers ?? legacyLocal.max_workers ?? 0
        })
      ];

  const seen = new Set();
  for (const lane of lanes) {
    if (seen.has(lane.key)) {
      throw new Error(`duplicate dispatcher lane key: ${lane.key}`);
    }
    seen.add(lane.key);
    if (!["hosted_codex", "local_container", "openai_compatible"].includes(lane.provider)) {
      throw new Error(`unsupported dispatcher lane provider for ${lane.key}: ${lane.provider}`);
    }
    if (lane.provider === "local_container" && lane.enabled && targetWorkersForLane(lane) > 0) {
      if (!lane.runtime_endpoint && !lane.runtime_command) {
        throw new Error(`local dispatcher lane ${lane.key} requires runtime_endpoint or runtime_command`);
      }
    }
    if (lane.provider === "openai_compatible" && lane.enabled && targetWorkersForLane(lane) > 0) {
      if (!lane.runtime_endpoint) {
        throw new Error(`openai_compatible dispatcher lane ${lane.key} requires runtime_endpoint`);
      }
    }
  }

  for (const key of ["primary", "secondary", "local"]) {
    if (!seen.has(key)) {
      lanes.push(normalizeDispatcherLane({}, laneDefaults[key]));
    }
  }

  return lanes;
}

export function getDispatcherLanes(config) {
  const lanes = Array.isArray(config?.models?.dispatcher?.lanes)
    ? config.models.dispatcher.lanes
    : [];
  return lanes.map((lane) => ({ ...lane }));
}

function normalizeConfig(parsed, { env = process.env } = {}) {
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!parsed?.[key]) {
      throw new Error(`Missing required config section: ${key}`);
    }
  }

  if (!parsed.repo?.key || !parsed.repo?.github_slug || !parsed.repo?.default_branch) {
    throw new Error("repo.key, repo.github_slug, and repo.default_branch are required");
  }

  const workspaceDir = parsed.repo.workspace_dir ?? env.AE_WORKSPACE_DIR ?? DEFAULT_WORKSPACE_DIR;
  const repo = {
    ...parsed.repo,
    workspace_dir: path.resolve(workspaceDir)
  };

  const lifecycle = {
    enabled: asBoolean(parsed.lifecycle.enabled, true),
    target_mode: String(parsed.lifecycle.target_mode ?? "milestone"),
    target_name: String(parsed.lifecycle.target_name ?? ""),
    pause_when_target_complete: asBoolean(parsed.lifecycle.pause_when_target_complete, true),
    pause_when_budget_exhausted: asBoolean(parsed.lifecycle.pause_when_budget_exhausted, true),
    max_parallel_prs: asInteger(parsed.lifecycle.max_parallel_prs, 1, 1),
    max_runs_per_day: asInteger(parsed.lifecycle.max_runs_per_day, 1, 1)
  };

  const issueSource = {
    labels: asStringArray(parsed.issue_source.labels),
    required_issue_prefix: parsed.issue_source.required_issue_prefix
      ? String(parsed.issue_source.required_issue_prefix)
      : null,
    allow_manual_issue_numbers: Array.isArray(parsed.issue_source.allow_manual_issue_numbers)
      ? parsed.issue_source.allow_manual_issue_numbers
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item > 0)
      : []
  };

  const branches = {
    work_branch_prefix: String(parsed.branches?.work_branch_prefix ?? "autonomous/"),
    pr_base_branch: String(parsed.branches?.pr_base_branch ?? repo.default_branch)
  };

  const dispatcher = {
    enabled: asBoolean(parsed.dispatcher?.enabled, true),
    poll_interval_seconds: asInteger(parsed.dispatcher?.poll_interval_seconds, 30, 5),
    primary_max_workers: asInteger(
      parsed.dispatcher?.primary_max_workers,
      (() => {
        const explicitMax = parsed.dispatcher?.max_concurrency;
        const explicitFraction = parsed.dispatcher?.secondary_lane_fraction;
        if (explicitMax != null) {
          const total = asInteger(explicitMax, lifecycle.max_parallel_prs, 1);
          const secondary = Math.min(
            total - 1,
            Math.max(0, Math.round(total * asNumber(explicitFraction, 0.35, 0)))
          );
          return Math.max(1, total - secondary);
        }
        return Math.max(1, lifecycle.max_parallel_prs);
      })(),
      0
    ),
    secondary_max_workers: asInteger(
      parsed.dispatcher?.secondary_max_workers,
      (() => {
        const explicitMax = parsed.dispatcher?.max_concurrency;
        const explicitFraction = parsed.dispatcher?.secondary_lane_fraction;
        if (explicitMax != null) {
          const total = asInteger(explicitMax, lifecycle.max_parallel_prs, 1);
          return Math.min(
            total - 1,
            Math.max(0, Math.round(total * asNumber(explicitFraction, 0.35, 0)))
          );
        }
        return 0;
      })(),
      0
    ),
    skip_issue_numbers: Array.isArray(parsed.dispatcher?.skip_issue_numbers)
      ? parsed.dispatcher.skip_issue_numbers
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item > 0)
      : []
  };
  dispatcher.max_concurrency = Math.max(0, dispatcher.primary_max_workers + dispatcher.secondary_max_workers);
  dispatcher.active_lane_count = dispatcher.secondary_max_workers > 0 ? 2 : 1;

  const dispatcherLanes = normalizeDispatcherLanes(parsed, dispatcher);
  const laneByKey = new Map(dispatcherLanes.map((lane) => [lane.key, lane]));
  dispatcher.primary_max_workers = targetWorkersForLane(laneByKey.get("primary"));
  dispatcher.secondary_max_workers = targetWorkersForLane(laneByKey.get("secondary"));
  dispatcher.local_max_workers = targetWorkersForLane(laneByKey.get("local"));
  dispatcher.max_concurrency = dispatcherLanes.reduce((total, lane) => total + targetWorkersForLane(lane), 0);
  dispatcher.active_lane_count = dispatcherLanes.filter((lane) => targetWorkersForLane(lane) > 0).length;

  const models = {
    dispatcher: {
      primary: laneByKey.get("primary"),
      secondary: laneByKey.get("secondary"),
      local: laneByKey.get("local"),
      lanes: dispatcherLanes
    },
    reviewer: {
      provider: String(parsed.models?.reviewer?.provider ?? "hosted_codex"),
      name: String(parsed.models?.reviewer?.name ?? "gpt-5.4"),
      reasoning_effort: String(parsed.models?.reviewer?.reasoning_effort ?? "medium"),
      runtime_endpoint: String(parsed.models?.reviewer?.runtime_endpoint ?? ""),
      api_key_env: String(parsed.models?.reviewer?.api_key_env ?? "")
    }
  };

  const validationCommands =
    Array.isArray(parsed.validation?.commands) && parsed.validation.commands.length > 0
      ? parsed.validation.commands.map((command) => String(command))
      : null;
  const validationBootstrapCommands = Array.isArray(parsed.validation?.bootstrap_commands)
    ? parsed.validation.bootstrap_commands.map((command) => String(command)).filter(Boolean)
    : [];
  if (!validationCommands) {
    throw new Error("validation.commands must contain at least one command");
  }

  const validation = {
    enabled: asBoolean(parsed.validation?.enabled, true),
    context: String(parsed.validation?.context ?? "validate"),
    bootstrap_commands: validationBootstrapCommands,
    commands: validationCommands,
    working_directory: parsed.validation?.working_directory
      ? String(parsed.validation.working_directory)
      : null,
    poll_interval_seconds: asInteger(parsed.validation?.poll_interval_seconds, 30, 5),
    max_concurrent: asInteger(parsed.validation?.max_concurrent, 1, 1),
    post_status: asBoolean(parsed.validation?.post_status, false)
  };

  const reviewer = {
    enabled: asBoolean(parsed.reviewer?.enabled, true),
    poll_interval_seconds: asInteger(parsed.reviewer?.poll_interval_seconds, 120, 15),
    max_concurrent: asInteger(parsed.reviewer?.max_concurrent, 1, 1),
    post_mode: String(parsed.reviewer?.post_mode ?? "comment"),
    instructions_path: parsed.reviewer?.instructions_path
      ? path.resolve(parsed.reviewer.instructions_path)
      : path.join(repo.workspace_dir, ".github", "copilot-instructions.md")
  };

  const runnerManager = {
    enabled: asBoolean(parsed.runner_manager?.enabled, true),
    scope: String(parsed.runner_manager?.scope ?? "repo"),
    required_labels: asStringArray(parsed.runner_manager?.required_labels, [
      "self-hosted",
      "linux",
      repo.key
    ]),
    runner_labels: asStringArray(parsed.runner_manager?.runner_labels, [
      "self-hosted",
      "linux",
      repo.key
    ]),
    runner_group: String(parsed.runner_manager?.runner_group ?? ""),
    image_name: String(parsed.runner_manager?.image_name ?? "commons-devloop/gh-runner:latest"),
    container_prefix: String(parsed.runner_manager?.container_prefix ?? `${repo.key}-gh-runner`),
    max_runners: asInteger(parsed.runner_manager?.max_runners, 2, 1),
    poll_interval_seconds: asInteger(parsed.runner_manager?.poll_interval_seconds, 20, 5),
    launch_cooldown_seconds: asInteger(
      parsed.runner_manager?.launch_cooldown_seconds,
      180,
      10
    ),
    network: String(parsed.runner_manager?.network ?? ""),
    mount_docker_socket: asBoolean(parsed.runner_manager?.mount_docker_socket, true),
    mount_workspace: asBoolean(parsed.runner_manager?.mount_workspace, false),
    dry_run: asBoolean(parsed.runner_manager?.dry_run, false)
  };

  const prManager = {
    enabled: asBoolean(parsed.pr_manager?.enabled, true),
    interval_seconds: asInteger(parsed.pr_manager?.interval_seconds, 30, 5),
    merge_concurrency: asInteger(parsed.pr_manager?.merge_concurrency, 4, 1),
    update_branch_concurrency: asInteger(
      parsed.pr_manager?.update_branch_concurrency,
      Math.max(
        asInteger(parsed.pr_manager?.merge_concurrency, 4, 1),
        lifecycle.max_parallel_prs
      ),
      1
    ),
    auto_merge_label: parsed.pr_manager?.auto_merge_label
      ? String(parsed.pr_manager.auto_merge_label)
      : null,
    auto_close_superseded_conflicts: asBoolean(
      parsed.pr_manager?.auto_close_superseded_conflicts,
      false
    )
  };

  const monitor = {
    enabled: asBoolean(parsed.monitor?.enabled, true),
    poll_interval_seconds: asInteger(parsed.monitor?.poll_interval_seconds, 30, 5)
  };

  const dashboard = {
    enabled: asBoolean(parsed.dashboard?.enabled, true),
    port: asInteger(env.AE_DASHBOARD_PORT ?? parsed.dashboard?.port, 4700, 1),
    expose_issue_details: asBoolean(parsed.dashboard?.expose_issue_details, true),
    expose_pr_links: asBoolean(parsed.dashboard?.expose_pr_links, true)
  };

  const retention = {
    enabled: asBoolean(parsed.retention?.enabled, true),
    worktree_max_age_hours: asInteger(parsed.retention?.worktree_max_age_hours, 6, 0),
    run_log_max_age_days: asInteger(parsed.retention?.run_log_max_age_days, 2, 0),
    output_max_age_days: asInteger(parsed.retention?.output_max_age_days, 2, 0)
  };

  const roles = {
    enabled: {
      autonomous: parsed.roles?.enabled?.autonomous ?? true,
      dispatcher: parsed.roles?.enabled?.dispatcher ?? dispatcher.enabled,
      validator: parsed.roles?.enabled?.validator ?? validation.enabled,
      reviewer: parsed.roles?.enabled?.reviewer ?? reviewer.enabled,
      "runner-manager": parsed.roles?.enabled?.["runner-manager"] ?? runnerManager.enabled,
      "pr-manager": parsed.roles?.enabled?.["pr-manager"] ?? prManager.enabled,
      monitor: parsed.roles?.enabled?.monitor ?? monitor.enabled,
      dashboard: parsed.roles?.enabled?.dashboard ?? dashboard.enabled
    }
  };

  return {
    ...parsed,
    version: parsed.version ?? 2,
    repo,
    lifecycle,
    issue_source: issueSource,
    branches,
    dispatcher,
    models,
    validation,
    reviewer,
    runner_manager: runnerManager,
    pr_manager: prManager,
    monitor,
    roles,
    dashboard,
    retention,
    budgets: {
      max_estimated_credits_per_day: parsed.budgets?.max_estimated_credits_per_day ?? null,
      pause_reason_on_budget: parsed.budgets?.pause_reason_on_budget
        ? String(parsed.budgets.pause_reason_on_budget)
        : "budget exhausted"
    },
    safety: {
      pr_only: asBoolean(parsed.safety.pr_only, true),
      auto_merge: asBoolean(parsed.safety.auto_merge, false),
      protected_branches: asStringArray(parsed.safety.protected_branches, [repo.default_branch]),
      protected_paths: asStringArray(parsed.safety.protected_paths),
      allow_force_push: asBoolean(parsed.safety.allow_force_push, false),
      require_clean_worktree_before_run: asBoolean(
        parsed.safety.require_clean_worktree_before_run,
        true
      ),
      disallow_github_actions_auto_triggers: asBoolean(
        parsed.safety.disallow_github_actions_auto_triggers,
        false
      )
    }
  };
}

export function loadRawConfig(configPath) {
  const raw = fs.readFileSync(configPath, "utf8");
  return YAML.parse(raw);
}

export function saveRawConfig(configPath, config) {
  fs.writeFileSync(configPath, `${YAML.stringify(config)}\n`);
}

export function loadConfig(configPath, options = {}) {
  return normalizeConfig(loadRawConfig(configPath), options);
}

export function resolveConfigPath() {
  const configPath = process.env.AE_REPO_CONFIG;
  if (!configPath) {
    throw new Error("AE_REPO_CONFIG is required");
  }
  return path.resolve(configPath);
}
