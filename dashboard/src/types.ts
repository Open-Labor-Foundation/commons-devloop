export type ServiceName =
  | "autonomous"
  | "dispatcher"
  | "validator"
  | "reviewer"
  | "runner-manager"
  | "pr-manager"
  | "monitor";

export type Tone = "good" | "warn" | "bad";

export type DispatcherItem = {
  number: number;
  title: string;
  url?: string;
  status: string;
  branch?: string;
  assigned_lane?: string | null;
  assigned_model?: string | null;
};

export type ServiceState = {
  state: {
    alive: boolean;
    enabled: boolean;
    configEnabled: boolean;
    desiredEnabled: boolean;
    lifecycle: string;
    summary: string;
    containerName?: string;
    containerStatus?: string;
    containerRunning?: boolean;
    containerAvailable?: boolean;
    containerFound?: boolean;
    lifecycleSource?: string;
    progress?: Record<string, unknown>;
    items?: DispatcherItem[];
    openPrCount?: number;
    openPrs?: unknown[];
    prs?: Record<string, unknown>;
    lastActions?: Array<{ number: number; action: string }>;
    updatedAt?: string | null;
  };
  logTail?: string[];
};

export type Lane = {
  key: string;
  label: string;
  provider: "hosted_codex" | "local_container" | "openai_compatible";
  enabled: boolean;
  model: string;
  reasoningEffort: string;
  targetConcurrency: number;
  pauseBelowRemainingPercent: number;
  weeklyPauseBelowRemainingPercent: number;
  reserveWindowHours: number;
  nominalBurnPerLaneHour: number;
  providerConcurrencyBudgetUnits?: number;
  requestCostUnits?: number;
  runtimeService?: string;
  runtimeEndpoint?: string;
  runtimeHealthUrl?: string;
  runtimeImage?: string;
  runtimeCommand?: string;
  localProvider?: string;
  numThread?: number;
  numCtx?: number;
  autoPull?: boolean;
};

export type LaneTelemetry = Lane & {
  running: number;
  activeTargetConcurrency: number;
  throttleReason: string | null;
  pauseReason?: string | null;
  remainingPercent: number | null;
  weeklyRemainingPercent?: number | null;
  effectiveReserveRemainingPercent?: number | null;
  reset?: string;
  weeklyReset?: string;
  telemetryAt?: string | null;
  telemetryAge?: string | null;
  maxSupportedConcurrency?: number | null;
  runtimeStatus?: string;
  runtimeHealth?: string;
  containerFound?: boolean;
  containerStatus?: string | null;
  modelReady?: boolean | null;
  loadedModels?: string[];
  localResourceSummary?: string;
};

export type LaneControl = {
  totalConcurrency: number;
  activeLaneCount: number;
  primaryTargetConcurrency: number;
  secondaryTargetConcurrency: number;
  localTargetConcurrency: number;
  lanes: Lane[];
  primary?: Lane;
  secondary?: Lane;
  local?: Lane;
  reviewer: { model: string; reasoningEffort: string };
};

export type OperationsCard = {
  label: string;
  value: string;
  sub?: string;
};

export type ReadinessConcern = {
  code: string;
  message: string;
  detail?: string | null;
};

export type ReadinessMountStatus = {
  status: string;
  tone: Tone;
  label: string;
  path: string | null;
  detail: string;
};

export type GithubVisibilityStatus = {
  status: string;
  tone: Tone;
  label: string;
  count: number;
  detail: string;
};

export type ServiceReadinessItem = {
  service: string;
  label: string;
  lifecycle: string;
  tone: Tone;
  configEnabled: boolean;
  desiredEnabled: boolean;
  summary: string | null;
  statusSource: string;
};

export type DeploymentReadiness = {
  status: "ready" | "degraded" | "blocked";
  label: string;
  tone: Tone;
  summary: string;
  blockers: ReadinessConcern[];
  warnings: ReadinessConcern[];
  config: { valid: boolean; schemaVersion: number | string | null; currentVersion: string; path: string };
  identity: {
    repoKey: string;
    githubSlug: string;
    defaultBranch: string;
    stackId: string;
    stackSource: string;
    stateRoot: string;
    dashboardPort: number;
  };
  targetRepoMount: ReadinessMountStatus;
  githubVisibility: {
    issues: GithubVisibilityStatus;
    pullRequests: GithubVisibilityStatus;
    mergedPullRequests: GithubVisibilityStatus;
    updatedAt: string | null;
  };
  requiredServices: {
    summary: { total: number; running: number; starting: number; stopped: number; disabled: number; degraded: number };
    items: ServiceReadinessItem[];
  };
};

