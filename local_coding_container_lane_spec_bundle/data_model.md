# Data Model Specification

## Config Entities

### Dispatcher Lane

Fields:

- `key`: stable lane identifier
- `label`: operator-facing name
- `enabled`: whether dispatcher may assign work
- `provider`: `hosted_codex` or `local_container`
- `model`: model/runtime name
- `reasoning_effort`: hosted reasoning effort or local equivalent
- `max_workers`: target worker count
- `pause_threshold_used_percent`: hosted quota policy where applicable
- `weekly_pause_threshold_used_percent`: hosted quota policy where applicable
- `reserve_burn_window_minutes`: hosted quota policy where applicable
- `nominal_burn_per_lane_hour`: cost or resource estimate
- `runtime_service`: local runtime service name when provider is local
- `runtime_endpoint`: local runtime endpoint when provider is local

### Legacy Dispatcher Lane

Existing `models.dispatcher.primary` and `models.dispatcher.secondary` fields should normalize into dispatcher lane records.

## Runtime Entities

### Lane Telemetry

Fields:

- `key`
- `provider`
- `model`
- `running`
- `targetConcurrency`
- `activeTargetConcurrency`
- `healthLabel`
- `healthDetail`
- `pauseReason`
- `throttleReason`
- `telemetryAt`
- `telemetryAge`

Hosted-only fields:

- `remainingPercent`
- `weeklyRemainingPercent`
- `effectiveReserveRemainingPercent`
- `reset`
- `weeklyReset`

Local-only fields:

- `runtimeService`
- `runtimeStatus`
- `runtimeHealth`
- `runtimeImage`
- `runtimeEndpoint`
- `localResourceSummary`

## Dispatcher Item Metadata

Each dispatched issue should continue to store:

- `number`
- `title`
- `status`
- `pid`
- `log`
- `worktree`
- `started_at`
- `finished_at`
- `exit_code`
- `signal`
- `assigned_model`
- `assigned_lane`
- `reasoning_effort`
- `last_error`
- `pr_url`

Add:

- `assigned_provider`
- `runtime_service`
- `runtime_image`
- `runtime_endpoint`

## Audit Requirements

The state record for each run must be enough to answer:

- which issue was assigned
- which lane handled it
- which runtime handled it
- which branch and PR were produced
- where logs and output artifacts are stored
- whether the run failed, exited, or completed

## Retention

Use existing retention controls for worktrees, run logs, and output files. Local model cache retention should be separate from run artifact retention because model downloads can be expensive and large.

