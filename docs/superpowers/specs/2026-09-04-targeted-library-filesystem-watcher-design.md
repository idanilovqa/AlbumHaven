# Targeted Library Filesystem Watcher Design

## Status

The owner approved this design on September 4, 2026. It supersedes the
scheduled-reconciliation sections of the September 3 missing-album design.
The missing-album review and removal flow remains in scope, with the gallery
badge copy changed to `Album deleted`.

## Problem

Album Haven currently discovers a deleted album only after a library scan.
Its incremental scan still enumerates the whole library before it publishes
missing rows, so a 57,975-file library took more than three minutes to mark one
deleted album stale. Cached cover art then made the absent album look present.

The server needs a small maintenance path that reacts to filesystem changes
while it runs. New, changed, moved, and deleted media must update Postgres and
the open web UI without enumerating unrelated roots. Full scans remain initial
import and manual recovery operations.

## Approved Scope

- Start a filesystem watcher with the Album Haven server and stop it during
  server shutdown.
- Watch each configured local library root for create, modify, delete, move,
  and root-health events.
- Coalesce event bursts by affected album directory and reconcile only those
  paths.
- Publish successful targeted changes to Postgres and advance the library
  inventory revision so the open web UI refreshes.
- Preserve a fully deleted album as a reviewable tombstone until an authorized
  owner or administrator confirms removal.
- Report watcher overflow, missed-event, and root-disconnect conditions without
  deleting inventory.
- Measure event-to-UI latency before setting a performance threshold.

The watcher does not recover changes made while the server is stopped. The
owner can run a manual full scan after offline changes or watcher-health
failures. Ordinary watcher events and watcher overflow do not start a full
scan.

## Permission, Deployment, And Client Decisions

The watcher is server-owned maintenance and needs no actor capability. It may
change inventory only inside configured library roots. The existing manual
full-scan action keeps its current authorization.

`library.inventory.manage` authorizes confirmed removal of a fully missing
album. The protected owner and administrator preset receive the capability.
`library.problems.read` permits the user to see missing-album and watcher-health
problems but never permits removal or a protected scan action.

- Web: required.
- Tauri: product-required, deferred because no desktop repository exists.
- Android: unsupported.
- TV: unsupported.
- Apple: unsupported.

Self-hosted private web and Album Haven Node deployments support the watcher.
Hosted web without an attached private-media node cannot watch local roots.

## Architecture

### Service boundaries

FastAPI lifespan owns a `LibraryWatchService`. The service has four boundaries
that can move into a separate process in a future service stack:

- `LibraryEventSource` translates platform events into normalized create,
  modify, delete, move, root-unavailable, and overflow events.
- `LibraryEventCoordinator` debounces event bursts, groups work by root and
  album directory, and preserves both sides of a move.
- `TargetedLibraryReconciler` reads stable files, derives inventory mutations,
  and rejects destructive decisions for unhealthy roots.
- `LibraryInventoryRepository` commits scoped mutations and advances the
  Postgres inventory revision.

The first implementation uses `watchdog` behind `LibraryEventSource`. Tests
inject a deterministic event source instead of depending on an operating-system
watcher.

### Event processing

The coordinator accepts raw events on a bounded queue. It normalizes paths
against the configured root that produced the event and rejects paths outside
that root. It coalesces duplicate events for one affected directory. Directory
delete and move events retain explicit subtree semantics so a removed album
folder marks its descendant tracks stale. A move keeps source, destination, and
both root identities together so one transaction can mark the old paths stale
and upsert the new paths.

Creates and modifications pass a stable-write check before metadata parsing.
The check samples size and modification time until two consecutive samples
match. If a file disappears during the check, the coordinator converts the
work to deletion reconciliation. The coordinator retries bounded transient
sharing violations and records a problem after the retry budget expires.

Each work item covers one album directory or the smallest safe subtree for a
directory move. No ordinary event may invoke the full scanner or enumerate an
unrelated library directory.

### Postgres publication

The targeted reconciler creates one mutation set outside the write transaction.
The repository then opens a short transaction, takes the existing per-library
inventory advisory lock, and performs atomic upserts and stale transitions.
It updates only rows owned by the event's library root and normalized relative
paths.

Stale transitions preserve `metadata.scan_cache.file_entry` and add stale
fields without replacing the stored file-entry object. This keeps enough
metadata to render a missing-album tombstone even when the file and cached cover
source no longer exist. Active upserts clear stale fields.

The commit increments `inventory_mutation_revision`. After commit, the server
invalidates only affected browse, album-detail, relation, Problematic Files,
and cover projections. A changed revision drives the existing web refresh path.

Queries use `library_id`, root identity, and normalized relative path as their
leading equality predicates. The implementation adds a composite or partial
index only when focused `EXPLAIN (ANALYZE, BUFFERS)` evidence shows the existing
indexes do not support those predicates.

### Coordination with manual scans

The watcher and manual scanner share the per-library advisory lock and revision
contract. Filesystem events continue to enter the bounded coordinator while a
manual scan runs. The coordinator coalesces them and processes the remaining
affected paths after the scan commits. A scan result may subsume an event only
when its completed snapshot includes the event's root and a revision check
proves the event predates that snapshot.

The server removes the periodic reconciliation timer. Startup may perform the
existing initial import only when the library has no completed inventory.
Users start later full scans through the authorized manual action.

## Root Health And Missed Events

The event source marks a root unhealthy when the operating system reports an
overflow or missed-event condition, the watcher stops, or the root becomes
unavailable. The coordinator then blocks delete and stale mutations for that
root. It may retain non-destructive diagnostics, but it cannot infer absence.

The Library Status control shows an amber state. Problematic Files keeps one
non-excludable operational item with this copy:

