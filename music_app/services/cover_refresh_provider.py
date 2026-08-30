from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Callable
from pathlib import Path

from config import Config
from music_app.services import cover_provider_deezer
from music_app.services import cover_provider_fallback_web
from music_app.services import cover_provider_http
from music_app.services import cover_provider_spotify
from music_app.services import cover_provider_cache
from music_app.services import cover_provider_apple
from music_app.services import cover_provider_matching
from music_app.services.app_logging import log_app_event
from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    current_use_candidate_debug_payload,
    normalize_remote_image_url,
)
from music_app.services.cover_provider_groups import (
    cover_provider_group_enabled,
    normalize_enabled_music_services,
)
from music_app.services.covers import (
    cover_stem,
    find_cover_image,
    image_area,
    image_dimensions,
    image_sharpness,
    images_are_visually_similar,
    is_authoritative_cover_name,
    is_low_quality_cover_name,
    measure_image_sharpness,
)
from music_app.services.cover_workflow import (
    cover_revision_for_path,
    decode_image_bytes,
    prepare_remote_cover_bytes_for_authoritative_write,
    write_prepared_remote_cover_bytes,
    write_remote_cover_bytes_as_authoritative_cover,
)

CoverSearchCache = cover_provider_cache.CoverSearchCache
SearchRemoteCover = Callable[..., tuple[CoverCandidate | None, list[dict[str, object]]]]
HttpGetBytes = Callable[..., bytes | None]
DecodeImage = Callable[[bytes], tuple[object, int, int] | None]
WriteCover = Callable[[Path, bytes], Path | None]
SuspiciousCacheEntry = Callable[..., bool]

_LOGGER = logging.getLogger(__name__)
_MIN_AUTHORITATIVE_COVER_EDGE = cover_provider_matching.MIN_AUTHORITATIVE_COVER_EDGE
_APPLE_SUFFICIENT_COVER_EDGE = cover_provider_apple._APPLE_SUFFICIENT_COVER_EDGE
_APPLE_MAX_PROBE_CONTENDERS = cover_provider_apple._APPLE_MAX_PROBE_CONTENDERS
_NEGATIVE_CACHE_TTL_SECONDS = cover_provider_cache._NEGATIVE_CACHE_TTL_SECONDS


def _log_verbose(logger, message: str, *args: object) -> None:
    callback = getattr(logger, "verbose", None)
    if not callable(callback):
        callback = logger.debug
    callback(message, *args)


def local_cover_requires_upgrade_check(local_cover: Path | None, cached: dict[str, object] | None = None) -> bool:
    if local_cover is None or not local_cover.exists():
        return True
    width, height = image_dimensions(local_cover)
    return width < _MIN_AUTHORITATIVE_COVER_EDGE or height < _MIN_AUTHORITATIVE_COVER_EDGE


def _http_get_bytes(url: str, *, user_agent: str, service: str, context: str) -> bytes | None:
    return cover_provider_http._http_get_bytes(
        url,
        user_agent=user_agent,
        service=service,
        context=context,
        append_apple_request_trace=cover_provider_apple.append_apple_request_trace,
    )


def _http_get_json(url: str, user_agent: str, *, service: str = "remote", context: str = "") -> dict | None:
    return cover_provider_http._http_get_json(
        url,
        user_agent,
        service=service,
        context=context,
        app_event_logger=log_app_event,
        append_apple_request_trace=cover_provider_apple.append_apple_request_trace,
    )


def _http_get_text(url: str, user_agent: str, *, service: str = "remote", context: str = "") -> str | None:
    return cover_provider_http._http_get_text(
        url,
        user_agent=user_agent,
        service=service,
        context=context,
        app_event_logger=log_app_event,
        append_apple_request_trace=cover_provider_apple.append_apple_request_trace,
    )


def _http_get_text_with_url(url: str, user_agent: str, *, service: str = "remote", context: str = "") -> tuple[str | None, str]:
    return cover_provider_http._http_get_text_with_url(
        url,
        user_agent=user_agent,
        service=service,
        context=context,
        app_event_logger=log_app_event,
        append_apple_request_trace=cover_provider_apple.append_apple_request_trace,
    )


def _probe_candidate_metrics(url: str, *, user_agent: str, service: str, context: str) -> dict[str, object] | None:
    raw_bytes = _http_get_bytes(
        url,
        user_agent=user_agent,
        service=service,
        context=context,
    )
    if not raw_bytes:
        return None
    decoded = decode_image_bytes(raw_bytes)
    if decoded is None:
        return None
    img, width, height = decoded
    try:
        sharpness = measure_image_sharpness(img)
    finally:
        try:
            img.close()
        except Exception:
            pass
    return {
        "raw_bytes": raw_bytes,
        "width": width,
        "height": height,
        "area": width * height,
        "sharpness": sharpness,
    }


