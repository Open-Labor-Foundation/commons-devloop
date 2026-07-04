# Architecture Specification

## Current Shape

Autonomous Engine currently uses a shared Docker image with role-based services:

- autonomous
- dispatcher
- validator
- reviewer
- runner-manager
- pr-manager
- monitor
- dashboard

Dispatcher lane policy is currently modeled around primary and secondary lanes. The dashboard and backend expose lane control and lane telemetry as fixed `primary` and `secondary` objects.

## Target Shape

The local coding container lane requires AE to evolve from two fixed dispatcher lanes to a lane registry.

Each lane should have:

- stable key
- display label
- provider type
- model name
- reasoning effort or local equivalent
- target concurrency
- active concurrency
- running count
- availability state
- health summary
- runtime metadata
- cost or quota policy
- launch adapter

Hosted lanes and local lanes should share the same dispatcher contract. The difference should live behind the lane launch adapter.

## Recommended Lane Model

Use a normalized list internally:

```yaml
models:
  dispatcher:
    lanes:
      - key: primary
        label: Primary lane
        provider: hosted_codex
        model: gpt-5.3-codex-spark
        reasoning_effort: high
        max_workers: 1
      - key: secondary
        label: Secondary lane
        provider: hosted_codex
        model: gpt-5.4
        reasoning_effort: medium
        max_workers: 1
      - key: local
        label: Local lane
        provider: local_container
        model: local
        reasoning_effort: local
        max_workers: 1
```

The existing `primary` and `secondary` config shape must continue to normalize into this list for backward compatibility.

## Local Runtime Components

Add a local model runtime service to the Docker stack. The exact image can be configurable, but the AE contract should be stable:

- service name: `local-model` or a repo-configured equivalent
- reachable from AE containers on the compose network
- exposes a local inference endpoint or command adapter
- stores model cache in a named volume
- does not require hosted model credentials for reasoning
- reports health through a lightweight health check

Add a local lane runner/adapter that the dispatcher can call when the selected lane has `provider: local_container`.

## Dispatcher Flow

1. Dispatcher refreshes accessible issues.
2. Dispatcher computes lane targets across all enabled lanes.
3. Dispatcher chooses the lane with available capacity using the same fairness rules applied to hosted lanes.
4. Dispatcher prepares the issue worktree and log/output paths.
5. Dispatcher invokes the lane adapter:
   - hosted lanes use the current Codex CLI launch path
   - the local lane invokes the local container runtime path
6. The selected lane works the issue.
7. The lane creates or updates a pull request.
8. Dispatcher records status, assigned lane, assigned model, output paths, and PR URL.

## Local Lane Adapter Contract

The local lane adapter must accept:

- repo workspace path
- prepared worktree path
- issue title, body, labels, and URL
- base branch
- branch name
- remediation payload when applicable
- output path
- log stream
- lane metadata

The local lane adapter must return:

- exit code
- signal if terminated
- PR URL when available
- branch name
- final status
- machine-readable error when failed

## Container Stack Integration

The compose stack should add the local runtime in a way that does not break existing deployments. Recommended approach:

- keep the current AE services unchanged by default
- add an optional `local-model` service
- add named model-cache volume
- make local lane enablement repo-configured
- allow operators to omit the local runtime if the lane is disabled

The local lane should not require broad Docker socket access. If the dispatcher needs to communicate with a local model container, prefer compose-network communication over Docker socket control.

## State Layout

Reuse the existing per-repo state layout:

```text
state/repos/<repo-key>/
  meta/
  logs/
  worktrees/
  run-logs/
  outputs/
```

Add local-lane metadata to dispatcher item records:

- `assigned_lane`
- `assigned_model`
- `assigned_provider`
- `local_runtime_service`
- `local_runtime_image`
- `local_runtime_health`
- `local_runtime_endpoint`
- `started_at`
- `finished_at`
- `exit_code`
- `pr_url`

## Dashboard Architecture

The dashboard backend should emit lane control and telemetry as arrays:

```json
{
  "laneControl": {
    "lanes": []
  },
  "laneTelemetry": {
    "lanes": []
  }
}
```

Legacy `primary` and `secondary` fields may remain during migration, but new UI rendering should consume the array.

## Privacy And Security Requirements

- The local lane must not send issue content or source code to hosted model services for reasoning.
- GitHub access may still be used for issue and PR operations.
- Secrets must come from existing AE environment/config mechanisms.
- Local model runtime endpoints must be available only on the Docker network unless explicitly exposed by the operator.
- Logs must avoid printing tokens, auth headers, or local model credentials.

## Reliability Requirements

- If the local runtime is unavailable, the lane should be shown as unavailable and should not receive new work.
- If the local lane process exits, dispatcher should record the same failure fields used by hosted lanes.
- Existing stuck/failure behavior should remain unchanged for v1.
- Local runtime health should be reflected in dashboard state.

## Performance Targets

- Local lane startup should not block hosted lanes.
- Lane selection should remain O(number of lanes + running items).
- Dashboard state generation should remain fast for normal lane counts.
- Local model startup latency should be visible to the operator instead of hidden as unexplained lane idleness.

