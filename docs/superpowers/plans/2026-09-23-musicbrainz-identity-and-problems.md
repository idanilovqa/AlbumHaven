# MusicBrainz Identity And Problems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `executing-plans`; implement this
> plan task-by-task. Use `test-driven-development` for each behavior change,
> `migration` for the additive PostgreSQL transition, and
> `verification-before-completion` before each checkpoint. If the owner explicitly
> requests delegated execution, use the repository's approved subagent workflow.

**Goal:** Persist reliable MusicBrainz artist and release-group identities for all
local library content, recover enrichment across restarts, and explain unresolved
matches through Problematic Files.

**Architecture:** MusicBrainz remains a separate mirror behind its configurable
JSON API. Album Haven stores bounded canonical MusicBrainz projections under
`integration`, library-scoped matches and diagnostics under `library`, and durable
leased jobs under `ops`. A background service schedules and processes work without
blocking scans or page reads.

**Tech Stack:** Python 3, FastAPI, PostgreSQL 18, psycopg 3, pytest, existing
MusicBrainz HTTP transport, and the current JavaScript/Playwright Problematic Files
surface.

## Global Constraints

- Source design: `docs/superpowers/specs/2026-09-23-musicbrainz-identity-and-problems-design.md`.
- Checklist scope: MI-01 and MI-02 from the private
  `docs/future-feature-plans/music-metadata-graph-and-artist-family-plan.md`.
- Development endpoint: `http://localhost:5000/ws/2/`; deployment switches only
  through `MUSICBRAINZ_BASE_URL`.
- MusicBrainz JSON is transport only. Persist app-owned state in normalized
  PostgreSQL tables, never JSON files or opaque inventory JSON.
- Keep Cover Art Archive separate and external.
- Gallery queries continue to return local albums only.
- Retain artist identities and decisions after local files disappear.
- Never replace a valid or manual match with a missing, ambiguous, or transient
  result.
- Prefer source-backed native-script names for Russian and other CIS artists;
  transliteration remains an alias.
- Handle search-index-ahead direct-lookup `404` as `catch_up_pending`.
- Web, including narrow-screen web, is required. Tauri, Android, TV, and Apple are
  unsupported for this delivery.
- `library.problems.read` reads diagnostics;
  `catalogue.enrichment.request` requests retries; and
  `library.metadata_matches.review` chooses, corrects, or clears matches.
- Listener defaults do not receive either mutation capability.
- Run at most one pytest process at a time.
- Each new test must first fail for the missing behavior, then pass after the
  smallest implementation.
- Do not run local full release suites. Use focused local tests and the complete
  review-first CI pipeline at each publication checkpoint.

## Delivery Units

### Delivery A — MI-01 Durable Identity Foundation

- **Outcome:** Every retained local artist and every local album has a resolved or
  explicit unresolved MusicBrainz match state; durable jobs survive restarts.
- **Checklist IDs:** MI-01; `AH-W02-012`, `AH-W02-013`, `AH-W02-014`; identity
  subset of `AH-W03-001`.
- **Prerequisites:** approved technical design and provider endpoint contract.
- **Acceptance:** Tasks 1–7 and their focused tests pass; scan publication remains
  non-blocking; existing browsing, playback, cover lookup, and MBID assertions stay
  compatible.
- **Rollback:** disable enrichment, stop the worker, and leave additive tables and
  accepted decisions intact.
- **Checkpoint:** two complete local review passes, complete CI, owner acceptance,
  merge/publish, then synchronize from updated main before Delivery B.

### Delivery B — MI-02 Explainable Problems

- **Outcome:** Current Problematic Files reads show safe, stable reasons for
  unresolved artist/release matches; authorized retry and match-review endpoints
  use the durable job and match model.
- **Checklist IDs:** MI-02; diagnostic subsets of `AH-W02-013`, `AH-W02-014`,
  `AH-W03-001`, and `AH-W03-003`.
- **Prerequisites:** merged Delivery A; owner approval of the exact existing-layout
  Problematic Files artifact and display strings before visible implementation.
- **Acceptance:** Tasks 8–11 pass; diagnostics deduplicate, resolve, and retain
  history; capabilities and library isolation are enforced.
- **Rollback:** disable diagnostic projection and mutation routes while retaining
  rows for later recovery.
- **Checkpoint:** focused verification, owner manual acceptance, approved
  functional E2E, two complete local review passes, complete CI, merge/publish,
  and local main synchronization.

---

## Delivery A — MI-01 Durable Identity Foundation

### Task 1: Add the normalized PostgreSQL foundation

**Files:**

- Create: `migrations/postgres/0080_create_musicbrainz_identity_foundation.sql`
- Modify: `migrations/postgres/README.md`
- Modify: `tests/py/test_postgres_migrations.py`
- Create: `tests/py/test_musicbrainz_identity_migration_postgres.py`

**Interfaces:**

- Produces canonical tables keyed by MusicBrainz UUID.
- Produces one current match row per local artist and local album.
- Produces normalized candidate, job, and diagnostic rows used by every later task.
- Keeps `library.local_mbid_assertions` as evidence history.

- [ ] **Step 1: Write the migration inventory test**

Add an expected `0080` entry and assert that the SQL contains each schema-owned
table, library-scoped foreign key, active-job uniqueness index, due-job claim index,
problem lifecycle index, check constraint, and role grant.