def _probe_match_candidates(
    *,
    source: str,
    matches: list[tuple[float, str, dict]],
    user_agent: str,
    query_mode: str,
    artist: str,
    album: str,
    year: int | None,
    raw_results: list[dict] | None = None,
    probe_limit: int | None = 5,
    use_score_cutoff: bool = True,
) -> list[CoverCandidate]:
    positive_matches = [item for item in matches if item[0] > 0 and item[1]]
    if not positive_matches:
        return []
    if source == "apple":
        positive_matches = cover_provider_apple.dedupe_apple_matches(positive_matches)
    year_preferred_matches = cover_provider_matching.prefer_release_year_matches(
        positive_matches,
        target_year=year,
    )
    if not year_preferred_matches:
        return []
    best_score = year_preferred_matches[0][0]
    if use_score_cutoff:
        cutoff = cover_provider_matching.strong_match_cutoff(best_score)
        contenders = [item for item in year_preferred_matches if item[0] >= cutoff]
    else:
        cutoff = 0.0
        contenders = list(year_preferred_matches)
    if probe_limit is not None:
        contenders = contenders[:max(1, int(probe_limit or 1))]
    _LOGGER.verbose(
        "Cover candidate probe start source=%s artist=%r album=%r year=%r query_mode=%s best_score=%.4f cutoff=%.4f contenders=%s",
        source,
        artist,
        album,
        year,
        query_mode,
        best_score,
        cutoff,
        [
            {
                "score": round(score, 4),
                "url": url,
            }
            for score, url, _meta in contenders
        ],
    )
    candidates: list[CoverCandidate] = []
    probed_results: list[dict[str, object]] = []
    for score, url, meta in contenders:
        prefetched_raw_bytes = meta.get("prefetched_raw_bytes") if isinstance(meta, dict) else None
        prefetched_width = int(meta.get("prefetched_width") or 0) if isinstance(meta, dict) else 0
        prefetched_height = int(meta.get("prefetched_height") or 0) if isinstance(meta, dict) else 0
        prefetched_area = int(meta.get("prefetched_area") or 0) if isinstance(meta, dict) else 0
        prefetched_sharpness = float(meta.get("prefetched_sharpness") or 0.0) if isinstance(meta, dict) else 0.0
        probe_urls = meta.get("probe_urls") if isinstance(meta, dict) else None
        candidate_probe_urls = [
            normalize_remote_image_url(str(candidate_url or "").strip())
            for candidate_url in (probe_urls if isinstance(probe_urls, list) else [url])
        ]
        candidate_probe_urls = [candidate_url for candidate_url in candidate_probe_urls if candidate_url]
        if isinstance(prefetched_raw_bytes, bytes) and prefetched_width > 0 and prefetched_height > 0:
            raw_bytes = prefetched_raw_bytes
            width = prefetched_width
            height = prefetched_height
            area = prefetched_area or (width * height)
            sharpness = prefetched_sharpness
            successful_url = normalize_remote_image_url(str(url or "").strip())
        else:
            metrics = None
            successful_url = ""
            for probe_index, probe_url in enumerate(candidate_probe_urls, start=1):
                metrics = _probe_candidate_metrics(
                    probe_url,
                    user_agent=user_agent,
                    service=source,
                    context=f"probe:{query_mode}:{artist} - {album}",
                )
                if metrics:
                    successful_url = probe_url
                    if probe_index > 1:
                        log_app_event(
                            {},
                            _LOGGER,
                            f"{source.title()} probe fallback succeeded",
                            level="info",
                            artist=artist,
                            album=album,
                            year=year,
                            query_mode=query_mode,
                            score=round(float(score or 0.0), 4),
                            probe_url=probe_url,
                            attempted_urls=candidate_probe_urls,
                            attempt_index=probe_index,
                        )
                    break
            if not metrics:
                _LOGGER.verbose(
                    "Cover candidate probe no-bytes source=%s artist=%r album=%r year=%r score=%.4f url=%s attempted_urls=%s",
                    source,
                    artist,
                    album,
                    year,
                    score,
                    url,
                    candidate_probe_urls,
                )
                if source == "deezer":
                    log_app_event(
                        {},
                        _LOGGER,
                        "Deezer probe rejected candidate",
                        level="info",
                        artist=artist,
                        album=album,
                        year=year,
                        query_mode=query_mode,
                        score=round(float(score or 0.0), 4),
                        attempted_urls=candidate_probe_urls,
                        candidate_artist=str(meta.get("artist") or meta.get("artistName") or ""),
                        candidate_album=str(meta.get("album") or meta.get("collectionName") or meta.get("title") or ""),
                    )
                continue
            raw_bytes = metrics["raw_bytes"]
            width = int(metrics["width"])
            height = int(metrics["height"])
            area = int(metrics["area"])
            sharpness = float(metrics["sharpness"])
        if not raw_bytes:
            continue
        candidate_meta = {
            "score": round(score, 4),
            "width": width,
            "height": height,
            "area": area,
            "sharpness": round(sharpness, 4),
            "album": str(meta.get("album") or meta.get("collectionName") or meta.get("title") or ""),
            "artist": str(meta.get("artist") or meta.get("artistName") or ""),
            "url": successful_url or normalize_remote_image_url(str(url or "").strip()),
        }
        candidate_year = cover_provider_matching.parse_year(meta.get("year") or meta.get("releaseDate"))
        if candidate_year is not None:
            candidate_meta["year"] = candidate_year
        variant = str(meta.get("variant") or "")
        if variant:
            candidate_meta["variant"] = variant
        album_url = str(meta.get("album_url") or meta.get("collectionViewUrl") or "")
        if album_url:
            candidate_meta["album_url"] = album_url
        probed_results.append(candidate_meta)
        _LOGGER.verbose(
            "Cover candidate probe result source=%s artist=%r album=%r year=%r result=%s",
            source,
            artist,
            album,
            year,
            candidate_meta,
        )
        candidate_debug_payload = dict(meta) if isinstance(meta, dict) else {}
        candidate_debug_payload.update({
            "query_mode": query_mode,
            "raw_results": raw_results or [],
            "probed_contenders": list(probed_results),
            "variant": variant,
            "album_url": album_url,
        })
        candidates.append(
            CoverCandidate(
                source=source,
                url=successful_url or normalize_remote_image_url(str(url or "").strip()),
                score=score,
                width=width,
                height=height,
                raw_bytes=raw_bytes,
                matched_artist=str(candidate_meta.get("artist") or ""),
                matched_album=str(candidate_meta.get("album") or ""),
                matched_year=candidate_year,
                debug_payload=candidate_debug_payload,
            )
        )
        if (
            source == "apple"
            and use_score_cutoff
            and candidates
            and score >= best_score - 0.03
            and cover_provider_apple.apple_candidate_is_sufficient({
                "width": width,
                "height": height,
                "sharpness": sharpness,
            })
        ):
            break
    return candidates


