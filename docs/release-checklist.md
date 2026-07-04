# Licensed Container Release Checklist

Use this checklist to prepare a licensed `autonomous-engine` container release
from a local checkout. It documents the current manual commands and does not
assume a release CI pipeline.

## Release Inputs

Record these values before starting:

```bash
export AE_RELEASE_VERSION=<version>
export AE_IMAGE_TAG=<registry>/<customer>/autonomous-engine:<version>
export AE_REPO_CONFIG_FILE=<target-repo>.yaml
export AE_CONFIG_TEMPLATE=config/repos/template.yaml
export AE_RELEASE_DIR=dist/releases/$AE_RELEASE_VERSION
export AE_DOCS_BUNDLE=$AE_RELEASE_DIR/operator-docs.tar.gz
mkdir -p "$AE_RELEASE_DIR"
```

- Version:
- Source branch:
- Source commit:
- Image tag:
- Image digest:
- Target repo config file:
- Operator:
- Release date:

## 1. Confirm The Source State

- Check out the release branch or commit.
- Confirm the commit that will be released:

```bash
git rev-parse HEAD
git status --short
```

- If the tree is dirty, either commit the change or record why it is included
  in the release notes.
- Confirm the customer config template and docs paths that will be included in
  the release manifest.

## 2. Run Repository Tests

Install dependencies and run the current test suite:

```bash
npm ci
npm test
```

Record the result:

- Test command:
- Result:
- Notes:

## 3. Run Deployment Readiness

Run the static readiness gate for the target repo config selected for the
release:

```bash
npm run predeploy:check -- \
  --config "$PWD/config/repos/$AE_REPO_CONFIG_FILE" \
  --target-path <absolute-target-repo-path>
```

Capture JSON output when the release record needs machine-readable proof:

```bash
npm run predeploy:check -- \
  --config "$PWD/config/repos/$AE_REPO_CONFIG_FILE" \
  --target-path <absolute-target-repo-path> \
  --json > "$AE_RELEASE_DIR/predeploy-check.json"
```

This check validates config loading, stack identity, Compose project name,
dashboard port, target repo path, and the default-on service set. It does not
build images or launch containers.

Record the result:

- Config file:
- Target repo path:
- Result:
- Notes:

## 4. Build The Licensed Image

Build the shared engine image with the release image tag:

```bash
AE_ENGINE_IMAGE="$AE_IMAGE_TAG" docker compose build engine-image
```

Inspect the local image:

```bash
docker image inspect "$AE_IMAGE_TAG" \
  --format 'id={{.Id}} created={{.Created}}'
```

If this release is pushed to a registry, push it and record the immutable
digest:

```bash
docker push "$AE_IMAGE_TAG"
docker image inspect "$AE_IMAGE_TAG" \
  --format '{{index .RepoDigests 0}}' \
  > "$AE_RELEASE_DIR/image-digest.txt"
```

Record the result:

- Build command:
- Push command:
- Image ID:
- Image digest:
- Notes:

## 5. Build The Docs Bundle

Create the operator docs bundle that will be delivered with the image:

```bash
tar -czf "$AE_DOCS_BUNDLE" README.md docs
```

Review the customer-facing docs before packaging or delivering them:

- [install.md](install.md)
- [operator-guide.md](operator-guide.md)
- [config-reference.md](config-reference.md)
- [release-notes-template.md](release-notes-template.md)

Record the result:

- Docs bundle:
- Reviewed by:
- Notes:

## 6. Generate The Release Manifest

Generate the manifest with checksums for the config template, docs bundle, and
other delivered files:

```bash
node scripts/release-manifest.mjs \
  --version "$AE_RELEASE_VERSION" \
  --image-tag "$AE_IMAGE_TAG" \
  --config-template "$AE_CONFIG_TEMPLATE" \
  --docs-bundle "$AE_DOCS_BUNDLE" \
  --file "$AE_RELEASE_DIR/image-digest.txt" \
  --build-source manual \
  --out "$AE_RELEASE_DIR/release-manifest.json"
```

Review the manifest warnings:

```bash
node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(m.warnings)" \
  "$AE_RELEASE_DIR/release-manifest.json"
```

Record the result:

- Manifest path:
- Warnings:
- Notes:

## 7. Generate Checksums

Generate a checksum file for the deliverables:

```bash
sha256sum \
  "$AE_RELEASE_DIR/release-manifest.json" \
  "$AE_RELEASE_DIR/image-digest.txt" \
  "$AE_DOCS_BUNDLE" \
  > "$AE_RELEASE_DIR/SHA256SUMS"
```

Verify the checksum file:

```bash
sha256sum -c "$AE_RELEASE_DIR/SHA256SUMS"
```

Record the result:

- Checksum file:
- Verification result:
- Notes:

## 8. Run The Smoke Harness

Run the local-only smoke harness:

```bash
npm run smoke:local-service
```

If the release is for a repo-focused branch deployment, also run:

```bash
npm run smoke:local-service:branch-deploy
```

If validating inside Compose on the release host, run:

```bash
docker compose run --rm autonomous npm run smoke:local-service
```

Record the result:

- Smoke command:
- Result:
- Harness output path or summary:
- Notes:

## 9. Complete Release Notes

Copy [release-notes-template.md](release-notes-template.md), fill in every
section, and save the completed notes with the release artifacts.

Confirm the notes include:

- version
- commit
- image tag and digest
- upgrade notes
- rollback notes
- known limitations
- support bundle instructions

## 10. Final Release Review

Before delivery, confirm:

- Tests passed.
- Config validation passed.
- Image build completed.
- Image digest is recorded.
- Manifest was generated.
- Manifest warnings were reviewed.
- Smoke harness passed or an explicit exception is documented.
- Docs were reviewed.
- Checksums were generated and verified.
- Release notes are complete.
- Deliverables are stored in the release directory.

Release approver:

Approval date:

Delivery notes:
