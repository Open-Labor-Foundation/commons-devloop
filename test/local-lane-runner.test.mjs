import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "local-lane-runner.mjs");

function startOllamaStub({ models = [], responses = [], onPull = null }) {
  const requests = [];
  let chatIndex = 0;
  const server = http.createServer((req, res) => {
    const requestRecord = { method: req.method, url: req.url };
    requests.push(requestRecord);
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/pull") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestRecord.body = JSON.parse(body);
        onPull?.(requestRecord.body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "success" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestRecord.body = JSON.parse(body);
        const responseEntry = responses[Math.min(chatIndex, responses.length - 1)] ?? { done: true };
        chatIndex += 1;
        // __rawContent bypasses JSON.stringify so a test can simulate a model
        // emitting text that isn't valid JSON on the wire (e.g. an unescaped
        // backslash from a regex) -- something a real stringify call would
        // never produce, but real models do.
        const content = Object.prototype.hasOwnProperty.call(responseEntry, "__rawContent")
          ? responseEntry.__rawContent
          : JSON.stringify(responseEntry);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { content } }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        requests,
        baseUrl: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

function initGitRepo(worktree) {
  fs.mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init"], { cwd: worktree, stdio: "ignore" });
  fs.writeFileSync(path.join(worktree, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(worktree, "package.json"), "{\"scripts\":{\"test\":\"node --version\"}}\n");
  execFileSync("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: worktree,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });
}

async function runRunner({
  baseUrl,
  model = "qwen2.5-coder:7b",
  autoPull = false,
  prompt = "Implement issue #1",
  env = {},
  setupWorktree = null
}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-local-lane-runner-"));
  const worktree = path.join(tempDir, "worktree");
  const promptPath = path.join(tempDir, "prompt.md");
  initGitRepo(worktree);
  setupWorktree?.(worktree);
  fs.writeFileSync(promptPath, prompt);

  const result = await execFileAsync("node", [RUNNER], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AE_WORKTREE: worktree,
      AE_ISSUE_PROMPT_PATH: promptPath,
      AE_LANE_MODEL: model,
      AE_LOCAL_MODEL_PROVIDER: "ollama",
      AE_LOCAL_MODEL_ENDPOINT: `${baseUrl}/v1`,
      AE_LOCAL_MODEL_HEALTH_URL: `${baseUrl}/api/tags`,
      AE_LOCAL_MODEL_AUTO_PULL: autoPull ? "1" : "0",
      AE_LOCAL_CODER_CREATE_PR: "0",
      // Opt-in quality-gate/catalog config (see config.mjs, fix/repo-agnostic-engine):
      // the engine has no built-in notion of these; this test file's fixtures were
      // written against the repo's pre-genericization always-on defaults, so supply
      // the equivalent config here as the shared test baseline. Individual tests
      // override via `env` where they need something different.
      AE_AUTHORITY_RESEARCH_KEYWORDS: "authority,authoritative,source,research,owasp,cfr,nist,cisa",
      AE_AUTHORITY_RESEARCH_MIN_SOURCES: "6",
      AE_CATALOG_SOURCE_PATTERN_FILENAMES: "evaluation/research-summary.json,manifest.yaml",
      ...env
    }
  });

  return {
    ...result,
    worktree
  };
}

test("local lane runner writes changes through direct Ollama chat without Codex", async () => {
  const { server, baseUrl, requests } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        write_files: [
          { path: "answer.txt", content: "local model change\n" }
        ],
        done: true,
        summary: "created answer"
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.equal(fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"), "local model change\n");
    assert.ok(requests.some((request) => request.method === "POST" && request.url === "/api/chat"));
    assert.match(result.stdout, /Lane coder completed with changes/);
  } finally {
    server.close();
  }
});

test("local lane runner forwards configured Ollama thread count", async () => {
  const { server, baseUrl, requests } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        write_files: [
          { path: "threads.txt", content: "threaded\n" }
        ],
        done: true,
        summary: "created threaded file"
      }
    ]
  });

  try {
    await runRunner({
      baseUrl,
      env: {
        AE_LOCAL_CODER_NUM_THREAD: "24",
        AE_LOCAL_CODER_NUM_CTX: "32768",
        AE_LOCAL_CODER_KEEP_ALIVE: "2m"
      }
    });
    const chatRequest = requests.find((request) => request.method === "POST" && request.url === "/api/chat");
    assert.equal(chatRequest.body.format, "json");
    assert.equal(chatRequest.body.keep_alive, "2m");
    assert.equal(chatRequest.body.options.num_thread, 24);
    assert.equal(chatRequest.body.options.num_ctx, 32768);
  } finally {
    server.close();
  }
});

test("local lane runner fails clearly when Ollama model is missing", async () => {
  const { server, baseUrl } = await startOllamaStub({ models: [] });
  try {
    await assert.rejects(
      () => runRunner({ baseUrl }),
      /Local model 'qwen2\.5-coder:7b' is not loaded/
    );
  } finally {
    server.close();
  }
});

test("local lane runner can auto-pull a missing Ollama model", async () => {
  let pulled = null;
  const { server, baseUrl, requests } = await startOllamaStub({
    models: [],
    onPull: (body) => {
      pulled = body;
    },
    responses: [
      {
        write_files: [
          { path: "pulled.txt", content: "after pull\n" }
        ],
        done: true
      }
    ]
  });
  try {
    const result = await runRunner({ baseUrl, autoPull: true });
    assert.equal(pulled.name, "qwen2.5-coder:7b");
    assert.ok(requests.some((request) => request.method === "POST" && request.url === "/api/pull"));
    assert.equal(fs.readFileSync(path.join(result.worktree, "pulled.txt"), "utf8"), "after pull\n");
  } finally {
    server.close();
  }
});

test("local lane runner applies unified diffs from direct model output", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        unified_diff: `diff --git a/README.md b/README.md
index d48ffdf..f80535d 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # fixture
+patched by local model
`,
        done: true
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.match(fs.readFileSync(path.join(result.worktree, "README.md"), "utf8"), /patched by local model/);
  } finally {
    server.close();
  }
});

