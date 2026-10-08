# MusicBrainz Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` for each
> delivery. Use `test-driven-development` for behavior changes, `migration` for
> PostgreSQL transitions, and `verification-before-completion` before each
> publication checkpoint.

**Goal:** Connect local artists and albums to MusicBrainz, expose useful metadata
and correction workflows in the application, classify local albums, and replace
folder-derived Artist Family membership with bounded MusicBrainz relationships.

**Architecture:** MusicBrainz remains a separate local mirror behind its JSON web
service. Album Haven stores bounded canonical projections under `integration`,
library-scoped matches and diagnostics under `library`, and durable jobs under
`ops`. Reads use Album Haven PostgreSQL projections; scans and background workers
perform provider calls outside database transactions.

**Tech Stack:** Python 3, FastAPI, PostgreSQL 18, psycopg 3, React, existing Album
Haven component tokens, pytest, JavaScript component tests, and Playwright.

## Delivery Policy

This plan has four delivery units. Each delivery produces a complete result that
the owner can open, exercise, and accept. Internal numbered tasks are implementation
steps within that delivery. They are not separate pull requests.

For each delivery:

1. Start one fresh branch/worktree from the currently published main.
2. Complete all internal tasks, focused tests, documentation, and required visual
   or manual gates on that branch.
3. Perform at least two adversarial whole-diff local review passes. Fix every
   validated finding and repeat the whole review after substantive fixes.
4. Commit coherent checkpoints as work progresses, but open one pull request for
   the complete delivery.
5. Run the complete review-first CI pipeline. Reproduce genuine failures with the
   narrowest focused local test, fix the full failure set, and rerun the complete
   pipeline.
6. Merge and publish only after required owner acceptance and green complete CI.
7. Synchronize local main and create the next delivery from that updated main.

Do not publish migrations, repositories, workers, APIs, or documentation as
standalone technical prework. They travel with the first user-visible outcome that
needs them. An incomplete or partially exposed journey cannot merge.

The recommended Codex setup is one orchestrator task plus one implementation task
per delivery. Create implementation tasks sequentially after the preceding delivery
is merged. Do not create all four worktrees in advance.

## Global Constraints

- MusicBrainz development endpoint: `http://localhost:5050/ws/2/`.
- `MUSICBRAINZ_BASE_URL` controls the endpoint; environment changes require no code
  changes.
- MusicBrainz JSON is transport only. Persist application-owned state as normalized
  PostgreSQL records, never JSON files or opaque inventory JSON.
- Cover Art Archive remains external and separately configured.
- Full scans, light/periodic scans, new-album detection, startup backfill, stale
  refresh, and authorized retry can schedule enrichment.
- Scans and page rendering never wait for provider calls.
- Retain artist identity, match decisions, and enrichment history after every local
  file for the artist disappears.
- A transient, missing, ambiguous, or catch-up response cannot overwrite a valid or
  manual match.
- A search-index result followed by direct entity `404` is `catch_up_pending`, not
  confirmed absence.
- Russian and other CIS artist/person names use source-backed native-language
  script. Transliteration remains a search alias. Never reverse-transliterate or
  translate another source language into Russian.
- Artist Family renders connected artist cards, including remote-only artists.
- Album galleries render local albums only. Never create remote-release placeholder
  cards.
- Web and narrow-screen web are required. Tauri, Android, TV, and Apple remain
  unsupported for these deliveries unless a later approved design changes the
  matrix.
- Run at most one pytest process at a time across the orchestrator and workers.
- Use focused local tests. Complete suites run through authoritative CI.
- Every visible surface requires an approved exact artifact and component-system
  mapping before implementation.

## Design Authority And Required Addenda

The approved
`docs/superpowers/specs/2026-09-23-musicbrainz-identity-and-problems-design.md`
governs normalized identities, matching, jobs, retry semantics, permissions, and
Problematic Files compatibility.

The new vertical split intentionally moves visible artist metadata into Delivery 1
and visible release metadata into Delivery 2. Before implementing either visible
surface, write and obtain approval for a short design addendum covering its exact
React placement, component/token mapping, payload shape, loading state, and
narrow-screen behavior. Delivery 3 and Delivery 4 require their own approved
technical design and exact visual artifacts before implementation. These are gates
inside the delivery, not separate publication units.

---

## Delivery 1: Artist Connections, Visible Enrichment, And Repair

### Outcome

Every retained local artist has a durable MusicBrainz artist match or an explicit
unresolved state. The gallery visibly proves successful enrichment through the
source-backed native artist name, country pill, and leading artist-genre pills.
Problematic Files explains failures and lets authorized users retry or select the
correct artist.

