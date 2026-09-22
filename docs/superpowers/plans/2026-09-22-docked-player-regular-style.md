# Docked Player Regular Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted, default-off checkbox that lets only the docked compact player retain the regular player surface and separator.

**Architecture:** Extend the existing Postgres-backed player preference contract with one optional boolean and expose it through the current Appearance controller, device profiles, bootstrap, and root data attributes. Keep presentation logic unchanged; a dock-only CSS selector switches the surface tokens while existing geometry selectors continue to own expanded-sidebar and collapsed Stay docked layouts.

**Tech Stack:** PostgreSQL migrations, Python/FastAPI preference services, server-rendered HTML, plain JavaScript, CSS custom properties, Node.js tests, Pytest, Playwright component tests.

## Global Constraints

- The stored field is `docked_compact_player_regular_style`, accepts only booleans, and defaults to `false`.
- The UI label is “Keep regular player style when docked.”
- Only `.global-player.is-docked-compact:not(.is-rail-compact)` may consume the enabled style.
- Sidebar play-button, sidebar artbox, floating compact, and expanded player surfaces remain unchanged.
- Stay docked with a collapsed Artist Tree retains its existing rounded geometry.
- Existing clients that omit the new field preserve saved values.
- No new permission, capability, dependency, or player DOM is introduced.

---

### Task 1: Persist and normalize the player preference

**Files:**
- Create: `migrations/postgres/0079_docked_compact_player_regular_style.sql`
- Modify: `music_app/services/appearance_preferences_postgres.py`
- Modify: `tests/py/test_appearance_preferences_postgres.py`
- Modify: `tests/py/test_compact_player_appearance.py`
- Modify: `tests/py/test_appearance_device_profiles.py`
- Modify: `tests/py/test_postgres_migrations.py`
- Modify: `tests/py/test_account_appearance_asgi.py`

**Interfaces:**
- Consumes: the existing aggregate appearance preference and player device-section contracts.
- Produces: `docked_compact_player_regular_style: bool`, with canonical default `False`, SQL column `boolean not null default false`, and omission-preserving writes.

- [ ] **Step 1: Write failing normalization, default, profile, route, and migration tests**

Add assertions equivalent to:

```python
assert expand_appearance_preferences(base)["docked_compact_player_regular_style"] is False
assert normalize_appearance_preferences({
    **aggregate_write(),
    "docked_compact_player_regular_style": True,
})["docked_compact_player_regular_style"] is True

with pytest.raises(ValueError, match="Docked compact player regular style"):
    normalize_appearance_preferences({
        **aggregate_write(),
        "docked_compact_player_regular_style": "true",
    })
```

Require the player device section, ASGI response shape, migration sequence, read columns, insert/update SQL, and rolling-upgrade omission contract to include the field.

- [ ] **Step 2: Run the exact Python tests and verify RED**

Run:

```powershell
python -m pytest tests/py/test_appearance_preferences_postgres.py tests/py/test_compact_player_appearance.py tests/py/test_appearance_device_profiles.py tests/py/test_account_appearance_asgi.py tests/py/test_postgres_migrations.py -q
```

Expected: new assertions fail because the field and migration do not exist.

- [ ] **Step 3: Add the migration and minimum repository support**

Create:

```sql
alter table app.user_appearance_preferences
add column docked_compact_player_regular_style boolean not null default false;
```

Add the field to storage/read columns, the player device section, and default maps. Normalize only exact booleans:

```python
if "docked_compact_player_regular_style" in writable:
    value = writable.pop("docked_compact_player_regular_style")
    if type(value) is not bool:
        raise ValueError("Docked compact player regular style must be enabled or disabled.")
    optional["docked_compact_player_regular_style"] = value
```

Default reads and inserts to `False`. Use `coalesce(incoming.docked_compact_player_regular_style, saved.docked_compact_player_regular_style)` on updates so old writers preserve the saved value. Preserve missing custom-profile values with the existing compatibility loop.

- [ ] **Step 4: Run the focused Python tests and verify GREEN**

Run the Step 2 command again. Expected: all selected tests pass.

---

### Task 2: Add the Appearance checkbox and prepaint data attribute

**Files:**
- Modify: `music_app/static/js/appearance-backgrounds.js`
- Modify: `music_app/static/js/client-layout-bootstrap.js`
- Modify: `music_app/templates/partials/appearance-bootstrap.html`
- Modify: `tests/js/runtime/appearance-workspace.test.js`
- Modify: `tests/js/runtime/client-layout-prepaint-bootstrap.test.js`
- Modify: `tests/components/appearanceWorkspace.spec.js`

**Interfaces:**
- Consumes: `docked_compact_player_regular_style` from the existing appearance bootstrap and save response.
- Produces: controller method `setDockedCompactPlayerRegularStyle(enabled)`, checkbox `[data-docked-compact-player-regular-style]`, and root attribute `data-docked-compact-player-regular-style="true|false"`.

- [ ] **Step 1: Write failing controller, markup, interaction, and prepaint tests**

Require canonical normalization to return `false` when omitted and preserve `true`; require the setter to change the draft, save payload, reload state, and reset state. In the component test, click the checkbox and assert the root attribute changes immediately, then save and assert the request payload contains `true`.

Require bootstrap capture to set:

```js
root.setAttribute(
  'data-docked-compact-player-regular-style',
  String(appearance.docked_compact_player_regular_style === true),
);
```

- [ ] **Step 2: Run the JavaScript tests and verify RED**

Run sequentially:

```powershell
node --test --test-concurrency=1 tests/js/runtime/appearance-workspace.test.js tests/js/runtime/client-layout-prepaint-bootstrap.test.js
npx playwright test tests/components/appearanceWorkspace.spec.js --config=playwright.component.config.js --grep "regular player style" --reporter=line
```

Expected: assertions fail because the controller field, root attribute, and checkbox do not exist.

- [ ] **Step 3: Implement the minimum controller and checkbox flow**

Normalize with an exact boolean default:

```js
const dockedCompactPlayerRegularStyle = value.docked_compact_player_regular_style === true;
```

Include it in the normalized preference, device player field list, reset state, and root application:

```js
rootElement.setAttribute(
  'data-docked-compact-player-regular-style',
  String(preference.docked_compact_player_regular_style === true),
);
```

Add the controller setter:

```js
const setDockedCompactPlayerRegularStyle = enabled => {
  if (saving) return;
  promote();
  draft.docked_compact_player_regular_style = enabled === true;
  error = '';
  notify();
};
```

Place this control under Docked player:

```html
<label class="compact-player-regular-style-toggle">
  <input type="checkbox" data-docked-compact-player-regular-style>
  Keep regular player style when docked
</label>
```

Sync `checked` and disable it when saving or when the selected compact style is not docked. Handle its `change` event through the setter. Set the same root attribute in `client-layout-bootstrap.js` from the bootstrap value.

- [ ] **Step 4: Run the focused JavaScript and component tests and verify GREEN**

Run the Step 2 commands again. Expected: all selected tests pass.

---

### Task 3: Scope regular player styling to the docked presentation

**Files:**
- Modify: `music_app/static/css/appearance-backgrounds.css`
- Modify: `tests/components/sidebarPlayer.spec.js`
- Modify: `tests/js/runtime/appearance-workspace.test.js`

**Interfaces:**
- Consumes: `data-docked-compact-player-regular-style='true'`, `.global-player.is-docked-compact:not(.is-rail-compact)`, and existing `--appearance-player-*` tokens.
- Produces: the regular surface, ink, top separator, shadow, and blur for the docked presentation only.

- [ ] **Step 1: Write failing rendered surface tests**

Extend `mount` with `regularStyle = false` and emit the root attribute. Assert:

```js
await expect(player(page)).toHaveCSS('background-color', sidebarSurface);
await mount(page, { regularStyle: true });
await expect(player(page)).toHaveCSS('background-color', regularPlayerSurface);
await expect(player(page)).toHaveCSS('border-top-width', '1px');
```

Add a Stay docked collapsed case that asserts the rounded radius remains. Add rail-play and rail-artbox cases with `regularStyle: true` that retain the sidebar surface. Assert floating and expanded player styling does not depend on the attribute.

- [ ] **Step 2: Run the rendered tests and verify RED**

Run:

```powershell
npx playwright test tests/components/sidebarPlayer.spec.js --config=playwright.component.config.js --grep "regular style" --reporter=line
```

