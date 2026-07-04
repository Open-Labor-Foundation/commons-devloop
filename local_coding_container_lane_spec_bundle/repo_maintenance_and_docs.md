# Repository Maintenance And Documentation

## Docs To Update

Update:

- `README.md`
- `docs/architecture.md`
- `docs/dashboard-spec.md`
- `docs/operator-guide.md`
- `docs/repo-contract.md`
- `docs/target-repo-onboarding.md`
- `docs/network-docker-host-onboarding.md` if remote Docker host behavior changes

## Code Organization

Prefer focused modules:

- lane normalization helpers
- lane target computation helpers
- hosted lane launcher
- local lane launcher
- lane telemetry builder
- dashboard lane renderer

## Maintenance Rules

- Avoid duplicating primary/secondary/local branching throughout the codebase.
- Centralize provider-specific behavior behind lane adapters.
- Keep tests near existing config, dispatcher, dashboard, and smoke harness tests.
- Preserve examples for both legacy and lane-list config.

