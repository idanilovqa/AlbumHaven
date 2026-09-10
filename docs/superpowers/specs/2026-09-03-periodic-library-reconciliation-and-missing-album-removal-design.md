# Periodic Library Reconciliation And Missing Album Removal Design

## Status

Owner-approved technical and UI design from September 3, 2026. The owner
overrode the mockup gate for this web/server slice. Tauri remains a required
product client, but its implementation is deferred because no desktop
repository exists yet.

The September 4
[targeted filesystem watcher design](2026-09-04-targeted-library-filesystem-watcher-design.md)
supersedes this document's periodic scheduling, native-watcher rejection,
performance, E2E timing, and manual-acceptance sections. The missing-album
state, protected removal transaction, and shared UI adoption remain applicable.

## Problem

Album Haven does not schedule recurring library scans. It scans an empty
library at startup, after an explicit refresh, after library-root changes, and
from a few repair flows. `MUSIC_CACHE_MAX_AGE_SECONDS` controls whether an
invoked scan may reuse a fresh snapshot; it does not invoke scans.

The current scan publication marks files absent from a completed scan as
stale. Browse and Problematic Files queries then exclude those stale rows. The
application has no user-visible state between detection and removal, no
periodic trigger, and no authorized confirmation flow for deleting obsolete
inventory records.

The reported album had five database file rows marked active even though all
five files were absent from disk. The last successful scan predated the
deletion.

## Approved Scope

- Run periodic incremental library reconciliation for configured local roots.
- Detect new, changed, and missing files through the existing scanner.
- Keep a fully missing album visible as a reviewable tombstone until an
  authorized user confirms removal.
- Show the missing state in the gallery, Album Details, and Problematic Files.
- Remove confirmed stale inventory and album-linked data from Postgres.
- Update the open web UI immediately after successful removal.
- Implement the web/server slice now.
- Record Tauri parity as deferred pending creation or attachment of the
  `album-haven-admin-desktop` repository.

This slice does not add Android, TV, or Apple behavior, native filesystem
watchers, hosted-cloud filesystem access, or automatic destructive cleanup.

## Permission And Deployment Decisions

- New capability: `library.inventory.manage`.
- The protected owner and administrator preset receive the capability.
- `library.problems.read` permits viewing missing-album warnings and
  Problematic Files state but does not permit removal.
- Self-hosted private web and Album Haven Node deployments support monitoring
  and removal.
- Hosted cloud without an attached private-media node does not support them.
- A hosted cloud connection to an authorized private-media node is deferred.
- Web is required for this slice.
- Tauri desktop is required for the product capability but deferred for this
  implementation because no desktop repository exists.
- Android, TV, and Apple are unsupported for this slice.

The server evaluates the capability and library scope. Client-projected
allowed actions only control presentation.

## Alternatives

### Scheduled incremental reconciliation

Selected. A monitor checks scan freshness and starts the existing incremental
scanner when the configured interval expires. The scanner enumerates files but
rereads metadata only for new or changed entries.

### Native filesystem watchers

Rejected for this slice. Watchers provide lower latency but add platform,
network-share, overflow, restart, and missed-event recovery requirements. A
later desktop implementation may add watchers as an optimization while keeping
periodic reconciliation as the correctness path.

### Browse-time presence checks

Rejected. Filesystem probes during gallery reads would add latency, couple
browse availability to mounted-path responsiveness, and miss albums that no
user opens.

## Scan Scheduling And Root Health

The application lifespan owns one periodic monitor. The monitor wakes on a
short bounded cadence, compares the last completed scan with the configured
scan interval, and submits work through the existing single scan executor. It
does not start a second scan while one is active.

The configured five-minute cache age becomes the default reconciliation
interval when positive. A non-positive cache age disables periodic scans
instead of creating a busy loop. Manual and settings-triggered scans retain
their current behavior.

Missing-root safety is mandatory. A scan may mark a file missing only when its
own configured root was available and successfully enumerated. An unavailable
drive, disconnected share, permission failure, or failed root traversal creates
an operational root problem and preserves that root's active inventory. A
healthy root cannot cause inventory under an unavailable sibling root to become
missing.

Multiple application processes coordinate periodic scan admission through the
existing scan state plus a non-blocking Postgres advisory lock. The monitor
skips the cycle when another process owns the scan lease.

## Missing Album State

An album is `missing_from_library` when:

- it still has persisted local tracks and file records;
- none of its file records remain active after a successful scan of their
  owning roots; and
- at least one file record transitioned from active to stale because its path
  disappeared.

The first transition records `missing_detected_at`. Later scans preserve that
timestamp. If any file reappears, normal scan upsert clears the stale state and
the album stops being a missing-album tombstone.

Partially missing albums remain outside this slice. Existing active tracks keep
the album in normal browse; later work may add track-level missing-file review.

Browse payloads expose server-owned fields:

- `inventory_status = "missing"`
- `missing_since`
- `allowed_actions["library.inventory.manage"]`

Clients do not receive raw file paths.

## Removal Transaction

The server exposes
`POST /api/library/albums/{album_key:path}/confirm-removal`. The route requires
`library.inventory.manage`, current-library scope, authentication, same-origin
validation, and session CSRF protection.

Before opening the write transaction, the service verifies that the target
album exists, has no active file rows, and remains absent from every available
owning root. If a path or active row reappears, the route returns `409` and
queues or requests reconciliation instead of deleting data.

