# Agent Instruction And Prompt Governance

## Purpose

The local lane should receive the same issue instructions and work expectations as hosted lanes unless provider-specific launch mechanics require adapter wrapping.

## Prompt Contract

The prompt or instruction payload sent to the local lane must preserve:

- issue title
- issue body
- repo context
- branch expectations
- PR expectations
- validation expectations
- protected path and branch constraints
- remediation payload when applicable

## Local Model Differences

Provider-specific wrapping is allowed only to make the local runtime understand the task. It must not weaken the issue-to-PR contract.

## Auditability

The exact instruction payload or a safe summary must be logged or stored in output artifacts, excluding secrets.

## Future Evaluation

Future work may add model quality evaluation across lanes. V1 only needs enough logging and state to compare outcomes manually.

