import { Panel, Badge, Metric } from "./Panel";
import type { DeploymentReadiness } from "../types";

function formatDateTime(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "-" : parsed.toLocaleString();
}

export function ReadinessPanel({ readiness }: { readiness: DeploymentReadiness }) {
  const github = readiness.githubVisibility;
  const services = readiness.requiredServices.items;
  const summary = readiness.requiredServices.summary;
  const serviceText = [
    `${summary.running}/${summary.total} running`,
    summary.starting ? `${summary.starting} starting` : null,
    summary.stopped ? `${summary.stopped} stopped` : null,
    summary.disabled ? `${summary.disabled} disabled` : null
  ].filter(Boolean).join(" · ");
  const githubText = [github.issues.label, github.pullRequests.label, github.mergedPullRequests.label].join(" · ");

  return (
    <Panel title="Deployment Readiness" id="readiness">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{readiness.label}</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{readiness.summary}</div>
        </div>
        <Badge tone={readiness.tone}>{readiness.status}</Badge>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
        <Metric label="Config" value={readiness.config.valid ? "Valid" : "Invalid"} sub={`schema ${readiness.config.schemaVersion ?? "-"} · v${readiness.config.currentVersion}`} />
        <Metric label="Repo" value={readiness.identity.githubSlug || readiness.identity.repoKey} sub={readiness.identity.defaultBranch ? `default ${readiness.identity.defaultBranch}` : undefined} />
        <Metric label="Stack" value={readiness.identity.stackId} sub={readiness.identity.stackSource ? `source ${readiness.identity.stackSource}` : undefined} />
        <Metric label="State root" value={readiness.identity.stateRoot} />
        <Metric label="Dashboard port" value={readiness.identity.dashboardPort} />
        <Metric
          label="Target repo"
          value={readiness.targetRepoMount.label}
          sub={readiness.targetRepoMount.path || readiness.targetRepoMount.detail}
        />
        <Metric label="GitHub visibility" value={githubText} sub={`refreshed ${formatDateTime(github.updatedAt)}`} />
        <Metric label="Required services" value={serviceText} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: readiness.blockers.length || readiness.warnings.length ? 12 : 0 }}>
        {services.map((service) => (
          <Badge key={service.service} tone={service.tone} title={service.summary ?? service.statusSource}>
            {service.label}: {service.lifecycle}
          </Badge>
        ))}
      </div>

      {readiness.blockers.length > 0 && (
        <div style={{ marginBottom: readiness.warnings.length ? 10 : 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--bad)", marginBottom: 4 }}>Blockers</div>
          {readiness.blockers.map((concern) => (
            <div key={concern.code} style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 12 }}>{concern.message}</div>
              {concern.detail && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{concern.detail}</div>}
            </div>
          ))}
        </div>
      )}

      {readiness.warnings.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--warn)", marginBottom: 4 }}>Concerns</div>
          {readiness.warnings.map((concern) => (
            <div key={concern.code} style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 12 }}>{concern.message}</div>
              {concern.detail && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{concern.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
