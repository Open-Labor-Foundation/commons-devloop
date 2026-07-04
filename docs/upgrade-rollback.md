# Upgrade and Rollback

Use this document for Docker Compose upgrades and controlled rollback for
`autonomous-engine`.

## Upgrade flow

Set environment context:

```bash
cd /srv/autonomous-engine/repo-target-repo
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-autonomous-engine}"
export AE_ENGINE_IMAGE=registry.example.com/customer/autonomous-engine:1.2.3
export AE_PREVIOUS_IMAGE=registry.example.com/customer/autonomous-engine:1.1.0
export AE_REPO_CONFIG_FILE=target-repo.yaml
export AE_TARGET_REPO_PATH=/srv/repos/target-repo
export AE_REPO_CONFIG="$PWD/config/repos/$AE_REPO_CONFIG_FILE"
export AE_STATE_DIR="$PWD/state"
```

1. Capture current running image and config state:

```bash
docker compose ps
docker compose images
```

2. Validate config for the next image before pull:

```bash
AE_REPO_CONFIG="$AE_REPO_CONFIG" AE_STATE_DIR="$AE_STATE_DIR" node scripts/validate-config.mjs
```

Optional deployment gate (if Node and npm are available on the host):

```bash
npm run predeploy:check -- \
  --config "$AE_REPO_CONFIG" \
  --target-path "$AE_TARGET_REPO_PATH"
```

3. Back up before upgrade:

Perform the full backup flow from [`backup-restore.md`](backup-restore.md) and
record `BACKUP_TS` so rollback can reuse the snapshot.

4. Update image usage and rollout the new tag:

```bash
cd "$PWD"
docker compose down

printf '%s=%s\n' AE_ENGINE_IMAGE "$AE_ENGINE_IMAGE" > .env.new
if [ -f .env ]; then
  grep -v '^AE_ENGINE_IMAGE=' .env > .env.tmp || true
  mv .env.tmp .env
else
  : > .env
fi
cat .env.new >> .env
rm -f .env.new

AE_ENGINE_IMAGE="$AE_ENGINE_IMAGE" docker compose pull autonomous dispatcher validator reviewer runner-manager pr-manager monitor dashboard
AE_ENGINE_IMAGE="$AE_ENGINE_IMAGE" docker compose up -d --force-recreate autonomous dispatcher validator reviewer runner-manager pr-manager monitor dashboard
```

5. Post-upgrade checks:

```bash
docker compose ps
docker compose run --rm autonomous node scripts/control.mjs status
docker compose run --rm autonomous npm run smoke:local-service
```

## Rollback flow

Use rollback when the upgraded stack should not continue.

1. Stop current services:

```bash
docker compose down
```

2. Repoint at the known-good image:

```bash
export AE_ENGINE_IMAGE="$AE_PREVIOUS_IMAGE"
printf '%s=%s\n' AE_ENGINE_IMAGE "$AE_ENGINE_IMAGE" > .env.new
if [ -f .env ]; then
  grep -v '^AE_ENGINE_IMAGE=' .env > .env.tmp || true
  mv .env.tmp .env
else
  : > .env
fi
cat .env.new >> .env
rm -f .env.new
```

3. Restart with previous image:

```bash
AE_ENGINE_IMAGE="$AE_ENGINE_IMAGE" docker compose up -d --force-recreate autonomous dispatcher validator reviewer runner-manager pr-manager monitor dashboard
```

4. Reconcile state compatibility:

- If the downgraded image supports the current state layout, validate and continue.
- If compatibility is unknown, restore state from a pre-upgrade backup before
  validating service startup.

5. Validate rollback:

```bash
docker compose run --rm autonomous node scripts/control.mjs status
docker compose run --rm autonomous node scripts/service-control.mjs status validator
```

## State compatibility caveat

`state/repos/<repo-key>/` is preserved through upgrades, but a rollback can only be
safe if the state layout is forward/backward compatible.

- If compatibility is confirmed in release notes, you can resume with current state.
- If compatibility is not confirmed, restore the matching pre-upgrade
  `state/...` snapshot first and resume from there.
- For compatibility uncertainty plus corrupted state, perform a fresh restore using
  the documented procedure in [`backup-restore.md`](backup-restore.md).

## Cleanup expectation after upgrade or rollback

- Keep retention policy aligned with your active repo config:
  `retention.worktree_max_age_hours`, `retention.run_log_max_age_days`,
  `retention.output_max_age_days`.
- Review cleanup cadence and manual trims in
  [`backup-restore.md`](backup-restore.md).
