# Album Details Immediate Close Design

## Outcome

Clicking the Album Details X button closes the modal visibly on the next browser paint, including with a large library loaded.

## Cause

The click handler marks the modal hidden immediately, then performs DOM clearing and full-view compaction in the same JavaScript task. The browser cannot paint the hidden state until that synchronous cleanup finishes, so the close appears delayed.

## Design

Keep close-critical work synchronous: hide the overlay, remove foreground styling, invalidate pending detail loads, reset modal identity state, close the version menu, update the body modal-open state, and release suspended gallery loads.

Defer expensive rendered-DOM clearing and view compaction until after the browser has had one paint opportunity. Give deferred modal cleanup a generation token. Opening or closing the modal advances the generation so an obsolete callback cannot clear a newly reopened modal. View compaction may still run when safe because it preserves the existing memory contract.

Use the existing browser scheduling helpers. No new dependency, animation, API, persistence, or server behavior.

## Compatibility and failure behavior

- Keyboard, overlay, mobile-page, and X-button close paths continue through the same close function.
- Pending album-detail responses remain invalidated synchronously.
- A rapid close/reopen cannot erase the reopened modal.
- Environments without animation-frame scheduling retain a safe fallback.
- Existing gallery-cover suspension and body scroll-lock behavior remain unchanged.

## Verification

1. Add a focused JavaScript regression test that injects expensive cleanup and proves close-critical state changes before deferred cleanup runs.
2. Add a rapid close/reopen test proving stale deferred cleanup does not clear the reopened modal.
3. Run the focused modal helper test sequentially.
4. Rebuild the runtime bundle and run its focused consistency test if required by the repository build contract.
5. Verify the real X-button path in Sandbox1 with a large library.
6. Perform at least two complete local diff-review passes.

## Scope

Only Album Details close responsiveness and its regression coverage. No visual redesign, close animation, server changes, or database changes.
