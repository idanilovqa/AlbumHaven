# Player-aware Hover and Focus Outline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give non-player hover and keyboard-focus outlines one source-aware Appearance setting that follows custom player colors by default and supports explicit theme, player, or fixed-color choices.

**Architecture:** Replace the duplicated `button_hover_border` and `focus` JSON values with one closed `item_outline` object. Resolve that object into one browser-owned `--appearance-interaction-outline` token, then make shared controls use that token for both hover and `:focus-visible`. Preserve existing accounts through a focus-first Postgres migration and a legacy browser normalizer.

**Tech Stack:** PostgreSQL JSONB migration, Python/FastAPI preference validation, browser JavaScript, CSS custom properties, Node test runner, pytest, Playwright.

## Global Constraints

- Do not change `account.self.appearance.read` or `account.self.appearance.write`, account ownership, same-origin enforcement, session-CSRF enforcement, or Postgres authority.
- Hosted and self-hosted web desktop and narrow web are required. Tauri is optional. Android, TV, and Apple are unsupported for this slice.
- Keep Selection Accent independent from the section-level **Use theme** action.
- Keep player transport, waveform, and loop controls inside the player token boundary.
- Preserve all established functional E2E expectations. Add assertions for the new behavior; do not weaken or replace existing assertions.
- Run JavaScript and Python tests sequentially. Run at most one pytest process at a time.
- Use the former Keyboard focus shades for the combined custom swatches: `#86B7EF`, `#91B7C4`, `#86B6A1`, `#AAAC70`, `#B98AA3`, `#C7937D`, and `#A1A8B0`.

---

### Task 0: Approve the exact visual and additive E2E contract

**Files:**
- Create: `C:/Repositories/album-haven-internal/docs/design-mockups/screens/appearance-backgrounds/v011/mockup.html`
- Create: `C:/Repositories/album-haven-internal/docs/design-mockups/screens/appearance-backgrounds/v011/mockup.css`
- Create: `C:/Repositories/album-haven-internal/docs/design-mockups/screens/appearance-backgrounds/v011/notes.md`
- Create: `C:/Repositories/album-haven-internal/docs/design-mockups/screens/appearance-backgrounds/v011/review.json`
- Modify: `C:/Repositories/album-haven-internal/docs/ui-component-system.md`
- Modify: `C:/Repositories/album-haven-internal/docs/permissions-and-capabilities.md`

**Interfaces:**
- Consumes: the approved design in `docs/superpowers/specs/2026-09-04-player-aware-hover-focus-outline-design.md` and the owner's current-app screenshots.
- Produces: one exact approved Selection & Hover visual and approval for the additive FTC-APPEARANCE-001 E2E steps below.

- [ ] **Step 1: Build the bounded v011 visual artifact**

Copy the approved v009 Appearance shell and show five interaction rows. Render the fourth row as:

```html
<div class="appearance-interaction-row appearance-interaction-row--outline">
  <strong>Item hover &amp; keyboard focus outline</strong>
  <div class="appearance-interaction-row__choices">
    <div class="appearance-muted-spectrum" aria-label="Custom outline color">
      <button type="button" style="--swatch:#86B7EF" aria-label="Use Blue #86B7EF"></button>
      <button type="button" style="--swatch:#91B7C4" aria-label="Use Steel #91B7C4"></button>
      <button type="button" style="--swatch:#86B6A1" aria-label="Use Green #86B6A1"></button>
      <button type="button" style="--swatch:#AAAC70" aria-label="Use Olive #AAAC70"></button>
      <button type="button" style="--swatch:#B98AA3" aria-label="Use Plum #B98AA3"></button>
      <button type="button" style="--swatch:#C7937D" aria-label="Use Clay #C7937D"></button>
      <button type="button" style="--swatch:#A1A8B0" aria-label="Use Neutral #A1A8B0"></button>
    </div>
    <button type="button" class="button button-secondary">Use player colors</button>
  </div>
</div>
```

Place the section-wide **Use theme** button below the interaction workspace. Replace the two preview cards with one card titled `Item hover & keyboard focus outline` and subtitle `Actionable item`.

- [ ] **Step 2: Capture desktop and narrow screenshots**

