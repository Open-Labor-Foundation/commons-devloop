import { useEffect, useState } from "react";
import { Panel, Badge, Button, Tabs } from "./Panel";
import { api } from "../api";
import type {
  ActivityWorker,
  CheckRecord,
  DispatcherItem,
  IssueRef,
  MergedPullRequest,
  PrDrillDown,
  ReviewActivityEntry,
  ServiceName,
  ServiceState
} from "../types";

type Tab = "laneQueue" | "issues" | "prs" | "review";

function formatDateTime(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "-" : parsed.toLocaleString();
}

function formatRelative(value?: string | null): string {
  if (!value) return "-";
  const target = Date.parse(value);
  if (Number.isNaN(target)) return "-";
  const diffMs = target - Date.now();
  const minutes = Math.round(diffMs / 60000);
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}m ${minutes >= 0 ? "from now" : "ago"}`;
  const hours = Math.round(minutes / 60);
  return `${Math.abs(hours)}h ${hours >= 0 ? "from now" : "ago"}`;
}

function CheckLine({ label, check }: { label: string; check: CheckRecord }) {
  const parts = [
    check.updatedAt ? `updated ${formatRelative(check.updatedAt)}` : null,
    check.failureCount != null ? `${check.failureCount} attempt${check.failureCount === 1 ? "" : "s"}` : null,
    check.nextRetryAt ? `retry ${formatRelative(check.nextRetryAt)}` : null,
    check.remediation?.label ?? null
  ].filter(Boolean).join(" · ");
  return (
    <div style={{ marginBottom: 4 }}>
      <div>
        <strong style={{ fontSize: 12 }}>{label}</strong> <Badge tone={check.tone}>{check.label}</Badge>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{[parts, check.failureSummary].filter(Boolean).join(" · ") || "No current local result recorded."}</div>
    </div>
  );
}

function CheckArtifacts({ label, check }: { label: string; check: CheckRecord }) {
  if (!check.runLog && !check.outputPath) {
    return <div style={{ fontSize: 11, color: "var(--text-muted)" }}>No local artifact path recorded yet.</div>;
  }
  return (
    <div style={{ marginBottom: 6 }}>
      {check.runLog && (
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{label} log</div>
          <div style={{ fontSize: 11, fontFamily: "ui-monospace, monospace" }}>{check.runLog}</div>
          {check.runLogExcerpt.length > 0 && (
            <pre style={{ fontSize: 10, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, padding: 6, overflow: "auto", maxHeight: 120 }}>
              {check.runLogExcerpt.join("\n")}
            </pre>
          )}
        </div>
      )}
      {check.outputPath && (
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{label} output</div>
          <div style={{ fontSize: 11, fontFamily: "ui-monospace, monospace" }}>{check.outputPath}</div>
        </div>
      )}
    </div>
  );
}

function PrRow({ pr }: { pr: PrDrillDown }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 220px" }}>
          {pr.url ? (
            <a href={pr.url} target="_blank" rel="noreferrer">
              #{pr.number} {pr.title}
            </a>
          ) : (
            <strong>#{pr.number} {pr.title}</strong>
          )}
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{pr.headRefName}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {pr.isDraft ? "Draft pull request" : `Merge state ${pr.mergeStateStatus || "unknown"}`}
          </div>
        </div>
        <div style={{ flex: "1 1 160px" }}>
          <Badge tone={pr.movement.tone}>{pr.movement.label}</Badge>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{pr.movement.detail || "-"}</div>
          {pr.movement.nextRetryAt && (
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Next retry {formatDateTime(pr.movement.nextRetryAt)} ({formatRelative(pr.movement.nextRetryAt)})
            </div>
          )}
        </div>
        <div style={{ flex: "1 1 160px" }}>
          <Badge tone={pr.localGate.tone}>{pr.localGate.label}</Badge>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{pr.localGate.reason}</div>
        </div>
        <button
          onClick={() => setExpanded((prev) => !prev)}
          style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer", alignSelf: "start" }}
        >
          {expanded ? "Hide checks" : "Show checks"}
        </button>
      </div>
      {expanded && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
          <div>
            <CheckLine label="Validator" check={pr.checks.validator} />
            <CheckArtifacts label="Validator" check={pr.checks.validator} />
          </div>
          <div>
            <CheckLine label="Reviewer" check={pr.checks.reviewer} />
            <CheckArtifacts label="Reviewer" check={pr.checks.reviewer} />
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewServiceCard({ serviceKey, activity }: { serviceKey: "validator" | "reviewer"; activity: ReviewActivityEntry }) {
  const [workerKey, setWorkerKey] = useState<string | null>(null);
  const workers = activity.workers ?? [];
  useEffect(() => {
    if (workerKey && !workers.some((worker) => worker.key === workerKey)) {
      setWorkerKey(null);
    }
  }, [workers, workerKey]);
  const selected: ActivityWorker | null = workers.find((worker) => worker.key === workerKey) ?? activity.selected ?? null;
  const hasSelection = selected?.number != null;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function requeue(action: "pending" | "clear") {
    if (!selected?.number) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.post(`/api/requeue/${serviceKey}/${action}`, { prNumber: selected.number });
      setStatus(action === "pending" ? `#${selected.number} set pending.` : `#${selected.number} record cleared.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "requeue failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 12, textTransform: "capitalize" }}>{serviceKey}</strong>
        <select
          value={workerKey ?? selected?.key ?? ""}
          disabled={workers.length === 0}
          onChange={(event) => setWorkerKey(event.target.value || null)}
          style={{ fontSize: 11 }}
        >
          {workers.length === 0 ? (
            <option value="">No runs available</option>
          ) : (
            workers.map((worker) => (
              <option key={worker.key} value={worker.key}>
                {worker.selectorLabel}
              </option>
            ))
          )}
        </select>
      </div>
      <div style={{ fontSize: 12, marginTop: 4 }}>{selected?.summary ?? "No activity"}</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{selected?.meta}</div>
      <pre
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 8,
          fontSize: 10,
          maxHeight: 160,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          marginTop: 6
        }}
      >
        {[selected?.error, selected?.logTail?.join("\n")].filter(Boolean).join("\n\n") || "No log output yet."}
      </pre>
      <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
        <Button disabled={!hasSelection || busy} onClick={() => requeue("pending")}>Set pending</Button>
        <Button disabled={!hasSelection || busy} onClick={() => requeue("clear")}>Clear record</Button>
        {status && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{status}</span>}
      </div>
    </div>
  );
}

