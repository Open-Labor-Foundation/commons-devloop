import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Panel, Button } from "./Panel";
import { ApiKeyRow } from "./LaneStatusPanel";
import { api } from "../api";
import type { DashboardOptions, LaneApiKeyStatus, PolicyControl, PolicyLane } from "../types";

type FormState = {
  repoKey: string;
  repoGithubSlug: string;
  repoDefaultBranch: string;
  repoWorkspaceDir: string;

  lifecycleEnabled: boolean;
  lifecycleTargetMode: string;
  lifecycleTargetName: string;
  lifecycleMaxParallelPrs: number;
  lifecycleMaxRunsPerDay: number;
  lifecyclePauseWhenTargetComplete: boolean;
  lifecyclePauseWhenBudgetExhausted: boolean;

  issueSourceLabels: string;
  issueSourceRequiredIssuePrefix: string;
  issueSourceAllowManualIssueNumbers: string;

  dispatcherEnabled: boolean;
  dispatcherPollIntervalSeconds: number;
  dispatcherSkipIssueNumbers: string;

  reviewerEnabled: boolean;
  reviewerPollIntervalSeconds: number;
  reviewerMaxConcurrent: number;
  reviewerModel: string;
  reviewerReasoningEffort: string;
  reviewerPostMode: string;
  reviewerInstructionsPath: string;

  validationEnabled: boolean;
  validationContext: string;
  validationPollIntervalSeconds: number;
  validationMaxConcurrent: number;
  validationPostStatus: boolean;
  validationWorkingDirectory: string;
  validationBootstrapCommands: string;
  validationCommands: string;

  prManagerEnabled: boolean;
  prManagerIntervalSeconds: number;
  prManagerMergeConcurrency: number;
  prManagerUpdateBranchConcurrency: number;
  prManagerAutoMergeLabel: string;

  runnerManagerEnabled: boolean;
  runnerManagerScope: string;
  runnerManagerRequiredLabels: string;
  runnerManagerRunnerLabels: string;
  runnerManagerRunnerGroup: string;
  runnerManagerImageName: string;
  runnerManagerContainerPrefix: string;
  runnerManagerMaxRunners: number;
  runnerManagerPollIntervalSeconds: number;
  runnerManagerLaunchCooldownSeconds: number;
  runnerManagerNetwork: string;
  runnerManagerDryRun: boolean;
  runnerManagerMountDockerSocket: boolean;
  runnerManagerMountWorkspace: boolean;

  monitorEnabled: boolean;
  monitorPollIntervalSeconds: number;

  safetyPrOnly: boolean;
  safetyAutoMerge: boolean;
  safetyProtectedBranches: string;
  safetyProtectedPaths: string;
  safetyAllowForcePush: boolean;
  safetyRequireCleanWorktreeBeforeRun: boolean;

  budgetMaxEstimatedCreditsPerDay: string;
  budgetPauseReasonOnBudget: string;

  branchesWorkBranchPrefix: string;
  branchesPrBaseBranch: string;

  roleAutonomousEnabled: boolean;
  roleDispatcherEnabled: boolean;
  roleValidatorEnabled: boolean;
  roleReviewerEnabled: boolean;
  roleRunnerManagerEnabled: boolean;
  rolePrManagerEnabled: boolean;
  roleMonitorEnabled: boolean;
  roleDashboardEnabled: boolean;

  dashboardEnabled: boolean;
  dashboardPort: number;
  dashboardExposeIssueDetails: boolean;
  dashboardExposePrLinks: boolean;

  retentionEnabled: boolean;
  retentionWorktreeMaxAgeHours: number;
  retentionRunLogMaxAgeDays: number;
  retentionOutputMaxAgeDays: number;
};

