# Gap Analysis

## Domains Touched

- dispatcher lane selection
- local model execution
- Docker compose runtime
- dashboard UX
- repo configuration
- API contract compatibility
- state persistence
- logs and observability
- privacy and data handling
- tests and acceptance harnesses
- operator documentation
- supply chain and runtime image trust

## Coverage Review

| Domain | Covered | Location |
| --- | --- | --- |
| Product intent | Yes | `idea_summary.md`, `product.md` |
| Architecture | Yes | `architecture.md` |
| UI/UX and accessibility | Yes | `ux.md`, `ui_ux_design_standards.md` |
| API contract | Yes | `api.md`, `api_versioning_and_contract_policy.md` |
| Data/state model | Yes | `data_model.md` |
| Execution policy | Yes | `execution_policy.md`, `specialist_selection_policy.md` |
| Container isolation | Yes | `container_runtime_isolation.md` |
| Config and environment | Yes | `configuration_and_environment_management.md` |
| Schema migration | Yes | `schema_migration_and_versioning.md` |
| Testing | Yes | `testing_strategy.md` |
| Agent instruction governance | Yes | `agent_instruction_and_prompt_governance.md` |
| Cost governance | Yes | `cost_governance.md` |
| Data governance | Yes | `data_governance.md` |
| Observability and incident ops | Yes | `observability_and_incident_ops.md` |
| Operator operations | Yes | `admin_and_operator_operations.md` |
| Supply chain | Yes | `supply_chain_governance.md` |
| Repository maintenance | Yes | `repo_maintenance_and_docs.md`, `developer_standards.md` |
| Realtime events | Covered as non-required for v1 | `realtime_events.md` |

## Autonomous Build Readiness

This pack is ready for autonomous implementation planning. It identifies:

- where current primary/secondary assumptions need to change
- how the local lane should join the existing issue-to-PR workflow
- how the dashboard should show lanes as chipped panels
- how to preserve backward compatibility
- how to test the feature without requiring a real model download in CI
- how to keep the local lane inside Docker runtime boundaries

## Blocking Gaps

No blocking product-intent gaps remain.

Implementation will still need to choose the concrete local model runtime image and adapter protocol. The spec allows this to be configurable so the build can proceed with a stub or default runtime first.

## Non-Blocking Gaps

- richer local hardware telemetry
- smarter routing
- project-wide stuck-lane recovery
- deeper offline operation

## Reference Lenses Used

- current AE Docker service model
- current dispatcher primary/secondary lane flow
- current dashboard lane telemetry and lane control surface
- current repo config and schema shape
- local-first privacy and container isolation expectations
- autonomous build requirements for tests, docs, and operations

