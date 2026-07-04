import { resolveConfigPath, loadConfig } from "./lib/config.mjs";
import { log } from "./lib/logger.mjs";

try {
  const config = loadConfig(resolveConfigPath());
  log("info", "config validated", {
    repoKey: config.repo.key,
    githubSlug: config.repo.github_slug,
    targetMode: config.lifecycle.target_mode,
    targetName: config.lifecycle.target_name
  });
} catch (error) {
  log("error", "config validation failed", { error: error.message });
  process.exitCode = 1;
}