Expected: the enabled docked player still resolves to the sidebar surface and has no top separator.

- [ ] **Step 3: Add the dock-only CSS override**

Add after the current `.global-player.is-docked-compact` Appearance rule:

```css
:root[data-docked-compact-player-regular-style='true']
  .global-player.is-docked-compact {
  background: linear-gradient(
    var(--appearance-player-surface-angle, 0deg),
    var(--appearance-player-surface-start, var(--appearance-player)),
    var(--appearance-player-surface-end, var(--appearance-player))
  );
  color: var(--appearance-player-ink);
  border-top: 1px solid var(--appearance-player-control-border, rgba(74, 222, 128, 0.24));
  box-shadow: 0 -18px 50px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(12px);
}
```

Do not set `border-radius`, width, position, transform, or presentation classes in this rule.

- [ ] **Step 4: Add a static selector ownership assertion**

Require the new root selector to target `.global-player.is-docked-compact` and to include the regular player surface variables and top border. Assert no equivalent selector targets rail or floating presentations.

- [ ] **Step 5: Run focused verification and rebuild generated assets**

Run sequentially:

```powershell
node scripts/build-runtime-bundle.cjs
python -m pytest tests/py/test_appearance_preferences_postgres.py tests/py/test_compact_player_appearance.py tests/py/test_appearance_device_profiles.py tests/py/test_account_appearance_asgi.py tests/py/test_postgres_migrations.py -q
node --test --test-concurrency=1 tests/js/runtime/appearance-workspace.test.js tests/js/runtime/client-layout-prepaint-bootstrap.test.js
npx playwright test tests/components/appearanceWorkspace.spec.js tests/components/sidebarPlayer.spec.js --config=playwright.component.config.js --grep "regular player style|regular style" --reporter=line
git diff --check -- migrations/postgres/0079_docked_compact_player_regular_style.sql music_app/services/appearance_preferences_postgres.py music_app/static/js/appearance-backgrounds.js music_app/static/js/client-layout-bootstrap.js music_app/templates/partials/appearance-bootstrap.html music_app/static/css/appearance-backgrounds.css tests/py/test_appearance_preferences_postgres.py tests/py/test_compact_player_appearance.py tests/py/test_appearance_device_profiles.py tests/py/test_account_appearance_asgi.py tests/py/test_postgres_migrations.py tests/js/runtime/appearance-workspace.test.js tests/js/runtime/client-layout-prepaint-bootstrap.test.js tests/components/appearanceWorkspace.spec.js tests/components/sidebarPlayer.spec.js
```

Expected: build exits `0`; all selected tests pass; diff check exits `0`.

- [ ] **Step 6: Verify localhost port 5001 serves the rebuilt files**

Restart the scoped application process on port 5001 using the repository’s existing restart helper. Fetch `appearance-backgrounds.css`, `appearance-backgrounds.js`, `client-layout-bootstrap.js`, and the main page with cache-busting queries. Require HTTP `200`, exact local-file equality for static assets after optional UTF-8 BOM normalization, and the new bootstrap field in page HTML.

---

### Task 4: Review the complete feature diff

**Files:**
- Review every file listed in Tasks 1 through 3.

**Interfaces:**
- Consumes: the approved design spec and complete feature diff.
- Produces: a reviewed, focused implementation with no known validated findings.

- [ ] **Step 1: First adversarial review pass**

Read the complete relevant diff. Check defaults, strict boolean validation, SQL placeholder order, omission compatibility, device-profile propagation, reset behavior, prepaint behavior, accessibility, selector specificity, presentation exclusions, and test strength. Fix every validated finding and rerun its focused check.

- [ ] **Step 2: Second adversarial review pass**

Review the entire resulting diff again, including fixes from Step 1. Challenge duplication, needless abstractions, misplaced ownership, untested behavior, and unrelated edits. If this pass finds a substantive issue, fix it, rerun focused checks, and complete a third full pass.

- [ ] **Step 3: Final requirements and evidence check**

Re-read `docs/superpowers/specs/2026-09-22-docked-player-regular-style-design.md`, map each requirement to code and a passing test or direct inspection, then report the exact verification commands and any unrelated pre-existing failures without claiming broader suite coverage.
