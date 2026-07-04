# Roadmap

## Version 1.0

Core feature:

- Add local coding container lane.
- Support three equal lanes in dispatcher selection.
- Add lane-list config normalization while preserving legacy primary/secondary config.
- Add local runtime container integration.
- Add local lane launch adapter.
- Preserve issue-to-PR workflow.
- Rework lane UI into chipped panels.
- Add local runtime health/status telemetry.
- Add tests for config, dispatcher selection, dashboard state, and local runtime unavailable states.
- Update operator and architecture docs.

Required platform work:

- container runtime isolation rules
- config validation
- API compatibility
- local runtime observability
- run artifact auditability
- supply chain documentation for local runtime images

## Future Version 1.1

- Improve local model setup documentation with model-specific examples.
- Add richer local resource telemetry.
- Add dashboard controls for local runtime image and model cache path if appropriate.
- Add deterministic local runtime stub to smoke harness if not included in v1.

## Future Version 2.0

- Add smarter routing based on issue type, privacy, cost, or model capability.
- Add project-wide stuck-lane recovery improvements.
- Add model outcome evaluation across lanes.
- Add cost-aware scheduling across hosted and local lanes.
- Add fully offline issue snapshot workflows if AE introduces non-GitHub issue sources.

