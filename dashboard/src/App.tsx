import { useCallback, useEffect, useState } from "react";
import { api, getStoredToken } from "./api";
import { TokenGate } from "./components/TokenGate";
import { Header } from "./components/Header";
import { ReadinessPanel } from "./components/ReadinessPanel";
import { StatusPanel } from "./components/StatusPanel";
import { LaneStatusPanel } from "./components/LaneStatusPanel";
import { WorkPanel } from "./components/WorkPanel";
import { ServiceControlsPanel } from "./components/ServiceControlsPanel";
import { ResourceMonitorPanel } from "./components/ResourceMonitorPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import type { DashboardState } from "./types";

const POLL_INTERVAL_MS = 15_000;

export default function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.get<DashboardState>(`/api/state?_=${Date.now()}`);
      setState(result);
      setNeedsToken(false);
      setError(null);
    } catch (err) {
      if (api.isAuthError(err)) {
        setNeedsToken(true);
        return;
      }
      setError(err instanceof Error ? err.message : "failed to load dashboard state");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  if (needsToken && !getStoredToken()) {
    return <TokenGate onSubmit={refresh} />;
  }

  if (needsToken) {
    // A token is stored but the server rejected it (wrong/rotated) — clear and re-prompt.
    return <TokenGate onSubmit={refresh} />;
  }

  if (!state) {
    return <div style={{ padding: 20, color: "var(--text-muted)" }}>{error ?? "Loading…"}</div>;
  }

  return (
    <>
      <Header repoKey={state.repo.key} generatedAt={state.generatedAt} />
      <main style={{ maxWidth: 1280, margin: "0 auto", padding: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <ReadinessPanel readiness={state.deploymentReadiness} />
          <StatusPanel
            cards={state.operationsCards}
            manualPause={state.controlState.manualPause}
            services={state.services}
            codexActivity={state.codexActivity}
            onChanged={refresh}
          />
          <LaneStatusPanel lanes={state.laneTelemetry.lanes} />
          <ResourceMonitorPanel resourceMonitor={state.resourceMonitor} />
        </div>
        <div>
          <ServiceControlsPanel services={state.services} onChanged={refresh} />
          <WorkPanel
            targetIssues={state.targetIssues}
            mergedPrs={state.mergedPrs}
            prDrillDown={state.prDrillDown}
            reviewActivity={state.reviewActivity}
            services={state.services}
          />
          <SettingsPanel
            policyControl={state.policyControl}
            laneControl={state.laneControl}
            dashboardOptions={state.dashboardOptions}
            configVersion={state.configVersion}
            onSaved={refresh}
          />
        </div>
      </main>
    </>
  );
}
