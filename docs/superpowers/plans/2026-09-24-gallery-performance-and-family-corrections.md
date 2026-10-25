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

### October 6 reconstruction-cost repair

This repair continues the duplicate-membership/performance acceptance items;
it does not complete browser acceptance. An isolated diagnostic measured a
40,345 ms full-root handler, including 35,354 ms of duplicate attachment and
11,556 ms of reconstruction. A separate full-root-key diagnostic measured
2,685 ms server execution and 5,903 ms query-plus-fetch. Its profiled
reconstruction took 15,918 ms; profiler overhead and different key scope prevent
using that value as a browser benchmark. Path construction is a measured hotspot.

The bounded implementation proposal reuses immutable cover-path objects within
one reconstruction call and avoids reparsing already-normalized Path inputs at
the existing album-container helper. Prerequisites are failing operation-count
regressions and compatibility cases for strings, Paths, whitespace, dot segments,
drive/UNC roots, disc folders and Unicode. Preserve the old normalization path
when the fast-path preconditions do not hold.

Acceptance requires complete same-input domain equality, including physical
container validation, metadata conflicts, selected covers, source order, track
references and provenance. Do not prune candidates, change query projections,
introduce a persistent cache or relax the existing browser timing contract.
After focused verification and review, rerun that unchanged browser check.
Rollback changes only the two responsible source seams and their tests. Commit
and full-CI promotion remain part of the repair batch; no service, media or
database mutation belongs to this unit. Existing checklist gates remain open.

### October 4 startup hydration regression repair

CI exposed startup views remaining at the sidebar tier: automatic root pagination
downgraded the configured full followup, while page metadata suppressed that
followup entirely. This repair restores the configured sidebar-to-full startup
sequence and preserves ordinary root navigation/continuation pagination. It is
part of the existing warm-up-continuation checklist item, not a new feature.
Acceptance requires a real-shaped initial sidebar page to remain incomplete
until its full followup applies, the followup URL to retain `omit_sidebar`, and
ordinary root requests to retain bounded pages. Existing E2E expectations and
performance budgets remain unchanged. Compatibility preserves the server's
existing hydration contract; rollback is limited to this request/readiness
repair. Review, full hosted CI, and manual acceptance remain merge checkpoints.

Restoring full startup hydration can increase startup payload and rendering cost
relative to a permanently partial root page. Focused runtime tests prove request
and readiness behavior only; the unchanged browser performance suite must measure
that cost before release. No new timing allowance is authorized.

Regression proof: the new sidebar-page case first failed because startup was
marked complete (`1` rather than `0`); the existing full-followup case failed
because its URL was downgraded to `payload_tier=sidebar`. The narrow runtime
repair excludes startup requests from automatic pagination and preserves the
configured full followup despite initial page metadata. Five existing startup
unit expectations now require the full URL their test contracts name; no E2E
expectation changed. Focused verification passed 161/161 tests, zero failures or
skips, in 1.107 seconds using
`node --test --test-concurrency=1 tests/js/runtime/gallery-refresh-and-status.test.js tests/js/runtime/bootstrap-init-playback-ownership.test.js`.
The adversarial follow-up pass found that initial page metadata also cleared
startup ownership and allowed an automatic continuation to cancel the queued
full request. An additive assertion reproduced that failure. Startup pages now
retain the awaiting flag, and automatic continuation waits for startup to
finish. The final green run above includes that regression and existing ordinary
root paging and continuation checks. Browser
startup costs and the complete hosted suite are still unverified.

Keep these changes on the current unmerged multi-root branch for owner manual acceptance. Full applicable review, CI, E2E, and publication gates remain required before release. Do not mark those gates complete from focused tests alone.

### October 6 measured reconstruction-repair checkpoint

The unchanged root-browse benchmark failed at **33,196 ms against the 6,400 ms
hard ceiling**, with one failed case and exit 1. Functional root assertions
passed before the timing assertion. The verifier retained
`benchmark-path-v1.capture.log` and SHA-verified copies of the trace and error
context in `benchmark-path-v1-artifacts`. No threshold, retry allowance or E2E
assertion changed. Performance acceptance remains open.

Complete same-input OLD/NEW reconstruction parity passed for 57,980 fetched rows
and 5,329 albums. `path-parity-v1-evidence/metadata.json` records source hashes,
equal canonical/domain projections and the matching domain SHA256
`6f11a57ff96a9ab58910145d81fc97b8ff90d56c46b136c32d59620aae7d99ca`.
The parity run measured 7.892s baseline and 7.963s current reconstruction; it
establishes compatibility, not a speedup or browser acceptance. Focused checks
passed 216 cases across overlapping selections; this is not a unique-test total.

The operator rebuilt the 77-module runtime and restarted normal shared-browsing
sandbox3 from the current dirty feature worktree. The recorded handoff verified
strict inventory startup, local/public Album Haven login200 and cookieless
bootstrap401, with production unchanged and no cover pass started. Authenticated
manual feature acceptance remains open. Separately, the truthful progress label
`cover searches completed` passed five focused checks (two status, three
view/progress); downloaded artwork retains its separate count.

Exact E2E flow changes still await owner approval, and the complete native CI
pipeline has not rerun. Browsing-enabled cover-maintenance composition also
awaits approval. Preserve the checklist above: focused tests, parity and this
manual-test deployment do not close performance, manual, CI or release gates.
Exact task elapsed time was not recorded.

### October 6 corrected architecture proposal, awaiting owner approval

Read-only inspection of the complete retained `.prof` found no calls to
`_build_album_duplicate_source_payload` or `_track_to_dict`: positive-source
serialization was absent in that profile. A simple late serialization split
therefore lacks evidence as a repair for this measured workload and is rejected.
The older profile contains 57,980 rich-row adaptations taking 2.726s, including
0.849s of exception normalization, and 173,807 Path constructions taking 5.461s.
These timings overlap and must not be added. They do not decompose the latest
33,196ms browser result or establish a current speedup opportunity of that size.

The revised proposal has two stages at the existing `library.py` domain boundary.
First, analyze complete rows and physical containers for identity, metadata
conflicts and provenance under the current domain rules, before rich Track/cover
adaptation. Then materialize rich data only for groups proven to have positive
duplicate sources. Analyze the full input; do not discard rows or infer absence
from compact identities alone. Query, cache and persistence changes are outside
this proposal unless the owner approves a separate justified change.

Acceptance requires complete OLD/NEW output and error parity, ordering and
provenance parity, and preservation of physical-container closure. The unchanged
6,400ms browser hard ceiling still applies. The proposal promises no speedup and
has no implementation or new tests yet. Owner technical approval is pending;
exact UI/manual, cover-composition/retry and E2E approvals, complete CI and release
gates remain open. Existing checkbox counts are unchanged.
