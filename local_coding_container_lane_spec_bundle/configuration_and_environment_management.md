# Configuration And Environment Management

## Config Goals

The local lane must be enabled through repo config and environment settings, not source edits.

## Required Config

Repo config should support:

- lane key
- label
- provider
- model/runtime name
- enabled state
- target concurrency
- local runtime service
- local runtime endpoint
- local resource/cost hint

## Environment Variables

Recommended environment variables:

- `AE_LOCAL_LANE_ENABLED`
- `AE_LOCAL_MODEL_SERVICE`
- `AE_LOCAL_MODEL_ENDPOINT`
- `AE_LOCAL_MODEL_IMAGE`
- `AE_LOCAL_MODEL_CACHE`

Environment variables should provide deployment defaults. Repo config remains the durable policy record.

## Backward Compatibility

Existing config files using primary and secondary lane objects must continue to validate and normalize.

The schema should support both:

- legacy two-lane object shape
- new lane-list shape

## Validation

Config validation must catch:

- duplicate lane keys
- unknown providers
- invalid concurrency values
- missing local runtime service for local lanes
- local lane enabled with no runtime endpoint or service