```python
def test_musicbrainz_identity_migration_declares_normalized_ownership():
    sql = Path(
        "migrations/postgres/0080_create_musicbrainz_identity_foundation.sql"
    ).read_text(encoding="utf-8").casefold()
    for table in (
        "integration.musicbrainz_artists",
        "integration.musicbrainz_artist_aliases",
        "integration.musicbrainz_release_groups",
        "integration.musicbrainz_release_group_secondary_types",
        "integration.musicbrainz_release_group_credits",
        "library.local_artist_musicbrainz_matches",
        "library.local_artist_musicbrainz_candidates",
        "library.local_album_musicbrainz_matches",
        "library.local_album_musicbrainz_candidates",
        "library.metadata_enrichment_problems",
        "ops.metadata_enrichment_jobs",
    ):
        assert f"create table if not exists {table}" in sql
    assert "metadata_enrichment_jobs_due_idx" in sql
    assert "metadata_enrichment_jobs_one_active_artist_idx" in sql
    assert "metadata_enrichment_jobs_one_active_album_idx" in sql
    assert "metadata_enrichment_problems_one_active_idx" in sql
    assert "source_payload jsonb" not in sql
```

- [ ] **Step 2: Run the migration tests and verify RED**

Run:

```powershell
python -m pytest tests/py/test_postgres_migrations.py tests/py/test_musicbrainz_identity_migration_postgres.py -q
```

Expected: FAIL because migration `0080` and its live contract do not exist.

- [ ] **Step 3: Create migration `0080`**

Use explicit columns. Required keys and constraints:

```sql
create table if not exists integration.musicbrainz_artists (
  mbid uuid primary key,
  canonical_name text not null,
  sort_name text not null default '',
  disambiguation text not null default '',
  artist_kind text not null default '',
  begin_date text not null default '',
  end_date text not null default '',
  ended boolean,
  preferred_native_name text not null default '',
  fetched_at timestamptz not null,
  verified_at timestamptz not null,
  response_hash text not null default ''
);

create table if not exists integration.musicbrainz_artist_aliases (
  artist_mbid uuid not null references integration.musicbrainz_artists(mbid)
    on delete cascade,
  alias_name text not null,
  sort_name text not null default '',
  locale text not null default '',
  alias_kind text not null default '',
  primary_for_locale boolean not null default false,
  primary key (artist_mbid, alias_name, locale, alias_kind)
);

create table if not exists integration.musicbrainz_release_groups (
  mbid uuid primary key,
  title text not null,
  disambiguation text not null default '',
  first_release_date text not null default '',
  primary_type text not null default '',
  fetched_at timestamptz not null,
  verified_at timestamptz not null,
  response_hash text not null default ''
);
```

Add normalized secondary-type and ordered-credit tables. Match tables must have
`library_id`, the local entity foreign key, nullable target MBID, state, decision
source, confidence, evidence summary, reviewer account, selected time, and verified
time. Use unique constraints on `(library_id, local_artist_id)` and
`(library_id, local_album_id)` and composite foreign keys or triggers that prevent a
local entity from another library being attached.

Candidate tables store candidate MBID, rank, confidence, evidence tier, evidence
summary, rejection reason, and observed time. Do not add JSON payload columns.

Jobs use nullable `local_artist_id` and `local_album_id` plus a check requiring
exactly one. Add partial unique indexes for states `queued`, `leased`, and
`retry_wait`. Problems use the same exactly-one-target rule and a partial unique
index over active `(library_id, target, reason_code)`.

Grant minimum `select/insert/update/delete` privileges to `album_haven_app`,
read-only canonical/match/problem access to `album_haven_readonly`, and migration
ownership privileges to `album_haven_migrator`. Grant sequence usage only where an
identity column exists.

- [ ] **Step 4: Add a live migration contract**

Use the repository's isolated PostgreSQL fixture. Assert:

```python
def test_musicbrainz_foundation_enforces_library_scope_and_active_job_identity(
    migrated_connection,
):
    # Insert two libraries and one local artist in each.
    # A match using the other library's artist must fail.
    # Two active artist jobs for one target must conflict.
    # A succeeded job followed by a queued job must succeed.
    # Two active problems with the same reason must conflict.
    # Resolving the first permits a new lifecycle occurrence.
```

Use real SQL and `pytest.raises(psycopg.errors.ForeignKeyViolation)` or
`UniqueViolation`; do not mock constraint behavior.

- [ ] **Step 5: Run focused migration tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add migrations/postgres/0080_create_musicbrainz_identity_foundation.sql migrations/postgres/README.md tests/py/test_postgres_migrations.py tests/py/test_musicbrainz_identity_migration_postgres.py
git commit -m "feat: add MusicBrainz identity schema"
```

### Task 2: Add durable job and match repositories

**Files:**

- Create: `music_app/services/musicbrainz_enrichment_postgres.py`
- Create: `tests/py/test_musicbrainz_enrichment_postgres.py`
- Modify: `tests/py/test_musicbrainz_identity_migration_postgres.py`

**Interfaces:**

- Produces `PostgresMusicBrainzEnrichmentRepository`.
- Produces immutable `EnrichmentJob`, `LocalArtistTarget`, `LocalAlbumTarget`, and
  `MatchDecision` dataclasses.
- Later tasks call `schedule_scan_work`, `claim_due_jobs`, `load_*_target`,
  `record_*_decision`, `retry_job`, and `review_match`.

- [ ] **Step 1: Write repository tests with a recording connection**

Cover idempotent scheduling, claim/lease commit before provider work, expired lease
recovery, prerequisite waiting without incrementing attempts, manual-decision
protection, candidate replacement, canonical projection upserts, and problem
reconciliation.

```python
def test_record_artist_decision_never_replaces_manual_match(repository):
    repository.record_artist_decision(
        job_id=41,
        decision=MatchDecision(
            state="not_found",
            mbid=None,
            decision_source="automatic",
            confidence=None,
            evidence_summary="No reliable candidate",
        ),
        candidates=(),
    )
    sql = repository.connection.normalized_sql
    assert "decision_source <> 'manual'" in sql


