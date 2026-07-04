# Execution Policy

## Lane Equality

All enabled lanes are eligible for work assignment according to their configured capacity and health. The local lane is not intrinsically lower priority than hosted lanes.

## Assignment Rules

Dispatcher should:

- ignore disabled lanes
- ignore lanes with 0 target workers
- ignore unhealthy local runtime lanes
- count currently running items per lane
- prefer lanes with the largest worker deficit
- use stable tie-breaking by lane key

## Local Runtime Readiness

The local lane can receive work only when:

- the local lane is enabled
- target concurrency is greater than 0
- the local runtime container is healthy or ready
- issues are accessible
- repo lifecycle and budget rules allow new work

## Failure Handling

Local lane failures should follow the same dispatcher behavior as other lanes. No new stuck-lane or retry policy is introduced in this feature.

## Pull Request Contract

The local lane must create or update a PR through the same branch and PR expectations as hosted lanes. AE should not accept local lane output as complete unless the issue-to-PR contract is satisfied or the run records a clear failure.

## Safety Controls

The local lane must respect existing safety config:

- PR-only operation
- protected branches
- protected paths
- force-push policy
- clean worktree requirement
- lifecycle pause state

