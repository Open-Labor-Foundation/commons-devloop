# Lane Selection Policy

## Purpose

This policy defines how Autonomous Engine selects between hosted and local coding lanes.

## Selection Inputs

Use:

- lane enabled state
- lane target concurrency
- active running count
- local runtime health
- repo PR capacity
- lifecycle pause state
- accessible issue queue

Do not use:

- assumptions that hosted models are better
- assumptions that local models are worse
- hidden priority boosts unless explicitly configured later

## V1 Behavior

All lanes are equal. The dispatcher assigns work based on available capacity and current running count.

## Future Behavior

Future routing may consider issue size, language, cost, privacy requirements, or model capability. That is outside v1 unless added later as an explicit operator-controlled policy.

