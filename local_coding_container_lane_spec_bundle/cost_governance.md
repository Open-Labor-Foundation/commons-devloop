# Cost Governance

## Cost Goals

The local lane should reduce hosted model spend and allow local-first operation when appropriate.

## V1 Cost Behavior

Hosted lanes continue using quota and burn telemetry where available.

The local lane should expose a resource/cost hint instead of fake hosted quota:

- local runtime ready or unavailable
- configured concurrency
- approximate local resource class if configured
- optional nominal local cost estimate

## Budget Interaction

Existing repo budget and lifecycle gates still apply globally unless explicitly separated later.

The local lane should not be blocked by hosted model quota telemetry simply because local runtime has no hosted quota reading.

## Future Cost Controls

Future phases may add:

- per-provider budget groups
- local hardware utilization
- energy or GPU time estimates
- cost-aware lane routing

