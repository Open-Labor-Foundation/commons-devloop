# Testing Strategy

## Required Test Coverage

Add focused tests for:

- config normalization from legacy primary/secondary shape
- config normalization from lane-list shape
- duplicate lane key validation
- local lane disabled behavior
- local lane unavailable behavior
- dispatcher lane target computation across three lanes
- dispatcher lane choice across three lanes
- dispatcher state persistence with local lane metadata
- dashboard state response with lane arrays
- dashboard rendering of chipped lane panels
- policy update handling for lane-list submissions
- compose config validation with local runtime service enabled

## Regression Tests

Existing two-lane behavior must remain covered:

- current repo configs still load
- existing dashboard tests still pass
- primary/secondary lane telemetry remains available during migration
- existing local-service smoke harness still passes

## Acceptance Test

Add or extend a smoke harness path that proves:

1. AE starts with a local lane enabled.
2. The local runtime health is reported ready.
3. Dispatcher assigns an accessible issue to the local lane.
4. The local lane works in a prepared worktree.
5. A pull request is created.
6. State records show `assigned_lane: local`.
7. Dashboard state shows the local lane chipped panel data.

The local model can be stubbed for deterministic CI tests. A real local model run can be documented as an operator acceptance path if it is too expensive for routine CI.

## Manual Verification

Manual verification should include:

- `npm test`
- `npm run validate:config`
- `docker compose config`
- `docker compose up -d`
- dashboard visual check at the configured port
- one local-lane issue-to-PR run in a target repo

