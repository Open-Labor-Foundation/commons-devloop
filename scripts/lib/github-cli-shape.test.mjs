import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

let previousPath;
let tempDir;
let callsPath;

beforeEach(() => {
  previousPath = process.env.PATH;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-gh-cli-"));
  callsPath = path.join(tempDir, "calls.jsonl");
  const ghPath = path.join(tempDir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AE_GH_CALLS_PATH, JSON.stringify(args) + "\\n");
if (args[0] === "pr" && args[1] === "list" && args.includes("open")) {
  process.stdout.write(JSON.stringify([
    {
      number: 2,
      title: "Second",
      headRefName: "autonomous/2-second",
      headRefOid: "bbb",
      baseRefName: "main",
      url: "https://example.test/pull/2",
      labels: [],
      isDraft: false,
      mergeStateStatus: "CLEAN",
      headRepository: { name: "repo" },
      headRepositoryOwner: { login: "owner" },
      isCrossRepository: false,
      maintainerCanModify: true
    },
    {
      number: 1,
      title: "First",
      headRefName: "autonomous/1-first",
      headRefOid: "aaa",
      baseRefName: "main",
      url: "https://example.test/pull/1",
      labels: [],
      isDraft: false,
      mergeStateStatus: "CLEAN",
      headRepository: "repo",
      headRepositoryOwner: "owner",
      isCrossRepository: false,
      maintainerCanModify: true
    }
  ]));
} else if (args[0] === "pr" && args[1] === "list" && args.includes("merged")) {
  process.stdout.write(JSON.stringify([
    { number: 9, title: "Merged", mergedAt: "2026-04-25T00:00:00Z", url: "https://example.test/pull/9" }
  ]));
} else if (args[0] === "pr" && args[1] === "merge") {
  process.stdout.write("merged");
} else {
  process.stderr.write("unexpected gh args: " + JSON.stringify(args));
  process.exit(2);
}
`,
    { mode: 0o755 }
  );
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath}`;
  process.env.AE_GH_CALLS_PATH = callsPath;
});

afterEach(() => {
  process.env.PATH = previousPath;
  delete process.env.AE_GH_CALLS_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function readCalls() {
  return fs.readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const config = {
  repo: {
    github_slug: "owner/repo"
  }
};

test("listOpenPullRequests uses gh pr list instead of REST pull pagination", async () => {
  const { listOpenPullRequests } = await import("./github.mjs");

  const prs = listOpenPullRequests(config, { limit: 10, retryCount: 1 });

  assert.deepEqual(prs.map((pr) => pr.number), [1, 2]);
  assert.deepEqual(readCalls(), [[
    "pr",
    "list",
    "--repo",
    "owner/repo",
    "--state",
    "open",
    "--limit",
    "10",
    "--json",
    "number,title,headRefName,headRefOid,baseRefName,url,labels,isDraft,mergeStateStatus,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify"
  ]]);
});

test("getMergedPullRequests uses gh pr list merged", async () => {
  const { getMergedPullRequests } = await import("./github.mjs");

  const prs = getMergedPullRequests(config, 5, { retryCount: 1 });

  assert.equal(prs[0].number, 9);
  assert.deepEqual(readCalls(), [[
    "pr",
    "list",
    "--repo",
    "owner/repo",
    "--state",
    "merged",
    "--limit",
    "5",
    "--json",
    "number,title,mergedAt,url"
  ]]);
});

test("mergePullRequest uses gh pr merge with branch deletion", async () => {
  const { mergePullRequest } = await import("./github.mjs");

  assert.equal(mergePullRequest(config, 7), "merged");
  assert.deepEqual(readCalls(), [[
    "pr",
    "merge",
    "7",
    "--repo",
    "owner/repo",
    "--squash",
    "--delete-branch"
  ]]);
});
