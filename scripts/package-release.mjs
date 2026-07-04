import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_PACKAGE_DIR_NAME = "releases";
const DEFAULT_MANIFEST_PATH = path.join("dist", "release-manifest.json");
const CHECKSUM_FILE = "SHA256SUMS.txt";

const DEFAULT_PACKAGED_FILES = [
  "compose.yaml",
  ".env.example",
  "config/predeploy.matrix.yaml",
  "config/repo.schema.yaml",
  "config/repos/template.yaml",
  "config/repos/example.yaml",
  "docs/install.md",
  "docs/operator-guide.md",
  "docs/release-notes-template.md",
  "docs/release-process.md"
];

const EXCLUDED_PATH_SEGMENTS = new Set([
  ".env",
  ".env.local",
  ".env.remote",
  ".codex",
  ".ae-deploy-manifest.json",
  "node_modules",
  "state",
  "target",
  "auth",
  "repo-state.json",
  ".git"
]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".yaml",
  ".yml",
  ".json",
  ".example",
  ".env"
]);

function printUsage() {
  process.stdout.write(`Usage: node scripts/package-release.mjs [options]

Required inputs:
  --version VERSION            AE_RELEASE_VERSION

Options:
  --out-dir PATH               Release output directory.
                               Defaults to dist/releases/<version>.
  --release-manifest PATH       Include a release manifest file in the package.
  --help                       Show this help text.
`);
}

function readOptionValue(argv, index, arg) {
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex !== -1) {
    return {
      value: arg.slice(equalsIndex + 1),
      nextIndex: index
    };
  }

  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return {
    value,
    nextIndex: index + 1
  };
}

export function parseArgs(argv, env = process.env) {
  const options = {
    version: env.AE_RELEASE_VERSION ?? null,
    outDir: env.AE_RELEASE_DIR ?? null,
    releaseManifestPath: env.AE_RELEASE_MANIFEST ?? null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (flag === "--version") {
      const value = readOptionValue(argv, index, arg);
      options.version = value.value;
      index = value.nextIndex;
      continue;
    }

    if (flag === "--out-dir") {
      const value = readOptionValue(argv, index, arg);
      options.outDir = value.value;
      index = value.nextIndex;
      continue;
    }

    if (flag === "--release-manifest") {
      const value = readOptionValue(argv, index, arg);
      options.releaseManifestPath = value.value;
      index = value.nextIndex;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function validateOptions(options) {
  const missing = [];
  if (options.version == null || String(options.version).trim() === "") {
    missing.push("version");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required inputs: ${missing.join(", ")}`);
  }
}

function isPathExcluded(filePath) {
  return filePath
    .split(path.sep)
    .some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment));
}

function resolveOutputDir(options, repoRoot) {
  const version = String(options.version);
  if (options.outDir != null && String(options.outDir).trim() !== "") {
    return path.resolve(repoRoot, options.outDir);
  }
  return path.resolve(repoRoot, "dist", DEFAULT_PACKAGE_DIR_NAME, version);
}

function defaultManifestPath(repoRoot) {
  return path.resolve(repoRoot, DEFAULT_MANIFEST_PATH);
}

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function fileChecksum(filePath) {
  const hash = crypto.createHash("sha256");
  const content = fs.readFileSync(filePath);
  hash.update(content);
  return hash.digest("hex");
}

function isTextArtifact(filePath) {
  const extension = path.extname(filePath);
  if (TEXT_EXTENSIONS.has(extension)) {
    return true;
  }
  return filePath === ".env.example" || filePath === CHECKSUM_FILE;
}

export function collectPackageFiles(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const files = [];
  for (const source of DEFAULT_PACKAGED_FILES) {
    const sourcePath = path.resolve(repoRoot, source);
    if (isPathExcluded(source)) {
      continue;
    }
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`Required release file is missing: ${source}`);
    }
    files.push({
      sourcePath,
      targetPath: normalizeRelativePath(source)
    });
  }

  const manifestCandidates = [
    options.releaseManifestPath,
    options.releaseManifestPath == null ? defaultManifestPath(repoRoot) : null
  ].filter(Boolean);

  for (const candidate of manifestCandidates) {
    const candidatePath = path.resolve(repoRoot, candidate);
    if (!fs.existsSync(candidatePath)) {
      continue;
    }
    if (!fs.statSync(candidatePath).isFile()) {
      continue;
    }
    files.push({
      sourcePath: candidatePath,
      targetPath: "release-manifest.json"
    });
    break;
  }

  const seen = new Set();
  return files.filter((entry) => {
    const key = entry.targetPath;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function buildReleasePackage(options) {
  validateOptions(options);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const packageRoot = resolveOutputDir(options, repoRoot);
  const files = collectPackageFiles({ ...options, repoRoot });

  if (fs.existsSync(packageRoot)) {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(packageRoot, { recursive: true });

  for (const file of files) {
    const outPath = path.join(packageRoot, file.targetPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(file.sourcePath, outPath);
  }

  const checksumEntries = files
    .filter((entry) => isTextArtifact(entry.targetPath))
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath))
    .map((entry) => `${fileChecksum(entry.sourcePath)}  ${entry.targetPath}`);

  const checksumPath = path.join(packageRoot, CHECKSUM_FILE);
  fs.writeFileSync(checksumPath, `${checksumEntries.join("\n")}\n`);

  return {
    packageDir: packageRoot,
    files: files.map((entry) => entry.targetPath),
    checksumFile: checksumPath
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }
    const result = buildReleasePackage({
      ...options,
      repoRoot: process.cwd()
    });
    process.stdout.write(`Release package created: ${path.relative(process.cwd(), result.packageDir)}\n`);
    process.stdout.write(`Text checksum file: ${path.relative(process.cwd(), result.checksumFile)}\n`);
  } catch (error) {
    process.stderr.write(`package-release: ${error.message}\n`);
    process.stderr.write("Run with --help for usage.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
