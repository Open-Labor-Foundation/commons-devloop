# Target Repo Onboarding

This document is the repeatable playbook Codex should follow whenever `autonomous-engine` starts managing a new target repo.

## Goal

For each new target repo:

1. create a long-lived engine branch for that repo
2. add a repo config under `config/repos/`
3. verify the target repo can be driven safely from local Docker
4. make the required GitHub-side settings changes
5. validate the local engine against that repo before autonomous runs begin
6. prepare and launch the stack on the network Docker host when remote testing is intended

## Codex Procedure

When the user asks Codex to onboard a new target repo, Codex should do this in order:

1. Update local `main` for `autonomous-engine`.
2. Create a new branch named `repo/<target-repo-name>`.
3. Copy [template.yaml](/Users/john/Documents/Projects/autonomous-engine/config/repos/template.yaml) to `config/repos/<target-repo-name>.yaml`.
4. Fill in the repo-specific values:
   - `repo.key`
   - `repo.github_slug`
   - `repo.default_branch`
   - `lifecycle.*`
   - `issue_source.*`
   - `models.*`
   - `validation.*`
   - `reviewer.*`
   - `runner_manager.*`
   - `safety.*`

   Leave the full standard stack enabled by default for the repo-focused branch. Set `roles.enabled.<role>: false` or a role-specific `enabled: false` only when the repo intentionally opts out of part of that stack.
5. Review the target repo’s existing workflows, branch protection, PR policy, and CI expectations.
6. Apply the GitHub settings checklist in this document.
7. Run the local verification commands in this document.
8. Apply the remote-host procedure in [network-docker-host-onboarding.md](/Users/john/Documents/Projects/autonomous-engine/docs/network-docker-host-onboarding.md) when the target repo is meant to run on the network Docker host, using `scripts/deploy-branch-to-host.sh` as the deployment path.
9. Commit the onboarding changes on the new `repo/<target-repo-name>` branch.
10. Push that branch to `origin`.

## GitHub Settings Checklist

Codex should verify and, when possible, apply the following settings on the target repo.

### Branch Protection

For the target repo’s protected branch, usually `main`:

- protect the branch
- require pull requests before merge
- only require the local validator status context named in `validation.context` when `validation.post_status` is `true`
- do not pin that required status check to the wrong source app when status posting is enabled
- keep force-push disabled unless the repo explicitly requires it

For V1 engine usage, the required status context should usually be `validate`.

### Local Merge Watcher

If the repo config enables automatic merge behavior:

- `pr-manager` is expected to merge from Docker after local validator and reviewer gates are satisfied
- GitHub auto-merge does not need to be enabled for this path
- local validator can remain fully Docker-local when `validation.post_status` is `false`

If `safety.auto_merge` is `false`, the local merge watcher should stay in observe-only mode.

### GitHub Actions And Self-Hosted Runners

If `runner_manager.enabled` is `true`, Codex should verify:

- GitHub Actions is enabled for the repo
- self-hosted runners are allowed for the repo or org
- the repo has access to the relevant runner group, if one is used
- the workflow labels in the target repo match `runner_manager.required_labels`

If `runner_manager.enabled` is `false`, no self-hosted runner setup is required.

### Workflow Expectations

Codex should inspect the target repo’s workflows and decide whether they should be:

- disabled for normal PR validation
- left as manual-only workflows
- redirected to self-hosted runners

The goal is to avoid duplicate validation when local validator/reviewer are the intended control path.

## Remote Deployment Path

When deploying a repo-focused branch to the network Docker host, use:

```bash
bash scripts/deploy-branch-to-host.sh \
  --ssh-host <host> \
  --remote-repo-path /srv/autonomous-engine/<branch-slug> \
  --env-file .env.remote
```

That path is deterministic because it syncs the exact local branch commit to the host, checks the remote revision after checkout, and fails closed on checkout or `.env` drift unless `--force` is used for an intentional repair.

Each checkout path is also bound to the last deployed branch and origin via `.ae-deploy-manifest.json`, so a clean host checkout that has been manually repurposed, moved off the recorded revision, or manually created outside this deployment flow is treated as drift until an operator intentionally repairs it with `--force`.

## Local Docker Expectations

Before enabling autonomous work, Codex should verify:

- the full standard stack starts from the repo-focused branch with `docker compose up -d` unless committed repo config disables a role
- the target repo can be mounted into `/workspace/target-repo`
- the validation commands run successfully from a worktree
- Codex CLI is available in the engine image
- `gh auth status` succeeds in the environment that will run the engine
- Docker socket access is available if `runner_manager.enabled` is `true`

## Network Docker Host Expectations

If the target repo is meant to run on the local-network Docker host, Codex should also follow:

- [network-docker-host-onboarding.md](/Users/john/Documents/Projects/autonomous-engine/docs/network-docker-host-onboarding.md)

That document is the source of truth for:

- Docker context selection
- remote path expectations
- remote auth persistence
- remote service launch
- remote health verification

## Verification Commands

Codex should run at least:

```bash
AE_REPO_CONFIG=/absolute/path/to/config/repos/<target-repo>.yaml \
node scripts/validate-config.mjs
```

```bash
AE_REPO_CONFIG=/absolute/path/to/config/repos/<target-repo>.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
node scripts/control.mjs status
```

```bash
AE_REPO_CONFIG=/absolute/path/to/config/repos/<target-repo>.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
AE_MODE=once node scripts/engine-role.mjs --role autonomous
```

```bash
AE_REPO_CONFIG=/absolute/path/to/config/repos/<target-repo>.yaml \
AE_STATE_DIR=/absolute/path/to/autonomous-engine/state \
node scripts/service-control.mjs status dispatcher
```

```bash
docker compose config
```

If the repo is intended to use reviewer and validator immediately, Codex should also run one-shot checks for those roles once the repo config is complete.

## Required Branch Output

Each repo branch should contain:

- `config/repos/<target-repo>.yaml`
- any repo-specific notes or runbook updates required to operate safely

The branch should not fork the reusable engine unless a repo-specific operational constraint truly requires it.