### Included scope

- Artist portion of MI-01.
- Artist portion of MI-02.
- Artist country and artist-genre portion of MI-03.
- Owner requirements 1, 2, and the artist portion of 4.
- Twelve acceptance artists: Neal Morse, Angra, The Flower Kings, Devin Townsend,
  ДДТ, Ария, Änglagård, Blind Guardian, Helloween, Nightwish, Stratovarius, and
  The Beatles.

### Prerequisites and gates

- Approved identity/problem design.
- Approved artist-header/gallery artifact showing native name, country pill,
  artist genre pills, pending state, and narrow-screen wrapping.
- Approved Problematic Files artifact for artist ambiguity, no match, metadata
  conflict, mirror catch-up, provider exhaustion, retry, and manual selection.
- Approved genre ranking rule for artist pills, including pill count, ties, and
  zero/negative vote handling.
- Approved capabilities: `library.problems.read`,
  `catalogue.enrichment.request`, and `library.metadata_matches.review`.

### Internal Task 1.1: Add the minimum normalized artist foundation

**Primary files:**

- `migrations/postgres/0080_create_musicbrainz_artist_enrichment.sql`
- `migrations/postgres/README.md`
- `music_app/services/musicbrainz_enrichment_postgres.py`
- `tests/py/test_musicbrainz_artist_migration_postgres.py`
- `tests/py/test_musicbrainz_enrichment_postgres.py`

Implement only tables needed for this outcome:

- `integration.musicbrainz_artists`
- `integration.musicbrainz_artist_aliases`
- normalized artist countries and canonical genres with vote/provenance fields
- `library.local_artist_musicbrainz_matches`
- `library.local_artist_musicbrainz_candidates`
- artist-target rows in `ops.metadata_enrichment_jobs`
- artist-target rows in `library.metadata_enrichment_problems`

Add library-safe foreign keys, one-current-match constraints, one-active-job and
one-active-problem partial indexes, due-job indexes, minimal grants, manual-decision
protection, and retained-artist scheduling. Existing MBID assertion tables remain
evidence history rather than a competing current-state authority.

### Internal Task 1.2: Add configurable artist retrieval and matching

**Primary files:**

- `config.py`
- `.env.example`
- `README.md`
- `music_app/services/musicbrainz_http.py`
- `music_app/services/musicbrainz_client.py`
- `music_app/services/musicbrainz_matching.py`
- `music_app/services/local_mbid_assertions.py`
- `tests/py/test_musicbrainz_http.py`
- `tests/py/test_musicbrainz_client.py`
- `tests/py/test_musicbrainz_matching.py`
- `tests/fixtures/musicbrainz/artist-search-cases.json`

Retrieve artists and aliases through the configured API. Preserve HTTP status so a
404 is not cached as a generic miss. Paginate bounded searches. Use embedded artist
MBIDs and trusted existing assertions before search.

Automatic artist matching requires one approved evidence path:

- a valid embedded artist MBID plus canonical-name/alias agreement and no
  contradictory release-credit evidence;
- a high-confidence existing assertion plus name/alias agreement and consistent
  local release-credit evidence; or
- one search candidate with exact normalized canonical-name/alias agreement,
  consistent local release-credit evidence, and no equally strong competitor.

Name equality and first-result order never authorize a match. Fuzzy text orders
review candidates only. Select a native-script display name only from canonical or
alias evidence with a matching language/locale; preserve original album credits.

### Internal Task 1.3: Add durable artist processing and scan triggers

**Primary files:**

- `music_app/services/musicbrainz_enrichment.py`
- `music_app/services/musicbrainz_enrichment_worker.py`
- `music_app/services/scan_state.py`
- `music_app/services/state.py`
- `music_app/__init__.py`
- `tests/py/test_musicbrainz_enrichment.py`
- `tests/py/test_musicbrainz_enrichment_worker.py`
- `tests/py/test_scan_state.py`
- `tests/py/test_state.py`

Claim due jobs with `FOR UPDATE SKIP LOCKED`, commit the lease, and then call the
provider. Use bounded retry schedules for rate limits, outages, invalid responses,
and mirror catch-up. Recover work after lease expiry and restart. Start and stop one
runtime-owned worker through FastAPI lifespan.

Schedule eligible artists after successful full scans, light scans, new-album
publication, startup backfill, stale refresh, and authorized retry. Scheduling is
idempotent and non-blocking. Failed or superseded scans do not schedule work.

### Internal Task 1.4: Project artist metadata into the gallery

**Primary files:**

