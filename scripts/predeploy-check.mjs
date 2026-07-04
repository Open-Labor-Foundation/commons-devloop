#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDeploymentReadiness,
  formatReadinessHuman,
  resolveReadinessProfiles
} from "./lib/deployment-readiness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function usage() {
  return `Usage: node scripts/predeploy-check.mjs [options]

Options:
  --profiles-file PATH       YAML file containing one or more readiness profiles.
  --profile NAME             Check one named profile from the profiles file. Repeatable.
  --config PATH              Repo config for the default qa profile.
  --target-path PATH         Host target repo path for the default qa profile.
  --state-dir PATH           State root for the default qa profile.
  --stack-id ID              Stack id for the default qa profile.
  --compose-project-name ID  Docker Compose project name for the default qa profile.
  --dashboard-port PORT      Dashboard port for the default qa profile.
  --inherit-env              Let the default qa profile inherit AE_* and COMPOSE_PROJECT_NAME.
  --json                     Emit JSON output.
  --format human|json        Output format. Defaults to human.
  --help                     Show this help text.
`;
}

export function parseArgs(argv) {
  const options = {
    format: "human",
    profilesFile: null,
    selectedProfiles: [],
    overrides: {}
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };

    switch (arg) {
      case "--profiles-file":
        options.profilesFile = next();
        break;
      case "--profile":
        options.selectedProfiles.push(next());
        break;
      case "--config":
        options.overrides.config = next();
        break;
      case "--target-path":
        options.overrides.target_path = next();
        break;
      case "--state-dir":
        options.overrides.state_dir = next();
        break;
      case "--stack-id":
        options.overrides.stack_id = next();
        break;
      case "--compose-project-name":
        options.overrides.compose_project_name = next();
        break;
      case "--dashboard-port":
        options.overrides.dashboard_port = next();
        break;
      case "--inherit-env":
        options.overrides.inherit_env = true;
        break;
      case "--json":
        options.format = "json";
        break;
      case "--format": {
        const format = next();
        if (!["human", "json"].includes(format)) {
          throw new Error(`Unsupported output format: ${format}`);
        }
        options.format = format;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function runPredeployCheck(argv = process.argv.slice(2), { repoRoot = REPO_ROOT, env = process.env } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    return {
      exitCode: 0,
      output: usage()
    };
  }

  const profiles = resolveReadinessProfiles({
    repoRoot,
    env,
    profilesFile: options.profilesFile,
    selectedProfiles: options.selectedProfiles,
    overrides: options.overrides
  });
  const result = checkDeploymentReadiness({ profiles, repoRoot, env });
  const output = options.format === "json"
    ? `${JSON.stringify(result, null, 2)}\n`
    : formatReadinessHuman(result);

  return {
    exitCode: result.ok ? 0 : 1,
    output
  };
}

function main() {
  try {
    const result = runPredeployCheck();
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write(usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
