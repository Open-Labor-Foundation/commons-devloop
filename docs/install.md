# Clean Docker Host Install

Use this guide to bring up `autonomous-engine` on a fresh customer-operated
Docker host. It assumes one target GitHub repository per stack.

For repo-specific setup, use the existing playbooks instead of duplicating the
details here:

- [target-repo-onboarding.md](target-repo-onboarding.md) for creating or
  reviewing `config/repos/<target-repo>.yaml`
- [github-settings-playbook.md](github-settings-playbook.md) for branch
  protection, runner, and PR settings
- [network-docker-host-onboarding.md](network-docker-host-onboarding.md) when
  Compose runs against a remote Docker host
- [operator-guide.md](operator-guide.md) for day-to-day service controls

## Prerequisites

Install or prepare these on the Docker host that will run the stack:

- Docker Engine with Docker Compose support
- Git access to the `autonomous-engine` bundle or repo
- a checkout of the target repository on the same Docker host
- GitHub authentication, either through `GH_TOKEN` in `.env` or `gh auth login`
  persisted in the `gh-config` volume
- Codex/OpenAI authentication persisted in the `codex-home` volume
- Node.js only if you want to run local host scripts such as
  `npm run validate:config` or `npm run smoke:local-service` outside Docker

When using a remote Docker context, all bind-mounted paths are resolved on the
remote Docker host, not on the operator laptop. In that mode,
`AE_TARGET_REPO_PATH` must be the target repo path on the remote host. See
[network-docker-host-onboarding.md](network-docker-host-onboarding.md) for the
remote deployment flow.

## 1. Choose Host Paths

Set the paths and repo config file for this installation:

```bash
export AE_ENGINE_DIR=/srv/autonomous-engine/repo-target-repo
export AE_TARGET_REPO_PATH=/srv/repos/target-repo
export AE_REPO_CONFIG_FILE=target-repo.yaml
export AE_DASHBOARD_PORT=4700
export AE_ENGINE_GIT_URL=git@github.com:customer/autonomous-engine.git
export AE_TARGET_REPO_GIT_URL=git@github.com:owner/target-repo.git
```

Clone or place the engine bundle and target repo at those paths:

```bash
sudo mkdir -p "$(dirname "$AE_ENGINE_DIR")" "$(dirname "$AE_TARGET_REPO_PATH")"
sudo chown -R "$USER":"$USER" "$(dirname "$AE_ENGINE_DIR")" "$(dirname "$AE_TARGET_REPO_PATH")"

git clone "$AE_ENGINE_GIT_URL" "$AE_ENGINE_DIR"
git clone "$AE_TARGET_REPO_GIT_URL" "$AE_TARGET_REPO_PATH"

cd "$AE_ENGINE_DIR"
```

The file `config/repos/$AE_REPO_CONFIG_FILE` must exist in the engine checkout.
For a new target repo, create it from `config/repos/template.yaml` and follow
[target-repo-onboarding.md](target-repo-onboarding.md).

## 2. Create `.env`

Create the minimum runtime `.env` file:

```bash
cat > .env <<EOF
AE_TARGET_REPO_PATH=$AE_TARGET_REPO_PATH
AE_REPO_CONFIG_FILE=$AE_REPO_CONFIG_FILE
AE_MODE=loop
AE_STATE_DIR=/engine/state
AE_WORKSPACE_DIR=/workspace/target-repo
AE_DASHBOARD_PORT=$AE_DASHBOARD_PORT
AE_DEFAULT_LOG_LEVEL=info
GH_TOKEN=${GH_TOKEN:-}
EOF
```

Minimum required values:

- `AE_TARGET_REPO_PATH`: absolute path to the target repo on the Docker host
- `AE_REPO_CONFIG_FILE`: file name under `config/repos/`
- `GH_TOKEN`: optional when `gh auth login` will be persisted in `gh-config`;
  required when you do not use persisted GitHub CLI auth

The other values above are stable defaults used by the Compose stack.

## 3. Build Or Pull The Image

If this host builds from the engine checkout, run:

```bash
docker compose build engine-image
```

The local build path uses default metadata:

```bash
AE_IMAGE_VERSION=0.1.0 \
AE_IMAGE_COMMIT_SHA=$(git rev-parse HEAD) \
AE_IMAGE_CREATED=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
docker compose build engine-image
```

Inspect the metadata labels on the image:

```bash
docker image inspect autonomous-engine:local --format '{{ json .Config.Labels }}' | jq .
```

## 4. Prepare Auth

If `GH_TOKEN` is populated in `.env`, verify GitHub access from a service
container:

```bash
docker compose run --rm reviewer gh auth status
```

If `GH_TOKEN` is blank, run a one-time GitHub CLI login. The login state is
stored in the named `gh-config` volume:

```bash
docker compose run --rm reviewer gh auth login
docker compose run --rm reviewer gh auth status
```

Run a one-time Codex/OpenAI login. The login state is stored in the named
`codex-home` volume:

```bash
docker compose run --rm reviewer codex login
```

## 5. Run Deployment Readiness

If Node is installed on the host, run the static readiness gate before building
or starting the stack:

```bash
npm ci
npm run predeploy:check -- \
  --config "$PWD/config/repos/$AE_REPO_CONFIG_FILE" \
  --target-path "$AE_TARGET_REPO_PATH"
```

The readiness gate checks the selected repo config, stack identity, Compose
project name, dashboard port, target repo path, and the default-on service set.
It does not start containers.

If Node is not available on the host yet, render the Compose config and validate
the selected repo config from the container once the image path is ready:

```bash
docker compose config >/tmp/autonomous-engine-compose.yaml
docker compose run --rm autonomous node scripts/validate-config.mjs
```

If Node is installed on the host and you want to run the local script directly:

```bash
npm ci
AE_REPO_CONFIG="$PWD/config/repos/$AE_REPO_CONFIG_FILE" npm run validate:config
```

## 6. Start The Stack

Start the standard local-service stack:

```bash
docker compose up -d autonomous dispatcher validator reviewer runner-manager pr-manager monitor dashboard
docker compose ps
```

Open the dashboard health endpoint:

```bash
curl -fsS "http://localhost:$AE_DASHBOARD_PORT/health"
printf 'Dashboard: http://localhost:%s\n' "$AE_DASHBOARD_PORT"
```

On a remote host, replace `localhost` with the host name or address that
exposes `AE_DASHBOARD_PORT`.

## 7. Smoke Test

Check repo lifecycle state and one service from inside the stack:

```bash
docker compose run --rm autonomous node scripts/control.mjs status
docker compose run --rm autonomous node scripts/service-control.mjs status dispatcher
```

Run the local-only acceptance harness with the existing script:

```bash
docker compose run --rm autonomous npm run smoke:local-service
```

If Node is installed on the host, the same harness can be run locally:

```bash
npm run smoke:local-service
```

If Node is installed on the host, use the existing branch deployment smoke
test:

```bash
npm run smoke:local-service:branch-deploy
```

## State And Auth Volume Behavior

The engine checkout is bind-mounted at `/engine`, so runtime state is written
under:

```text
state/repos/<repo-key>/
```

Expected persistent locations include:

- `state/repos/<repo-key>/meta/` for normalized runtime config
- `state/repos/<repo-key>/logs/` for service logs
- `state/repos/<repo-key>/worktrees/` for isolated validation and review
  worktrees
- `state/repos/<repo-key>/run-logs/` and `state/repos/<repo-key>/outputs/` for
  run artifacts
- `codex-home` named volume for Codex/OpenAI auth
- `gh-config` named volume for GitHub CLI auth
- `engine-node-modules` named volume so image-installed dependencies remain
  available even though the repo is bind-mounted over `/engine`
- `dashboard-dist` named volume so the image-built dashboard frontend remains
  available for the same reason (dashboard service only)

`docker compose down` stops and removes containers but keeps named volumes.
`docker compose down -v` removes named volumes and clears persisted Codex and
GitHub CLI auth. Back up or rotate these locations according to the customer
credential and retention policy.

Inspect the volumes with:

```bash
docker volume ls | grep -E 'codex-home|gh-config|engine-node-modules|dashboard-dist' || true
```
