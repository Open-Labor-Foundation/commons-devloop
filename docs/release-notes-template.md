# Licensed Container Release Notes Template

Copy this template for each licensed `autonomous-engine` container release.
Fill in every section before delivery.

## Release Summary

- Version:
- Release date:
- Operator:
- Customer or environment:
- Source branch:
- Source commit:
- Release manifest:
- Checksum file:

## Container Image

- Image tag:
- Image digest:
- Registry:
- Build command:
- Push command:

## Delivered Files

- Release manifest:
- Docs bundle:
- Config template:
- Image digest file:
- Checksum file:
- Other files:

## Upgrade Notes

Describe the supported upgrade path from the previous licensed release.
Include required operator actions, expected downtime, config changes, auth
changes, state migration steps, and any Docker host prerequisites.

- Previous version:
- Required config changes:
- Required `.env` changes:
- State or volume handling:
- Expected service restart command:

```bash
docker compose pull autonomous dispatcher validator reviewer runner-manager pr-manager monitor dashboard
docker compose up -d autonomous dispatcher validator reviewer runner-manager pr-manager monitor dashboard
```

## Rollback Notes

Describe how to return to the previous known-good image and config. Include the
previous image tag or digest, config backup location, state handling, and the
command used to restart services.

- Previous image tag or digest:
- Previous config backup:
- State or volume handling:
- Rollback command:

```bash
docker compose down
AE_ENGINE_IMAGE=<previous-image-tag-or-digest> docker compose up -d
```

## Known Limitations

List limitations that matter to the customer or support operator. Include
manual steps, unsupported deployment modes, missing automation, operational
risks, or known issues in this release.

- Limitation:
- Impact:
- Workaround:

## Validation Results

- `npm test` result:
- Config validation command:
- Config validation result:
- Image build result:
- Release manifest result:
- Smoke harness command:
- Smoke harness result:
- Checksum verification result:

## Support Bundle Instructions

When opening a support request, include the release identifiers and a support
bundle with the relevant local state. Do not include Codex/OpenAI credentials,
GitHub tokens, or customer secrets.

Collect these identifiers:

- Version:
- Source commit:
- Image tag:
- Image digest:
- Release manifest:
- Checksum file:

Collect these files or directories when available:

```text
state/repos/<repo-key>/repo-state.json
state/repos/<repo-key>/meta/
state/repos/<repo-key>/logs/
state/repos/<repo-key>/run-logs/
state/repos/<repo-key>/outputs/
.ae-deploy-manifest.json
```

Create a support bundle from the engine checkout:

```bash
tar --ignore-failed-read -czf support-bundle-<repo-key>-<version>.tar.gz \
  state/repos/<repo-key>/repo-state.json \
  state/repos/<repo-key>/meta \
  state/repos/<repo-key>/logs \
  state/repos/<repo-key>/run-logs \
  state/repos/<repo-key>/outputs \
  .ae-deploy-manifest.json
```

Before sending, review the archive contents:

```bash
tar -tzf support-bundle-<repo-key>-<version>.tar.gz
```

## Support Contacts

- Customer owner:
- Support owner:
- Escalation path:
- Ticket or case link:
