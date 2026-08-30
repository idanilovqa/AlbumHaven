from __future__ import annotations

import logging
from threading import Lock
from time import perf_counter

from music_app.routes.api_rules_helpers import build_utility_rules_payload as build_utility_rules_read_payload
from music_app.services.runtime_shutdown import create_daemon_executor


_LOGGER = logging.getLogger(__name__)
_UTILITY_RULES_CACHE_KEY = "_utility_rules_payload_cache"
_UTILITY_RULES_CACHE_SIGNATURE_KEY = "_utility_rules_payload_cache_signature"
_UTILITY_RULES_CACHE_REVISION_KEY = "_utility_rules_payload_cache_revision"
_UTILITY_RULES_PREWARM_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-utility-rules-prewarm")
_UTILITY_RULES_PREWARM_LOCK = Lock()
_UTILITY_RULES_CACHE_LOCK = Lock()
_UTILITY_RULES_PREWARM_SIGNATURES: set[tuple[object, ...]] = set()


def _log_utility_rules_timing(kind: str, *, logger=None, **details: object) -> None:
    active_logger = logger if logger is not None else _LOGGER
    active_logger.info(
        "Utility rules timing: %s",
        {
            "kind": kind,
            **details,
        },
    )


def _utility_rules_cache_signature(library_state: dict[str, object]) -> tuple[object, ...]:
    return (
        id(library_state.get("albums")),
        id(library_state.get("file_cache")),
        id(library_state.get("relation_views")),
        int(library_state.get(_UTILITY_RULES_CACHE_REVISION_KEY) or 0),
    )


def _require_library_state(library_state: dict[str, object] | None) -> dict[str, object]:
    if not isinstance(library_state, dict):
        raise ValueError("library_state is required")
    return library_state


def invalidate_utility_rules_payload_cache(library_state: dict[str, object] | None = None) -> None:
    st = _require_library_state(library_state)
    with _UTILITY_RULES_CACHE_LOCK:
        st.pop(_UTILITY_RULES_CACHE_KEY, None)
        st.pop(_UTILITY_RULES_CACHE_SIGNATURE_KEY, None)
        st[_UTILITY_RULES_CACHE_REVISION_KEY] = int(
            st.get(_UTILITY_RULES_CACHE_REVISION_KEY) or 0
        ) + 1
    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

    invalidate_postgres_utility_projection_cache()


def has_cached_utility_rules_payload(
    library_state: dict[str, object] | None = None,
    *,
    config: dict[str, object] | None = None,
) -> bool:
    if config is None:
        return False
    st = _require_library_state(library_state)
    with _UTILITY_RULES_CACHE_LOCK:
        cached_payload = st.get(_UTILITY_RULES_CACHE_KEY)
        cached_signature = st.get(_UTILITY_RULES_CACHE_SIGNATURE_KEY)
        return isinstance(cached_payload, dict) and cached_signature == _utility_rules_cache_signature(st)


def _build_utility_rules_payload_for_prewarm(
    *,
    library_state: dict[str, object],
    config: dict[str, object],
    logger,
    load_ignored_version_keys,
    load_ignored_repair_keys,
    album_to_dict,
) -> dict[str, object]:
    return build_utility_rules_payload(
        library_state=library_state,
        config=config,
        logger=logger,
        load_ignored_version_keys=load_ignored_version_keys,
        load_ignored_repair_keys=load_ignored_repair_keys,
        album_to_dict=album_to_dict,
    )