test("local lane runner recovers from a corrupt unified diff instead of crashing the run", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        // Missing "@@ ... @@" hunk header -- git apply rejects this as corrupt.
        unified_diff: `diff --git a/README.md b/README.md
index d48ffdf..f80535d 100644
--- a/README.md
+++ b/README.md
 # fixture
+patched by local model
`
      },
      {
        write_files: [
          { path: "recovered.txt", content: "written after the corrupt diff was rejected\n" }
        ],
        done: true
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.equal(
      fs.readFileSync(path.join(result.worktree, "recovered.txt"), "utf8"),
      "written after the corrupt diff was rejected\n"
    );
  } finally {
    server.close();
  }
});

test("local lane runner repairs an invalid backslash escape instead of crashing the run", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        // A literal "\|" from a grep-style regex is not a valid JSON escape
        // sequence -- JSON.parse rejects it outright ("Bad escaped character").
        __rawContent: '{"commands":["grep -i \'audit\\|liaison\' README.md"]}'
      },
      {
        write_files: [
          { path: "recovered.txt", content: "written after the invalid escape was repaired\n" }
        ],
        done: true
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.equal(
      fs.readFileSync(path.join(result.worktree, "recovered.txt"), "utf8"),
      "written after the invalid escape was repaired\n"
    );
  } finally {
    server.close();
  }
});

function createMockMarkdownlintCli2(binDir, { logPath }) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "markdownlint-cli2"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args[0] === "--version") {
  process.exit(0);
}
if (args[0] === "--fix") {
  for (const file of args.slice(1)) {
    fs.appendFileSync(file, "<!-- auto-fixed -->\\n");
  }
}
process.exit(0);
`,
    { mode: 0o755 }
  );
}

test("local lane runner auto-fixes every markdown file it writes with markdownlint-cli2", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-markdownlint-mock-"));
  const logPath = path.join(binDir, "invocations.log");
  createMockMarkdownlintCli2(binDir, { logPath });

  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        write_files: [
          { path: "notes.md", content: "# Heading\nSome text right after with no blank line.\n" }
        ],
        done: true
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` }
    });
    const content = fs.readFileSync(path.join(result.worktree, "notes.md"), "utf8");
    assert.match(content, /<!-- auto-fixed -->/);
    const invocations = fs.readFileSync(logPath, "utf8");
    assert.match(invocations, /--fix notes\.md/);
  } finally {
    server.close();
  }
});

function createMockGh(binDir) {
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://example.test/pr/1\\n");
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );
}

// Simulates `gh pr view <branch>` finding a PR that's CLOSED (not OPEN) for
// that head branch -- e.g. an earlier attempt's PR that was closed when its
// branch got deleted. Real `gh` with `--jq 'if .state == "OPEN" then .url
// else "" end'` would exit 0 with empty stdout in this case; this stub
// reproduces that exact shape so the fix under test (checking .state, not
// just whether a PR object exists at all) is exercised.
function createMockGhWithClosedPr(binDir) {
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write("\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://example.test/pr/2\\n");
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );
}

test("local lane runner's final PR sweep fixes a pre-existing markdown file the model never touched", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-markdownlint-mock-"));
  const logPath = path.join(binDir, "invocations.log");
  createMockMarkdownlintCli2(binDir, { logPath });
  createMockGh(binDir);

  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        write_files: [{ path: "unrelated.txt", content: "not markdown\n" }],
        done: true
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AE_LOCAL_CODER_CREATE_PR: "1",
        AE_ISSUE_NUMBER: "42",
        AE_BRANCH_NAME: "autonomous/42-test",
        AE_PR_BASE_BRANCH: "main"
      },
      setupWorktree: (worktree) => {
        const originDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-origin-"));
        execFileSync("git", ["init", "--bare", "--initial-branch=main", originDir], { stdio: "ignore" });
        execFileSync("git", ["remote", "add", "origin", originDir], { cwd: worktree, stdio: "ignore" });
        execFileSync("git", ["push", "origin", "HEAD:main"], { cwd: worktree, stdio: "ignore" });
        execFileSync("git", ["fetch", "origin"], { cwd: worktree, stdio: "ignore" });

        // Simulate content committed by an earlier, separate coder invocation
        // (before this run started) that the current model turn never
        // rewrites -- it should still get swept and fixed at finalize time.
        fs.writeFileSync(
          path.join(worktree, "pre-existing.md"),
          "# Heading\nNo blank line here either.\n"
        );
        execFileSync("git", ["add", "pre-existing.md"], { cwd: worktree, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "earlier run"], {
          cwd: worktree,
          stdio: "ignore",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com"
          }
        });
      }
    });

    const content = fs.readFileSync(path.join(result.worktree, "pre-existing.md"), "utf8");
    assert.match(content, /<!-- auto-fixed -->/);
    const invocations = fs.readFileSync(logPath, "utf8");
    assert.match(invocations, /--fix pre-existing\.md/);
  } finally {
    server.close();
  }
});

test("local lane runner opens a fresh PR when the only existing PR for this branch is closed", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-gh-closed-pr-mock-"));
  createMockGhWithClosedPr(binDir);

  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        write_files: [{ path: "answer.txt", content: "resolved again\n" }],
        done: true
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AE_LOCAL_CODER_CREATE_PR: "1",
        AE_ISSUE_NUMBER: "11",
        AE_BRANCH_NAME: "autonomous/11-test",
        AE_PR_BASE_BRANCH: "main"
      },
      setupWorktree: (worktree) => {
        const originDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-origin-"));
        execFileSync("git", ["init", "--bare", "--initial-branch=main", originDir], { stdio: "ignore" });
        execFileSync("git", ["remote", "add", "origin", originDir], { cwd: worktree, stdio: "ignore" });
        execFileSync("git", ["push", "origin", "HEAD:main"], { cwd: worktree, stdio: "ignore" });
        execFileSync("git", ["fetch", "origin"], { cwd: worktree, stdio: "ignore" });
      }
    });

    assert.match(result.stdout, /Lane coder PR created: https:\/\/example\.test\/pr\/2/);
    assert.doesNotMatch(result.stdout, /PR already exists/);
  } finally {
    server.close();
  }
});

