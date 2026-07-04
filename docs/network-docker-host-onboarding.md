# Network Docker Host Onboarding

This document tells Codex how to set up and launch `autonomous-engine` on a remote Docker host on the local network.

It is the source of truth for turning a target repo branch into a running remote-host deployment.

## Goal

For each target repo, Codex should be able to:

1. prepare the remote Docker host
2. place or update the target repo on that host
3. place or update `autonomous-engine` on that host
4. configure persistent auth and state volumes
5. ensure the shared dependency volume is populated from the image
6. launch all required services on that host
7. verify service health from the operator machine

## Core Principle

When using a remote Docker context, all bind-mounted paths in `compose.yaml` are resolved on the remote host, not on the operator machine.

That means:

- `AE_TARGET_REPO_PATH` must be a path on the remote host
- the `commons-devloop` repo itself must also exist on the remote host if Compose is run from there

Because the repo is bind-mounted into `/engine`, the runtime also needs the named `engine-node-modules` volume so installed dependencies remain available inside the containers, and the dashboard service needs the named `dashboard-dist` volume for the same reason (the image-built frontend).

## Required Inputs

Codex should determine or be given:

- Docker context name
- remote host SSH identity
- remote host path for the branch-specific `autonomous-engine` checkout
- remote host path for the target repo
- repo config file name
- whether runner-manager is enabled for that target repo

## Remote Host Preparation

Codex should verify on the remote host:

- Docker is installed and reachable
- the selected Docker context works
- the remote host has enough disk for worktrees, run logs, and outputs
- the target repo exists on disk
- `autonomous-engine` exists on disk

Recommended remote layout:

```text
/srv/autonomous-engine/<branch-slug>
/srv/repos/<target-repo>
```

Each long-lived repo branch should deploy to its own checkout path on the host. The checkout path should not be shared across branches.

## Auth Preparation

### Codex Auth

Codex CLI auth persists in the named `codex-home` volume.

Codex should ensure the remote host has a valid login by running an interactive one-time login flow in a service container if needed.

Example:

```bash
docker --context <context> compose run --rm reviewer codex login
```

### GitHub Auth

GitHub auth should persist in the named `gh-config` volume, or `GH_TOKEN` should be provided in `.env`.

Preferred approach for remote-host operation:

1. keep `GH_TOKEN` set in the remote `.env`, or
2. run a one-time `gh auth login` inside a service container and persist it in `gh-config`

Example:

```bash
docker --context <context> compose run --rm reviewer gh auth login
```

## Remote `.env` Expectations

The remote host’s `.env` should include values appropriate for the remote filesystem.

Minimum example:

```bash
AE_TARGET_REPO_PATH=/srv/repos/olf-agent-pa
AE_REPO_CONFIG_FILE=olf-agent-pa.yaml
AE_MODE=loop
AE_AUTONOMOUS_LOOP_INTERVAL_SECONDS=300
AE_STATE_DIR=/engine/state
AE_WORKSPACE_DIR=/workspace/target-repo
AE_DASHBOARD_PORT=4700
AE_DEFAULT_LOG_LEVEL=info
GH_TOKEN=
```

If `GH_TOKEN` is blank, Codex should ensure the `gh-config` volume is authenticated before normal service startup.

`AE_LOOP_INTERVAL_SECONDS` is treated as a legacy autonomous-only override. To change other service cadences, use role-specific variables such as `AE_PR_MANAGER_LOOP_INTERVAL_SECONDS`, `AE_VALIDATOR_LOOP_INTERVAL_SECONDS`, or `AE_REVIEWER_LOOP_INTERVAL_SECONDS`.

## Deterministic Branch Deployment

Use `scripts/deploy-branch-to-host.sh` from the operator machine as the canonical deployment path.

The script:

1. requires a clean local worktree
2. bundles the exact local `HEAD` commit
3. installs that commit on the remote host at the selected checkout path
4. verifies the remote `HEAD` matches the local branch revision
5. records the deployed branch, commit, origin, and `.env` checksum in `.ae-deploy-manifest.json`
6. refuses to continue if the remote checkout has drifted from that manifest, is dirty, or the remote `.env` differs from the operator-provided `.env`, unless `--force` is used for an intentional repair
7. runs remote config validation and `docker compose` startup unless `--skip-launch` is set

If the selected host path already contains a git checkout that was not created by this deployment flow, the script treats it as unmanaged drift and fails closed until you rerun with `--force` to intentionally adopt and replace it.

Example:

```bash
bash scripts/deploy-branch-to-host.sh \
  --ssh-host <user>@<host> \
  --remote-repo-path /srv/autonomous-engine/repo-autonomous-engine \
  --env-file .env.remote
```

If the host checkout or `.env` has drifted and you want to intentionally repair it, rerun with `--force`.

That includes a clean checkout that no longer matches the last deployed revision for that branch path, or a pre-existing checkout at that path that does not yet have `.ae-deploy-manifest.json`. The manifest makes checkout-path reuse explicit instead of silently repurposing a host checkout.

```bash
bash scripts/deploy-branch-to-host.sh \
  --ssh-host <user>@<host> \
  --remote-repo-path /srv/autonomous-engine/repo-autonomous-engine \
  --env-file .env.remote \
  --force
```

## Launch Procedure

Codex should follow this order on the remote Docker host:

1. select the correct branch-specific remote checkout path
2. run `scripts/deploy-branch-to-host.sh` with the intended host and `.env`
3. confirm the remote revision matches the local branch revision
4. check service and dashboard health

### Example Commands

Remote revision check:

```bash
ssh <host> 'git -C /srv/autonomous-engine/<branch-slug> rev-parse HEAD'
```

Drift repair:

```bash
bash scripts/deploy-branch-to-host.sh \
  --ssh-host <host> \
  --remote-repo-path /srv/autonomous-engine/<branch-slug> \
  --env-file .env.remote \
  --force
```

Validate config:

```bash
ssh <host> '
  cd /srv/autonomous-engine/<branch-slug> &&
  AE_REPO_CONFIG=/srv/autonomous-engine/<branch-slug>/config/repos/<target-repo>.yaml \
  node scripts/validate-config.mjs
'
```

Render Compose:

```bash
ssh <host> 'cd /srv/autonomous-engine/<branch-slug> && docker compose config'
```

Check status:

```bash
ssh <host> '
  cd /srv/autonomous-engine/<branch-slug> &&
  AE_REPO_CONFIG=/srv/autonomous-engine/<branch-slug>/config/repos/<target-repo>.yaml \
  AE_STATE_DIR=/srv/autonomous-engine/<branch-scoped-state-dir> \
  node scripts/control.mjs status
'
```

## Health Verification

Codex should verify:

- `docker --context <context> ps` shows the expected service containers
- `git -C /srv/autonomous-engine/<branch-slug> rev-parse HEAD` matches the local branch revision
- dashboard responds on `http://<host>:<port>/health`
- `service-control.mjs status dispatcher` returns valid service config and state
- the state directory contains repo-level meta and log files
- reviewer and validator have access to auth and can reach GitHub

## Service Expectations

The remote host should be able to run:

- `autonomous`
- `dispatcher`
- `validator`
- `reviewer`
- `runner-manager`
- `pr-manager`
- `monitor`
- `dashboard`

If a target repo does not use runner-manager, that service may remain disabled in config, but the stack definition should still support it.

## Current Testing Context

Current known local-network Docker context:

- `jkm-remote`

Current endpoint:

- `ssh://jkm-remote-host` (resolved via the operator's local SSH config alias)

Codex should not hardcode that value as a permanent assumption, but it can use it when the operator confirms this host is the intended test target.

## Failure Conditions

Codex should stop and report a setup gap if:

- the Docker context is invalid
- the target repo path does not exist on the remote host
- the remote checkout is dirty, on the wrong recorded branch/revision/origin, or otherwise drifted from `.ae-deploy-manifest.json` when `--force` was not requested
- the remote `.env` differs from the operator-provided `.env` when `--force` was not requested
- the remote revision does not match the local branch revision after deployment
- `docker compose config` fails
- Codex auth is unavailable in the remote service environment
- GitHub auth is unavailable in the remote service environment
- dashboard health fails after launch
