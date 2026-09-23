# Player Preview Sticky Boundary

## Scope

Fix the Player & Seekbar Appearance page so scrolling keeps the preview player in view while the Seekbar style control scrolls with the other settings. Apply the behavior to Default seekbar and Waveform seekbar modes.

This correction changes no preferences, permissions, deployment modes, client support, component tokens, or persistence behavior.

## Root cause

`seekbarMarkup()` places the preview player and the Seekbar style section inside `.player-preview-dock`. CSS assigns `position: sticky` to that wrapper, so the browser keeps both elements in view.

## Design

Keep `.player-preview-dock` as the sticky container for the preview player. Close that container after `[data-player-live-preview]`, then render `.player-seekbar-mode` as its sibling before `.player-editor-workspace`.

The existing preview spacing, colors, stacking order, and sticky top offset remain unchanged. The selector keeps its current appearance and updates the draft through the existing event path.

## Tests

Update the existing Appearance workspace layout contract to verify:

- `.player-preview-dock` contains `[data-player-live-preview]` and closes before `.player-seekbar-mode`.
- `.player-seekbar-mode` remains before `.player-editor-workspace` and appears once.
- `.player-preview-dock` retains `position: sticky` and `top: 0`.
- Both Default and Waveform markup use the same corrected boundary.

Run the focused JavaScript runtime test, then run the related Appearance runtime tests. Use browser verification at a scroll position where the selector has left the viewport and the preview remains visible.
