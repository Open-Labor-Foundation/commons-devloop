# Data Governance

## Privacy Goal

The local lane should avoid sending issue content and source code to hosted model services for reasoning.

## Data That May Remain External

GitHub may still be used as the control plane for:

- issues
- pull requests
- comments
- statuses
- merge operations

This is acceptable because the feature goal is local reasoning and coding execution, not removing GitHub from AE.

## Local Data

Local lane artifacts include:

- worktrees
- run logs
- output files
- local runtime logs
- model cache

These should remain in Docker-managed volumes or AE state paths.

## Sensitive Data

Logs must not include:

- tokens
- auth headers
- private keys
- full environment dumps
- local model credentials if any are used

## Retention

Use existing AE retention for run artifacts. Model cache should be retained separately and should not be cleared by normal run-log cleanup.

