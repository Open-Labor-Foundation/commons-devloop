# Product Specification

## Name

Local Coding Container Lane

## Product Type

Feature addition to Autonomous Engine.

## Core Definition

Autonomous Engine should support a local coding lane that participates in the same issue-to-pull-request workflow as the existing hosted model lanes.

The local lane is not a separate product. It is an additional dispatcher lane backed by a local model running inside the existing Docker-based AE stack.

## Target User

- Primary: the current AE operator.
- Long term: anyone who deploys Autonomous Engine.

## Core Value

The local lane gives AE operators a privacy-preserving, lower-cost, local-first execution option while preserving the same operating model as the hosted model lanes.

## In Scope For Version 1.0

- Add a third dispatcher lane backed by a local model runtime in Docker.
- Treat the local lane as an equal lane choice beside primary and secondary hosted lanes.
- Preserve the current issue-to-PR contract:
  - AE selects or receives an accessible issue.
  - AE dispatches the issue to a lane.
  - The lane works in an isolated worktree.
  - The lane creates or updates a pull request.
  - AE records lane, model, logs, state, and PR metadata.
- Add local lane configuration to repo config and normalized config output.
- Add a local model container/service to the compose stack or an equivalent container-managed runtime path.
- Make the dispatcher capable of selecting from a lane list rather than only fixed primary and secondary lanes.
- Rework the dashboard lane display so each lane is shown in its own chipped panel.
- Show the local lane with the same status vocabulary as hosted lanes, with local-specific telemetry where hosted quota data does not apply.
- Keep existing lane failure behavior unchanged.
- Support operation when issues are accessible, including local or previously available issue sources where AE already supports them.

## Explicitly Out Of Scope For Version 1.0

- Project-wide stuck-lane recovery improvements.
- New issue source strategy beyond existing accessible issue behavior.
- Hosted deployment of the local model.
- Guaranteeing that every local model has equal capability to hosted models.
- Automatically choosing the best local model for a task.
- Replacing hosted lanes.
- Replacing existing validator, reviewer, runner-manager, monitor, or PR-manager roles.

## Supporting Platform Requirements

- Configuration must allow deployers to enable, disable, and tune the local lane without editing source code.
- Operators must be able to see whether the local model container is available, starting, healthy, busy, failed, or disabled.
- AE must clearly record which lane and local model handled each issue.
- Logs and outputs from local lane runs must remain inspectable under the existing state layout.
- The local model container must not require hosted model credentials for reasoning work.
- GitHub or an equivalent configured issue/PR control plane may still be needed for issue intake and pull request publication.
- Local lane behavior must be documented in onboarding and operator docs.

## Success Criteria

- A repo config can define primary, secondary, and local lanes.
- The dispatcher can launch work on any enabled lane based on configured lane capacity.
- The local lane can receive an issue and produce a pull request through the same state and PR workflow used by hosted lanes.
- The dashboard shows all lanes as separate chipped panels.
- The local lane remains inside Docker-managed runtime boundaries.
- Existing two-lane configs continue to work.
- Existing tests pass, and new tests prove the three-lane path.