def test_claim_due_jobs_uses_skip_locked(repository):
    repository.claim_due_jobs(worker_id="worker-a", limit=8, lease_seconds=120)
    assert "for update skip locked" in repository.connection.normalized_sql
```

- [ ] **Step 2: Run the repository tests and verify RED**

```powershell
python -m pytest tests/py/test_musicbrainz_enrichment_postgres.py -q
```

Expected: FAIL because the repository module does not exist.

- [ ] **Step 3: Implement dataclasses and the repository**

Use psycopg and injected `connect`/`now` seams:

Define `EnrichmentJob` as a frozen, slotted dataclass with `id: int`,
`library_id: int`, `job_kind: str`, nullable local artist/album IDs,
`attempt_count: int`, and `reason: str`. The repository exposes these exact methods:

- `schedule_scan_work(*, reason: str) -> dict[str, int]`
- `claim_due_jobs(*, worker_id: str, limit: int, lease_seconds: int) -> tuple[EnrichmentJob, ...]`
- `load_artist_target(job: EnrichmentJob) -> LocalArtistTarget`
- `load_album_target(job: EnrichmentJob) -> LocalAlbumTarget`
- `record_artist_decision(*, job_id, decision, candidates, artist)`
- `record_album_decision(*, job_id, decision, candidates, release_group)`
- `defer_for_prerequisite(*, job_id: int, retry_at: datetime)`
- `record_retry(*, job_id, classification, retry_at, safe_error)`
- `record_exhausted(*, job_id, classification, safe_error)`
- `retry_target(*, library_id, target_kind, target_key, reason)`
- `review_match(*, library_id, target_kind, target_key, mbid, actor_id)`

`schedule_scan_work` inserts work for every unmatched, unresolved, or stale local
artist and album, including retained artists. It uses conflict-safe partial-index
semantics and returns counts. Album loading includes credited artists, year, active
track count, embedded release/release-group MBIDs when present, and existing
assertion evidence.

Each decision transaction replaces candidates, updates the current match only when
manual ownership permits it, upserts canonical rows, reconciles one active problem,
and finalizes the job. Provider HTTP is never called inside these transactions.

- [ ] **Step 4: Add live repository tests**

Exercise real `SKIP LOCKED` claiming from two connections, expired lease recovery,
cross-library target rejection, retained-artist scheduling, and manual decision
preservation.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
python -m pytest tests/py/test_musicbrainz_enrichment_postgres.py tests/py/test_musicbrainz_identity_migration_postgres.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add music_app/services/musicbrainz_enrichment_postgres.py tests/py/test_musicbrainz_enrichment_postgres.py tests/py/test_musicbrainz_identity_migration_postgres.py
git commit -m "feat: persist MusicBrainz enrichment work"
```

### Task 3: Make the MusicBrainz transport classify responses without hiding catch-up

**Files:**

- Modify: `music_app/services/musicbrainz_http.py`
- Create: `music_app/services/musicbrainz_client.py`
- Modify: `tests/py/test_musicbrainz_http.py`
- Create: `tests/py/test_musicbrainz_client.py`
- Modify: `config.py`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**

- `musicbrainz_http.get_json` returns status metadata including an HTTP status.
- `MusicBrainzClient` exposes `get_artist`, `search_artists`, `get_release`,
  `get_release_group`, and `search_release_groups`.
- `ProviderResult[T]` exposes `classification`, `value`, `status_code`,
  `retry_after_seconds`, and `safe_error`.

- [ ] **Step 1: Write transport and client tests**

```python
def test_http_404_is_not_cached_as_generic_miss(monkeypatch):
    payload, detail = musicbrainz_http.get_json(
        "http://localhost:5000/ws/2/artist/missing?fmt=json",
        "AlbumHavenTests/1.0",
    )
    assert payload is None
    assert detail["status"] == "http_404"
    assert detail["status_code"] == 404


def test_search_hit_followed_by_direct_404_is_catch_up_pending(client):
    result = client.resolve_artist_candidate("candidate-mbid")
    assert result.classification == "catch_up_pending"
```

Also test endpoint joining with and without a trailing slash, pagination until
`count` is exhausted, 429 retry metadata, 5xx, timeouts, invalid payloads,
cancellation, and CAA endpoint independence.

- [ ] **Step 2: Run the client tests and verify RED**

```powershell
python -m pytest tests/py/test_musicbrainz_http.py tests/py/test_musicbrainz_client.py -q
```

Expected: FAIL on missing typed client and 404 semantics.

- [ ] **Step 3: Refine the shared transport**

Keep existing callers compatible. Add `status_code` to HTTP results, do not write
404/429/5xx/connection failures into the generic miss cache, and retain successful
response caching. Only a true caller-classified absence may receive a short negative
cache in the higher-level client.