test("local lane runner force-pushes its branch so an earlier attempt's unrelated push doesn't reject this one", async () => {
  // Reproduces the exact shape observed live: the dispatcher hands out a
  // brand-new worktree (rebuilt from main) on every attempt, but an earlier
  // attempt -- including one that never finished -- may have already pushed
  // something under this same branch name. A plain (non-force) push
  // non-fast-forwards in that case, silently discarding the run's work.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-gh-force-push-mock-"));
  createMockGh(binDir);

  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        write_files: [{ path: "answer.txt", content: "this attempt's content\n" }],
        done: true
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AE_LOCAL_CODER_CREATE_PR: "1",
        AE_ISSUE_NUMBER: "11",
        AE_BRANCH_NAME: "autonomous/11-test",
        AE_PR_BASE_BRANCH: "main"
      },
      setupWorktree: (worktree) => {
        const originDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-origin-"));
        execFileSync("git", ["init", "--bare", "--initial-branch=main", originDir], { stdio: "ignore" });
        execFileSync("git", ["remote", "add", "origin", originDir], { cwd: worktree, stdio: "ignore" });
        execFileSync("git", ["push", "origin", "HEAD:main"], { cwd: worktree, stdio: "ignore" });

        // Simulate an earlier, unrelated attempt's push under the same
        // branch name from a completely different worktree (no shared
        // history with this run's HEAD).
        const staleWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "ae-stale-attempt-"));
        execFileSync("git", ["clone", originDir, staleWorktree], { stdio: "ignore" });
        fs.writeFileSync(path.join(staleWorktree, "answer.txt"), "an earlier, abandoned attempt's content\n");
        execFileSync("git", ["add", "answer.txt"], { cwd: staleWorktree, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "earlier abandoned attempt"], {
          cwd: staleWorktree,
          stdio: "ignore",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com"
          }
        });
        execFileSync("git", ["push", "origin", "HEAD:autonomous/11-test"], { cwd: staleWorktree, stdio: "ignore" });

        execFileSync("git", ["fetch", "origin"], { cwd: worktree, stdio: "ignore" });
      }
    });

    assert.match(result.stdout, /Lane coder PR created:/);

    const pushed = execFileSync(
      "git",
      ["show", "origin/autonomous/11-test:answer.txt"],
      { cwd: result.worktree, encoding: "utf8" }
    );
    assert.equal(pushed, "this attempt's content\n");
  } finally {
    server.close();
  }
});

test("local lane runner recovers from a response that is unparseable even after every repair attempt", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        // Trailing garbage after a complete, valid JSON object -- none of
        // extractJsonObject's repair fallbacks (fenced-code stripping,
        // brace-slicing, control-character/backslash escaping) can fix
        // extra content after the object closes, so JSON.parse still throws.
        __rawContent: '{"commands":["echo hi"]}{"stray":"garbage"}'
      },
      {
        write_files: [
          { path: "recovered.txt", content: "written after the unparseable response was rejected\n" }
        ],
        done: true
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.equal(
      fs.readFileSync(path.join(result.worktree, "recovered.txt"), "utf8"),
      "written after the unparseable response was rejected\n"
    );
  } finally {
    server.close();
  }
});

test("local lane runner rejects placeholder write output before accepting a corrected write", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        write_files: [
          { path: "placeholder.txt", content: "See https://example.com/source for Scenario 1\n" }
        ],
        summary: "bad placeholder"
      },
      {
        write_files: [
          { path: "answer.txt", content: "specific implementation detail\n" }
        ],
        done: true,
        summary: "created concrete file"
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.ok(!fs.existsSync(path.join(result.worktree, "placeholder.txt")));
    assert.equal(fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"), "specific implementation detail\n");
    assert.match(result.stdout, /quality_gate/);
  } finally {
    server.close();
  }
});

test("local lane runner rejects repeated no-op actions", async () => {
  const repeatedRead = {
    read_files: ["README.md"],
    summary: "inspect readme"
  };
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      repeatedRead,
      repeatedRead,
      {
        write_files: [
          { path: "answer.txt", content: "new implementation\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.equal(fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"), "new implementation\n");
    assert.match(result.stdout, /repeat_action/);
  } finally {
    server.close();
  }
});

test("local lane runner compacts chat history before follow-up model calls", async () => {
  const { server, baseUrl, requests } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        read_files: ["README.md"],
        summary: "inspect readme"
      },
      {
        write_files: [
          { path: "answer.txt", content: "after compact context\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      env: {
        AE_LOCAL_CODER_CONTEXT_COMPACT_CHARS: "1"
      }
    });
    assert.equal(fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"), "after compact context\n");
    const chatRequests = requests.filter((request) => request.method === "POST" && request.url === "/api/chat");
    assert.equal(chatRequests.length, 2);
    assert.equal(chatRequests[1].body.messages.length, 2);
    const compactPayload = JSON.parse(chatRequests[1].body.messages[1].content);
    assert.equal(Object.hasOwn(compactPayload, "initial_context"), false);
    assert.equal(compactPayload.working_context.target_path, null);
    assert.equal(compactPayload.recent_observations[0].type, "read_file");
    assert.equal(compactPayload.recent_observations[0].path, "README.md");
    assert.match(result.stdout, /lane-coder context-compact/);
  } finally {
    server.close();
  }
});

test("local lane runner skips repeated failed commands", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["false"],
        summary: "bad command"
      },
      {
        commands: ["false"],
        write_files: [
          { path: "answer.txt", content: "after failed command\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.equal(fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"), "after failed command\n");
    assert.match(result.stdout, /command failed earlier in this run/);
  } finally {
    server.close();
  }
});