- PostgreSQL gallery projection in `music_app/services/library_browse_postgres.py`
- relevant React gallery/header modules identified by the approved artifact
- relevant component tests
- `tests/py/test_library_browse_postgres.py`

Read stored artist projections only. Display the native name when evidenced, a
country pill when country exists, and the approved number of leading canonical
artist genres. Pending and failed enrichment cannot masquerade as confirmed
absence. Reuse approved pill components and tokens; do not add page-local visual
primitives.

### Internal Task 1.5: Add artist problems, retry, and correction

**Primary files:**

- `music_app/services/library_browse_postgres.py`
- `music_app/routes/musicbrainz_enrichment_asgi.py`
- `music_app/services/private_route_boundary.py`
- `music_app/services/admin_account_creation.py`
- `music_app/routes/admin_asgi.py`
- approved React Problematic Files modules
- `tests/py/test_musicbrainz_enrichment_asgi.py`
- `tests/py/test_api_read_asgi_routes.py`
- relevant React/component tests

Project active artist diagnostics into the existing Problematic Files surface with
stable reason codes and safe text. Preserve `problem_reasons: list[str]` during the
transition and add structured metadata-problem fields. Do not expose paths or raw
provider payloads.

Retry requires `catalogue.enrichment.request`. Candidate selection/correction
requires `library.metadata_matches.review`. Resolve the current library server-side;
never accept `library_id` or actor identity from the request. Validate a manual MBID
through MusicBrainz outside the write transaction, store the canonical projection
and manual decision atomically, and prevent later automatic replacement.

### Internal Task 1.6: Verify and document the complete artist journey

**Primary files:**

- focused Python, component, and Playwright tests
- private functional cases for scan/enrichment and Problematic Files
- private `docs/architecture.md`
- private `docs/permissions-and-capabilities.md`
- private MusicBrainz owning plan and roadmap

Automated acceptance covers all trigger types, restart recovery, removal and
reappearance, duplicate roots, homonyms, Nightwish collision, `Anglagard` alias,
`Кипелов` native display, missing native evidence, library isolation, manual
override, catch-up 404, provider outage, and narrow-screen pills/problems.

### Owner manual acceptance

1. Scan a library containing several acceptance artists.
2. Confirm native name, country, and artist genre pills.
3. Open an ambiguous/no-match artist in Problematic Files and inspect the reason.
4. Retry it and select a supplied candidate with an authorized account.
5. Confirm a listener cannot perform those mutations.
6. Remove all local files for one artist, scan, restore the files, and confirm the
   same MusicBrainz identity and enrichment return.
7. Exercise a deterministic catch-up `404` and confirm it is shown as mirror
   catch-up rather than bad local metadata.

### Compatibility and rollback

Disable artist enrichment scheduling and the worker; fall back to existing local
artist names and gallery behavior. Retain accepted matches, manual decisions,
canonical rows, and diagnostic history. Do not delete identities or modify the
MusicBrainz mirror.

### Publication checkpoint

One PR contains Tasks 1.1–1.6. Merge only after the exact visuals, manual script,
focused tests, approved E2E, two local review passes, and complete CI pass.

---

## Delivery 2: Local Release Connections And Album-Card Enrichment

### Outcome

Every local album maps to a MusicBrainz release group or has an explicit unresolved
state. Local gallery cards show one canonical genre and stored MusicBrainz release
types. Problematic Files explains unresolved releases and confirmed genre absence.
The resulting type inventory is presented to the owner for Delivery 3 decisions.

### Included scope

- Release-group portion of MI-01.
- Release portion of MI-02.
- Release genre/fallback portion of MI-03.
- Raw type retrieval and calibration portion of MI-04.
- Owner requirements 3, 5, 6, and 7.

### Prerequisites and gates

- Published Delivery 1.
- Approved album-card genre/type artifact and narrow-screen behavior.
- Approved release genre precedence and deterministic tie rules.
- The Album Haven type taxonomy remains unapproved; this delivery displays stored
  provider facts in the approved review presentation and does not silently map
  `Album` to `Studio`.

### Internal Task 2.1: Extend normalized storage for release groups

Add release-group projections, ordered credits, normalized primary/secondary
types, release/release-group canonical genres with votes and provenance, local
album matches/candidates, album jobs, and album diagnostics. Extend the existing
Delivery 1 migration sequence with a new additive migration. Preserve library
scope and manual-decision protection.

### Internal Task 2.2: Retrieve and match releases and release groups

Add paginated release-group search, direct release lookup, direct release-group
lookup, and release-to-release-group resolution. Process album jobs only after
credited local artist matches resolve or reach explicit review. Do not consume an
attempt while waiting on artist prerequisites.