- [ ] **Step 4: Implement the typed client**

Define `ProviderResult[T]` as a frozen, slotted dataclass with
`classification: str`, `value: T | None`, `status_code: int | None`,
`retry_after_seconds: float | None`, and `safe_error: str`. `MusicBrainzClient`
accepts keyword-only `base_url`, `user_agent`, and an injectable `get_json`. It
exposes `get_artist(UUID)`, `search_artists(str)`, `get_release(UUID)`,
`get_release_group(UUID)`, and `search_release_groups(str)`, each returning the
corresponding typed `ProviderResult`.

Use `urllib.parse.urlencode`. Apply `fmt=json`, bounded `limit`, and explicit
`offset`. Classify direct 404 after a search-selected MBID as `catch_up_pending` in
the resolve method; a standalone direct lookup is `not_found`.

- [ ] **Step 5: Document local configuration**

Add to `.env.example`:

```dotenv
MUSICBRAINZ_BASE_URL=http://localhost:5000/ws/2/
MUSICBRAINZ_ENABLED=1
```

README text must state that the development value targets the local mirror, the
environment can switch endpoints without code changes, and CAA remains external.
Keep the code default safe for installations that do not copy the development env.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add config.py .env.example README.md music_app/services/musicbrainz_http.py music_app/services/musicbrainz_client.py tests/py/test_musicbrainz_http.py tests/py/test_musicbrainz_client.py
git commit -m "feat: add configurable MusicBrainz client"
```

### Task 4: Implement deterministic artist and release-group matching

**Files:**

- Create: `music_app/services/musicbrainz_matching.py`
- Create: `tests/py/test_musicbrainz_matching.py`
- Create: `tests/fixtures/musicbrainz/artist-search-cases.json`
- Create: `tests/fixtures/musicbrainz/release-group-search-cases.json`

**Interfaces:**

- Consumes repository target dataclasses and client response dictionaries.
- Produces `MatchEvaluation(decision, candidates, canonical_entity)`.
- Does not perform HTTP or database I/O.

- [ ] **Step 1: Add sanitized acceptance fixtures**

Include bounded provider fields for the twelve named artists. Include
`Anglagard` → `Änglagård`, `Kipelov` → `Кипелов`, the distinct Nightwish collision,
same-title release groups, compilation credits, missing years, and conflicting
embedded IDs. Do not copy private paths or full mirror responses.

- [ ] **Step 2: Write failing pure matcher tests**

```python
def test_artist_name_without_release_credit_is_not_auto_matched():
    result = evaluate_artist_match(target, [same_name_candidate])
    assert result.decision.state == "manual_review"
    assert result.decision.mbid is None


def test_native_alias_selects_canonical_identity_and_native_display_name():
    result = evaluate_artist_match(kipelov_target, [kipelov_candidate])
    assert result.decision.state == "matched"
    assert result.canonical_entity.preferred_native_name == "Кипелов"


def test_release_group_requires_title_and_resolved_credit_agreement():
    result = evaluate_release_group_match(target, candidates)
    assert result.decision.state == "ambiguous"
```

Cover every approved evidence gate and every diagnostic state.

- [ ] **Step 3: Run matcher tests and verify RED**

```powershell
python -m pytest tests/py/test_musicbrainz_matching.py -q
```

Expected: FAIL because the matcher is absent.

- [ ] **Step 4: Implement pure matching**

Define `CandidateEvaluation` as a frozen, slotted dataclass with MBID, rank,
confidence, evidence tier, evidence summary, and rejection reason. Define
`MatchEvaluation[T]` with a `MatchDecision`, candidate tuple, and nullable canonical
entity. Export these exact pure functions:

- `evaluate_artist_match(LocalArtistTarget, Sequence[Mapping[str, object]]) -> MatchEvaluation[CanonicalArtist]`
- `evaluate_release_group_match(LocalAlbumTarget, Sequence[Mapping[str, object]]) -> MatchEvaluation[CanonicalReleaseGroup]`

Normalize Unicode with NFKC and casefold for comparison while preserving original
text for display. Never reverse-transliterate. Implement the evidence gates exactly
as approved in the spec. Confidence orders review candidates; it cannot bypass a
gate. Ties at the strongest eligible tier are ambiguous.

- [ ] **Step 5: Run focused matcher tests and verify GREEN**

Run the command from Step 3. Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add music_app/services/musicbrainz_matching.py tests/py/test_musicbrainz_matching.py tests/fixtures/musicbrainz/artist-search-cases.json tests/fixtures/musicbrainz/release-group-search-cases.json
git commit -m "feat: match local music to MusicBrainz identities"
```

### Task 5: Process one durable enrichment job end to end

**Files:**

- Create: `music_app/services/musicbrainz_enrichment.py`
- Create: `tests/py/test_musicbrainz_enrichment.py`
- Modify: `music_app/services/local_mbid_assertions.py`
- Modify: `tests/py/test_local_mbid_assertions.py`

**Interfaces:**

- Produces `MusicBrainzEnrichmentService.process_job(job)` and `run_batch()`.
- Consumes the repository, client, and pure matcher interfaces from Tasks 2–4.
- Converts existing Last.fm MBID assertions into evidence without letting old
  projection columns own current match state.

- [ ] **Step 1: Write orchestration tests**

