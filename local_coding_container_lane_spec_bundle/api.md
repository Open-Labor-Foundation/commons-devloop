# API Specification

## Scope

This feature affects dashboard and control APIs exposed by AE. The API should preserve current endpoints while adding lane-list support.

## Compatibility Rule

Existing consumers of `primary` and `secondary` lane fields must not break during v1 rollout. New code should consume array-based lane data.

## State Endpoint

`GET /api/state`

The response should include lane arrays:

```json
{
  "laneControl": {
    "lanes": [
      {
        "key": "local",
        "label": "Local lane",
        "provider": "local_container",
        "model": "local",
        "enabled": true,
        "targetConcurrency": 1,
        "activeTargetConcurrency": 1,
        "runtime": {
          "service": "local-model",
          "status": "ready",
          "health": "healthy"
        }
      }
    ]
  },
  "laneTelemetry": {
    "lanes": [
      {
        "key": "local",
        "running": 0,
        "healthLabel": "Ready",
        "healthDetail": "Local runtime is ready and waiting for accessible issues.",
        "telemetryAge": "just now"
      }
    ]
  }
}
```

## Config Endpoint

`GET /api/config`

Should expose normalized lane list plus legacy fields during migration.

## Policy Update Endpoint

`POST /api/settings/policies`

Must accept lane updates by key. Required behavior:

- unknown lane keys are rejected
- local lane settings validate provider-specific fields
- disabled lanes persist as disabled, not deleted
- target concurrency is bounded
- existing primary/secondary form submissions remain supported

Example request fragment:

```json
{
  "dispatcherLanes": [
    {
      "key": "local",
      "enabled": true,
      "targetConcurrency": 1,
      "provider": "local_container",
      "model": "local",
      "runtimeService": "local-model"
    }
  ]
}
```

## Local Runtime Health

The dashboard server should include local runtime health in state. It may collect this from:

- HTTP health endpoint on the compose network
- a configured command probe
- Docker service state if already available without expanding Docker socket access

The preferred v1 path is a simple health endpoint exposed inside the compose network.

## Error Model

Errors should use the existing dashboard API style and include:

- `error`: short message
- `code`: stable machine-readable code
- `details`: optional supporting fields

Recommended codes:

- `unknown_lane`
- `invalid_lane_provider`
- `invalid_lane_concurrency`
- `local_runtime_unavailable`
- `local_runtime_health_failed`
- `config_write_failed`

## Auth And Session Model

No new account model is required. The feature uses AE's existing dashboard and local operator access model.

GitHub authentication remains necessary when AE needs to read issues or publish pull requests through GitHub.