test("local lane runner stops after consecutive no-progress actions", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["false"],
        summary: "bad command"
      },
      {
        commands: ["false"],
        summary: "repeated bad command"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({
        baseUrl,
        env: {
          AE_LOCAL_CODER_MAX_NO_PROGRESS_TURNS: "2"
        }
      }),
      (error) => {
        assert.match(error.stdout, /lane-coder no-progress-stop/);
        assert.match(error.message, /Lane coder stopped after 2 consecutive no-progress turns/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner forces repo source pattern discovery after repeated authority failures", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["curl -sSL https://example.com/nope"],
        summary: "bad source"
      },
      {
        commands: ["curl -sSL https://ordinary-commercial.test/nope"],
        summary: "bad source two"
      },
      {
        commands: ["curl -sSL https://www.bls.gov/ooh/computer-and-information-technology/software-developers.htm"],
        summary: "guess another URL"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({
        baseUrl,
        prompt,
        setupWorktree: (worktree) => {
          const summaryPath = path.join(
            worktree,
            "agents/catalog/industry-overlays/information-software-and-digital-media/adjacent-agent/evaluation/research-summary.json"
          );
          fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
          fs.writeFileSync(summaryPath, JSON.stringify({ source_audit: [] }, null, 2));
          execFileSync("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
          execFileSync("git", ["commit", "-m", "add source pattern"], {
            cwd: worktree,
            stdio: "ignore",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Test",
              GIT_AUTHOR_EMAIL: "test@example.com",
              GIT_COMMITTER_NAME: "Test",
              GIT_COMMITTER_EMAIL: "test@example.com"
            }
          });
        }
      }),
      (error) => {
        assert.match(error.stdout, /source_strategy/);
        assert.match(error.stdout, /agents\/catalog\/industry-overlays\/information-software-and-digital-media\/adjacent-agent\/evaluation\/research-summary\.json/);
        assert.match(error.stdout, /read\/search repository source pattern files/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

// Regression test for a real incident: the source-pattern-discovery guardrail
// hardcoded the OLD "agents/catalog/industry-overlays" layout in its
// suggested search glob. labor-commons (and any repo configured with
// catalog.overlay_root: catalog/naics-overlays) never had that path, so the
// suggested search silently matched zero files, the anti-fabrication
// guardrail never actually grounded anything, and the coder fell back to
// generating authority sources -- and surrounding boundary/scope content --
// from training-data recall instead. That produced healthcare-flavored
// content under unrelated hospitality-and-travel and home-services slugs
// (labor-commons FINDING-03). This test pins the fix: for the naics-overlays
// layout, the suggested glob must be scoped to the record's own section, not
// the stale hardcoded literal.
test("local lane runner scopes source pattern discovery to the naics-overlays layout, not a stale hardcoded path", async () => {
  const prompt = `Implement issue #1

## Target Path
catalog/naics-overlays/hospitality-and-travel/guest-services-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["curl -sSL https://example.com/nope"],
        summary: "bad source"
      },
      {
        commands: ["curl -sSL https://ordinary-commercial.test/nope"],
        summary: "bad source two"
      },
      {
        commands: ["curl -sSL https://www.bls.gov/ooh/computer-and-information-technology/software-developers.htm"],
        summary: "guess another URL"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({
        baseUrl,
        prompt,
        env: { AE_CATALOG_OVERLAY_ROOT: "catalog/naics-overlays" },
        setupWorktree: (worktree) => {
          const summaryPath = path.join(
            worktree,
            "catalog/naics-overlays/hospitality-and-travel/hospitality-analytics-specialist/evaluation/research-summary.json"
          );
          fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
          fs.writeFileSync(summaryPath, JSON.stringify({ source_audit: [] }, null, 2));
          execFileSync("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
          execFileSync("git", ["commit", "-m", "add source pattern"], {
            cwd: worktree,
            stdio: "ignore",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Test",
              GIT_AUTHOR_EMAIL: "test@example.com",
              GIT_COMMITTER_NAME: "Test",
              GIT_COMMITTER_EMAIL: "test@example.com"
            }
          });
        }
      }),
      (error) => {
        assert.match(error.stdout, /source_strategy/);
        // The suggested glob must be scoped to the record's own section...
        assert.match(error.stdout, /catalog\/naics-overlays\/hospitality-and-travel\/\*\*\/evaluation\/research-summary\.json/);
        // ...and must never reference the stale, nonexistent layout.
        assert.doesNotMatch(error.stdout, /agents\/catalog\/industry-overlays/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

// Regression test for the deeper gap an independent review found in the
// glob-path fix above: labor-commons' catalog/README.md explicitly forbids
// research-summary.json/manifest.yaml ("those belong to a different, older
// format this repo does not use"), so collectSourcePatternFiles/
// collectAuthoritySourceCandidates always return empty for this repo's real
// catalog -- not due to a path bug, but because those files never exist here
// at all. The only real, already-vetted grounding data that exists is in
// sibling spec.yaml files' own authority_sources blocks. This pins that the
// coder is actually pointed at that real data, not just told (correctly, but
// unhelpfully) that no research-summary.json/manifest.yaml exists.
test("local lane runner grounds against sibling spec.yaml authority_sources when no research-summary.json/manifest.yaml exists", async () => {
  const prompt = `Implement issue #1

## Target Path
catalog/naics-overlays/hospitality-and-travel/guest-services-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl, requests } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        done: true,
        summary: "no changes"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({
        baseUrl,
        prompt,
        env: {
          AE_CATALOG_OVERLAY_ROOT: "catalog/naics-overlays",
          AE_CATALOG_SPEC_FILENAME: "spec.yaml",
          AE_CATALOG_FIRST_ENTRY_EXEMPLAR_KEY: "authority_sources"
        },
        setupWorktree: (worktree) => {
          const siblingSpecPath = path.join(
            worktree,
            "catalog/naics-overlays/hospitality-and-travel/reservations-specialist/spec.yaml"
          );
          fs.mkdirSync(path.dirname(siblingSpecPath), { recursive: true });
          fs.writeFileSync(
            siblingSpecPath,
            [
              "metadata:",
              "  slug: reservations-specialist",
              "knowledge_baseline:",
              "  authority_sources:",
              "  - source_id: ftc-advertising",
              "    title: FTC advertising and pricing guidance",
              "    location: https://www.ftc.gov/example-hospitality-guidance",
              ""
            ].join("\n")
          );
          // Deliberately no research-summary.json/manifest.yaml anywhere --
          // this repo's catalog/README.md forbids them.
          execFileSync("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
          execFileSync("git", ["commit", "-m", "add sibling spec"], {
            cwd: worktree,
            stdio: "ignore",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Test",
              GIT_AUTHOR_EMAIL: "test@example.com",
              GIT_COMMITTER_NAME: "Test",
              GIT_COMMITTER_EMAIL: "test@example.com"
            }
          });
        }
      })
    );
    const chatRequest = requests.find((request) => request.method === "POST" && request.url === "/api/chat");
    const startupUserMessage = chatRequest.body.messages.find((message) => message.role === "user");
    const startupPayload = JSON.parse(startupUserMessage.content);
    assert.deepEqual(startupPayload.initial_context.authority_source_candidates_from_repo_patterns, [
      {
        url: "https://www.ftc.gov/example-hospitality-guidance",
        source_file: "catalog/naics-overlays/hospitality-and-travel/reservations-specialist/spec.yaml"
      }
    ]);
    // Not the "no siblings exist, do not fabricate" fallback -- real sibling
    // data was found and should be what the coder is told to go read.
    assert.match(
      JSON.stringify(startupPayload.initial_context.required_first_steps),
      /catalog\/naics-overlays\/hospitality-and-travel\/reservations-specialist\/spec\.yaml/
    );
  } finally {
    server.close();
  }
});

// Pins the actual point of fix/repo-agnostic-engine: a repo with no
// quality_gates.authority_research config gets NO authority-research gate at
// all, even for an issue whose text would have tripped the old, always-on
// hardcoded regex (authority|authoritative|source|research|...). Every other
// test in this file supplies AE_AUTHORITY_RESEARCH_KEYWORDS via runRunner's
// shared baseline env specifically to keep exercising the gate -- this test
// explicitly clears it to prove the opt-in default is really off, not just
// that a configured repo still behaves like before.
test("local lane runner never gates on authority research when the repo has no quality_gates config", async () => {
  const prompt = `Implement issue #1

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        write_files: [
          { path: "answer.txt", content: "no research performed\n" }
        ],
        done: true,
        summary: "created answer without any authority-source research"
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      prompt,
      env: { AE_AUTHORITY_RESEARCH_KEYWORDS: "" }
    });
    assert.equal(
      fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"),
      "no research performed\n"
    );
    assert.match(result.stdout, /Lane coder completed with changes/);
  } finally {
    server.close();
  }
});

test("local lane runner rejects PDF-only source pattern mining", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: [
          "grep -Eo 'https?://[^ ]+\\.pdf' agents/catalog/industry-overlays/information-software-and-digital-media/adjacent-agent/evaluation/research-summary.json"
        ],
        summary: "mine pdf urls"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({
        baseUrl,
        prompt,
        env: {
          AE_LOCAL_CODER_MAX_NO_PROGRESS_TURNS: "1"
        },
        setupWorktree: (worktree) => {
          const summaryPath = path.join(
            worktree,
            "agents/catalog/industry-overlays/information-software-and-digital-media/adjacent-agent/evaluation/research-summary.json"
          );
          fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
          fs.writeFileSync(summaryPath, JSON.stringify({
            authority_sources: [
              { url: "https://www.nist.gov/source.pdf" }
            ]
          }, null, 2));
          execFileSync("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
          execFileSync("git", ["commit", "-m", "add pdf source pattern"], {
            cwd: worktree,
            stdio: "ignore",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Test",
              GIT_AUTHOR_EMAIL: "test@example.com",
              GIT_COMMITTER_NAME: "Test",
              GIT_COMMITTER_EMAIL: "test@example.com"
            }
          });
        }
      }),
      (error) => {
        assert.match(error.stdout, /must read structured source records, not mine PDF URLs/);
        assert.match(error.stdout, /lane-coder no-progress-stop/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner includes repo-derived authority source candidates", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl, requests } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        done: true,
        summary: "no changes"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({
        baseUrl,
        prompt,
        setupWorktree: (worktree) => {
          const summaryPath = path.join(
            worktree,
            "agents/catalog/industry-overlays/information-software-and-digital-media/adjacent-agent/evaluation/research-summary.json"
          );
          fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
          fs.writeFileSync(summaryPath, JSON.stringify({
            authority_sources: [
              { url: "https://www.nist.gov/example-source" },
              { url: "https://commercial.example/source" }
            ]
          }, null, 2));
          execFileSync("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
          execFileSync("git", ["commit", "-m", "add authority candidates"], {
            cwd: worktree,
            stdio: "ignore",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Test",
              GIT_AUTHOR_EMAIL: "test@example.com",
              GIT_COMMITTER_NAME: "Test",
              GIT_COMMITTER_EMAIL: "test@example.com"
            }
          });
        }
      })
    );
    const chatRequest = requests.find((request) => request.method === "POST" && request.url === "/api/chat");
    const startupUserMessage = chatRequest.body.messages.find((message) => message.role === "user");
    const startupPayload = JSON.parse(startupUserMessage.content);
    assert.deepEqual(startupPayload.initial_context.authority_source_candidates_from_repo_patterns, [
      {
        url: "https://www.nist.gov/example-source",
        source_file: "agents/catalog/industry-overlays/information-software-and-digital-media/adjacent-agent/evaluation/research-summary.json"
      }
    ]);
  } finally {
    server.close();
  }
});

test("local lane runner counts structured research-summary reads as authority evidence", async () => {
  const targetPath = "agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/";
  const prompt = `Implement issue #1

## Target Path
${targetPath}

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        read_files: [
          "agents/catalog/industry-overlays/information-software-and-digital-media/adjacent-agent/evaluation/research-summary.json"
        ],
        write_files: [
          { path: `${targetPath}manifest.yaml`, content: "agent_slug: software-business-operations-specialist\n" }
        ],
        summary: "read source records and wrote manifest"
      },
      {
        done: true,
        summary: "done"
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      prompt,
      setupWorktree: (worktree) => {
        const summaryPath = path.join(
          worktree,
          "agents/catalog/industry-overlays/information-software-and-digital-media/adjacent-agent/evaluation/research-summary.json"
        );
        fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
        fs.writeFileSync(summaryPath, JSON.stringify({
          authoritative_sources: [
            { url: "https://www.nist.gov/source-one", title: "One", publisher: "NIST", authority_rationale: "public authority" },
            { url: "https://csrc.nist.gov/source-two", title: "Two", publisher: "NIST CSRC", authority_rationale: "public authority" },
            { url: "https://www.cisa.gov/source-three", title: "Three", publisher: "CISA", authority_rationale: "public authority" },
            { url: "https://www.ecfr.gov/source-four", title: "Four", publisher: "eCFR", authority_rationale: "public authority" },
            { url: "https://www.w3.org/source-five", title: "Five", publisher: "W3C", authority_rationale: "open standard" },
            { url: "https://owasp.org/source-six", title: "Six", publisher: "OWASP", authority_rationale: "open framework" }
          ]
        }, null, 2));
        execFileSync("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "add structured authority evidence"], {
          cwd: worktree,
          stdio: "ignore",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com"
          }
        });
      }
    });
    assert.match(result.stdout, /"type": "write_file"/);
    assert.doesNotMatch(result.stdout, /authority-source research has not been performed/);
  } finally {
    server.close();
  }
});

