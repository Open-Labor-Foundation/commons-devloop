# Operator Guide

## Common Tasks

### Validate the repo config

```bash
AE_REPO_CONFIG=/absolute/path/to/config.yaml node scripts/validate-config.mjs
```

### Start the local-service stack

```bash
docker compose build engine-image
docker compose up -d
```

### Start the optional local model runtime

Run these commands against the intended Docker context. In the local-network setup, that is the VS Code linked Docker host, not the operator machine.

```bash
docker compose --profile local-lane up -d local-model
docker compose --profile local-lane exec local-model ollama pull qwen2.5-coder:7b
AE_REPO_CONFIG=config/repos/olf-agents.yaml npm run check:local-lane
```

Enable the local dispatcher lane in repo config or from the dashboard, then set
its workers above 0. The default local runtime endpoint is
`http://local-model:11434/v1`; GitHub access is still used for issue intake and
pull request publication.

Set `auto_pull: true` on the local lane only when you want the first local lane
run to pull a missing Ollama model automatically. Keeping it false makes model
setup an explicit operator step.

### Run the deployment readiness check

```bash
npm run predeploy:check
```

This reads `config/predeploy.matrix.yaml` and checks the default QA readiness
profile before deployment. The check validates repo config loading, target path
resolution, isolated stack identity, isolated compose project name,
non-conflicting dashboard port, and the standard local-service defaults. It does
not launch containers. Use `-- --json` for a machine-readable gate, or
`-- --require-targets` when target repo paths must exist on the machine running
the check. Optional variant profiles can be added to the YAML when a release
needs extra coverage.

### Run the local-only acceptance harness

```bash
npm run smoke:local-service
```

This smoke harness drives one issue through issue intake, PR creation, local
review, local validation, remediation, revalidation, and local merge. It keeps
the mock PR `mergeStateStatus` at `BLOCKED` and still merges after local gates
go green, which proves normal PR progress does not require GitHub-hosted
compute.
Use `node scripts/local-service-acceptance-harness.mjs --json` when you want
the ordered stage sequence and local-only merge proof as a machine-readable
artifact.

### Run the repo-focused branch deployment smoke harness

```bash
npm run smoke:local-service:branch-deploy
```

This command snapshots the current branch, deploys it through
`scripts/deploy-branch-to-host.sh` with `--transport local`, and runs the same
one-issue smoke harness from the deployed checkout. Use it to prove the full
local-service path still works after a repo-focused branch deployment.
Add `--json` to capture the nested smoke summary from that deployed checkout.

### Generate a release manifest

```bash
node scripts/release-manifest.mjs \
  --version 1.2.3 \
  --image-tag ghcr.io/example/autonomous-engine:1.2.3 \
  --config-template config/repos/template.yaml \
  --docs-bundle docs/operator-guide.md \
  --file dist/sbom.json \
  --build-metadata pipeline=release \
  --out dist/release-manifest.json
```

The manifest is a dry-run delivery record. It writes deterministic JSON with
the release version, image tag, build metadata, current git commit, dirty-tree
warning, and SHA-256 checksums for selected release files that exist. It does
not publish container images or upload artifacts.

The required inputs can also come from environment variables:
`AE_RELEASE_VERSION`, `AE_IMAGE_TAG`, `AE_CONFIG_TEMPLATE`, and
`AE_DOCS_BUNDLE`. Optional inputs include `AE_RELEASE_FILES`,
`AE_BUILD_METADATA`, `AE_BUILD_ID`, and `AE_BUILD_SOURCE`.

### Check repo lifecycle state

```bash
AE_REPO_CONFIG=/absolute/path/to/config.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
node scripts/control.mjs status
```

### Pause the repo

```bash
AE_REPO_CONFIG=/absolute/path/to/config.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
node scripts/control.mjs pause "manual review window"
```

### Resume the repo

```bash
AE_REPO_CONFIG=/absolute/path/to/config.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
node scripts/control.mjs resume
```

### Disable the repo entirely

```bash
AE_REPO_CONFIG=/absolute/path/to/config.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
node scripts/control.mjs disable "parking repo until next budget window"
```

### Inspect a service

```bash
AE_REPO_CONFIG=/absolute/path/to/config.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
node scripts/service-control.mjs status reviewer
```

### Stop or start a service without tearing down Compose

```bash
AE_REPO_CONFIG=/absolute/path/to/config.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
node scripts/service-control.mjs stop validator

AE_REPO_CONFIG=/absolute/path/to/config.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
node scripts/service-control.mjs start validator
```

### Maintenance procedures

- [backup-restore.md](backup-restore.md)
- [upgrade-rollback.md](upgrade-rollback.md)

## Dashboard

Start the dashboard:

```bash
docker compose up -d dashboard
```

Endpoints:

- `GET /health`
- `GET /status`
- `GET /api/state`
- `GET /api/config`
- `POST /api/dispatcher/start`
- `POST /api/dispatcher/stop`
- `POST /api/dispatcher/pause`
- `POST /api/dispatcher/resume`
- `POST /api/service/<role>/start`
- `POST /api/service/<role>/stop`
- `POST /api/service/<role>/reset`

## Operational Pattern

1. Define a target milestone or label set.
2. Start the stack and let it work locally.
3. Watch the dashboard or state files for validator/reviewer/dispatcher progress.
4. Let the repo auto-pause when the target completes, or pause it manually.
5. Resume later when you want another processing window.

## Onboarding A New Target Repo

When a new target repo starts using `autonomous-engine`, follow:

- [target-repo-onboarding.md](/Users/john/Documents/Projects/autonomous-engine/docs/target-repo-onboarding.md)
- [github-settings-playbook.md](/Users/john/Documents/Projects/autonomous-engine/docs/github-settings-playbook.md)
- [network-docker-host-onboarding.md](/Users/john/Documents/Projects/autonomous-engine/docs/network-docker-host-onboarding.md)

That is the source of truth for:

- creating the `repo/<target-repo>` branch
- creating the repo config
- aligning GitHub settings with local Docker execution
- launching and verifying services on the network Docker host

## Repo-Focused Branch Deployments

For a local branch-deployment proof, run:

```bash
npm run smoke:local-service:branch-deploy
```

After deploying a repo-focused branch checkout to the Docker host, run the same
smoke harness from that deployed checkout to verify the local-only path is still
runnable there:

```bash
bash scripts/deploy-branch-to-host.sh \
  --transport ssh \
  --ssh-host <host> \
  --remote-repo-path <remote-autonomous-engine-path> \
  --env-file <branch-deployment.env> \
  --skip-launch

ssh <host> "cd <remote-autonomous-engine-path> && npm run smoke:local-service"
```

## Key Local-State Paths

```text
state/repos/<repo-key>/repo-state.json
state/repos/<repo-key>/meta/
state/repos/<repo-key>/logs/
state/repos/<repo-key>/worktrees/
state/repos/<repo-key>/run-logs/
state/repos/<repo-key>/outputs/
```
