# Multi-root libraries: early delivery

## Status and decisions

- [x] Create isolated worktree and branch from the requested source branch.
- [x] Read existing multi-root implementation and owning roadmap/companion plan.
- [x] Owner approves permission, deployment and client scope (September 23, 2026, reply `approve`).
- [x] Owner confirms the current-stack exception for this early delivery.
- [x] Owner approves this technical design and v003 layout with final icon refinements.
- [ ] Owner approves automated functional scenarios and performance assessment.
- [x] Add failing focused tests and implement the approved behavior.
- [x] Focused verification of the initial build.
- [ ] Owner manual acceptance.
- [ ] Add approved functional E2E coverage after manual acceptance.
- [ ] Complete required review and CI before release; configure and scan real sources on an accepted build.

The owner approved initial implementation on September 23, 2026, without another
mock rebuild. The final mailbox/vinyl/sparkles and locked-chest references will be
redrawn as theme-aware SVGs, preserving their recognizable designs without the
screenshots' black backgrounds. At least one source indicator must remain enabled,
enforced in Appearance and on the server. Manual acceptance and release remain open.
No production root setting, music file, or database has changed; no real scan has run.

Application worktree: `C:\Users\Rendref\.codex\worktrees\multi-root-libraries\album-haven-app`.
Branch: `2026-09-23-multi-root-libraries`; base: `0900c81ac8d3799dbba350113fc433a84d03d774`
on `2026-09-09-cover-look-up-refactor`. The managed worktree contains committed
source-branch work, not uncommitted files from the original checkout.

Owner documents: private `docs/future-feature-plans/library-roots-and-arrivals-plan.md`,
`docs/post-migration-roadmap.md`, `docs/permissions-and-capabilities.md`, and
`docs/ui-component-system.md`. Those files already have unrelated working changes;
preserve them. This task-local record does not replace the private registries.
Reconcile approved changes into their owners without overwriting concurrent work.

## Requested outcome

Preserve existing Main roots and read/play albums from multiple Hoard and New
Arrivals roots. The machine-specific root list supplied in the task is applied
through authorized Settings on the accepted local build; do not hardcode it in
source, public docs, fixtures, or defaults. Settings save remains Postgres-backed.

The gallery distinguishes Hoard and New Arrivals with icons, labels, outlines,
and category-tinted card surfaces. Album Details and Problematic Files expose
every qualifying duplicate source. A full scan inventories the added roots and
queues missing-cover discovery/fetching. No manual or automatic move feature is
implemented in this delivery. Existing move behavior outside this slice is not
silently removed or newly enabled by source configuration.

## Authority approved by owner

Root reads/management reuse `library.settings.read` / `library.settings.manage`
for the current media-host library and owner/admin workflows. Scan controls use
the existing `library.refresh` action (`POST /refresh-api`), with
`library.refresh.cancel` for cancellation. Existing root validation and bounded folder browsing
remain authoritative; folder browsing additionally requires its existing
filesystem and path-read grants.

Browse/play reuse `library.browse.read` and `library.stream_private`; source
category does not confer or restrict membership. Problems reuse
`library.problems.read`. Covers retain existing media/fetch authority. The
bootstrap owner inherits existing capabilities; this slice grants no new role
preset or capability. Server-side checks apply to routes, media, and queued
work; absent authority yields existing denial behavior without path disclosure.

Self-hosted/private node is required; public hosted cloud is unsupported here.
Web is required; Tauri optional; native Android, TV, and Apple unsupported.

## Existing implementation and architectural choice

Use the existing root service, scoped Postgres storage, indexer, cover queue,
gallery payloads and PCM player. Root enumeration and media containment already
support multiple categories. Settings already supports repeated roots and
rejects duplicate/overlapping paths. The shared GalleryCard currently does not
render provenance. Existing duplicate detection compares track collections and
durations and is too restrictive for this request.

Alternatives considered:

1. Extend existing shared service/component owners (recommended for this early
   delivery). Smallest coherent scope; requires the explicit current-stack
   exception because the selected branch has not completed React migration.
2. Deliver backend configuration only. Provides extra music, but does not satisfy
   the requested gallery treatments and duplicate presentation.
3. Complete the React prerequisite first. Follows the future Wave 2 stack but
   introduces substantial migration scope before this requested capability.

No new persistence framework, scanner, audio architecture, or gallery is needed.
Keep new business rules in a shared domain/service owner used by both in-memory
album construction and Postgres projections. Do not implement separate duplicate
rules in Album Details, Problematic Files, or browser JavaScript.

## Root configuration, scan, and covers