test("local lane runner rejects direct PDF authority dumps before fetching", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["curl -sSL https://www.nist.gov/source.pdf"],
        summary: "raw pdf URL"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({
        baseUrl,
        prompt,
        env: {
          AE_LOCAL_CODER_MAX_NO_PROGRESS_TURNS: "1"
        }
      }),
      (error) => {
        assert.match(error.stdout, /PDF authority URLs must be converted into small text snippets/);
        assert.match(error.stdout, /lane-coder no-progress-stop/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner accepts command object entries", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: [
          { command: "printf 'from command object\\n' > command-object.txt" }
        ],
        summary: "created file from command object"
      },
      {
        done: true,
        summary: "command object file exists"
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.equal(fs.readFileSync(path.join(result.worktree, "command-object.txt"), "utf8"), "from command object\n");
  } finally {
    server.close();
  }
});

test("local lane runner extracts real body text from HTML command output instead of truncating it away as boilerplate", async () => {
  // Pads <head> past the old 1200-char raw-truncation point so a naive
  // "truncate then strip tags" pipeline would cut the response down to
  // boilerplate and never reach REAL_BODY_MARKER in <body>.
  const fetchCommand = "pad=$(printf '<!--pad-->%.0s' $(seq 1 150)); " +
    "printf '<!DOCTYPE html><html><head>%s<title>Test Standard</title></head>" +
    "<body><p>REAL_BODY_MARKER real standards content beyond the old truncation point.</p></body></html>' " +
    "\"$pad\" > page.html && curl -sSL \"file://$(pwd)/page.html\"";

  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: [fetchCommand],
        summary: "fetched page"
      },
      {
        write_files: [
          { path: "answer.txt", content: "done\n" }
        ],
        done: true,
        summary: "done"
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.match(result.stdout, /REAL_BODY_MARKER/);
    assert.match(result.stdout, /title: Test Standard/);
  } finally {
    server.close();
  }
});

