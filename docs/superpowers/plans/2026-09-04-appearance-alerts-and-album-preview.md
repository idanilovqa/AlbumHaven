# Appearance Alerts And Album Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Alerts editor and Album page live preview without changing Album Details or playback behavior.

**Architecture:** Extend the revisioned Postgres Appearance aggregate with one closed `alert_family` field. Keep severity and Present/Missing preview switches inside the mounted editors, and render preview-only semantic markup styled from the current draft tokens.

**Tech Stack:** FastAPI, PostgreSQL migrations, plain JavaScript current-web Appearance controller, CSS, Node test runner, pytest.

## Global Constraints

- Alert families are exactly `ember`, `signal`, and `quiet`; default is `ember`.
- Preview severity and Present/Missing state are not persisted.
- Web desktop and narrow web are required.
- Existing account-self permissions, playback behavior, and Album Details runtime behavior remain unchanged.

---

### Task 1: Durable alert family

**Files:**
- Create: `migrations/postgres/0059_alert_appearance_family.sql`
- Modify: `migrations/postgres/README.md`
- Modify: `music_app/services/appearance_preferences_postgres.py`
- Modify: `music_app/templates/partials/appearance-bootstrap.html`
- Test: `tests/py/test_postgres_migrations.py`
- Test: `tests/py/test_appearance_preferences_postgres.py`
- Test: `tests/py/test_account_appearance_asgi.py`

**Interfaces:** Produces `alert_family: "ember" | "signal" | "quiet"` in the canonical Appearance payload.

- [x] Add failing migration and normalization tests for the closed field and default.
- [x] Run the focused pytest files and confirm the missing-field failures.
- [x] Add the migration, repository read/write column, canonical default, and bootstrap field.
- [x] Run the focused pytest files and confirm they pass.

### Task 2: Controller and reusable preview markup

**Files:**
- Modify: `music_app/static/js/appearance-backgrounds.js`
- Modify: `music_app/static/css/appearance-backgrounds.css`
- Modify: `music_app/static/css/runtime/alert-components.css`
- Test: `tests/js/runtime/appearance-workspace.test.js`
- Test: `tests/js/runtime/appearance-waveform-recents.test.js`

**Interfaces:** Produces `setAlertFamily(family)`, `alertsMarkup()`, and the redesigned `albumPageMarkup()`; editor-local state remains outside `controller.getState().draft`.

- [x] Add failing JavaScript contracts for family save/reset, semantic preview markup, visual layout cards, local-only preview switches, and responsive/theme CSS.
- [x] Run the focused Node tests and confirm the new assertions fail.
- [x] Implement the controller field, Alerts mount, Album page preview mount, and approved responsive styling.
- [x] Re-run the focused Node tests and confirm they pass.

### Task 3: Navigation and runtime integration

**Files:**
- Modify: `music_app/static/js/runtime/appearance-backgrounds-bridge.js`
- Modify: `music_app/static/js/runtime/utility-renderers-and-actions.js`
- Regenerate: `music_app/static/js/runtime-bundle.js`
- Test: `tests/js/runtime/navigation-tree.test.js`
- Test: `tests/js/runtime/utility-list-builders.test.js`

**Interfaces:** Adds the separate `alerts` Appearance route and mounts `mountAlerts` through the existing editor bridge.

- [x] Add failing navigation and bridge assertions.
- [x] Run focused Node tests and confirm the missing Alerts route failures.
- [x] Implement navigation, bridge mounting, and regenerate the runtime bundle.
- [ ] Run focused Node and Python verification sequentially, then inspect the rendered editor in a real browser.
