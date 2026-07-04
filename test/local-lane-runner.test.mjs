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
      }),
      (error) => {
        assert.match(error.stdout, /"type": "write_file"/);
        assert.doesNotMatch(error.stdout, /authority-source research has not been performed/);
        assert.match(error.stderr, /Lane coder quality gate failed/);
        return true;
      }
    );
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
    assert.deepEqual(startupPayload.initial_context.required_first_steps, [
      "Search repository research-summary.json and manifest.yaml files for structured source records before broad URL guessing.",
      "Prefer non-PDF authority pages first; PDF sources are acceptable only when converted to small text snippets, never dumped as raw bytes.",
      "Write the required package files only under agents/catalog/industry-overlays/information-software-and-digital-media/software-business-operations-specialist/."
    ]);
    assert.equal(Object.hasOwn(startupPayload.initial_context, "existing_example_artifact_files"), false);
    assert.equal(Object.hasOwn(startupPayload.initial_context, "candidate_authority_sources_from_existing_packs"), false);
    assert.doesNotMatch(startupText, /read (exactly )?one existing spec-pack/i);
    assert.doesNotMatch(startupText, /sibling examples/i);
  } finally {
    server.close();
  }
});
