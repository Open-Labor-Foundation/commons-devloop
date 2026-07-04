# Config Reference

Repo configs live under `config/repos/` and describe how `autonomous-engine`
operates against one target repository. Start from
[`config/repos/template.yaml`](../config/repos/template.yaml), compare against
[`config/repos/example.yaml`](../config/repos/example.yaml), and then keep the
repo-specific config on that repo's long-lived `repo/<target-repo>` branch.

Run this after every edit:

```bash
AE_REPO_CONFIG=/absolute/path/to/config/repos/<target-repo>.yaml npm run validate:config
```

The schema summary is [`config/repo.schema.yaml`](../config/repo.schema.yaml).
This page explains the same contract in operator terms.

## Required Sections

These sections must be present for the runtime to load and safely operate a
repo config:

- `repo`: identifies the target repo and where it is mounted.
- `lifecycle`: defines what work is in scope and when the repo should pause.
- `issue_source`: filters which GitHub issues the dispatcher may take.
- `validation`: supplies the local commands that must pass for a PR.
- `safety`: sets the branch, path, merge, force-push, and clean-worktree guardrails.

The runtime also accepts defaults for many optional fields. Customer configs
should still keep `models` explicit so lane choice, reasoning effort, and budget
thresholds are visible without reading source code.

## Optional Sections

These sections can be omitted when their defaults are acceptable:

- `dispatcher`: polling, lane worker counts, and skipped issue numbers.
- `models`: dispatcher primary and secondary lane models plus reviewer model.
- `reviewer`: local review polling, concurrency, post mode, and instructions path.
- `runner_manager`: self-hosted GitHub runner container settings.
- `pr_manager`: local merge watcher polling and concurrency.
- `monitor`: service health polling.
- `budgets`: daily spend cap and pause reason text.
- `branches`: work branch prefix and PR base branch.
- `roles`: committed service opt-outs for the standard stack.
- `dashboard`: browser dashboard port and data exposure controls.
- `retention`: local state, run log, and output retention windows.

Omitting an optional section does not disable its service. Most standard services
are default-on unless a config opts out explicitly.

## `repo`

Required fields:

- `key`: stable local identifier used in state paths, runner labels, and logs.
- `github_slug`: target repository as `owner/repo`.
- `default_branch`: target repo default branch, usually `main`.

Optional fields:

- `workspace_dir`: where the target repo is mounted inside engine containers.
  Defaults to `AE_WORKSPACE_DIR` or `/workspace/target-repo`.

Use a short, lowercase `key` that is safe in file paths and container names.

## `lifecycle`

Required operator decisions:

- `enabled`: set `true` for normal operation. Set `false` to disable repo work.
- `target_mode`: how work is selected. Current configs use modes such as
  `milestone`, `label`, `backlog_file`, or `open`, depending on the branch's
  operating convention.
- `target_name`: milestone name, label name, backlog path, or descriptive target.
- `pause_when_target_complete`: pause when the selected target is exhausted.
- `pause_when_budget_exhausted`: pause when configured budget limits are reached.
- `max_parallel_prs`: maximum PRs this repo should have in active engine work.
- `max_runs_per_day`: daily run limiter for the repo lifecycle.

Keep `max_parallel_prs` aligned with the repo's review and validation capacity,
not just the host's CPU capacity.

## `issue_source`

Use this section to control which GitHub issues the dispatcher can claim:

- `labels`: all listed labels must be present on a target issue. Use an empty
  list only when every otherwise eligible issue is in scope.
- `required_issue_prefix`: optional title prefix gate.
- `allow_manual_issue_numbers`: optional list of issue numbers the operator may
  allow even when normal filters would not pick them.

This section is a safety boundary. Tight filters are preferred for customer
repos until the operator has watched a few full local-service runs.

## `dispatcher`

The dispatcher is default-on. It selects eligible issues and starts work in the
configured model lanes.