Automatic release-group matching requires one approved evidence path:

- embedded release-group MBID plus title and resolved artist-credit agreement;
- embedded release MBID resolving to a release group with title and credit
  agreement; or
- one search candidate with exact normalized title, resolved artist-credit
  agreement, compatible meaningful year, and no equally strong competitor.

Track count may rank compatible candidates when release evidence supplies it but
cannot override contradictory identity evidence.

### Internal Task 2.3: Schedule and process local albums

Extend scan/startup/retry scheduling to every eligible local album. Persist the
release-group match, canonical release-group projection, genres, primary type, and
all secondary types. Keep remote release groups out of local album inventory and
gallery membership.

### Internal Task 2.4: Enrich local gallery cards

For each local album card, show exactly one canonical genre from the first usable
source:

1. release-group genre;
2. selected release genre when available;
3. matched artist genre.

Display the approved raw-type review treatment without imposing the later Album
Haven taxonomy. Preserve overlaps such as Live + Demo and Live + Compilation.
Cards without enrichment remain usable.

### Internal Task 2.5: Add release and genre diagnostics

Add stable reasons for release group not found, ambiguous release group, metadata
conflict, mirror catch-up, exhausted provider retry, manual review, unavailable
matched entity, and confirmed canonical genre absence. The genre-missing reason
becomes active only after release group, selected release, and artist genre
hydration all succeed and all three lack an eligible canonical genre.

Reuse Delivery 1 retry/correction capabilities and UI. An artist correction
requeues dependent local album matches.

### Internal Task 2.6: Produce the type review and verify the complete release journey

Run the local-album dataset for the twelve acceptance artists. Present observed
primary types, secondary types, overlaps, nulls, and examples to the owner. Keep
provider catalog counts separate from local album counts.

Automated acceptance covers edition ambiguity, same-title release groups,
compilations, meaningful/missing years, pagination, catch-up 404, genre precedence,
confirmed missing genre, recovery, local-only gallery membership, and dependent
requeue after artist correction.

### Owner manual acceptance

1. Scan local albums for the acceptance artists.
2. Verify release-group identities for representative studio, EP, single, live,
   demo, compilation, soundtrack, broadcast, other, and null-type cases.
3. Verify one genre pill and its release-group → release → artist fallback.
4. Resolve an ambiguous local album from Problematic Files.
5. Confirm missing genre appears only after successful complete hydration.
6. Confirm no remote-only MusicBrainz release creates a gallery card.
7. Review and approve or revise the type inventory used to design Delivery 3.

### Compatibility and rollback

Disable album enrichment scheduling and the card overlays. Keep existing local
album cards, browsing, playback, artist matches, accepted release matches, and
diagnostic history. Do not erase stored provider facts.

### Publication checkpoint

One PR contains Tasks 2.1–2.6. Merge only after manual acceptance, approved E2E,
two local review passes, and complete CI pass.

---

## Delivery 3: Album-Type Taxonomy And Customize

### Outcome

The Album Type dropdown uses an owner-approved taxonomy derived from real local
MusicBrainz results. Customize provides the approved user workflow and persists its
configuration.

### Included scope

- Remaining MI-04.
- Owner requirement 8.
- Album Haven display categories including Studio, EP, Single, Live, Demo,
  Compilation, Soundtrack, and approved handling for every observed provider type
  and overlap.

### Prerequisites and gates

- Published Delivery 2 and approved type inventory.
- Owner decision on what Customize means: type visibility/order customization or
  per-artist custom subsection editing. Do not infer this choice from historical
  drafts.
- Approved mapping rules for primary/secondary overlaps and nulls.
- Approved exact dropdown, Customize flow, persistence, reset, empty state,
  narrow-screen artifact, and component-system mapping.
- Approved capability and scope for shared versus per-account customization.

### Internal implementation tasks

1. Write the approved taxonomy and overlap algorithm as a pure tested domain
   mapping over preserved MusicBrainz facts.
2. Add only the persistence required by the approved Customize ownership model.
3. Update gallery grouping/filter payloads and the React Album Type dropdown.
4. Implement Customize, validation, reset, optimistic/error behavior, and
   accessibility using approved shared components.
5. Add Problematic Files diagnostics only if the approved taxonomy produces an
   actionable unmapped state; never treat an intentional `Other` classification as
   corrupt metadata.
6. Add focused Python/component tests, owner manual script, accepted functional
   E2E, documentation, and rollback proof.

### Owner manual acceptance

Exercise every approved type and overlap from Delivery 2, customize the approved
settings, reload, verify persistence and reset, and confirm gallery membership and
local-album-only behavior remain correct.