export type IssueRef = {
  number: number;
  title: string;
  url?: string;
  milestone?: { title: string } | null;
  labels?: Array<{ name: string }>;
};

export type PullRequestRef = {
  number: number;
  title: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string | null;
  baseRefName?: string | null;
  isDraft?: boolean;
  mergeStateStatus?: string | null;
  labels?: Array<{ name: string }>;
};

export type MergedPullRequest = {
  number: number;
  title: string | null;
  mergedAt: string | null;
  url: string | null;
  source: "local" | "github" | null;
};

export type CheckRecord = {
  service: string;
  current: boolean;
  result: "success" | "failure" | "pending";
  label: string;
  tone: Tone;
  title: string | null;
  updatedAt: string | null;
  branch: string | null;
  failureSummary: string | null;
  failureCount: number | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  remediationStatus: string | null;
  remediation: { key: string; label: string; tone: Tone } | null;
  runLog: string | null;
  runLogExcerpt: string[];
  outputPath: string | null;
  model: string | null;
  reasoningEffort: string | null;
};

export type PrMovement = {
  key: string;
  label: string;
  tone: Tone;
  detail: string;
  nextRetryAt: string | null;
};

export type PrLocalGate = {
  readiness: "merge" | "update_branch" | "blocked" | "waiting";
  reason: string;
  validateState: string;
  reviewerState: string;
  label: string;
  tone: Tone;
};

export type PrDrillDown = PullRequestRef & {
  movement: PrMovement;
  localGate: PrLocalGate;
  checks: { validator: CheckRecord; reviewer: CheckRecord };
};

export type ActivityWorker = {
  key: string;
  number: number;
  status?: string;
  result?: string | null;
  statusLabel?: string;
  title?: string;
  issueTitle?: string;
  branch?: string;
  lane?: string | null;
  model?: string | null;
  summary: string;
  selectorLabel: string;
  meta: string;
  logTail?: string[];
  error?: string | null;
};

export type CodexActivity = {
  key?: string;
  number?: number;
  issueTitle?: string;
  branch?: string;
  lane?: string | null;
  model?: string | null;
  status?: string;
  title: string;
  summary: string;
  selectorLabel?: string;
  meta?: string;
  logTail?: string[];
  workers: ActivityWorker[];
};

export type ReviewActivityEntry = {
  selected: ActivityWorker | null;
  workers: ActivityWorker[];
};

export type LaneApiKeyStatus = { configured: boolean; source: "stored" | "env" | "none" };

export type ResourceMonitor = {
  generatedAt: string;
  host: {
    hostname: string;
    platform: string;
    cpuCount: number;
    loadAverage: number[];
    loadHostShare: string;
    loadHostSharePercent: number | null;
    sampledCpu: string;
    sampledCpuPercent: number | null;
    memory: {
      total: string;
      used: string;
      free: string;
      available: string;
      cache: string;
      usedPercent: number | null;
      swapTotal: string;
      swapUsed: string;
      swapFree: string;
      swapUsedPercent: number;
    };
  };
  docker: {
    available: boolean;
    error: string | null;
    summary: {
      containers?: number | null;
      containersRunning?: number | null;
      images?: number | null;
      ncpu?: number | null;
      memTotal?: string | null;
      serverVersion?: string | null;
      totalHostShare: string;
      totalHostSharePercent: number | null;
    };
    containers: Array<{
      id: string;
      name: string;
      cpu: string;
      cpuHostShare: string;
      cpuHostSharePercent: number | null;
      memory: string;
      memoryPercent: string;
      network: string;
      block: string;
      pids: string;
    }>;
  };
  disk: {
    available: boolean;
    error?: string | null;
    filesystems: Array<{ filesystem: string; size: string; used: string; available: string; usePercent: string; mount: string }>;
    blockDevices: {
      available: boolean;
      error?: string | null;
      devices: Array<{ name: string; size: string; model: string; media: string; transport: string; visibleMounts: string }>;
    };
  };
};

export type PolicyLane = {
  key: string;
  label: string;
  provider: "hosted_codex" | "local_container" | "openai_compatible";
  enabled: boolean;
  model: string;
  reasoningEffort: string;
  targetConcurrency: number;
  pauseBelowRemainingPercent: number;
  weeklyPauseBelowRemainingPercent: number;
  reserveWindowHours: number;
  nominalBurnPerLaneHour: number;
  providerConcurrencyBudgetUnits: number;
  requestCostUnits: number;
  runtimeService: string;
  runtimeEndpoint: string;
  runtimeHealthUrl: string;
  runtimeImage: string;
  runtimeCommand: string;
  localProvider: string;
  numThread: number;
  numCtx: number;
  autoPull: boolean;
};

