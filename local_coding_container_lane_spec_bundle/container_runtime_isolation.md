# Container Runtime Isolation

## Goal

The local lane should operate fully within Docker-managed runtime boundaries.

## Runtime Boundary

The local model must run in a container that is part of the AE stack or reachable by the AE stack through a configured Docker network.

The dispatcher should communicate with the local runtime over a stable adapter boundary rather than treating it as a host process.

## Recommended Controls

- Do not expose local runtime ports to the host by default.
- Use named volumes for model cache.
- Keep worktree access scoped to the same target repo mount used by AE.
- Do not mount the Docker socket into the local model container unless a future feature explicitly requires it.
- Avoid giving the local model container write access to AE state except through the lane adapter.
- Keep secrets in AE service containers, not in the model runtime container, unless required.

## Health

The local runtime should expose a health signal that AE can read from inside the compose network.

Required states:

- disabled
- unavailable
- starting
- ready
- busy
- failed

## Resource Controls

Operators should be able to set or document:

- model image
- model cache volume
- memory expectations
- CPU/GPU expectations
- concurrency limit

V1 may document hardware expectations rather than enforce all of them automatically.

