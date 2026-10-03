# Fast Automatic Cover Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace slow automatic cover discovery, preserve completed covers, and resume the cover-only pass with measured throughput.

**Architecture:** Keep manual Find Better Art unchanged. Add a bounded automatic resolver that checks Apple API, Deezer, YouTube Music, and Spotify in order; only use Bandcamp when none returns a valid candidate. Reconcile interrupted writes and checkpoint scan/lookup metadata during the bulk pass.

**Tech Stack:** Python, Pillow, pytest, Postgres-backed scan state.

## Global Constraints

- Never overwrite a selected or user-owned cover.
- Never follow cover paths outside authorized album folders.
- Stop on a confident image with both dimensions at least 1,200 pixels.
- Retain the best matched smaller candidate when no provider clears that threshold.
- Keep manual page search unchanged; automatic Apple search is API-only.
- Do not repeat the full music scan or stop unrelated processes.

---

### Task 1: Automatic provider selection

**Files:** `music_app/services/cover_refresh_provider.py`, `music_app/services/cover_provider_apple.py`, `music_app/services/cover_provider_matching.py`, `tests/py/test_cover_refresh_provider.py`, `tests/py/test_cover_provider_apple.py`.

**Interfaces:** Preserve `search_primary_remote_cover(...) -> tuple[CoverCandidate | None, list[dict[str, object]]]`; add a separate bounded Apple API path and use existing provider candidate contracts.

- [ ] Add exact tests for provider order, first 1,200×1,200 stop, smaller fallback, disabled providers, wrong identity/year, and Apple API-only automatic search. Run each exact pytest selection and confirm an expected failure.
- [ ] Implement the minimum automatic resolver and bounded provider calls without altering manual search.
- [ ] Run the focused provider tests and confirm they pass.

### Task 2: Bandcamp fallback and interruption budget

**Files:** `music_app/services/cover_refresh_provider.py`, `tests/py/test_cover_refresh_provider.py`.

**Interfaces:** Retain the current resolver return contract and trace statuses; Bandcamp is reachable only after all four primary providers miss.

- [ ] Add failing tests for Bandcamp-only-after-total-miss and a mocked slow provider that cannot monopolize the job.
- [ ] Add bounded waits and fallback at the existing automatic resolver seam.
- [ ] Run focused tests and confirm provider failures, skips, and no-matches remain distinct.

October 3 provider-failure correction: regressions first reproduced lost
Deezer HTTP-200 errors, malformed/empty response payloads, Apple/Deezer/Spotify
missing result lists, Spotify missing tokens, MusicBrainz dependency failures,
and swallowed Bandcamp discovery-future failures. Automatic failures now remain
retryable rather than becoming negative-cache entries. Bandcamp preserves valid
matches despite another discovery path failing. Both image-probe paths preserve
all earlier valid candidates when a later probe expires, including a higher-ranked
candidate other than the last one. Manual behavior and valid empty-result lists
remain unchanged. The final focused deadline, Bandcamp, automatic resolver,
HTTP, Deezer, planning, Apple, Spotify and MusicBrainz gate passed 185 tests in
9.59 seconds (two existing Pillow deprecation warnings). This evidence does not
establish live throughput or satisfy manual acceptance, E2E, review, CI or
publication gates. No task checkbox or progress counter changed; remaining
task-level acceptance stays open.

### Task 3: Recover interrupted cover writes and checkpoint progress

**Files:** `music_app/services/cover_refresh_planning.py`, `music_app/services/cover_refresh_execution.py`, `music_app/services/cover_provider_cache.py`, `tests/py/test_cover_refresh_planning.py`, `tests/py/test_state.py`.

**Interfaces:** Reuse the existing scan-cache and lookup-cache persistence owners; no new storage authority.

- [ ] Add failing tests showing a written local cover survives replanning and an interrupted batch retains checkpointed metadata.
- [ ] Reconcile existing authorized cover files before planning and checkpoint updates in bounded batches.
- [ ] Run focused recovery and execution tests; confirm selected-cover and containment cases still pass.

### Task 4: Safe replacement and measured smoke

**Files:** `docs/superpowers/specs/2026-09-24-fast-automatic-cover-search-design.md`, owning multi-root plan.

- [ ] Confirm the old worker exited and inspect current cover files/cache without disclosing paths or media.
- [ ] Run sequential focused Python tests and a small live smoke with elapsed provider timings.
- [ ] Resume only the cover pass on the published inventory; record jobs per minute and provider error rates against the earlier 265-job/156-download checkpoint.
- [ ] Record remaining manual acceptance, E2E, review, CI, and publication gates.

## Recovery verification progress

Focused red/green tests cover recovery of a newly discovered local cover and a
changed image at the same path, preserving its content revision without counting
a download. Nondownloaded user-owned selections retain their paths and linked
remote-art metadata. Lookup results checkpoint every 25 completed jobs. The
existing guarded image writer already commits new image selections per album.
The combined family-projection/cover-job verification passed 124 tests after
review fixes. Live reconciliation and resumption remain open.

Storage clarification: scan/image-selection metadata is Postgres-backed, but
the pre-existing `CoverSearchCache` still uses its legacy JSON implementation.
This change reuses that owner; it does not add a JSON fallback or claim the
lookup cache has been migrated. A lookup-cache persistence migration is not
part of this approved resolver correction.

### October 3 integrated verification and sandbox deployment

Independent focused integration verification passed 244 tests with 30 unrelated
cases deselected and two existing Pillow deprecation warnings in 11.64 seconds.
The JavaScript verification passed 370 tests. This evidence supplements the
earlier provider gate; it does not replace required acceptance or release gates.

Sandbox3 was deployed at code commit `2ecf7de2` using the official deployment
runbook and this feature worktree. The public endpoint
`https://sandbox3.albumhaven.org/login` returned HTTP 200 with the Album Haven
sign-in page; `/bootstrap-data` returned HTTP 401. The deployment task was running,
with port 5003 owned by reloader PID 22256 and application worker PID 2496.
These are observations at verification time, not persistent process identities.

An initial Windows `pythonw` spawned-stream startup failure was corrected locally
in the deployment repository's `serve.py` and `test_deploy.py`, with five passing
tests and two review passes. The production deployment path remained unchanged.

No production cover pass was started. The supported endpoint uses the installed
application code; an independent worker was unsafe because of full-snapshot
writes and process-local coordination. Manual acceptance, E2E, CI, release, and
live production cover throughput remain open. No checklist or counter changed.

### October 3 search-only smoke evidence

Read-only provider searches using isolated sandbox3 configuration measured Rush
in 4.194 seconds (Apple candidate, 1498 x 1498) and Spock's Beard in 12.571
seconds (no candidate, including a 7.06164-second Bandcamp timeout). These were
search-only samples, with no album or database writes. Production cover-pass
throughput in jobs per minute remains unverified; these measurements do not
complete manual acceptance, E2E, CI, review, or publication gates.
