# Album Track Play Hover Outline Design

## Status

Approved by the owner on September 4, 2026.

## Scope

Add a hover outline only to the round per-track Play controls in the Album
Details track table. Do not change the bottom player, other shared buttons, or
per-track controls outside `AlbumTrackTable`.

## Interaction And Appearance

- Pointer hover renders a crisp `2px` circular outline outside the control's
  existing border without changing its size or the row layout.
- The outline uses `--appearance-play`, matching the active main player Play
  control. It falls back through the player accent and the table accent so the
  affordance remains theme-aware when a partial or legacy theme is active.
- Disabled controls do not receive the hover outline.
- Existing playing-row styling, one-shot Play activation animation, focus
  behavior, accessible names, and playback behavior remain unchanged.

## Verification

Add a focused CSS contract assertion to the existing AlbumTrackTable JavaScript
test. Prove the test fails before implementation, then add the scoped CSS rule
and rerun the complete AlbumTrackTable JavaScript test file.