### Compatibility and rollback

Disable the new taxonomy/customization read path and restore the prior Album Type
behavior. Retain raw MusicBrainz types and saved customization for later recovery.

### Publication checkpoint

One PR contains the complete approved taxonomy and Customize journey. It cannot
start implementation until the prerequisite owner decisions and exact artifact are
approved.

---

## Delivery 4: First-Level MusicBrainz Artist Family

### Outcome

Artist Family uses MusicBrainz relationships instead of folder-derived membership.
It shows every qualifying connected artist as a card while album galleries continue
to show local albums only.

### Included scope

- MI-05.
- Owner requirements 9–12.
- First relationship level only; no weights, recursive expansion, popularity, or
  Extended Family scoring.

### Prerequisites and gates

- Published Deliveries 1–3.
- Approved relationship eligibility design, stale/current presentation, incomplete
  evidence presentation, exact card artifact, and component-system mapping.
- Owner decision on whether a qualifying member's other bands include all
  historical memberships or only original/current memberships.
- Approved family read capability and any correction/rebuild capability.

### Internal Task 4.1: Persist bounded relationships and evidence

Add normalized MusicBrainz relationship projections with source/target MBIDs,
relationship type, begin/end dates, ended flag, attributes, source IDs, fetched
time, and evidence completeness. Replace use of the old weighted folder-family
projection for this read path without deleting it during rollout.

### Internal Task 4.2: Derive the approved first-level family

For a person seed, include solo identity plus bands/projects where evidence says
founding/original or current member, including evidenced eponymous acts.

For a band seed, identify original and current members and, for dissolved bands,
the evidenced final lineup. Include the qualifying members' solo identities and
other bands/projects according to the approved historical-membership rule.

Exclude guest-only, session-only, and credit-only relationships. An ended
relationship alone proves neither original membership nor final-lineup membership.
Missing dates/attributes produce incomplete evidence instead of invented
membership. Stop after this path and deduplicate by canonical MBID.

### Internal Task 4.3: Serve and render Artist Family

Build the family payload from stored projections with no render-time provider
calls. Render cards for every connected artist, including artists absent from the
local library. Use native-language names from Delivery 1. When a family artist is
selected, the album gallery contains only locally available albums and never a
remote placeholder.

### Internal Task 4.4: Verify relationship edge cases

Automated and manual acceptance covers:

- The Beatles includes Ringo Starr through final-lineup evidence.
- Ария/Кипелов uses `Кипелов` and exposes incomplete original/start evidence rather
  than inventing it.
- Helloween/Michael Kiske and Stratovarius/Timo Tolkki incomplete-evidence cases.
- Nightwish same-name entity separation.
- `Anglagard` alias resolution to `Änglagård`.
- person → band/project, band → member → solo/project, eponymous acts, duplicates,
  remote-only related artists, local-album-only gallery, provider outage, stale
  relationships, no deeper traversal, and no weights.

### Owner manual acceptance

Exercise all twelve seed artists and inspect relationship explanations, remote-only
artist cards, native names, dissolved-band final lineup, incomplete evidence, and
local-only album rendering.

### Compatibility and rollback

Use a reversible read cutover. Disable the MusicBrainz family projection and
restore the prior family read behavior without deleting relationship facts or
altering local inventory.

### Publication checkpoint

One PR contains relationship storage, derivation, API, React cards, tests, docs,
and rollback. Merge only after exact visual approval, manual acceptance, approved
E2E, two local review passes, and complete CI pass.

---

## Orchestrator Completion Contract

For each delivery, the implementation task returns:

- branch and worktree identity;
- commits and PR URL;
- focused test commands and results;
- two whole-diff local review records and resolved findings;
- owner visual/manual acceptance evidence;
- hosted reviewer and complete CI results;
- merge commit and published release/deployment evidence;
- rollback verification;
- updated public/private documentation and checklist IDs;
- known usage/cost evidence, leaving unknown values explicitly unknown.

The orchestrator verifies this evidence, synchronizes main, and only then creates
the next delivery task. A failed dependency, pending approval, red CI run, or
unmerged PR stops dependent delivery creation. Independent investigation may
continue, but implementation never starts from an unpublished dependency.

## Final Stop Condition

The scoped MusicBrainz integration is complete only when all four deliveries are
published and manually accepted, all twelve acceptance artists pass their relevant
cases, gallery cards remain local-album-only, Artist Family includes remote related
artists without weights or recursive expansion, and the owning plans contain the
final review, CI, merge, publication, and rollback evidence.
