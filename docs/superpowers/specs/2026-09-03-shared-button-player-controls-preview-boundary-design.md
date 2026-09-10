# Shared Button, Player Controls, and Preview Boundary Design

## Approved outcome

Album Haven will expose one reusable current-web Button primitive for dynamic JavaScript surfaces and Jinja templates. Appearance footer buttons and player mode controls are the first consumers. Unsaved Appearance theme values remain inside each page's preview and do not recolor editor chrome or the shared footer before Save.

## Shared Button primitive

The component has `primary`, `secondary`, and `icon` variants plus `medium` and `small` sizes. Its shared content box uses `inline-flex`, `align-items: center`, `justify-content: center`, and `line-height: 1`, centering text or icons on both axes. It preserves native button semantics, disabled behavior, accessible names, keyboard activation, and focus-visible treatment.

`music_app/static/js/button-component.js` renders dynamic buttons from structured options. `music_app/templates/partials/button.html` provides the equivalent Jinja macro. Both emit the same `ui-button` classes and `data-ui-button-action` contract and consume `music_app/static/css/button-component.css`. Future work in a touched current-web boundary uses this primitive rather than page-local button markup. Existing unrelated buttons are not migrated in this slice.

## Component-owned player controls

The expanded `.player-shell` owns a small collapse icon button. The `.compact-player-shell` owns a separate expand icon button. The controller queries each action through its owning shell and binds both to the same compact-mode transition. It no longer changes one outer `.global-player` button's label or position.

In floating compact mode, the expand button is a circular surface overlapping the compact card's top-left edge, matching the owner-provided previous design. Docked compact mode uses the same compact-owned control with placement relative to the compact shell. Playback, cover, queue, dragging, waveform, loop, and album-opening behavior remain unchanged.

## Preview-only unsaved theming

Each Appearance page has one draft-token host:

- Main elements: `.background-preview`
- Player & Seekbar: `.player-live-preview`
- Selection & Hover: `.selection-hover-preview`

Draft tokens are applied only to that host. The Utilities dialog, navigation, editor controls, and reusable footer inherit the last successfully saved document theme. Swatches, selected indicators, field values, validation, and dirty state still update immediately. A successful Save applies the new theme to the document through the existing saved-theme path.

## Verification

Tests cover the shared renderer and macro contract, centered layout, component-owned player actions, absence of the outer toggle, preview-only draft-token calls, unchanged footer theming, and generated runtime bundle parity. Existing Appearance and compact-player regression suites remain green.
