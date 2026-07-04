# GitHub Settings Playbook

This document tells Codex exactly what GitHub-side settings to verify when onboarding a target repo into `autonomous-engine`.

## Principle

`autonomous-engine` replaces GitHub-hosted execution where local Docker can do the work better, but GitHub still remains the system of record for:

- issues
- pull requests
- commit statuses
- posted reviews and comments
- merge state and merge execution targets
- workflow queue visibility when runner-manager is enabled

That means the GitHub setup must support local services without fighting them.

## Required For Most Target Repos

### Protected Branch Setup

For the repo’s protected base branch, usually `main`:

- require pull requests before merge
- only require the validator status context defined in `validation.context` when `validation.post_status` is `true`
- do not bind that required status check to the wrong source app when status posting is enabled
- keep force-push disabled unless explicitly required

### Local Validator Alignment

If `validation.post_status` is `true`:

- the branch protection rules must accept that status context as merge-blocking evidence
- the repo should not depend on a separate GitHub-hosted validation workflow for the same purpose unless intentionally duplicated

### Reviewer Alignment

If `reviewer.enabled` is `true`:

- the repo must allow PR comments or reviews from the authenticated operator identity
- review policy source should exist at `reviewer.instructions_path`, or Codex should update the config to point somewhere real

### Local Merge Watcher Alignment

If `safety.auto_merge` is `true`:

- the local `pr-manager` is expected to decide merge readiness from local validator and reviewer results
- GitHub auto-merge does not need to be enabled for this model
- branch protection must only require the local validator status when that status is being posted

## Required Only For Runner-Manager Usage

If `runner_manager.enabled` is `true`, Codex must also verify:

- GitHub Actions is enabled
- self-hosted runners are allowed for the repo or org
- the repo has access to the correct runner group, if used
- target workflows use labels that match `runner_manager.required_labels`

If any of those are false, Codex should treat runner-manager onboarding as incomplete.

## What Codex Should Record

When onboarding a target repo, Codex should confirm these items in the branch commit message or operator note:

- protected branch base name
- validator status context
- whether local PR merge is enabled
- whether runner-manager is enabled
- whether target workflows were left hosted, made manual-only, or pointed to self-hosted labels

## Failure Conditions

Codex should stop and report a setup gap if:

- branch protection requires a local validator status that the stack is not configured to post
- required status checks are pinned to an incompatible source app
- runner-manager is enabled but self-hosted runners are not allowed
- the target repo workflows still assume GitHub-hosted validation while the engine is meant to replace it