def _select_largest_candidate(
    *,
    source: str,
    matches: list[tuple[float, str, dict]],
    user_agent: str,
    query_mode: str,
    artist: str,
    album: str,
    year: int | None,
    raw_results: list[dict] | None = None,
) -> CoverCandidate | None:
    candidates = _probe_match_candidates(
        source=source,
        matches=matches,
        user_agent=user_agent,
        query_mode=query_mode,
        artist=artist,
        album=album,
        year=year,
        raw_results=raw_results,
        probe_limit=_APPLE_MAX_PROBE_CONTENDERS if source == "apple" else 5,
        use_score_cutoff=True,
    )
    if not candidates:
        return None
    best_candidate = cover_provider_matching.select_largest_candidate(candidates)
    if best_candidate is None:
        return None
    _LOGGER.verbose(
        "Cover candidate selected source=%s artist=%r album=%r year=%r query_mode=%s score=%.4f width=%s height=%s url=%s",
        source,
        artist,
        album,
        year,
        query_mode,
        best_candidate.score,
        best_candidate.width,
        best_candidate.height,
        best_candidate.url,
    )
    return best_candidate


def _search_apple(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    allow_web_fallback: bool,
) -> CoverCandidate | None:
    return cover_provider_apple.search_apple(
        artist,
        album,
        edition,
        year,
        user_agent,
        allow_web_fallback=allow_web_fallback,
        build_query_variants=cover_provider_matching.build_query_variants,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        similarity=cover_provider_matching.similarity,
        probe_candidate_metrics=_probe_candidate_metrics,
        select_largest_candidate=_select_largest_candidate,
        http_get_json=_http_get_json,
        http_get_text=_http_get_text,
        http_get_text_with_url=_http_get_text_with_url,
        extract_og_image=cover_provider_fallback_web.extract_og_image,
        album_name_in_alt=cover_provider_matching.album_name_in_alt,
        log_event=log_app_event,
        logger=_LOGGER,
    )


def _search_deezer(artist: str, album: str, edition: str | None, year: int | None, user_agent: str) -> CoverCandidate | None:
    return cover_provider_deezer.search_deezer_cover(
        artist,
        album,
        edition,
        year,
        user_agent,
        http_get_json=_http_get_json,
        build_query_variants=cover_provider_matching.build_query_variants,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        select_largest_candidate=_select_largest_candidate,
    )


def _spotify_api_enabled() -> bool:
    return cover_provider_spotify.spotify_api_enabled(config=Config)


def _spotify_request_json(url: str, *, method: str, headers: dict[str, str], data: bytes | None = None, context: str = "") -> dict | None:
    return cover_provider_spotify.spotify_request_json(
        url,
        method=method,
        headers=headers,
        data=data,
        context=context,
        logger=_LOGGER,
        log_event=log_app_event,
    )


