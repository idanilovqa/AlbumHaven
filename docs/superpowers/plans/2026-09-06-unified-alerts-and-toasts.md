# Unified Alerts and Toasts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route inline alerts, compact labels, hover actions, and all application toasts through one semantic alert schema and the coordinated Appearance alert color scheme.

**Architecture:** Make alert-components.js the single semantic renderer, retain showToast as a compatibility facade, and map the existing `alert_family` preference to success/info/warning/error tokens. Existing callers keep their operation logic.

**Tech Stack:** Browser JavaScript, CSS custom properties, appearance preference JSON, Node test runner.

## Global Constraints

- Follow the index constraints in `2026-09-06-shared-ui-convergence-index.md`.
- Success is green, info follows the selected theme's blue/info family, warning is amber, and error is red.
- Same-family hover/focus/selected outlines must never fall back to the global mint outline for warning/error/destructive elements.
- Preserve the existing Problematic Files icon and navigation behavior.
- Keep `showToast(message, variant, duration, options)` callable by all existing code.

### Task 1: Define one alert schema and renderers

**Files:**
- Modify: `music_app/static/js/runtime/alert-components.js`
- Modify: `music_app/static/css/runtime/alert-components.css`
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`
- Modify: `C:/Repositories/album-haven-internal/docs/permissions-and-capabilities.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/appearance-customization.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/app-shell-and-shared-components.md`
- Modify: `C:/Repositories/album-haven-internal/docs/functional-test-cases/utilities-problematic-files.md`
- Test: `tests/js/runtime/alert-components.test.js`

**Interfaces:**
- `normalizeAlert({ severity='info', title='', message='', action=null, dismissible=false, id='' })`.
- `buildInlineAlertHtml(alert)`, `buildAlertLabelHtml(alert)`, `buildHoverAlertActionHtml(alert)`, and `buildToastAlertHtml(alert)` consume the normalized schema.
- Valid severities are `success`, `info`, `warning`, and `error`; unknown values normalize to `info`.

- [ ] Add failing tests for normalization, escaping, action/dismiss controls, accessible roles/live-region attributes, compact and expanded toast markup, and all four severities.
- [ ] Add stylesheet contract assertions for shared `--alert-edge`, `--alert-tint`, `--alert-ink`, and same-family interaction states.
- [ ] Run the focused alert-component test; expect failures for the unified schema and missing renderers.
- [ ] Implement normalization and renderers with one safe attribute serializer and no caller-supplied HTML path.
- [ ] Consolidate severity tokens and explicitly override global interaction outline variables for semantic alert controls.
- [ ] Update the private registry with Alert, AlertLabel, HoverAlertAction, and ToastAlert variants under one schema.
- [ ] Record that alert presentation grants no capabilities in the permission registry, and add the approved shared-alert, Appearance-scheme, and Problematic Files cases plus proposed tests to their owning functional-case files.
- [ ] Repeat the focused test and require zero failures.
- [ ] Commit as `refactor: unify semantic alert components`.

### Task 2: Route all toasts through ToastAlert

**Files:**
- Modify: `music_app/static/js/runtime/notification-ui-helpers.js`
- Modify: `music_app/static/css/base.css`
- Test: `tests/js/runtime/notification-ui-helpers.test.js`
- Test: `tests/js/runtime/cover-lookup-notification-helpers.test.js`

**Interfaces:**
- `showToast(message, severity='success', duration=3600, options={})` normalizes legacy string calls and delegates markup to `buildToastAlertHtml`.
- `options` supports `title`, `action`, `dismissible`, and `expanded`; current callers require no signature changes.

- [ ] Add failing tests showing scheduled cover lookup, tag edits, deletion, and generic notifications render `.toast-alert` with correct semantic severity and live-region behavior.
- [ ] Add compatibility tests for existing success/error strings and existing timeout/removal behavior.
- [ ] Run both focused tests; expect failures because `showToast` hand-builds `.toast` DOM.
- [ ] Replace its markup construction with the shared renderer while preserving container ownership, timers, cancellation, and action callbacks.
- [ ] Remove only superseded raw toast visual declarations from `base.css`; retain positioning and stacking on the toast host.
- [ ] Repeat the focused tests and require zero failures.
- [ ] Commit as `refactor: render application toasts as alerts`.

### Task 3: Extend Appearance alert-family preview

**Files:**
- Modify: `music_app/static/js/appearance-backgrounds.js`
- Modify: `music_app/static/css/appearance-backgrounds.css`
- Modify: `music_app/templates/partials/appearance-bootstrap.html`
- Test: `tests/js/runtime/appearance-backgrounds.test.js`

**Interfaces:**
- Existing preference key `alert_family` remains the single scheme selector.
- Each curated scheme emits `--alert-success-*`, `--alert-info-*`, `--alert-warning-*`, and `--alert-error-*` tokens.
- Appearance preview renders all four semantic states through alert-components.js.

- [ ] Add failing tests that every scheme contains four complete severity token sets and that the preview includes success, info, warning, and error.
- [ ] Assert persistence payload/key compatibility so no migration or new preference field is introduced.
- [ ] Run the focused appearance test; expect failure because success is absent from the coordinated preview/schema.
- [ ] Extend scheme definitions and bootstrap defaults, and have preview markup call the shared inline/label renderer.
- [ ] Update explanatory copy to say the selection coordinates success, info, warning, and error surfaces.
- [ ] Repeat the focused test and require zero failures.
- [ ] Commit as `feat: coordinate alert appearance colors`.

### Task 4: Migrate Problematic Files labels without changing its icon

**Files:**
- Modify: `music_app/static/js/runtime/utility-list-builders.js`
- Modify: `music_app/static/css/utilities.css`
- Test: `tests/js/runtime/utility-list-builders.test.js`

- [ ] Add failing tests that album-level and track-level reason pills use `buildAlertLabelHtml({ severity: 'error' })`, while `.track-problem-link` markup and destination remain unchanged.
- [ ] Assert interactive selected/focus/hover states use the error-family edge and keep current `aria-pressed`, disabled, and data attributes.
- [ ] Run the focused utility-list test; expect failures for hand-built problem pills.
- [ ] Delegate label markup to the shared renderer and remove duplicated visual rules; do not replace the problematic-file icon.
- [ ] Repeat the focused test and require zero failures.
- [ ] Commit as `refactor: share problematic file labels`.

### Task 5: Slice verification and acceptance

- [ ] Run the four affected Node suites together with `--test-concurrency=1` and then `npm run test:js`.
- [ ] Regenerate the runtime bundle and run `tests/js/runtime/app-loader-bundle.test.js`.
- [ ] Run `git diff --check`; inspect all `showToast(` call sites and confirm their semantic result is correct without bulk caller rewrites.
- [ ] Give the owner a manual script for successful and failed tag edit, deletion, scheduled cover lookup, info notification, Appearance scheme switching, and Problematic Files label interactions.
- [ ] Wait for owner acceptance before adding functional E2E coverage.
