# Architecture

## Goal

Provide one reusable autonomous engine that can operate against any GitHub repository through configuration rather than repo-specific runtime code, while keeping the useful local-service behavior already proven in `olf-agents`.

## Runtime Model

The engine uses one shared image and several role-based services:

- `autonomous`
- `dispatcher`
- `validator`
- `reviewer`
- `runner-manager`
- `pr-manager`
- `monitor`
- `dashboard`

Each service runs in its own container from the same image. This keeps operational separation without creating multiple maintenance burdens.

## Local Services First

The design assumes that work you can do locally in Docker should stay local:

- validation is local worktree execution
- PR review is local Codex-backed review
- queueing, monitoring, pause/resume, and service health are local
- runner management is local when a repo chooses to keep GitHub Actions as the control plane

GitHub remains the source of truth for:

- issues
- pull requests
- commit statuses
- posted review/comment artifacts
- final merge operations initiated by local services

`pr-manager` is a local merge watcher, not a GitHub auto-merge proxy. It consumes the local PR queue plus local validator/reviewer results, uses PR metadata only for draft/conflict/behind checks, updates stale PR branches when needed, and performs merges from Docker once local gates are satisfied. GitHub Actions results are publication artifacts, not the normal readiness source.

## Model Lane Control

Dispatcher lane policy is first-class:

- primary lane model
- secondary lane model
- optional local container lane model/runtime
- per-lane reasoning label
- pause thresholds
- reserve burn windows
- nominal burn estimates per lane-hour

Internally, dispatcher lanes normalize to a lane list so hosted and local lanes share the same issue-to-PR dispatch contract. Legacy primary/secondary config remains supported.

Reviewer model policy is also first-class and separate from dispatcher lanes.

## State Layout

Per-repo state lives under:

```text
state/repos/<repo-key>/
  repo-state.json
  meta/
  logs/
  worktrees/
  run-logs/
  outputs/
```

This layout mirrors the useful operating shape from `olf-agents`:

- service configs are inspectable
- service states are durable
- logs fail visibly
- worktrees are kept separate from the target repo root
- review output is auditable

## Trust Boundaries

- target repo workspace mount
- engine state directory
- Codex auth volume
- GitHub auth via `gh` / `GH_TOKEN`
- Runner-manager Docker socket access (read-write) and dashboard read-only status
  telemetry access

## Lifecycle States

- `disabled`
- `ready`
- `running`
- `paused_manual`
- `paused_milestone`
- `paused_budget`
- `failed_attention_needed`

## Service Control

This pack uses container-native long-running services rather than `screen` sessions. Service lifecycle control is handled by:

- container restart policy
- repo-level pause state
- per-service desired state in control metadata
- dashboard and CLI controls

That preserves the operational behavior of start/stop/pause/resume while fitting a Docker-host runtime better than host-level `screen`.

## Dashboard

The dashboard is a first-class browser control plane, not just a JSON status server.

It must provide:

- operations summary cards
- lane status and lane controls
- active issue and PR visibility
- validator and reviewer activity panels
- service controls
- repo pause and resume controls
- settings panels that use direct, human-readable controls

## Current Correction Spec

The current highest-priority implementation correction is defined in [local-service-default-implementation-spec.md](local-service-default-implementation-spec.md).

That spec makes the intended model explicit:

- full local-service stack is the default for every repo-focused branch
- GitHub is the record system, not the primary compute plane
- failed PRs must route back into a local remediation loop
- branch deployment must be deterministic and isolated
