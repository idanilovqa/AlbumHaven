# Mobile header density — 2026-09-28

Owner-directed correction from the two phone screenshots in the mobile-layout conversation.
Application target: `2026-09-25-mobile-layout`; promote only verified changes to `2026-09-25-render-demo`.
This is a layout correction to the existing GalleryBar and underline tabs, not a new UI component or permission.

## Acceptance

- Recent and disabled News remain adjacent, left-aligned. The separate Top tracks / Top albums / Top Artists row retains its existing distribution and behavior.
- The title and its hamburger occupy the first row. Album/family counts and the three gallery controls share a second row immediately beneath the title, with counts left and controls right.
- The hamburger is transparent and borderless for pointer/touch interaction. Keep its 40px target and visible keyboard focus.
- Reduce the gallery's top inset and inter-row/bottom spacing. Long names may wrap without overlap or truncation; counts must not force a third row.
- Keep desktop geometry, menus, playback, approved album layouts and the track table unchanged.

## Verification

Additive production-path tests: `tests/e2e/mobile-feedback/mobileHeader.spec.js`.
Exercise both Black and Parchment & Pine, 320/390/430px widths, drawer navigation,
count/control alignment, adjacent Home tabs and view-menu opening without header growth.
Use the existing mobile verification and demo verification workflows. Real-app screenshots
are captured by the existing fixture. Existing test assertions and budgets are unchanged.

This note adds no phase-plan checkbox and changes no existing phase progress counter.
