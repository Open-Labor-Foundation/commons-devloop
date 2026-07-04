import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLaneApiKey, setLaneApiKey, laneApiKeyStatus } from "../scripts/lib/secrets.mjs";

function tempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ae-secrets-"));
}

test("resolveLaneApiKey returns empty string when neither stored value nor env var is set", () => {
  const stateDir = tempStateDir();
  const key = resolveLaneApiKey(stateDir, "test-repo", { key: "featherless", api_key_env: "FEATHERLESS_API_KEY" });
  assert.equal(key, "");
});

test("resolveLaneApiKey falls back to the env var named by api_key_env", () => {
  const stateDir = tempStateDir();
  process.env.AE_TEST_SECRETS_ENV_VAR = "env-value-123";
  try {
    const key = resolveLaneApiKey(stateDir, "test-repo", { key: "featherless", api_key_env: "AE_TEST_SECRETS_ENV_VAR" });
    assert.equal(key, "env-value-123");
  } finally {
    delete process.env.AE_TEST_SECRETS_ENV_VAR;
  }
});

test("setLaneApiKey persists a stored value that takes priority over the env var", () => {
  const stateDir = tempStateDir();
  process.env.AE_TEST_SECRETS_ENV_VAR = "env-value-123";
  try {
    setLaneApiKey(stateDir, "test-repo", "featherless", "stored-value-456");
    const key = resolveLaneApiKey(stateDir, "test-repo", { key: "featherless", api_key_env: "AE_TEST_SECRETS_ENV_VAR" });
    assert.equal(key, "stored-value-456");

    const filePath = path.join(stateDir, "repos", "test-repo", "secrets.json");
    assert.ok(fs.existsSync(filePath));
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    delete process.env.AE_TEST_SECRETS_ENV_VAR;
  }
});

test("setLaneApiKey with an empty value clears a previously stored key", () => {
  const stateDir = tempStateDir();
  setLaneApiKey(stateDir, "test-repo", "featherless", "stored-value-456");
  setLaneApiKey(stateDir, "test-repo", "featherless", "");
  const key = resolveLaneApiKey(stateDir, "test-repo", { key: "featherless", api_key_env: "" });
  assert.equal(key, "");
});

test("laneApiKeyStatus reports configured/source without ever returning key material", () => {
  const stateDir = tempStateDir();
  setLaneApiKey(stateDir, "test-repo", "featherless", "stored-value-456");
  process.env.AE_TEST_SECRETS_ENV_VAR = "env-value-123";
  try {
    const lanes = [
      { key: "featherless", api_key_env: "AE_TEST_SECRETS_ENV_VAR" },
      { key: "env-only", api_key_env: "AE_TEST_SECRETS_ENV_VAR" },
      { key: "unset", api_key_env: "" }
    ];
    const status = laneApiKeyStatus(stateDir, "test-repo", lanes);
    assert.deepEqual(status.featherless, { configured: true, source: "stored" });
    assert.deepEqual(status["env-only"], { configured: true, source: "env" });
    assert.deepEqual(status.unset, { configured: false, source: "none" });
    assert.equal(JSON.stringify(status).includes("stored-value-456"), false);
    assert.equal(JSON.stringify(status).includes("env-value-123"), false);
  } finally {
    delete process.env.AE_TEST_SECRETS_ENV_VAR;
  }
});
