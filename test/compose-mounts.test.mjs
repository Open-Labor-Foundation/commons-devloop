import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const composePath = path.resolve("compose.yaml");
const compose = YAML.parse(fs.readFileSync(composePath, "utf8"));

function getDockerSocketMount(serviceName) {
  return compose.services?.[serviceName]?.volumes?.find((mount) =>
    typeof mount === "string" && mount.startsWith("/var/run/docker.sock:")
  );
}

test("compose keeps Docker socket mounts to the minimum necessary services", () => {
  const socketMountedServices = Object.entries(compose.services).flatMap(([serviceName, service]) => {
    const hasSocketMount = Array.isArray(service.volumes) &&
      service.volumes.some((mount) =>
        typeof mount === "string" && mount.startsWith("/var/run/docker.sock:")
      );
    return hasSocketMount ? [serviceName] : [];
  });

  assert.deepEqual(socketMountedServices.sort(), ["dashboard", "runner-manager"].sort());

  assert.equal(
    getDockerSocketMount("runner-manager"),
    "/var/run/docker.sock:/var/run/docker.sock:rw",
    "runner-manager must mount docker socket with write access"
  );
  assert.equal(
    getDockerSocketMount("dashboard"),
    "/var/run/docker.sock:/var/run/docker.sock:ro",
    "dashboard must mount docker socket read-only"
  );
});