export type PolicyControl = {
  repo: { key: string; githubSlug: string; defaultBranch: string; workspaceDir: string };
  lifecycle: {
    enabled: boolean;
    targetMode: string;
    targetName: string;
    maxParallelPrs: number;
    maxRunsPerDay: number;
    pauseWhenTargetComplete: boolean;
    pauseWhenBudgetExhausted: boolean;
  };
  issueSource: { labels: string; requiredIssuePrefix: string; allowManualIssueNumbers: string };
  dispatcher: {
    enabled: boolean;
    pollIntervalSeconds: number;
    primaryTargetConcurrency: number;
    secondaryTargetConcurrency: number;
    localTargetConcurrency: number;
    skipIssueNumbers: string;
    lanes: PolicyLane[];
    primary?: PolicyLane;
    secondary?: PolicyLane;
    local?: PolicyLane;
  };
  validation: {
    enabled: boolean;
    context: string;
    pollIntervalSeconds: number;
    maxConcurrent: number;
    postStatus: boolean;
    workingDirectory: string;
    bootstrapCommands: string;
    commands: string;
  };
  reviewer: {
    enabled: boolean;
    pollIntervalSeconds: number;
    maxConcurrent: number;
    model: string;
    reasoningEffort: string;
    postMode: string;
    instructionsPath: string;
  };
  prManager: {
    enabled: boolean;
    intervalSeconds: number;
    mergeConcurrency: number;
    updateBranchConcurrency: number;
    autoMergeLabel: string;
  };
  runnerManager: {
    enabled: boolean;
    scope: string;
    requiredLabels: string;
    runnerLabels: string;
    runnerGroup: string;
    imageName: string;
    containerPrefix: string;
    maxRunners: number;
    pollIntervalSeconds: number;
    launchCooldownSeconds: number;
    network: string;
    dryRun: boolean;
    mountDockerSocket: boolean;
    mountWorkspace: boolean;
  };
  monitor: { enabled: boolean; pollIntervalSeconds: number };
  safety: {
    prOnly: boolean;
    autoMerge: boolean;
    protectedBranches: string;
    protectedPaths: string;
    allowForcePush: boolean;
    requireCleanWorktreeBeforeRun: boolean;
  };
  budgets: { maxEstimatedCreditsPerDay: string; pauseReasonOnBudget: string };
  branches: { workBranchPrefix: string; prBaseBranch: string };
  roles: {
    autonomous: boolean;
    dispatcher: boolean;
    validator: boolean;
    reviewer: boolean;
    runnerManager: boolean;
    prManager: boolean;
    monitor: boolean;
    dashboard: boolean;
  };
  dashboard: { enabled: boolean; port: number; exposeIssueDetails: boolean; exposePrLinks: boolean };
  retention: { enabled: boolean; worktreeMaxAgeHours: number; runLogMaxAgeDays: number; outputMaxAgeDays: number };
};

export type DashboardOptions = {
  models: string[];
  reasoningEfforts: string[];
  reviewerPostModes: string[];
  lifecycleTargetModes: string[];
  runnerManagerScopes: string[];
};

export type DashboardState = {
  generatedAt: string;
  configVersion: string;
  repo: { key: string; github_slug: string; default_branch: string; workspace_dir?: string | null };
  stack: { stackId: string; source: string; stateRoot: string };
  lifecycle: Record<string, unknown>;
  repoState: { status: string; pauseReason?: string | null };
  controlState: { manualPause: boolean; desiredServices: Record<string, boolean> };
  services: Record<ServiceName, ServiceState>;
  targetIssues: IssueRef[];
  openPrs: PullRequestRef[];
  mergedPrs: MergedPullRequest[];
  githubCache: { updatedAt: string | null; errors: Record<string, string> };
  operationsCards: OperationsCard[];
  deploymentReadiness: DeploymentReadiness;
  prDrillDown: PrDrillDown[];
  codexActivity: CodexActivity;
  reviewActivity: { validator: ReviewActivityEntry; reviewer: ReviewActivityEntry };
  resourceMonitor: ResourceMonitor;
  laneControl: LaneControl;
  policyControl: PolicyControl;
  laneTelemetry: { lanes: LaneTelemetry[]; primary?: LaneTelemetry; secondary?: LaneTelemetry; local?: LaneTelemetry };
  dashboardOptions: DashboardOptions;
};