Use fakes. Cover trusted embedded IDs before search, assertion evidence, paginated
search, album prerequisite deferral, direct-search-hit 404 catch-up, retryable
provider errors, retry exhaustion, cancellation, canonical upsert, candidate
replacement, and valid/manual match preservation.

```python
def test_search_hit_direct_404_retries_without_erasing_match(service, repository):
    outcome = service.process_job(repository.artist_job)
    assert outcome.classification == "catch_up_pending"
    assert repository.retry_calls[0].classification == "catch_up_pending"
    assert repository.decision_calls == []
```

- [ ] **Step 2: Run orchestration tests and verify RED**

```powershell
python -m pytest tests/py/test_musicbrainz_enrichment.py tests/py/test_local_mbid_assertions.py -q
```

Expected: FAIL because the service is missing.

- [ ] **Step 3: Implement the service**

`MusicBrainzEnrichmentService` accepts keyword-only repository, client, clock, and
cancellation callback dependencies. It exposes
`run_batch(*, worker_id: str, limit: int = 8) -> BatchSummary` and
`process_job(job: EnrichmentJob) -> JobOutcome`.

Use an operation retry schedule of 1 minute, 5 minutes, 30 minutes, 2 hours, 8
hours, then 24 hours with bounded jitter. Catch-up pending remains retryable for
seven days before `exhausted`; other transient classes use six attempts. Provider
calls happen after the job lease transaction commits.

For existing assertions, expose one read-only function returning normalized
evidence rows for a local artist. Remove no assertion history and write no new
current match back into the old projection columns.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add music_app/services/musicbrainz_enrichment.py music_app/services/local_mbid_assertions.py tests/py/test_musicbrainz_enrichment.py tests/py/test_local_mbid_assertions.py
git commit -m "feat: process durable MusicBrainz enrichment jobs"
```

### Task 6: Schedule work from scans and run the background worker

**Files:**

- Create: `music_app/services/musicbrainz_enrichment_worker.py`
- Create: `tests/py/test_musicbrainz_enrichment_worker.py`
- Modify: `music_app/services/scan_state.py`
- Modify: `music_app/services/state.py`
- Modify: `music_app/__init__.py`
- Modify: `tests/py/test_scan_state.py`
- Modify: `tests/py/test_state.py`
- Modify: `tests/py/test_web_asgi_routes.py`

**Interfaces:**

- Produces `start_musicbrainz_enrichment_worker(runtime)` and
  `stop_musicbrainz_enrichment_worker(runtime, wait=True)`.
- Adds `queue_metadata_enrichment` to the successful scan finalization seam.
- Startup schedules a backfill and wakes the worker.

- [ ] **Step 1: Write worker lifecycle and scan-trigger tests**

Assert:

Use the exact test names
`test_successful_scan_schedules_all_eligible_metadata_work`,
`test_cache_fresh_light_scan_still_schedules_unresolved_backfill`,
`test_failed_or_superseded_scan_does_not_schedule_work`,
`test_worker_recovers_expired_lease_after_restart`, and
`test_asgi_shutdown_stops_musicbrainz_worker_before_runtime_executor`.

Also cover full scan, periodic/light scan, new album, no database URL, disabled
MusicBrainz, and repeated scheduling deduplication.

- [ ] **Step 2: Run focused lifecycle tests and verify RED**

```powershell
python -m pytest tests/py/test_scan_state.py tests/py/test_state.py tests/py/test_musicbrainz_enrichment_worker.py tests/py/test_web_asgi_routes.py -q
```

Expected: FAIL on missing scheduling and lifecycle behavior.

- [ ] **Step 3: Add the scan scheduling seam**

Extend `refresh_library_state` with:

```python
queue_metadata_enrichment: Callable[[str], object] | None = None
```

Call it only after a successful persisted scan or successful cache hydration, with
reason `full_scan`, `periodic_scan`, `new_album`, or `startup_backfill`. Scheduling
does one database upsert pass and returns immediately. Keep the existing Last.fm
assertion follow-up until its evidence collection has been fully replaced; do not
use its in-process executor for MusicBrainz work.

- [ ] **Step 4: Implement the worker**

Use one daemon thread with a stop event and wake event. The loop runs bounded job
batches until none are due, then waits at most 30 seconds. `MUSICBRAINZ_ENABLED=0`
prevents scheduling and startup. Store the worker instance on runtime/app state;
avoid module-global ownership collisions between tests.

`MusicBrainzEnrichmentWorker` exposes `start() -> None`, `wake() -> None`, and
`stop(*, wait: bool = True, timeout: float = 5.0) -> bool`.

Start after startup hydration and stop in `shutdown_resources` before generic
runtime shutdown. Log only safe counts, classifications, and job IDs.

- [ ] **Step 5: Run focused lifecycle tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add music_app/services/musicbrainz_enrichment_worker.py music_app/services/scan_state.py music_app/services/state.py music_app/__init__.py tests/py/test_musicbrainz_enrichment_worker.py tests/py/test_scan_state.py tests/py/test_state.py tests/py/test_web_asgi_routes.py
git commit -m "feat: run MusicBrainz enrichment after library scans"
```

### Task 7: Complete MI-01 compatibility, acceptance, and checkpoint documentation

**Files:**

- Modify: `tests/py/test_scan_cache_persistence.py`
- Modify: `tests/py/test_library_browse_postgres.py`
- Create: `tests/py/test_musicbrainz_identity_acceptance.py`
- Modify in private repo:
  `docs/functional-test-cases/scan-status-caching-and-operational-flows.md`