Render `mockup.html` at `1100x710` and `390x844`. Store the screenshots beside the artifact as `desktop.png` and `narrow.png`. Confirm the row-level action stays visually attached to the combined row and stacks without horizontal clipping at narrow width.

- [ ] **Step 3: Present the exact artifact and E2E proposal to the owner**

Propose one extension to existing `FTC-APPEARANCE-001` with these normal-user-flow steps:

1. Save a custom player control-border color and leave the outline source automatic.
2. Hover and keyboard-focus an ActionButton; assert both outlines use the player control border.
3. Choose the Blue combined swatch; assert hover and focus use `#86B7EF`.
4. Click **Use player colors**; assert the preview and real ActionButton return to the current player control border.
5. Set unrelated interaction overrides, click **Use theme**, and assert those overrides clear while Selection Accent remains unchanged.
6. Save and reload after the player and theme source choices; assert the selected source remains linked to later source-color changes.

Data mode remains the existing isolated Postgres-backed Appearance fixture. The test validates the visible preview, a real shared ActionButton, saved root CSS tokens, and persistence after reload. It adds no performance E2E because the change performs constant-time token resolution with no measurable interaction risk.

- [ ] **Step 4: Record approval before production edits**

Set `review.json` to `approved_for_implementation` only after the owner approves both screenshots and the exact E2E proposal. Update the internal component and capability registries with the approved reference. Stop here if either approval is missing.

- [ ] **Step 5: Commit the approved artifact and registry records**

```powershell
git -C C:/Repositories/album-haven-internal add -- docs/design-mockups/screens/appearance-backgrounds/v011 docs/ui-component-system.md docs/permissions-and-capabilities.md
git -C C:/Repositories/album-haven-internal commit -m "docs: approve player-aware interaction outline"
```

Expected: one private-repository documentation commit containing only the approved artifact and registry changes.

---

### Task 1: Migrate and validate the closed interaction payload

**Files:**
- Create: `migrations/postgres/0060_player_aware_interaction_outline.sql`
- Modify: `migrations/postgres/README.md`
- Modify: `music_app/services/appearance_preferences_postgres.py`
- Modify: `tests/py/test_appearance_preferences_postgres.py`
- Modify: `tests/py/test_postgres_migrations.py`
- Modify: `tests/py/test_account_appearance_asgi.py`

**Interfaces:**
- Consumes: legacy six-key `interaction_overrides` JSON.
- Produces: `normalize_interaction_overrides(value) -> dict[str, object]` with keys `item_hover`, `item_selected`, `button_hover_background`, `button_pressed`, and `item_outline`; `item_outline` contains exactly `source` and `color`.

- [ ] **Step 1: Write failing Python normalization tests**

Add fixtures and cases equivalent to:

```python
ITEM_OUTLINE = {"source": "automatic", "color": None}
INTERACTION_OVERRIDES = {
    "item_hover": None,
    "item_selected": None,
    "button_hover_background": None,
    "button_pressed": None,
    "item_outline": ITEM_OUTLINE,
}

@pytest.mark.parametrize("source", ["automatic", "theme", "player"])
def test_normalizer_accepts_linked_outline_sources(source):
    payload = aggregate_write(interaction_overrides={
        **INTERACTION_OVERRIDES,
        "item_outline": {"source": source, "color": None},
    })
    assert normalize_appearance_preferences(payload) == payload

def test_normalizer_accepts_and_uppercases_custom_outline():
    payload = aggregate_write(interaction_overrides={
        **INTERACTION_OVERRIDES,
        "item_outline": {"source": "custom", "color": "#86b7ef"},
    })
    assert normalize_appearance_preferences(payload)["interaction_overrides"]["item_outline"] == {
        "source": "custom", "color": "#86B7EF",
    }
```

Reject missing/extra top-level interaction keys, missing/extra outline keys, unknown sources, a non-null linked-source color, and a null or invalid custom color.

- [ ] **Step 2: Run the focused Python test and verify RED**

Run:

```powershell
pytest tests/py/test_appearance_preferences_postgres.py -q
```

Expected: failures because `_interaction_overrides` still requires `button_hover_border` and `focus` and treats every value as a color.

- [ ] **Step 3: Implement the new Python validator**

Replace the legacy tuple and validator with:

