from __future__ import annotations

from collections.abc import Callable, Mapping
from concurrent.futures import TimeoutError as FutureTimeoutError
from contextvars import ContextVar
from dataclasses import replace
from datetime import datetime, timezone
import inspect
from types import MethodType
import os
from pathlib import Path
from threading import Event, Lock
import time
import uuid

from music_app.services import cover_provider_matching
from music_app.services.album_cover_candidate_publisher import AlbumCoverCandidatePublisher
from music_app.services.album_cover_candidate_snapshots_postgres import (
    AlbumCoverCandidateSnapshotRepository,
)
from music_app.services.app_logging import log_app_event
from music_app.services.runtime_shutdown import create_daemon_executor
from music_app.services.cover_lookup_jobs import CoverLookupRuntimeJob, build_cover_lookup_job_contract
from music_app.services.cover_lookup_tasks import (
    cover_lookup_result,
    create_cover_lookup_task,
    discard_cover_lookup_future,
    finalize_cover_lookup_task_canceled,
    register_cover_lookup_future,
    request_cover_lookup_task_stop,
    update_cover_lookup_task,
)
from music_app.services.cover_provider_candidates import (
    SelectedRemoteImage,
    normalize_remote_image_url,
    selected_remote_image_from_lookup_match,
)
from music_app.services.cover_provider_deadline import (
    cover_lookup_provider_deadline_at as build_cover_lookup_provider_deadline_at,
    cover_lookup_provider_deadline_reached,
)
from music_app.services.cover_provider_registry import (
    COVER_LOOKUP_PROVIDER_REGISTRY,
    CoverLookupProviderQuery,
)
from music_app.services.cover_remote_image_downloads import fetch_remote_image
from music_app.services.cache import execute_cover_mutation_for_config
from music_app.services.cover_mutation_coordinator import (
    CommitOutcomeUnknown,
    CoverArtifactIdentity,
    CoverMutationOutcome,
    CoverMutationStatus,
)
from music_app.services.cover_workflow import (
    begin_prepared_remote_cover_promotion,
    complete_local_image_promotion,
    decode_image_bytes,
    download_remote_cover_to_folder,
    prepare_cover_reservation,
    prepare_remote_cover_bytes_for_authoritative_write,
    resolve_album_root_from_track_paths,
    rollback_local_image_promotion,
)


_COVER_LOOKUP_EXECUTOR = create_daemon_executor(max_workers=4, thread_name_prefix="albumhaven-cover-lookup")
_COVER_LOOKUP_PROVIDER_EXECUTOR = create_daemon_executor(
    max_workers=4,
    thread_name_prefix="albumhaven-cover-provider",
)
_COVER_LOOKUP_BANDCAMP_EXECUTOR = create_daemon_executor(
    max_workers=4,
    thread_name_prefix="albumhaven-cover-bandcamp",
)
_CANDIDATE_LOOKUP_JOB_CONTRACT = build_cover_lookup_job_contract("candidate_lookup")
_RUNTIME_PHASE_NAMES = ("discovery", "fetch", "scoring", "persistence")
_CLAIMED_LOOKUP_PUBLISHER: ContextVar[Callable[..., bool] | None] = ContextVar(
    "claimed_cover_lookup_publisher", default=None
)


def _new_runtime_phase_metrics() -> tuple[dict[str, float], dict[str, int]]:
    return (
        {phase_name: 0.0 for phase_name in _RUNTIME_PHASE_NAMES},
        {phase_name: 0 for phase_name in _RUNTIME_PHASE_NAMES},
    )


def _runtime_phase_metrics_for_task(task_id: str) -> tuple[dict[str, float], dict[str, int]]:
    timings, counts = _new_runtime_phase_metrics()
    task = cover_lookup_result(task_id)
    stored_timings = task.get("phase_timings_ms") if isinstance(task, dict) else None
    stored_counts = task.get("phase_counts") if isinstance(task, dict) else None
    for phase_name in _RUNTIME_PHASE_NAMES:
        try:
            timings[phase_name] = max(
                0.0,
                float(stored_timings.get(phase_name) or 0.0) if isinstance(stored_timings, dict) else 0.0,
            )
        except (TypeError, ValueError):
            timings[phase_name] = 0.0
        try:
            counts[phase_name] = max(
                0,
                int(stored_counts.get(phase_name) or 0) if isinstance(stored_counts, dict) else 0,
            )
        except (TypeError, ValueError):
            counts[phase_name] = 0
    return timings, counts


def _record_runtime_phase(
    timings: dict[str, float],
    counts: dict[str, int],
    phase_name: str,
    started: float,
    *,
    count: int = 0,
) -> None:
    timings[phase_name] = timings.get(phase_name, 0.0) + max(
        0.0,
        (time.perf_counter() - started) * 1000,
    )
    counts[phase_name] = counts.get(phase_name, 0) + max(0, int(count))


def _runtime_phase_payload(
    timings: dict[str, float],
    counts: dict[str, int],
) -> dict[str, dict[str, float] | dict[str, int]]:
    return {
        "phase_timings_ms": {
            phase_name: round(max(0.0, float(timings.get(phase_name, 0.0))), 2)
            for phase_name in _RUNTIME_PHASE_NAMES
        },
        "phase_counts": {
            phase_name: max(0, int(counts.get(phase_name, 0)))
            for phase_name in _RUNTIME_PHASE_NAMES
        },
    }


def _publish_candidate_runtime_phase_metrics(
    task_id: str,
    *,
    config: Mapping[str, object],
    timings: dict[str, float],
    counts: dict[str, int],
) -> None:
    if _CLAIMED_LOOKUP_PUBLISHER.get() is None and not cover_lookup_result(task_id):
        return
    _update_candidate_lookup_task(
        task_id,
        config=config,
        **_runtime_phase_payload(timings, counts),
    )


def _publish_save_runtime_phase_metrics(
    task_id: str,
    *,
    config: Mapping[str, object],
    timings: dict[str, float],
    counts: dict[str, int],
) -> None:
    if not cover_lookup_result(task_id):
        return
    update_cover_lookup_task(
        task_id,
        config=config,
        **_runtime_phase_payload(timings, counts),
    )


def _update_candidate_lookup_task(
    task_id: str,
    *,
    config: Mapping[str, object] | None = None,
    **changes,
) -> None:
    if "possible_matches" in changes:
        changes["candidate_updated_at"] = datetime.now(timezone.utc).isoformat()
    claimed_publisher = _CLAIMED_LOOKUP_PUBLISHER.get()
    if claimed_publisher is not None:
        claimed_publisher(
            job_contract=_CANDIDATE_LOOKUP_JOB_CONTRACT,
            **changes,
        )
        return
    update_cover_lookup_task(
        task_id,
        config=config,
        job_contract=_CANDIDATE_LOOKUP_JOB_CONTRACT,
        **changes,
    )


def _path_key(path: Path | object) -> str:
    return os.path.normcase(str(Path(str(path)).resolve(strict=False)))