- Modify in private repo: `docs/architecture.md`
- Modify in private repo:
  `docs/future-feature-plans/music-metadata-graph-and-artist-family-plan.md`
- Modify in private repo: `docs/post-migration-roadmap.md`

**Interfaces:**

- Verifies identity retention and local-album-only gallery behavior across the
  existing persistence and browse boundaries.
- Records MI-01 progress without marking MI-02–MI-05 complete.

- [ ] **Step 1: Write retention and gallery regressions**

Add focused cases proving scan publication updates `last_seen_at` without clearing
match rows, disappearance preserves the artist and decision, reappearance reuses
the same local artist ID, another library cannot observe it, and no canonical
MusicBrainz release group creates a gallery card without a local album.

- [ ] **Step 2: Run focused MI-01 verification**

```powershell
python -m pytest tests/py/test_musicbrainz_http.py tests/py/test_musicbrainz_client.py tests/py/test_musicbrainz_matching.py tests/py/test_musicbrainz_enrichment_postgres.py tests/py/test_musicbrainz_enrichment.py tests/py/test_musicbrainz_enrichment_worker.py tests/py/test_local_mbid_assertions.py tests/py/test_scan_state.py tests/py/test_scan_cache_persistence.py tests/py/test_library_browse_postgres.py tests/py/test_musicbrainz_identity_acceptance.py -q
```

Expected: PASS with one pytest process.

- [ ] **Step 3: Run migration and static checks**

```powershell
python -m pytest tests/py/test_postgres_migrations.py tests/py/test_musicbrainz_identity_migration_postgres.py -q
git diff --check
```

Expected: PASS and no whitespace errors.

- [ ] **Step 4: Update documentation**

Document the source boundary, tables, worker lifecycle, endpoint configuration,
retry classifications, rollback switch, and exact operator diagnostics. Mark only
MI-01 checklist items proven by the final code and tests. Record the commit/PR/CI
evidence instead of marking provider exploration as implementation acceptance.

- [ ] **Step 5: Perform the required review and delivery checkpoint**

Complete two adversarial local review passes over the entire Delivery A diff. Fix
every validated finding and repeat a full pass when a substantive issue appears.
Push the branch and require the complete review-first CI pipeline. Give the owner a
manual script that scans a small library, checks retained matches after removal and
reappearance, changes `MUSICBRAINZ_BASE_URL`, and demonstrates catch-up retry.
Obtain owner acceptance, merge/publish, and synchronize a fresh branch/worktree from
updated main before Task 8.

---

## Delivery B — MI-02 Explainable Problems

### Task 8: Project durable metadata diagnostics into Problematic Files

**Pre-implementation gate:** Capture the current Problematic Files desktop and
narrow-screen layouts populated with representative mapping reasons. Obtain owner
approval of the exact artifact and display strings. Reuse the current components;
do not add candidate-selection controls in this task.

**Files:**

- Modify: `music_app/services/library_browse_postgres.py`
- Modify: `music_app/routes/api_problematic_albums.py`
- Modify: `tests/py/test_library_browse_postgres.py`
- Modify: `tests/py/test_problematic_albums.py`
- Modify: `tests/py/test_api_read_asgi_routes.py`
- Modify: `tests/js/runtime/utility-problematic-tab.test.js`

**Interfaces:**

- Existing `problem_reasons: list[str]` remains compatible.
- Adds safe structured `metadata_problems` to summary/detail payloads.
- Artist problems project only onto currently local affected albums.

- [ ] **Step 1: Write projection tests**

Cover every initial reason code, stable display order, candidate count, retry state,
resolved-row exclusion, cross-library exclusion, artist-to-local-album projection,
no private path/provider payload leakage, and existing reason preservation.

```python
def test_problematic_payload_adds_active_musicbrainz_reason_without_replacing_file_reasons():
    payload = repository.build_problematic_files_payload()
    item = payload["items"][0]
    assert item["problem_reasons"] == [
        "Missing cover art",
        "MusicBrainz release match is ambiguous",
    ]
    assert item["metadata_problems"][0]["reason_code"] == (
        "musicbrainz_release_group_ambiguous"
    )
    assert "path" not in item["metadata_problems"][0]
```

- [ ] **Step 2: Run projection tests and verify RED**

```powershell
python -m pytest tests/py/test_library_browse_postgres.py tests/py/test_problematic_albums.py tests/py/test_api_read_asgi_routes.py -q
```

Expected: FAIL because metadata diagnostics are not joined.

- [ ] **Step 3: Extend the PostgreSQL read projection**

Add one aggregated diagnostic CTE keyed by local album. Map reason codes through a
Python constant rather than storing mutable prose as authority:

```python
MUSICBRAINZ_PROBLEM_MESSAGES = {
    "musicbrainz_artist_not_found": "MusicBrainz artist match was not found",
    "musicbrainz_artist_ambiguous": "MusicBrainz artist match is ambiguous",
    "musicbrainz_artist_metadata_conflict": "Local artist metadata conflicts with MusicBrainz",
    "musicbrainz_release_group_not_found": "MusicBrainz release match was not found",
    "musicbrainz_release_group_ambiguous": "MusicBrainz release match is ambiguous",
    "musicbrainz_mirror_replication_pending": "MusicBrainz mirror is still catching up",
    "musicbrainz_provider_retry_exhausted": "MusicBrainz could not be reached after retries",
    "musicbrainz_manual_review_required": "MusicBrainz match needs review",
    "musicbrainz_matched_entity_unavailable": "Matched MusicBrainz entity is unavailable",
}
```