function buildFormState(policy: PolicyControl): FormState {
  return {
    repoKey: policy.repo.key,
    repoGithubSlug: policy.repo.githubSlug,
    repoDefaultBranch: policy.repo.defaultBranch,
    repoWorkspaceDir: policy.repo.workspaceDir,

    lifecycleEnabled: policy.lifecycle.enabled,
    lifecycleTargetMode: policy.lifecycle.targetMode,
    lifecycleTargetName: policy.lifecycle.targetName,
    lifecycleMaxParallelPrs: policy.lifecycle.maxParallelPrs,
    lifecycleMaxRunsPerDay: policy.lifecycle.maxRunsPerDay,
    lifecyclePauseWhenTargetComplete: policy.lifecycle.pauseWhenTargetComplete,
    lifecyclePauseWhenBudgetExhausted: policy.lifecycle.pauseWhenBudgetExhausted,

    issueSourceLabels: policy.issueSource.labels,
    issueSourceRequiredIssuePrefix: policy.issueSource.requiredIssuePrefix,
    issueSourceAllowManualIssueNumbers: policy.issueSource.allowManualIssueNumbers,

    dispatcherEnabled: policy.dispatcher.enabled,
    dispatcherPollIntervalSeconds: policy.dispatcher.pollIntervalSeconds,
    dispatcherSkipIssueNumbers: policy.dispatcher.skipIssueNumbers,

    reviewerEnabled: policy.reviewer.enabled,
    reviewerPollIntervalSeconds: policy.reviewer.pollIntervalSeconds,
    reviewerMaxConcurrent: policy.reviewer.maxConcurrent,
    reviewerModel: policy.reviewer.model,
    reviewerReasoningEffort: policy.reviewer.reasoningEffort,
    reviewerPostMode: policy.reviewer.postMode,
    reviewerInstructionsPath: policy.reviewer.instructionsPath,

    validationEnabled: policy.validation.enabled,
    validationContext: policy.validation.context,
    validationPollIntervalSeconds: policy.validation.pollIntervalSeconds,
    validationMaxConcurrent: policy.validation.maxConcurrent,
    validationPostStatus: policy.validation.postStatus,
    validationWorkingDirectory: policy.validation.workingDirectory,
    validationBootstrapCommands: policy.validation.bootstrapCommands,
    validationCommands: policy.validation.commands,

    prManagerEnabled: policy.prManager.enabled,
    prManagerIntervalSeconds: policy.prManager.intervalSeconds,
    prManagerMergeConcurrency: policy.prManager.mergeConcurrency,
    prManagerUpdateBranchConcurrency: policy.prManager.updateBranchConcurrency,
    prManagerAutoMergeLabel: policy.prManager.autoMergeLabel,

    runnerManagerEnabled: policy.runnerManager.enabled,
    runnerManagerScope: policy.runnerManager.scope,
    runnerManagerRequiredLabels: policy.runnerManager.requiredLabels,
    runnerManagerRunnerLabels: policy.runnerManager.runnerLabels,
    runnerManagerRunnerGroup: policy.runnerManager.runnerGroup,
    runnerManagerImageName: policy.runnerManager.imageName,
    runnerManagerContainerPrefix: policy.runnerManager.containerPrefix,
    runnerManagerMaxRunners: policy.runnerManager.maxRunners,
    runnerManagerPollIntervalSeconds: policy.runnerManager.pollIntervalSeconds,
    runnerManagerLaunchCooldownSeconds: policy.runnerManager.launchCooldownSeconds,
    runnerManagerNetwork: policy.runnerManager.network,
    runnerManagerDryRun: policy.runnerManager.dryRun,
    runnerManagerMountDockerSocket: policy.runnerManager.mountDockerSocket,
    runnerManagerMountWorkspace: policy.runnerManager.mountWorkspace,

    monitorEnabled: policy.monitor.enabled,
    monitorPollIntervalSeconds: policy.monitor.pollIntervalSeconds,

    safetyPrOnly: policy.safety.prOnly,
    safetyAutoMerge: policy.safety.autoMerge,
    safetyProtectedBranches: policy.safety.protectedBranches,
    safetyProtectedPaths: policy.safety.protectedPaths,
    safetyAllowForcePush: policy.safety.allowForcePush,
    safetyRequireCleanWorktreeBeforeRun: policy.safety.requireCleanWorktreeBeforeRun,

    budgetMaxEstimatedCreditsPerDay: policy.budgets.maxEstimatedCreditsPerDay,
    budgetPauseReasonOnBudget: policy.budgets.pauseReasonOnBudget,

    branchesWorkBranchPrefix: policy.branches.workBranchPrefix,
    branchesPrBaseBranch: policy.branches.prBaseBranch,

    roleAutonomousEnabled: policy.roles.autonomous,
    roleDispatcherEnabled: policy.roles.dispatcher,
    roleValidatorEnabled: policy.roles.validator,
    roleReviewerEnabled: policy.roles.reviewer,
    roleRunnerManagerEnabled: policy.roles.runnerManager,
    rolePrManagerEnabled: policy.roles.prManager,
    roleMonitorEnabled: policy.roles.monitor,
    roleDashboardEnabled: policy.roles.dashboard,

    dashboardEnabled: policy.dashboard.enabled,
    dashboardPort: policy.dashboard.port,
    dashboardExposeIssueDetails: policy.dashboard.exposeIssueDetails,
    dashboardExposePrLinks: policy.dashboard.exposePrLinks,

    retentionEnabled: policy.retention.enabled,
    retentionWorktreeMaxAgeHours: policy.retention.worktreeMaxAgeHours,
    retentionRunLogMaxAgeDays: policy.retention.runLogMaxAgeDays,
    retentionOutputMaxAgeDays: policy.retention.outputMaxAgeDays
  };
}

