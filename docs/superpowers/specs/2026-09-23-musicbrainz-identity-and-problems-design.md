# MusicBrainz Identity And Problems Design

## Outcome

Album Haven automatically connects every artist and album found in the local
library to MusicBrainz or records an explicit, explainable unresolved state.
Artist matches point to MusicBrainz artists. Album matches point to MusicBrainz
release groups. Removing all local files does not erase the known artist identity,
match decision, or enrichment history, so a later reappearance reuses the prior
connection.

This design covers MI-01 and the MI-02 diagnostic foundation. It includes the
database model, MusicBrainz client semantics, matching workflow, durable jobs,
scan triggers, permissions, and the existing Problematic Files projection. It
does not add country or genre pills, release-type filtering, Customize, or the
MusicBrainz relationship-based Artist Family. Those later deliveries consume the
identities established here.

## Approved Deployment And Client Contract

The owner approved this contract on September 23, 2026:

- Deployment is all-local and self-hosted for this delivery.
- Web is required, including narrow-screen web.
- Tauri, Android, TV, and Apple are unsupported for this delivery.
- Automatic enrichment runs in the Album Haven node's background service. Here,
  `node` means the local Album Haven installation, not the Node.js runtime.
- `library.problems.read` permits reading safe diagnostics.
- `catalogue.enrichment.request` permits owner/admin users to request retries.
- `library.metadata_matches.review` permits owner/admin users to choose, correct,
  or clear a match.

Automatic scan-triggered work is a service action. It does not borrow authority
from the user who happened to start or browse during a scan.

## Source Boundary And JSON

The local MusicBrainz mirror remains a separate database behind the MusicBrainz
web service. Development uses:

```text
http://localhost:5000/ws/2/
```

`MUSICBRAINZ_BASE_URL` remains environment-configurable and normalized with a
trailing slash. Switching to another deployment requires configuration only.
Cover Art Archive uses its separate external endpoint and is outside this
delivery.

MusicBrainz JSON is a transport representation only. Album Haven requests JSON
from the locally running API, validates it, and stores the selected identities,
bounded canonical metadata, match evidence, and operational state as normalized
PostgreSQL records. It does not persist application-owned state in JSON files or
opaque inventory JSON fields. The MBID is the stable application-level link
between Album Haven and the separate MusicBrainz mirror; it is not a cross-database
foreign key.

Raw MusicBrainz responses are not retained as a second mirror. Small audit facts
such as endpoint class, response status, observed time, and response hash may be
stored in explicit fields. Tests may use bounded, sanitized JSON fixtures to
exercise the provider contract.

## Chosen Architecture

Use three ownership areas:

1. `integration` owns bounded MusicBrainz canonical projections and aliases keyed
   by MBID.
2. `library` owns local-to-MusicBrainz match decisions, candidates, evidence, and
   active metadata diagnostics scoped to one library.
3. `ops` owns durable, deduplicated enrichment jobs, leases, attempts, and retry
   schedules.

This is preferred over extending only the existing MBID columns because a single
column cannot represent candidates, release-group matches, manual decisions,
retries, or problem lifecycles. A generic multi-provider identity graph is also
rejected for this delivery because it would add abstractions without a current
consumer. Album Haven does not query the raw MusicBrainz schema directly because
that would couple application behavior to mirror internals and availability.

## Domain Model

### Canonical MusicBrainz projections

`integration.musicbrainz_artists` is keyed by artist MBID and stores only the
canonical fields needed for matching and later display: canonical name, sort name,
disambiguation, artist kind, life-span facts, preferred native-script name when
MusicBrainz supplies evidence, and refresh timestamps.

`integration.musicbrainz_artist_aliases` stores one normalized alias per artist,
including locale, alias kind, sort name, and primary-for-locale evidence. Aliases
support matching and lookup without replacing the canonical identity.

`integration.musicbrainz_release_groups` is keyed by release-group MBID and stores
the title, first-release date, primary type, disambiguation, and refresh timestamps.
`integration.musicbrainz_release_group_secondary_types` stores each secondary type
as a separate provider fact. MI-04 later defines the Album Haven display taxonomy.

`integration.musicbrainz_release_group_credits` stores the ordered artist credits
for each release group. It preserves the credited text and artist MBID rather than
flattening credits into one string.

