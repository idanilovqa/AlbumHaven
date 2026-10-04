# Cover Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox syntax. The orchestrator coordinates separate test authoring, implementation and review; only one pytest process may run at a time.

**Goal:** Prepare manual cover-only requests once, reducing redundant normalization and filesystem probes without changing job selection or execution safety.

**Architecture:** Memoize normalized identities inside one planning call. Carry prepared jobs and the existing `CoverRefreshContext` through the manual worker chain. Existing execution, ownership, image inspection and persistence services retain their responsibilities; standalone execution still plans for itself.

**Tech Stack:** Python, pathlib, dataclasses, pytest; existing executor. No dependencies added.

## Global constraints and delivery record

- Approved design: `docs/superpowers/specs/2026-10-04-cover-preparation-design.md`; owner approved the written specification October 4, 2026.
- Checklist IDs: PREP-1 normalization/probe reduction; PREP-2 prepared-request reuse; PREP-3 generated-input measurement and verification.
- Prerequisites: written approval, separate failing regressions, exclusive pytest lane. Metadata recovery and atomic cache hardening are separate units.
- Do not introduce a new persistent cache or concurrency mechanism.
- Do not trust hydrated dimensions without file-revision validation. Do not skip track-path, metadata, or user-ownership aggregation after a folder is queued.
- No schema, cache-authority, permission, UI, public API, settings, client-support or deployment change.
- No production database/media access, active-pass inspection, maintenance restart, redeployment or new cover pass. The active pass finishes using its loaded code.
- Compatibility: standalone manual bulk refresh still works; background and single-album flows retain behavior. `None` means no prepared request; an empty list is a valid prepared result.
- Rollback: revert this unit's source/tests/docs only; no migration or persisted-plan cleanup.
- Merge/publish checkpoint: coherent independently reviewed unit, preserving manual acceptance, E2E, hosted review, CI and publication gates. Do not automatically publish the accumulated multi-root branch. Establish its safe delivery boundary before staging unrelated changes or opening a PR.

## File ownership and current interfaces

- `music_app/services/cover_refresh_planning.py`: `build_cover_refresh_jobs(file_cache, *, require_missing_cover=False, cover_cache=None, logger=None)` owns aggregation and per-call decision memoization.
- `music_app/services/cover_refresh_runtime.py`: `start_manual_cover_refresh`, `start_manual_cover_refresh_request`, `build_manual_cover_refresh_runner`, `run_manual_cover_refresh_worker`, `refresh_unsuccessful_cover_artwork_request` form the manual chain. Existing `CoverRefreshContext` owns state, file snapshot, separate release keys, cache instance, image extensions, user agent and generations.
- `music_app/services/state.py`: `refresh_unsuccessful_cover_artwork_for_state` and the manual-start callback in the runtime builder must forward the optional prepared request.
- `music_app/routes/api_wave_d_asgi_routes.py`: the manual-cover callback currently accepts only `force_search`; add explicit internal prepared forwarding without changing HTTP arguments/responses.
- Tests: `tests/py/test_cover_refresh_planning.py`, `tests/py/test_cover_refresh_runtime.py`, existing state/route tests for changed callbacks and existing cancellation/ownership regressions. Locate exact wrapper coverage with `rg -n 'start_manual_cover_refresh|refresh_unsuccessful_cover_artwork' music_app tests/py` before edits.

## Task 1 — PREP-1: normalize once and remove the duplicate existence probe

**Interfaces:** planner signature and job dictionaries remain unchanged. Continue using `cover_query_key(artist, album, edition, year)` and `local_cover_requires_upgrade_check(path, cached)`.

- [ ] Separate test author extends `test_build_cover_refresh_jobs_checks_shared_cover_and_lookup_once` with a normalization spy; identical tracks normalize once. Extend `test_build_cover_refresh_jobs_rechecks_when_album_query_identity_changes` to require two normalizations when year appears on the second track. Add different-cover/same-query and same-cover/different-query cases.

