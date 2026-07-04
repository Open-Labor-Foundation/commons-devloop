# Supply Chain Governance

## Local Runtime Image

The local model runtime image must be operator-configurable and documented.

## Image Trust

Recommended controls:

- pin image tags in examples
- document expected image source
- avoid `latest` in production examples
- allow operators to build or mirror images
- document model cache volume behavior

## Dependency Changes

Avoid adding unnecessary runtime dependencies to the shared AE image. Keep local model runtime dependencies in the local runtime image where possible.

## CI

CI should not require downloading a large local model. Use a stub local runtime for automated tests.

