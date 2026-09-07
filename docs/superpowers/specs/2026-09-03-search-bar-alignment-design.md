# Search Bar Alignment Design

## Goal

Align the library search field's outer left border with the main content panel's outer rounded edge. Tighten the visual gap between the browser-native clear control and the adjacent search button without allowing the controls to overlap.

Remove the nested rounded focus outline between the browser-native clear control and the search button. The editable input and both actions must read as parts of one search component.

## Scope

This is a CSS-only adjustment to the library app bar. It does not change search behavior, markup, keyboard handling, the native clear control, the search button's accessible name, or the placement of trailing app-bar controls.

## Design

On desktop, remove the library app bar search form's 24-pixel left inset. The search form already occupies the grid column whose left edge matches the main content panel, so removing that inset aligns their outer borders without moving the app-bar grid or other controls.

Within the app-bar search field, reduce the input's right-side padding next to the browser-native clear control. Keep the search action in its existing grid column and preserve its independent button target. Scope the spacing adjustment to the app bar so other shared search fields retain their current layout.

The shared component places its focus indicator on `.search-field-control` with
`:focus-within` and suppresses the nested input outline. The later generic
`:focus-visible` rule has equal or greater selector specificity, so it restores an
outline around a focused child and produces the unwanted rounded boundary. The
shared search component must own this exception: add component-scoped input and
button overrides with enough specificity to suppress every nested outline,
border, and shadow. Preserve the shared outer focus indicator. A keyboard-focused
search button remains distinguishable through the component's existing focused
background and foreground color state, never through an internal ring.

Existing responsive overrides remain unchanged. At widths up to 900 pixels the search form already removes its left inset, and at widths up to 720 pixels the app bar and main panel use their existing mobile margins.

## Verification

Add a focused stylesheet contract test that checks the desktop alignment rule and the app-bar-scoped clear/action spacing rule. Run the focused test, then visually confirm that:

- the search field aligns with the main panel's outer rounded edge;
- the clear and search controls are closer but do not overlap;
- both controls remain usable with pointer and keyboard input; and
- focusing either child draws one outline around the complete search component, with no inner rounded boundary between clear and search;
- keyboard focus on the search button changes its background and foreground without drawing an internal outline; and
- the existing mobile layout remains intact.