```python
original = cover_refresh_planning.cover_query_key
identities = []
def counted_key(*identity):
    identities.append(identity)
    return original(*identity)
monkeypatch.setattr(cover_refresh_planning, "cover_query_key", counted_key)
# After planning the existing shared-identity fixture:
assert len(identities) == 1
```

- [ ] Add real-helper fixtures for missing, corrupt, disappearing, undersized in one dimension and adequate images. Count `Path.exists` calls only for the fixture cover: one per shared decision. Preserve current image-dimension caching. Keep existing later-missing-track and user-origin aggregation assertions.
- [ ] Run `rtk python -m pytest tests/py/test_cover_refresh_planning.py -q --tb=short` with the verified feature interpreter; require RED for repeated normalization/probe count rather than fixture failure.
- [ ] Add one raw-identity-to-normalized-key dictionary local to the planner. Form the tuple after each track contributes metadata; retain existing `(cover_value, cache_key)` decision memoization. Do not collapse all tracks onto final folder metadata or skip aggregation once queued.

```python
query_keys: dict[tuple[str, str, str | None, int | None], str] = {}
# When a cache, artist and album are available:
identity = (
    str(job.get("artist") or "").strip(),
    str(job.get("album") or "").strip(),
    str(job.get("edition") or "").strip() or None,
    job.get("year") if isinstance(job.get("year"), int) else None,
)
if identity not in query_keys:
    query_keys[identity] = cover_query_key(*identity)
cache_key = query_keys[identity]
# Replace the existing caller-side exists() expression on decision miss:
cover_needs_fetch[decision_key] = local_cover_requires_upgrade_check(cover_path, cache_entry)
```

- [ ] Rerun the focused planner file and require GREEN. Review full task diff. Record results; commit only at the orchestrator-approved cohesive delivery checkpoint, not by staging the whole accumulated branch.

## Task 2 — PREP-2: carry the prepared request through execution

**Interfaces:** use an optional internal `prepared` value containing the existing context plus jobs. No global or state-dictionary plan cache. Add the same keyword to manual request/runner/state callbacks and update the two explicit state/ASGI closures together.

```python
PreparedCoverRefresh = tuple[CoverRefreshContext, list[dict[str, object]]]
# Internal signature addition:
prepared: PreparedCoverRefresh | None = None
# Callback forwarding:
refresh_unsuccessful_cover_artwork(force_search=force_search, prepared=prepared)
```

- [ ] Separate test author adds trigger-to-captured-callback integration: exactly one planner invocation, queue count/first folder agree with ordered executed jobs, track membership/user ownership preserved, force flag and configured worker count unchanged.

```python
submitted = []
def submit(callback, *args, **kwargs):
    submitted.append((callback, args, kwargs))
# Invoke the real manual-start chain with existing runtime fixtures.
callback, args, kwargs = submitted.pop()
callback(*args, **kwargs)
assert planning_calls == 1
assert executed_jobs == queued_jobs
```

- [ ] Add standalone/no-prepared test: one plan and existing generation advance. Add cancellation between submit and callback: no provider call, no generation rebasing and no restored active flag. Cover stale scan generation, a newer request's progress, empty prepared jobs, submission failure, already-running and queued-after-indexing guards.
- [ ] Run `rtk python -m pytest tests/py/test_cover_refresh_runtime.py -q --tb=short`; require RED for duplicate preparation/missing propagation.
- [ ] Capture the supplied file-cache snapshot once at the indexed/manual trigger boundary. Use that exact snapshot and the same `CoverSearchCache` instance for planning and `CoverRefreshContext`. Preserve early busy/indexing guards. Reserve one cover generation for this request and capture it; do not resnapshot after planning.
- [ ] Submit the manual worker with `prepared=(context, jobs)`. Forward through `build_manual_cover_refresh_runner`, `run_manual_cover_refresh_worker`, `refresh_unsuccessful_cover_artwork_for_state`, and explicit state/ASGI callback closures. Internal callback annotations/tests change together; public route contract does not.
- [ ] Keep the original context creation and bulk selection only when `prepared is None`. For prepared work, unpack and reject stale state/generations before resetting progress. Never increment its generation again or replace it with the current generation.

