# UX Specification

## Main Flow

The operator opens the AE dashboard and sees all dispatcher lanes. Each lane appears in its own chipped panel.

The local lane appears beside the hosted lanes and uses the same interaction pattern:

- lane label
- current model/runtime
- health state
- running work count
- configured workers
- active workers allowed
- current issue or idle state when available
- short status explanation

The operator should not have to learn a separate workflow for the local lane.

## Chipped Lane Panels

Each lane panel should be visually compact and self-contained. The panel should read like a lane chip with enough detail to make operational decisions.

Each panel should include:

- lane name
- provider tag, such as `Hosted` or `Local`
- model or runtime name
- worker count
- current health
- budget/quota or local resource summary
- short reason for any pause, unavailable state, or throttle

For the local lane, hosted quota bars should not be shown as fake data. Instead, show local runtime state:

- container unavailable
- starting
- ready
- busy
- failed
- disabled

## Lane Equality

The UI should not imply that the local lane is experimental, lower priority, or secondary to hosted lanes. All lanes are equal choices. The panel may show different resources, speed, or status because the underlying runtime differs.

## Configuration Flow

Lane settings should support the local lane in the same area used for hosted lanes:

- enabled or disabled
- target concurrency
- model/runtime name
- provider
- local runtime endpoint or service name where needed
- cost or resource hint

The UI should avoid exposing implementation internals as primary controls.

## Error And Recovery States

If the local runtime is unavailable:

- the lane panel should say that the local runtime is unavailable
- the lane should show 0 active workers
- the dispatcher should not assign new work to it
- hosted lanes should continue operating

If the local lane fails while working:

- the item should show the same failed state used by other lanes
- the run log should be linked or discoverable in the same way as hosted lane logs
- no special stuck-lane workflow should be introduced in v1

If issue access is unavailable:

- the dashboard should explain that no accessible issues are available
- the local lane should remain ready but idle

## Accessibility

- Chipped panels must have readable contrast.
- Health states must not rely only on color.
- Labels must remain visible at narrow dashboard widths.
- Panels should wrap instead of forcing horizontal overflow.
- Controls must have labels tied to form inputs.

## Copy Guidelines

Use operator-facing language:

- `Local lane`
- `Ready`
- `Running 1 issue`
- `Local runtime unavailable`
- `Waiting for accessible issues`

Avoid implementation-only wording as primary copy:

- raw provider enum names
- raw JSON field names
- unexplained endpoint names