MI-03 may add country and genre projections beside these records. It must not
change the match identity or move those facts into library inventory JSON.

### Library-scoped matches

`library.local_artist_musicbrainz_matches` has one current row per local artist.
It records the target artist MBID when resolved, state, decision source,
confidence, evidence summary, selected time, reviewer when applicable, and the
last verification time. The allowed states are:

- `pending`
- `matched`
- `ambiguous`
- `not_found`
- `conflict`
- `manual_review`

`library.local_album_musicbrainz_matches` follows the same contract for a local
album and a MusicBrainz release-group MBID. The name says `album` because the
source entity is Album Haven's local album; the target identifier is always a
release group in this delivery.

Separate artist and album candidate tables hold candidate MBIDs, normalized
scores, contributing evidence, rejection reasons, and observation times. Candidate
rows are replaced atomically after a completed match attempt. They are not the
authority for the selected match.

Manual selection is an explicit decision source. Automatic enrichment may refresh
its canonical MusicBrainz projection and verification time, but it cannot replace
or clear a manual decision. A later missing or transient provider response cannot
overwrite any valid current match.

### Existing MBID assertions

The current generic `library.local_mbid_assertions`, artist-specific assertion
history, and local entity projection columns remain readable during migration.
Existing valid artist assertions seed candidate evidence and may seed a resolved
match when their provenance satisfies the approved matcher. New match state has
one authority: the match tables above. The old assertion stores remain evidence
history rather than competing current-state authorities.

No track matching is added by MI-01. Existing track assertions remain untouched.

### Durable enrichment jobs

`ops.metadata_enrichment_jobs` stores an artist-match or release-group-match job.
Each row has a library, exactly one local target, reason, state, priority, attempt
count, next-attempt time, lease owner and expiry, last provider classification,
safe last-error text, and create/update timestamps.

Only one active job may exist for a target and job kind. Inserts use an idempotent
upsert that advances priority or retry time without creating parallel work. Job
states are `queued`, `leased`, `retry_wait`, `succeeded`, `needs_review`, and
`exhausted`.

Workers claim due jobs with `FOR UPDATE SKIP LOCKED`, commit the lease, then make
provider calls outside the database transaction. A process restart makes leased
work eligible again after lease expiry. The first deployment runs one worker, but
the claim contract remains safe for later bounded concurrency.

## Identity Retention And Library Isolation

Scan publication marks local presence separately from identity. When the last file
for an artist disappears, Album Haven retains the local artist row, match, manual
decision, canonical MusicBrainz projection, and resolved diagnostic history. A
later scan that finds the artist again reuses that identity and schedules a refresh
only when the canonical projection is stale or the local evidence changed.

Retained identity does not imply local availability. Gallery queries continue to
return only local albums. Every library-scoped match, candidate, job, and diagnostic
includes and enforces `library_id`; canonical MusicBrainz projections may be shared
by MBID but cannot expose another library's inventory or paths.

## Trigger And Processing Flow

The same idempotent scheduler receives work from:

- full scans;
- light or periodic scans;
- detection of a newly added album;
- startup/backfill of existing unresolved records;
- stale canonical projection refresh;
- retry requested through an authorized API.

A scan never waits for MusicBrainz. After successful PostgreSQL scan publication,
the scheduler upserts artist jobs for unmatched or recheck-eligible local artists
and album jobs for local albums. Artist work is eligible first. An album job waits
without consuming an attempt until its credited local artist identities have
reached a resolved or explicit review state.

For each claimed job, the worker:

1. Loads the local entity and existing decision.
2. Evaluates trusted embedded identifiers and existing assertion evidence.
3. Fetches an identified entity or performs bounded, paginated MusicBrainz search.
4. Validates candidates using aliases, credited artists, release title, dates,
   track count when release evidence makes it available, and other local release
   context.
5. Replaces the candidate set and either selects one uniquely supported result or
   records an explicit unresolved state.
6. Upserts the bounded canonical projection.
7. Completes, retries, or exhausts the job and reconciles its active diagnostic.

Name equality alone and first-result ordering never authorize a match. Automatic
artist matching accepts one of these evidence paths:

- a valid embedded artist MBID resolves and its canonical name or evidenced alias
  agrees with the local identity without contradictory release-credit evidence;
- an existing high-confidence MBID assertion resolves, its canonical name or alias
  agrees, and at least one local release supplies consistent artist-credit evidence;
- one search candidate has an exact normalized canonical-name or alias agreement
  plus consistent local release-credit evidence, and no competing candidate has the
  same evidence strength.

Automatic release-group matching accepts one of these evidence paths:

- a valid embedded release-group MBID resolves and its title and resolved artist
  credits agree with the local album;
- a valid embedded release MBID resolves to a release group whose title and artist
  credits agree with the local album;
- one search candidate has exact normalized title and resolved artist-credit
  agreement, with a compatible local year when a meaningful year is available,
  and no competing candidate has the same evidence strength.

Fuzzy text can order candidates for review but cannot authorize an automatic match
without an identifier or corroborating release evidence. Missing corroboration,
contradictory dates or credits, and tied evidence become reviewable states. The
implementation plan may tune ranking within these gates, but it may not weaken the
gates without another owner-approved design change.

## Native-Language Names

MusicBrainz canonical names, sort names, and aliases remain distinct. For Russian
and other CIS artists or people, Album Haven prefers a source-backed name in the
artist's original language and script. It does not reverse-transliterate, translate
another CIS language into Russian, or infer a native name from folder text.
Transliterated names remain aliases for search. For example, the preferred display
name is `Кипелов`, while `Kipelov` may remain a lookup alias.

This rule does not rewrite original album-credit text and does not merge distinct
same-name entities. Missing native-script evidence remains explicit and does not
block an otherwise reliable MBID match.

## Provider Result Classification And Retry

The MusicBrainz client classifies every attempt as one of:

- `found`
- `not_found`
- `catch_up_pending`
- `ambiguous`
- `rate_limited`
- `provider_unavailable`
- `invalid_response`
- `permanent_mismatch`

The restored search index can temporarily return an entity that the replicated
database cannot yet serve. A direct entity `404` following a successful search hit
for the same MBID is `catch_up_pending`, not `not_found`. It receives bounded
exponential retry with jitter and remains visibly distinct from a confirmed absent
entity. A search with no candidate can become `not_found` only after all required
pages were processed and the provider was otherwise healthy.

Rate limits, timeouts, connection failures, 5xx responses, and catch-up pending
states retry. Invalid response shape and contradictory evidence become review or
permanent mismatch states. Retry exhaustion preserves the last classification and
safe diagnostic. It never clears a previously valid match.

The existing shared HTTP transport remains responsible for user agent, throttling,
cancellation, bounded retries at the request layer, and process cache. Durable job
retry is the outer operation-level policy and must avoid multiplying request-layer
attempts without a documented bound.

## MI-02 Diagnostic Lifecycle

`library.metadata_enrichment_problems` is the durable source for active and
resolved metadata diagnostics. It stores the library, local entity, stable reason
code, lifecycle state, safe display context, candidate count, related job,
first/last observed times, resolved time, and resolution source. It does not store
private paths or raw provider payloads.

Initial reason codes are:

- `musicbrainz_artist_not_found`
- `musicbrainz_artist_ambiguous`
- `musicbrainz_artist_metadata_conflict`
- `musicbrainz_release_group_not_found`
- `musicbrainz_release_group_ambiguous`
- `musicbrainz_mirror_replication_pending`
- `musicbrainz_provider_retry_exhausted`
- `musicbrainz_manual_review_required`
- `musicbrainz_matched_entity_unavailable`

The same active problem is updated across retries rather than duplicated. Recovery
marks it resolved while preserving evidence and timestamps. A new regression may
open a new lifecycle occurrence without erasing the earlier resolution.

The existing Problematic Files PostgreSQL read path projects active metadata
diagnostics into its current album summaries and details. The compatibility field
`problem_reasons: list[str]` remains present and receives concise display text such
as `MusicBrainz release match is ambiguous`. Pending mirror replication says that
the mirror is catching up; it does not tell the user that the album metadata is
wrong. Artist-only diagnostics are associated with affected local albums for the
current album-oriented surface until a later approved artist diagnostic surface
exists.

