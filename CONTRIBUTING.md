# Contributing to autonomous-engine

> **A note on contributions:** This repository is public for transparency, but is not yet accepting external issues or pull requests directly. Issues are disabled repo-wide, and pull requests from outside collaborators aren't reviewed at this stage. This is expected to change as the project matures — check back, or watch [openlabor.foundation](https://openlabor.foundation) for updates.

> **A note on contributions:** This repository is public for transparency, but is not yet accepting external issues or pull requests directly. Issues are disabled repo-wide, and pull requests from outside collaborators aren't reviewed at this stage. This is expected to change as the project matures — check back, or watch [openlabor.foundation](https://openlabor.foundation) for updates.

autonomous-engine is an infrastructure project. Contributions are engineering-focused.

---

## Before you start

Open an issue before beginning significant work. The engine has strong opinions about how services interact — a design conversation upfront saves rework.

For bug reports, include:
- Which service produced the unexpected behavior (dispatcher, validator, reviewer, PR manager, monitor, runner manager, dashboard)
- Docker and compose version
- Relevant log output

---

## Making a contribution

1. Fork the repository
2. Create a branch: `issue-<number>-<short-description>`
3. Make your changes
4. Test against a real repository with open issues — unit tests are not sufficient for verifying lane behavior
5. Open a pull request with a clear description of what changed and why

---

## What is in scope

- Bug fixes in any service
- Coding lane improvements (cloud model providers, local model providers, quota tracking)
- Validator and reviewer improvements
- Dashboard features
- Documentation corrections
- Performance and reliability improvements

## What is out of scope

- Features that require a cloud dependency not already present
- Changes that break the per-repo deployment model
- Proprietary provider integrations that cannot be contributed back under AGPL-3.0

---

## Code standards

- Services are Node.js — follow the patterns already established in each service directory
- Configuration belongs in `config/` — services read it, they do not embed it
- Secrets always come from environment variables, never from committed files
- New services follow the same compose and healthcheck patterns as existing services

---

## License

All contributions are made under the [AGPL-3.0 license](LICENSE). By submitting a contribution, you agree that your contribution is available under these terms.
