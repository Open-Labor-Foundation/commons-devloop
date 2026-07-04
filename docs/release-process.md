# Release Packaging Process

Use `node scripts/package-release.mjs` to create a local, install-ready release
artifact bundle for customer delivery.

## Goal

Produce a deterministic package containing the reusable engine files customers need
alongside the container image (compose/docs/config/templates/checksums/manifest).

## Inputs

- `AE_RELEASE_VERSION`: release version used for default `dist/releases/<version>`
  output path.
- Optionally `AE_RELEASE_MANIFEST` pointing at a generated release manifest.

## Default package contents

The script includes:

- `compose.yaml`
- `.env.example`
- `config/predeploy.matrix.yaml`
- `config/repo.schema.yaml`
- `config/repos/template.yaml`
- `config/repos/example.yaml`
- `docs/install.md`
- `docs/operator-guide.md`
- `docs/release-notes-template.md`
- `docs/release-process.md`
- `release-manifest.json` when `AE_RELEASE_MANIFEST` is present or when
  `dist/release-manifest.json` exists.

It also writes `SHA256SUMS.txt` for packaged text artifacts.

## Commands

```bash
export AE_RELEASE_VERSION=1.2.3
export AE_RELEASE_MANIFEST=dist/release-manifest.json
node scripts/package-release.mjs
```

Use an explicit path for a custom output directory:

```bash
node scripts/package-release.mjs --out-dir /tmp/releases/1.2.3
```

## Exclusions

The packaging process does not include:

- `state/`
- `.env` files and `.env*` files
- local auth/state mounts (`.codex`, `node_modules`, `auth`, `.ae-deploy-manifest.json`)
- target repo content and `target/`

## Validation

1. Confirm `SHA256SUMS.txt` exists in the package.
2. Confirm `release-manifest.json` exists when generated.
3. Confirm only the documented customer-facing artifacts are present in the package.