`Some library changes may have been missed.`

An authorized user can start a manual full scan from that state. Album Haven
does not start the scan on the user's behalf. A successful full scan of the
root clears its watcher-health problem and lets targeted reconciliation resume.
An unavailable root preserves the last committed inventory.

## Missing Album State And Removal

An album becomes `missing_from_library` after a healthy targeted reconciliation
marks all its persisted local file rows stale. Cached artwork can remain, but
cover availability does not affect inventory status. If any file reappears, a
targeted upsert clears the tombstone.

The server exposes these public fields without raw paths:

- `inventory_status = "missing"`
- `missing_since`
- `allowed_actions["library.inventory.manage"]`

The protected removal route and transaction follow the approved September 3
design. The service rechecks that no active row or available path has
reappeared, returns `409` on conflict, removes app-owned album inventory in one
transaction, advances the revision, and refreshes the affected projections.

## Web UI

This section's visual treatment is superseded by the owner-approved private
component record `docs/design-mockups/components/missing-album-and-album-details/v001/notes.md`
and the public companion design
`2026-09-04-missing-album-and-album-details-components-design.md`. The watcher,
inventory, removal, and refresh contracts below remain authoritative.

Targeted work uses the existing Library Status busy state and does not open the
Scan Page.

The gallery card places a destructive red `!` capsule at the bottom-right of
the cover. Pointer hover or keyboard focus expands the capsule to
`Album deleted`. Reduced-motion preferences remove the transition. The badge
renders from `inventory_status`, so cached cover art cannot hide it.

Album Details places this warning before the track table:

`It seems this album was deleted or is not found under the current library roots.`

Authorized users see `Remove from Album Haven`. Other problem reviewers see
`Ask an owner or administrator to remove it.` Unsafe playback and filesystem
actions do not render for the tombstone.

Problematic Files shows the album-level reason `Album not found` and the same
authorized removal action. It also shows the watcher-health item described
above. Both surfaces reuse the existing warning, status-row, shared Button,
confirmation-dialog, toast, and badge patterns; this feature adds no UI
primitive.

After confirmation succeeds, the client closes Album Details and the
confirmation dialog, removes the card, updates counts, removes an empty artist
section, and refreshes Problematic Files without a page reload.

## Failure Handling

- A queue overflow or missed event makes the affected root unhealthy before
  the server can publish a stale transition.
- A disconnected or unreadable root preserves its inventory.
- A metadata parse or Postgres failure leaves the last committed inventory
  visible and records an operational problem.
- Duplicate events produce one idempotent mutation.
- A server shutdown stops event intake, drains or cancels owned work within a
  bounded deadline, and leaves no watcher thread running.
- A restart creates fresh watchers. Changes made during downtime require a
  manual full scan.

## Functional Cases And Automated Test Proposal

Unit tests cover event normalization, out-of-root rejection, debounce,
stable-write sampling, duplicate events, move pairing, clean shutdown,
overflow, and root-health gating.

Postgres integration tests use temporary roots and isolated library records.
They cover targeted insert, metadata update, one-track deletion, complete album
deletion, move/rename, revision advancement, metadata preservation, and
unavailable-root safety. They also prove that one event does not enumerate an
unrelated directory or invoke the full scanner.

After owner manual acceptance, functional Playwright coverage mutates generated
media through the filesystem while the production FastAPI server and watcher
run. The approved cases cover:

- a new album and a new track appearing without a manual scan;
- an external tag change reaching Postgres and the UI;
- one deleted track and one fully deleted album;
- the bottom-right warning, Album Details warning, Problematic Files state,
  owner/admin confirmation, and immediate gallery removal;
- move and rename behavior;
- a rapid multi-file copy that never publishes a partial album;
- duplicate event coalescing;
- an unavailable root preserving inventory; and
- a simulated event-source overflow producing the amber status and manual-scan
  prompt without starting a scan.

The E2E fixture owns a temporary library root and unique Postgres data. Test
actions mutate files rather than calling scanner services or test-only routes.
Playwright waits on the production inventory revision and visible UI state;
tests use no fixed sleeps. Specs stay thin, with filesystem actions, page
objects, and fixture lifecycle in their existing support layers.

Existing incremental-scan performance cases remain manual full-scan coverage
unless the owner approves a narrower edit during implementation.

## Performance Assessment

The first performance pass records these timestamps for each generated
filesystem change:

- event received;
- file stable for parsing;
- Postgres transaction committed;
- API exposed the new inventory revision; and
- the open gallery rendered the change.

The measurement produces event-to-commit and event-to-visible distributions for
new, changed, moved, and deleted albums. It records results without a pass/fail
threshold. After representative local runs, the owner will approve the target,
grace band, and hard ceiling. The current 40-second expectation is an
observation, not a contract.

## Manual Acceptance

1. Start Album Haven with a present test album and no scan running.
2. Copy in a generated album and verify it appears without a manual scan.
3. Change one tag and verify Album Details refreshes.
4. Delete one track and verify the remaining album updates.
5. Delete the album directory and verify the bottom-right `!` expands to
   `Album deleted` even if cached cover art remains.
6. Verify Album Details and Problematic Files show the approved warning.
7. Confirm removal as owner/admin and verify immediate gallery and count
   cleanup.
8. Disconnect a test root and verify Album Haven preserves its albums, shows
   amber watcher health, and offers the authorized manual scan.
9. Restore the root, run the manual full scan, and verify watcher health clears.

## Merge Boundary

The server, Postgres, and web slice can reach manual acceptance after focused
unit, integration, and frontend verification. Functional and performance E2E
work lands after manual acceptance under the approved Wave 2 workflow. Tauri
parity remains deferred until its repository exists.
