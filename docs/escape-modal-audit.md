# Escape modal audit

Scope: current application JavaScript and rendered dialog templates on
`2026-09-09-cover-look-up-refactor`.

Escape is handled once during document capture, before control and document
bubble handlers. The visible foreground overlay is resolved using computed
stacking contexts and document paint order, rather than a fixed modal priority.
Hidden ancestors and non-rendered overlays are excluded. Repeated keydown events
cannot cascade through dialogs.

| Surface | Escape action |
| --- | --- |
| Edit tags | Cancel an active reorder; otherwise clear a multi-file selection; otherwise cancel the editor |
| Album details, cover lookup, loose tracks, version picker, full-screen cover | Existing close action for the foreground surface only |
| Tag apply, repair, cover deletion confirmations | Existing cancel action; never apply the pending operation |
| App confirmation, app form, loop naming, loop deletion | Click the owning Cancel action so its promise settles and focus cleanup runs |
| Settings | Cancel an active saved-loop edit first; otherwise discard Appearance drafts and close; retain the in-flight-save guard |
| Repair progress | Consume Escape without closing the operation or an underlying dialog |

Gallery surfaces, account menus, drawer navigation, dropdowns, search suggestions,
and player loop shortcuts retain their nonmodal behavior when no modal is open.
Their Escape listeners cannot receive a keypress owned by a modal. The Artist
information popover is nonmodal and sits below the modal layer. Standalone member
menus have local menu dismissal, not modal dismissal.

Regression coverage:
- Node tests exercise every modal route, ordering, hidden surfaces, stacking
  ancestors, cancellation, held keys, and empty tag selections.
- Chromium component tests use production tag markup, styles, rendering, shared
  confirmations, and Escape routing to check actual keyboard propagation.
- Existing tag editing, dialogs, lightbox, and stacking tests remain required.

Manual acceptance:
1. Open Album details, open Edit tags, select multiple files, press Escape.
   All file selections clear; the editor and Album details stay open.
2. Press Escape again. Only Edit tags closes; no tag edits are submitted.
3. Open a confirmation over an editor and press Escape. Only the confirmation
   cancels; the editor and its draft remain.
4. Open a full-screen cover or another stacked dialog and press Escape.
   Only the foreground surface closes.
