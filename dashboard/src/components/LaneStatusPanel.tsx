import { useEffect, useState } from "react";
import { Panel, Badge, Button, Metric } from "./Panel";
import { api } from "../api";
import type { LaneApiKeyStatus, LaneTelemetry, Tone } from "../types";

type Health = { tone: Tone | "off"; label: string; detail: string };

function laneHealth(lane: LaneTelemetry): Health {
  const dailyRemaining = lane.remainingPercent;
  const weeklyRemaining = lane.weeklyRemainingPercent ?? null;
  const configuredTarget = lane.targetConcurrency ?? 0;
  const activeTarget = lane.activeTargetConcurrency ?? configuredTarget;
  const running = lane.running ?? 0;

  if (lane.pauseReason) {
    return { tone: "warn", label: "Paused", detail: lane.pauseReason };
  }
  if (configuredTarget <= 0) {
    return { tone: "off", label: "Off", detail: "This lane is configured with 0 workers." };
  }
  if (lane.provider === "local_container") {
    if (lane.runtimeStatus === "ready") {
      return { tone: "good", label: "Ready", detail: lane.localResourceSummary || "Local runtime is ready." };
    }
    if (lane.runtimeStatus === "busy") {
      return { tone: "good", label: "Running", detail: `${running} issue${running === 1 ? "" : "s"} currently running on this local lane.` };
    }
    return { tone: "warn", label: "Unavailable", detail: lane.localResourceSummary || "Local runtime is not available." };
  }
  if (lane.provider === "openai_compatible") {
    // No daily/weekly usage window for this provider — concurrency against
    // the plan's unit budget is the only real ceiling, so health is judged
    // on running/target/maxSupportedConcurrency rather than quota percent.
    const maxSupported = lane.maxSupportedConcurrency ?? null;
    if (running > 0) {
      return {
        tone: "good",
        label: "Running",
        detail: `${running} issue${running === 1 ? "" : "s"} currently running on this lane.${activeTarget <= 0 ? " New launches are temporarily held until the current worker finishes." : ""}`
      };
    }
    if (activeTarget <= 0) {
      return {
        tone: "warn",
        label: "Held",
        detail: lane.throttleReason || `Configured for ${configuredTarget} worker${configuredTarget === 1 ? "" : "s"}, but currently held at 0 by dispatcher constraints.`
      };
    }
    if (maxSupported != null && configuredTarget > maxSupported) {
      return {
        tone: "warn",
        label: "Over plan concurrency",
        detail: `Target concurrency (${configuredTarget}) exceeds the plan's derived concurrency limit (${maxSupported} requests) for this model.`
      };
    }
    return { tone: "good", label: "Ready", detail: "This lane has capacity configured but no active workers right now." };
  }
  if (running > 0) {
    return {
      tone: "good",
      label: "Running",
      detail: `${running} issue${running === 1 ? "" : "s"} currently running on this lane.${activeTarget <= 0 ? " New launches are temporarily held until the current worker finishes." : ""}`
    };
  }
  if (activeTarget <= 0) {
    return {
      tone: "warn",
      label: "Held",
      detail: lane.throttleReason || `Configured for ${configuredTarget} worker${configuredTarget === 1 ? "" : "s"}, but currently held at 0 by dispatcher constraints.`
    };
  }
  if (dailyRemaining == null) {
    return { tone: "warn", label: "No telemetry", detail: "Quota telemetry is unavailable, so this lane should be watched closely." };
  }
  if (lane.effectiveReserveRemainingPercent != null && dailyRemaining <= lane.effectiveReserveRemainingPercent) {
    return {
      tone: "warn",
      label: "Daily reserve pressure",
      detail: `Daily remaining quota is ${dailyRemaining}%, at or below the protected reserve (${lane.effectiveReserveRemainingPercent}%).${weeklyRemaining == null ? "" : ` Weekly remaining is ${weeklyRemaining}%.`}`
    };
  }
  if (dailyRemaining <= lane.pauseBelowRemainingPercent) {
    return {
      tone: "bad",
      label: "At daily pause threshold",
      detail: `Daily remaining quota is ${dailyRemaining}%, at the configured pause threshold (${lane.pauseBelowRemainingPercent}%).${weeklyRemaining == null ? "" : ` Weekly remaining is ${weeklyRemaining}%.`}`
    };
  }
  if (weeklyRemaining != null && lane.weeklyPauseBelowRemainingPercent != null && weeklyRemaining <= lane.weeklyPauseBelowRemainingPercent) {
    return {
      tone: "warn",
      label: "Weekly reserve pressure",
      detail: `Weekly remaining quota is ${weeklyRemaining}%, at or below the configured weekly reserve (${lane.weeklyPauseBelowRemainingPercent}%).`
    };
  }
  if (running <= 0) {
    return { tone: "warn", label: "Ready", detail: "This lane has capacity configured but no active workers right now." };
  }
  if (running < configuredTarget) {
    return { tone: "warn", label: "Filling", detail: `Running ${running} of ${configuredTarget} configured workers.` };
  }
  return { tone: "good", label: "Healthy", detail: `Running ${running} of ${configuredTarget} configured workers with quota available.` };
}

