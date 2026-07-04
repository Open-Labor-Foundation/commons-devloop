# Dashboard Spec

> **Status note:** this spec's core is built — a real React dashboard
> (`dashboard/src/`) with state snapshot/config/service-lifecycle/lane
> endpoints, light/dark theming, bearer-token auth, and a lane API-key
> settings panel. What's **not** yet built: slider-based direct editing of
> pause thresholds/reserve windows/concurrency, the dedicated
> Capacity/Lane-Policy/Usage-Limits tuning panels, and progressive
> disclosure/collapsible sections. Today's lane and service panels are
> read-mostly (status + start/stop/pause/resume + lane API keys) rather than
> full inline tuning. Treat the sections below as the target, not the
> current state.

## Goal

Provide a real browser dashboard for `commons-devloop` that preserves the operational value of the `olf-agents` Codex dashboard while improving the usability of lane and scheduler controls.

The dashboard is a control plane, not just a status endpoint.

## Product Role

The dashboard must let an operator:

- see the current repo status quickly
- understand what each local service is doing
- inspect target issues and PRs
- control dispatcher and service lifecycle
- tune model-lane behavior without needing to understand internal formulas
- pause or resume the repo safely

## Baseline From olf-agents

The browser dashboard baseline comes from:

- `infra/scripts/codex-dashboard-server.mjs`
- `infra/dashboard/codex-dashboard.html`

The reusable `commons-devloop` dashboard should preserve the functional categories that matter:

- top-level operations summary
- lane and quota visibility
- active issue table
- PR status and merged PR history
- validator and reviewer activity
- service controls
- scheduler controls
- live refresh and health visibility

## UX Principle

The dashboard must optimize for operator comprehension, not internal implementation fidelity.

That means:

- controls should be direct
- labels should describe the outcome the operator is changing
- labels should use plain language instead of internal shorthand
- derived formulas should stay in the backend
- the operator should not need to mentally translate multipliers or fractions into real effects

## Direct-Control Requirement

The lane and scheduler area must not expose opaque multipliers, fractions, or internal-only tuning knobs as the primary UI.

Examples of controls that should not be first-class:

- secondary lane fraction
- reserve multipliers
- indirect burn modifiers
- controls whose effect is only understandable after applying another formula

Instead, the UI should expose direct operator values.

## Required Lane Controls

The dashboard lane controls must support direct adjustment of:

- primary lane enabled or disabled
- secondary lane enabled or disabled
- primary lane target concurrency
- secondary lane target concurrency
- total dispatcher concurrency as a derived display, not a primary control
- minimum reserve percent to preserve
- pause threshold percent
- daily usage ceiling percent
- weekly usage ceiling percent
- reserve window in hours
- reasoning effort per lane
- model selection per lane

These controls should be presented as direct controls, preferably sliders where a bounded numeric range exists.

## Slider-First UX Rules

The dashboard should use sliders for bounded numeric values when a slider improves comprehension.

Examples:

- target concurrency per lane
- pause below remaining percent
- weekly reserve remaining percent
- daily usage ceiling percent
- weekly usage ceiling percent
- reserve window hours

The dashboard should use select controls for categorical values:

- model name
- reasoning effort
- lane mode

The dashboard may pair sliders with numeric input fields for precise entry, but the slider is the primary affordance.

## Display Requirements For Lane Controls

For every slider-backed control, the UI must show:

- current value
- allowed range
- short plain-language description of impact
- immediate preview of the resulting effective configuration

The preview should describe outcomes directly, for example:

- `2 primary workers, 1 secondary worker`
- `Pause when primary lane drops below 15%`
- `Keep at least 20% reserve`
- `Use up to 80% of the weekly budget`

Control copy should favor operator language such as:

- `Pause when remaining falls below 15%`
- `Keep at least 20% weekly reserve`
- `Reserve protection window`

Avoid internal-feeling shorthand such as:

- `pause below remaining %`
- `weekly reserve %`
- `nominal burn`

## Required Lane Visibility

The dashboard must still display live lane state:

- current model per lane
- current reasoning effort per lane
- current running count
- target concurrency
- remaining percent
- weekly remaining percent
- effective reserve remaining percent
- reset time
- weekly reset time
- pause reason
- current note or health summary

These values are status outputs, not tuning controls.

Each lane card should also provide:

- a plain-language health state such as `Healthy`, `Filling`, `Paused`, `Reserve pressure`, or `No telemetry`
- a one-sentence explanation of why that status is being shown

The operator should not have to infer lane health from percentages alone.

## Scheduler UX Requirement

Scheduler tuning must be grouped into a human-centered panel called something like:

- `Capacity`
- `Lane Policy`
- `Usage Limits`

It must not be presented as a raw config dump.

The operator should be able to answer:

- how hard is the system allowed to run right now
- how much reserve will it keep
- when will it pause
- how many workers can use each model
- which model is prioritized

## Service Control Requirements

The browser dashboard must include first-class controls for:

- dispatcher start
- dispatcher stop
- dispatcher pause
- dispatcher resume
- per-service start
- per-service stop
- per-service reset for a desired-on service that needs a container restart

Services visible in the table:

- autonomous
- dispatcher
- validator
- reviewer
- runner-manager
- pr-manager
- monitor
- dashboard

## Required Browser Sections

The browser dashboard must include:

- operations summary cards
- lane status panel
- lane control panel
- active issues panel
- PR status or merged PR panel
- validator panel
- reviewer panel
- service controls panel
- repo pause/resume controls
- repo identity and access policy controls
- settings summary panel

## Progressive Disclosure

Default view should show:

- top-level status
- lane health
- active issues
- service state

Detailed items should be collapsible:

- recent PR tables
- validator/reviewer logs
- advanced tuning controls
- raw state snapshots

When multiple lane-control sections are present, the dashboard should prefer compact disclosure patterns such as tabs so the operator does not need to scroll through repeated control groups.

The review services panel should remain close to the lane policy area so control changes and review/validation feedback stay visually connected.

## Visual Direction

The dashboard should remain intentionally designed rather than generic admin UI.

Required qualities:

- strong visual hierarchy
- clear distinction between status, warnings, and controls
- readable tables and cards
- desktop-first control density with usable mobile fallback
- keyboard-accessible controls

## Accessibility

The dashboard must follow the repo's UX and accessibility expectations:

- no color-only state signaling
- keyboard navigable controls
- visible focus states
- labeled sliders and inputs
- readable contrast
- meaningful button text

## Backend Contract Requirement

The dashboard backend must support the browser UI with first-class endpoints for:

- state snapshot
- config snapshot
- dispatcher lifecycle actions
- per-service lifecycle actions
- lane and scheduler config updates

Configuration update endpoints must accept direct operator values, not UI-only multipliers.

Any internal derived math should happen server-side after the direct input is submitted.

## Non-Negotiable UX Change

Compared to the current `olf-agents` behavior, `commons-devloop` must simplify lane tuning:

- remove multiplier-style primary controls from the browser UI
- replace them with direct sliders and selects
- prefer remaining-percent language over used-percent language in the browser
- describe the effect of each control in plain language
- keep advanced computed values visible as status only

## Acceptance Criteria

The dashboard portion is not complete unless:

- the browser root renders a real HTML dashboard
- lane tuning is possible without understanding internal formulas
- at least the main lane controls are slider-first
- service controls work from the browser
- the operator can see lane reserve and pause behavior directly
- the operator can pause and resume the repo from the browser
- the operator can understand current capacity and limits within a few seconds of loading the page
