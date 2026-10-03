# Problematic Files Virtualization Design

## Outcome

Settings must enter and leave Problematic Files without the multi-second pause caused by mounting and destroying every artwork-heavy row. The existing visible design and behavior remain unchanged. The performance contract is exercised against 706 deterministic, production-shaped problematic albums rather than the old 18-item fixture.

## Evidence and cause

The current 706-row catalog creates about 6,200 DOM elements and 627 images. Cached transitions measured roughly 1.97 seconds entering Problematic Files and 2.76 seconds leaving it, while other Settings transitions were materially faster. `renderProblematicFiles` eagerly builds every wide `NavigationTree` row, and the tab/load path can render the same state twice. Leaving the tab destroys the same large tree.

## Runtime design

Add a focused `ProblematicFilesVirtualList` runtime module. It owns only list windowing; filtering, selection, details, repair actions, and API state remain in the existing utility runtime.

The module accepts the list element, filtered albums, selected key, and row-render callback. It renders an overscanned visible range and spacer geometry representing unmounted rows. Desktop uses the established 68-pixel row stride: the existing 60-pixel minimum row height plus the 8-pixel list gap. Mobile keeps the existing horizontal card strip and uses measured horizontal stride with a stable fallback. At ordinary modal sizes, roughly 20–40 rows are mounted instead of all 706.

The virtualizer must:

- preserve scroll position across ordinary rerenders and cached tab switches;
- reveal the selected row when selection changes outside the mounted range;
- preserve native focus and keyboard/click behavior for mounted `NavigationTree` rows;
- rerender on scroll and resize through one scheduled animation frame;
- expose mounted-range metadata for deterministic unit and E2E assertions;
- tear down listeners and scheduled work when another Settings tab replaces the list;
- keep artwork lazy and create artwork markup only for mounted rows.

`renderProblematicFiles` remains the owner of filtering, count, selection reconciliation, detail rendering, and row updates. It delegates list markup to the virtualizer. Empty and loading states dispose the virtualizer and render their existing messages.

Tab activation becomes the single render owner. A cached loader returns data without rendering. An uncached loader renders its loading and completion states only when no navigation activation owns rendering. Navigation renders once after the selected loader settles. This removes duplicate synchronous work without changing API behavior.

## Responsive behavior

Desktop and mobile keep their current layouts. Desktop windowing uses vertical scroll. At the existing 720-pixel breakpoint, the Problematic Files strip remains horizontal and is windowed on `scrollLeft`. Rules and other Settings lists are unchanged.

## Sanitized fixture

Update the `utility-problematic-files` generator in the test-data repository to produce exactly 706 problematic albums. Data is deterministic and synthetic. It must not copy owner paths, music metadata, media, database contents, credentials, or other private values.

The fixture mirrors only aggregate workload characteristics:

- 706 problematic albums;
- approximately 627 cover-backed rows;
- the existing six problem types and required named behavioral cases;
- varied issue combinations and distribution;
- long names, Unicode, mixed years, and missing-cover cases;
- production-shaped compact summaries and detail payloads.

Existing named cases used by search, filtering, detail, encoding, and incomplete-track assertions remain present. The old 18-item count is replaced; useful behavioral coverage is retained or strengthened.

## Automated verification

Unit tests cover visible-range calculation, overscan, vertical and horizontal modes, selection reveal, cleanup, and bounded mounted rows. Renderer tests prove a 706-item input does not build 706 rows. Loader/navigation tests prove cached and uncached tab activation has one render owner.

Fixture tests assert exact counts, deterministic rebuilding, sanitized paths, the cover ratio, Unicode/long-name cases, and all named problem contracts. Application loader and benchmark contracts change from 18 to 706.

The production-app Playwright scenario uses isolated Postgres plus generated media and measures:

- initial Problematic Files readiness;
- cached non-problematic tab to Problematic Files readiness;
- cached Problematic Files to non-problematic tab readiness;
- a repeated cached cycle;
- mounted-row count substantially below 706;
- search, filters, selection, detail, and payload contracts already covered by the scenario.

Every transition retains the approved 1,000 ms target, 200 ms grace, and 1,200 ms hard ceiling. Reports classify target met, grace used, or hard failure.

## Compatibility and rollback

No route, database schema, permission, capability, or public API changes. Web and Tauri use the same required runtime behavior. Android, TV, and Apple clients are unsupported for this server-rendered Settings modal. Rollback is removal of the virtualizer integration plus restoration of eager row rendering; fixture artifacts remain versioned independently.

## Delivery boundary

This is one cohesive delivery: virtualized rendering, single-render navigation ownership, a 706-row sanitized fixture, and the focused performance contract. No visual redesign, new component primitive, or broader Settings refactor is included.
