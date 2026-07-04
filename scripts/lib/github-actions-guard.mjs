import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"]);
const AUTO_TRIGGER_EVENTS = new Set(["push", "pull_request"]);

function workflowFiles(workspaceDir) {
  const workflowsDir = path.join(workspaceDir, ".github", "workflows");
  if (!fs.existsSync(workflowsDir)) {
    return [];
  }

  return fs.readdirSync(workflowsDir)
    .filter((entry) => WORKFLOW_EXTENSIONS.has(path.extname(entry)))
    .map((entry) => path.join(workflowsDir, entry));
}

function autoTriggerEvents(onValue) {
  if (typeof onValue === "string") {
    return AUTO_TRIGGER_EVENTS.has(onValue) ? [onValue] : [];
  }

  if (Array.isArray(onValue)) {
    return onValue
      .map((entry) => String(entry))
      .filter((entry) => AUTO_TRIGGER_EVENTS.has(entry));
  }

  if (onValue && typeof onValue === "object") {
    return Object.keys(onValue).filter((entry) => AUTO_TRIGGER_EVENTS.has(entry));
  }

  return [];
}

export function findAutoTriggeredGithubActions(workspaceDir) {
  const findings = [];
  for (const filePath of workflowFiles(workspaceDir)) {
    let parsed;
    try {
      parsed = YAML.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      findings.push({
        path: filePath,
        events: ["unparseable"],
        error: error.message
      });
      continue;
    }

    const events = autoTriggerEvents(parsed?.on);
    if (events.length > 0) {
      findings.push({ path: filePath, events });
    }
  }
  return findings;
}

export function assertNoAutoTriggeredGithubActions(config) {
  if (!config.safety?.disallow_github_actions_auto_triggers) {
    return;
  }

  const findings = findAutoTriggeredGithubActions(config.repo.workspace_dir);
  if (findings.length === 0) {
    return;
  }

  const detail = findings
    .map((finding) => `${path.relative(config.repo.workspace_dir, finding.path)}: ${finding.events.join(", ")}`)
    .join("; ");
  throw new Error(`GitHub Actions auto-trigger guard failed: ${detail}`);
}
