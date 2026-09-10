# Account and Admin UI Cleanup Design

## Scope

Make three owner-approved presentation changes to the standalone Account and
Admin surfaces:

1. Remove the disabled `Profile` item from Account navigation.
2. Remove the session-list border immediately above the first active session
   while preserving the section divider above `Active sessions`.
3. Hide the blinking text caret on non-editable Account and Admin content while
   retaining a normal caret in form inputs, textareas, selects, and editable
   content.

## Implementation

- Delete the disabled `Profile` navigation span from `account.html`.
- Remove the top border from `.sessions` in `account.css` without changing
  session spacing or the individual session separators.
- Apply `caret-color: transparent` to each standalone page body and restore
  `caret-color: auto` for `input`, `textarea`, `select`, and
  `[contenteditable="true"]` elements. This matches the existing library-page
  behavior without disabling text selection or copying.

## Constraints

- Do not make `Profile` clickable or add a replacement placeholder.
- Do not use `user-select: none`.
- Do not change form behavior, focus styling, navigation destinations, session
  data, permissions, or backend behavior.
- Apply the caret rule to both Account and Admin because these standalone
  stylesheets do not inherit the library page's existing caret treatment.

## Verification

- Add focused source-contract tests that fail while the disabled navigation
  item, session-list top border, or missing caret rules remain.
- Run the focused tests after the minimal HTML/CSS changes.
- Manually confirm that Account navigation starts with `Password & security`,
  the first session has no divider directly above it, static text shows no
  blinking caret, and editable controls retain their caret.
