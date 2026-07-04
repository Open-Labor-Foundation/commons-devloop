# Support bundle export

This document describes how to generate a sanitized support bundle for
troubleshooting a deployment.

## What it is

`node scripts/support-bundle.mjs` collects operator-relevant telemetry from the
configured repo and state directory and writes it as machine-readable JSON.
The bundle is intended for troubleshooting and sharing with support staff.

## Usage

```bash
AE_REPO_CONFIG=/engine/config/repos/commons-devloop.yaml \
AE_STATE_DIR=/engine/state \
node scripts/support-bundle.mjs \
  --config /engine/config/repos/commons-devloop.yaml \
  --state-dir /engine/state \
  --env-file /engine/.env \
  --json \
  --out /tmp/support-bundle.json

node scripts/support-bundle.mjs --help
```

Optional output formats:

- `--json` (default): writes JSON payload to stdout or `--out`.
- `--zip`: writes a zip archive containing `support-bundle.json`.
- `--tar`: writes a tar archive containing `support-bundle.json`.
- `--out` works with `--json`, `--zip`, and `--tar`.

## What is included

- Stack identity (`stackId`, `repoKey`, `stateRoot`) resolved from the effective
  runtime environment.
- Config summary:
  - parsed config path
  - raw and normalized config snapshots
  - parse warning fields when config is unavailable
- Repo state:
  - `repo-state.json` snapshot (if available)
  - `meta/control.json` snapshot (if available)
- Service state:
  - service state JSONs under `state/repos/<repo>/meta/*.json`
  - service config JSONs under `state/repos/<repo>/*-config.json`
- Recent service log tail from each `.log` file under `state/repos/<repo>/logs`.
- Version image metadata when available:
  - `package.json` name/version/private
  - compose `services.*.image` values
  - git commit and dirty status

## What is not included

- Worktree file contents are not included.
- Full raw `.env` content is not included; only a sanitized summary is included.
- Secret-bearing values are redacted.

## Redaction behavior

Obvious secret-bearing values are redacted using conservative patterns for:

- `token`, `secret`, `password`, `api key`-style keys
- Bearer-style auth headers
- common token formats (for example `ghp_...`, `ghs_...`, `sk-...`, JWT-like values)

The sanitizer is intentionally conservative and removes any obvious matches while
preserving non-secret diagnostics needed for troubleshooting.
