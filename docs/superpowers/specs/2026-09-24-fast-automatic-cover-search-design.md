# Fast automatic cover search for the multi-root scan

## Status

- [x] Owner approves the search behavior (September 24, 2026): Apple, Deezer,
  YouTube Music, then Spotify; stop at the first confident match at least
  1,200×1,200; otherwise use the best matched smaller cover; try Bandcamp only
  when all four return no valid cover. Keep deeper page searches in Find Better
  Art.
- [ ] Owner reviews this written design and the operational replacement plan.
- [ ] Record the focused test plan, add failing tests, implement, and verify.
- [ ] Owner approves stopping the currently running slow cover worker before
  its in-memory cache changes are published.

This is a performance correction to the approved multi-root delivery, not a
new UI or a move feature. A separate HTTPS review server serves the current
multi-root build on port 5001. The old cover-only runner remains live until an
explicitly approved replacement.

## Evidence and design choice

The current bulk path runs one job worker. Automatic Apple search uses
`collect_apple_matches`, which probes API artwork and, when it is not
sufficient, fetches up to two album web pages per query. It can then try artist
lookup and more query variants before Deezer and Spotify. The separate
`allow_web_fallback=False` flag does not disable those album-page fetches.
Individual HTTP operations have 15–30 second timeouts. The 120-second provider
deadline applies to manual cover lookup, not this automatic batch. Observed
throughput dropped as low as one completed job in 30 minutes.

Considered approaches:

1. Use a distinct bounded automatic resolver (chosen). Keep only provider
   API/search results and a bounded number of queries; reserve Apple album,
   artist and web-page exploration for Find Better Art. This directly removes
   the measured slow path without degrading the manual tool.
2. Increase bulk worker count while retaining the rich resolver. This can
   amplify page requests, rate limits and memory pressure without fixing
   per-album latency.
3. Lower HTTP timeouts in the shared resolver. This changes manual Find Better
   Art and can create false misses while retaining unnecessary page work.

## Automatic resolver contract

For an album folder, preserve existing user-selected artwork and validate
containment before any write. A valid local cover at least 1,200×1,200 needs
no automatic remote improvement. A smaller local cover remains a fallback.
Respect enabled-provider and provider-group settings.

Query Apple API, Deezer, YouTube Music, then Spotify, in that order. Each
provider uses its existing artist/title/edition/year matching policy, with at
most an exact query and one normalized retry if the exact query has no valid
match. Automatic Apple work never fetches album, artist or generic web pages.
Probe only a promising candidate's image when dimensions cannot be trusted
from provider metadata. Stop at the first confidently matched image with both
edges at least 1,200 pixels.

If no provider yields that size, select the best valid smaller image from the
four using match confidence, then dimensions; do not replace a better local
cover with a worse image. Only when none of those four yields a valid cover
may the existing Bandcamp provider run, subject to its enabled setting.
No-match, provider failure, and skipped-provider outcomes remain distinct.
Automatic selection never overrides a manual/user-owned cover. Find Better Art
keeps its current rich, multi-candidate search, including Apple page discovery.

The automatic path must have a bounded per-provider and per-album wait so one
slow remote service cannot monopolize the scan. Use the existing bulk-worker
setting for modest concurrency only after focused provider and resource checks;
do not infer that more workers alone solves the problem. Measure actual
per-provider elapsed time and batch throughput in the replacement run before
claiming a speedup.

## Transition and recovery

The current runner writes individual cover images during the loop but updates
the scan cache and saves the lookup cache after the loop. Stopping it now may
lose in-memory metadata, not the image files. Do not stop or replace its exact
PID without the owner's pending approval.

After the new resolver passes focused tests, inventory covers written since the
old run began, verify they are inside authorized album folders, and reconcile
their paths/revisions through the existing scan-cache owner. Do not delete or
overwrite them. Only then stop the exact old worker if approved, verify its
process tree exited, and run a replacement cover-only pass against the already
published 159,545-file inventory. Do not repeat the full library scan.
Checkpoint updated cover metadata and lookup-cache state in bounded batches so
a later interruption does not discard the entire pass. Replanning must skip
already satisfactory local/user-owned art and retain no-match visibility.

## Verification and compatibility

Focused tests must prove provider order, first qualifying 1,200px stop,
best-smaller fallback, Bandcamp-only-after-total-miss, bounded query count,
automatic Apple page exclusion, manual page-search preservation, disabled
provider behavior, wrong-artist/year rejection, selected-cover protection,
local-cover recovery, and interrupted-batch checkpoint/resume. A mocked slow
provider test must show the next job can progress under the automatic budget.
Run a small live smoke only after deterministic tests pass; record timing and
provider errors without exposing music paths or raw media.

No schema or capability migration is planned. Existing covers, roots, duplicate
groups, playback, and manual Find Better Art remain compatible. Rollback
restores the previous automatic resolver; persisted image and cache entries stay
readable. Web and private-node support remain required; Tauri optional; native
Android, TV and Apple unsupported for this early delivery. Manual acceptance,
functional E2E, complete CI, review and publication gates remain open.
