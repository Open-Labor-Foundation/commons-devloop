import { Panel, Metric } from "./Panel";
import type { ResourceMonitor } from "../types";

export function ResourceMonitorPanel({ resourceMonitor }: { resourceMonitor: ResourceMonitor }) {
  const host = resourceMonitor.host;
  const memory = host.memory;
  const docker = resourceMonitor.docker;
  const disk = resourceMonitor.disk;
  const containers = docker.containers ?? [];
  const filesystems = disk.filesystems ?? [];
  const blockDevices = disk.blockDevices?.devices ?? [];

  return (
    <Panel title="Resource Monitor" id="resources" defaultCollapsed>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Metric
          label="CPU"
          value={host.sampledCpu || `${host.cpuCount} CPU${host.cpuCount === 1 ? "" : "s"}`}
          sub={`${host.hostname} · sampled machine CPU busy · ${host.cpuCount} CPUs`}
        />
        <Metric
          label="Load"
          value={host.loadHostShare || "Unavailable"}
          sub={`load ${host.loadAverage.join(" / ")} normalized across ${host.cpuCount} CPUs`}
        />
        <Metric
          label="Memory"
          value={memory.available ? `${memory.available} available` : "Unavailable"}
          sub={`${memory.usedPercent ?? "-"}% used · ${memory.used} used · ${memory.cache} cache · ${memory.total} total`}
        />
        <Metric
          label="Swap"
          value={memory.swapUsedPercent == null ? "Unavailable" : `${memory.swapUsedPercent}% used`}
          sub={`${memory.swapUsed} used · ${memory.swapFree} free · ${memory.swapTotal} total`}
        />
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Containers</div>
      {containers.length ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
          {docker.summary.containersRunning ?? containers.length} running · {docker.summary.containers ?? containers.length} total ·{" "}
          {docker.summary.totalHostShare} host share · Docker {docker.summary.serverVersion ?? "-"}
        </div>
      ) : null}
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginBottom: 16 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "4px 6px" }}>Container</th>
            <th style={{ padding: "4px 6px" }}>CPU</th>
            <th style={{ padding: "4px 6px" }}>Memory</th>
            <th style={{ padding: "4px 6px" }}>Network / Block</th>
          </tr>
        </thead>
        <tbody>
          {containers.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ padding: "4px 6px", color: "var(--text-muted)" }}>
                {docker.available === false ? docker.error || "Docker stats unavailable" : "No container stats available"}
              </td>
            </tr>
          ) : (
            containers.map((container) => (
              <tr key={container.id || container.name} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "4px 6px" }}>
                  <div>{container.name}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>pids {container.pids}</div>
                </td>
                <td style={{ padding: "4px 6px" }}>{container.cpuHostShare}</td>
                <td style={{ padding: "4px 6px" }}>
                  <div>{container.memory}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{container.memoryPercent}</div>
                </td>
                <td style={{ padding: "4px 6px" }}>
                  <div>{container.network}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{container.block}</div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Disk</div>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginBottom: 16 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "4px 6px" }}>Mount</th>
            <th style={{ padding: "4px 6px" }}>Used / Size</th>
            <th style={{ padding: "4px 6px" }}>Available</th>
            <th style={{ padding: "4px 6px" }}>Use %</th>
          </tr>
        </thead>
        <tbody>
          {filesystems.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ padding: "4px 6px", color: "var(--text-muted)" }}>
                {disk.available === false ? disk.error || "Disk stats unavailable" : "No disk stats available"}
              </td>
            </tr>
          ) : (
            filesystems.map((entry) => (
              <tr key={entry.mount} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "4px 6px" }}>
                  <div>{entry.mount}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{entry.filesystem}</div>
                </td>
                <td style={{ padding: "4px 6px" }}>{entry.used} / {entry.size}</td>
                <td style={{ padding: "4px 6px" }}>{entry.available}</td>
                <td style={{ padding: "4px 6px" }}>{entry.usePercent}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Block Devices</div>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "4px 6px" }}>Device</th>
            <th style={{ padding: "4px 6px" }}>Media / Transport</th>
            <th style={{ padding: "4px 6px" }}>Size</th>
            <th style={{ padding: "4px 6px" }}>Mounts</th>
          </tr>
        </thead>
        <tbody>
          {blockDevices.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ padding: "4px 6px", color: "var(--text-muted)" }}>
                {disk.blockDevices?.available === false ? disk.blockDevices.error || "Block device stats unavailable" : "No block devices available"}
              </td>
            </tr>
          ) : (
            blockDevices.map((entry) => (
              <tr key={entry.name} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "4px 6px" }}>
                  <div>{entry.name}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{entry.model}</div>
                </td>
                <td style={{ padding: "4px 6px" }}>{entry.media} · {entry.transport}</td>
                <td style={{ padding: "4px 6px" }}>{entry.size}</td>
                <td style={{ padding: "4px 6px" }}>{entry.visibleMounts}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Panel>
  );
}