```python
if prepared is None:
    context = build_cover_refresh_context(
        get_state=get_state, config=config, bump_cover_generation=True,
    )
    jobs = select_manual_bulk_cover_refresh_jobs(
        file_cache=context.file_cache, cover_cache=context.cover_cache,
        build_cover_jobs=lambda current_file_cache, **kwargs: build_cover_jobs(
            current_file_cache, logger=logger, **kwargs,
        ),
        logger=logger, force_search=force_search,
    )
else:
    context, jobs = prepared
    current = get_state()
    same_request = (
        current is context.library_state
        and int(current.get("cover_generation") or 0) == context.cover_generation
    )
    stale = (
        not same_request
        or int(current.get("scan_generation") or 0) != context.scan_generation
        or bool(current.get("scan_in_progress"))
    )
    if stale:
        if same_request:
            _reset_cover_refresh_progress(current, in_progress=False)
        return _empty_cover_refresh_result(include_job_results=True)
# Existing execute_cover_refresh_request remains the execution owner.
```

- [ ] Retain execution-time generation/ownership checks; the initial guard does not replace them. Audit error and submission cleanup so an old request cannot clear newer progress. Do not change background/single-album entrypoints or add concurrency.
- [ ] Run planner/runtime and touched wrapper/route regressions sequentially, followed by existing cancellation/user-owned-cover selections. Require GREEN; record exact selections/results.
- [ ] Review the entire relevant diff at least twice under repository rules; fix validated findings and repeat. Commit only after the orchestrator confirms safe unit boundaries; suggested coherent-unit message `perf: reuse cover preparation work`.

## Task 3 — PREP-3: generated-input measurements and handoff

**Files:** use an isolated temporary benchmark script, not production fixtures; record results in this document. No benchmark code is added to runtime.

- [ ] Before implementation, preserve baseline source/revision for isolated measurement without resetting or checking out user files. Run baseline and changed versions in separate interpreter processes with identical inputs and dependencies.
- [ ] Generate 10,000 folders × 12 tracks in memory. Stub cache lookup and upgrade decisions for the CPU comparison. Also compare fixtures where the last track adds year and where the last track lacks a cover.

```python
file_cache = {
    f"generated/artist/album-{album}/track-{track}.mp3": {
        "album_artist": "Generated Artist", "album": f"Album {album}",
        "cover_path": f"generated/artist/album-{album}/cover.jpg",
    }
    for album in range(10000)
    for track in range(12)
}
```

- [ ] Instrument normalization, cache lookup, upgrade decision and planning-call counts. Use `time.perf_counter`: one warm-up plus five samples per revision; record samples, median, OS/Python/source revisions and fixture sizes. Compare complete ordered job outputs. Runtime comparison uses a captured submission callback and stub executor, never a provider/network call.
- [ ] If filesystem cost is measured, use generated small images in an isolated temporary directory and label results warm local synthetic files. Record exists/dimensions counts. Do not infer cold-library throughput from warm results or promise reduction of the observed 987.906-second preparation.
- [ ] Acceptance: one manual planning pass; one normalization per distinct effective identity; no duplicate caller stat; semantic and stale-generation regressions green. Report actual timing even if wall-time benefit is small; no flaky CI timing threshold.
- [ ] Record focused commands/results, process exit evidence, benchmark results, full-diff review outcomes and remaining release gates. Hand off without merging, redeploying or starting covers. Live measurement requires separate owner coordination after the active pass.

## Self-review

PREP-1 covers normalization/probe ownership and image/aggregation semantics; PREP-2 covers request reuse, standalone compatibility, cancellation and cleanup; PREP-3 covers generated measurements and evidence. Prepared context is request-scoped. No concurrency, schema, cache authority or live-operation scope was added. This document does not start implementation.
