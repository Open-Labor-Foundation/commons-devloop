# Local-Service Default Codex Backlog

This backlog breaks [local-service-default-implementation-spec.md](./local-service-default-implementation-spec.md) into Codex-sized implementation issues.

Each issue is intended to be:

- one bounded PR
- one clear ownership area
- one verification path
- safe to process independently once dependencies are satisfied

## Execution Order

1. branch and deployment isolation
2. default service bring-up
3. local PR queue and local gate correctness
4. failure state and retry visibility
5. remediation routing
6. end-to-end acceptance hardening

## Codex-Sized Issues

Tracker: `#1` Local-service default implementation tracker

### 1. `#2` Branch-scoped stack identity and state root isolation

Scope:

- derive Docker Compose project name from target repo branch/config
- isolate state root, logs, worktrees, and outputs per repo-focused branch
- ensure two repo-focused branches do not share stack names or state paths

Primary files:

- `compose.yaml`
- `scripts/control.mjs`
- `scripts/lib/state.mjs`
- `docs/network-docker-host-onboarding.md`

Done means:

- two repo-focused branches can run without container/state collisions

Verification:

- `docker compose config`
- branch A/B deployment smoke check

Dependencies:

- none

### 2. `#3` Deterministic branch-to-host deployment flow

Scope:

- add a deployment script or documented command path that syncs exact branch contents to the host
- verify remote revision matches local branch revision
- fail closed when host checkout or env drift is detected

Primary files:

- `scripts/`
- `docs/network-docker-host-onboarding.md`
- `docs/target-repo-onboarding.md`

Done means:

- redeploying a branch produces a host runtime that matches committed branch contents

Verification:

- remote revision check
- forced redeploy on an intentionally drifted host checkout

Dependencies:

- issue 1

### 3. `#4` Full local-service stack enabled by default

Scope:

- make `autonomous`, `dispatcher`, `validator`, `reviewer`, `runner-manager`, `pr-manager`, `monitor`, and `dashboard` default-on
- keep explicit opt-outs repo-config-driven only
- align onboarding docs and config schema with this default

Primary files:

- `compose.yaml`
- `config/repo.schema.yaml`
- `config/repos/template.yaml`
- `README.md`
- `docs/repo-contract.md`

Done means:

- a new repo-focused branch starts the full standard stack unless config explicitly disables a role

Verification:

- `docker compose config`
- config validation for template and target config

Dependencies:

- issue 1

### 4. `#5` Runner-manager default lifecycle and dashboard visibility

Scope:

- ensure `runner-manager` is treated as a standard service in default deployment and dashboard state
- make default status and control path consistent even when a repo does not currently launch runners

Primary files:

- `scripts/engine-role.mjs`
- `scripts/dashboard-server.mjs`
- `dashboard/index.html`

Done means:

- `runner-manager` is always part of the standard service model and visible/controllable in the dashboard

Verification:

- dashboard service controls
- service state inspection

Dependencies:

- issue 3

### 5. `#6` Local PR queue as the sole scheduler for reviewer and validator

Scope:

- remove remaining direct GitHub-list assumptions from reviewer/validator scheduling
- require both services to consume only locally cached PR queue state for their sweeps
- harden queue fallback behavior under GitHub API slowness

Primary files:

- `scripts/engine-role.mjs`
- `scripts/lib/github.mjs`
- `scripts/lib/state.mjs`

Done means:

- reviewer/validator keep working from local queue state even when GitHub listing calls are slow or unavailable

Verification:

- local service sweep with cached queue
- forced GitHub API failure simulation

Dependencies:

- issue 2
- issue 3

### 6. `#7` Local gate-only readiness in pr-manager

Scope:

- make `pr-manager` decide readiness strictly from local validator/reviewer results plus PR metadata
- remove any normal dependence on GitHub Actions success for merge readiness
- keep GitHub only as a result publication channel

Primary files:

- `scripts/engine-role.mjs`
- `scripts/lib/github.mjs`
- `docs/architecture.md`

Done means:

- a PR can move to merge-ready from local gates alone

Verification:

- local green validator + reviewer state
- merge readiness without GitHub Actions

Dependencies:

- issue 5

### 7. `#8` Service failure state model and retry backoff

Scope:

- add `failure_count`, `failure_summary`, `last_attempt_at`, `next_retry_at`, and `remediation_status`
- add bounded retry backoff for reviewer and validator
- stop hot-looping failed PRs

Primary files:

- `scripts/engine-role.mjs`
- `scripts/lib/state.mjs`
- `dashboard/index.html`

Done means:

- a failed PR enters a visible retry window instead of immediate blind reruns

Verification:

- induced validation failure
- dashboard retry state

Dependencies:

- issue 5

### 8. `#9` Dashboard failure, retry, and local-gate drill-down

Scope:

- expose failure summary, next retry, and local gate state in the dashboard
- make blocked vs waiting-retry vs remediation-running visually explicit
- provide direct links or paths to local run logs where useful

Primary files:

- `dashboard/index.html`
- `scripts/dashboard-server.mjs`

Done means:

- an operator can tell why a PR is not moving without SSHing into the host

Verification:

- dashboard walkthrough against failed and green PR states

Dependencies:

- issue 7

### 9. `#10` Remediation record model and persistence

Scope:

- add persisted remediation records for failed PRs
- capture failing service, PR number, SHA, failure summary, run log, status, and attempts
- keep remediation records separate from validator/reviewer raw state

Primary files:

- `scripts/lib/state.mjs`
- `scripts/engine-role.mjs`

Done means:

- failed PRs create durable remediation records in engine state

Verification:

- induced validator failure
- remediation record persisted to state

Dependencies:

- issue 7

### 10. `#11` Dispatcher remediation routing to existing PR branches

Scope:

- route failed PR remediation back to dispatcher as local work
- reuse the existing PR branch instead of creating a new PR
- keep branch ownership and PR association stable

Primary files:

- `scripts/engine-role.mjs`
- `scripts/lib/runtime.mjs`
- `scripts/lib/state.mjs`

Done means:

- a failed PR is re-entered into the coding lane as a repair task on the same branch

Verification:

- local failure followed by remediation dispatch on the same PR branch

Dependencies:

- issue 9

### 11. `#12` Remediation prompt envelope and branch-fix constraints

Scope:

- create the prompt/input envelope for remediation runs
- include PR number, head SHA, failure summary, and log references
- constrain Codex to patch the existing PR branch rather than start a new flow

Primary files:

- `scripts/engine-role.mjs`
- `scripts/lib/runtime.mjs`
- prompt/instruction assets if needed

Done means:

- remediation worker runs have enough context to fix the right branch with the right constraints

Verification:

- recorded remediation payload
- one induced failure repaired through the remediation loop

Dependencies:

- issue 10

### 12. `#13` Local-only end-to-end acceptance harness

Scope:

- add a smoke harness or documented test path for:
  - issue intake
  - PR creation
  - local review
  - local validation
  - failed remediation
  - revalidation
  - local merge
- ensure this can be run against a repo-focused branch deployment

Primary files:

- `docs/`
- `scripts/`
- tests or smoke scripts as appropriate

Done means:

- the full intended local-service path can be demonstrated from one issue through merge without relying on GitHub-hosted compute

Verification:

- end-to-end smoke run on a target repo

Dependencies:

- issues 1 through 11
