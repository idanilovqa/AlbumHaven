# Player-aware hover and focus outline design

## Status and scope

The owner approved this Appearance workspace refinement on September 4, 2026.
It replaces the separate **Item hover border** and **Keyboard focus** controls
with one **Item hover & keyboard focus outline** control. The same semantic
outline color reaches non-player action controls on pointer hover and keyboard
focus.

Unless the owner selects another source, a custom player style supplies the
outline color. The active Main elements theme supplies it when the player has
no custom style. Navigation selection, item background, and pressed colors
continue to come from the Main elements theme or their own overrides.

This refinement keeps the existing Appearance page, account scope, endpoint,
and aggregate save transaction. It does not add arbitrary color input or a new
component family.

## Root cause

The current ActionButton hover rule draws both a physical border and an outer
outline. `button_hover_border` controls only the border, while `focus` controls
the outer outline on hover and keyboard focus. The outer outline dominates the
visible result, so changing **Item hover border** appears to do nothing.

The current fallback removes both interaction variables when their overrides
are null. CSS then resolves the outline through the Main elements theme accent.
Changing the player cannot affect the outline.

## Interaction controls

Selection & Hover presents five interaction rows:

1. Navigation hover
2. Navigation selected
3. Item hover background
4. Item hover & keyboard focus outline
5. Item pressed

The combined row keeps the seven coordinated color swatches. Selecting a
swatch creates one fixed custom outline color. The row also contains **Use
player colors**. That action links the outline to the effective player control
border and updates when the player colors change.

The combined swatches use the brighter former Keyboard focus shades because
the color must remain visible outside the control edge: Blue `#86B7EF`, Steel
`#91B7C4`, Green `#86B6A1`, Olive `#AAAC70`, Plum `#B98AA3`, Clay `#C7937D`,
and Neutral `#A1A8B0`.

The section-level **Revert to theme defaults** action becomes **Use theme**. It
clears Navigation hover, Navigation selected, Item hover background, Item
pressed, and any fixed outline color, then links the combined outline to the
active Main elements theme. It does not change the separate Selection Accent
enablement or color.

The preview replaces the separate Item hover border and Keyboard focus samples
with one combined sample. The sample shows the same color as a hover border and
outer outline and as a keyboard-focus outline. Unsaved Appearance values affect
only the editor preview until Save.

## Outline source and resolution

The aggregate Appearance payload stores one outline object:

```json
{
  "item_outline": {
    "source": "automatic",
    "color": null
  }
}
```

`source` accepts `automatic`, `theme`, `player`, or `custom`.

| Source | Resolved color | Reaction to later changes |
| --- | --- | --- |
| `automatic` | Player control border when a custom player style exists; otherwise Main elements theme accent | Follows whichever eligible source is active |
| `theme` | Main elements theme accent | Follows theme changes and ignores custom player changes |
| `player` | Effective player control border | Follows custom, preset, and theme-derived player colors |
| `custom` | Stored `color` | Remains fixed |

`color` must be null for `automatic`, `theme`, and `player`. A custom source
requires one uppercase `#RRGGBB` color. The server rejects unknown sources,
extra keys, and incomplete combinations through the existing Appearance
validation path.

The default value is `automatic`. Clicking **Use player colors** selects
`player`. Clicking a coordinated swatch selects `custom`. Clicking the
section-level **Use theme** selects `theme` after clearing the other interaction
overrides.

## Compatibility and migration

The Postgres migration replaces `button_hover_border` and `focus` inside
`interaction_overrides` with `item_outline`. It retains these keys:

- `item_hover`
- `item_selected`
- `button_hover_background`
- `button_pressed`

The migration converts existing rows as follows:

- If `focus` contains a color, it becomes a custom `item_outline`. This
  preserves the color users saw as the outer hover and keyboard-focus outline.
- Otherwise, a non-null `button_hover_border` becomes the custom outline.
- Rows with neither override receive the `automatic` source.

The browser normalizer accepts the legacy six-key shape during rolling upgrade
and applies the same precedence. The browser writes only the new shape. This
keeps an existing session readable while the server and page assets change.

## Styling boundary

One semantic CSS token supplies both hover and focus outline treatment. Shared
ActionButton hover uses it for `border-color` and `outline-color`.
`:focus-visible` uses the same token. Other non-player buttons, checkboxes,
radio buttons, and opted-in custom actions consume the token through their
existing component contracts.

Navigation hover and selected backgrounds retain their navigation tokens.
Navigation keyboard focus may consume the combined outline because it is an
accessibility state. Player transport, waveform, and loop controls remain
inside the player token boundary and do not consume the application interaction
outline.

Disabled controls do not show pointer hover or pressed treatment. Keyboard
focus stays visible with a two-pixel outline and the existing offset.

## Permissions and clients

The owner reconfirmed the unchanged capability model on September 4, 2026.
Active authenticated users read and write only their own Postgres-backed
Appearance record through `account.self.appearance.read` and
`account.self.appearance.write`. The server derives account identity and keeps
same-origin and session-CSRF enforcement. The refinement adds no preset grant,
administrator action, cross-account write, playback authority, or media-path
access.

Hosted and self-hosted web desktop and narrow web are required. Tauri is
optional through its web renderer. Android, TV, and Apple are unsupported for
this current-stack slice.

## Verification proposal

1. Add controller and server tests for the four sources, dynamic theme/player
   resolution, invalid combinations, aggregate save, and legacy normalization.
2. Add a migration test for legacy focus-first conversion, hover-border
   fallback conversion, and untouched unrelated Appearance fields.
3. Add rendering and style-contract tests for the five rows, the row-level
   **Use player colors** action, the section-level **Use theme** action, the
   combined preview, shared controls, disabled controls, and player exclusion.
4. Extend the approved Appearance functional E2E case to save a custom player,
   observe the player-derived hover/focus outline, select a custom swatch,
   select **Use player colors**, select **Use theme**, reload, and confirm each
   persisted source through normal UI flows.
5. Run focused JavaScript and Python tests sequentially. Give the owner a short
   live manual script before broader regression.

The functional E2E change adds assertions to the existing Appearance case. It
does not remove, weaken, reorder, or replace an established expectation.
