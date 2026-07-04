import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  collectPackageFiles,
  parseArgs,
  buildReleasePackage
} from "../scripts/package-release.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_SCRIPT = path.join(REPO_ROOT, "scripts", "package-release.mjs");

function copyArtifact(sourceRoot, relativePath, targetRoot) {
  const sourcePath = path.join(REPO_ROOT, relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("parseArgs reads release version and optional manifest from env", () => {
  const options = parseArgs([], {
    AE_RELEASE_VERSION: "9.9.9",
    AE_RELEASE_MANIFEST: "dist/release-manifest.json"
  });
  assert.equal(options.version, "9.9.9");
  assert.equal(options.releaseManifestPath, "dist/release-manifest.json");
});

test("collectPackageFiles errors when required artifacts are missing", () => {
  assert.throws(
    () => collectPackageFiles({
      repoRoot: "/tmp/does-not-exist"
    }),
    /Required release file is missing/
  );
});

test("buildReleasePackage creates a deterministic package and excludes sensitive/runtime paths", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "package-release-"));
  const repoRoot = path.join(workspace, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });

  copyArtifact(repoRoot, "compose.yaml", repoRoot);
  copyArtifact(repoRoot, ".env.example", repoRoot);
  copyArtifact(repoRoot, "config/predeploy.matrix.yaml", repoRoot);
  copyArtifact(repoRoot, "config/repo.schema.yaml", repoRoot);
  copyArtifact(repoRoot, "config/repos/template.yaml", repoRoot);
  copyArtifact(repoRoot, "config/repos/example.yaml", repoRoot);
  copyArtifact(repoRoot, "docs/install.md", repoRoot);
  copyArtifact(repoRoot, "docs/operator-guide.md", repoRoot);
  copyArtifact(repoRoot, "docs/release-notes-template.md", repoRoot);
  copyArtifact(repoRoot, "docs/release-process.md", repoRoot);

  writeFile(path.join(repoRoot, "dist", "release-manifest.json"), "{}\n");
  writeFile(path.join(repoRoot, ".env"), "SECRET=1\n");
  writeFile(path.join(repoRoot, ".codex", "credentials.json"), "{}\n");
  fs.mkdirSync(path.join(repoRoot, "state"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "target"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "auth"), { recursive: true });

  const result = buildReleasePackage({
    repoRoot,
    version: "1.2.3"
  });

  assert.equal(result.packageDir, path.join(repoRoot, "dist", "releases", "1.2.3"));
  assert.equal(result.files.includes("compose.yaml"), true);
  assert.equal(result.files.includes("release-manifest.json"), true);

  assert.ok(fs.existsSync(path.join(result.packageDir, "compose.yaml")));
  assert.ok(fs.existsSync(path.join(result.packageDir, "docs", "operator-guide.md")));
  assert.ok(fs.existsSync(path.join(result.packageDir, "release-manifest.json")));
  assert.ok(fs.existsSync(path.join(result.packageDir, "SHA256SUMS.txt")));

  const checksums = fs.readFileSync(path.join(result.packageDir, "SHA256SUMS.txt"), "utf8");
  assert.match(checksums, /compose.yaml/);
  assert.equal(fs.existsSync(path.join(result.packageDir, "state")), false);
  assert.equal(fs.existsSync(path.join(result.packageDir, ".env")), false);
  assert.equal(fs.existsSync(path.join(result.packageDir, ".codex")), false);
  assert.equal(fs.existsSync(path.join(result.packageDir, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(result.packageDir, "target")), false);
  assert.equal(fs.existsSync(path.join(result.packageDir, "auth")), false);
});

test("CLI creates deterministic package path from AE_RELEASE_VERSION", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "package-release-cli-"));
  const repoRoot = path.join(workspace, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });

  copyArtifact(repoRoot, "compose.yaml", repoRoot);
  copyArtifact(repoRoot, ".env.example", repoRoot);
  copyArtifact(repoRoot, "config/predeploy.matrix.yaml", repoRoot);
  copyArtifact(repoRoot, "config/repo.schema.yaml", repoRoot);
  copyArtifact(repoRoot, "config/repos/template.yaml", repoRoot);
  copyArtifact(repoRoot, "config/repos/example.yaml", repoRoot);
  copyArtifact(repoRoot, "docs/install.md", repoRoot);
  copyArtifact(repoRoot, "docs/operator-guide.md", repoRoot);
  copyArtifact(repoRoot, "docs/release-notes-template.md", repoRoot);
  copyArtifact(repoRoot, "docs/release-process.md", repoRoot);
  writeFile(path.join(repoRoot, "dist", "release-manifest.json"), "{}\n");

  const result = spawnSync(process.execPath, [PACKAGE_SCRIPT], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AE_RELEASE_VERSION: "2.0.0",
      AE_RELEASE_MANIFEST: path.join("dist", "release-manifest.json")
    }
  });

  assert.equal(result.status, 0, result.stderr ?? result.stdout);
  assert.ok(fs.existsSync(path.join(repoRoot, "dist", "releases", "2.0.0", "compose.yaml")));
  assert.ok(fs.existsSync(path.join(repoRoot, "dist", "releases", "2.0.0", "release-manifest.json")));
});
