# Developer Standards

## Implementation Style

Follow existing AE patterns:

- Node ESM modules
- YAML config parsing through existing config helpers
- Docker compose stack integration
- state files under existing repo state layout
- node test runner

## Refactor Rule

Refactor fixed primary/secondary handling only where needed to support lane lists. Do not rewrite unrelated dispatcher, PR-manager, reviewer, validator, or runner-manager behavior.

## Adapter Rule

Provider-specific execution must live behind explicit lane adapter boundaries.

## Compatibility Rule

Existing repos should keep working without config changes.

## Documentation Rule

Any new config field must be documented in the schema and operator docs.

