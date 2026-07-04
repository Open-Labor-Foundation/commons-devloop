import { useEffect, useState } from "react";
import { Panel, Button, Tabs } from "./Panel";
import { api } from "../api";
import type { CodexActivity, OperationsCard, ServiceName, ServiceState } from "../types";

type Tab = "operations" | "progress" | "coder";

function progressCard(title: string, status: string, meta: string, detail: string) {
  return (
    <div key={title} style={{ background: "var(--surface-alt)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{title}</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{status}</div>
      <div style={{ fontSize: 12, marginTop: 4 }}>{meta}</div>
      <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 6 }}>{detail}</div>
    </div>
  );
}

function summarizeDispatcher(service?: ServiceState) {
  const progress = (service?.state.progress ?? {}) as Record<string, number | Array<{ number: number; lane: string }> | undefined>;
  const items = service?.state.items ?? [];
  const running = Number(progress.running ?? items.filter((item) => item.status === "running").length);
  const queued = Number(progress.queued ?? items.filter((item) => item.status === "queued").length);
  const total = Number(progress.totalIssues ?? items.length);
  const openPrs = Number(progress.openPrs ?? service?.state.openPrCount ?? 0);
  const runningIssues = Array.isArray(progress.runningIssues) ? progress.runningIssues : [];
  const current = runningIssues.length
    ? runningIssues.slice(0, 3).map((item) => `#${item.number} ${item.lane}`).join(", ")
    : "No active issues right now.";
  return progressCard(
    "Dispatcher",
    service?.state.summary || "No activity",
    `${running} running · ${queued} queued · ${openPrs} open PRs`,
    total > 0 ? `Current: ${current}` : "No target issues loaded."
  );
}

function summarizeSweep(title: string, service?: ServiceState) {
  const progress = (service?.state.progress ?? {}) as Record<string, number | string | undefined>;
  const prs = Object.values(service?.state.prs ?? {}) as Array<{ result?: string; next_retry_at?: string }>;
  const passing = prs.filter((entry) => entry.result === "success").length;
  const failing = prs.filter((entry) => entry.result === "failure").length;
  const waitingRetry = prs.filter((entry) => entry.next_retry_at && Date.parse(entry.next_retry_at) > Date.now()).length;
  const source = progress.source ?? "cache";
  const scheduled = Number(progress.scheduled ?? 0);
  const completed = Number(progress.completed ?? 0);
  const retryQueued = Number(progress.waitingRetry ?? waitingRetry);
  const current = progress.currentPrNumber ? `PR #${progress.currentPrNumber}` : "No PR in flight.";
  return progressCard(
    title,
    service?.state.summary || "No activity",
    `${completed} completed · ${scheduled} scheduled · ${passing} pass · ${failing} fail · ${retryQueued} waiting retry`,
    `${current} · source: ${source}`
  );
}

function summarizePrManager(service?: ServiceState) {
  const progress = (service?.state.progress ?? {}) as Record<string, number | undefined>;
  const open = Number(progress.open ?? service?.state.openPrs?.length ?? 0);
  const lastActions = (service?.state.lastActions ?? []).slice(0, 3);
  const actions = lastActions.length ? lastActions.map((entry) => `#${entry.number} ${entry.action}`).join(", ") : "No recent merge actions.";
  return progressCard(
    "PR Manager",
    service?.state.summary || "No activity",
    `${open} open PRs tracked`,
    actions
  );
}

export function StatusPanel({
  cards,
  manualPause,
  services,
  codexActivity,
  onChanged
}: {
  cards: OperationsCard[];
  manualPause: boolean;
  services: Record<ServiceName, ServiceState>;
  codexActivity: CodexActivity;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("operations");
  const [workerKey, setWorkerKey] = useState<string | null>(null);

  const workers = codexActivity.workers ?? [];
  useEffect(() => {
    if (workerKey && !workers.some((worker) => worker.key === workerKey)) {
      setWorkerKey(null);
    }
  }, [workers, workerKey]);
  const selected = workers.find((worker) => worker.key === workerKey) ?? (workers.length ? workers[0] : codexActivity);

  async function pauseOrResume() {
    await api.post(manualPause ? "/api/dispatcher/resume" : "/api/dispatcher/pause");
    onChanged();
  }

  return (
    <Panel
      title="Status"
      id="status"
      actions={
        <Button variant={manualPause ? "primary" : "danger"} onClick={pauseOrResume}>
          {manualPause ? "Resume Repo" : "Pause Repo"}
        </Button>
      }
    >
      <Tabs
        tabs={[
          { key: "operations", label: "Operations" },
          { key: "progress", label: "Live Progress" },
          { key: "coder", label: "Coder Activity" }
        ]}
        active={tab}
        onChange={(key) => setTab(key as Tab)}
      />

      {tab === "operations" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
          {cards.map((card) => (
            <div key={card.label} style={{ background: "var(--surface-alt)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{card.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{card.value}</div>
              {card.sub && <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{card.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {tab === "progress" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          {summarizeDispatcher(services.dispatcher)}
          {summarizeSweep("Validator", services.validator)}
          {summarizeSweep("Reviewer", services.reviewer)}
          {summarizePrManager(services["pr-manager"])}
        </div>
      )}

      {tab === "coder" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{selected?.title || "No active coder worker"}</div>
            <select
              value={workerKey ?? ""}
              disabled={workers.length === 0}
              onChange={(event) => setWorkerKey(event.target.value || null)}
              style={{ fontSize: 12 }}
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
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
            {selected?.meta || "The next dispatched issue will stream its run log here."}
          </div>
          <pre
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 8,
              fontSize: 11,
              maxHeight: 260,
              overflow: "auto",
              whiteSpace: "pre-wrap"
            }}
          >
            {selected?.logTail?.length ? selected.logTail.join("\n") : "No live worker output yet."}
          </pre>
        </div>
      )}
    </Panel>
  );
}
