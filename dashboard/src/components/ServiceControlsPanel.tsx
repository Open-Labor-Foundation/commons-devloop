import { Panel, Badge, Button } from "./Panel";
import { api } from "../api";
import type { ServiceName, ServiceState } from "../types";

const SERVICE_ORDER: ServiceName[] = [
  "autonomous",
  "dispatcher",
  "validator",
  "reviewer",
  "runner-manager",
  "pr-manager",
  "monitor"
];

function tone(service: ServiceState): "good" | "warn" | "bad" {
  if (!service.state.desiredEnabled) return "warn";
  return service.state.alive ? "good" : "bad";
}

export function ServiceControlsPanel({
  services,
  onChanged
}: {
  services: Record<ServiceName, ServiceState>;
  onChanged: () => void;
}) {
  async function toggle(service: ServiceName, desiredEnabled: boolean) {
    await api.post(`/api/service/${service}/${desiredEnabled ? "start" : "stop"}`);
    onChanged();
  }

  async function reset(service: ServiceName) {
    await api.post(`/api/service/${service}/reset`);
    onChanged();
  }

  return (
    <Panel title="Services" id="services">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {SERVICE_ORDER.map((service) => {
          const entry = services[service];
          if (!entry) return null;
          const resetDisabled = !entry.state.configEnabled || !entry.state.desiredEnabled;
          return (
            <div key={service} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div>
                <strong style={{ fontSize: 13 }}>{service}</strong>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{entry.state.summary}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Badge tone={tone(entry)}>{entry.state.lifecycle}</Badge>
                <Button onClick={() => toggle(service, !entry.state.desiredEnabled)} disabled={!entry.state.configEnabled}>
                  {entry.state.desiredEnabled ? "Stop" : "Start"}
                </Button>
                <Button onClick={() => reset(service)} disabled={resetDisabled}>
                  Reset
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