This delivery reuses the current Problematic Files layout. New candidate-selection
or correction controls require a separately approved exact mockup before they are
exposed. Authorized retry and review API contracts may be implemented without
claiming that those controls already exist in the UI.

The `musicbrainz_canonical_genre_missing` reason is reserved for MI-03. It becomes
active only after artist and release genre hydration can distinguish confirmed
absence from pending or failed enrichment. At that point it applies when the
release group, selected release, and artist all lack an eligible canonical genre.
A local MusicBrainz mirror does not by itself prove that a genre was retrieved or
classified.

## API And Authorization

Ordinary gallery and Problematic Files reads use stored PostgreSQL projections and
make no render-time MusicBrainz calls.

The Problematic Files read contract requires `library.problems.read`. It exposes
safe reason text, state, timestamps, and candidate summaries but no raw paths,
provider payloads, credentials, or data from another library.

Retry requires `catalogue.enrichment.request`, validates that the target belongs to
the current library, and performs an idempotent job upsert. Choosing, correcting,
or clearing a match requires `library.metadata_matches.review`, records the actor
and audit event, and schedules dependent release-group reconciliation when an
artist decision changes. Owner inherits both capabilities. Administrator presets
may grant them. Listener defaults do not include them.

Provider endpoint configuration and service startup remain operator concerns and
are not user-facing mutation endpoints.

## Compatibility And Rollback

The migration is additive. Existing scan publication, browsing, playback, cover
lookup, MBID assertion history, and the `problem_reasons` response remain valid.
Reads switch to new match projections only after backfill and focused verification.

Rollback proceeds in this order:

1. Disable the enrichment worker and new scheduling through configuration.
2. Disable new diagnostic and match reads while preserving existing behavior.
3. Keep additive tables and accepted decisions for a later retry.
4. Remove schema only in a separate migration after confirming no reader depends
   on it.

Rollback never deletes retained identities, manual decisions, or audit facts and
never modifies the raw MusicBrainz mirror.

## Verification

Focused unit and PostgreSQL integration tests cover:

- environment-only endpoint relocation;
- artist matching by trusted MBID and multiple forms of corroborating evidence;
- rejection of name-only and first-result matches;
- ambiguous artists, homonyms, invalid IDs, and absent candidates;
- release-group matching with credited artist, title, date, and track evidence;
- complete paginated search and release-group reads;
- manual decision persistence and automatic-match replacement rules;
- protection of a valid match from transient or later missing responses;
- full, light, new-album, backfill, refresh, and manual-retry triggers;
- active-job deduplication and prerequisite waiting without attempt consumption;
- lease expiry, restart recovery, retry scheduling, and exhausted jobs;
- search-index-ahead direct-lookup `404` classification and recovery;
- provider outage, rate limit, invalid response, and cancellation;
- artist removal, reappearance, root moves, and duplicate roots;
- library isolation and safe Problematic Files output;
- stable diagnostic deduplication, recovery, and history;
- native-script preference, transliterated lookup, original album credits, and
  missing native-name evidence.

Acceptance data includes Neal Morse, Angra, The Flower Kings, Devin Townsend,
`ДДТ`, `Ария`, `Änglagård` through the `Anglagard` alias, Blind Guardian,
Helloween, Nightwish, Stratovarius, and The Beatles. The Nightwish same-name
collision is an explicit name-only rejection case. MI-05 later uses relationship
edge cases such as The Beatles final lineup; MI-01 verifies only stable identity
and local release-group linkage for these seeds.

Provider tests use bounded sanitized fixtures. State-mutating tests own unique
PostgreSQL data. Performance checks measure scan publication latency, queue growth,
indexed due-job claims, indexed active-problem reads, and bounded provider work.
The scan remains non-blocking, page rendering performs no provider calls, and job
processing observes configured concurrency and request-rate limits.

## Delivery Boundary

MI-01 and the MI-02 backend/compatibility projection form one independently useful
foundation: normalized identities, durable local matches, jobs, retries, and
explainable Problematic Files reasons. The implementation plan may split this
foundation into reviewable migrations and vertical slices, but every published
slice must have a tested compatibility contract and must not expose a broken user
journey.

Country and genre display, missing-genre activation, release-type UI, Customize,
relationship-driven Artist Family, family cards, remote-only related artists, and
family weighting remain outside this spec.