def _spotify_access_token() -> str | None:
    return cover_provider_spotify.spotify_access_token(
        config=Config,
        api_enabled=_spotify_api_enabled,
        request_json=_spotify_request_json,
        log_event=log_app_event,
    )


def _spotify_api_get(path: str, *, params: dict[str, object] | None = None) -> dict | None:
    return cover_provider_spotify.spotify_api_get(
        path,
        params=params,
        access_token=_spotify_access_token,
        request_json=_spotify_request_json,
        log_event=log_app_event,
    )


def _spotify_collect_album_matches(
    query_text: str,
    *,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    enforce_year: bool,
    query_mode: str,
) -> tuple[list[tuple[float, str, dict]], list[dict]]:
    return cover_provider_spotify.spotify_collect_album_matches(
        query_text,
        artist=artist,
        album=album,
        edition=edition,
        year=year,
        enforce_year=enforce_year,
        query_mode=query_mode,
        config=Config,
        api_get=_spotify_api_get,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        log_event=log_app_event,
    )


def _spotify_collect_artist_album_matches(
    query_artist: str,
    *,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    enforce_year: bool,
    query_mode: str,
) -> tuple[list[tuple[float, str, dict]], list[dict]]:
    return cover_provider_spotify.spotify_collect_artist_album_matches(
        query_artist,
        artist=artist,
        album=album,
        edition=edition,
        year=year,
        enforce_year=enforce_year,
        query_mode=query_mode,
        config=Config,
        api_get=_spotify_api_get,
        similarity=cover_provider_matching.similarity,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        log_event=log_app_event,
    )


def _search_spotify(artist: str, album: str, edition: str | None, year: int | None, user_agent: str) -> CoverCandidate | None:
    return cover_provider_spotify.search_spotify(
        artist,
        album,
        edition,
        year,
        user_agent,
        config=Config,
        api_enabled=_spotify_api_enabled,
        global_rate_limit_active=cover_provider_spotify.spotify_global_rate_limit_active,
        reset_rate_limit_state=cover_provider_spotify.reset_spotify_rate_limit_state,
        rate_limited=cover_provider_spotify.spotify_rate_limited,
        search_timed_out=cover_provider_spotify.spotify_search_timed_out,
        build_query_variants=cover_provider_matching.build_query_variants,
        collect_album_matches=_spotify_collect_album_matches,
        collect_artist_album_matches=_spotify_collect_artist_album_matches,
        select_largest_candidate=_select_largest_candidate,
        log_event=log_app_event,
    )


