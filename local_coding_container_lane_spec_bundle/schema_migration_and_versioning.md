# Schema Migration And Versioning

## Current Version

The repo schema is currently versioned and models dispatcher lanes as primary and secondary entries.

## Required Migration

Introduce lane-list support without forcing immediate config rewrites.

## Compatibility Strategy

Version 1 implementation should:

- keep reading existing primary and secondary config
- normalize legacy config into lane records
- allow new `models.dispatcher.lanes` config
- write normalized config metadata with the lane list
- keep dashboard legacy fields until callers migrate

## Deprecation Strategy

Do not remove legacy primary/secondary config in v1.

Future removal may be considered only after:

- docs have been updated
- all tests use lane-list helpers where possible
- dashboard and scripts consume lane arrays
- migration examples are available