Keep pending enrichment out of confirmed not-found reasons. Preserve current
pagination, virtualization, search text, count, and detail behavior.

- [ ] **Step 4: Run Python and JavaScript focused tests**

```powershell
python -m pytest tests/py/test_library_browse_postgres.py tests/py/test_problematic_albums.py tests/py/test_api_read_asgi_routes.py -q
node --test --test-concurrency=1 tests/js/runtime/utility-problematic-tab.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add music_app/services/library_browse_postgres.py music_app/routes/api_problematic_albums.py tests/py/test_library_browse_postgres.py tests/py/test_problematic_albums.py tests/py/test_api_read_asgi_routes.py tests/js/runtime/utility-problematic-tab.test.js
git commit -m "feat: explain MusicBrainz problems in Problematic Files"
```

### Task 9: Add retry and manual match-review capabilities and APIs

**Files:**

- Create: `music_app/routes/musicbrainz_enrichment_asgi.py`
- Modify: `music_app/__init__.py`
- Modify: `music_app/services/private_route_boundary.py`
- Modify: `music_app/services/admin_account_creation.py`
- Modify: `music_app/routes/admin_asgi.py`
- Modify: `tests/py/test_admin_account_creation.py`
- Modify: `tests/py/test_admin_members_asgi.py`
- Create: `tests/py/test_musicbrainz_enrichment_asgi.py`
- Modify in private repo: `docs/permissions-and-capabilities.md`

**Interfaces:**

- `POST /metadata-enrichment/retry` accepts target kind and local key.
- `PUT /metadata-matches/{target_kind}` accepts local key and MusicBrainz UUID or
  `null` to clear for review.
- Both routes resolve the current authorized library server-side.

- [ ] **Step 1: Register approved capabilities in documentation and tests**

Add:

```python
"catalogue.enrichment.request",
"library.metadata_matches.review",
```

to `MANAGED_CAPABILITY_KEYS` and the Management admin group. Assert owner
inheritance, optional administrator grants, listener-default exclusion, and exact
labels. Add the approved deployment/client matrix and mutation semantics to the
private capability registry before exposing routes.

- [ ] **Step 2: Write API tests and verify RED**

Cover missing authentication, missing capability, wrong-library target, invalid
kind/key/UUID, idempotent retry, valid retry, manual select, correction, clear,
dependent album requeue after artist change, audit event, and safe responses.

Use the exact test names `test_retry_requires_enrichment_capability`,
`test_review_match_requires_review_capability`,
`test_artist_correction_requeues_dependent_local_albums`, and
`test_match_route_never_accepts_internal_library_id_from_body`.

Run:

```powershell
python -m pytest tests/py/test_musicbrainz_enrichment_asgi.py tests/py/test_admin_account_creation.py tests/py/test_admin_members_asgi.py -q
```

Expected: FAIL because capabilities and routes are absent.

- [ ] **Step 3: Implement bounded request models and routes**

Create `RetryRequest` with `target_kind: Literal["artist", "album"]` and a
1–512-character `target_key`. Create `MatchReviewRequest` with the same bounded
`target_key` and `mbid: UUID | None`. `POST /metadata-enrichment/retry` depends on
`require_action("catalogue.enrichment.request")`. `PUT
/metadata-matches/{target_kind}` bounds the path kind to artist/album and depends on
`require_action("library.metadata_matches.review")`.

Use the actor/library scope from the policy result. Never accept `library_id` or
`account_id` from the request body. Return `202` with the existing/new job state for
retry, `200` with the stored match state for review, `404` for a target outside the
current library, and `409` for an MBID whose fetched entity kind conflicts.

For a non-null manual MBID, perform the direct MusicBrainz lookup outside a database
transaction before calling `review_match`. Return `503` with bounded `Retry-After`
for provider-unavailable or catch-up-pending validation, `404` for a confirmed
missing entity, and `409` for the wrong entity kind. Upsert the validated canonical
projection and manual decision together. Clearing a decision makes the target
`manual_review` and queues automatic candidate discovery; it does not restore an
older automatic selection silently.

Add exact route mappings to `private_route_boundary.py`, include the router, and
wake the worker after a committed retry or changed match. Log actor ID, target kind,
opaque local key hash, and decision type without raw paths.

