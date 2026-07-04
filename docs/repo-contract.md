# Repo Contract

Every target repository must provide a YAML config that satisfies `config/repo.schema.yaml`.

## Required Inputs

- `repo.key`
- `repo.github_slug`
- `repo.default_branch`
- `lifecycle.*`
- `issue_source.*`
- `models.dispatcher.*`
- `models.reviewer.*`
- `validation.commands`
- `safety.*`

## Required Decisions Per Repo

- what defines the active target
- which models are used by dispatcher primary, secondary, and optional local lanes
- which model the local reviewer uses
- what validation gates are mandatory
- whether commit status posting is enabled
- whether PR review posting is enabled
- which standard services, if any, are intentionally opted out in committed repo config
- what runner labels and image names apply if runner-manager is used
- what branches and paths are protected
- whether PR-only mode is mandatory
- how many concurrent PRs the repo can safely tolerate

## Supported Target Modes

- `milestone`
- `label`
- `backlog_file`

`milestone` and `label` are implemented for GitHub-backed completion checks. `backlog_file` can be added by repo-specific backlog conventions without changing the base runtime.

## Recommended Defaults

- `pr_only: true`
- `auto_merge: false`
- `require_clean_worktree_before_run: true`
- `pause_when_target_complete: true`
- `pause_when_budget_exhausted: true`
- full standard stack enabled by default: `autonomous`, `dispatcher`, `validator`, `reviewer`, `runner-manager`, `pr-manager`, `monitor`, `dashboard`
- repo configs omit positive role flags and rely on the default-on stack
- explicit opt-outs live in committed repo config only, via `enabled: false` or `roles.enabled.<role>: false`
- repo-focused branches should start the same default-on stack with `docker compose up -d` unless committed config disables a role
- local validator enabled
- local reviewer enabled

## Validation Commands

These should be the same commands a human operator would trust before opening or merging a PR.

Examples:

- `npm test`
- `npm run build`
- `npm run verify:v1`
- `pytest`
- `cargo test`
- `go test ./...`

## Local-Service Expectations

The target repo should tolerate:

- the full standard local-service stack starting by default on the repo-focused branch
- detached worktrees under the engine state directory
- local validation from those worktrees
- local Codex review from those worktrees
- GitHub status/comment/review updates driven from the local engine instead of GitHub-hosted automation