The short transaction takes the existing inventory publication advisory lock,
rechecks the database predicates, and removes:

- stale local track-file rows owned only by the album;
- local tracks left without another file or album use;
- the local album row;
- album-key and vanished-path rules or projections that would otherwise point
  at the removed inventory.

Existing foreign-key behavior removes album ratings, cover-candidate snapshots,
featured-artist rows, and local assertion rows tied to the deleted album.
Listening-history rows whose foreign keys use `on delete set null` remain as
detached history. The service removes an artist only when no remaining library
data or relationship references it.

The transaction bumps the inventory mutation revision. After commit, the
server invalidates browse, relation, Problematic Files, utility-rule, and modal
detail projections affected by the album.

The response contains the removed album key and refreshed count or view data
needed for deterministic client reconciliation. It contains no private paths.

## Web UI

### Gallery card

A red warning badge overlays the bottom-right corner of the album cover. Its
collapsed state shows `!`. Pointer hover or keyboard focus expands it to
`Album not found` with a short width and label transition. Reduced-motion users
receive the state change without animation.

The badge does not replace the normal card trigger. It exposes the missing
state through accessible text and supports keyboard focus without making the
whole card a destructive action.

### Album Details

Album Details opens from the tombstone card and places a warning panel before
the track table:

`This album was not found under the current library roots.`

Authorized users see `Remove from Album Haven`. Read-only problem reviewers
see `Ask an owner or administrator to remove it.` Missing tracks do not expose
playback, file-open, tag-edit, move, cover-write, or other filesystem actions.

### Problematic Files

The album appears with the album-level reason `Album not found`, using the
approved compact Problematic Files structure. The reason cannot be excluded as
not a problem. Authorized users receive the same removal action; read-only
reviewers receive the explanatory state.

### Confirmation

The confirmation says:

`Remove “{album title}” from Album Haven? Its local files are already missing. This removes the album and its Album Haven data. It does not delete files from disk.`

Actions are `Cancel` and `Remove album`.

On success, the client closes confirmation and Album Details, removes the card,
updates album and artist counts, removes an empty artist section, and refreshes
Problematic Files without a page reload. On `409`, it keeps the album, refreshes
the server-owned state, and reports that Album Haven found the album again.

## Error Handling

- An unavailable root cannot create missing-album tombstones.
- A failed scan leaves the last committed inventory visible and records an
  operational error.
- A duplicate monitor tick does not start concurrent scan work.
- An unauthorized removal returns `403`; the UI does not optimistically remove
  the card.
- A reappeared album returns `409` and preserves all data.
- A database failure rolls back the entire removal and leaves the UI intact.
- A successful database commit followed by a refresh failure returns committed
  removal state and lets the client request a canonical view refresh.

## Functional Cases And Automated Test Proposal

Unit and integration coverage will prove:

- the monitor starts one due scan and skips fresh, disabled, or active scans;
- an available root marks absent files stale while an unavailable root
  preserves inventory;
- all-stale albums project as missing tombstones and mixed active/stale albums
  do not;
- a reappearing file clears the tombstone;
- permission checks allow the owner or an explicitly granted administrator and
  deny a read-only problem reviewer;
- removal rechecks absence, rejects active or reappeared files, commits the
  exact cleanup, preserves detached history, and invalidates projections;
- gallery, Album Details, Problematic Files, confirmation, success, denial, and
  conflict states render and reconcile correctly.

After owner manual acceptance, one production-path Playwright case will use an
isolated Postgres database and generated media. It will delete a generated
album folder after initial indexing, wait for periodic reconciliation, verify
the bottom-right expandable gallery warning, open Album Details, verify
Problematic Files, confirm removal as an authorized actor, and assert immediate
gallery/count cleanup plus durable absence after reload. A denial segment will
verify that a `library.problems.read` actor sees the warning but has no removal
action. The test will restore or delete only its uniquely owned generated data.

## Performance Assessment

Periodic reconciliation reuses the incremental scan and must not add filesystem
probes to browse requests or album-card rendering. The monitor performs no work
when the snapshot is fresh or another scan owns the lease. Missing-state reads
must use set-based active/stale aggregation backed by existing track-file and
album foreign-key indexes; add a partial or composite index only if focused
`EXPLAIN (ANALYZE, BUFFERS)` evidence shows the candidate query needs one.

The feature does not require a new performance E2E contract unless focused
measurements show that the periodic scan, missing-album projection, or gallery
render threatens an existing scan or large-gallery budget.

## Manual Acceptance

The owner will receive a web build or local run with these steps:

1. Add or select a uniquely owned test album and wait for a completed scan.
2. Delete or temporarily move its folder while its library root remains
   available.
3. Wait for the periodic scan.
4. Verify the bottom-right `!` expands to `Album not found`.
5. Verify Album Details and Problematic Files show the approved warning.
6. Confirm removal as owner/admin and verify immediate gallery cleanup.
7. Repeat with an unavailable root and verify Album Haven reports the root
   problem without marking its albums missing.
8. Repeat as a problem-review-only user and verify read-only warning access.

## Merge Boundary

The web/server slice may reach manual acceptance after focused unit and
integration verification. It cannot be described as full product-client
completion while Tauri parity remains deferred. Functional E2E lands only
after manual acceptance. Full regression, review, and publishing follow the
normal feature workflow after the accepted E2E slice.