test("local lane runner never falls back to raw markup when an HTML fetch has nothing extractable", async () => {
  // Reproduces a real live case: the model piped a fetch through `head -N`
  // itself, so only <head> meta tags (no <title>, no description, no body
  // text) ever reached our process. htmlToCleanText correctly extracts
  // nothing from that -- the bug was falling back to the raw markup instead
  // of accepting the (correctly) sparse result, re-exposing exactly the tag
  // soup this function exists to strip.
  const fetchCommand = "printf '<!DOCTYPE html><html><head>" +
    "<meta charset=\"utf-8\" /><meta name=\"robots\" content=\"index, follow\" />" +
    "<meta name=\"viewport\" content=\"width=device-width\" />' " +
    "> page.html && curl -sSL \"file://$(pwd)/page.html\"";

  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: [fetchCommand],
        summary: "fetched meta-only fragment"
      },
      {
        write_files: [
          { path: "answer.txt", content: "done\n" }
        ],
        done: true,
        summary: "done"
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    // Check the observation's own stdout field specifically -- the model's
    // *own* echoed command legitimately contains literal "<meta" text
    // elsewhere in the transcript, so asserting against the whole log would
    // false-fail. The compacted observation for this command must be empty
    // (correctly sparse), not the raw markup that command produced.
    const observationsBlock = result.stdout.split("[lane-coder observations]")[1].split("[lane-coder")[0];
    const observation = JSON.parse(observationsBlock.trim())[0];
    assert.equal(observation.type, "command");
    assert.equal(observation.stdout, "");
  } finally {
    server.close();
  }
});

test("local lane runner treats a grep-piped HTML fragment as HTML even when it doesn't start with <html>", async () => {
  // Mirrors what was observed live: the model pipes curl through its own
  // grep, and for a minified single-line page grep's "matching line" can be
  // nearly the whole document but start mid-markup (e.g. `</style></head>
  // <body...`), never matching a doc-start-only HTML check.
  const fetchCommand = "pad=$(printf '<!--pad-->%.0s' $(seq 1 150)); " +
    "printf '<!DOCTYPE html><html><head>%s<style>body{color:red}</style>" +
    "<title>Test Standard</title></head>" +
    "<body><p>REAL_BODY_MARKER real standards content beyond the old truncation point.</p></body></html>' " +
    "\"$pad\" > page.html && curl -sSL \"file://$(pwd)/page.html\" | grep -o '</style>.*'";

  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: [fetchCommand],
        summary: "fetched page via grep"
      },
      {
        write_files: [
          { path: "answer.txt", content: "done\n" }
        ],
        done: true,
        summary: "done"
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.match(result.stdout, /REAL_BODY_MARKER/);
    assert.match(result.stdout, /title: Test Standard/);
  } finally {
    server.close();
  }
});

test("local lane runner applies search globs without corrupting the query", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        searches: [
          { query: "fixture", glob: "*.md" }
        ],
        write_files: [
          { path: "answer.txt", content: "search complete\n" }
        ],
        done: true,
        summary: "searched markdown"
      }
    ]
  });

  try {
    const result = await runRunner({ baseUrl });
    assert.equal(fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"), "search complete\n");
    assert.match(result.stdout, /"query": "fixture"/);
    assert.doesNotMatch(result.stdout, /regex parse error/);
  } finally {
    server.close();
  }
});

