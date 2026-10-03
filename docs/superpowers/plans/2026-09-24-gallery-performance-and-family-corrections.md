# Gallery Performance and Artist Family Corrections

Owner-approved scope, September 24, 2026. This correction continues the multi-root implementation on its existing worktree. The fast automatic cover-search work remains unfinished and separate.

## Delivery outcome

Search and artist navigation must no longer recompute expensive duplicate candidates through correlated whole-library queries. Gallery startup must progress beyond its warm-up preview, render a bounded visible set, and show authoritative artist/album totals for the selected sources. Searching hides artist information while retaining Hoard/New Arrivals card, outline, and icon preferences. Folder-derived family membership uses Main library roots only; albums from every selected source remain visible.

## Evidence

- Selected Neal Morse payload with duplicate attachment: 117,712 ms and 97,043 ms; 86 albums, 18 artists, approximately 3.5 MB serialized.
- Same diagnostic with only duplicate attachment disabled: 2,136 ms. Search for `morse` without attachment: 2,921 ms.
- These are repository timings, not browser acceptance measurements. Duplicate warnings must remain functional after optimization.
- Final same-process read-only measurements: Neal Morse (86 albums) was 10,262 ms cold, 1,854 ms on its first repeat, and 1,122 ms after switching back from Rush. Rush (20 albums) was 1,490 ms initially and 700 ms on repeat. The album counts remained unchanged. Cold timing includes lazy imports and initial inventory discovery; browser/manual acceptance is still required.
- Focused duplicate, non-album inventory, root-sidebar/startup, and domain verification passed 78 tests. Coverage includes exact Unicode artist/title/year identity, full-container conflict checks, root/year provenance, cache invalidation and concurrent publication, fresh positive duplicate sources, and snapshot ownership. A subsequent 40-test fingerprint/cache/snapshot run passed, including the explicit empty-candidate-cache guard and three regressions for transactions committing out of start-time order. The repaired fingerprint SQL also passed a read-only runtime Postgres smoke check.

## Acceptance and implementation checklist

- [x] Replace correlated duplicate candidate discovery with equivalent bounded set-based work; preserve Unicode identity, year matching, source details, and selected-file protection.
- [x] Prove duplicate membership is unchanged with focused tests and measure the real inventory read-only before/after.
- [x] Restrict folder-location facts to Main roots without removing Hoard/New Arrivals albums from identity or gallery projections; intake soundtrack folders cannot suppress Main relationships either.
- [ ] Invalidate/rebuild persisted folder-derived relationships; retain manual/external relationships.
- [x] Repair warm-up continuation and implement progressive gallery loading with existing virtualization (focused verification passed; live manual acceptance pending).
- [x] Compute full filtered artist/album totals independently of the mounted/loaded batch (authoritative source-filtered totals retained across continuation).
- [x] Hide artist information during searches; preserve source card/outline/icon preferences for searched artists (focused component/runtime checks; live manual acceptance pending).
- [ ] Run focused Python and JavaScript checks sequentially, then verify the running app and provide a manual test build.
- [ ] Update the owning multi-root documentation with measured results and remaining acceptance gates.

## Compatibility and rollback

### Browse query reuse

Duplicate discovery first reads compact tag identities and applies the existing domain NFC/casefold/artist/title/year comparison, then retrieves full metadata only for exact candidates and their complete physical containers. Parameterized indexed path ranges prevent a whole-library container sort. The existing database-scoped projection cache retains one compact identity index (15,810 entries, approximately 6.25 MiB on this library), replacing it when the library/inventory/root/exception fingerprint changes. Generation checks, snapshot ordering, and a post-load fingerprint check prevent stale concurrent publication.

Root and override fingerprints compare ordered row IDs, MVCC versions, and timestamps, rather than maximum timestamps alone. This detects edits committed by an earlier-starting transaction after a later-starting transaction, even when row counts and maximum timestamps remain unchanged. The check works across application processes without relying on local invalidation notifications or adding schema.

Only requested albums proven nonduplicated after complete-container validation retain a compact absence result and year/root provenance. Positive duplicate source details are always reloaded. Non-album discovery retains candidate track IDs only (488 in this library), then reloads current rows through the existing inventory query with the ID predicate applied before expensive discovery scans. Empty cached IDs return no rows without invoking the unrestricted inventory path. These caches store no media paths or track/source payloads; fingerprint changes invalidate reuse after publication, metadata mutation, root edits, or exception changes. All reads retain the caller's existing snapshot connection.

### Progressive gallery contract

The existing root sidebar projection now accepts a nonnegative `gallery_offset` and returns six canonical live artists per page. `gallery_page.next_offset` is null at the end. The first response includes the complete source-filtered sidebar and artist/album totals; continuation responses retain authoritative totals and omit repeated sidebar JSON. Missing album projections join the initial page and merge by artist and album key with later live pages, preserving missing-only artists.

The browser retains its virtual row renderer and requests the next page within one viewport of the loaded content's end. Continuations use the existing request ownership and cancellation mechanism. Artist/search navigation stops continuation, and source changes reset the root page; continuation uses loaded source scope rather than a deliberately preserved URL scope. Initial authoritative pages satisfy scan reconciliation without requiring full-library gallery hydration. Search results retain shared source styling, titles, and counts while suppressing artist-information triggers and overlays.

Focused JavaScript verification passed 183 tests covering gallery refresh/lifecycle, source hydration, virtual rendering, source visuals in artist search, and cross-page artist/album ordering. Focused Python verification passed 18 root-sidebar, root-startup, and ASGI routing tests, including canonical rank offsets, scan-state routing, snapshot ownership, and cursor metadata. A subsequent combined family-projection and cover-job run passed 124 tests, including intake soundtrack exclusion and user-owned cover preservation. Existing missing-album projection loading remains unbounded; the normal live gallery hydration is bounded by canonical artist count, not a fixed number of albums. Live browser/manual acceptance remains pending.

No files are moved and no cover images are overwritten by this slice. Reuse Postgres persistence and the existing React/component contracts. Preserve duplicate warnings, artist-family alias handling, permissions, source filters, playback, and keyboard navigation. Relationship rebuild replaces only derived folder relationships. Reverting the query/frontend changes restores prior behavior; a builder-version transition rebuilds derived relationships from their authoritative inputs.

## Delivery checkpoint

Keep these changes on the current unmerged multi-root branch for owner manual acceptance. Full applicable review, CI, E2E, and publication gates remain required before release. Do not mark those gates complete from focused tests alone.