```python
_INTERACTION_COLOR_FIELDS = (
    "item_hover", "item_selected", "button_hover_background", "button_pressed",
)
_ITEM_OUTLINE_SOURCES = frozenset({"automatic", "theme", "player", "custom"})

def _item_outline(value: object) -> dict[str, str | None]:
    if not isinstance(value, Mapping) or set(value) != {"source", "color"}:
        raise ValueError("Item outline requires source and color.")
    source = _closed_choice(value["source"], _ITEM_OUTLINE_SOURCES, "Unknown item outline source.")
    color = _color(value["color"])
    if source == "custom" and color is None:
        raise ValueError("A custom item outline color is required.")
    if source != "custom" and color is not None:
        raise ValueError("Linked item outline sources cannot store a fixed color.")
    return {"source": source, "color": color}

def _interaction_overrides(value: object) -> dict[str, object]:
    expected = {*_INTERACTION_COLOR_FIELDS, "item_outline"}
    if not isinstance(value, Mapping) or set(value) != expected:
        raise ValueError("Interaction overrides require the complete closed set.")
    return {
        **{name: _color(value[name]) for name in _INTERACTION_COLOR_FIELDS},
        "item_outline": _item_outline(value["item_outline"]),
    }
```

Update ASGI fixtures to use the new closed shape without changing route authority or error semantics.

- [ ] **Step 4: Run the focused Python test and verify GREEN**

Run `pytest tests/py/test_appearance_preferences_postgres.py tests/py/test_account_appearance_asgi.py -q`.

Expected: all selected tests pass in one pytest process.

- [ ] **Step 5: Write the failing migration contract test**

Add `PLAYER_AWARE_OUTLINE_MIGRATION` and assert the migration:

```python
assert "0060_player_aware_interaction_outline.sql" in migration_names
assert "drop constraint user_appearance_aggregate_shape" in sql
assert "coalesce(interaction_overrides->>'focus', interaction_overrides->>'button_hover_border')" in sql
for value in ("automatic", "theme", "player", "custom", "item_outline"):
    assert value in sql
```

Also assert the migration retains `item_hover`, `item_selected`, `button_hover_background`, and `button_pressed` and removes the legacy keys from the new default and constraint.

- [ ] **Step 6: Run the migration test and verify RED**

Run `pytest tests/py/test_postgres_migrations.py -q`.

Expected: failure because migration 0060 does not exist.

- [ ] **Step 7: Add migration 0060**

Use this shape, retaining the repository's transaction and formatting conventions:

```sql
alter table app.user_appearance_preferences
  drop constraint if exists user_appearance_aggregate_shape;

update app.user_appearance_preferences
set interaction_overrides = jsonb_build_object(
  'item_hover', interaction_overrides->'item_hover',
  'item_selected', interaction_overrides->'item_selected',
  'button_hover_background', interaction_overrides->'button_hover_background',
  'button_pressed', interaction_overrides->'button_pressed',
  'item_outline', jsonb_build_object(
    'source', case
      when coalesce(interaction_overrides->>'focus', interaction_overrides->>'button_hover_border') is null then 'automatic'
      else 'custom'
    end,
    'color', to_jsonb(coalesce(interaction_overrides->>'focus', interaction_overrides->>'button_hover_border'))
  )
);

alter table app.user_appearance_preferences
  alter column interaction_overrides set default
  '{"item_hover":null,"item_selected":null,"button_hover_background":null,"button_pressed":null,"item_outline":{"source":"automatic","color":null}}'::jsonb;
```

Add this replacement constraint and document the focus-first migration in `migrations/postgres/README.md`:

```sql
alter table app.user_appearance_preferences
  add constraint user_appearance_aggregate_shape check (
    revision >= 0
    and jsonb_typeof(interaction_overrides) = 'object'
    and interaction_overrides ?& array[
      'item_hover', 'item_selected', 'button_hover_background',
      'button_pressed', 'item_outline'
    ]
    and interaction_overrides - array[
      'item_hover', 'item_selected', 'button_hover_background',
      'button_pressed', 'item_outline'
    ] = '{}'::jsonb
    and jsonb_typeof(interaction_overrides->'item_outline') = 'object'
    and (interaction_overrides->'item_outline') ?& array['source', 'color']
    and (interaction_overrides->'item_outline') - array['source', 'color'] = '{}'::jsonb
    and interaction_overrides->'item_outline'->>'source'
      in ('automatic', 'theme', 'player', 'custom')
    and (
      (interaction_overrides->'item_outline'->>'source' = 'custom'
        and interaction_overrides->'item_outline'->>'color' ~ '^#[0-9A-F]{6}$')
      or
      (interaction_overrides->'item_outline'->>'source' <> 'custom'
        and interaction_overrides->'item_outline'->'color' = 'null'::jsonb)
    )
    and jsonb_typeof(selection_accent) = 'object'
    and selection_accent ?& array['enabled', 'color']
    and selection_accent - array['enabled', 'color'] = '{}'::jsonb
    and (player_style_override is null or jsonb_typeof(player_style_override) = 'object')
    and jsonb_typeof(player_recent_sets) = 'array'
    and jsonb_array_length(player_recent_sets) <= 5
  );
```

- [ ] **Step 8: Run the migration and normalization tests**

Run:

```powershell
pytest tests/py/test_postgres_migrations.py tests/py/test_appearance_preferences_postgres.py tests/py/test_account_appearance_asgi.py -q
```

Expected: all selected tests pass.

- [ ] **Step 9: Commit the persistence slice**

```powershell
git add -- migrations/postgres/0060_player_aware_interaction_outline.sql migrations/postgres/README.md music_app/services/appearance_preferences_postgres.py tests/py/test_appearance_preferences_postgres.py tests/py/test_postgres_migrations.py tests/py/test_account_appearance_asgi.py
git commit -m "feat: persist player-aware interaction outline"
```

---

### Task 2: Resolve one outline token from theme, player, or custom state

**Files:**
- Modify: `music_app/static/js/appearance-backgrounds.js`
- Modify: `tests/js/runtime/appearance-workspace.test.js`
- Modify: `tests/js/runtime/appearance-palettes.test.js`

**Interfaces:**
- Consumes: normalized `interaction_overrides.item_outline` and the existing `resolveAppearance()` result.
- Produces: `normalizeInteractionOverrides(value)`, `resolveInteractionOutline(preference, effective) -> string`, `controller.setItemOutline(source, color = null)`, and the CSS token `--appearance-interaction-outline`.

- [ ] **Step 1: Write failing JavaScript tests for legacy normalization and source resolution**

Add table-driven assertions equivalent to:

```javascript
assert.equal(resolveInteractionOutline({
  ...initialAppearance(),
  player_style_override: classicGreen(),
  interaction_overrides: { ...newInteractions(), item_outline: { source: 'automatic', color: null } },
}, effective), classicGreen().controls.border);

assert.equal(resolveInteractionOutline(withOutline('theme'), effective), effective.tokens.accent);
assert.equal(resolveInteractionOutline(withOutline('player'), effective), effective.tokens['player-control-border']);
assert.equal(resolveInteractionOutline(withOutline('custom', '#86B7EF'), effective), '#86B7EF');
```

Assert that legacy `{button_hover_border, focus}` input becomes a custom outline using `focus` first, then hover border, and becomes automatic when both are null.

- [ ] **Step 2: Run the focused JavaScript test and verify RED**

Run:

```powershell
node --test --test-concurrency=1 tests/js/runtime/appearance-workspace.test.js tests/js/runtime/appearance-palettes.test.js
```

Expected: failures because the new helpers, object, and CSS token do not exist.

- [ ] **Step 3: Implement the browser normalizer and resolver**

Add these constants and helpers near the existing aggregate normalizers:

```javascript
const defaultItemOutline = Object.freeze({ source: 'automatic', color: null });
const interactionColorKeys = ['item_hover', 'item_selected', 'button_hover_background', 'button_pressed'];
const outlineSources = new Set(['automatic', 'theme', 'player', 'custom']);

function normalizeItemOutline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'color,source'
      || !outlineSources.has(value.source)) {
    throw new TypeError('Invalid item outline.');
  }
  const color = normalizeColor(value.color);
  if (value.source === 'custom' && color === null) {
    throw new TypeError('A custom item outline color is required.');
  }
  if (value.source !== 'custom' && color !== null) {
    throw new TypeError('Linked item outline sources cannot store a fixed color.');
  }
  return { source: value.source, color };
}

function normalizeInteractionOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid interaction overrides.');
  }
  const keys = Object.keys(value).sort().join(',');
  const currentKeys = [...interactionColorKeys, 'item_outline'].sort().join(',');
  const legacyKeys = [
    ...interactionColorKeys, 'button_hover_border', 'focus',
  ].sort().join(',');
  const colors = Object.fromEntries(interactionColorKeys.map(key => [
    key, normalizeColor(value[key]),
  ]));
  if (keys === currentKeys) {
    return { ...colors, item_outline: normalizeItemOutline(value.item_outline) };
  }
  if (keys === legacyKeys) {
    const legacyColor = normalizeColor(value.focus)
      || normalizeColor(value.button_hover_border);
    return {
      ...colors,
      item_outline: legacyColor
        ? { source: 'custom', color: legacyColor }
        : { ...defaultItemOutline },
    };
  }
  throw new TypeError('Invalid interaction overrides.');
}

function resolveInteractionOutline(preference, effective) {
  const outline = preference.interaction_overrides.item_outline;
  if (outline.source === 'custom') return outline.color;
  if (outline.source === 'theme') return effective.tokens.accent;
  const playerBorder = effective.tokens['player-control-border']
    || effective.tokens['waveform-edge']
    || effective.tokens['player-ink'];
  if (outline.source === 'player') return playerBorder;
  return (preference.player_style_override || preference.player_override)
    ? playerBorder
    : effective.tokens.accent;
}
```

`normalizeInteractionOverrides` must accept only the new closed shape or the exact legacy six-key shape. Normalize fixed colors through `normalizeColor`. Use `focus` before `button_hover_border` during legacy conversion.

- [ ] **Step 4: Apply the unified token in saved and preview themes**

In `applyTheme` and `applyDraftEditorTheme`, resolve the complete Appearance first, then set:

```javascript
style.setProperty(
  '--appearance-interaction-outline',
  resolveInteractionOutline(preference, effective),
);
```

Continue setting the navigation hover/selected, item hover background, and item pressed tokens. Stop setting independent `--appearance-item-action-hover-border` and `--appearance-focus` values.

- [ ] **Step 5: Add controller source actions**

Replace the duplicated key mutation with:

```javascript
const setItemOutline = (source, color = null) => {
  if (busy()) return;
  const normalized = normalizeItemOutline({ source, color });
  aggregate = true;
  draft.interaction_overrides = {
    ...draft.interaction_overrides,
    item_outline: normalized,
  };
  error = '';
  notify();
};

const useThemeInteractions = () => setInteractionOverrides({
  item_hover: null,
  item_selected: null,
  button_hover_background: null,
  button_pressed: null,
  item_outline: { source: 'theme', color: null },
});
```

Export `normalizeInteractionOverrides` and `resolveInteractionOutline` for direct tests. Make selection-section reset use the automatic source; reserve explicit theme source for **Use theme**.

- [ ] **Step 6: Run the focused JavaScript tests and verify GREEN**

Run the command from Step 2.

Expected: all selected tests pass.

- [ ] **Step 7: Commit the state-resolution slice**

```powershell
git add -- music_app/static/js/appearance-backgrounds.js tests/js/runtime/appearance-workspace.test.js tests/js/runtime/appearance-palettes.test.js
git commit -m "feat: resolve interaction outline sources"
```

---

### Task 3: Combine the editor control and shared control styling

**Files:**
- Modify: `music_app/static/js/appearance-backgrounds.js`
- Modify: `music_app/static/css/appearance-backgrounds.css`
- Modify: `music_app/static/css/button-component.css`
- Modify: `tests/js/runtime/appearance-workspace.test.js`
- Modify: `tests/js/runtime/button-component.test.js`

**Interfaces:**
- Consumes: `controller.setItemOutline`, `controller.useThemeInteractions`, and `--appearance-interaction-outline` from Task 2.
- Produces: five interaction rows, `[data-item-outline-source="player"]`, `[data-item-outline-color]`, `[data-interaction-use-theme]`, and one combined preview state `item-outline`.

- [ ] **Step 1: Write failing markup and CSS contract tests**

Assert exactly five row labels, one combined preview, row-level **Use player colors**, section-level **Use theme**, and no legacy labels or data attributes:

```javascript
assert.match(markup, />Item hover &amp; keyboard focus outline</);
assert.match(markup, /data-item-outline-source="player"[^>]*>Use player colors</);
assert.match(markup, /data-interaction-use-theme[^>]*>Use theme</);
assert.equal((markup.match(/class="appearance-interaction-row/g) || []).length, 5);
assert.doesNotMatch(markup, />Item hover border<|>Keyboard focus<|data-interaction-clear-all/);
```

Assert ActionButton hover `border-color` and `outline-color`, ActionButton focus, generic action hover/focus, and checkbox/radio outlines all consume `--appearance-interaction-outline`. Keep disabled exclusions and player-control exclusions.

- [ ] **Step 2: Run the focused JavaScript tests and verify RED**

Run:

```powershell
node --test --test-concurrency=1 tests/js/runtime/appearance-workspace.test.js tests/js/runtime/button-component.test.js
```

Expected: failures for the legacy six-row markup and split CSS variables.

- [ ] **Step 3: Render the five rows and source action**

Change `interactionRoles` to the four retained color keys plus `item_outline`. Build each family's outline shade from the former focus value. Render the source action only for `item_outline`:

```javascript
const sourceAction = key === 'item_outline'
  ? '<button class="button button-secondary appearance-outline-source" type="button" data-item-outline-source="player">Use player colors</button>'
  : '';
```

Render custom outline swatches with `data-item-outline-color`; retain `data-interaction-color` for the other rows. Use `aria-pressed` on the selected source button and selected custom swatch.

- [ ] **Step 4: Wire editor actions and the combined preview**

Handle the new actions in `mountSelectionAccent`:

```javascript
else if (button.hasAttribute('data-item-outline-color')) {
  controller.setItemOutline('custom', button.getAttribute('data-item-outline-color'));
} else if (button.getAttribute('data-item-outline-source') === 'player') {
  controller.setItemOutline('player');
} else if (button.hasAttribute('data-interaction-use-theme')) {
  controller.useThemeInteractions();
}
```

Replace the separate preview elements with `data-preview-state="item-outline"`. Set its border and outline from `--appearance-interaction-outline` so the preview makes the shared color visible.

- [ ] **Step 5: Unify the CSS token**

Update ActionButton and the aggregate actionable rules to use:

```css
.action-button:hover:not(:disabled):not([aria-disabled='true']) {
  border-color: var(--appearance-interaction-outline, var(--appearance-accent, #72baff));
  outline-color: var(--appearance-interaction-outline, var(--appearance-accent, #72baff));
}
.action-button:focus-visible {
  outline-color: var(--appearance-interaction-outline, var(--appearance-accent, #72baff));
}
```

Apply the same token to non-player generic action borders/outlines and native checkbox/radio hover outlines. Preserve the existing two-pixel focus outline, offset, disabled state, navigation background tokens, and `.global-player` boundary.

- [ ] **Step 6: Run focused JavaScript tests and verify GREEN**

Run the command from Step 2, then run:

```powershell
node --test --test-concurrency=1 tests/js/runtime/appearance-waveform-recents.test.js tests/js/runtime/selection-accent.test.js tests/js/runtime/navigation-tree.test.js
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit the UI slice**

```powershell
git add -- music_app/static/js/appearance-backgrounds.js music_app/static/css/appearance-backgrounds.css music_app/static/css/button-component.css tests/js/runtime/appearance-workspace.test.js tests/js/runtime/button-component.test.js
git commit -m "feat: unify hover and focus outline controls"
```

---

### Task 4: Extend the approved Appearance functional E2E

**Files:**
- Modify: `tests/e2e/poms/utilityAppearanceTab.js`
- Modify: `tests/e2e/actions/utilityAppearanceActions.js`
- Modify: `tests/e2e/specs/appearanceControls.spec.js`

**Interfaces:**
- Consumes: the approved Task 0 E2E contract and Task 3 data attributes.
- Produces: additive FTC-APPEARANCE-001 coverage for automatic, custom, player, and theme outline sources through normal visible UI flows.

- [ ] **Step 1: Invoke the Playwright workflow skills**

Read and follow `playwright-best-practices` first, then `webapp-testing`. Keep the existing isolated Postgres-backed application fixture and production routes. Do not add browser-state mutation, direct DOM action fallbacks, or test-only application behavior.

- [ ] **Step 2: Update the POM and action vocabulary**

Expose locators and actions with user-facing names:

```javascript
this.useThemeButton = this.editor.getByRole('button', { name: 'Use theme', exact: true });
this.usePlayerOutlineButton = this.editor.getByRole('button', { name: 'Use player colors', exact: true });

