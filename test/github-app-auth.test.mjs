import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  ensureGithubAppAuth,
  githubAppAuthConfigured,
  resetGithubAppAuthCacheForTests
} from "../scripts/lib/github-app-auth.mjs";

function tempPrivateKeyPath() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-github-app-auth-"));
  const filePath = path.join(dir, "app.private-key.pem");
  fs.writeFileSync(filePath, privateKey.export({ type: "pkcs1", format: "pem" }));
  return filePath;
}

function fakeFetch(responses) {
  let call = 0;
  return async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return response;
  };
}

test("githubAppAuthConfigured requires all three env vars", () => {
  assert.equal(githubAppAuthConfigured({}), false);
  assert.equal(githubAppAuthConfigured({ GITHUB_APP_ID: "1" }), false);
  assert.equal(
    githubAppAuthConfigured({ GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY_PATH: "/x" }),
    true
  );
});

test("ensureGithubAppAuth is a no-op when app auth isn't configured", async () => {
  const env = { GH_TOKEN: "existing-pat" };
  const configured = await ensureGithubAppAuth(env, { fetchImpl: fakeFetch([]) });
  assert.equal(configured, false);
  assert.equal(env.GH_TOKEN, "existing-pat");
});

test("ensureGithubAppAuth mints an installation token and sets GH_TOKEN/GITHUB_TOKEN", async () => {
  resetGithubAppAuthCacheForTests();
  const env = {
    GITHUB_APP_ID: "4213165",
    GITHUB_APP_INSTALLATION_ID: "144308655",
    GITHUB_APP_PRIVATE_KEY_PATH: tempPrivateKeyPath()
  };
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const fetchImpl = fakeFetch([
    { ok: true, json: async () => ({ token: "ghs_minted-token", expires_at: expiresAt }) }
  ]);

  const configured = await ensureGithubAppAuth(env, { fetchImpl });
  assert.equal(configured, true);
  assert.equal(env.GH_TOKEN, "ghs_minted-token");
  assert.equal(env.GITHUB_TOKEN, "ghs_minted-token");
});

test("ensureGithubAppAuth reuses a cached token instead of re-minting when far from expiry", async () => {
  resetGithubAppAuthCacheForTests();
  const env = {
    GITHUB_APP_ID: "4213165",
    GITHUB_APP_INSTALLATION_ID: "144308655",
    GITHUB_APP_PRIVATE_KEY_PATH: tempPrivateKeyPath()
  };
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ token: `ghs_token-${calls}`, expires_at: expiresAt }) };
  };

  await ensureGithubAppAuth(env, { fetchImpl });
  await ensureGithubAppAuth(env, { fetchImpl });

  assert.equal(calls, 1);
  assert.equal(env.GH_TOKEN, "ghs_token-1");
});

test("ensureGithubAppAuth re-mints once the cached token is close to expiry", async () => {
  resetGithubAppAuthCacheForTests();
  const env = {
    GITHUB_APP_ID: "4213165",
    GITHUB_APP_INSTALLATION_ID: "144308655",
    GITHUB_APP_PRIVATE_KEY_PATH: tempPrivateKeyPath()
  };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const expiresAt = calls === 1
      ? new Date(Date.now() + 60 * 1000).toISOString()
      : new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return { ok: true, json: async () => ({ token: `ghs_token-${calls}`, expires_at: expiresAt }) };
  };

  await ensureGithubAppAuth(env, { fetchImpl });
  assert.equal(env.GH_TOKEN, "ghs_token-1");

  await ensureGithubAppAuth(env, { fetchImpl });
  assert.equal(calls, 2);
  assert.equal(env.GH_TOKEN, "ghs_token-2");
});

test("ensureGithubAppAuth throws with the response body when GitHub rejects the token request", async () => {
  resetGithubAppAuthCacheForTests();
  const env = {
    GITHUB_APP_ID: "4213165",
    GITHUB_APP_INSTALLATION_ID: "144308655",
    GITHUB_APP_PRIVATE_KEY_PATH: tempPrivateKeyPath()
  };
  const fetchImpl = fakeFetch([
    { ok: false, status: 404, text: async () => "Not Found" }
  ]);

  await assert.rejects(
    () => ensureGithubAppAuth(env, { fetchImpl }),
    /Failed to mint GitHub App installation token \(404\): Not Found/
  );
});
