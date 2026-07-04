# Local-Service Default Implementation Spec

## Purpose

This spec corrects `autonomous-engine` back to the intended operating model:

- every target-repo branch deploys its own Docker stack
- local Docker services are the primary execution plane
- GitHub is only the system of record for issues, PRs, statuses, reviews, and merges
- normal PR progress must not depend on GitHub-hosted compute

This is the next implementation baseline Codex should execute end to end.

## Problem Statement

The current implementation is still too hybridized.

Observed failures:

- validator and reviewer can block a PR, but they do not route failed PRs back into a local remediation loop
- some live stacks still behave as if self-hosted workflow execution is optional rather than the default local-service model
- service deployment can drift by host checkout and branch, which makes one branch behave differently from another
- dashboard state can lag behind actual service behavior, especially around failure, retry, and local gate status
- parts of the runtime still behave as if GitHub-hosted execution is a normal dependency instead of a fallback-only concern

## Required Outcome

For every repo-focused branch of `autonomous-engine`, the default behavior must be:

1. dispatcher pulls GitHub issues and launches Codex work from Docker
2. Codex produces or updates a PR branch
3. reviewer performs the review inside its container
4. validator performs the validation inside its container
5. if review or validation fails, the PR is routed back into a local remediation loop
6. when local review and validation are green, `pr-manager` updates or merges the PR from Docker
7. GitHub receives the posted artifacts and merge result, but does not provide the primary compute path

## Hard Rules

### Local First

- `dispatcher`, `validator`, `reviewer`, `pr-manager`, `monitor`, `dashboard`, `autonomous`, and `runner-manager` must be part of the standard branch deployment
- these services must start enabled by default unless repo config explicitly disables them
- local validation and local review are the default merge gates
- GitHub Actions must not be required for PR progress under the normal local-service path

### GitHub Scope

GitHub is only for:

- issue intake
- PR intake and update
- commit status publication
- review/comment publication
- merge record publication

GitHub is not the primary scheduler, validator, reviewer, or merge executor.

### Deterministic Branch Deployment

Every repo-focused branch must be deployable in a deterministic way:

- one branch maps to one target repo
- one branch gets one repo-specific config
- one branch gets one isolated Docker stack identity
- one branch gets isolated state, logs, worktrees, and outputs
- host drift must not change runtime behavior relative to branch contents

## Scope

### In Scope

- full local-service stack enabled by default
- removal of GH-hosted assumptions from validator, reviewer, and `pr-manager`
- local remediation loop for failed PRs
- deterministic per-branch deployment model
- dashboard and state visibility for failure, retry, remediation, and merge readiness

### Out of Scope

- redesigning Codex worker prompting beyond what is required for remediation routing
- replacing GitHub as issue/PR source of truth
- multi-repo orchestration from one branch

## Target Architecture

### Standard Service Set

Every repo-focused stack must run:

- `autonomous`
- `dispatcher`
- `validator`
- `reviewer`
- `runner-manager`
- `pr-manager`
- `monitor`
- `dashboard`

If a service is intentionally disabled for a repo, that must come from committed repo config, not host drift.

### Execution Flow

1. `dispatcher` selects a GitHub issue
2. `dispatcher` launches Codex work from Docker
3. branch/worktree is created locally
4. PR is opened or updated in GitHub
5. `pr-manager` records the PR in local queue state
6. `reviewer` consumes local PR queue state and performs review in Docker
7. `validator` consumes local PR queue state and performs validation in Docker
8. `pr-manager` evaluates local gate state and either:
   - requests branch update
   - routes remediation
   - merges

### Failure Remediation Flow

When review or validation fails:

1. the failing service stores:
   - failure result
   - failure summary
   - run log path
   - retry metadata
   - PR SHA
2. `pr-manager` or a dedicated remediation coordinator creates a local remediation record
3. remediation is scheduled back to dispatcher as local work for that same PR branch
4. Codex receives the failure artifacts and fixes the branch
5. the updated branch re-enters local review and validation

This remediation loop must be local-first and must not require manual intervention for normal recoverable failures.

## Implementation Workstreams

### 1. Make Full Local Stack Default

Deliverables:

- compose and onboarding defaults start the full service set
- repo config schema clearly marks explicit opt-outs
- branch setup docs state that local services are the default path, not an optional mode

Acceptance:

- a new repo-focused branch starts all standard services by default
- dashboard shows every standard service unless explicitly disabled in config

### 2. Remove GH-Hosted Assumptions

Deliverables:

