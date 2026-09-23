# Library Status Page Design

## Outcome

The Library Status Page is a dedicated non-gallery surface. Opening it replaces the active GalleryBar with a Library Status Page bar and replaces gallery content with concise library state and health information.

## Header ownership and DOM lifecycle

- The gallery page DOM contains only the GalleryBar.
- The Library Status Page bar does not exist in the DOM until the page opens.
- Opening the page detaches the existing GalleryBar, closes its anchored surfaces, and mounts a Library Status Page bar in the shared header slot.
- Closing the page removes the status bar and restores the same GalleryBar instance and prior gallery context.
- Header switching must not depend on hidden duplicate bars or CSS visibility swapping.
- The status bar reuses GalleryBar structure and shared button styles. It contains the themed Back control, the title `Library Status Page`, the live status summary, and applicable scan actions.

## Invocation labels

- Idle status dropdown: `Open Library Status Page`.
- Busy status dropdown: `Go to Library Status Page`.
- Existing operational terms such as `Full Rescan`, `Cancel Scan`, and scan progress copy remain scan-specific.

## Page body

The page body uses a status workspace rather than a centered loader stack.

### Library State

- Displays the current high-level state and concise supporting text.
- The ready state shows a green checkmark beside `Your local library is ready.`
- Displays active progress and the existing four scan stages: Discover files, Read tags and metadata, Update cover art, and Refresh artist relations.
- Reuses existing theme tokens and progress styles.

### Library Health

- Appears only when a warning or error exists.
- Uses the existing on-page alert component and shared button component.
- Keeps the warning concise and retains applicable actions such as `Full Rescan`.
- Does not render an empty health panel when the library has no health issue.

## Layout

- Healthy state: one Library State column.
- Warning or error state: conditional two-column layout with Library State on the left and Library Health on the right.
- Narrow screens stack Library Health below Library State.
- Content is left-aligned within a bounded workspace; alerts no longer occupy the center of the screen.

## Behavior and compatibility

- Keep the current FastAPI, Postgres, JavaScript, Jinja, and CSS stack. No React migration.
- Preserve scan, cancellation, browse-results, watcher acknowledgement, and Back behavior.
- Keep status updates live while the page is open.
- Do not expose private library paths or fixture data.

## Verification

- Unit coverage proves the Library Status Page bar is absent from the initial gallery DOM, mounted on open, removed on close, and replaced by the original GalleryBar.
- Contract coverage proves the new header and dropdown wording.
- Rendering coverage proves the green ready check, conditional health section, compact shared alert, and responsive state/health layout.
- Focused browser/component coverage verifies that gallery context and controls never appear on the Library Status Page.

