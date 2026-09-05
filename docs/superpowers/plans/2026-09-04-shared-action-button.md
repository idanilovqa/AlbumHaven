# Shared ActionButton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the approved current-web Button primitive with one theme-aware 34px `ActionButton` used by the app bar and Album Details header without changing any action behavior.

**Architecture:** `ActionButton` is a specialization of the existing shared `Button`, not a second button family. Jinja and JavaScript renderers emit the same canonical classes and native-button attributes; shared CSS owns size, surface, hover/focus, and disabled presentation, while consumers own only placement, icon artwork, IDs, and event hooks.

**Tech Stack:** Jinja templates, browser JavaScript, CSS custom properties, Node's built-in test runner.

## Global Constraints

- Preserve every existing control ID, data action, title, accessible name, status class, and native disabled state.
- Use a native `<button>` with a required accessible name for icon-only controls.
- Render at exactly `34px × 34px` with `8px` corners, crisp `18px–20px` icon content, a single theme-aware surface, and no nested border.
- Hover and focus use shared Appearance interaction tokens; disabled controls are inert and receive no hover feedback.
- Album Details edit and folder controls remain disabled while inventory is missing; Close remains enabled.
- Web desktop and narrow web are required. Tauri is deferred because no desktop repository exists. Android, TV, and Apple are unsupported for this slice.
- This component adds no permission or capability; each consumer keeps its existing server-owned authority.

---

### Task 1: Lock the shared ActionButton contract with failing tests

**Files:**
- Modify: `tests/js/runtime/button-component.test.js`
- Modify: `tests/js/runtime/album-details-components.test.js`
- Modify: `tests/js/shared-account-menu-contract.test.js`
- Modify: `tests/py/test_shared_app_bar_templates.py`

**Interfaces:**
- Consumes: existing `ButtonComponent.renderButton(options)` and Jinja `ui_button(...)`.
- Produces: expected JavaScript `renderActionButton(options)` and Jinja `action_button(...)` contracts.

- [x] **Step 1: Add renderer tests for the wished-for API**

```js
const html = button.renderActionButton({
  ariaLabel: 'Edit album tags',
  className: 'track-modal-edit-tags album-details-header__action',
  iconClass: 'album-details-header__action-icon album-details-header__action-icon--edit',
  attributes: { id: 'track-modal-edit-tags', 'data-open-track-modal-editor': '1' },
});
assert.match(html, /ui-button--icon ui-button--medium action-button/);
assert.match(html, /aria-label="Edit album tags"/);
```

- [x] **Step 2: Add consumer tests**

```js
assert.match(albumActions, /class="[^"]*action-button[^"]*album-details-header__action/);
assert.match(appBarTemplate, /action_button/);
assert.match(accountMenuTemplate, /action_button/);
```

- [x] **Step 3: Run the focused tests and verify RED**

Run: `node --test --test-concurrency=1 tests/js/runtime/button-component.test.js tests/js/runtime/album-details-components.test.js tests/js/shared-account-menu-contract.test.js`

Expected: FAIL because `renderActionButton`, the `action_button` macro, and migrated consumer markup do not exist.

Run: `python -m pytest tests/py/test_shared_app_bar_templates.py -q`

Expected: FAIL because the rendered app-bar controls do not yet expose the shared `action-button` contract.

### Task 2: Implement the shared renderer and styles

**Files:**
- Modify: `music_app/static/js/button-component.js`
- Modify: `music_app/templates/partials/button.html`
- Modify: `music_app/static/css/button-component.css`

**Interfaces:**
- Consumes: `renderButton(options)` escaping and validation conventions.
- Produces: `ButtonComponent.renderActionButton(options)` and `action_button(...)` with canonical classes `button ui-button ui-button--icon ui-button--medium action-button`.

- [x] **Step 1: Implement a shared internal button-markup path and ActionButton JavaScript renderer**

```js
function renderActionButton(options = {}) {
  if (!options.ariaLabel) throw new TypeError('ActionButton requires an accessible label.');
  return renderButtonMarkup({ ...options, variant: 'icon', size: 'medium' },
    `<span class="action-button__icon ${escape(options.iconClass || '')}" aria-hidden="true"></span>`);
}
```

- [x] **Step 2: Add the Jinja specialization with caller-provided icon content**

```jinja2
{% macro action_button(aria_label, class_name='', id=none, title=none, disabled=false, attributes={}) -%}
<button type="button" class="button ui-button ui-button--icon ui-button--medium action-button{% if class_name %} {{ class_name }}{% endif %}" aria-label="{{ aria_label }}" ...><span class="ui-button__content action-button__content">{{ caller() }}</span></button>
{%- endmacro %}
```

