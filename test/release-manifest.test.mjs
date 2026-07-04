import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  buildReleaseManifest,
  parseArgs,
  validateOptions
} from "../scripts/release-manifest.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_SCRIPT = path.join(REPO_ROOT, "scripts", "release-manifest.mjs");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

test("buildReleaseManifest records release inputs and fixture file checksums", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-manifest-"));
  const configContent = "repo:\n  key: fixture\n";
  const docsContent = "operator docs bundle\n";
  const noteContent = "release notes\n";

  writeFile(path.join(tempRoot, "config", "release-template.yaml"), configContent);
  writeFile(path.join(tempRoot, "dist", "operator-docs.txt"), docsContent);
  writeFile(path.join(tempRoot, "dist", "release-notes.txt"), noteContent);

  const manifest = buildReleaseManifest({
    repoRoot: tempRoot,
    version: "1.2.3",
    imageTag: "ghcr.io/example/autonomous-engine:1.2.3",
    configTemplate: "config/release-template.yaml",
    docsBundle: "dist/operator-docs.txt",
    extraFiles: ["dist/release-notes.txt", "dist/missing.tar.gz"],
    buildMetadata: {
      source: "ci",
      buildId: "build-123"
    },
    git: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      dirty: false
    }
  });

  assert.deepEqual(manifest, {
    schemaVersion: "commons-devloop.release-manifest.v1",
    version: "1.2.3",
    imageTag: "ghcr.io/example/autonomous-engine:1.2.3",
    buildMetadata: {
      buildId: "build-123",
      source: "ci"
    },
    git: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      dirty: false
    },
    files: [
      {
        role: "configTemplate",
        path: "config/release-template.yaml",
        present: true,
        sha256: sha256(configContent),
        sizeBytes: Buffer.byteLength(configContent)
      },
      {
        role: "docsBundle",
        path: "dist/operator-docs.txt",
        present: true,
        sha256: sha256(docsContent),
        sizeBytes: Buffer.byteLength(docsContent)
      },
      {
        role: "releaseFile",
        path: "dist/missing.tar.gz",
        present: false,
        sha256: null,
        sizeBytes: null
      },
      {
        role: "releaseFile",
        path: "dist/release-notes.txt",
        present: true,
        sha256: sha256(noteContent),
        sizeBytes: Buffer.byteLength(noteContent)
      }
    ],
    warnings: [
      "Selected release file is missing: dist/missing.tar.gz"
    ]
  });
});

test("parseArgs accepts required inputs from env and build metadata from flags", () => {
  const options = parseArgs([
    "--build-metadata",
    "pipeline=release",
    "--build-id=build-456",
    "--file",
    "dist/image-digest.txt"
  ], {
    AE_RELEASE_VERSION: "2.0.0",
    AE_IMAGE_TAG: "ghcr.io/example/autonomous-engine:2.0.0",
    AE_CONFIG_TEMPLATE: "config/template.yaml",
    AE_DOCS_BUNDLE: "docs/operator-guide.md",
    AE_BUILD_METADATA: "{\"source\":\"manual\"}",
    AE_RELEASE_FILES: `dist/sbom.json${path.delimiter}dist/provenance.json`
  });

  assert.equal(options.version, "2.0.0");
  assert.equal(options.imageTag, "ghcr.io/example/autonomous-engine:2.0.0");
  assert.equal(options.configTemplate, "config/template.yaml");
  assert.equal(options.docsBundle, "docs/operator-guide.md");
  assert.deepEqual(options.extraFiles, [
    "dist/sbom.json",
    "dist/provenance.json",
    "dist/image-digest.txt"
  ]);
  assert.deepEqual(options.buildMetadata, {
    buildId: "build-456",
    pipeline: "release",
    source: "manual"
  });
});

test("validateOptions rejects missing required inputs", () => {
  assert.throws(
    () => validateOptions({
      version: "1.0.0",
      imageTag: "",
      configTemplate: "config/template.yaml",
      docsBundle: null
    }),
    /Missing required inputs: imageTag, docsBundle/
  );
});

test("release manifest CLI exits nonzero on missing required inputs", () => {
  const result = spawnSync(process.execPath, [MANIFEST_SCRIPT, "--version", "1.0.0"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required inputs: imageTag, configTemplate, docsBundle/);
});