- `enabled`: optional service opt-out. Omit it for normal default-on operation.
- `poll_interval_seconds`: dispatcher polling interval. Minimum is 5 seconds.
- `primary_max_workers`: concurrent primary-lane workers.
- `secondary_max_workers`: concurrent secondary-lane workers.
- `skip_issue_numbers`: issue numbers the dispatcher must ignore.

Primary and secondary lanes are scheduling lanes, not a hardware validation
claim. The host must have enough CPU, memory, disk, Docker capacity, network
access, GitHub auth, and Codex auth for the number of workers you allow. Start
with one active worker, then raise counts after observing local validation,
review, and worktree behavior on that repo.

## `models`

`models.dispatcher.lanes` is an arbitrary-length list — add, remove, or mix as
many lanes as you want, each fully self-describing its own inference source.
This is the recommended format; see
[`config/repos/template.yaml`](../config/repos/template.yaml) for a complete
example. Each lane entry:

- `key`: stable lane identifier (e.g. `primary`, `featherless`, `local`).
- `label`: operator-facing lane label.
- `provider`: one of:
  - `hosted_codex` — OpenAI's Codex CLI. Requires Codex/ChatGPT auth in the
    `codex-home` volume.
  - `openai_compatible` — any OpenAI-compatible hosted or self-hosted API.
    Requires `runtime_endpoint` (the base URL, e.g.
    `https://api.featherless.ai/v1`) and, usually, `api_key_env` (the name of
    an env var to read a key from). This is where Featherless.ai fits — it's
    just an OpenAI-compatible endpoint, not a special case.
  - `local_container` — a local model runtime (Ollama or LM Studio) that the
    engine manages the lifecycle of. Requires `runtime_service`,
    `runtime_endpoint`, and `local_provider: ollama | lmstudio`.
- `name`: the model identifier that lane's provider expects.
- `reasoning_effort`: operator-selected reasoning effort label.
- `max_workers`: concurrent workers for that lane. `0` disables it without
  removing the entry.
- `enabled`: optional; defaults to `true`.
- `provider_concurrency_budget_units` / `request_cost_units` (`openai_compatible`
  only): some providers — Featherless.ai included — have no daily/weekly usage
  window at all, only a concurrency ceiling, expressed as a plan-wide unit
  budget divided by a per-model unit cost (e.g. a 4-unit plan running a
  2-unit-per-request model supports 2 concurrent requests). Set both to have
  the dashboard show the derived concurrency limit next to `max_workers`; both
  default to `0` (no derived limit shown) and are ignored for providers that
  do have a real usage window.

**API key resolution for `openai_compatible` lanes**: a key entered through
the dashboard's settings UI (persisted to `state/repos/<repo-key>/secrets.json`
— gitignored runtime state, never the tracked config) always takes priority
over `api_key_env`. If neither is set, that lane has no key and calls to it
will fail — set at least one before enabling the lane.

Inference choice is entirely up to you — `hosted_codex`, a self-hosted
`local_container`, or an `openai_compatible` endpoint like Featherless.ai are
all first-class options, not a tiered set of alternatives.

**Legacy format**: `models.dispatcher.primary` / `.secondary` / `.local` (plus
top-level `dispatcher.primary_max_workers` / `.secondary_max_workers` /
`.local_max_workers`) remain fully supported and are normalized into the same
lane list internally — you don't need to migrate an existing config, but new
configs should use `lanes`.

Use `models.reviewer` for the local review service:

- `name`: model name used for review.
- `reasoning_effort`: operator-selected reasoning effort label.

Set a lane's worker count to `0` when that lane should not run.

## `validation`

The validator is default-on and `commands` must contain at least one command.
Commands run in order from a local worktree.

- `enabled`: optional service opt-out. Omit it for normal default-on operation.
- `context`: commit status context when status posting is enabled.
- `bootstrap_commands`: optional setup commands run before validation commands.
- `commands`: required list of local validation gates.
- `working_directory`: optional path relative to the worktree.
- `poll_interval_seconds`: validator polling interval. Minimum is 5 seconds.
- `max_concurrent`: concurrent validation jobs.
- `post_status`: whether to post GitHub commit statuses.