def search_primary_remote_cover(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    allow_apple_web_fallback: bool,
    has_local_cover: bool,
    candidate_callback: Callable[..., object] | None = None,
    logger=None,
) -> tuple[CoverCandidate | None, list[dict[str, object]]]:
    resolver_trace: list[dict[str, object]] = []
    primary_resolvers: list[tuple[str, str, object]] = [
        (
            "apple",
            "_search_apple",
            lambda a, b, e, y, ua: _search_apple(
                a,
                b,
                e,
                y,
                ua,
                allow_web_fallback=allow_apple_web_fallback,
            ),
        ),
        ("deezer", "_search_deezer", _search_deezer),
        ("spotify", "_search_spotify", _search_spotify),
    ]
    enabled_service_names = normalize_enabled_music_services(Config.ENABLED_MUSIC_SERVICES)
    primary_resolvers = [
        item
        for item in primary_resolvers
        if not enabled_service_names or item[0] in enabled_service_names
    ]
    primary_resolvers = cover_provider_matching.order_provider_items(
        primary_resolvers,
        order=cover_provider_matching.AUTOMATIC_PRIMARY_PROVIDER_ORDER,
        provider_name=lambda item: item[0],
    )
    primary_candidates: list[CoverCandidate] = []
    effective_logger = logger or _LOGGER
    for _provider_name, resolver_name, resolver in primary_resolvers:
        started_at = time.perf_counter()
        apple_trace_enabled = resolver_name == "_search_apple"
        if apple_trace_enabled:
            cover_provider_apple.begin_apple_request_trace()
        try:
            candidate = resolver(artist, album, edition, year, user_agent)
        except Exception as exc:
            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            resolver_trace.append({
                "resolver": resolver_name,
                "elapsed_ms": elapsed_ms,
                "status": "exception",
                "error": str(exc),
            })
            if apple_trace_enabled:
                apple_trace = cover_provider_apple.finish_apple_request_trace()
                if apple_trace:
                    resolver_trace[-1]["apple_http_trace"] = apple_trace
            effective_logger.warning(
                "Cover resolver crashed resolver=%s artist=%r album=%r edition=%r year=%r error=%r",
                resolver_name,
                artist,
                album,
                edition,
                year,
                exc,
            )
            candidate = None
        else:
            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            trace_item: dict[str, object] = {
                "resolver": resolver_name,
                "elapsed_ms": elapsed_ms,
                "status": "matched" if candidate else "no_candidate",
            }
            if apple_trace_enabled:
                apple_trace = cover_provider_apple.finish_apple_request_trace()
                if apple_trace and (elapsed_ms >= 3000 or not candidate):
                    trace_item["apple_http_trace"] = apple_trace
            if candidate:
                trace_item["candidate_source"] = candidate.source
                trace_item["candidate_score"] = round(candidate.score, 4)
                trace_item["matched_artist"] = candidate.matched_artist
                trace_item["matched_album"] = candidate.matched_album
                trace_item["candidate_width"] = int(candidate.width or 0)
                trace_item["candidate_height"] = int(candidate.height or 0)
                trace_item["acceptable"] = cover_provider_matching.cover_candidate_is_acceptable(
                    candidate,
                    apple_sufficient_cover_edge=_APPLE_SUFFICIENT_COVER_EDGE,
                    min_authoritative_cover_edge=_MIN_AUTHORITATIVE_COVER_EDGE,
                )
                if candidate.matched_year is not None:
                    trace_item["matched_year"] = candidate.matched_year
            resolver_trace.append(trace_item)
        if candidate:
            if candidate_callback is not None:
                try:
                    candidate_callback(candidate)
                except Exception as exc:
                    effective_logger.warning(
                        "Cover candidate publication failed resolver=%s artist=%r album=%r error=%r",
                        resolver_name,
                        artist,
                        album,
                        exc,
                    )
            primary_candidates.append(candidate)
            if cover_provider_matching.cover_candidate_is_acceptable(
                candidate,
                apple_sufficient_cover_edge=_APPLE_SUFFICIENT_COVER_EDGE,
                min_authoritative_cover_edge=_MIN_AUTHORITATIVE_COVER_EDGE,
            ):
                return candidate, resolver_trace

    if not primary_candidates:
        return None, resolver_trace
    return cover_provider_matching.select_primary_cover_candidate(
        primary_candidates,
        provider_order=cover_provider_matching.AUTOMATIC_PRIMARY_PROVIDER_ORDER,
        apple_sufficient_cover_edge=_APPLE_SUFFICIENT_COVER_EDGE,
        min_authoritative_cover_edge=_MIN_AUTHORITATIVE_COVER_EDGE,
    ), resolver_trace


def suspicious_positive_cache_entry(
    cached: dict[str, object],
    *,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
) -> bool:
    cached_url = str(cached.get("url") or "").strip()
    cached_source = str(cached.get("source") or "").strip()
    cached_artist = str(cached.get("matched_artist") or "").strip()
    cached_album = str(cached.get("matched_album") or "").strip()
    cached_year = cover_provider_matching.parse_year(cached.get("matched_year"))
    if not cached_url or not cached_source:
        return True
    if not cached_artist or not cached_album:
        return True
    return cover_provider_matching.match_score(
        target_artist=artist,
        target_album=album,
        target_edition=edition,
        target_year=year,
        candidate_artist=cached_artist,
        candidate_album=cached_album,
        candidate_year=cached_year,
        enforce_year=bool(year and cached_year),
    ) <= 0


def _write_cover_jpg(folder: Path, raw_bytes: bytes) -> Path | None:
    return write_remote_cover_bytes_as_authoritative_cover(folder, raw_bytes)


def _should_replace_local_cover(
    local_cover: Path | None,
    *,
    local_area: int,
    local_sharpness: float,
    remote_area: int,
    remote_sharpness: float,
) -> tuple[bool, str]:
    if local_cover is None or local_area <= 0:
        return True, "missing_or_invalid_local_cover"
    if is_low_quality_cover_name(local_cover):
        return True, "low_quality_local_cover_name"
    if not is_authoritative_cover_name(local_cover):
        if local_area >= remote_area and local_sharpness >= remote_sharpness:
            return False, "local_noncover_beats_remote"
        return True, "remote_beats_noncover_local"
    if remote_area > local_area:
        return True, "remote_larger_than_local"
    if remote_area >= local_area and remote_sharpness > local_sharpness * 1.05:
        return True, "remote_sharper_same_size"
    if remote_area >= int(local_area * 0.95) and remote_sharpness > local_sharpness * 1.2:
        return True, "remote_much_sharper_similar_size"
    return False, "remote_not_better_than_local"


