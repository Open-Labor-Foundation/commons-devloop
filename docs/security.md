# Security and Trust Boundaries

This document reflects current `v1` compose/config behavior in this repository.

## Runtime Trust Map

### Mounted Inputs

- Target repository mount:
  - `AE_TARGET_REPO_PATH` is bind-mounted into each role container at
    `config.repo.workspace_dir`, which defaults to `AE_WORKSPACE_DIR` or
    `/workspace/target-repo`.
  - `compose.yaml` also mounts the engine checkout at `/engine`.
- State root:
  - `AE_STATE_DIR` is mounted at `/engine/state` for all role containers.
  - Runtime state is stack-scoped at
    `${AE_STATE_DIR}/stacks/<stack-id>/repos/<repo-key>/...` (config and tests
    can be seen from `scripts/control.mjs identity`).
- Auth volumes:
  - `codex-home` is mounted at `/engine/.codex`.
  - `gh-config` is mounted at `/root/.config/gh`.
  - `engine-node-modules` carries runtime image dependencies.
  - `dashboard-dist` carries the image-built dashboard frontend (dashboard service only).

### GitHub and Codex Auth Paths

- GitHub token / CLI auth:
  - `GH_TOKEN` is passed into each role as an environment variable.
  - `GH_CONFIG_DIR=/root/.config/gh` points `gh` at the mounted `gh-config`
    volume.
  - `scripts/lib/github.mjs` invokes `gh` for issue/PR listing, status/review
    posts, and merge updates.
  - Before first git-over-SSH operations, runtime calls `gh auth setup-git`.
- Codex auth:
  - `CODEX_HOME=/engine/.codex` is passed to Codex invocations.
  - Dispatcher and reviewer create temporary isolated copies of these files while
    executing to run side-by-side.
  - `scripts/lib/runtime.mjs` expects `auth.json`, `config.toml`, and
    `.codex-global-state.json` in the mounted Codex home.

## Docker Socket Access

Only two services mount the host Docker socket in `compose.yaml`:

- `runner-manager`
  - mounts `/var/run/docker.sock` read-write
  - manages container lifecycle operations required for self-hosted runner
    management
  - reads queued workflows and lists runner containers via `docker ps`
- `dashboard`
  - mounts `/var/run/docker.sock` read-only
  - collects host container observability for the dashboard UI
  - uses Docker state for service health and lifecycle visibility

All other standard services (`autonomous`, `dispatcher`, `validator`,
`reviewer`, `pr-manager`, and `monitor`) intentionally do not mount the Docker
socket by default.

If either Docker socket mount changes in the future, update both `compose.yaml`
and this document in the same PR because these are defense-relevant deployment
permissions.

## Write Boundaries and Safety Controls

- PR-only flow:
  - Dispatcher/validator/reviewer are PR-oriented by design and consume work from
    open PRs by default.
  - The following settings are currently recorded in policy:
    - `safety.pr_only`
    - `safety.protected_branches`
    - `safety.protected_paths`
    - `safety.allow_force_push`
  - Current runtime code does not currently enforce full branch/path/force-push
    guardrails internally; those controls should be enforced in GitHub branch
    protection and repository process.
- `pr_manager.auto_merge`/`pr_manager.auto_merge_label` control when local merge
  can proceed, subject to local validator/reviewer outcomes and `validation`
  command status.
- GitHub remains source of record for merge and branch state transitions.

## Secret Handling Expectations and Limits

- Secret sources are host-managed:
  - `.env` values (including optional `GH_TOKEN`)
  - `gh-config` volume
  - `codex-home` volume
- No separate secret vault or broker is shipped in this runtime.
- Service logs and run logs may include command output, arguments, and failures.
  Redaction is not globally enforced.
- `state/...` files are durable operator data and should be protected as
  sensitive config/artifacts.

## Known Limitations (current implementation)

- No built-in authentication/authorization layer exists on dashboard HTTP
  endpoints.
- Safety policy fields (`pr_only`, protected branch/path lists, force-push flag)
  are policy configuration first; they are not yet hard-enforced everywhere.
- Docker socket access for the dashboard and `runner-manager` increases
  container impact radius if compromised.

## Operator Hardening Recommendations

- Keep the Docker host isolated from untrusted tenants and lock it down with
  normal host hardening.
- Treat `codex-home`, `gh-config`, and `.env` as secrets; rotate them with
  operator runbook cadence.
- Prefer least-privilege GitHub credentials:
  - use a service account token/credential set scoped to required repo actions.
- Do not expose the dashboard to untrusted networks; bind/route it through an
  operator-only access path.
- Maintain GitHub branch protection for the target repo:
  - require PR flow,
  - keep force-push disabled unless explicitly required,
  - keep validation status checks aligned to local workflow.
- Keep `safety.protected_branches`, `safety.protected_paths`,
  `safety.allow_force_push`, and `safety.require_clean_worktree_before_run` in
  repo config as explicit review items before enabling a new target repo.
