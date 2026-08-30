from __future__ import annotations

import logging
from pathlib import Path
from threading import Lock
from time import perf_counter

from music_app.routes.api_problematic_albums import build_problematic_albums_payload as build_problematic_albums_read_payload
from music_app.routes.api_problematic_albums import build_problematic_album_detail_payload as build_problematic_album_detail_read_payload
from music_app.services.ignored_repairs import load_ignored_repair_keys
from music_app.services.library import album_to_dict, get_album_duplicate_sources
from music_app.services.runtime_shutdown import create_daemon_executor
from music_app.services.separate_releases import load_separate_release_keys


_LOGGER = logging.getLogger(__name__)
_POOR_ART_MIN_EDGE = 1200
_PROBLEMATIC_ALBUMS_CACHE_KEY = "_problematic_albums_payload_cache"
_PROBLEMATIC_ALBUMS_CACHE_SIGNATURE_KEY = "_problematic_albums_payload_cache_signature"
_PROBLEMATIC_ALBUMS_CACHE_REVISION_KEY = "_problematic_albums_payload_cache_revision"
_PROBLEMATIC_ALBUMS_PREWARM_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-problematic-prewarm")
_PROBLEMATIC_ALBUMS_PREWARM_LOCK = Lock()
_PROBLEMATIC_ALBUMS_CACHE_LOCK = Lock()
_PROBLEMATIC_ALBUMS_PREWARM_SIGNATURES: set[tuple[object, ...]] = set()


def _log_problematic_albums_timing(kind: str, *, logger=None, **details: object) -> None:
    active_logger = logger if logger is not None else _LOGGER
    active_logger.info(
        "Problematic albums timing: %s",
        {
            "kind": kind,
            **details,
        },
    )


def _problematic_albums_cache_signature(library_state: dict[str, object]) -> tuple[object, ...]:
    return (
        id(library_state.get("albums")),
        id(library_state.get("file_cache")),
        id(library_state.get("relation_views")),
        int(library_state.get(_PROBLEMATIC_ALBUMS_CACHE_REVISION_KEY) or 0),
    )


def _require_library_state(library_state: dict[str, object] | None) -> dict[str, object]:
    if not isinstance(library_state, dict):
        raise ValueError("library_state is required")
    return library_state


def invalidate_problematic_albums_payload_cache(library_state: dict[str, object] | None = None) -> None:
    st = _require_library_state(library_state)
    with _PROBLEMATIC_ALBUMS_CACHE_LOCK:
        st.pop(_PROBLEMATIC_ALBUMS_CACHE_KEY, None)
        st.pop(_PROBLEMATIC_ALBUMS_CACHE_SIGNATURE_KEY, None)
        st[_PROBLEMATIC_ALBUMS_CACHE_REVISION_KEY] = int(
            st.get(_PROBLEMATIC_ALBUMS_CACHE_REVISION_KEY) or 0
        ) + 1
    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

    invalidate_postgres_utility_projection_cache()


def has_cached_problematic_albums_payload(
    library_state: dict[str, object] | None = None,
    *,
    config: dict[str, object] | None = None,
) -> bool:
    if config is None:
        return False
    st = _require_library_state(library_state)
    with _PROBLEMATIC_ALBUMS_CACHE_LOCK:
        cached_payload = st.get(_PROBLEMATIC_ALBUMS_CACHE_KEY)
        cached_signature = st.get(_PROBLEMATIC_ALBUMS_CACHE_SIGNATURE_KEY)
        return isinstance(cached_payload, dict) and cached_signature == _problematic_albums_cache_signature(st)


def _build_problematic_albums_payload_for_prewarm(
    *,
    library_state: dict[str, object],
    config: dict[str, object],
    logger,
) -> dict[str, object]:
    from music_app.services.repair_previews import build_problematic_albums_payload

    return build_problematic_albums_payload(
        library_state=library_state,
        config=config,
        logger=logger,
    )


def _run_problematic_albums_prewarm(
    expected_signature: tuple[object, ...],
    *,
    library_state: dict[str, object],
    config: dict[str, object],
    logger,
    ) -> None:
    try:
        current_signature = _problematic_albums_cache_signature(library_state)
        if current_signature != expected_signature:
            return
        if has_cached_problematic_albums_payload(library_state, config=config):
            return
        if not library_state.get("albums") or not library_state.get("file_cache"):
            return
        _build_problematic_albums_payload_for_prewarm(
            library_state=library_state,
            config=config,
            logger=logger,
        )
    except Exception as exc:
        logger.warning("Could not prewarm problematic albums payload: %s", exc)
    finally:
        with _PROBLEMATIC_ALBUMS_PREWARM_LOCK:
            _PROBLEMATIC_ALBUMS_PREWARM_SIGNATURES.discard(expected_signature)


def queue_problematic_albums_prewarm(
    *,
    library_state: dict[str, object],
    config: dict[str, object],
    logger,
) -> bool:
    if not library_state.get("albums") or not library_state.get("file_cache"):
        return False
    if library_state.get("scan_in_progress") or library_state.get("covers_in_progress"):
        return False
    signature = _problematic_albums_cache_signature(library_state)
    if has_cached_problematic_albums_payload(library_state, config=config):
        return False
    with _PROBLEMATIC_ALBUMS_PREWARM_LOCK:
        if signature in _PROBLEMATIC_ALBUMS_PREWARM_SIGNATURES:
            return False
        _PROBLEMATIC_ALBUMS_PREWARM_SIGNATURES.add(signature)
    _PROBLEMATIC_ALBUMS_PREWARM_EXECUTOR.submit(
        _run_problematic_albums_prewarm,
        signature,
        library_state=library_state,
        config=config,
        logger=logger,
    )
    return True