Batch source changes into one Settings save. Preserve every current Main root,
unrelated setting, and move-policy value. Validate newly configured directories
and reject nested or duplicate physical roots across categories. Resolve mapped
drive availability in the actual application process; if the host cannot access
a supplied drive, report that exact source as unavailable. Do not invent a UNC
replacement or mount mapping.

Scan every configured, available root and preserve per-file root identity and
category. An offline root is an operational condition, not proof of deletion;
retain its inventory according to existing missing-album contracts. Avoid
duplicate index jobs/cover work from repeated saves. Retain cancellation, errors,
progress, and restart/recovery behavior through existing job owners.

After indexing, discover local art and fetch missing covers through existing
provider orchestration. Preserve valid existing covers and manual selections.
Remote providers may have no match: completion reports indexed albums, covers
found/fetched, unavailable roots, and unresolved cover failures; it cannot promise
that every album has provider artwork. No forced replacement of existing art.
Cover writes are restricted to validated album folders and existing authority.

Root-scoped scan APIs, if required to close AH-W02-002 in full, need their full
acceptance contract. A successful all-root scan alone must not close that item.

## Duplicate rule and source representation

A duplicate group contains two or more distinct physical album containers within
the current authorized library, with the same album artist, album title, and
valid release year. It may span roots/categories or exist twice within one root.
Normalize Unicode consistently, case, and surrounding/repeated whitespace; reuse
existing authoritative artist identity when available. Do not introduce fuzzy
title matching, substring matching, or broad punctuation removal as identity.

File size, codec, bitrate, duration, track count, and bonus tracks do not suppress
the problem. Edition labels do not exempt a matching artist/title/year under the
owner's requested rule. Preserve existing distinct-version presentation and
explicit release identities; linking duplicate candidates does not merge or
delete their records. Different valid years or artists do not match. Missing or
conflicting year/artist/title metadata remains a metadata problem and cannot
establish a precise duplicate match by treating unknown values as equal.

Collapse recognized disc subfolders into their album container so a multidisc
album is not its own duplicate. Canonical physical path/root checks prevent one
directory being counted twice through aliases. Use a grouped identity lookup,
not pairwise album comparisons.

Every affected album exposes `Duplicate files` in Album Details and Problematic
Files, with all source locations represented. Where the existing gallery has one
logical album, retain that card and list all copies in its source tabs. Where
explicit versions are separate, flag each affected version and cross-reference
the source group. Source counts and duplicate status consider all authorized
configured sources, even when a gallery category is hidden. Path details retain
the existing separate path-read restriction.

Keep each source's track collection and playback binding separate. Selecting a
copy plays that copy; it must never concatenate multiple copies into an album
queue. Use the existing PCM playback pipeline and root containment checks.
After rescan, metadata correction, source removal, or reappearance, invalidate
and rebuild affected duplicate projections so all surfaces agree.

## Visual design and shared components

Exact current review artifact: `docs/design-mockups/components/library-provenance/v003/index.html`.
Review metadata and detailed prompt live alongside it. Current/similar screenshot
reference is recorded in its notes; the live HTTPS app was unavailable at intake.

Owner selected subtle treatment and requested the v002/v003 corrections. Propose a
shared GalleryCard provenance extension in Cards and Covers views. Hoard uses
an old chest with padlock and warm amber; New Arrivals uses a mailbox with vinyl
and sparkles, based on the owner image, and cool teal. Appearance > Albums gets
three independent own-account preferences: `Color cards by library source`,
`Color hover outlines by library source`, and `Show library source icons`.
Approved defaults are off/off/on. Reject disabling all three indicators, including
through direct API requests; preserve valid legacy defaults. Reuse existing Appearance persistence and staged
Save/Cancel; no new media or administrative authority. Card colors govern subtle
tint and card border; outline colors independently govern the artbox hover frame.
With either coloring disabled, that part retains its normal theme styling.
Main uses regular white/dark-theme or black/light-theme. Mixed-source borders and
frames include every present category, including a third neutral Main segment.
Hiding source icons does not hide duplicate or missing-inventory warnings.
Existing cover art, card geometry and hover glow remain intact.