def _run_utility_rules_prewarm(
    expected_signature: tuple[object, ...],
    *,
    library_state: dict[str, object],
    config: dict[str, object],
    logger,
    load_ignored_version_keys,
    load_ignored_repair_keys,
    album_to_dict,
) -> None:
    try:
        current_signature = _utility_rules_cache_signature(library_state)
        if current_signature != expected_signature:
            return
        if has_cached_utility_rules_payload(library_state, config=config):
            return
        if not library_state.get("albums") or not library_state.get("file_cache"):
            return
        _build_utility_rules_payload_for_prewarm(
            library_state=library_state,
            config=config,
            logger=logger,
            load_ignored_version_keys=load_ignored_version_keys,
            load_ignored_repair_keys=load_ignored_repair_keys,
            album_to_dict=album_to_dict,
        )
    except Exception as exc:
        logger.warning("Could not prewarm utility rules payload: %s", exc)
    finally:
        with _UTILITY_RULES_PREWARM_LOCK:
            _UTILITY_RULES_PREWARM_SIGNATURES.discard(expected_signature)


def queue_utility_rules_prewarm(
    *,
    library_state: dict[str, object],
    config: dict[str, object],
    logger,
    load_ignored_version_keys,
    load_ignored_repair_keys,
    album_to_dict,
) -> bool:
    if not library_state.get("albums") or not library_state.get("file_cache"):
        return False
    if library_state.get("scan_in_progress") or library_state.get("covers_in_progress"):
        return False
    signature = _utility_rules_cache_signature(library_state)
    if has_cached_utility_rules_payload(library_state, config=config):
        return False
    with _UTILITY_RULES_PREWARM_LOCK:
        if signature in _UTILITY_RULES_PREWARM_SIGNATURES:
            return False
        _UTILITY_RULES_PREWARM_SIGNATURES.add(signature)
    _UTILITY_RULES_PREWARM_EXECUTOR.submit(
        _run_utility_rules_prewarm,
        signature,
        library_state=library_state,
        config=config,
        logger=logger,
        load_ignored_version_keys=load_ignored_version_keys,
        load_ignored_repair_keys=load_ignored_repair_keys,
        album_to_dict=album_to_dict,
    )
    return True


def build_utility_rules_payload(
    *,
    load_ignored_version_keys,
    load_ignored_repair_keys,
    album_to_dict,
    library_state: dict[str, object] | None = None,
    config=None,
    logger=None,
) -> dict[str, object]:
    started_at = perf_counter()
    if config is None:
        raise ValueError("config is required to build utility rules payload")
    st = _require_library_state(library_state)
    cfg = config
    with _UTILITY_RULES_CACHE_LOCK:
        signature = _utility_rules_cache_signature(st)
        cached_payload = st.get(_UTILITY_RULES_CACHE_KEY)
        cached_signature = st.get(_UTILITY_RULES_CACHE_SIGNATURE_KEY)
        cache_hit = isinstance(cached_payload, dict) and cached_signature == signature
    if cache_hit:
        _log_utility_rules_timing(
            "rules_payload",
            logger=logger,
            cache_status="hit",
            rule_count=len(cached_payload.get("rules", [])),
            elapsed_ms=round((perf_counter() - started_at) * 1000, 2),
        )
        return cached_payload

    relation_views = st.get("relation_views", {}) or {}
    alias_to_canonical = relation_views.get("alias_to_canonical", {}) if isinstance(relation_views, dict) else {}
    payload = build_utility_rules_read_payload(
        config=cfg,
        albums=list(st.get("albums", []) or []),
        file_cache=st.get("file_cache", {}) or {},
        ignored_version_keys=load_ignored_version_keys(cfg),
        ignored_repair_keys=load_ignored_repair_keys(cfg),
        album_to_dict=album_to_dict,
        alias_to_canonical=alias_to_canonical or None,
    )
    with _UTILITY_RULES_CACHE_LOCK:
        if _utility_rules_cache_signature(st) == signature:
            st[_UTILITY_RULES_CACHE_KEY] = payload
            st[_UTILITY_RULES_CACHE_SIGNATURE_KEY] = signature
    _log_utility_rules_timing(
        "rules_payload",
        logger=logger,
        cache_status="miss",
        rule_count=len(payload.get("rules", [])),
        elapsed_ms=round((perf_counter() - started_at) * 1000, 2),
        alias_source="relation_views" if alias_to_canonical else "empty_fallback",
    )
    return payload
