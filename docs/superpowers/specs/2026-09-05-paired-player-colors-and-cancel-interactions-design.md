# Paired Player Colors and Cancel Interactions

## Approved outcome

The owner approved this refinement on September 5, 2026, during manual review
of the Appearance workspace. Player control colors and waveform colors remain
distinct roles, but edits keep each pair in the same color family:

- Control fill and waveform fill form one bidirectional pair.
- Control border and waveform edge form one bidirectional pair.
- Waveform handles continue to follow waveform edge until the user edits the
  handle color directly.

The edited field retains the exact selected `#RRGGBB` value. The editor converts
the paired field in HSL using the hue and lightness differences and saturation
ratio between the two Classic green reference colors. The conversion clamps
saturation and lightness to the HSL gamut and returns uppercase hex.
It derives each result from the current input rather than a prior derived value,
preventing repeated edits from accumulating rounding drift.

Classic green remains the reference:

| Pair | Control role | Waveform role |
| --- | --- | --- |
| Fill | `#24B86B` | `#387F68` |
| Edge | `#86EFAC` | `#AFD8C2` |

Permanent themes and restored recent sets remain atomic configurations. Pairing
applies to direct edits made through the Controls, Waveform, and recent-color
inputs; choosing a complete theme or recent set does not rewrite its approved
colors.

## Player-aware interaction outline

The existing `player` outline source resolves from the effective player control
border. Draft previews and saved application styling both use the same resolver.
Any paired border or waveform-edge edit therefore updates the outline while the
source is `player` or eligible `automatic`. A `custom` outline remains fixed,
and `theme` continues to follow the Main elements theme.

## Shared Button behavior

The shared Button primitive owns its enabled hover, active, and keyboard-focus
feedback without depending on page-wide Appearance selectors. Every enabled
Button receives the semantic interaction border and outline. Disabled Buttons
remain inert.

Cancel uses a reusable quiet modifier. Its hover and active backgrounds use a
faint translucent tint, while its border and outline retain the same semantic
interaction color as other Buttons. This keeps Cancel visibly interactive
without competing with the primary Save action. The footer supplies the modifier
through the shared JavaScript renderer; it does not create a page-local button.

## Boundaries

This refinement changes no endpoint, persistence shape, permission, capability,
or playback authority. Active users continue to edit only their own Appearance
record. Hosted and self-hosted desktop and narrow web are required. Tauri remains
optional through its web renderer. Android, TV, and Apple remain unsupported for
this current-stack slice.

## Verification

JavaScript unit tests cover both directions of each color pair, exact retention
of the edited value, theme and recent-set isolation, handle behavior, and dynamic
player-outline resolution. Button contract tests load the component stylesheet
without the aggregate Appearance stylesheet. A component-browser test verifies
Cancel hover, active, focus, and disabled states with the shared tokens.