export function WorkPanel({
  targetIssues,
  mergedPrs,
  prDrillDown,
  reviewActivity,
  services
}: {
  targetIssues: IssueRef[];
  mergedPrs: MergedPullRequest[];
  prDrillDown: PrDrillDown[];
  reviewActivity: { validator: ReviewActivityEntry; reviewer: ReviewActivityEntry };
  services: Record<ServiceName, ServiceState>;
}) {
  const [tab, setTab] = useState<Tab>("laneQueue");
  const dispatcherItems: DispatcherItem[] = services.dispatcher?.state.items ?? [];
  const laneQueue = dispatcherItems.filter((item) => item.status === "running");
  const drillDown = prDrillDown;

  const movementSummary = drillDown.reduce<Record<string, number>>((summary, pr) => {
    const key = pr.movement?.key || "unknown";
    summary[key] = (summary[key] ?? 0) + 1;
    return summary;
  }, {});
  const localMerged = mergedPrs.filter((pr) => pr.source === "local").length;
  const githubMerged = mergedPrs.filter((pr) => pr.source === "github").length;

  return (
    <Panel title="Work" id="work">
      <Tabs
        tabs={[
          { key: "laneQueue", label: "Issues in Lanes" },
          { key: "issues", label: "Active Issues" },
          { key: "prs", label: "Pull Requests" },
          { key: "review", label: "Review Services" }
        ]}
        active={tab}
        onChange={(key) => setTab(key as Tab)}
      />

      {tab === "laneQueue" && (
        <div>
          {laneQueue.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No issues are currently assigned to a lane.</div>
          ) : (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                  <th style={{ padding: "4px 6px" }}>#</th>
                  <th style={{ padding: "4px 6px" }}>Title</th>
                  <th style={{ padding: "4px 6px" }}>Lane</th>
                  <th style={{ padding: "4px 6px" }}>Model</th>
                </tr>
              </thead>
              <tbody>
                {laneQueue.map((item) => (
                  <tr key={item.number} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "4px 6px" }}>
                      {item.url ? <a href={item.url} target="_blank" rel="noreferrer">#{item.number}</a> : `#${item.number}`}
                    </td>
                    <td style={{ padding: "4px 6px" }}>{item.title}</td>
                    <td style={{ padding: "4px 6px" }}>
                      <Badge tone={item.assigned_lane === "primary" ? "good" : "warn"}>{item.assigned_lane ?? "-"}</Badge>
                    </td>
                    <td style={{ padding: "4px 6px" }}>{item.assigned_model ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "issues" && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {targetIssues.length === 0 && <li style={{ color: "var(--text-muted)" }}>No issues match the current target filters.</li>}
          {targetIssues.map((issue) => (
            <li key={issue.number} style={{ marginBottom: 4 }}>
              {issue.url ? (
                <a href={issue.url} target="_blank" rel="noreferrer">
                  #{issue.number} {issue.title}
                </a>
              ) : (
                `#${issue.number} ${issue.title}`
              )}
              {issue.milestone?.title && <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {issue.milestone.title}</span>}
              {issue.labels?.length ? (
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {issue.labels.map((label) => label.name).join(", ")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {tab === "prs" && (
        <div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
            {drillDown.length} PRs in the local merge watch queue
          </div>
          <div style={{ fontSize: 12, marginBottom: 10 }}>
            {movementSummary.ready ?? 0} ready · {movementSummary["waiting-local"] ?? 0} waiting local · {movementSummary["waiting-retry"] ?? 0} retry · {movementSummary.blocked ?? 0} blocked · {movementSummary["update-branch"] ?? 0} behind
          </div>
          {drillDown.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No open PRs.</div>
          ) : (
            drillDown.map((pr) => <PrRow key={pr.number} pr={pr} />)
          )}

          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 16, marginBottom: 4 }}>Merged PRs</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
            {mergedPrs.length} shown · {localMerged} local · {githubMerged} github
          </div>
          {mergedPrs.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No merged PR history yet.</div>
          ) : (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                  <th style={{ padding: "4px 6px" }}>#</th>
                  <th style={{ padding: "4px 6px" }}>Title</th>
                  <th style={{ padding: "4px 6px" }}>Merged at</th>
                  <th style={{ padding: "4px 6px" }}>Source</th>
                </tr>
              </thead>
              <tbody>
                {mergedPrs.map((pr) => (
                  <tr key={pr.number} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "4px 6px" }}>
                      {pr.url ? <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a> : `#${pr.number}`}
                    </td>
                    <td style={{ padding: "4px 6px" }}>{pr.title}</td>
                    <td style={{ padding: "4px 6px" }}>{formatDateTime(pr.mergedAt)}</td>
                    <td style={{ padding: "4px 6px" }}>{pr.source ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "review" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <ReviewServiceCard serviceKey="validator" activity={reviewActivity.validator} />
          <ReviewServiceCard serviceKey="reviewer" activity={reviewActivity.reviewer} />
        </div>
      )}
    </Panel>
  );
}