test("local lane runner rejects no-op research commands on source-gated spec packs", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["echo researching"],
        write_files: [
          { path: "answer.txt", content: "after no-op research\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({ baseUrl, prompt }),
      (error) => {
        assert.match(error.stdout, /echo\/printf commands do not count as authority-source research/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner forces a write once the iteration budget runs low, waiving the authority-source minimum", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl, requests } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      { commands: ["true # filler 1"], summary: "iteration 1: no real research yet" },
      { commands: ["true # filler 2"], summary: "iteration 2: still no real research" },
      {
        write_files: [
          {
            path: "agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/answer.txt",
            content: "written under budget pressure\n"
          }
        ],
        done: true,
        summary: "forced write with no authority evidence gathered"
      }
    ]
  });

  try {
    // The run succeeds overall -- there is no repo-agnostic "required file
    // set" gate anymore (that guidance is entirely repo-dependent and lives
    // in the target repo's own .github/copilot-instructions.md, not this
    // engine). What's under test is that the *authority-source* complaint
    // specifically never appears, proving that gate got waived once the
    // budget ran low.
    await runRunner({
      baseUrl,
      prompt,
      env: {
        AE_LOCAL_CODER_MAX_ITERATIONS: "3",
        AE_LOCAL_CODER_FORCE_WRITE_ITERATIONS_REMAINING: "2"
      }
    });

    // With AE_LOCAL_CODER_MAX_ITERATIONS=3 and
    // AE_LOCAL_CODER_FORCE_WRITE_ITERATIONS_REMAINING=2, only 2 iterations
    // remain right after iteration 1 with nothing written yet -- budgetExhaustedWithNoWrite
    // fires immediately (not just a soft nudge waiting for the model to comply
    // on its own initiative), so the hard forced_final_write instruction is
    // already in the request sent for iteration 2.
    const secondTurnMessages = requests
      .filter((request) => request.body?.messages)
      .at(1).body.messages;
    const lastUserMessage = [...secondTurnMessages].reverse().find((message) => message.role === "user");
    assert.match(lastUserMessage.content, /"forced_final_write":true/);
    assert.match(lastUserMessage.content, /out of research turns and have written nothing/);
  } finally {
    server.close();
  }
});

