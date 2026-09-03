# Coordinated Interaction Colors Design

## Scope

Simplify the Appearance **Selection & Hover** interaction controls and make
their curated colors complement one another by role. This is a refinement of
the owner-approved Appearance v009 workspace. It does not add a new preference
scope, endpoint, permission, or arbitrary color input.

The editor presents these six controls:

1. Navigation hover
2. Navigation selected
3. Item hover background
4. Item hover border
5. Item pressed
6. Keyboard focus

`Item` means an actionable application control: buttons, checkboxes, radio
buttons, clickable cards, and custom controls with button semantics. Disabled
controls do not receive hover or pressed treatment. NavigationTree selection
and hover continue to use the two navigation controls. Player transport,
waveform, and loop controls continue to use Player & Seekbar colors.

## Coordinated families

Swatches stay arranged in consistent family columns. Each row uses a shade
chosen for that role instead of repeating the same color in every row.

| Family | Navigation hover | Navigation selected | Item hover background | Item hover border | Item pressed | Keyboard focus |
| --- | --- | --- | --- | --- | --- | --- |
| Blue | `#31465D` | `#3F5F7E` | `#27384B` | `#6E9BD0` | `#203246` | `#86B7EF` |
| Steel | `#43545E` | `#526B72` | `#34434A` | `#7FA0AC` | `#29373D` | `#91B7C4` |
| Green | `#3A524A` | `#4F665D` | `#2F443C` | `#75A08D` | `#25382F` | `#86B6A1` |
| Olive | `#55583A` | `#737548` | `#41452D` | `#9C9E63` | `#353823` | `#AAAC70` |
| Plum | `#5B3D4E` | `#785568` | `#462F3C` | `#A97A92` | `#38242F` | `#B98AA3` |
| Clay | `#60463C` | `#855F4F` | `#4A352E` | `#B98671` | `#3B2924` | `#C7937D` |
| Neutral | `#4B5057` | `#666B72` | `#393D43` | `#90979F` | `#2D3136` | `#A1A8B0` |

Users may mix families between rows. The aligned columns make a coordinated
set easy to choose, while each role remains independently overridable.

## Compatibility and data flow

The existing persisted keys remain unchanged to avoid a schema migration:

- `item_hover` renders as Navigation hover.
- `item_selected` renders as Navigation selected.
- `button_hover_background` renders as Item hover background.
- `button_hover_border` renders as Item hover border.
- `button_pressed` renders as Item pressed.
- `focus` renders as Keyboard focus.

The browser maps those stored values to semantic action tokens. Existing saved
values remain valid. **Use theme default** clears only the selected override and
returns that role to the active Main elements palette.

Actionable component styles consume the semantic item hover, border, pressed,
and focus tokens. Native checkboxes and radio buttons use the same family for
their actionable states. Custom clickable containers must expose their existing
button semantics or the shared actionable marker. Navigation and Player
components retain their dedicated tokens and are excluded from generic item
state styling.

## Components and accessibility

This reuses the current Appearance interaction-row and curated-swatch controls.
No page-local picker or new component family is introduced. Each swatch keeps a
descriptive accessible label containing its role and color. Selected swatches
use `aria-pressed`. Keyboard focus remains visible independently of hover and
pressed state. Disabled controls do not react to pointer states.

The existing own-account `account.self.appearance.read` and
`account.self.appearance.write` authority is unchanged. Hosted and self-hosted
web desktop and narrow web are required. Tauri is optional. Android, TV, and
Apple are unsupported for this current-stack refinement.

## Verification

- Add controller tests for the exact role-specific family catalog and retained
  persisted keys.
- Add rendering tests for the revised labels, aligned family columns, selected
  state, and **Use theme default** behavior.
- Add style-contract tests proving item hover/background/border/pressed/focus
  tokens reach buttons, checkboxes, radio buttons, and opted-in custom controls
  without recoloring NavigationTree or Player controls.
- Run focused Appearance and shared-control JavaScript tests.
- Manually verify one coordinated blue set and one mixed-family set in the live
  Utilities modal before requesting acceptance.

## Approved decision

The owner approved the coordinated-family approach on September 3, 2026 after
requesting a retained hover-border control and complementary role-specific
shades. Exact family values and the written implementation contract require the
owner's review before implementation begins.
