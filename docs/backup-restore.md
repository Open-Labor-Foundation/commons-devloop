# Backup and Restore

Use this procedure for Docker Compose deployments when you need a point-in-time
recovery for an `autonomous-engine` stack.

## What to include in backup

- `state/` (or `$AE_STATE_DIR`) runtime data:
  - `state/repos/<repo-key>/repo-state.json`
  - `state/repos/<repo-key>/meta/`
  - `state/repos/<repo-key>/logs/`
  - `state/repos/<repo-key>/worktrees/`
  - `state/repos/<repo-key>/run-logs/`
  - `state/repos/<repo-key>/outputs/`
- repo configs:
  - `config/repos/`
- environment:
  - `.env`
- named volumes:
  - `codex-home`
  - `gh-config`

## Stop → backup → start flow

Set common variables before running these commands:

```bash
export AE_ENGINE_DIR=/srv/autonomous-engine/repo-target-repo
export AE_REPO_CONFIG_FILE=target-repo.yaml
export AE_STATE_DIR="${AE_ENGINE_DIR}/state"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-autonomous-engine}"
export REPO_KEY=autonomous-engine
export BACKUP_ROOT=/srv/autonomous-engine/backups
export BACKUP_TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_ROOT/$BACKUP_TS"
```

1. Stop services to avoid state writes during backup:

```bash
cd "$AE_ENGINE_DIR"
docker compose down
```

2. Back up environment and repo configuration:

```bash
tar -czf "$BACKUP_ROOT/$BACKUP_TS/autonomous-engine-config.tar.gz" \
  -C "$AE_ENGINE_DIR" \
  .env \
  config/repos/"$AE_REPO_CONFIG_FILE"
```

3. Back up engine state:

```bash
tar -czf "$BACKUP_ROOT/$BACKUP_TS/autonomous-engine-state.tar.gz" \
  -C "$AE_STATE_DIR" \
  repos
```

4. Back up Codex and GitHub auth volumes:

```bash
docker run --rm \
  -v "${COMPOSE_PROJECT_NAME}_codex-home:/volume:ro" \
  -v "$BACKUP_ROOT/$BACKUP_TS:/backup" \
  alpine:3.22 sh -c 'cd /volume && tar -czf /backup/codex-home.tar.gz .'

docker run --rm \
  -v "${COMPOSE_PROJECT_NAME}_gh-config:/volume:ro" \
  -v "$BACKUP_ROOT/$BACKUP_TS:/backup" \
  alpine:3.22 sh -c 'cd /volume && tar -czf /backup/gh-config.tar.gz .'
```

5. Start the stack again:

```bash
docker compose up -d autonomous dispatcher validator reviewer runner-manager pr-manager monitor dashboard
```

## Restore from backup

Use this process when a machine or stack is recreated, or when state/config
corruption requires reverting to a known good backup.

1. Stop and clear running containers:

```bash
cd "$AE_ENGINE_DIR"
docker compose down
```

2. Restore environment and config:

```bash
mkdir -p "$AE_ENGINE_DIR"
tar -xzf "$BACKUP_ROOT/$BACKUP_TS/autonomous-engine-config.tar.gz" \
  -C "$AE_ENGINE_DIR"
```

3. Restore engine state:

```bash
tar -xzf "$BACKUP_ROOT/$BACKUP_TS/autonomous-engine-state.tar.gz" \
  -C "$AE_STATE_DIR"
```

4. Restore auth volumes:

```bash
mkdir -p "$BACKUP_ROOT/$BACKUP_TS"

docker run --rm \
  -v "${COMPOSE_PROJECT_NAME}_codex-home:/volume" \
  -v "$BACKUP_ROOT/$BACKUP_TS:/backup" \
  alpine:3.22 sh -c 'rm -rf /volume/* /volume/.[!.]* /volume/..?* && cd /volume && tar -xzf /backup/codex-home.tar.gz .'

docker run --rm \
  -v "${COMPOSE_PROJECT_NAME}_gh-config:/volume" \
  -v "$BACKUP_ROOT/$BACKUP_TS:/backup" \
  alpine:3.22 sh -c 'rm -rf /volume/* /volume/.[!.]* /volume/..?* && cd /volume && tar -xzf /backup/gh-config.tar.gz .'
```

5. Start the stack and verify:

```bash
docker compose up -d autonomous dispatcher validator reviewer runner-manager pr-manager monitor dashboard
docker compose run --rm autonomous node scripts/control.mjs status
```

## Cleanup and retention expectations

Expected retention targets are also enforced by runtime config (`retention`) and are
important for disk control:

- worktrees: age-based cleanup via `retention.worktree_max_age_hours` (default `6`)
- run logs: age-based cleanup via `retention.run_log_max_age_days` (default `2`)
- outputs: age-based cleanup via `retention.output_max_age_days` (default `2`)

To run an operator-initiated cleanup outside service cycles, stop the stack first.

```bash
cd "$AE_STATE_DIR"

find "repos/$REPO_KEY/worktrees" -mindepth 1 -maxdepth 1 -type d -mtime +7 -print
find "repos/$REPO_KEY/worktrees" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +

find "repos/$REPO_KEY/logs" -type f -mtime +14 -print
find "repos/$REPO_KEY/logs" -type f -mtime +14 -delete

find "repos/$REPO_KEY/run-logs" -type f -mtime +3 -print
find "repos/$REPO_KEY/run-logs" -type f -mtime +3 -delete

find "repos/$REPO_KEY/outputs" -type f -mtime +3 -print
find "repos/$REPO_KEY/outputs" -type f -mtime +3 -delete
```

Tune thresholds after editing the active repo config and confirm them in
`docs/config-reference.md`.
