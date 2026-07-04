# Branch Strategy

## Recommendation

Use one long-lived branch per target repo that `autonomous-engine` is configured to operate against.

Examples:

- `repo/olf-agent-pa`
- `repo/olf-agents`
- `repo/my-other-repo`

This is the right fit for this project because the engine itself is shared, but the effective operating contract changes by target repo:

- repo config
- model lane choices
- validator commands
- reviewer instructions
- runner labels and image choices
- safety policy
- milestone and pause behavior

Those differences are operationally significant enough that keeping them on per-target branches is cleaner than mixing them all on one mutable branch.

## What Stays On `main`

`main` should hold the reusable, target-agnostic engine:

- shared container image
- shared scripts
- shared control plane
- shared docs
- shared config schema

## What Lives On Per-Repo Branches

Per-target branches should carry only the repo-specific layer:

- `config/repos/<repo>.yaml`
- repo-specific defaults
- repo-specific docs or runbooks if needed
- temporary tuning for that target repo

## Operational Model

1. Keep `main` as the reusable engine baseline.
2. Create one branch per target repo.
3. Add `config/repos/<target-repo>.yaml` on that branch.
4. Apply the onboarding steps in [target-repo-onboarding.md](/Users/john/Documents/Projects/autonomous-engine/docs/target-repo-onboarding.md).
5. Define the default QA readiness profile in `config/predeploy.matrix.yaml` for that branch.
6. Run `npm run predeploy:check` before deploying to prove the profile has a valid config, target path, required service defaults, isolated stack identity, compose project name, and dashboard port. Add optional variant profiles only when a release needs them.
7. Point the engine at that repo using the branch’s config.
8. Merge reusable engine improvements back to `main`.
9. Rebase or merge `main` into per-repo branches as the engine evolves.

## Why Not One Branch Per Work Item

The engine already creates work branches inside the target repo it is operating on. Creating engine-repo branches per work item would mix two levels of branching:

- engine maintenance
- target-repo work execution

That would create unnecessary operational noise.

## Naming Guidance

Prefer:

- `repo/<github-repo-name>`

Avoid:

- target-specific feature branches for normal engine use
- encoding milestone names into the engine branch name
- one branch per autonomous run

## Initial Branches

For your current usage, the first two sensible long-lived branches are:

- `main`
- `repo/olf-agent-pa`