Source badges appear on card hover or keyboard focus; only hovering/focusing
the individual icon expands its label. Artwork hover never expands labels.
Each accessible named action opens Album Details source information. Touch
keeps a usable explicit control. Mixed-source albums show both category markers and
list every authorized location; no source silently wins by ordering. In this
initial build, the owner approved showing alternate copy details and enabling
copy selection only for actors with existing `library.paths.read` authority.
Other library readers still receive duplicate warnings and default playback;
their response must omit alternate folder and track paths. Use a
neutral mixed-card surface with both category accents. Missing-album and problem
alerts remain separate semantic states. Latest owner correction removes all
below-card duplicate messages: an artbox warning action expands to `Duplicate
files` only on its own hover/focus, and opens duplicate source details. The
existing `Album not found` artbox warning is triggered by missing inventory,
not by duplicates or unavailable artwork. Color is never the only cue.

Component mapping: GalleryCard, AlbumArtbox, ActionButton, existing Album Details
header/source tabs, problem labels, shared Settings inputs/dropdowns and footer.
The category semantic tokens are a reusable catalog extension requiring approval
of this artifact. Preserve reduced motion, contrast in dark/light themes, focus
outlines, narrow layouts, and virtualized card reuse/render-key invalidation.

## Verification proposal for owner approval

Focused unit/integration coverage before implementation: multi-root Settings
persistence/validation, enumeration/provenance, authorized second-root playback,
outside-root denial, cover jobs targeting added roots, duplicate identity matrix,
multidisc handling, offline-root retention, and consistent projections. Use
isolated Postgres plus generated media and mocked external provider responses.
Production data is not test setup.

After owner manual acceptance, add seven production-path functional scenarios:

1. Settings saves several categorized roots, persists after reload, rejects
   overlap, and Cancel leaves settings unchanged (FTC-LIBROOTS-001/002).
2. Authorized scan indexes added roots and fetches missing art; unavailable root
   and provider no-match remain visible, without replacing selected covers
   (FTC-LIBROOTS-002 and cover/scan cases; exact additive IDs assigned in backlog).
3. Play generated audio from each added category and chosen duplicate source;
   verify source binding and real playback progression (FTC-LIBROOTS-002A extension).
4. Cards/Covers show correct single/mixed provenance; category filtering and
   search retain source scope; keyboard/touch source action opens details
   (FTC-LIBROOTS-003/003A extension).
5. Same artist/title/year in different folders, encodes and track counts exposes
   all copies in Details and Problematic Files; no duplicate track concatenation
   (FTC-DUPES-001 extension).
6. Different artist/year, missing identity and multidisc negative cases avoid
   false duplicates; refresh removes stale duplicate membership (FTC-DUPES-001 extension).
7. Existing member/denied actor matrix preserves browse/play grants and denies
   root edits, scans, path reads and unauthorized media as applicable.

Proposed data mode: isolated generated library, isolated Postgres and mock external
cover providers; real ASGI routes, storage, player and shared UI. Owner manual
acceptance then validates supplied real roots. Existing E2E expectations remain
protected; any replacement of a conflicting old duplicate contract is presented
with exact evidence before editing it.

Performance assessment: identity grouping must be linear/grouped, never N-squared;
provenance rendering must add no per-card network or filesystem requests. More
roots can materially increase scan/projection and Problematic Files costs.
Reuse established synthetic large-library gallery, playback and Problematic Files
budgets. Add one focused mixed-root performance scenario if existing fixtures do
not cover the new grouped query; retain the documented timing targets/grace bands.
Do not run a full local release inventory. Required complete suites run in CI.

## Delivery and documentation checkpoints

This early request covers the configured-root browse/play outcome, cover scan,
semantic duplicate reporting, and provenance visuals. AH-W02-005 moves remains
open and deferred. AH-W02-004 dedicated New Arrivals review is not closed merely
by adding category badges or a source filter. AH-W02-001/002/003 close only if
their complete atomic contracts are met; otherwise add precise partial progress.

First checkpoint: approved design, exact mocks and verification proposal.
Implementation units: (1) root/scan/playback contracts and any needed fixes,
(2) precise duplicate-source domain/projection/reporting, (3) approved provenance
UI. Each unit carries its own tests/docs and focused verification; no unrelated
Wave scope is added. Before merge/publication, establish the source branch's
integration status and an explicit safe split/base plan. Do not publish the
already-accumulated source branch as part of this task by implication.

Compatibility: additive provenance/group fields; existing root IDs, media refs,
ratings, history, selected art, and player ownership remain stable. Rollback must
not move/delete media or discard configured roots. Any schema migration must be
additive and backward-compatible; avoid one unless existing projections cannot
represent the approved rule. Reverting the UI must leave readable inventory.

Operational checkpoint: after an accepted build is available, configure supplied
roots once, verify effective saved roots/move settings, run the requested full
scan and missing-cover pass, and report actual completion/unresolved sources.
Document exact evidence before checking completion boxes.
