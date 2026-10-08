# Problematic Files and loading polish design

## Outcome

Open Problematic Files within the existing 1,000 ms target and 1,200 ms hard ceiling while preserving the complete authoritative dataset, search, filters, detail loading, and the default complete API response. Also strengthen selected Suggested Edit labels, make drag selection immediate and stable, and improve startup progress length, percentage feedback, and motion.

## Measured bottleneck

The Problematic Files request does not traverse the filesystem. It queries Postgres, transfers candidate rows, rebuilds every problematic album summary in Python, sorts all summaries, builds the first detail, deep-copies the result into the process cache, and serializes about 1.96 MB.

Pinned `fixtures-v1.0.25` evidence, 706 problematic albums and 7,200 files:

- complete repository build: 1,391 ms on the least-contended run; instrumented runs were 1,687–2,043 ms;
- candidate row query and conversion: 572–651 ms;
- album projection: 399–405 ms;
- reason and summary construction: 364–710 ms;
- relation aliases: 80–104 ms;
- JSON serialization: 16–31 ms;
- warm in-process cache hit: 40 ms;
- candidate SQL `EXPLAIN (ANALYZE, BUFFERS)`: 87.72 ms planning, 232.855 ms execution, 7,200 rows, all shared-buffer hits, no reads or temp spill.

The query is material work, but the dominant delay is the complete cold projection pipeline, not a tree walk or JSON serialization. The existing cache is fast after population but does not make the first user-visible load fast.

The canonical Playwright target is presently blocked before measurement by a separate worker-authentication harness failure: HTTP prewarm login succeeds, but the worker's second browser login remains on `/login`. The database contains the expected owner credential with no throttle or failed-login audit row. That failure remains a harness investigation item; it is not treated as performance evidence.

## API and loading contract

The existing `GET /utilities/problematic-files` contract remains unchanged and complete.

Add an optional bounded initial request:

`GET /utilities/problematic-files?limit=50`

The repository discovers candidate album IDs, orders them by the same title/artist/year contract, fetches rows only for the first 50 active candidates, folds in missing-inventory summaries, and returns the same summary/detail shape with additive completeness metadata. It must not build then slice the complete payload.

The client:

1. requests the bounded first page;
2. paints it immediately, including the first selected detail;
3. starts the unchanged complete request immediately;
4. atomically replaces summaries with the complete response while preserving current selection/detail ownership;
5. exposes search and problem filtering only against the complete response. If an action arrives first, it awaits the in-flight complete request rather than searching a partial set.

The complete response replaces the bounded response as one snapshot, so page revisions are never merged and mixed-revision state cannot occur. Mutations retain the existing invalidation and reload ownership rules.

## Suggested Edit interaction

Selected labels use a clearly saturated green fill, stronger border, and selected-state text contrast. Unselected labels retain the quieter neutral/green-tinted treatment.

Drag intent is fixed by the origin label: starting on an unselected label selects; starting on a selected label deselects. The origin updates on pointer-down. Movement processes only newly crossed indices, fills skipped indices, and does not recompute and resynchronize the full anchor range for every mouse pixel.

## Startup progress

The progress track becomes responsive and materially longer, with a visible integer percentage tied to the displayed progress. Stage changes animate through a requestAnimationFrame-driven displayed value; the bar and percentage finish smoothly before dismissal. Reduced-motion users receive immediate stage updates without ornamental interpolation.

## Compatibility and rollback

- Web and Tauri use the same runtime and are required.
- Android, TV, and Apple are unaffected by this desktop utility/loading change.
- The default complete endpoint and response fields remain compatible.
- Removing the bounded query parameter and client two-stage load reverts the performance slice without data migration.
- CSS and interaction changes are independently reversible.

