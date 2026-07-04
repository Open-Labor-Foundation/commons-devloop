# Realtime Events

## Scope

AE currently exposes dashboard state through polling-style endpoints. This feature does not require a new realtime event system.

## V1 Requirement

Dashboard refreshes must include local lane state through the same state refresh path used by current lane telemetry.

## Event-Like State Changes To Surface

The dashboard should surface changes for:

- local runtime unavailable
- local runtime ready
- local lane assigned issue
- local lane run failed
- local lane produced PR

## Future Work

If AE later adds server-sent events or websockets, local lane state should use the same event model as hosted lanes.