def _validated_remote_selection_album_root(
    config: dict[str, object],
    album_root,
    requested_track_paths: set[str],
) -> Path | None:
    resolved_album_root = resolve_album_root_from_track_paths(config, requested_track_paths)
    if resolved_album_root is None:
        return None
    if _path_key(resolved_album_root) != _path_key(album_root):
        return None
    return resolved_album_root


def merge_lookup_matches(
    existing: list[dict[str, object]] | None,
    incoming: list[dict[str, object]] | None,
) -> list[dict[str, object]]:
    merged: list[dict[str, object]] = []
    seen: set[str] = set()
    for item in [*(existing or []), *(incoming or [])]:
        if not isinstance(item, dict):
            continue
        key = str(item.get("id") or item.get("url") or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


def _lookup_match_is_acceptable(match: dict[str, object]) -> bool:
    try:
        candidate = selected_remote_image_from_lookup_match(match)
    except (TypeError, ValueError):
        return False
    return cover_provider_matching.cover_candidate_is_acceptable(candidate)


def queue_cover_lookup_task(
    album: dict[str, object],
    requested_track_paths: set[str],
    manual_urls: list[str] | None = None,
    *,
    config: Mapping[str, object],
    logger,
    user_agent: str | None = None,
    prepare: Callable[
        [dict[str, object], set[str], Event],
        tuple[dict[str, object], set[str]],
    ]
    | None = None,
) -> str:
    task_id, cancel_event = create_cover_lookup_task(album, requested_track_paths, manual_urls)
    resolved_user_agent = str(user_agent or config["MUSICBRAINZ_USER_AGENT"])
    runtime_job = CoverLookupRuntimeJob(
        task_id,
        config,
        logger,
        resolved_user_agent,
        album,
        requested_track_paths,
        cancel_event,
        manual_urls,
        build_cover_lookup_job_contract("candidate_lookup"),
    )
    future = _COVER_LOOKUP_EXECUTOR.submit(
        _run_prepared_cover_lookup_job if prepare is not None else _run_cover_lookup_job,
        runtime_job,
        *([prepare] if prepare is not None else []),
    )
    register_cover_lookup_future(task_id, future, config=config)
    return task_id


def queue_cover_lookup_save_remote_task(
    task_id: str,
    album_root,
    requested_track_paths: set[str],
    candidate_id: str,
    selected_match: dict[str, object],
    *,
    config: Mapping[str, object],
    logger,
    library_state: dict[str, object],
    user_agent: str | None = None,
    cover_selection_origin: str = "user",
    apply_cover_selection_for_tracks,
    persist_cover_selection_for_tracks=None,
) -> None:
    resolved_user_agent = str(user_agent or config["MUSICBRAINZ_USER_AGENT"])
    future = _COVER_LOOKUP_EXECUTOR.submit(
        _run_cover_lookup_save_remote_task,
        task_id,
        config,
        logger,
        library_state,
        resolved_user_agent,
        album_root,
        requested_track_paths,
        candidate_id,
        selected_remote_image_from_lookup_match(selected_match),
        cover_selection_origin=cover_selection_origin,
        apply_cover_selection_for_tracks=apply_cover_selection_for_tracks,
        persist_cover_selection_for_tracks=persist_cover_selection_for_tracks,
    )
    register_cover_lookup_future(task_id, future, config=config)


def run_claimed_cover_remote_save(
    *,
    scope,
    config: Mapping[str, object],
    logger,
    should_cancel: Callable[[], bool],
    checkpoint: Callable[..., int | None],
    persist_selection: Callable[..., int | None],
    publish: Callable[..., bool],
    library_id: int | None = None,
    job_id: int | None = None,
    attempt: int | None = None,
    worker_id: str | None = None,
    lease_token: str | None = None,
    task_id: int | None = None,
    checkpoint_revision: int | None = None,
) -> dict[str, object]:
    """Execute one claimed remote selection with conservative crash recovery."""

    del logger
    album_root = Path(scope.library_root_path)
    track_paths = {str(path) for path in scope.track_paths}
    try:
        common_parent = Path(os.path.commonpath([str(Path(path).parent) for path in track_paths]))
    except (ValueError, TypeError):
        return {"status": "failed", "reason_code": "album_scope_invalid"}
    if not track_paths or common_parent.resolve(strict=False) != album_root.resolve(strict=False):
        return {"status": "failed", "reason_code": "album_scope_invalid"}
    selected_image = selected_remote_image_from_lookup_match(
        dict(scope.selected_candidate)
    )
    if should_cancel():
        return {"status": "canceled", "reason_code": "canceled_before_download"}

    remote_cover = {
        "remote_cover_url": selected_image.url,
        "remote_cover_thumbnail_url": selected_image.thumbnail_url or selected_image.url,
        "remote_cover_source": selected_image.source,
        "remote_cover_source_label": selected_image.source_label,
        "remote_cover_album_url": selected_image.album_url,
        "remote_cover_width": selected_image.width,
        "remote_cover_height": selected_image.height,
    }
    mutation: dict[str, object] = {}

    def prepare(_request, _baseline):
        if selected_image.display_only:
            return selected_image.url.encode("utf-8")
        revision = checkpoint("download_started")
        if revision is None:
            mutation["failure"] = ("ambiguous", "download_checkpoint_lost")
            raise RuntimeError("durable download checkpoint was lost")
        if should_cancel():
            mutation["failure"] = ("canceled", "canceled_before_fetch")
            raise RuntimeError("durable cover save was canceled")
        raw_bytes, _mime_type = fetch_remote_cover_bytes(
            selected_image.url,
            config=config,
        )
        if not raw_bytes:
            mutation["failure"] = ("failed", "download_failed")
            raise RuntimeError("remote cover download failed")
        prepared = prepare_remote_cover_bytes_for_authoritative_write(raw_bytes)
        if prepared is None:
            mutation["failure"] = ("failed", "image_validation_failed")
            raise RuntimeError("remote cover image validation failed")
        decoded = decode_image_bytes(prepared)
        if decoded is None:
            raise RuntimeError("prepared cover image validation failed")
        image, width, height = decoded
        try:
            mutation["local_dimensions"] = (width, height)
        finally:
            image.close()
        mutation["reservation"] = prepare_cover_reservation(album_root, prepared)
        return prepared

    def write_artifact(prepared, _baseline):
        if selected_image.display_only:
            return CoverArtifactIdentity(
                private_path=None,
                sha256=None,
                post_write_exists=False,
                selected_cover_path=None,
                promoted_cover_revision=None,
                prior_cover_existed=False,
                prior_cover_bytes=None,
            )
        promotion = begin_prepared_remote_cover_promotion(
            album_root,
            prepared,
            reservation=mutation.get("reservation"),
            serialize_selection=False,
        )
        if promotion is None:
            raise RuntimeError("remote cover image validation failed")
        mutation["promotion"] = promotion
        width, height = mutation["local_dimensions"]
        return CoverArtifactIdentity(
            private_path=promotion.cover_path,
            sha256=promotion.promoted_cover_revision,
            post_write_exists=True,
            selected_cover_path=str(promotion.cover_path),
            promoted_cover_revision=promotion.promoted_cover_revision,
            prior_cover_existed=promotion.prior_cover_existed,
            prior_cover_bytes=promotion.prior_cover_bytes,
            local_cover_width=width,
            local_cover_height=height,
        )

    def prepare_commit(artifact) -> int:
        revision = checkpoint(
            "artifact_written",
            artifact_sha256=artifact.sha256,
            cover_revision=artifact.promoted_cover_revision,
        )
        if revision is None:
            mutation["failure"] = ("ambiguous", "artifact_checkpoint_lost")
            raise RuntimeError("durable artifact checkpoint was lost")
        return revision

    def commit_selection(request) -> CoverMutationOutcome:
        revision = persist_selection(
            expected_checkpoint_revision=request.checkpoint_revision,
            selected_cover_path=request.selected_cover_path,
            selected_cover_revision=request.promoted_cover_revision,
            linked_remote=selected_image.display_only,
            local_cover_width=request.local_cover_width,
            local_cover_height=request.local_cover_height,
            expected_library_id=request.identity.library_id,
            expected_album_id=request.identity.local_album_id,
            expected_inventory_revision=request.expected_inventory_revision,
            expected_cover_mutation_revision=request.expected_cover_mutation_revision,
            track_paths=request.track_paths,
        )
        promotion = mutation.get("promotion")
        if promotion is not None:
            complete_local_image_promotion(promotion)
        if revision is None:
            raise CommitOutcomeUnknown("claimed selection commit was not confirmed")
        mutation["committed"] = True
        revision = checkpoint("promotion_completed")
        if revision is None:
            mutation["failure"] = ("ambiguous", "promotion_checkpoint_lost")
            raise CommitOutcomeUnknown("claimed promotion checkpoint was not confirmed")
        return CoverMutationOutcome(
            status=CoverMutationStatus.COMMITTED,
            finalization_checkpoint_revision=revision,
        )

    def recover_selection(_request, _artifact) -> CoverMutationOutcome:
        return CoverMutationOutcome(status=CoverMutationStatus.AMBIGUOUS)

    def publish_committed(outcome, artifact) -> None:
        if not publish(
            expected_checkpoint_revision=outcome.finalization_checkpoint_revision,
            selected_cover_path=artifact.selected_cover_path,
            linked_remote=selected_image.display_only,
        ):
            raise RuntimeError("durable cover publication was not confirmed")

    def compensate_artifact(_artifact) -> None:
        promotion = mutation.get("promotion")
        if promotion is not None:
            rollback_local_image_promotion(promotion)

    try:
        outcome = execute_cover_mutation_for_config(
            dict(config),
            library_id=library_id,
            track_paths=track_paths,
            album_root=album_root,
            selected_origin="user",
            clear_selection=False,
            remote_cover=remote_cover if selected_image.display_only else None,
            prepare=prepare,
            cleanup_prepared=lambda _prepared: None,
            write_artifact=write_artifact,
            prepare_commit=prepare_commit,
            commit_selection=commit_selection,
            recover_selection=recover_selection,
            compensate_artifact=compensate_artifact,
            publish_committed=publish_committed,
            should_cancel=should_cancel,
            job_id=job_id,
            attempt=attempt,
            worker_id=worker_id,
            lease_token=lease_token,
            task_id=task_id,
            checkpoint_revision=checkpoint_revision,
        )
    except Exception:
        failure = mutation.get("failure")
        if isinstance(failure, tuple):
            return {"status": failure[0], "reason_code": failure[1]}
        return {
            "status": "ambiguous" if mutation.get("committed") else "failed",
            "reason_code": (
                "publication_uncertain" if mutation.get("committed") else "selection_commit_uncertain"
            ),
        }
    if outcome.status is CoverMutationStatus.CANCELED:
        return {
            "status": "canceled",
            "reason_code": (
                "canceled_before_commit"
                if mutation.get("promotion") is not None
                else "canceled_before_promotion"
            ),
        }
    if outcome.status is CoverMutationStatus.AMBIGUOUS:
        failure = mutation.get("failure")
        if isinstance(failure, tuple):
            return {"status": failure[0], "reason_code": failure[1]}
        return {"status": "ambiguous", "reason_code": "selection_commit_uncertain"}
    return {"status": "succeeded"}


def _run_cover_lookup_job(runtime_job: CoverLookupRuntimeJob) -> None:
    provider_deadline_at = build_cover_lookup_provider_deadline_at(runtime_job.config)
    _run_cover_lookup_task(
        runtime_job.task_id,
        runtime_job.config,
        runtime_job.logger,
        runtime_job.user_agent,
        runtime_job.album,
        runtime_job.requested_track_paths,
        runtime_job.cancel_event,
        runtime_job.manual_urls,
        provider_deadline_at=provider_deadline_at,
    )


def _run_prepared_cover_lookup_job(
    runtime_job: CoverLookupRuntimeJob,
    prepare: Callable[
        [dict[str, object], set[str], Event],
        tuple[dict[str, object], set[str]],
    ],
) -> None:
    try:
        album, track_paths = prepare(
            runtime_job.album,
            runtime_job.requested_track_paths,
            runtime_job.cancel_event,
        )
    except Exception as exc:
        log_app_event(
            runtime_job.config,
            runtime_job.logger,
            "Cover lookup preparation failed",
            level="error",
            task_id=runtime_job.task_id,
            error=str(exc),
        )
        _update_candidate_lookup_task(
            runtime_job.task_id,
            config=runtime_job.config,
            status="failed",
            progress=100,
            progress_label="Failed",
            finished_at=datetime.now(timezone.utc).isoformat(),
            message=str(exc),
        )
        return
    if runtime_job.cancel_event.is_set():
        return
    _update_candidate_lookup_task(
        runtime_job.task_id,
        config=runtime_job.config,
        artist=str(album.get("album_artist") or ""),
        album=str(album.get("name") or album.get("album") or ""),
        year=album.get("year"),
        album_payload=album,
        track_paths=sorted(track_paths),
    )
    _run_cover_lookup_job(
        replace(
            runtime_job,
            album=album,
            requested_track_paths=track_paths,
        )
    )


def fetch_remote_cover_bytes(
    image_url: str,
    *,
    config: Mapping[str, object] | None = None,
    user_agent: str | None = None,
) -> tuple[bytes | None, str | None]:
    normalized_url = normalize_remote_image_url(image_url)
    resolved_user_agent = user_agent
    if resolved_user_agent is None and config is not None:
        resolved_user_agent = str(config["MUSICBRAINZ_USER_AGENT"])
    if resolved_user_agent is None:
        raise ValueError("fetch_remote_cover_bytes requires explicit config or user_agent")
    result = fetch_remote_image(
        normalized_url,
        user_agent=resolved_user_agent,
        service="manual-remote",
        context=f"remote-image:{normalized_url}",
    )
    return result.payload, result.mime_type


def _callback_accepts_parameter(callback, parameter_name: str) -> bool:
    try:
        signature = inspect.signature(callback)
    except (TypeError, ValueError):
        return False
    return parameter_name in signature.parameters


def _provider_call_kwargs(
    callback,
    *,
    cancel_event: Event,
    deadline_at: float,
) -> dict[str, object]:
    kwargs: dict[str, object] = {}
    if _callback_accepts_parameter(callback, "should_cancel"):
        def should_cancel(event: Event) -> bool:
            return event.is_set() or cover_lookup_provider_deadline_reached(deadline_at)

        kwargs["should_cancel"] = MethodType(should_cancel, cancel_event)
    if _callback_accepts_parameter(callback, "deadline_at"):
        kwargs["deadline_at"] = deadline_at
    return kwargs


def _terminalize_canceled_cover_lookup_task(
    task_id: str,
    *,
    config: Mapping[str, object],
    candidate_publisher: object | None,
    candidate_snapshot_published: bool,
) -> None:
    if candidate_publisher is not None and candidate_snapshot_published:
        try:
            candidate_publisher.fail()
        except Exception:
            pass
    claimed_publisher = _CLAIMED_LOOKUP_PUBLISHER.get()
    if claimed_publisher is not None:
        claimed_publisher(
            cancel_requested=True,
            status="canceled",
            progress=100,
            progress_label="Canceled",
            finished_at=datetime.now(timezone.utc).isoformat(),
            message="Cover art lookup canceled.",
            job_contract=_CANDIDATE_LOOKUP_JOB_CONTRACT,
        )
    else:
        finalize_cover_lookup_task_canceled(task_id, config=config)


class _ClaimedLookupCancelSignal:
    def __init__(self, should_cancel: Callable[[], bool]) -> None:
        self._should_cancel = should_cancel

    def is_set(self) -> bool:
        return bool(self._should_cancel())


def run_claimed_cover_lookup(
    *,
    task_id: str,
    config: Mapping[str, object],
    logger: object,
    user_agent: str,
    album: dict[str, object],
    track_paths: set[str],
    manual_urls: list[str],
    provider_deadline_at: float,
    should_cancel: Callable[[], bool],
    publish: Callable[..., bool],
) -> None:
    """Run the existing provider pipeline inside one durable claim boundary."""

    token = _CLAIMED_LOOKUP_PUBLISHER.set(publish)
    try:
        _run_cover_lookup_task(
            task_id,
            config,
            logger,
            user_agent,
            album,
            track_paths,
            _ClaimedLookupCancelSignal(should_cancel),
            manual_urls,
            provider_deadline_at=provider_deadline_at,
        )
    finally:
        _CLAIMED_LOOKUP_PUBLISHER.reset(token)


def _run_provider_call_until_deadline(
    callback: Callable[[], object],
    *,
    deadline_at: float,
    cancel_event: Event,
    fallback: object,
) -> tuple[object, bool]:
    if cancel_event.is_set():
        return fallback, False
    if cover_lookup_provider_deadline_reached(deadline_at):
        return fallback, True

    future = _COVER_LOOKUP_PROVIDER_EXECUTOR.submit(callback)
    return _await_provider_future_until_deadline(
        future,
        deadline_at=deadline_at,
        cancel_event=cancel_event,
        fallback=fallback,
    )


def _await_provider_future_until_deadline(
    future,
    *,
    deadline_at: float,
    cancel_event: Event,
    fallback: object,
) -> tuple[object, bool]:
    while True:
        remaining_seconds = max(0.0, deadline_at - time.perf_counter())
        try:
            return future.result(timeout=min(0.05, remaining_seconds)), False
        except FutureTimeoutError:
            if future.done():
                return future.result(), False
        if cancel_event.is_set():
            future.cancel()
            return fallback, False
        if cover_lookup_provider_deadline_reached(deadline_at):
            future.cancel()
            return fallback, True


def _apply_cover_selection_for_tracks(
    apply_cover_selection_for_tracks,
    track_paths: set[str],
    *,
    config: Mapping[str, object],
    logger,
    library_state: dict[str, object],
    **changes,
):
    dependency_kwargs: dict[str, object] = {}
    if _callback_accepts_parameter(apply_cover_selection_for_tracks, "config"):
        dependency_kwargs["config"] = config
    if _callback_accepts_parameter(apply_cover_selection_for_tracks, "logger"):
        dependency_kwargs["logger"] = logger
    if _callback_accepts_parameter(apply_cover_selection_for_tracks, "library_state"):
        dependency_kwargs["library_state"] = library_state
    return apply_cover_selection_for_tracks(track_paths, **changes, **dependency_kwargs)


def _run_cover_lookup_task(
    task_id: str,
    config: Mapping[str, object],
    logger,
    user_agent: str,
    album: dict[str, object],
    requested_track_paths: set[str],
    cancel_event: Event,
    manual_urls: list[str] | None = None,
    *,
    provider_deadline_at: float | None = None,
) -> None:
    phase_timings, phase_counts = _new_runtime_phase_metrics()
    candidate_publisher = None
    candidate_snapshot_published = False
    candidate_snapshot_diagnostic = ""
    candidate_repository_factory = config.get(
        "COVER_CANDIDATE_SNAPSHOT_REPOSITORY_FACTORY"
    )
    candidate_persistence_required = bool(
        config.get("COVER_CANDIDATE_SNAPSHOT_PERSISTENCE_REQUIRED")
    )
    try:
        album_id = int(album.get("id") or 0)
        repository = (
            candidate_repository_factory(
                album_id=album_id,
                search_generation=task_id,
                search_kind="manual",
            )
            if callable(candidate_repository_factory)
            else AlbumCoverCandidateSnapshotRepository(config)
        )
        if album_id <= 0:
            album_id = int(
                repository.resolve_album_id_for_track_paths(
                    track_paths=requested_track_paths
                )
                or 0
            )
        if album_id > 0:
            candidate_publisher = AlbumCoverCandidatePublisher(
                repository,
                album_id=album_id,
                search_generation=task_id,
                search_kind="manual",
            )
    except Exception:
        if candidate_persistence_required:
            raise
        candidate_publisher = None
        candidate_snapshot_diagnostic = "durable_candidate_persistence_failed"

    def publish_candidate_snapshot(candidates: list[dict[str, object]]) -> None:
        nonlocal candidate_publisher, candidate_snapshot_diagnostic
        nonlocal candidate_snapshot_published
        if candidate_publisher is None or not candidates:
            return
        try:
            accepted = bool(candidate_publisher.publish_candidates(candidates))
            if candidate_persistence_required and not accepted:
                raise RuntimeError("candidate snapshot publication lost its claim")
            candidate_snapshot_published = accepted or candidate_snapshot_published
        except Exception:
            if candidate_persistence_required:
                raise
            candidate_publisher = None
            candidate_snapshot_diagnostic = "durable_candidate_persistence_failed"

    def candidate_snapshot_changes() -> dict[str, object]:
        if not candidate_snapshot_diagnostic:
            return {}
        return {"candidate_snapshot_diagnostic": candidate_snapshot_diagnostic}

    provider_deadline_at = (
        float(provider_deadline_at)
        if provider_deadline_at is not None
        else build_cover_lookup_provider_deadline_at(config)
    )
    provider_deadline_exhausted = False
    try:
        if cancel_event.is_set():
            _terminalize_canceled_cover_lookup_task(
                task_id,
                config=config,
                candidate_publisher=candidate_publisher,
                candidate_snapshot_published=candidate_snapshot_published,
            )
            return
        log_app_event(
            config,
            logger,
            "Cover lookup task started",
            level="info",
            task_id=task_id,
            artist=str(album.get("album_artist") or ""),
            album=str(album.get("name") or album.get("album") or ""),
            year=album.get("year"),
            edition=str(album.get("edition") or ""),
            track_count=len(requested_track_paths),
        )
        _update_candidate_lookup_task(
            task_id,
            config=config,
            status="running",
            progress=12,
            progress_label="Searching music services...",
        )
        if cancel_event.is_set():
            _terminalize_canceled_cover_lookup_task(
                task_id,
                config=config,
                candidate_publisher=candidate_publisher,
                candidate_snapshot_published=candidate_snapshot_published,
            )
            return
        _update_candidate_lookup_task(
            task_id,
            config=config,
            progress=52,
            progress_label="Collecting service matches...",
        )
        lookup_query = CoverLookupProviderQuery(
            artist=str(album.get("album_artist") or ""),
            album=str(album.get("name") or album.get("album") or ""),
            edition=str(album.get("edition") or "").strip() or None,
            year=int(album.get("year")) if isinstance(album.get("year"), int) else None,
            user_agent=user_agent,
            enabled_provider_groups=config.get("COVER_PROVIDER_GROUPS"),
            enabled_music_services=config.get("ENABLED_MUSIC_SERVICES"),
        )
        bandcamp_search = COVER_LOOKUP_PROVIDER_REGISTRY.search_bandcamp_matches
        bandcamp_stop_event = Event()
        bandcamp_search_kwargs = _provider_call_kwargs(
            bandcamp_search,
            cancel_event=cancel_event,
            deadline_at=provider_deadline_at,
        )
        bandcamp_should_cancel = bandcamp_search_kwargs.get("should_cancel")
        if callable(bandcamp_should_cancel):
            bandcamp_search_kwargs["should_cancel"] = lambda: (
                bandcamp_stop_event.is_set()
                or bandcamp_should_cancel()
            )
        bandcamp_future = _COVER_LOOKUP_BANDCAMP_EXECUTOR.submit(
            lambda: bandcamp_search(
                lookup_query,
                **bandcamp_search_kwargs,
            )
        )
        later_provider_search = (
            COVER_LOOKUP_PROVIDER_REGISTRY.search_discogs_and_cover_art_archive_matches
        )
        later_provider_search_kwargs = _provider_call_kwargs(
            later_provider_search,
            cancel_event=cancel_event,
            deadline_at=provider_deadline_at,
        )
        later_provider_future = _COVER_LOOKUP_PROVIDER_EXECUTOR.submit(
            lambda: later_provider_search(
                lookup_query,
                **later_provider_search_kwargs,
            )
        )
        phase_started = time.perf_counter()
        service_search = COVER_LOOKUP_PROVIDER_REGISTRY.search_music_service_matches
        progressive_service_candidates: list[dict[str, object]] = []
        progressive_service_candidates_lock = Lock()
        progressive_service_candidates_published = False

        def retain_service_candidates(candidates: list[dict[str, object]]) -> None:
            nonlocal progressive_service_candidates_published
            with progressive_service_candidates_lock:
                progressive_service_candidates[:] = list(candidates)
                should_publish = bool(candidates) and not progressive_service_candidates_published
                if should_publish:
                    progressive_service_candidates_published = True
            if not should_publish or cancel_event.is_set():
                return
            publish_candidate_snapshot(candidates)
            _update_candidate_lookup_task(
                task_id,
                config=config,
                possible_matches=candidates,
                **candidate_snapshot_changes(),
            )

        service_search_kwargs = _provider_call_kwargs(
            service_search,
            cancel_event=cancel_event,
            deadline_at=provider_deadline_at,
        )
        if _callback_accepts_parameter(service_search, "on_candidates"):
            service_search_kwargs["on_candidates"] = retain_service_candidates
        service_result, service_timed_out = _run_provider_call_until_deadline(
            lambda: service_search(
                lookup_query,
                manual_urls=manual_urls,
                **service_search_kwargs,
            ),
            deadline_at=provider_deadline_at,
            cancel_event=cancel_event,
            fallback=([], []),
        )
        service_candidates, manual_candidates = service_result
        if service_timed_out and not service_candidates:
            with progressive_service_candidates_lock:
                service_candidates = list(progressive_service_candidates)
        provider_deadline_exhausted = (
            service_timed_out
            or cover_lookup_provider_deadline_reached(provider_deadline_at)
        )
        _record_runtime_phase(
            phase_timings,
            phase_counts,
            "discovery",
            phase_started,
            count=len(service_candidates) + len(manual_candidates),
        )
        if cancel_event.is_set():
            _terminalize_canceled_cover_lookup_task(
                task_id,
                config=config,
                candidate_publisher=candidate_publisher,
                candidate_snapshot_published=candidate_snapshot_published,
            )
            return
        phase_started = time.perf_counter()
        combined_service_candidates = merge_lookup_matches(service_candidates, manual_candidates)
        _record_runtime_phase(
            phase_timings,
            phase_counts,
            "scoring",
            phase_started,
            count=len(combined_service_candidates),
        )
        phase_started = time.perf_counter()
        publish_candidate_snapshot(combined_service_candidates)
        _update_candidate_lookup_task(
            task_id,
            config=config,
            possible_matches=combined_service_candidates,
            **candidate_snapshot_changes(),
        )
        _record_runtime_phase(phase_timings, phase_counts, "persistence", phase_started, count=1)
        _publish_candidate_runtime_phase_metrics(
            task_id,
            config=config,
            timings=phase_timings,
            counts=phase_counts,
        )
        log_app_event(
            config,
            logger,
            "Cover lookup service candidates collected",
            level="info",
            task_id=task_id,
            artist=str(album.get("album_artist") or ""),
            album=str(album.get("name") or album.get("album") or ""),
            candidate_count=len(combined_service_candidates),
            manual_candidate_count=len(manual_candidates),
        )
        _update_candidate_lookup_task(
            task_id,
            config=config,
            progress=62,
            progress_label="Checking Bandcamp...",
        )
        phase_started = time.perf_counter()
        bandcamp_candidates: list[dict[str, object]] = []
        collect_bandcamp_result = bandcamp_future.done() or (
            not combined_service_candidates
            and not provider_deadline_exhausted
        )
        if not collect_bandcamp_result and not provider_deadline_exhausted:
            try:
                bandcamp_candidates = bandcamp_future.result(timeout=0.02)
                collect_bandcamp_result = True
            except FutureTimeoutError:
                pass
        if collect_bandcamp_result:
            bandcamp_timed_out = False
            if not bandcamp_candidates:
                bandcamp_result, bandcamp_timed_out = _await_provider_future_until_deadline(
                    bandcamp_future,
                    deadline_at=provider_deadline_at,
                    cancel_event=cancel_event,
                    fallback=[],
                )
                bandcamp_candidates = bandcamp_result
            provider_deadline_exhausted = (
                bandcamp_timed_out
                or cover_lookup_provider_deadline_reached(provider_deadline_at)
            )
        else:
            bandcamp_stop_event.set()
            bandcamp_future.cancel()
        _record_runtime_phase(
            phase_timings,
            phase_counts,
            "discovery",
            phase_started,
            count=len(bandcamp_candidates),
        )
        if cancel_event.is_set():
            _terminalize_canceled_cover_lookup_task(
                task_id,
                config=config,
                candidate_publisher=candidate_publisher,
                candidate_snapshot_published=candidate_snapshot_published,
            )
            return
        phase_started = time.perf_counter()
        combined_service_candidates = merge_lookup_matches(combined_service_candidates, bandcamp_candidates)
        _record_runtime_phase(
            phase_timings,
            phase_counts,
            "scoring",
            phase_started,
            count=len(combined_service_candidates),
        )
        phase_started = time.perf_counter()
        publish_candidate_snapshot(combined_service_candidates)
        _update_candidate_lookup_task(
            task_id,
            config=config,
            possible_matches=combined_service_candidates,
            **candidate_snapshot_changes(),
        )
        _record_runtime_phase(phase_timings, phase_counts, "persistence", phase_started, count=1)
        _publish_candidate_runtime_phase_metrics(
            task_id,
            config=config,
            timings=phase_timings,
            counts=phase_counts,
        )
        log_app_event(
            config,
            logger,
            "Cover lookup Bandcamp search completed",
            level="info",
            task_id=task_id,
            artist=str(album.get("album_artist") or ""),
            album=str(album.get("name") or album.get("album") or ""),
            candidate_count=len(bandcamp_candidates),
        )
        if cancel_event.is_set():
            _terminalize_canceled_cover_lookup_task(
                task_id,
                config=config,
                candidate_publisher=candidate_publisher,
                candidate_snapshot_published=candidate_snapshot_published,
            )
            return
        _update_candidate_lookup_task(
            task_id,
            config=config,
            progress=72,
            progress_label="Searching Discogs and Cover Art Archive...",
        )
        phase_started = time.perf_counter()
        discogs_candidates: list[dict[str, object]] = []
        archive_candidates: list[dict[str, object]] = []
        later_provider_result, later_provider_timed_out = _await_provider_future_until_deadline(
            later_provider_future,
            deadline_at=provider_deadline_at,
            cancel_event=cancel_event,
            fallback=([], []),
        )
        discogs_candidates, archive_candidates = later_provider_result
        provider_deadline_exhausted = (
            provider_deadline_exhausted
            or later_provider_timed_out
            or cover_lookup_provider_deadline_reached(provider_deadline_at)
        )
        _record_runtime_phase(
            phase_timings,
            phase_counts,
            "discovery",
            phase_started,
            count=len(discogs_candidates) + len(archive_candidates),
        )
        log_app_event(
            config,
            logger,
            "Cover lookup CAA search completed",
            level="info",
            task_id=task_id,
            artist=lookup_query.artist,
            album=lookup_query.album,
            candidate_count=len(archive_candidates),
        )
        log_app_event(
            config,
            logger,
            "Cover lookup Discogs search completed",
            level="info",
            task_id=task_id,
            artist=lookup_query.artist,
            album=lookup_query.album,
            candidate_count=len(discogs_candidates),
        )
        if cancel_event.is_set():
            _terminalize_canceled_cover_lookup_task(
                task_id,
                config=config,
                candidate_publisher=candidate_publisher,
                candidate_snapshot_published=candidate_snapshot_published,
            )
            return
        phase_started = time.perf_counter()
        combined_candidates = merge_lookup_matches(combined_service_candidates, discogs_candidates)
        combined_candidates = merge_lookup_matches(combined_candidates, archive_candidates)
        _record_runtime_phase(
            phase_timings,
            phase_counts,
            "scoring",
            phase_started,
            count=len(combined_candidates),
        )
        publish_candidate_snapshot(combined_candidates)
        _update_candidate_lookup_task(
            task_id,
            config=config,
            possible_matches=combined_candidates,
            **candidate_snapshot_changes(),
        )
        artist_website_candidates: list[dict[str, object]] = []
        if not provider_deadline_exhausted:
            _update_candidate_lookup_task(
                task_id,
                config=config,
                progress=78,
                progress_label="Checking artist website...",
            )
            phase_started = time.perf_counter()
            artist_website_search = COVER_LOOKUP_PROVIDER_REGISTRY.search_artist_website_matches
            artist_website_result, artist_website_timed_out = _run_provider_call_until_deadline(
                lambda: artist_website_search(
                    lookup_query,
                    **_provider_call_kwargs(
                        artist_website_search,
                        cancel_event=cancel_event,
                        deadline_at=provider_deadline_at,
                    ),
                ),
                deadline_at=provider_deadline_at,
                cancel_event=cancel_event,
                fallback=[],
            )
            artist_website_candidates = artist_website_result
            provider_deadline_exhausted = (
                artist_website_timed_out
                or cover_lookup_provider_deadline_reached(provider_deadline_at)
            )
            _record_runtime_phase(
                phase_timings,
                phase_counts,
                "discovery",
                phase_started,
                count=len(artist_website_candidates),
            )
            if cancel_event.is_set():
                _terminalize_canceled_cover_lookup_task(
                    task_id,
                    config=config,
                    candidate_publisher=candidate_publisher,
                    candidate_snapshot_published=candidate_snapshot_published,
                )
                return
            log_app_event(
                config,
                logger,
                "Cover lookup artist website search completed",
                level="info",
                task_id=task_id,
                artist=lookup_query.artist,
                album=lookup_query.album,
                candidate_count=len(artist_website_candidates),
            )
            phase_started = time.perf_counter()
            combined_candidates = merge_lookup_matches(combined_candidates, artist_website_candidates)
            _record_runtime_phase(
                phase_timings,
                phase_counts,
                "scoring",
                phase_started,
                count=len(combined_candidates),
            )
            publish_candidate_snapshot(combined_candidates)
            _update_candidate_lookup_task(
                task_id,
                config=config,
                possible_matches=combined_candidates,
                **candidate_snapshot_changes(),
            )
        if cancel_event.is_set():
            _terminalize_canceled_cover_lookup_task(
                task_id,
                config=config,
                candidate_publisher=candidate_publisher,
                candidate_snapshot_published=candidate_snapshot_published,
            )
            return
        if provider_deadline_exhausted:
            log_app_event(
                config,
                logger,
                "Cover lookup provider deadline reached",
                level="info",
                task_id=task_id,
                artist=lookup_query.artist,
                album=lookup_query.album,
                candidate_count=len(combined_candidates),
            )
        caa_empty_notice = not archive_candidates
        if candidate_publisher is not None and candidate_snapshot_published:
            try:
                completed = bool(candidate_publisher.complete())
                if candidate_persistence_required and not completed:
                    raise RuntimeError("candidate snapshot completion lost its claim")
            except Exception:
                if candidate_persistence_required:
                    raise
                candidate_snapshot_diagnostic = "durable_candidate_persistence_failed"
        phase_started = time.perf_counter()
        _update_candidate_lookup_task(
            task_id,
            config=config,
            status="completed",
            progress=100,
            progress_label="Completed",
            finished_at=datetime.now(timezone.utc).isoformat(),
            message=(
                "Possible matches are ready."
                if combined_candidates
                else "We cannot guarantee Cover Art Archive results. Its API is flaky, you can try doing the same search later and might see good matches here"
            )
            if caa_empty_notice
            else ("Possible matches are ready." if combined_candidates else "No better results found on the Internet."),
            result_kind="possible-matches" if combined_candidates else "no-results",
            possible_matches=combined_candidates,
            caa_empty_notice=caa_empty_notice,
            **candidate_snapshot_changes(),
        )
        _record_runtime_phase(phase_timings, phase_counts, "persistence", phase_started, count=1)
        _publish_candidate_runtime_phase_metrics(
            task_id,
            config=config,
            timings=phase_timings,
            counts=phase_counts,
        )
    except Exception as exc:
        if candidate_publisher is not None and candidate_snapshot_published:
            try:
                candidate_publisher.fail()
            except Exception:
                candidate_snapshot_diagnostic = "durable_candidate_persistence_failed"
        log_app_event(
            config,
            logger,
            "Cover lookup task failed",
            level="error",
            task_id=task_id,
            artist=str(album.get("album_artist") or ""),
            album=str(album.get("name") or album.get("album") or ""),
            error=(
                type(exc).__name__
                if _CLAIMED_LOOKUP_PUBLISHER.get() is not None
                else str(exc)
            ),
        )
        phase_started = time.perf_counter()
        _update_candidate_lookup_task(
            task_id,
            config=config,
            status="failed",
            progress=100,
            progress_label="Failed",
            finished_at=datetime.now(timezone.utc).isoformat(),
            message=str(exc),
            error=str(exc),
            **candidate_snapshot_changes(),
        )
        _record_runtime_phase(phase_timings, phase_counts, "persistence", phase_started, count=1)
        _publish_candidate_runtime_phase_metrics(
            task_id,
            config=config,
            timings=phase_timings,
            counts=phase_counts,
        )
    finally:
        discard_cover_lookup_future(task_id)


def _run_cover_lookup_save_remote_task(
    task_id: str,
    config: Mapping[str, object],
    logger,
    library_state: dict[str, object],
    user_agent: str,
    album_root,
    requested_track_paths: set[str],
    candidate_id: str,
    selected_image: SelectedRemoteImage,
    *,
    cover_selection_origin: str = "user",
    apply_cover_selection_for_tracks,
    persist_cover_selection_for_tracks=None,
) -> None:
    phase_timings, phase_counts = _runtime_phase_metrics_for_task(task_id)
    try:
        validated_album_root = _validated_remote_selection_album_root(
            config,
            album_root,
            requested_track_paths,
        )
        if validated_album_root is None:
            phase_started = time.perf_counter()
            update_cover_lookup_task(
                task_id,
                config=config,
                status="failed",
                progress=100,
                progress_label="Failed",
                finished_at=datetime.now(timezone.utc).isoformat(),
                message="Album root could not be resolved",
            )
            _record_runtime_phase(phase_timings, phase_counts, "persistence", phase_started, count=1)
            _publish_save_runtime_phase_metrics(
                task_id,
                config=config,
                timings=phase_timings,
                counts=phase_counts,
            )
            return
        if selected_image.display_only:
            phase_started = time.perf_counter()
            linked_updates: dict[str, object] = {}

            def prepare(_request, _baseline):
                return selected_image.url.encode("utf-8")

            def write_artifact(prepared, _baseline):
                return CoverArtifactIdentity(
                    private_path=None,
                    sha256=None,
                    post_write_exists=False,
                    selected_cover_path=None,
                    promoted_cover_revision=None,
                    prior_cover_existed=False,
                    prior_cover_bytes=None,
                )

            def publish_committed(_outcome, _artifact) -> None:
                apply_changes = {
                    "cover_path": None,
                    "remote_cover_url": selected_image.url,
                    "remote_cover_thumbnail_url": selected_image.thumbnail_url or selected_image.url,
                    "remote_cover_source": selected_image.source,
                    "remote_cover_source_label": selected_image.source_label,
                    "remote_cover_album_url": selected_image.album_url,
                    "remote_cover_width": selected_image.width,
                    "remote_cover_height": selected_image.height,
                }
                if (
                    persist_cover_selection_for_tracks is not None
                    and _callback_accepts_parameter(
                        apply_cover_selection_for_tracks,
                        "schedule_cache_update",
                    )
                ):
                    apply_changes["schedule_cache_update"] = False
                linked_updates["updates"] = _apply_cover_selection_for_tracks(
                    apply_cover_selection_for_tracks,
                    requested_track_paths,
                    config=config,
                    logger=logger,
                    library_state=library_state,
                    **apply_changes,
                )

            outcome = execute_cover_mutation_for_config(
                dict(config),
                track_paths=requested_track_paths,
                album_root=validated_album_root,
                selected_origin=(
                    "automatic"
                    if str(cover_selection_origin).casefold() == "automatic"
                    else "user"
                ),
                explicit_selection=str(cover_selection_origin).casefold() == "user",
                clear_selection=False,
                remote_cover={
                    "remote_cover_url": selected_image.url,
                    "remote_cover_thumbnail_url": selected_image.thumbnail_url or selected_image.url,
                    "remote_cover_source": selected_image.source,
                    "remote_cover_source_label": selected_image.source_label,
                    "remote_cover_album_url": selected_image.album_url,
                    "remote_cover_width": selected_image.width,
                    "remote_cover_height": selected_image.height,
                },
                prepare=prepare,
                cleanup_prepared=lambda _prepared: None,
                write_artifact=write_artifact,
                publish_committed=publish_committed,
            )
            if outcome.status is not CoverMutationStatus.COMMITTED:
                raise RuntimeError("Linked cover selection was not committed.")
            updated_albums, updated_problematic_album = linked_updates["updates"]
            update_cover_lookup_task(
                task_id,
                config=config,
                status="completed",
                progress=100,
                progress_label="Completed",
                finished_at=datetime.now(timezone.utc).isoformat(),
                selected_candidate_id=candidate_id,
                notification_action_taken=True,
                message="Selected remote cover art saved as a linked artwork source.",
                result_kind="cover-updated",
                updated_albums=updated_albums,
                updated_problematic_album=updated_problematic_album,
            )
            _record_runtime_phase(phase_timings, phase_counts, "persistence", phase_started, count=1)
            request_cover_lookup_task_stop(task_id)
            _publish_save_runtime_phase_metrics(
                task_id,
                config=config,
                timings=phase_timings,
                counts=phase_counts,
            )
            return
        phase_started = time.perf_counter()
        committed_updates = None

        def apply_downloaded_cover(written_cover: Path, cover_revision: str | None):
            apply_changes = {"cover_path": written_cover, "cover_revision": cover_revision}
            if (
                persist_cover_selection_for_tracks is not None
                and _callback_accepts_parameter(
                    apply_cover_selection_for_tracks,
                    "schedule_cache_update",
                )
            ):
                apply_changes["schedule_cache_update"] = False
            return _apply_cover_selection_for_tracks(
                apply_cover_selection_for_tracks,
                requested_track_paths,
                config=config,
                logger=logger,
                library_state=library_state,
                **apply_changes,
            )

        def write_persist_and_apply(folder: Path, raw_bytes: bytes) -> Path | None:
            nonlocal committed_updates
            mutation: dict[str, object] = {}
            local_dimensions: tuple[int, int] | None = None

            def prepare(_request, _baseline):
                nonlocal local_dimensions
                prepared = prepare_remote_cover_bytes_for_authoritative_write(raw_bytes)
                if prepared is None:
                    raise RuntimeError("Remote cover image validation failed.")
                decoded = decode_image_bytes(prepared)
                if decoded is None:
                    raise RuntimeError("Prepared cover image validation failed.")
                image, width, height = decoded
                try:
                    local_dimensions = (width, height)
                finally:
                    image.close()
                mutation["reservation"] = prepare_cover_reservation(folder, prepared)
                return prepared

            def write_artifact(prepared, _baseline):
                assert local_dimensions is not None
                promotion = begin_prepared_remote_cover_promotion(
                    folder,
                    prepared,
                    reservation=mutation.get("reservation"),
                    serialize_selection=False,
                )
                if promotion is None:
                    raise RuntimeError("Remote cover image validation failed.")
                mutation["promotion"] = promotion
                return CoverArtifactIdentity(
                    private_path=promotion.cover_path,
                    sha256=promotion.promoted_cover_revision,
                    post_write_exists=True,
                    selected_cover_path=str(promotion.cover_path),
                    promoted_cover_revision=promotion.promoted_cover_revision,
                    prior_cover_existed=promotion.prior_cover_existed,
                    prior_cover_bytes=promotion.prior_cover_bytes,
                    local_cover_width=local_dimensions[0],
                    local_cover_height=local_dimensions[1],
                )

            def publish_committed(_outcome, artifact) -> None:
                nonlocal committed_updates
                promotion = mutation.get("promotion")
                if promotion is not None:
                    complete_local_image_promotion(promotion)
                assert artifact.private_path is not None
                committed_updates = apply_downloaded_cover(
                    artifact.private_path, artifact.promoted_cover_revision
                )
                mutation["written"] = artifact.private_path

            def compensate_artifact(_artifact) -> None:
                promotion = mutation.get("promotion")
                if promotion is not None:
                    rollback_local_image_promotion(promotion)

            outcome = execute_cover_mutation_for_config(
                dict(config),
                track_paths=requested_track_paths,
                album_root=folder,
                selected_origin=(
                    "automatic"
                    if str(cover_selection_origin).casefold() == "automatic"
                    else "user"
                ),
                explicit_selection=str(cover_selection_origin).casefold() == "user",
                clear_selection=False,
                remote_cover=None,
                prepare=prepare,
                cleanup_prepared=lambda _prepared: None,
                write_artifact=write_artifact,
                compensate_artifact=compensate_artifact,
                publish_committed=publish_committed,
            )
            if outcome.status is not CoverMutationStatus.COMMITTED:
                raise RuntimeError("Remote cover selection was not committed.")
            return mutation.get("written")

        download_kwargs = {
            "folder": validated_album_root,
            "image_url": selected_image.url,
            "user_agent": user_agent,
        }
        download_kwargs["write_cover_func"] = write_persist_and_apply
        written, detail = download_remote_cover_to_folder(**download_kwargs)
        _record_runtime_phase(phase_timings, phase_counts, "fetch", phase_started, count=1)
        if written is None:
            phase_started = time.perf_counter()
            update_cover_lookup_task(
                task_id,
                config=config,
                status="failed",
                progress=100,
                progress_label="Failed",
                finished_at=datetime.now(timezone.utc).isoformat(),
                message=str(detail.get("reason") or "Failed to save selected cover art."),
            )
            _record_runtime_phase(phase_timings, phase_counts, "persistence", phase_started, count=1)
            _publish_save_runtime_phase_metrics(
                task_id,
                config=config,
                timings=phase_timings,
                counts=phase_counts,
            )
            return
        phase_started = time.perf_counter()
        if committed_updates is None:
            raise RuntimeError("Remote cover committed without runtime publication.")
        updated_albums, updated_problematic_album = committed_updates
        update_cover_lookup_task(
            task_id,
            config=config,
            status="completed",
            progress=100,
            progress_label="Completed",
            finished_at=datetime.now(timezone.utc).isoformat(),
            selected_candidate_id=candidate_id,
            notification_action_taken=True,
            message="Selected cover art saved.",
            result_kind="cover-updated",
            updated_albums=updated_albums,
            updated_problematic_album=updated_problematic_album,
        )
        _record_runtime_phase(phase_timings, phase_counts, "persistence", phase_started, count=1)
        request_cover_lookup_task_stop(task_id)
        _publish_save_runtime_phase_metrics(
            task_id,
            config=config,
            timings=phase_timings,
            counts=phase_counts,
        )
    except Exception as exc:
        log_exception = getattr(logger, "exception", None)
        if callable(log_exception):
            log_exception(
                "Remote cover selection failed task_id=%s candidate_id=%s source=%s",
                task_id,
                candidate_id,
                selected_image.source,
            )
        phase_started = time.perf_counter()
        update_cover_lookup_task(
            task_id,
            config=config,
            status="failed",
            progress=100,
            progress_label="Failed",
            finished_at=datetime.now(timezone.utc).isoformat(),
            message="Failed to save selected cover art.",
        )
        _record_runtime_phase(phase_timings, phase_counts, "persistence", phase_started, count=1)
        _publish_save_runtime_phase_metrics(
            task_id,
            config=config,
            timings=phase_timings,
            counts=phase_counts,
        )
