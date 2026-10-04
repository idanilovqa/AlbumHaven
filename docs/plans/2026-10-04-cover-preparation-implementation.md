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

## October 4 synthetic preparation measurement

Baseline: `cb35c5b28c708a163d061d399cc2abc155bbf4f5`; changed source: uncommitted preparation implementation on that baseline.
Windows 10 build 26200; Python 3.11.16, MSC v.1942 AMD64.

Each revision ran in a separate process, sequentially. Each scenario generated 10,000 folders with 12 tracks per folder (120,000 tracks), warmed up once, then recorded five samples. Provider/cache lookups and upgrade decisions used in-memory stubs; caller existence checks returned true without filesystem access. This measures warm synthetic CPU work, not cold media storage or production throughput. Host timing noise affects elapsed comparisons.

| Scenario | Baseline samples (seconds) | Changed samples (seconds) | Median before → after |
| --- | --- | --- | --- |
| shared_identity | 19.140476, 24.934293, 24.490248, 19.601963, 19.380434 | 6.970272, 6.502923, 7.137380, 7.477881, 5.556806 | 19.601963 → 6.970272 |
| late_year | 11.562452, 14.152394, 13.970636, 12.237863, 13.866212 | 6.666479, 8.040163, 7.124316, 6.050466, 8.443758 | 13.866212 → 7.124316 |
| late_missing | 10.086752, 7.605973, 13.225422, 12.793655, 12.511724 | 6.033998, 5.264902, 6.039404, 6.072593, 4.644495 | 12.511724 → 6.033998 |

Normalization calls fell from 120,000 to 10,000 for shared identities, 120,000 to 20,000 when the last track adds a year, and 110,000 to 10,000 when the last track lacks a cover. Upgrade decisions and cache lookups remained 10,000 / 20,000 / 10,000. Redundant caller-side existence checks fell from those same counts to zero; the stub excluded the helper's own filesystem work.

Each scenario returned 10,000 jobs. Full ordered-job serialization hashes matched before and after:

- Shared identity and late missing: `b9d780312ea2d792b6ee4668710fb3a02539136e7e26f88b903fc994ba227002`.
- Late year: `8f7e3bbd74a6a5aa3fe273ee7a51aa69bdae662e915c477b45f7487ff9ac174b`.

A separate generated one-album captured-callback run exercised the actual manual orchestration with a stub executor: planning calls 2 → 1, lookup-cache instances 2 → 1, supplied snapshots 1 → 1, executions 1 → 1, and final cover generation 2 → 1. It performed no provider work.

All four commands exited 0; the observed benchmark launcher/child PIDs exited. Scripts and full JSON evidence remain locally under `.tmp/benchmark_cover_preparation.py`, `.tmp/benchmark_cover_submission.py`, and `.tmp/cover-preparation-benchmark-20261004.json`.

Measured source SHA-256:
- Planner: `D320D3B12196B98E87C97ADFA4A555114566002C098B0EDDE7F5F9D739DF857F`.
- Runtime: `4695E01532AAB9E4E6DCFDA61BB8F6D3131689E2FE298938B79FDBDF100BA044`.

These measurements do not close review, concurrency-safety, manual acceptance, E2E, CI or release gates. A later reservation/progress locking correction requires focused verification; no live preparation-time reduction has been measured.

## October 4 focused verification after reservation locking

The first test-author run established 10 failures, 3 passes and 19 deselections
in 1.87 seconds: repeated normalization, duplicate caller probes and duplicate
manual preparation. The review's reservation/start-progress race tests then
established 3 failures and 1 pass. Implementation now uses the existing cache
lock for manual reservation, prepared validation plus progress startup, owned
error cleanup, API cancellation and shutdown cancellation. Provider and database
work remain outside that critical section.

- [x] PREP-1 implemented and focused planner regressions pass.
- [x] PREP-2 implemented; normal, competing-start, stale-generation, cancellation,
  standalone and focused callback-forwarding cases pass.
- [x] PREP-3 synthetic samples, operation counts and ordered-output checks recorded.
- [x] Verify explicit empty-prepared and planning/submission-error cleanup cases,
  including preservation of a newer generation's progress.
- [x] Independent complete-diff review and root confirmation of the final checkpoint.

Latest sequential commands used the sandbox3 virtualenv interpreter without
loading sandbox configuration or accessing live data:

```powershell
python -m pytest tests/py/test_cover_refresh_planning.py tests/py/test_cover_refresh_runtime.py -q --tb=short
```

Result: 35 passed in 2.01 seconds, exit 0.

```powershell
python -m pytest tests/py/test_state.py::test_refresh_unsuccessful_cover_artwork_for_state_uses_explicit_dependencies_without_flask_context tests/py/test_state.py::test_refresh_unsuccessful_cover_artwork_for_state_uses_configured_bulk_cover_limits tests/py/test_state.py::test_refresh_library_for_state_threads_explicit_manual_cover_refresh_dependencies tests/py/test_state.py::test_refresh_library_for_state_runs_without_flask_context tests/py/test_api_wave_d_asgi_routes.py::test_asgi_cover_refresh_routes_preserve_manual_payloads_and_cancel_status tests/py/test_runtime_shutdown.py -k 'refresh_unsuccessful_cover_artwork_for_state or refresh_library_for_state_threads_explicit or refresh_library_for_state_runs_without or asgi_cover_refresh_routes_preserve or request_runtime_shutdown' -q --tb=short
```

Result: 10 passed, 14 deselected in 4.88 seconds, exit 0. Neither command reported
warnings; both exited before the pytest lane was released. The implementation
owner reread the complete preparation diff; this self-review does not replace
the independent review checkpoint. Terminal execution progress ownership belongs
to the adjacent recovery unit and needs its separate test evidence. The benchmark
above predates the locking correction; its source hashes identify that measurement.

Five additional isolated runtime cases passed (5 passed, 21 deselected in 0.78
seconds): planning and submission failures with the same or a newer generation,
and direct execution of an empty prepared request. The test author released the
pytest lane afterward. The root reviewer reread the complete preparation source
and tests after the reservation-lock correction and reported no new finding;
final overall verification and the recorded delivery/release gates remain open.

## Final independent commit checkpoint

Subsequent fresh root verification passed 40 planner/runtime tests in 2.28
seconds, and 10 state/API/shutdown tests with 152 unrelated cases deselected in
4.12 seconds. Both commands exited 0, sequentially, and the pytest lane was
released. Iterative root and independent complete relevant-diff review found no
remaining actionable findings. The independent review checkbox above is now
complete; earlier detailed task instructions remain historical, not a second
progress counter. No numeric progress counter is maintained here.

Changed files (10):

- `music_app/services/cover_refresh_planning.py`
- `music_app/services/cover_refresh_runtime.py`
- `music_app/services/state.py`
- `music_app/services/runtime_shutdown.py`
- `music_app/routes/api_wave_d_asgi_routes.py`
- `tests/py/test_cover_refresh_planning.py`
- `tests/py/test_cover_refresh_runtime.py`
- `tests/py/test_runtime_shutdown.py`
- `tests/py/test_api_wave_d_asgi_routes.py`
- `docs/plans/2026-10-04-cover-preparation-implementation.md`

Direct task time, skill/process overhead and total slice elapsed time were not
fully captured and remain unknown. Synthetic measurements above remain scoped
to their recorded source hashes; final live preparation throughput is unverified.
Manual acceptance, E2E, hosted CI, live verification and release gates remain
open. No active-pass inspection, deployment, restart or new scan was performed
for this checkpoint.