test("local lane runner rejects empty curl research evidence", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["curl -s file:///dev/null"],
        summary: "empty research"
      },
      {
        write_files: [
          { path: "answer.txt", content: "after empty research\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({ baseUrl, prompt }),
      (error) => {
        assert.match(error.stdout, /research command returned no evidence/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner rejects headers-only authority research", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["curl -sSLI file://$(pwd)/README.md"],
        summary: "headers only"
      },
      {
        write_files: [
          { path: "answer.txt", content: "after headers-only research\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({ baseUrl, prompt }),
      (error) => {
        assert.match(error.stdout, /research command returned only headers\/status metadata/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner rejects raw binary authority research dumps", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["true > fake.pdf; printf '%s\\n' '%PDF-1.7' 'raw document bytes' > fake.pdf; curl -sSL file://$(pwd)/fake.pdf"],
        summary: "raw pdf"
      },
      {
        write_files: [
          { path: "answer.txt", content: "after raw pdf research\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({ baseUrl, prompt }),
      (error) => {
        assert.match(error.stdout, /raw binary\/document bytes/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner rejects ordinary commercial public authority URLs", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["curl -sSL https://commercial.invalid/source"],
        summary: "commercial public page"
      },
      {
        write_files: [
          { path: "answer.txt", content: "after commercial research\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({ baseUrl, prompt }),
      (error) => {
        assert.match(error.stdout, /does not target a government or open-access authority URL/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner rejects blocked authority pages", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["true > blocked.html; printf '%s\\n' 'Apologies; the page you are requesting is currently unavailable. The request resembles an abusive automated request.' > blocked.html; curl -sSL file://$(pwd)/blocked.html"],
        summary: "blocked source"
      },
      {
        write_files: [
          { path: "answer.txt", content: "after blocked source\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({ baseUrl, prompt }),
      (error) => {
        assert.match(error.stdout, /access-denied or unavailable page/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner rejects not found authority pages", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/

## Authority Sources
Use public authoritative source research.
`;
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        commands: ["true > missing.html; printf '%s\\n' '<title>Page not found</title>' '404' > missing.html; curl -sSL file://$(pwd)/missing.html"],
        summary: "missing source"
      },
      {
        write_files: [
          { path: "answer.txt", content: "after missing source\n" }
        ],
        done: true,
        summary: "created implementation"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({ baseUrl, prompt }),
      (error) => {
        assert.match(error.stdout, /access-denied or unavailable page/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("local lane runner uses repo guardrails instead of sibling example startup guidance", async () => {
  const prompt = `Implement issue #1

## Target Path
agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/
`;
  const { server, baseUrl, requests } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      {
        done: true,
        summary: "no changes yet"
      }
    ]
  });

  try {
    await assert.rejects(
      () => runRunner({ baseUrl, prompt }),
      (error) => {
        assert.match(error.stderr, /Lane coder stopped after 3 consecutive no-progress turns/);
        return true;
      }
    );
    const chatRequest = requests.find((request) => request.method === "POST" && request.url === "/api/chat");
    const startupUserMessage = chatRequest.body.messages.find((message) => message.role === "user");
    const startupPayload = JSON.parse(startupUserMessage.content);
    const startupText = JSON.stringify(startupPayload);
    // This prompt has no "Authority Sources" section, so no authority-research
    // first-steps guidance applies -- required_first_steps is empty. What
    // this repo-agnostic engine must never do is fabricate a required-files
    // list or instance-specific "sibling example" guidance for any repo.
    assert.deepEqual(startupPayload.initial_context.required_first_steps, []);
    assert.equal(Object.hasOwn(startupPayload.initial_context, "existing_example_artifact_files"), false);
    assert.equal(Object.hasOwn(startupPayload.initial_context, "candidate_authority_sources_from_existing_packs"), false);
    assert.doesNotMatch(startupText, /read (exactly )?one existing spec-pack/i);
    assert.doesNotMatch(startupText, /sibling examples/i);
  } finally {
    server.close();
  }
});

function startOpenAiCompatibleStub({ responses = [] }) {
  const requests = [];
  let index = 0;
  const server = http.createServer((req, res) => {
    const requestRecord = { method: req.method, url: req.url };
    requests.push(requestRecord);
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestRecord.body = JSON.parse(body);
        const entry = responses[Math.min(index, responses.length - 1)];
        index += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(entry));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        requests,
        baseUrl: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

// Regression test for a real gotcha hit deploying against Featherless's
// GLM-5.2: reasoning models split "thinking" into message.reasoning,
// separate from message.content. When the reasoning phase alone consumes
// the token budget, the API returns HTTP 200 with finish_reason: "length"
// and an EMPTY content string -- a truncated failure, not a valid empty
// response. A prior version returned that empty string as if the model had
// legitimately produced nothing; this pins that it's now treated as a
// retryable error instead, and that a subsequent successful response is
// used once the retry lands.
test("local lane runner retries a truncated reasoning-only response instead of treating empty content as valid", async () => {
  const { server, baseUrl, requests } = await startOpenAiCompatibleStub({
    responses: [
      {
        id: "truncated",
        object: "chat.completion",
        model: "zai-org/GLM-5.2",
        choices: [
          {
            index: 0,
            message: { role: "assistant", reasoning: "thinking about how best to respond to this issue...", content: "" },
            finish_reason: "length"
          }
        ]
      },
      {
        id: "recovered",
        object: "chat.completion",
        model: "zai-org/GLM-5.2",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                write_files: [{ path: "answer.txt", content: "recovered after retry\n" }],
                done: true,
                summary: "created answer after retry"
              })
            },
            finish_reason: "stop"
          }
        ]
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      env: {
        AE_LOCAL_MODEL_PROVIDER: "openai_compatible",
        AE_LOCAL_MODEL_ENDPOINT: `${baseUrl}/v1`,
        AE_LOCAL_CODER_CHAT_RETRY_BASE_MS: "10",
        AE_LOCAL_CODER_CHAT_RETRY_MAX_MS: "20"
      }
    });
    assert.equal(
      fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"),
      "recovered after retry\n"
    );
    assert.equal(requests.filter((r) => r.url === "/v1/chat/completions").length, 2);
  } finally {
    server.close();
  }
});

// Regression test for a real incident: GLM-5.2, stuck re-orienting instead
// of committing to a write, re-read the same 3-4 sibling files turn after
// turn for the full 20-iteration budget and produced nothing -- ten times in
// a row across dispatcher restarts, each one a real, paid API run. The root
// cause: observationShowsProgress counted every successful read_file as
// progress regardless of whether that exact path had already been read
// earlier in the run, so the no-progress-turn counter (which is what gates
// the forced-final-write escape hatch) never accumulated. This pins that a
// *repeated* read of an already-seen path does not reset the counter, so the
// forced write actually fires instead of silently burning the whole budget.
test("local lane runner treats a repeated read of an already-seen file as no progress", async () => {
  const { server, baseUrl, requests } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      { read_files: ["README.md"], summary: "iteration 1: first read, genuinely new" },
      { read_files: ["README.md"], summary: "iteration 2: re-reads the same file again" },
      { read_files: ["README.md"], summary: "iteration 3: re-reads the same file a third time" },
      {
        write_files: [{ path: "answer.txt", content: "written after the forced write kicked in\n" }],
        done: true,
        summary: "forced write after repeated no-progress re-reads"
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      env: {
        AE_LOCAL_CODER_MAX_NO_PROGRESS_TURNS: "2",
        AE_LOCAL_CODER_MAX_ITERATIONS: "10"
      }
    });
    assert.match(result.stdout, /lane-coder forced-final-write/);
    assert.equal(
      fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"),
      "written after the forced write kicked in\n"
    );
    // Confirms it forced on the 3rd iteration (2 repeated reads after the
    // first genuine one), not by exhausting all 10 available iterations.
    assert.equal(requests.filter((r) => r.method === "POST" && r.url === "/api/chat").length, 4);
  } finally {
    server.close();
  }
});

// Regression test for the exact production pattern that survived the first
// fix above: a run where EVERY turn mixes in at least one genuinely-new
// read alongside heavy repeats of the same file, so consecutiveNoProgressTurns
// never trips (each turn looks "productive" in isolation) -- yet the model
// still never converges on a write. This pins the independent, budget-based
// trigger (budgetExhaustedWithNoWrite): once the iteration budget is
// genuinely running low and nothing has been written, force a write
// regardless of whether recent turns individually looked productive.
test("local lane runner forces a write when every turn looks productive but nothing ever gets written", async () => {
  const { server, baseUrl } = await startOllamaStub({
    models: ["qwen2.5-coder:7b"],
    responses: [
      { read_files: ["README.md", "sibling-a.txt"], summary: "iteration 1: reads README + a new sibling" },
      { read_files: ["README.md", "sibling-b.txt"], summary: "iteration 2: re-reads README, reads a different new sibling" },
      { read_files: ["README.md", "sibling-c.txt"], summary: "iteration 3: same pattern, another new sibling" },
      {
        write_files: [{ path: "answer.txt", content: "written once the budget forced it\n" }],
        done: true,
        summary: "forced write"
      }
    ]
  });

  try {
    const result = await runRunner({
      baseUrl,
      env: {
        AE_LOCAL_CODER_MAX_ITERATIONS: "5",
        AE_LOCAL_CODER_FORCE_WRITE_ITERATIONS_REMAINING: "2"
      },
      setupWorktree: (worktree) => {
        fs.writeFileSync(path.join(worktree, "sibling-a.txt"), "a\n");
        fs.writeFileSync(path.join(worktree, "sibling-b.txt"), "b\n");
        fs.writeFileSync(path.join(worktree, "sibling-c.txt"), "c\n");
        execFileSync("git", ["add", "."], { cwd: worktree, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "add siblings"], {
          cwd: worktree,
          stdio: "ignore",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com"
          }
        });
      }
    });
    assert.match(result.stdout, /lane-coder forced-final-write/);
    assert.equal(
      fs.readFileSync(path.join(result.worktree, "answer.txt"), "utf8"),
      "written once the budget forced it\n"
    );
  } finally {
    server.close();
  }
});
