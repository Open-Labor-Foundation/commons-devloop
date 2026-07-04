import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "commons-devloop.release-manifest.v1";
const REQUIRED_OPTIONS = ["version", "imageTag", "configTemplate", "docsBundle"];

function printUsage() {
  process.stdout.write(`Usage: node scripts/release-manifest.mjs [options]

Required inputs can be supplied as flags or environment variables:
  --version VERSION              AE_RELEASE_VERSION
  --image-tag TAG                AE_IMAGE_TAG
  --config-template PATH         AE_CONFIG_TEMPLATE
  --docs-bundle PATH             AE_DOCS_BUNDLE

Options:
  --file PATH                    Add another release file to checksum when present.
  --build-metadata KEY=VALUE     Add build metadata. May be repeated.
  --build-id ID                  Add buildMetadata.buildId.
  --build-source SOURCE          Add buildMetadata.source.
  --out PATH                     Write manifest JSON to a file instead of stdout.
  --help                         Show this help text.

Environment:
  AE_RELEASE_FILES               Additional release files separated by "${path.delimiter}".
  AE_BUILD_METADATA              JSON object or comma-separated KEY=VALUE pairs.
  AE_BUILD_ID                    Add buildMetadata.buildId.
  AE_BUILD_SOURCE                Add buildMetadata.source.
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

function envList(value) {
  if (value == null || value.trim() === "") {
    return [];
  }
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseMetadataPair(pair) {
  const equalsIndex = pair.indexOf("=");
  if (equalsIndex <= 0) {
    throw new Error(`Invalid build metadata entry "${pair}". Use KEY=VALUE.`);
  }
  return [pair.slice(0, equalsIndex), pair.slice(equalsIndex + 1)];
}

function parseBuildMetadata(value) {
  if (value == null || value.trim() === "") {
    return {};
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (parsed == null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("AE_BUILD_METADATA must be a JSON object when JSON is used.");
    }
    return Object.fromEntries(
      Object.entries(parsed).map(([key, entryValue]) => [key, String(entryValue)])
    );
  }

  return Object.fromEntries(
    trimmed
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(parseMetadataPair)
  );
}

function sortedObject(input) {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value != null && value !== "")
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export function parseArgs(argv, env = process.env) {
  const options = {
    version: env.AE_RELEASE_VERSION ?? null,
    imageTag: env.AE_IMAGE_TAG ?? null,
    configTemplate: env.AE_CONFIG_TEMPLATE ?? null,
    docsBundle: env.AE_DOCS_BUNDLE ?? null,
    extraFiles: envList(env.AE_RELEASE_FILES),
    buildMetadata: {
      ...parseBuildMetadata(env.AE_BUILD_METADATA),
      ...(env.AE_BUILD_ID != null ? { buildId: env.AE_BUILD_ID } : {}),
      ...(env.AE_BUILD_SOURCE != null ? { source: env.AE_BUILD_SOURCE } : {})
    },
    out: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (flag) {
      case "--version": {
        const result = readOptionValue(argv, index, arg);
        options.version = result.value;
        index = result.nextIndex;
        break;
      }
      case "--image-tag": {
        const result = readOptionValue(argv, index, arg);
        options.imageTag = result.value;
        index = result.nextIndex;
        break;
      }
      case "--config-template": {
        const result = readOptionValue(argv, index, arg);
        options.configTemplate = result.value;
        index = result.nextIndex;
        break;
      }
      case "--docs-bundle": {
        const result = readOptionValue(argv, index, arg);
        options.docsBundle = result.value;
        index = result.nextIndex;
        break;
      }
      case "--file": {
        const result = readOptionValue(argv, index, arg);
        options.extraFiles.push(result.value);
        index = result.nextIndex;
        break;
      }
      case "--build-metadata": {
        const result = readOptionValue(argv, index, arg);
        const [key, value] = parseMetadataPair(result.value);
        options.buildMetadata[key] = value;
        index = result.nextIndex;
        break;
      }
      case "--build-id": {
        const result = readOptionValue(argv, index, arg);
        options.buildMetadata.buildId = result.value;
        index = result.nextIndex;
        break;
      }
      case "--build-source": {
        const result = readOptionValue(argv, index, arg);
        options.buildMetadata.source = result.value;
        index = result.nextIndex;
        break;
      }
      case "--out": {
        const result = readOptionValue(argv, index, arg);
        options.out = result.value;
        index = result.nextIndex;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.buildMetadata = sortedObject(options.buildMetadata);
  return options;
}

export function validateOptions(options) {
  const missing = REQUIRED_OPTIONS.filter((key) => {
    const value = options[key];
    return value == null || String(value).trim() === "";
  });

  if (missing.length > 0) {
    throw new Error(`Missing required inputs: ${missing.join(", ")}`);
  }
}

function checksumFile(filePath) {
  const hash = crypto.createHash("sha256");
  const content = fs.readFileSync(filePath);
  hash.update(content);
  return hash.digest("hex");
}

function toManifestPath(repoRoot, filePath) {
  const absolutePath = path.resolve(repoRoot, filePath);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (relativePath === "") {
    return ".";
  }
  return relativePath.split(path.sep).join("/");
}

function readFileRecord(repoRoot, role, filePath) {
  const manifestPath = toManifestPath(repoRoot, filePath);
  const absolutePath = path.resolve(repoRoot, filePath);

  if (!fs.existsSync(absolutePath)) {
    return {
      record: {
        role,
        path: manifestPath,
        present: false,
        sha256: null,
        sizeBytes: null
      },
      warning: `Selected release file is missing: ${manifestPath}`
    };
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    return {
      record: {
        role,
        path: manifestPath,
        present: false,
        sha256: null,
        sizeBytes: null
      },
      warning: `Selected release path is not a file: ${manifestPath}`
    };
  }

  return {
    record: {
      role,
      path: manifestPath,
      present: true,
      sha256: checksumFile(absolutePath),
      sizeBytes: stat.size
    },
    warning: null
  };
}

function selectedFiles(options, repoRoot) {
  const files = [
    {
      role: "configTemplate",
      path: options.configTemplate
    },
    {
      role: "docsBundle",
      path: options.docsBundle
    },
    ...options.extraFiles.map((filePath) => ({
      role: "releaseFile",
      path: filePath
    }))
  ];

  const seen = new Set();
  return files.filter((file) => {
    const key = path.resolve(repoRoot, file.path);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sortFileRecords(files) {
  const rolePriority = new Map([
    ["configTemplate", 0],
    ["docsBundle", 1],
    ["releaseFile", 2]
  ]);

  return [...files].sort((left, right) => {
    const leftPriority = rolePriority.get(left.role) ?? 99;
    const rightPriority = rolePriority.get(right.role) ?? 99;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.path.localeCompare(right.path);
  });
}

export function buildReleaseManifest(options) {
  validateOptions(options);

  const repoRoot = options.repoRoot ?? process.cwd();
  const warnings = [];
  const files = selectedFiles(options, repoRoot).map((file) => {
    const result = readFileRecord(repoRoot, file.role, file.path);
    if (result.warning != null) {
      warnings.push(result.warning);
    }
    return result.record;
  });

  if (options.git?.dirty === true) {
    warnings.push("Git working tree has uncommitted changes.");
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    version: String(options.version),
    imageTag: String(options.imageTag),
    buildMetadata: sortedObject(options.buildMetadata ?? {}),
    git: {
      commit: options.git?.commit ?? null,
      dirty: options.git?.dirty ?? null
    },
    files: sortFileRecords(files),
    warnings: warnings.sort()
  };
}

export function readGitInfo(repoRoot) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

  return {
    commit,
    dirty: status.length > 0
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }

    validateOptions(options);
    const manifest = buildReleaseManifest({
      ...options,
      repoRoot: process.cwd(),
      git: readGitInfo(process.cwd())
    });
    const output = `${JSON.stringify(manifest, null, 2)}\n`;

    if (options.out != null) {
      const outPath = path.resolve(process.cwd(), options.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, output);
      return;
    }

    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`release-manifest: ${error.message}\n`);
    process.stderr.write("Run with --help for usage.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
