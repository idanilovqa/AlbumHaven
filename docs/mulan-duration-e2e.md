# Mulan gallery duration regression

Owner request: cover the Mulan gallery card showing approximately eight hours while Album Details shows the correct album duration.

`FTC-GALLERY-030` uses the production app and visible unfiltered gallery, search, artist navigation, reload, and Album Details controls. It asserts 14 tracks and a gallery duration of `56m 18s`, with an independent Album Details total of `56m 18s`. Duration assertions are soft so all gallery entry points can report failures in one run; fixture and Details assertions remain hard failures.

The companion functional-core generator supplies a synthetic Mulan (1998) album owned by Various Artists, eight existing synthetic credited artists, thirteen 240-second tracks, and one 258-second track. Generated audio matches these durations. Equal-length tracks ensure that deduplicating by duration instead of track identity cannot satisfy the test. No personal music is copied and no application routes are mocked.

CI ownership: gallery-search-visual, functional-core. The added scenario requires a new fixture release; the currently pinned published fixtures-v1.0.19 does not contain it. Local validation uses the explicitly labeled fixtures-v1.0.19-mulan-local build. No published fixture release or CI pin has been changed.

The duration fix joins each rollup to distinct (library_id, album_id) keys, preventing artist credits from multiplying track durations. It covers unfiltered, artist-scoped, and search gallery queries.

## Local verification

The final exact browser run completed every step and reported one expected regression: unfiltered gallery expected `56m 18s`, received `8h 26m`. Search, Album Details (14 rows and exact shared-table total), artist navigation, and reload completed successfully. This is the preserved pre-fix failure evidence.

The fixture duration/audio contract and two fixture-source contracts passed. Playwright discovery and production-path validation passed. Earlier local attempts exposed and corrected fixture padding and obsolete test-helper/locator usage; a concurrent settings E2E lock collision was resolved only in the task-local runner by isolating its temporary directory.

## Fix verification

The unchanged Mulan E2E passes all four steps after the rollup fix. The real library query independently returns 14 tracks and 3378 seconds for all nine Mulan artist rows. Browse unit tests report 190 passed and 22 failed; importing the original HEAD implementation in a separate test process produces the identical 22 failure names, confirming no new failures in that file. All 26 CI shard contract checks passed in the preceding coverage work. The isolated test database, roles, servers, and scoped ports were cleaned up.