Use the same commands a human operator would trust before merge. If
`post_status` is `false`, validation can remain Docker-local and still gate the
local merge watcher.

## `reviewer`

The reviewer is default-on and runs Codex-backed local PR review.

- `enabled`: optional service opt-out. Omit it for normal default-on operation.
- `poll_interval_seconds`: reviewer polling interval. Minimum is 15 seconds.
- `max_concurrent`: concurrent review jobs.
- `post_mode`: `none`, `comment`, or `review`.
- `instructions_path`: optional absolute path to review instructions. When
  omitted, the runtime looks for `.github/copilot-instructions.md` in the target
  repo workspace.

Use `comment` when you want lightweight PR feedback, `review` when GitHub review
state should be part of the gate, and `none` when review should stay local.

## `runner_manager`

The runner manager is default-on, but it only needs to be useful when the target
repo still runs GitHub Actions jobs on self-hosted runners.

- `enabled`: optional service opt-out. Set `false` when no self-hosted runner
  management is needed.
- `scope`: `repo` or `org`.
- `required_labels`: labels workflows require.
- `runner_labels`: labels registered runners should receive.
- `runner_group`: optional runner group.
- `image_name`: runner container image.
- `container_prefix`: prefix for runner containers.
- `max_runners`: maximum runner containers.
- `poll_interval_seconds`: polling interval. Minimum is 5 seconds.
- `launch_cooldown_seconds`: minimum delay between launches. Minimum is 10 seconds.
- `network`: optional Docker network.
- `mount_docker_socket`: mount Docker socket into runner containers.
- `mount_workspace`: mount the target workspace into runner containers.
- `dry_run`: observe without launching runner containers.

The default local-service path validates and reviews PRs inside engine
containers. Use runner-manager only for workflows that must still execute as
GitHub Actions jobs.

## `pr_manager`

The PR manager is default-on. It watches local validation and review gates and
can merge through GitHub when policy allows it.

- `enabled`: optional service opt-out. Omit it for normal default-on operation.
- `interval_seconds`: polling interval. Minimum is 5 seconds.
- `merge_concurrency`: concurrent merge attempts.
- `update_branch_concurrency`: concurrent update-branch attempts. Defaults to
  the larger of `merge_concurrency` and `lifecycle.max_parallel_prs`.
- `auto_merge_label`: optional label required before local auto-merge.

`safety.auto_merge` must also be `true` before automatic merge behavior is
allowed.

## `monitor`

The monitor is default-on and records service health.

- `enabled`: optional service opt-out. Omit it for normal default-on operation.
- `poll_interval_seconds`: polling interval. Minimum is 5 seconds.

## `safety`

Safety settings are operator guardrails:

- `pr_only`: when `true`, work must flow through PRs instead of direct branch
  changes.
- `auto_merge`: when `true`, the local merge watcher may merge after configured
  gates pass. Keep `false` for human-controlled merges.
- `protected_branches`: branches the engine must treat as protected.
- `protected_paths`: glob-like paths the engine should not change.
- `allow_force_push`: keep `false` unless the repo intentionally permits force
  pushes for engine work.
- `require_clean_worktree_before_run`: when `true`, workers must start from a
  clean worktree.

Recommended customer defaults are `pr_only: true`, `auto_merge: false`,
`allow_force_push: false`, and `require_clean_worktree_before_run: true`.

## `budgets`

Budget settings control when lifecycle should pause for spend management:

- `max_estimated_credits_per_day`: optional daily credit cap. Omit or set to
  `null` when the repo should not pause on this limit.
- `pause_reason_on_budget`: operator-facing reason recorded when the budget cap
  pauses the repo. Defaults to `budget exhausted`.

Use budget values as operating guardrails. They do not replace external billing
or quota controls.

## `branches`

Branch settings describe how target-repo PR branches are created and where PRs
target:

- `work_branch_prefix`: prefix for work branches. Defaults to `autonomous/`.
- `pr_base_branch`: base branch for PRs. Defaults to `repo.default_branch`.

On repo-focused engine branches, `pr_base_branch` should match the branch that
the target repo expects autonomous PRs to merge into.

## Default-On Services And Opt-Outs

Repo-focused branches start the full standard stack by default:

- `autonomous`
- `dispatcher`
- `validator`
- `reviewer`
- `runner-manager`
- `pr-manager`
- `monitor`
- `dashboard`

Do not add positive `enabled: true` flags just to restate the default. Commit an
opt-out only when the repo intentionally disables part of the stack.

You can opt out in either place:

```yaml
reviewer:
  enabled: false
```

```yaml
roles:
  enabled:
    reviewer: false
```

Use role-specific `enabled: false` when the service's own section is already
being edited. Use `roles.enabled.<role>: false` when you want all service
opt-outs collected in one place. The role names are `autonomous`, `dispatcher`,
`validator`, `reviewer`, `runner-manager`, `pr-manager`, `monitor`, and
`dashboard`.

## `dashboard`

The dashboard is default-on and provides browser visibility and operator
controls.

- `enabled`: optional service opt-out. Omit it for normal default-on operation.
- `port`: dashboard port. Defaults to `AE_DASHBOARD_PORT` or `4700`.
- `expose_issue_details`: include issue details in dashboard responses.
- `expose_pr_links`: include PR links in dashboard responses.

Set the port per repo branch when multiple engine stacks run on the same Docker
host.

## `retention`

Retention settings keep local state bounded:

- `enabled`: turn retention cleanup on or off.
- `worktree_max_age_hours`: maximum retained worktree age.
- `run_log_max_age_days`: maximum retained run log age.
- `output_max_age_days`: maximum retained output age.

These settings apply to engine-local artifacts under `state/repos/<repo-key>/`.

## Example Repo Configs

Use these checked-in configs as references:

- [`config/repos/template.yaml`](../config/repos/template.yaml): starting point
  for a new target repo.
- [`config/repos/example.yaml`](../config/repos/example.yaml): fully populated
  example with explicit service flags.
- [`config/repos/commons-devloop.yaml`](../config/repos/commons-devloop.yaml):
  current config for this repo-focused branch (commons-devloop dogfooding itself).
- [`config/repos/olf-agents.yaml`](../config/repos/olf-agents.yaml): config for
  another target repo with a different lane and dashboard port.

After editing any config, run `npm run validate:config` with `AE_REPO_CONFIG`
pointing at the edited file.

## Deployment Readiness Profiles

Before building or launching a stack, run the lightweight deployment readiness
gate:

```bash
npm run predeploy:check -- \
  --config config/repos/<target-repo>.yaml \
  --target-path /absolute/path/to/target-repo
```

The default profile is named `qa`. It validates the repo config, derives the
stack id, checks the Compose project name, validates the dashboard port, confirms
the target repo path exists, and verifies the standard service set remains
default-on. It does not start Docker containers.

For release records, emit JSON:

```bash
npm run predeploy:check -- --json
```

Optional variant profiles can live in `config/deployment-readiness.yaml` when a
branch has more than one planned deployment profile:

```yaml
profiles:
  qa:
    config: config/repos/commons-devloop.yaml
    target_path: /srv/repos/commons-devloop
    stack_id: commons-devloop-qa
    compose_project_name: commons-devloop-qa
    dashboard_port: 4700
  staging:
    config: config/repos/commons-devloop.yaml
    target_path: /srv/repos/commons-devloop
    stack_id: commons-devloop-staging
    compose_project_name: commons-devloop-staging
    dashboard_port: 4701
```

When multiple profiles are checked, duplicate stack ids, Compose project names,
or dashboard ports fail the gate. Keep the profile list focused on deployment
readiness; it is not intended to model a broad experimentation or QA platform.
