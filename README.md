# commons-devloop

A self-hosted autonomous development engine for any GitHub repository.

commons-devloop replaces GitHub Actions as the execution layer for repository automation. It runs entirely in Docker — on your own hardware, on your own schedule, using your own model quotas — and only touches GitHub to retrieve issues and submit pull requests. Everything in between happens locally.

Point it at a repository with open issues. It picks them up, writes code, opens pull requests, validates them, reviews them, and merges them — continuously, without per-cycle human intervention. You define the policies. It does the work.

> **Experimental release.** This is functional but still early — rough edges exist. See [CONTRIBUTING.md](CONTRIBUTING.md) for current contribution status.

> **Known shortcomings:** see [open-labor-foundation/ARCHITECTURE.md](https://github.com/Open-Labor-Foundation/open-labor-foundation/blob/main/ARCHITECTURE.md)
> for the full ecosystem picture. commons-devloop is actively in use, but
> transitional: its job — turning a defined need into working, reviewed code
> — is exactly the build capability commons-board is currently missing
> internally. Once commons-crew's recursive delegation gives commons-board
> native build capacity, an external automation engine doing the same job
> from outside the governed structure is expected to be retired or absorbed
> rather than maintained indefinitely as separate infrastructure.

---

## What it does

The engine runs eight coordinated services:

- **Dispatcher** — picks up issues matching your configured labels, creates work branches, routes to the appropriate coding lane
- **Coding lanes** — parallel model workers (cloud models, local self-hosted models, or both) that generate code against the issue spec
- **Validator** — pulls each branch into a local worktree, runs your test suite, reports pass/fail
- **Reviewer** — runs an AI-backed code review on each PR, posts inline comments, flags issues
- **PR Manager** — watches validation and review gates, merges when both pass
- **Runner Manager** — manages self-hosted GitHub Actions runners for any CI workflows that remain
- **Monitor** — watches repo health, controls pause/resume based on budget thresholds and milestone state
- **Dashboard** — browser UI for observing and controlling the running engine in real time

---

## Multi-lane, multi-model

`models.dispatcher.lanes` is an arbitrary-length list — configure as many lanes as you want, mixing providers freely:

- **`hosted_codex`** — OpenAI's Codex CLI
- **`openai_compatible`** — any OpenAI-compatible hosted or self-hosted API, including [Featherless.ai](https://featherless.ai) (the documented, cost-efficient default for this org), with per-lane API keys settable through the dashboard or an env var
- **`local_container`** — a local model runtime (Ollama or LM Studio) that the engine manages the lifecycle of, running on your own hardware at no marginal token cost
- Per-lane quota tracking with dynamic allocation based on remaining quota and time-to-reset

Which lanes to run, and in what mix, is entirely your choice — see [`docs/config-reference.md`](docs/config-reference.md) for the full lane schema and [`config/repos/template.yaml`](config/repos/template.yaml) for a worked example. The engine maximizes throughput within your available quota windows rather than burning through them, and weekly/daily reserve floors prevent unexpected overages.

---

## Per-repo deployment model

Each target repository gets its own branch of commons-devloop and its own container stack. Configuration lives in a single YAML file per repo. Improvements to the engine merge to main and propagate to all deployed branches.

---

## Who it is for

**Collectives and organizations** in the Open Labor Foundation stack that need to build and ship software without a dedicated engineering team.

**Technical users** who want to run autonomous development cycles on their own repositories with full local control over execution, cost, and model selection.

---

## Getting started

Requirements: Docker, Docker Compose, a GitHub token with repo and workflow scopes.

1. Copy `.env.example` to `.env` and fill in the required values
2. Copy `config/repos/template.yaml`, fill it in for your target repository
3. Start the stack:

```bash
docker compose up
```

The dashboard is available at `http://localhost:4700`. Set `AE_DASHBOARD_TOKEN` in `.env` before exposing it beyond your own machine — without it, anyone who can reach the port can pause services or trigger control actions with no credential at all.

See `docs/install.md` for the complete setup guide and `docs/config-reference.md` for all configuration options.

---

## Part of the Open Labor Foundation

This repository is part of the [Open Labor Foundation](https://github.com/Open-Labor-Foundation/open-labor-foundation) software stack.

Licensed under [AGPL-3.0](LICENSE).