export function ApiKeyRow({ laneKey, status, onSaved }: { laneKey: string; status: LaneApiKeyStatus; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.post(`/api/lanes/${encodeURIComponent(laneKey)}/key`, { apiKey: value });
      setValue("");
      setEditing(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          API key: {status.configured ? `configured (${status.source})` : "not set"}
        </span>
        <Button onClick={() => setEditing(true)}>{status.configured ? "Change" : "Set key"}</Button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
      <input
        type="password"
        placeholder="Paste API key"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        style={{ flex: 1 }}
      />
      <Button variant="primary" onClick={save} disabled={saving || !value.trim()}>
        Save
      </Button>
      <Button onClick={() => setEditing(false)}>Cancel</Button>
    </div>
  );
}

function LaneCard({ lane, keyStatus, onKeySaved }: { lane: LaneTelemetry; keyStatus: LaneApiKeyStatus; onKeySaved: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const health = laneHealth(lane);
  const percent = lane.remainingPercent;
  const width = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const barTone: Tone = percent == null ? "warn" : percent <= lane.pauseBelowRemainingPercent ? "bad" : percent <= 25 ? "warn" : "good";
  const provider = lane.provider === "local_container" ? "Local" : lane.provider === "openai_compatible" ? "OpenAI-compatible" : "Hosted";
  const resourceText = lane.provider === "local_container"
    ? (lane.localResourceSummary || `Runtime ${lane.runtimeStatus || "unknown"}`)
    : lane.provider === "openai_compatible"
      ? (lane.maxSupportedConcurrency != null
          ? `No usage window for this provider — concurrency limit is ${lane.maxSupportedConcurrency} request${lane.maxSupportedConcurrency === 1 ? "" : "s"} (${lane.providerConcurrencyBudgetUnits} unit budget ÷ ${lane.requestCostUnits} unit cost).`
          : "No usage window for this provider. Set a cost per request in Settings to compute the concurrency limit.")
      : `${percent == null ? "No daily quota reading available" : `${percent}% daily remaining`}${lane.weeklyRemainingPercent == null ? "" : ` · ${lane.weeklyRemainingPercent}% weekly remaining`} · Telemetry ${lane.telemetryAge || "unavailable"}`;

  return (
    <div style={{ background: "var(--surface-alt)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <strong>{lane.label}</strong>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {provider} · {lane.model} · {lane.reasoningEffort}
          </div>
        </div>
        <Badge tone={health.tone === "off" ? "warn" : health.tone}>{health.label}</Badge>
      </div>
      {lane.provider !== "local_container" && lane.provider !== "openai_compatible" && (
        <div style={{ background: "var(--border)", borderRadius: 4, height: 6, marginTop: 8, overflow: "hidden" }}>
          <div style={{ width: `${width}%`, height: "100%", background: `var(--${barTone})` }} />
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>{health.detail}</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{resourceText}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8, marginTop: 10 }}>
        <Metric label="Running" value={lane.running} />
        <Metric label="Configured workers" value={lane.targetConcurrency} />
        <Metric label="Active workers allowed" value={lane.activeTargetConcurrency ?? lane.targetConcurrency} />
      </div>

      <button
        onClick={() => setExpanded((prev) => !prev)}
        style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 11, padding: "8px 0 0", cursor: "pointer" }}
      >
        {expanded ? "Hide details" : "Show details"}
      </button>

      {expanded && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginTop: 8 }}>
          {lane.provider === "local_container" ? (
            <>
              <Metric label="Runtime" value={lane.runtimeStatus || "-"} />
              <Metric label="Service" value={lane.runtimeService || "-"} />
              <Metric label="Provider" value={lane.localProvider || "-"} />
              <Metric label="Endpoint" value={lane.runtimeEndpoint || "-"} />
              <Metric label="Image" value={lane.runtimeImage || "-"} />
              <Metric label="Threads" value={lane.numThread || "-"} />
              <Metric label="Context" value={lane.numCtx || "-"} />
            </>
          ) : lane.provider === "openai_compatible" ? (
            <>
              <Metric label="Plan concurrency budget" value={lane.providerConcurrencyBudgetUnits != null ? `${lane.providerConcurrencyBudgetUnits} units` : "-"} />
              <Metric label="Cost per request" value={lane.requestCostUnits != null ? `${lane.requestCostUnits} units` : "-"} />
              <Metric label="Max supported concurrency" value={lane.maxSupportedConcurrency != null ? `${lane.maxSupportedConcurrency} requests` : "-"} />
              <Metric label="Endpoint" value={lane.runtimeEndpoint || "-"} />
            </>
          ) : (
            <>
              <Metric label="Daily remaining" value={lane.remainingPercent == null ? "-" : `${lane.remainingPercent}%`} />
              <Metric label="Weekly remaining" value={lane.weeklyRemainingPercent == null ? "-" : `${lane.weeklyRemainingPercent}%`} />
              <Metric label="Protected reserve" value={lane.effectiveReserveRemainingPercent == null ? "-" : `${lane.effectiveReserveRemainingPercent}%`} />
              <Metric label="Reset" value={lane.reset || "-"} />
              <Metric label="Weekly reset" value={lane.weeklyReset || "-"} />
              <Metric label="Daily pause threshold" value={`${lane.pauseBelowRemainingPercent}% remaining`} />
              <Metric label="Weekly reserve threshold" value={`${lane.weeklyPauseBelowRemainingPercent}% remaining`} />
              <Metric label="Protection window" value={`${lane.reserveWindowHours}h`} />
            </>
          )}
        </div>
      )}

      {lane.provider === "openai_compatible" && (
        <>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>{lane.runtimeEndpoint}</div>
          <ApiKeyRow laneKey={lane.key} status={keyStatus} onSaved={onKeySaved} />
        </>
      )}
    </div>
  );
}

export function LaneStatusPanel({ lanes }: { lanes: LaneTelemetry[] }) {
  const [keyStatus, setKeyStatus] = useState<Record<string, LaneApiKeyStatus>>({});

  async function refreshKeyStatus() {
    try {
      const result = await api.get<{ lanes: Record<string, LaneApiKeyStatus> }>("/api/lanes/keys");
      setKeyStatus(result.lanes);
    } catch {
      // Non-fatal — key status is a secondary detail, not required for the lane cards themselves.
    }
  }

  useEffect(() => {
    void refreshKeyStatus();
  }, []);

  const visibleLanes = lanes.filter((lane) => lane.key !== "local" || lane.provider === "local_container");

  return (
    <Panel title="Lane Status" id="lanes">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
        {visibleLanes.map((lane) => (
          <LaneCard
            key={lane.key}
            lane={lane}
            keyStatus={keyStatus[lane.key] ?? { configured: false, source: "none" }}
            onKeySaved={refreshKeyStatus}
          />
        ))}
      </div>
    </Panel>
  );
}