- validator consumes only local PR queue state for scheduling
- reviewer consumes only local PR queue state for scheduling
- `pr-manager` makes readiness decisions from local gate state
- no normal PR progress depends on a successful GitHub Actions run

Acceptance:

- if GitHub Actions are disabled, local validation/review/merge still function
- temporary GitHub API slowness does not stop local review/validation sweeps once PR state is cached

### 3. Add PR Remediation Loop

Deliverables:

- remediation record model in engine state
- routing logic from failed validator/reviewer result back to dispatcher
- remediation prompt envelope including:
  - failing PR number
  - current head SHA
  - local failure summary
  - relevant log path or excerpt
  - required constraints for patching existing PR branch
- retry/backoff semantics that do not hot-loop endlessly

Acceptance:

- a failed PR is visibly marked as `remediation queued` or `remediation running`
- the same PR branch is updated locally by Codex
- the PR automatically re-enters local review and validation after remediation

### 4. Deterministic Per-Branch Deployment

Deliverables:

- branch-specific stack naming
- branch-specific state root
- branch-specific config resolution
- deployment script or documented command path that syncs exact branch contents to host
- host runtime must reflect branch contents, not leftover files

Acceptance:

- two different repo-focused branches can be deployed independently without sharing state
- restarting a branch stack preserves only that branch’s intended state
- branch deployment is repeatable from committed repo contents alone

### 5. Failure and Retry Visibility

Deliverables:

- service state stores:
  - `failure_count`
  - `failure_summary`
  - `next_retry_at`
  - `last_attempt_at`
  - `remediation_status`
- dashboard exposes:
  - current failure reason
  - retry timing
  - remediation state
  - whether a PR is blocked, waiting for retry, or actively being repaired

Acceptance:

- an operator can tell within one dashboard view whether a PR is:
  - currently validating
  - failed and waiting for retry
  - queued for remediation
  - under active remediation
  - ready to merge

## State Model Additions

### Validator / Reviewer PR Record

Each PR record must support:

- `title`
- `sha`
- `result`
- `updated_at`
- `run_log`
- `branch`
- `error`
- `failure_count`
- `failure_summary`
- `last_attempt_at`
- `next_retry_at`
- `remediation_status`

### Remediation Record

Each remediation record must support:

- `pr_number`
- `head_sha`
- `source_service`
- `failure_summary`
- `run_log`
- `status`
- `assigned_lane`
- `worker_id`
- `attempt_count`
- `created_at`
- `updated_at`

## Dashboard Requirements

The dashboard must make the local-service model obvious.

Required UI states:

- `validator failed, retry at <time>`
- `reviewer failed, retry at <time>`
- `remediation queued for PR #...`
- `remediation running on lane ...`
- `ready to merge locally`
- `blocked by merge conflicts`
- `blocked by explicit config gate`

The dashboard must not present a failed PR as if it is merely “still running.”

## Deployment Requirements

### Branch Isolation

Each repo-focused branch must define:

- target repo identity
- stack/project name
- state root
- config path
- host workspace path

### Required Deployment Behavior

- sync exact branch contents to host
- verify remote files match expected branch revision
- restart only that branch’s stack
- preserve only that branch’s state

## Acceptance Tests

Codex should not consider this work complete until these are true:

### A. Local-Only PR Flow

- issue is dispatched locally
- PR is created
- reviewer runs locally
- validator runs locally
- `pr-manager` merges locally
- GitHub Actions can be absent or irrelevant

### B. Failed PR Remediation

- validator fails a PR locally
- dashboard shows failure summary and retry timing
- remediation task is created locally
- dispatcher runs remediation on the same PR branch
- validator reruns locally on the updated branch

### C. Branch Isolation

- deploy one repo-focused branch for repo A
- deploy another repo-focused branch for repo B
- verify separate service state, stack names, and worktrees

### D. Host Drift Resistance

- redeploy from committed branch contents
- confirm runtime reflects branch contents, not stale files

## Suggested Execution Order

1. implement deterministic branch deployment and stack naming
2. make full local-service stack default in config and compose behavior
3. complete local-only scheduling for validator/reviewer/`pr-manager`
4. add remediation record model and remediation routing
5. add dashboard failure/remediation visibility
6. run a one-issue smoke test through local dispatch -> PR -> local fail -> remediation -> local green -> merge

## Done Means

This spec is complete only when a repo-focused branch of `autonomous-engine` can:

- pick up a GitHub issue
- create a PR from Docker
- review and validate that PR from Docker
- repair that PR from Docker when review or validation fails
- merge the PR from Docker when local gates pass

with GitHub acting only as the issue/PR record system, not the primary compute path.
