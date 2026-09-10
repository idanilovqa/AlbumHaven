# Missing Album Removal Regression Design

## Context

The missing-album removal service now calls the PostgreSQL function
`library.confirm_missing_album_removal(text)`. Migration `0061`, which should
create and grant access to that function, is absent. A real removal request
therefore fails before the UI can update.

The existing functional E2E follows the production watcher, gallery, modal,
API, and Postgres path. It checks that the modal closes, the card disappears,
and the deletion survives reload. It does not assert the post-removal card
order, preserved scroll position, lack of an error toast, or absence of a page
reload. The service changed after that E2E was authored, and the current
working tree has not passed the scenario with the function-backed service.

## Approved Behavior

An owner confirms removal through the existing app confirmation dialog. The
API removes only an album whose known files remain stale and whose owning
library roots are available. A successful response closes Album Details,
removes the card through one in-place gallery render, preserves the gallery's
scroll position, and leaves the remaining albums in their normal sort order.
The browser must not reload the page, show a loading reset, or display an error
toast. Reloading afterward must prove the deletion is durable.

If a file reappears or a root becomes unavailable, the transaction rolls back
and the existing conflict behavior remains unchanged.

## Implementation

Add `migrations/postgres/0061_create_missing_album_removal_function.sql`. The
security-definer function will own the existing transaction SQL, set a bounded
`pg_catalog` search path, lock the inventory publication boundary, recheck the
album and file state, delete only the confirmed missing album, advance the
inventory revision, and return the state consumed by
`PostgresMissingAlbumRemovalService`. Revoke public execution and grant execute
only to `album_haven_app`; do not grant direct table deletion.

Keep the current JavaScript success path. It already applies the response to
the in-memory view, asks the gallery renderer to preserve scroll, then closes
Album Details. Strengthen its unit contract only if the new E2E exposes a
product defect in that path.

## Automated Coverage

The migration test must fail while `0061` is absent and pass only when the
function, security boundary, mutation statements, and grants exist.

Extend `FTC-LIBROOTS-016 / 017 / 018` without changing its timeout or production
path. Capture the removal response, page URL, scroll position, and remaining
album order. After confirmation, assert a successful API response, both modal
overlays hidden, no removal error toast, no main-frame navigation, stable scroll,
the target card absent, and the two surviving cards ordered as if the target
album had never existed. Keep the existing Postgres and reload durability
checks.

## Scope

This maintenance fix does not add permissions, actions, client support, visual
components, or deployment modes. It completes the already approved
missing-album removal contract and its existing web E2E coverage.