- [ ] **Step 4: Run focused capability and API tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add music_app/routes/musicbrainz_enrichment_asgi.py music_app/__init__.py music_app/services/private_route_boundary.py music_app/services/admin_account_creation.py music_app/routes/admin_asgi.py tests/py/test_musicbrainz_enrichment_asgi.py tests/py/test_admin_account_creation.py tests/py/test_admin_members_asgi.py
git commit -m "feat: authorize MusicBrainz retry and review"
```

Commit the private capability-registry update separately in its owning repository;
do not stage unrelated dirty private-repository files.

### Task 10: Add functional coverage and exact manual acceptance

**Files:**

- Modify in private repo:
  `docs/functional-test-cases/utilities-problematic-files-rules-appearance-and-log-history.md`
- Modify in private repo:
  `docs/functional-test-cases/scan-status-caching-and-operational-flows.md`
- Create: `tests/e2e/specs/musicbrainzMetadataProblems.spec.js`

**Interfaces:**

- Covers the visible existing-layout reason rendering and authorized retry journey.
- Uses local albums only and deterministic seeded PostgreSQL diagnostics.

- [ ] **Step 1: Record functional cases and test proposal**

Add cases for ambiguous artist, ambiguous release group, mirror catching up,
provider retry exhaustion, recovery clearing the active problem, unauthorized
retry, authorized retry deduplication, local-only gallery, and native-script artist
name. Record web and narrow-screen web as required and other clients unsupported.

- [ ] **Step 2: Give the owner the exact manual script/build**

The script must state:

1. Start the app with `MUSICBRAINZ_BASE_URL=http://localhost:5000/ws/2/`.
2. Load a seeded local album with an ambiguous release-group match.
3. Open Problematic Files and verify the approved reason and safe context.
4. Retry as an unauthorized listener and verify denial.
5. Retry as owner/admin and verify one durable job, not duplicates.
6. Let a deterministic provider fixture resolve the match and verify the active
   problem disappears while history remains in PostgreSQL.
7. Remove and restore the local artist's files and verify the same identity returns.
8. Verify no remote-only album card appears.

Wait for owner manual acceptance before adding E2E, as required by the feature
workflow.

- [ ] **Step 3: Add the approved Playwright scenario**

Use the existing isolated PostgreSQL fixture tooling. Do not call the live owner
mirror from E2E. Assert exact reason text, permitted actions, response status,
deduplication, recovery, and narrow-screen usability.

- [ ] **Step 4: Run focused E2E**

Use the repository's functional E2E runner with only the newly registered case.
Expected: PASS. Audit the exact owned Playwright/browser/app process tree and ports
after completion before starting another heavyweight run.

- [ ] **Step 5: Commit**

```powershell
git add tests/e2e/specs/musicbrainzMetadataProblems.spec.js
git commit -m "test: cover MusicBrainz metadata problems"
```

Commit the two functional-case documents separately in the private repository,
staging only those exact files.

### Task 11: Complete MI-02 review, documentation, and publication

**Files:**

- Modify in private repo: `docs/architecture.md`
- Modify: `README.md`
- Modify in private repo:
  `docs/future-feature-plans/music-metadata-graph-and-artist-family-plan.md`
- Modify in private repo: `docs/post-migration-roadmap.md`
- Modify in private repo: `docs/permissions-and-capabilities.md`

**Interfaces:**

- Closes only the proven MI-02 foundation and keeps MI-03–MI-05 unchecked.
- Records review, CI, manual acceptance, rollback, and publication evidence.

- [ ] **Step 1: Run focused MI-02 verification**

```powershell
python -m pytest tests/py/test_musicbrainz_enrichment_postgres.py tests/py/test_musicbrainz_enrichment.py tests/py/test_musicbrainz_enrichment_asgi.py tests/py/test_library_browse_postgres.py tests/py/test_problematic_albums.py tests/py/test_api_read_asgi_routes.py tests/py/test_admin_account_creation.py tests/py/test_admin_members_asgi.py -q
node --test --test-concurrency=1 tests/js/runtime/utility-problematic-tab.test.js
git diff --check
```

Expected: PASS, PASS, and no whitespace errors.

- [ ] **Step 2: Verify migration and rollback contracts**

```powershell
python -m pytest tests/py/test_postgres_migrations.py tests/py/test_musicbrainz_identity_migration_postgres.py -q
```

Disable enrichment in a focused runtime test and prove browsing and existing
Problematic Files reasons still work from stored state.

- [ ] **Step 3: Update public and private documentation**

Document operator configuration, worker health, stable reason codes, capabilities,
API request/response contracts, local-only gallery behavior, and rollback order.
Mark MI-02 complete only after every acceptance item has evidence. Leave
`musicbrainz_canonical_genre_missing` inactive and MI-03 unchecked until genre
hydration can prove confirmed absence.

- [ ] **Step 4: Perform required local review**

Review the complete Delivery B diff twice with adversarial correctness,
simplicity, privacy, privilege, concurrency, and query-plan scrutiny. Fix every
validated issue and repeat a whole-diff pass after any substantive fix.

- [ ] **Step 5: Publish through the authoritative pipeline**

Push the reviewed branch. Let every applicable hosted reviewer finish before test
jobs. Collect the complete CI failure inventory, fix reproduced failures with
focused local tests, and rerun the complete pipeline until green. Merge/publish
only after successful full CI and recorded owner manual acceptance. Synchronize
local main and archive the delivery evidence.

## Plan Self-Review Checklist

- [x] Every MI-01 design requirement maps to Tasks 1–7.
- [x] Every MI-02 design requirement maps to Tasks 8–11.
- [x] No task activates country/genre pills, release-type UI, Customize, Artist
  Family relationships, remote album cards, or family weights.
- [x] Match, candidate, job, and problem state is normalized PostgreSQL data.
- [x] Provider calls occur outside database transactions and page rendering.
- [x] Manual and valid match protection is tested at repository and service levels.
- [x] Catch-up 404, restart recovery, library isolation, and retained identity each
  have focused tests.
- [x] Capability registry, managed-account keys, route policy, and tests agree.
- [x] Delivery A completes its merge/publish checkpoint before Delivery B starts.
- [x] Private-repository commits stage only intended documentation files.
