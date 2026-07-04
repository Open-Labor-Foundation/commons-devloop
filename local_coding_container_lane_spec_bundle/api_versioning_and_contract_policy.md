# API Versioning And Contract Policy

## Contract Goal

The feature must add lane-list support without breaking dashboard clients or scripts that still expect primary and secondary fields.

## Versioning Approach

Use additive API changes in v1:

- add `lanes` arrays
- keep `primary` and `secondary` fields
- document lane arrays as the preferred contract

## Breaking Changes

Do not remove legacy fields in v1.

## Validation

Tests should lock the response shape for:

- legacy two-lane config
- three-lane config
- local lane disabled
- local runtime unavailable