function toBody(form: FormState, lanes: PolicyLane[], configVersion: string, laneControl: { primaryTargetConcurrency: number; secondaryTargetConcurrency: number; localTargetConcurrency: number }) {
  return {
    configVersion,
    repoKey: form.repoKey,
    repoGithubSlug: form.repoGithubSlug,
    repoDefaultBranch: form.repoDefaultBranch,
    repoWorkspaceDir: form.repoWorkspaceDir,

    lifecycleEnabled: form.lifecycleEnabled,
    lifecycleTargetMode: form.lifecycleTargetMode,
    lifecycleTargetName: form.lifecycleTargetName,
    lifecycleMaxParallelPrs: form.lifecycleMaxParallelPrs,
    lifecycleMaxRunsPerDay: form.lifecycleMaxRunsPerDay,
    lifecyclePauseWhenTargetComplete: form.lifecyclePauseWhenTargetComplete,
    lifecyclePauseWhenBudgetExhausted: form.lifecyclePauseWhenBudgetExhausted,

    issueSourceLabels: form.issueSourceLabels,
    issueSourceRequiredIssuePrefix: form.issueSourceRequiredIssuePrefix,
    issueSourceAllowManualIssueNumbers: form.issueSourceAllowManualIssueNumbers,

    dispatcherEnabled: form.dispatcherEnabled,
    dispatcherPollIntervalSeconds: form.dispatcherPollIntervalSeconds,
    dispatcherSkipIssueNumbers: form.dispatcherSkipIssueNumbers,
    primaryTargetConcurrency: laneControl.primaryTargetConcurrency,
    secondaryTargetConcurrency: laneControl.secondaryTargetConcurrency,
    localTargetConcurrency: laneControl.localTargetConcurrency,
    dispatcherLanes: lanes,

    reviewerEnabled: form.reviewerEnabled,
    reviewerPollIntervalSeconds: form.reviewerPollIntervalSeconds,
    reviewerMaxConcurrent: form.reviewerMaxConcurrent,
    reviewerModel: form.reviewerModel,
    reviewerReasoningEffort: form.reviewerReasoningEffort,
    reviewerPostMode: form.reviewerPostMode,
    reviewerInstructionsPath: form.reviewerInstructionsPath,

    validationEnabled: form.validationEnabled,
    validationContext: form.validationContext,
    validationPollIntervalSeconds: form.validationPollIntervalSeconds,
    validationMaxConcurrent: form.validationMaxConcurrent,
    validationPostStatus: form.validationPostStatus,
    validationWorkingDirectory: form.validationWorkingDirectory,
    validationBootstrapCommands: form.validationBootstrapCommands,
    validationCommands: form.validationCommands,

    prManagerEnabled: form.prManagerEnabled,
    prManagerIntervalSeconds: form.prManagerIntervalSeconds,
    prManagerMergeConcurrency: form.prManagerMergeConcurrency,
    prManagerUpdateBranchConcurrency: form.prManagerUpdateBranchConcurrency,
    prManagerAutoMergeLabel: form.prManagerAutoMergeLabel,

    runnerManagerEnabled: form.runnerManagerEnabled,
    runnerManagerScope: form.runnerManagerScope,
    runnerManagerRequiredLabels: form.runnerManagerRequiredLabels,
    runnerManagerRunnerLabels: form.runnerManagerRunnerLabels,
    runnerManagerRunnerGroup: form.runnerManagerRunnerGroup,
    runnerManagerImageName: form.runnerManagerImageName,
    runnerManagerContainerPrefix: form.runnerManagerContainerPrefix,
    runnerManagerMaxRunners: form.runnerManagerMaxRunners,
    runnerManagerPollIntervalSeconds: form.runnerManagerPollIntervalSeconds,
    runnerManagerLaunchCooldownSeconds: form.runnerManagerLaunchCooldownSeconds,
    runnerManagerNetwork: form.runnerManagerNetwork,
    runnerManagerDryRun: form.runnerManagerDryRun,
    runnerManagerMountDockerSocket: form.runnerManagerMountDockerSocket,
    runnerManagerMountWorkspace: form.runnerManagerMountWorkspace,

    monitorEnabled: form.monitorEnabled,
    monitorPollIntervalSeconds: form.monitorPollIntervalSeconds,

    safetyPrOnly: form.safetyPrOnly,
    safetyAutoMerge: form.safetyAutoMerge,
    safetyProtectedBranches: form.safetyProtectedBranches,
    safetyProtectedPaths: form.safetyProtectedPaths,
    safetyAllowForcePush: form.safetyAllowForcePush,
    safetyRequireCleanWorktreeBeforeRun: form.safetyRequireCleanWorktreeBeforeRun,

    budgetMaxEstimatedCreditsPerDay: form.budgetMaxEstimatedCreditsPerDay,
    budgetPauseReasonOnBudget: form.budgetPauseReasonOnBudget,

    branchesWorkBranchPrefix: form.branchesWorkBranchPrefix,
    branchesPrBaseBranch: form.branchesPrBaseBranch,

    roleAutonomousEnabled: form.roleAutonomousEnabled,
    roleDispatcherEnabled: form.roleDispatcherEnabled,
    roleValidatorEnabled: form.roleValidatorEnabled,
    roleReviewerEnabled: form.roleReviewerEnabled,
    roleRunnerManagerEnabled: form.roleRunnerManagerEnabled,
    rolePrManagerEnabled: form.rolePrManagerEnabled,
    roleMonitorEnabled: form.roleMonitorEnabled,
    roleDashboardEnabled: form.roleDashboardEnabled,

    dashboardEnabled: form.dashboardEnabled,
    dashboardPort: form.dashboardPort,
    dashboardExposeIssueDetails: form.dashboardExposeIssueDetails,
    dashboardExposePrLinks: form.dashboardExposePrLinks,

    retentionEnabled: form.retentionEnabled,
    retentionWorktreeMaxAgeHours: form.retentionWorktreeMaxAgeHours,
    retentionRunLogMaxAgeDays: form.retentionRunLogMaxAgeDays,
    retentionOutputMaxAgeDays: form.retentionOutputMaxAgeDays
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      {children}
    </label>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>{children}</div>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

const SECTIONS = [
  "Repo",
  "Lifecycle",
  "Issue Source",
  "Dispatcher & Lanes",
  "Validator",
  "Reviewer",
  "PR Manager",
  "Runner Manager",
  "Monitor",
  "Safety",
  "Budgets",
  "Branches",
  "Roles",
  "Dashboard",
  "Retention"
] as const;
type Section = (typeof SECTIONS)[number];

function LaneEditor({
  lanes,
  onChange,
  options
}: {
  lanes: PolicyLane[];
  onChange: (lanes: PolicyLane[]) => void;
  options: DashboardOptions;
}) {
  const [keyStatus, setKeyStatus] = useState<Record<string, LaneApiKeyStatus>>({});

  async function refreshKeyStatus() {
    try {
      const result = await api.get<{ lanes: Record<string, LaneApiKeyStatus> }>("/api/lanes/keys");
      setKeyStatus(result.lanes);
    } catch {
      // Non-fatal — key status is a secondary detail in this editor.
    }
  }

  useEffect(() => {
    void refreshKeyStatus();
  }, []);

  function update(index: number, patch: Partial<PolicyLane>) {
    onChange(lanes.map((lane, laneIndex) => (laneIndex === index ? { ...lane, ...patch } : lane)));
  }

  function changeProvider(index: number, provider: PolicyLane["provider"]) {
    // Clear the previous provider's fields instead of just hiding them —
    // engine-role.mjs's dispatch logic reads local_provider/runtime_health_url
    // directly, so a stale value left over from local_container can silently
    // misroute a lane even after switching it to a different provider.
    const patch: Partial<PolicyLane> = { provider };
    if (provider !== "local_container") {
      patch.localProvider = "";
      patch.runtimeHealthUrl = "";
      patch.numThread = 0;
      patch.numCtx = 0;
      patch.autoPull = false;
    }
    if (provider !== "openai_compatible") {
      patch.providerConcurrencyBudgetUnits = 0;
      patch.requestCostUnits = 0;
    }
    if (provider === "hosted_codex") {
      patch.runtimeEndpoint = "";
      patch.runtimeService = "";
    }
    update(index, patch);
  }

  function remove(index: number) {
    onChange(lanes.filter((_, laneIndex) => laneIndex !== index));
  }

  function add() {
    const key = `lane-${Date.now().toString(36)}`;
    onChange([
      ...lanes,
      {
        key,
        label: "New lane",
        provider: "hosted_codex",
        enabled: true,
        model: options.models[0] ?? "",
        reasoningEffort: options.reasoningEfforts[0] ?? "medium",
        targetConcurrency: 0,
        pauseBelowRemainingPercent: 10,
        weeklyPauseBelowRemainingPercent: 10,
        reserveWindowHours: 5,
        nominalBurnPerLaneHour: 3,
        providerConcurrencyBudgetUnits: 0,
        requestCostUnits: 0,
        runtimeService: "",
        runtimeEndpoint: "",
        runtimeHealthUrl: "",
        runtimeImage: "",
        runtimeCommand: "",
        localProvider: "",
        numThread: 0,
        numCtx: 0,
        autoPull: false
      }
    ]);
  }

  return (
    <div>
      {lanes.map((lane, index) => (
        <div key={lane.key} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong style={{ fontSize: 12 }}>{lane.key}</strong>
            <Button variant="danger" onClick={() => remove(index)}>Remove lane</Button>
          </div>
          <Grid>
            <Field label="Label">
              <input value={lane.label} onChange={(event) => update(index, { label: event.target.value })} />
            </Field>
            <Field label="Provider">
              <select value={lane.provider} onChange={(event) => changeProvider(index, event.target.value as PolicyLane["provider"])}>
                <option value="hosted_codex">Hosted Codex</option>
                <option value="openai_compatible">OpenAI-compatible</option>
                <option value="local_container">Local container</option>
              </select>
            </Field>
            <Check label="Enabled" checked={lane.enabled} onChange={(value) => update(index, { enabled: value })} />
            <Field label="Model">
              <input value={lane.model} onChange={(event) => update(index, { model: event.target.value })} />
            </Field>
            <Field label="Reasoning effort">
              <input value={lane.reasoningEffort} onChange={(event) => update(index, { reasoningEffort: event.target.value })} />
            </Field>
            <Field label="Target concurrency">
              <input
                type="number" min={0} max={24} step={1}
                value={lane.targetConcurrency}
                onChange={(event) => update(index, { targetConcurrency: Number(event.target.value) })}
              />
            </Field>
            <Field label="Pause below remaining %">
              <input
                type="number" min={0} max={100} step={1}
                value={lane.pauseBelowRemainingPercent}
                onChange={(event) => update(index, { pauseBelowRemainingPercent: Number(event.target.value) })}
              />
            </Field>
            <Field label="Weekly reserve floor %">
              <input
                type="number" min={0} max={100} step={1}
                value={lane.weeklyPauseBelowRemainingPercent}
                onChange={(event) => update(index, { weeklyPauseBelowRemainingPercent: Number(event.target.value) })}
              />
            </Field>
            <Field label="Reserve window (hours)">
              <input
                type="number" min={1} max={48} step={1}
                value={lane.reserveWindowHours}
                onChange={(event) => update(index, { reserveWindowHours: Number(event.target.value) })}
              />
            </Field>
            <Field label="Nominal burn per lane/hour">
              <input
                type="number" min={0} max={20} step={0.5}
                value={lane.nominalBurnPerLaneHour}
                onChange={(event) => update(index, { nominalBurnPerLaneHour: Number(event.target.value) })}
              />
            </Field>
            {(lane.provider === "openai_compatible" || lane.provider === "local_container") && (
              <Field label="Runtime endpoint">
                <input value={lane.runtimeEndpoint} onChange={(event) => update(index, { runtimeEndpoint: event.target.value })} />
              </Field>
            )}
            {lane.provider === "openai_compatible" && (
              <>
                <Field label="Plan concurrency budget (units)">
                  <input
                    type="number" min={0} step={1}
                    value={lane.providerConcurrencyBudgetUnits}
                    onChange={(event) => update(index, { providerConcurrencyBudgetUnits: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Cost per request for this model (units)">
                  <input
                    type="number" min={0} step={0.5}
                    value={lane.requestCostUnits}
                    onChange={(event) => update(index, { requestCostUnits: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Max supported concurrency">
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                    {lane.requestCostUnits > 0
                      ? `${Math.floor(lane.providerConcurrencyBudgetUnits / lane.requestCostUnits)} requests (${lane.providerConcurrencyBudgetUnits} ÷ ${lane.requestCostUnits})`
                      : "set a cost per request to see the derived limit"}
                  </span>
                </Field>
              </>
            )}
            {lane.provider === "local_container" && (
              <>
                <Field label="Runtime service">
                  <input value={lane.runtimeService} onChange={(event) => update(index, { runtimeService: event.target.value })} />
                </Field>
                <Field label="Runtime health URL">
                  <input value={lane.runtimeHealthUrl} onChange={(event) => update(index, { runtimeHealthUrl: event.target.value })} />
                </Field>
                <Field label="Runtime image">
                  <input value={lane.runtimeImage} onChange={(event) => update(index, { runtimeImage: event.target.value })} />
                </Field>
                <Field label="Local provider">
                  <input value={lane.localProvider} onChange={(event) => update(index, { localProvider: event.target.value })} />
                </Field>
                <Field label="Threads">
                  <input type="number" min={0} max={128} value={lane.numThread} onChange={(event) => update(index, { numThread: Number(event.target.value) })} />
                </Field>
                <Field label="Context size">
                  <input type="number" min={0} max={131072} value={lane.numCtx} onChange={(event) => update(index, { numCtx: Number(event.target.value) })} />
                </Field>
                <Check label="Pull missing model" checked={Boolean(lane.autoPull)} onChange={(value) => update(index, { autoPull: value })} />
              </>
            )}
          </Grid>
          {lane.provider === "openai_compatible" && (
            <ApiKeyRow
              laneKey={lane.key}
              status={keyStatus[lane.key] ?? { configured: false, source: "none" }}
              onSaved={refreshKeyStatus}
            />
          )}
        </div>
      ))}
      <Button onClick={add}>Add lane</Button>
    </div>
  );
}

export function SettingsPanel({
  policyControl,
  laneControl,
  dashboardOptions,
  configVersion,
  onSaved
}: {
  policyControl: PolicyControl;
  laneControl: { primaryTargetConcurrency: number; secondaryTargetConcurrency: number; localTargetConcurrency: number };
  dashboardOptions: DashboardOptions;
  configVersion: string;
  onSaved: () => void;
}) {
  const [section, setSection] = useState<Section>("Repo");
  const [form, setForm] = useState<FormState>(() => buildFormState(policyControl));
  const [lanes, setLanes] = useState<PolicyLane[]>(() => policyControl.dispatcher.lanes);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const initial = useMemo(() => buildFormState(policyControl), [policyControl]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function resetForm() {
    setForm(initial);
    setLanes(policyControl.dispatcher.lanes);
    setStatus(null);
  }

  async function save() {
    setSaving(true);
    setStatus("Saving…");
    try {
      await api.post("/api/settings/policies", toBody(form, lanes, configVersion, laneControl));
      setStatus("Policies updated.");
      onSaved();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="Settings" id="settings" defaultCollapsed>
      <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {SECTIONS.map((candidate) => (
            <button
              key={candidate}
              onClick={() => setSection(candidate)}
              style={{
                textAlign: "left",
                background: section === candidate ? "var(--accent)" : "transparent",
                color: section === candidate ? "var(--accent-contrast)" : "var(--text)",
                border: "none",
                borderRadius: 6,
                padding: "6px 8px",
                fontSize: 12,
                cursor: "pointer"
              }}
            >
              {candidate}
            </button>
          ))}
        </div>

        <div>
          {section === "Repo" && (
            <Grid>
              <Field label="Repo key"><input value={form.repoKey} onChange={(e) => set("repoKey", e.target.value)} /></Field>
              <Field label="GitHub repo (owner/repo)"><input value={form.repoGithubSlug} onChange={(e) => set("repoGithubSlug", e.target.value)} /></Field>
              <Field label="Default branch"><input value={form.repoDefaultBranch} onChange={(e) => set("repoDefaultBranch", e.target.value)} /></Field>
              <Field label="Workspace directory"><input value={form.repoWorkspaceDir} onChange={(e) => set("repoWorkspaceDir", e.target.value)} /></Field>
            </Grid>
          )}

          {section === "Lifecycle" && (
            <Grid>
              <Check label="Enable lifecycle" checked={form.lifecycleEnabled} onChange={(v) => set("lifecycleEnabled", v)} />
              <Field label="Target mode">
                <select value={form.lifecycleTargetMode} onChange={(e) => set("lifecycleTargetMode", e.target.value)}>
                  {dashboardOptions.lifecycleTargetModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              </Field>
              <Field label="Target name"><input value={form.lifecycleTargetName} onChange={(e) => set("lifecycleTargetName", e.target.value)} /></Field>
              <Field label="Max parallel PRs"><input type="number" min={1} max={50} value={form.lifecycleMaxParallelPrs} onChange={(e) => set("lifecycleMaxParallelPrs", Number(e.target.value))} /></Field>
              <Field label="Max runs per day"><input type="number" min={1} max={500} value={form.lifecycleMaxRunsPerDay} onChange={(e) => set("lifecycleMaxRunsPerDay", Number(e.target.value))} /></Field>
              <Check label="Pause when target complete" checked={form.lifecyclePauseWhenTargetComplete} onChange={(v) => set("lifecyclePauseWhenTargetComplete", v)} />
              <Check label="Pause when budget exhausted" checked={form.lifecyclePauseWhenBudgetExhausted} onChange={(v) => set("lifecyclePauseWhenBudgetExhausted", v)} />
            </Grid>
          )}

          {section === "Issue Source" && (
            <Grid>
              <Field label="Labels (one per line)"><textarea rows={3} value={form.issueSourceLabels} onChange={(e) => set("issueSourceLabels", e.target.value)} /></Field>
              <Field label="Required issue prefix"><input value={form.issueSourceRequiredIssuePrefix} onChange={(e) => set("issueSourceRequiredIssuePrefix", e.target.value)} /></Field>
              <Field label="Allow manual issue numbers (one per line)"><textarea rows={3} value={form.issueSourceAllowManualIssueNumbers} onChange={(e) => set("issueSourceAllowManualIssueNumbers", e.target.value)} /></Field>
            </Grid>
          )}

          {section === "Dispatcher & Lanes" && (
            <div>
              <Grid>
                <Check label="Enable dispatcher" checked={form.dispatcherEnabled} onChange={(v) => set("dispatcherEnabled", v)} />
                <Field label="Poll interval (seconds)"><input type="number" min={5} max={600} value={form.dispatcherPollIntervalSeconds} onChange={(e) => set("dispatcherPollIntervalSeconds", Number(e.target.value))} /></Field>
                <Field label="Skip issue numbers (one per line)"><textarea rows={2} value={form.dispatcherSkipIssueNumbers} onChange={(e) => set("dispatcherSkipIssueNumbers", e.target.value)} /></Field>
              </Grid>
              <div style={{ fontSize: 12, fontWeight: 600, margin: "14px 0 8px" }}>Lanes</div>
              <LaneEditor lanes={lanes} onChange={setLanes} options={dashboardOptions} />
            </div>
          )}

          {section === "Validator" && (
            <Grid>
              <Check label="Enable validator" checked={form.validationEnabled} onChange={(v) => set("validationEnabled", v)} />
              <Field label="Context"><input value={form.validationContext} onChange={(e) => set("validationContext", e.target.value)} /></Field>
              <Field label="Poll interval (seconds)"><input type="number" min={5} max={600} value={form.validationPollIntervalSeconds} onChange={(e) => set("validationPollIntervalSeconds", Number(e.target.value))} /></Field>
              <Field label="Max concurrent"><input type="number" min={1} max={24} value={form.validationMaxConcurrent} onChange={(e) => set("validationMaxConcurrent", Number(e.target.value))} /></Field>
              <Check label="Post status to GitHub" checked={form.validationPostStatus} onChange={(v) => set("validationPostStatus", v)} />
              <Field label="Working directory"><input value={form.validationWorkingDirectory} onChange={(e) => set("validationWorkingDirectory", e.target.value)} /></Field>
              <Field label="Bootstrap commands (one per line)"><textarea rows={3} value={form.validationBootstrapCommands} onChange={(e) => set("validationBootstrapCommands", e.target.value)} /></Field>
              <Field label="Commands (one per line)"><textarea rows={3} value={form.validationCommands} onChange={(e) => set("validationCommands", e.target.value)} /></Field>
            </Grid>
          )}

          {section === "Reviewer" && (
            <Grid>
              <Check label="Enable reviewer" checked={form.reviewerEnabled} onChange={(v) => set("reviewerEnabled", v)} />
              <Field label="Poll interval (seconds)"><input type="number" min={5} max={600} value={form.reviewerPollIntervalSeconds} onChange={(e) => set("reviewerPollIntervalSeconds", Number(e.target.value))} /></Field>
              <Field label="Max concurrent"><input type="number" min={1} max={24} value={form.reviewerMaxConcurrent} onChange={(e) => set("reviewerMaxConcurrent", Number(e.target.value))} /></Field>
              <Field label="Model">
                <select value={form.reviewerModel} onChange={(e) => set("reviewerModel", e.target.value)}>
                  {dashboardOptions.models.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </Field>
              <Field label="Reasoning effort">
                <select value={form.reviewerReasoningEffort} onChange={(e) => set("reviewerReasoningEffort", e.target.value)}>
                  {dashboardOptions.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                </select>
              </Field>
              <Field label="Post mode">
                <select value={form.reviewerPostMode} onChange={(e) => set("reviewerPostMode", e.target.value)}>
                  {dashboardOptions.reviewerPostModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              </Field>
              <Field label="Instructions path"><input value={form.reviewerInstructionsPath} onChange={(e) => set("reviewerInstructionsPath", e.target.value)} /></Field>
            </Grid>
          )}

          {section === "PR Manager" && (
            <Grid>
              <Check label="Enable PR manager" checked={form.prManagerEnabled} onChange={(v) => set("prManagerEnabled", v)} />
              <Field label="Interval (seconds)"><input type="number" min={5} max={600} value={form.prManagerIntervalSeconds} onChange={(e) => set("prManagerIntervalSeconds", Number(e.target.value))} /></Field>
              <Field label="Merge concurrency"><input type="number" min={1} max={24} value={form.prManagerMergeConcurrency} onChange={(e) => set("prManagerMergeConcurrency", Number(e.target.value))} /></Field>
              <Field label="Update-branch concurrency"><input type="number" min={1} max={24} value={form.prManagerUpdateBranchConcurrency} onChange={(e) => set("prManagerUpdateBranchConcurrency", Number(e.target.value))} /></Field>
              <Field label="Auto-merge label"><input value={form.prManagerAutoMergeLabel} onChange={(e) => set("prManagerAutoMergeLabel", e.target.value)} /></Field>
            </Grid>
          )}

          {section === "Runner Manager" && (
            <Grid>
              <Check label="Enable runner manager" checked={form.runnerManagerEnabled} onChange={(v) => set("runnerManagerEnabled", v)} />
              <Field label="Scope">
                <select value={form.runnerManagerScope} onChange={(e) => set("runnerManagerScope", e.target.value)}>
                  {dashboardOptions.runnerManagerScopes.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
                </select>
              </Field>
              <Field label="Required labels (one per line)"><textarea rows={2} value={form.runnerManagerRequiredLabels} onChange={(e) => set("runnerManagerRequiredLabels", e.target.value)} /></Field>
              <Field label="Runner labels (one per line)"><textarea rows={2} value={form.runnerManagerRunnerLabels} onChange={(e) => set("runnerManagerRunnerLabels", e.target.value)} /></Field>
              <Field label="Runner group"><input value={form.runnerManagerRunnerGroup} onChange={(e) => set("runnerManagerRunnerGroup", e.target.value)} /></Field>
              <Field label="Image name"><input value={form.runnerManagerImageName} onChange={(e) => set("runnerManagerImageName", e.target.value)} /></Field>
              <Field label="Container prefix"><input value={form.runnerManagerContainerPrefix} onChange={(e) => set("runnerManagerContainerPrefix", e.target.value)} /></Field>
              <Field label="Max runners"><input type="number" min={1} max={50} value={form.runnerManagerMaxRunners} onChange={(e) => set("runnerManagerMaxRunners", Number(e.target.value))} /></Field>
              <Field label="Poll interval (seconds)"><input type="number" min={5} max={600} value={form.runnerManagerPollIntervalSeconds} onChange={(e) => set("runnerManagerPollIntervalSeconds", Number(e.target.value))} /></Field>
              <Field label="Launch cooldown (seconds)"><input type="number" min={10} max={3600} value={form.runnerManagerLaunchCooldownSeconds} onChange={(e) => set("runnerManagerLaunchCooldownSeconds", Number(e.target.value))} /></Field>
              <Field label="Network"><input value={form.runnerManagerNetwork} onChange={(e) => set("runnerManagerNetwork", e.target.value)} /></Field>
              <Check label="Dry run" checked={form.runnerManagerDryRun} onChange={(v) => set("runnerManagerDryRun", v)} />
              <Check label="Mount Docker socket" checked={form.runnerManagerMountDockerSocket} onChange={(v) => set("runnerManagerMountDockerSocket", v)} />
              <Check label="Mount workspace" checked={form.runnerManagerMountWorkspace} onChange={(v) => set("runnerManagerMountWorkspace", v)} />
            </Grid>
          )}

          {section === "Monitor" && (
            <Grid>
              <Check label="Enable monitor" checked={form.monitorEnabled} onChange={(v) => set("monitorEnabled", v)} />
              <Field label="Poll interval (seconds)"><input type="number" min={5} max={600} value={form.monitorPollIntervalSeconds} onChange={(e) => set("monitorPollIntervalSeconds", Number(e.target.value))} /></Field>
            </Grid>
          )}

          {section === "Safety" && (
            <Grid>
              <Check label="PR-only changes" checked={form.safetyPrOnly} onChange={(v) => set("safetyPrOnly", v)} />
              <Check label="Allow auto-merge" checked={form.safetyAutoMerge} onChange={(v) => set("safetyAutoMerge", v)} />
              <Check label="Allow force push" checked={form.safetyAllowForcePush} onChange={(v) => set("safetyAllowForcePush", v)} />
              <Check label="Require clean worktree before run" checked={form.safetyRequireCleanWorktreeBeforeRun} onChange={(v) => set("safetyRequireCleanWorktreeBeforeRun", v)} />
              <Field label="Protected branches (one per line)"><textarea rows={3} value={form.safetyProtectedBranches} onChange={(e) => set("safetyProtectedBranches", e.target.value)} /></Field>
              <Field label="Protected paths (one per line)"><textarea rows={3} value={form.safetyProtectedPaths} onChange={(e) => set("safetyProtectedPaths", e.target.value)} /></Field>
            </Grid>
          )}

          {section === "Budgets" && (
            <Grid>
              <Field label="Max estimated credits per day"><input value={form.budgetMaxEstimatedCreditsPerDay} onChange={(e) => set("budgetMaxEstimatedCreditsPerDay", e.target.value)} /></Field>
              <Field label="Pause reason on budget"><input value={form.budgetPauseReasonOnBudget} onChange={(e) => set("budgetPauseReasonOnBudget", e.target.value)} /></Field>
            </Grid>
          )}

          {section === "Branches" && (
            <Grid>
              <Field label="Work branch prefix"><input value={form.branchesWorkBranchPrefix} onChange={(e) => set("branchesWorkBranchPrefix", e.target.value)} /></Field>
              <Field label="PR base branch"><input value={form.branchesPrBaseBranch} onChange={(e) => set("branchesPrBaseBranch", e.target.value)} /></Field>
            </Grid>
          )}

          {section === "Roles" && (
            <Grid>
              <Check label="Autonomous" checked={form.roleAutonomousEnabled} onChange={(v) => set("roleAutonomousEnabled", v)} />
              <Check label="Dispatcher" checked={form.roleDispatcherEnabled} onChange={(v) => set("roleDispatcherEnabled", v)} />
              <Check label="Validator" checked={form.roleValidatorEnabled} onChange={(v) => set("roleValidatorEnabled", v)} />
              <Check label="Reviewer" checked={form.roleReviewerEnabled} onChange={(v) => set("roleReviewerEnabled", v)} />
              <Check label="Runner manager" checked={form.roleRunnerManagerEnabled} onChange={(v) => set("roleRunnerManagerEnabled", v)} />
              <Check label="PR manager" checked={form.rolePrManagerEnabled} onChange={(v) => set("rolePrManagerEnabled", v)} />
              <Check label="Monitor" checked={form.roleMonitorEnabled} onChange={(v) => set("roleMonitorEnabled", v)} />
              <Check label="Dashboard" checked={form.roleDashboardEnabled} onChange={(v) => set("roleDashboardEnabled", v)} />
            </Grid>
          )}

          {section === "Dashboard" && (
            <Grid>
              <Check label="Enable dashboard" checked={form.dashboardEnabled} onChange={(v) => set("dashboardEnabled", v)} />
              <Field label="Port"><input type="number" min={1} max={65535} value={form.dashboardPort} onChange={(e) => set("dashboardPort", Number(e.target.value))} /></Field>
              <Check label="Read issue details" checked={form.dashboardExposeIssueDetails} onChange={(v) => set("dashboardExposeIssueDetails", v)} />
              <Check label="Read pull request links" checked={form.dashboardExposePrLinks} onChange={(v) => set("dashboardExposePrLinks", v)} />
            </Grid>
          )}

          {section === "Retention" && (
            <Grid>
              <Check label="Enable retention cleanup" checked={form.retentionEnabled} onChange={(v) => set("retentionEnabled", v)} />
              <Field label="Worktree max age (hours)"><input type="number" min={0} max={168} value={form.retentionWorktreeMaxAgeHours} onChange={(e) => set("retentionWorktreeMaxAgeHours", Number(e.target.value))} /></Field>
              <Field label="Run log max age (days)"><input type="number" min={0} max={30} value={form.retentionRunLogMaxAgeDays} onChange={(e) => set("retentionRunLogMaxAgeDays", Number(e.target.value))} /></Field>
              <Field label="Output max age (days)"><input type="number" min={0} max={30} value={form.retentionOutputMaxAgeDays} onChange={(e) => set("retentionOutputMaxAgeDays", Number(e.target.value))} /></Field>
            </Grid>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
            <Button variant="primary" onClick={save} disabled={saving}>Save Config</Button>
            <Button onClick={resetForm} disabled={saving}>Reset</Button>
            {status && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{status}</span>}
          </div>
        </div>
      </div>
    </Panel>
  );
}
