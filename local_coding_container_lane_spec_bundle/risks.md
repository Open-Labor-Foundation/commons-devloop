# Risks

## Product Risks

Risk: the local lane feels like a special case instead of an equal lane.

Mitigation: render every lane through the same chipped panel component and route all lanes through the same dispatcher contract.

Risk: local model quality varies widely.

Mitigation: show model/runtime identity clearly, preserve logs and PR outcomes, and avoid promising equal performance.

## Technical Risks

Risk: fixed primary/secondary assumptions are spread through dispatcher, dashboard, config, and tests.

Mitigation: introduce lane-list normalization and helper functions before adding local provider behavior.

Risk: local runtime integration leaks host-specific assumptions.

Mitigation: communicate over compose network and keep runtime image/service configurable.

Risk: CI becomes slow or flaky if it downloads real local models.

Mitigation: use a stub local runtime for automated tests.

## Privacy And Security Risks

Risk: local lane accidentally sends code or issue content to hosted model services.

Mitigation: make local provider adapter separate from hosted Codex CLI launch path and test the selected command path.

Risk: local model container gets excessive access.

Mitigation: avoid Docker socket mounts and avoid host port exposure by default.

## Operations Risks

Risk: operators cannot tell whether local runtime is unavailable or simply idle.

Mitigation: add explicit runtime health states and panel explanations.

Risk: model cache consumes disk space.

Mitigation: document cache volume and cleanup process separately from run artifact cleanup.

## Scope Risks

Risk: stuck-lane behavior expands the project.

Mitigation: keep current failure behavior unchanged and put project-wide stuck-lane improvements in backlog.

