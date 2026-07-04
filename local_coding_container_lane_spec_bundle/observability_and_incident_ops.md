# Observability And Incident Operations

## Required Observability

The local lane must expose:

- lane enabled state
- runtime availability
- runtime health
- current running count
- active worker allowance
- assigned issues
- run log path
- last error
- PR URL when created

## Dashboard

The dashboard should show local runtime state in the lane panel and service status area.

## Logs

Run logs should remain under existing dispatcher run-log paths. Local runtime service logs should be inspectable through Docker logs and summarized in AE state when failures block work.

## Alerts And Incidents

V1 does not need a new alerting system. It does need visible operator states:

- local runtime unavailable
- local runtime failed health check
- local lane disabled
- local lane blocked by no accessible issues
- local lane failed a run

## Recovery

Recovery should use existing service controls:

- restart local runtime container
- restart dispatcher
- disable local lane
- reduce local lane concurrency

Stuck-lane workflow improvements remain outside this feature.