def build_problematic_albums_payload(
    *,
    text_problem_reason,
    artist_alias_problem_reason,
    year_problem_reason,
    all_track_text_problems_ignored,
    all_track_year_problems_ignored,
    collect_track_level_problem_reasons,
    build_encoding_repair_preview,
    collect_track_problem_rows,
    separate_release_candidate,
    image_dimensions,
    config=None,
    library_state: dict[str, object] | None = None,
    logger=None,
) -> dict[str, object]:
    started_at = perf_counter()
    if config is None:
        raise ValueError("config is required to build problematic albums payload")
    st = _require_library_state(library_state)
    cfg = config
    with _PROBLEMATIC_ALBUMS_CACHE_LOCK:
        signature = _problematic_albums_cache_signature(st)
        cached_payload = st.get(_PROBLEMATIC_ALBUMS_CACHE_KEY)
        cached_signature = st.get(_PROBLEMATIC_ALBUMS_CACHE_SIGNATURE_KEY)
        cache_hit = isinstance(cached_payload, dict) and cached_signature == signature
    if cache_hit:
        _log_problematic_albums_timing(
            "summary_payload",
            logger=logger,
            cache_status="hit",
            item_count=len(cached_payload.get("items", [])),
            elapsed_ms=round((perf_counter() - started_at) * 1000, 2),
        )
        return cached_payload

    payload = build_problematic_albums_read_payload(
        state_getter=lambda: st,
        config=cfg,
        load_ignored_repair_keys=load_ignored_repair_keys,
        load_separate_release_keys=load_separate_release_keys,
        text_problem_reason=lambda label, value: text_problem_reason(label, value, detect_encoding=True),
        artist_alias_problem_reason=artist_alias_problem_reason,
        year_problem_reason=year_problem_reason,
        all_track_text_problems_ignored=all_track_text_problems_ignored,
        all_track_year_problems_ignored=all_track_year_problems_ignored,
        collect_track_level_problem_reasons=collect_track_level_problem_reasons,
        build_encoding_repair_preview=build_encoding_repair_preview,
        collect_track_problem_rows=collect_track_problem_rows,
        separate_release_candidate=separate_release_candidate,
        album_to_dict=lambda album: album_to_dict(album, config=cfg),
        get_album_duplicate_sources=get_album_duplicate_sources,
        image_dimensions=image_dimensions,
        poor_art_min_edge=_POOR_ART_MIN_EDGE,
    )
    with _PROBLEMATIC_ALBUMS_CACHE_LOCK:
        if _problematic_albums_cache_signature(st) == signature:
            st[_PROBLEMATIC_ALBUMS_CACHE_KEY] = payload
            st[_PROBLEMATIC_ALBUMS_CACHE_SIGNATURE_KEY] = signature
    _log_problematic_albums_timing(
        "summary_payload",
        logger=logger,
        cache_status="miss",
        item_count=len(payload.get("items", [])),
        elapsed_ms=round((perf_counter() - started_at) * 1000, 2),
    )
    return payload


def build_problematic_album_detail_payload(
    album_key: str,
    *,
    text_problem_reason,
    artist_alias_problem_reason,
    year_problem_reason,
    all_track_text_problems_ignored,
    all_track_year_problems_ignored,
    collect_track_level_problem_reasons,
    build_encoding_repair_preview,
    collect_track_problem_rows,
    separate_release_candidate,
    image_dimensions,
    config=None,
    library_state: dict[str, object] | None = None,
    logger=None,
) -> dict[str, object] | None:
    started_at = perf_counter()
    if config is None:
        raise ValueError("config is required to build problematic album detail payload")
    st = _require_library_state(library_state)
    cfg = config
    payload = build_problematic_album_detail_read_payload(
        album_key=album_key,
        state_getter=lambda: st,
        config=cfg,
        load_ignored_repair_keys=load_ignored_repair_keys,
        load_separate_release_keys=load_separate_release_keys,
        text_problem_reason=lambda label, value: text_problem_reason(label, value, detect_encoding=True),
        artist_alias_problem_reason=artist_alias_problem_reason,
        year_problem_reason=year_problem_reason,
        all_track_text_problems_ignored=all_track_text_problems_ignored,
        all_track_year_problems_ignored=all_track_year_problems_ignored,
        collect_track_level_problem_reasons=collect_track_level_problem_reasons,
        build_encoding_repair_preview=build_encoding_repair_preview,
        collect_track_problem_rows=collect_track_problem_rows,
        separate_release_candidate=separate_release_candidate,
        album_to_dict=lambda album: album_to_dict(album, config=cfg),
        get_album_duplicate_sources=get_album_duplicate_sources,
        image_dimensions=image_dimensions,
        poor_art_min_edge=_POOR_ART_MIN_EDGE,
    )
    _log_problematic_albums_timing(
        "detail_payload",
        logger=logger,
        album_key=album_key,
        status="found" if payload is not None else "not_found",
        elapsed_ms=round((perf_counter() - started_at) * 1000, 2),
    )
    return payload


def find_problematic_album_by_track_paths(
    track_paths: set[str],
    *,
    build_problematic_albums_payload,
) -> dict[str, object] | None:
    if not track_paths:
        return None
    for item in build_problematic_albums_payload().get("items", []):
        item_paths = {
            str(track.get("path") or "")
            for track in item.get("tracks", [])
            if isinstance(track, dict) and str(track.get("path") or "")
        }
        if item_paths & track_paths:
            return item
    return None


def find_problematic_album_cover_paths(problematic_album: dict[str, object]) -> list[Path]:
    return [
        Path(str(track.get("path") or ""))
        for track in problematic_album.get("tracks", [])
        if isinstance(track, dict) and str(track.get("path") or "")
    ]
