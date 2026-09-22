# Overlay-Detached Sidebar Player Design

**Status:** Approved by the owner on 2026-09-22.

## Goal

Keep sidebar-integrated compact-player variants visually coherent and fully interactive whenever a background-dimming overlay is active.

## Approved behavior

- Any active background-dimming overlay, represented by the existing shared `body.modal-open` state, detaches sidebar-integrated compact-player variants from the sidebar.
- The same persistent player DOM is reused. Playback state, focus, button state, artwork actions, and the audio owner are not duplicated or reparented.
- The detached presentation uses the existing rounded, light-surface “stay docked” visual language and remains above the dimmer.
- Play/pause and artwork actions remain interactive.
- The play-only sidebar variant becomes an approximately square detached control.
- When that variant reveals artwork upward, its light surface expands with the artwork so no artwork escapes the player background.
- Closing the final dimming overlay removes only the effective detached state and restores the original docked, play-only, or artbox sidebar presentation.
- Always-floating players and expanded players retain their existing behavior. Normal non-overlay behavior does not change.

## Ownership

- `music_app/static/js/runtime/compact-player-controller.js` synchronizes one `is-overlay-detached` class from the shared body state and the effective compact-player presentation.
- `music_app/static/js/runtime/compact-player-helpers.js` owns the pure eligibility decision for detachment.
- `music_app/static/js/runtime/modal-and-overlay-helpers.js` continues to own `body.modal-open`; the player observes that shared state rather than adding modal-specific hooks.
- `music_app/static/css/runtime/non-album-and-player.css` owns the detached geometry, rounded surface, play-only square, and upward artwork surface expansion.

## Accessibility and interaction

The active element is preserved because the DOM is unchanged. Existing labels, keyboard handling, click/double-click artwork behavior, pointer capture, and play/pause handlers remain authoritative. The detached surface must not set `pointer-events: none` on interactive descendants.

## Verification

- Pure unit coverage for detachment eligibility across expanded, floating, docked, rail-play, and rail-artbox presentations.
- Component coverage that toggles `body.modal-open`, verifies detach/restore without replacing the player node, checks z-order and button interaction, and confirms the revealed artwork remains inside the detached surface.
- Rebuild the runtime bundle and run the focused player unit/component suites.