def ensure_best_cover_for_folder(
    folder: Path,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    image_extensions: set[str],
    cache: CoverSearchCache,
    user_agent: str,
    force_search: bool = False,
    allow_apple_web_fallback: bool = False,
    allow_apple_web_fallback_when_has_cover: bool = True,
    negative_cache_ttl_seconds: float | None = None,
    enabled_provider_groups: object = None,
    cover_selection_origin: str = "automatic",
    reject_if_user_controlled: bool = False,
    *,
    candidate_callback: Callable[..., object] | None = None,
    automatic_write_guard: Callable[..., object] | None = None,
    search_remote_cover_func: SearchRemoteCover = search_primary_remote_cover,
    http_get_bytes_func: HttpGetBytes = _http_get_bytes,
    decode_image_func: DecodeImage = decode_image_bytes,
    write_cover_func: WriteCover = _write_cover_jpg,
    suspicious_cache_entry_func: SuspiciousCacheEntry = suspicious_positive_cache_entry,
    logger=None,
) -> tuple[Path | None, bool, dict[str, object]]:
    effective_logger = logger or _LOGGER
    normalized_cover_selection_origin = str(
        cover_selection_origin or "automatic"
    ).strip().casefold()
    user_controls_cover = (
        reject_if_user_controlled and normalized_cover_selection_origin == "user"
    )
    fetch_started_at = time.perf_counter()
    local_cover = find_cover_image(folder, image_extensions)
    local_area = image_area(local_cover) if local_cover else 0
    local_sharpness = image_sharpness(local_cover) if local_cover else 0.0
    local_cover_stem = cover_stem(local_cover) if local_cover else ""
    detail: dict[str, object] = {
        "artist": artist,
        "album": album,
        "edition": edition or "",
        "year": year,
        "folder": str(folder),
        "force_search": force_search,
        "local_cover": str(local_cover) if local_cover else None,
        "local_cover_stem": local_cover_stem,
        "local_area": local_area,
        "local_sharpness": round(local_sharpness, 4),
        "reason": "",
    }
    if not cover_provider_group_enabled(enabled_provider_groups, "music_services"):
        detail["reason"] = "remote_provider_group_disabled"
        detail["elapsed_ms"] = round((time.perf_counter() - fetch_started_at) * 1000, 2)
        return local_cover, False, detail
    if not artist.strip() or not album.strip():
        detail["reason"] = "missing_artist_or_album"
        _log_verbose(effective_logger,
            "Cover fetch skipped folder=%r artist=%r album=%r year=%r reason=%s",
            str(folder),
            artist,
            album,
            year,
            detail["reason"],
        )
        return local_cover, False, detail

    cache_key = cover_provider_cache.cover_query_key(artist, album, edition, year)
    cached = cache.get(cache_key)
    now = time.time()
    local_cover_needs_refresh = local_cover_requires_upgrade_check(local_cover, cached)
    detail["cache_key"] = cache_key
    detail["local_cover_needs_refresh"] = local_cover_needs_refresh
    effective_negative_cache_ttl_seconds = float(
        _NEGATIVE_CACHE_TTL_SECONDS if negative_cache_ttl_seconds is None else negative_cache_ttl_seconds
    )
    detail["negative_cache_ttl_seconds"] = effective_negative_cache_ttl_seconds
    effective_allow_apple_web_fallback = allow_apple_web_fallback and (
        local_cover is None or allow_apple_web_fallback_when_has_cover
    )
    detail["apple_web_fallback_enabled"] = effective_allow_apple_web_fallback
    if cached and not force_search:
        updated_at = float(cached.get("updated_at") or 0.0)
        is_missing = bool(cached.get("missing"))
        if not is_missing:
            if suspicious_cache_entry_func(
                cached,
                artist=artist,
                album=album,
                edition=edition,
                year=year,
            ):
                detail["reason"] = "suspicious_positive_cache_entry"
                detail["cache_suspicious"] = True
                effective_logger.warning(
                    "Cover fetch ignoring suspicious cache entry folder=%r artist=%r album=%r year=%r cache_key=%r source=%r matched_artist=%r matched_album=%r matched_year=%r",
                    str(folder),
                    artist,
                    album,
                    year,
                    cache_key,
                    str(cached.get("source") or ""),
                    str(cached.get("matched_artist") or ""),
                    str(cached.get("matched_album") or ""),
                    cached.get("matched_year"),
                )
            elif user_controls_cover:
                detail["cache_bypassed"] = True
                _log_verbose(
                    effective_logger,
                    "Cover fetch bypassing positive cache for user-controlled cover folder=%r artist=%r album=%r year=%r cache_key=%r",
                    str(folder),
                    artist,
                    album,
                    year,
                    cache_key,
                )
            elif local_cover and local_area > 0 and not local_cover_needs_refresh:
                detail["reason"] = "successful_cache_and_local_cover_present"
                _log_verbose(effective_logger,
                    "Cover fetch skipped folder=%r artist=%r album=%r year=%r reason=%s cache_key=%r local_cover=%r local_area=%s",
                    str(folder),
                    artist,
                    album,
                    year,
                    detail["reason"],
                    cache_key,
                    str(local_cover),
                    local_area,
                )
                return local_cover, False, detail
            else:
                detail["reason"] = "positive_cache_restore_disabled"
                detail["cache_bypassed"] = True
                detail["cached_url"] = str(cached.get("url") or "")
                _log_verbose(effective_logger,
                    "Cover fetch bypassing positive cache restore folder=%r artist=%r album=%r year=%r cache_key=%r source=%r",
                    str(folder),
                    artist,
                    album,
                    year,
                    cache_key,
                    str(cached.get("source") or ""),
                )
        if updated_at and now - updated_at <= effective_negative_cache_ttl_seconds:
            if is_missing:
                detail["reason"] = "negative_cache_ttl_active"
                detail["cache_age_seconds"] = round(now - updated_at, 2)
                detail["cache_ttl_seconds"] = effective_negative_cache_ttl_seconds
                _log_verbose(effective_logger,
                    "Cover fetch skipped folder=%r artist=%r album=%r year=%r reason=%s cache_key=%r age_seconds=%s ttl_seconds=%s",
                    str(folder),
                    artist,
                    album,
                    year,
                    detail["reason"],
                    cache_key,
                    round(now - updated_at, 2),
                    effective_negative_cache_ttl_seconds,
                )
                return local_cover, False, detail
    elif cached and force_search:
        detail["cache_bypassed"] = True
        _log_verbose(effective_logger,
            "Cover fetch bypassing cache folder=%r artist=%r album=%r year=%r cache_key=%r force_search=%s missing=%s",
            str(folder),
            artist,
            album,
            year,
            cache_key,
            force_search,
            bool(cached.get("missing")),
        )

    candidate, resolver_trace = search_remote_cover_func(
        artist=artist,
        album=album,
        edition=edition,
        year=year,
        user_agent=user_agent,
        allow_apple_web_fallback=effective_allow_apple_web_fallback,
        has_local_cover=local_cover is not None,
        candidate_callback=candidate_callback,
        logger=effective_logger,
    )
    detail["resolver_trace"] = resolver_trace
    if not candidate:
        detail["reason"] = "remote_search_returned_no_candidate"
        detail["elapsed_ms"] = round((time.perf_counter() - fetch_started_at) * 1000, 2)
        cache.set(cache_key, {"updated_at": now, "missing": True})
        return local_cover, False, detail
    detail["source"] = candidate.source
    detail["candidate_url"] = candidate.url
    if candidate.debug_payload:
        for key, value in current_use_candidate_debug_payload(candidate.debug_payload).items():
            detail[f"debug_{key}"] = value
    raw_bytes = candidate.raw_bytes
    if raw_bytes is None:
        raw_bytes = http_get_bytes_func(
            candidate.url,
            user_agent=user_agent,
            service=candidate.source,
            context=f"cover-download:{artist} - {album}",
        )
    if not raw_bytes:
        detail["reason"] = "candidate_download_failed"
        detail["elapsed_ms"] = round((time.perf_counter() - fetch_started_at) * 1000, 2)
        cache.set(cache_key, {"updated_at": now, "missing": True})
        return local_cover, False, detail

    decoded = decode_image_func(raw_bytes)
    if decoded is None:
        detail["reason"] = "candidate_decode_failed"
        detail["elapsed_ms"] = round((time.perf_counter() - fetch_started_at) * 1000, 2)
        cache.set(cache_key, {"updated_at": now, "missing": True})
        return local_cover, False, detail

    img, width, height = decoded
    try:
        remote_width = int(candidate.width or width)
        remote_height = int(candidate.height or height)
        remote_area = remote_width * remote_height
        remote_sharpness = measure_image_sharpness(img)
        detail["remote_width"] = remote_width
        detail["remote_height"] = remote_height
        detail["remote_area"] = remote_area
        detail["remote_sharpness"] = round(remote_sharpness, 4)
        _log_verbose(effective_logger,
            "Cover fetch candidate ready folder=%r artist=%r album=%r year=%r source=%s width=%s height=%s remote_area=%s local_area=%s remote_sharpness=%.4f local_sharpness=%.4f",
            str(folder),
            artist,
            album,
            year,
            candidate.source,
            width,
            height,
            remote_area,
            local_area,
            remote_sharpness,
            local_sharpness,
        )
        cache.set(cache_key, {
            "updated_at": now,
            "missing": False,
            "source": candidate.source,
            "url": candidate.url,
            "width": width,
            "height": height,
            "matched_artist": candidate.matched_artist,
            "matched_album": candidate.matched_album,
            "matched_year": candidate.matched_year,
            "managed_cover_written": False,
            "managed_cover_width": 0,
            "managed_cover_height": 0,
            "managed_cover_stem": "",
        })
        should_replace, comparison_reason = _should_replace_local_cover(
            local_cover,
            local_area=local_area,
            local_sharpness=local_sharpness,
            remote_area=remote_area,
            remote_sharpness=remote_sharpness,
        )
        detail["comparison_reason"] = comparison_reason
        if not should_replace:
            detail["reason"] = comparison_reason
            detail["elapsed_ms"] = round((time.perf_counter() - fetch_started_at) * 1000, 2)
            _log_verbose(effective_logger,
                "Cover fetch skipped write folder=%r artist=%r album=%r year=%r reason=%s source=%s remote_area=%s local_area=%s remote_sharpness=%.4f local_sharpness=%.4f",
                str(folder),
                artist,
                album,
                year,
                detail["reason"],
                candidate.source,
                remote_area,
                local_area,
                remote_sharpness,
                local_sharpness,
            )
            return local_cover, False, detail

        def publish_automatic_improvement() -> None:
            if candidate_callback is not None:
                try:
                    candidate_callback(candidate, automatic_improvement=True)
                except Exception as exc:
                    effective_logger.warning(
                        "Cover improvement publication failed artist=%r album=%r source=%s error=%r",
                        artist,
                        album,
                        candidate.source,
                        exc,
                    )

        preserve_user_ownership = False
        expected_cover_revision = ""
        if user_controls_cover:
            if local_cover is None or not images_are_visually_similar(local_cover, raw_bytes):
                publish_automatic_improvement()
                detail["reason"] = "user_controlled_improvement_available"
                detail["elapsed_ms"] = round(
                    (time.perf_counter() - fetch_started_at) * 1000,
                    2,
                )
                return local_cover, False, detail
            preserve_user_ownership = True
            expected_cover_revision = cover_revision_for_path(local_cover)
            detail["same_art_quality_upgrade"] = True

        if reject_if_user_controlled and automatic_write_guard is None:
            detail["reason"] = "automatic_write_guard_unavailable"
            detail["elapsed_ms"] = round(
                (time.perf_counter() - fetch_started_at) * 1000,
                2,
            )
            return local_cover, False, detail

        production_write = write_cover_func in {
            _write_cover_jpg,
            write_remote_cover_bytes_as_authoritative_cover,
        }
        prepared_write_bytes = (
            prepare_remote_cover_bytes_for_authoritative_write(raw_bytes)
            if production_write
            else raw_bytes
        )
        if prepared_write_bytes is None:
            detail["reason"] = "candidate_encode_failed"
            detail["elapsed_ms"] = round(
                (time.perf_counter() - fetch_started_at) * 1000,
                2,
            )
            return local_cover, False, detail

        def write_action():
            if production_write:
                return write_prepared_remote_cover_bytes(folder, prepared_write_bytes)
            return write_cover_func(folder, prepared_write_bytes)

        # The production guard uses these immutable inputs to stage the
        # targeted database update before the filesystem commit runs.
        write_action.selected_cover_path = folder / "cover.jpg"  # type: ignore[attr-defined]
        write_action.provisional_cover_revision = hashlib.sha256(prepared_write_bytes).hexdigest()  # type: ignore[attr-defined]
        write_action.preserve_user_ownership = preserve_user_ownership  # type: ignore[attr-defined]
        write_action.expected_cover_revision = expected_cover_revision  # type: ignore[attr-defined]
        write_action.prepared_cover_bytes = prepared_write_bytes  # type: ignore[attr-defined]
        if automatic_write_guard is not None:
            written = automatic_write_guard(
                write_action,
                cover_selection_origin="automatic",
            )
            if written is False:
                publish_automatic_improvement()
                detail["reason"] = "automatic_write_blocked_by_user_selection"
                detail["elapsed_ms"] = round(
                    (time.perf_counter() - fetch_started_at) * 1000,
                    2,
                )
                return local_cover or find_cover_image(folder, image_extensions), False, detail
        else:
            written = write_action()
        if written:
            cache.set(cache_key, {
                "updated_at": now,
                "missing": False,
                "source": candidate.source,
                "url": candidate.url,
                "width": width,
                "height": height,
                "matched_artist": candidate.matched_artist,
                "matched_album": candidate.matched_album,
                "matched_year": candidate.matched_year,
                "managed_cover_written": True,
                "managed_cover_width": remote_width,
                "managed_cover_height": remote_height,
                "managed_cover_stem": cover_stem(written),
            })
            detail["reason"] = "cover_written"
            detail["written_path"] = str(written)
            detail["elapsed_ms"] = round((time.perf_counter() - fetch_started_at) * 1000, 2)
            return written, True, detail
        detail["reason"] = "write_returned_no_file"
        detail["elapsed_ms"] = round((time.perf_counter() - fetch_started_at) * 1000, 2)
        return local_cover or find_cover_image(folder, image_extensions), False, detail
    finally:
        img.close()