itemOutlineColorButton(family) {
  return this.editor.locator(`[data-item-outline-color][data-color-family="${family}"]`);
}
```

Replace the six-role helper with four retained rows plus `chooseItemOutlineColor(family)`, `usePlayerOutline()`, and `useThemeInteractions()`.

- [ ] **Step 3: Add the approved FTC-APPEARANCE-001 assertions**

Follow the six approved Task 0 steps. Use Playwright hover, keyboard Tab navigation, accessible roles, and computed-style reads already accepted by the E2E parity checker. Assert the root token `--appearance-interaction-outline`, the real ActionButton `borderColor` and `outlineColor`, preview values, source-button `aria-pressed`, Selection Accent preservation, and post-reload persistence.

- [ ] **Step 4: Run the focused functional E2E**

Run:

```powershell
& 'C:\Program Files\nodejs\node.exe' scripts/run-functional-playwright.cjs test tests/e2e/specs/appearanceControls.spec.js --workers=1
```

Preserve the output, trace path, and result in the handoff.

Expected: FTC-APPEARANCE-001 passes with the existing and additive expectations. If an established assertion fails, treat it as a product regression unless evidence proves a pre-application harness fault.

- [ ] **Step 5: Commit the E2E slice**

```powershell
git add -- tests/e2e/poms/utilityAppearanceTab.js tests/e2e/actions/utilityAppearanceActions.js tests/e2e/specs/appearanceControls.spec.js
git commit -m "test: cover player-aware interaction outlines"
```

---

### Task 5: Focused verification and owner manual acceptance

**Files:**
- Modify: `docs/superpowers/plans/2026-09-05-player-aware-hover-focus-outline.md`
- Modify: `C:/Repositories/album-haven-internal/docs/design-mockups/screens/appearance-backgrounds/v011/notes.md`

**Interfaces:**
- Consumes: committed persistence, browser, UI, and E2E slices.
- Produces: focused verification evidence and an exact manual test script for owner acceptance.

- [ ] **Step 1: Run focused JavaScript verification**

```powershell
node --test --test-concurrency=1 tests/js/runtime/appearance-workspace.test.js tests/js/runtime/appearance-palettes.test.js tests/js/runtime/appearance-waveform-recents.test.js tests/js/runtime/selection-accent.test.js tests/js/runtime/navigation-tree.test.js tests/js/runtime/button-component.test.js
```

Expected: all selected tests pass with no warnings or leaked Node processes.

- [ ] **Step 2: Verify the JavaScript process tree exited**

Inspect the exact test PID and descendants. Confirm no owned Node process from Step 1 remains before starting pytest.

- [ ] **Step 3: Run focused Python verification**

```powershell
pytest tests/py/test_postgres_migrations.py tests/py/test_appearance_preferences_postgres.py tests/py/test_account_appearance_asgi.py -q
```

Expected: all selected tests pass in one pytest process.

- [ ] **Step 4: Run repository hygiene checks**

Run `git diff --check` and the repository's migration ordering check. Expected: no whitespace errors, migration 0060 follows 0059, and no unrelated files are staged.

- [ ] **Step 5: Give the owner this manual test**

1. Choose a Main elements theme and save.
2. Choose a visibly different Player control border and save.
3. Open Selection & Hover. Confirm the combined preview and an app-bar ActionButton hover/focus outline use the player border.
4. Choose the Blue outline swatch. Confirm hover and keyboard focus both change to the same blue.
5. Click **Use player colors**. Confirm both return to the player border.
6. Change Navigation hover and Item pressed, then click **Use theme**. Confirm those choices clear, the outline follows the Main elements theme, and Selection Accent does not change.
7. Save, reload, and confirm the selected source still follows its source color.

- [ ] **Step 6: Stop for owner acceptance**

Do not run broad JavaScript, Python, functional E2E, performance E2E, release, or publish suites until the owner accepts the manual result or moves the branch into regression/release work.