- [x] **Step 3: Add the exact shared visual/state contract**

```css
.action-button {
  width: 34px;
  height: 34px;
  min-width: 34px;
  min-height: 34px;
  border: 1px solid var(--appearance-line, #ffffff04);
  border-radius: 8px;
  background: var(--appearance-control, var(--app-control));
}
.action-button:hover:not(:disabled):not([aria-disabled='true']) {
  border-color: var(--appearance-item-action-hover-border, var(--appearance-focus, #72baff));
  background: var(--appearance-item-action-hover-background, #293a50);
}
```

- [x] **Step 4: Run the component test and verify GREEN**

Run: `node --test --test-concurrency=1 tests/js/runtime/button-component.test.js`

Expected: PASS.

### Task 3: Migrate app-bar and Album Details consumers

**Files:**
- Modify: `music_app/templates/index.html`
- Modify: `music_app/templates/partials/account-menu.html`
- Modify: `music_app/templates/partials/primary-modals.html`
- Modify: `music_app/static/js/runtime/album-details-components.js`
- Modify: `music_app/static/css/app-chrome.css`
- Modify: `music_app/static/css/runtime/album-details-components.css`
- Modify: `music_app/static/js/runtime-bundle.js` (generated)
- Modify: `../album-haven-internal/docs/design-mockups/components/shared-button/v001/component-record.md`
- Modify: `../album-haven-internal/docs/ui-component-system.md`

**Interfaces:**
- Consumes: JavaScript `renderActionButton(options)` and Jinja `action_button(...)` from Task 2.
- Produces: app-bar and Album Details controls with unchanged consumer IDs/events and shared appearance ownership.

- [x] **Step 1: Replace the app-bar notification, library-status, and settings raw buttons with Jinja `action_button` calls**

```jinja2
{% call action_button('Library status', class_name='status-indicator is-idle', id='scan-indicator', title='Library ready') %}
  <span class="status-spinner" aria-hidden="true"></span>
  ...
{% endcall %}
```

- [x] **Step 2: Replace the Album Details loading-shell controls with the same macro**

```jinja2
{% call action_button('Close tracklist', class_name='track-modal-close album-details-header__action', id='track-modal-close', attributes={'data-close-track-modal': '1'}) %}
  <span class="album-details-header__action-icon album-details-header__action-icon--close" aria-hidden="true"></span>
{% endcall %}
```

- [x] **Step 3: Replace dynamically rendered Album Details buttons with `renderActionButton`**

```js
return [
  ButtonComponent.renderActionButton({ ariaLabel: editLabel, disabled: missing, ... }),
  ButtonComponent.renderActionButton({ ariaLabel: folderLabel, disabled: missing, ... }),
  ButtonComponent.renderActionButton({ ariaLabel: 'Close tracklist', ... }),
].join('');
```

- [x] **Step 4: Remove duplicate app-bar and Album Details button appearance rules**

Keep only app-bar/Album Details layout and icon-mask rules. Shared `ActionButton` CSS owns geometry, hover/focus, and disabled appearance.

- [x] **Step 5: Record the approved ActionButton specialization and adopted consumers**

Update the current-web Button record and UI component registry with the approved dimensions, states, accessibility rule, and consumer list. State explicitly that no capability changes.

- [x] **Step 6: Rebuild the generated runtime bundle**

Run: `npm run build:runtime`

Expected: exit 0 and `runtime-bundle.js` contains the migrated Album Details renderer.

- [x] **Step 7: Run focused verification**

Run: `node --test --test-concurrency=1 tests/js/runtime/button-component.test.js tests/js/runtime/album-details-components.test.js tests/js/shared-account-menu-contract.test.js tests/js/runtime/app-loader-bundle.test.js`

Expected: PASS.

Run: `python -m pytest tests/py/test_shared_app_bar_templates.py -q`

Expected: PASS.

- [x] **Step 8: Inspect the diff for consumer-hook preservation**

Run: `git diff --check` and `git diff -- music_app/static/js/button-component.js music_app/templates/partials/button.html music_app/static/css/button-component.css music_app/templates/index.html music_app/templates/partials/account-menu.html music_app/templates/partials/primary-modals.html music_app/static/js/runtime/album-details-components.js music_app/static/css/app-chrome.css music_app/static/css/runtime/album-details-components.css`

Expected: no whitespace errors; the same IDs, `data-*` hooks, status classes, titles, accessible labels, and missing-album disabled behavior remain present.
