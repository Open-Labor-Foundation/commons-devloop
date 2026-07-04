# UI And UX Design Standards

## Lane Panel Standard

Each lane must render as its own chipped panel. The panel is the unit of lane status, not a row in a generic table and not a special-case local widget.

## Required Panel Content

Each lane panel must show:

- lane label
- provider
- model/runtime name
- health label
- health explanation
- running count
- configured workers
- active workers allowed
- budget/quota/resource summary relevant to the provider

## Layout

- Panels should wrap responsively.
- Each panel should have stable dimensions as values change.
- Long model names must wrap or truncate safely.
- Health pills must not resize the whole panel unexpectedly.
- The local lane should not create a separate section unless future lane count requires grouping.

## Visual Treatment

- All lanes use the same panel style.
- Provider differences are shown through labels and metrics, not hierarchy.
- Hosted quota data and local runtime data may differ, but the panel structure stays consistent.

## Accessibility

- Health must be communicated with text, not color alone.
- Controls must have labels.
- Keyboard navigation must reach all lane controls.
- Contrast must be sufficient for status text and controls.

