from __future__ import annotations

import logging
import time
from collections.abc import Callable
from pathlib import Path

from config import Config
from music_app.services import cover_provider_apple
from music_app.services import cover_provider_cache
from music_app.services import cover_provider_deezer
from music_app.services import cover_provider_fallback_web
from music_app.services import cover_provider_http
from music_app.services import cover_provider_matching
from music_app.services import cover_provider_musicbrainz_caa
from music_app.services import cover_provider_spotify
from music_app.services import cover_provider_youtube_music
from music_app.services import music_identity_matching
from music_app.services.app_logging import log_app_event
from music_app.services.cover_provider_candidates import CoverCandidate, normalize_remote_image_url
from music_app.services.cover_workflow import decode_image_bytes, write_remote_cover_bytes_as_authoritative_cover
from music_app.services.covers import measure_image_sharpness
from music_app.services.musicbrainz_http import get_json as musicbrainz_get_json

LOGGER = logging.getLogger(__name__)
MIN_AUTHORITATIVE_COVER_EDGE = cover_provider_matching.MIN_AUTHORITATIVE_COVER_EDGE
APPLE_SUFFICIENT_COVER_EDGE = cover_provider_apple._APPLE_SUFFICIENT_COVER_EDGE
APPLE_MAX_PROBE_CONTENDERS = cover_provider_apple._APPLE_MAX_PROBE_CONTENDERS


def http_get_bytes(
    url: str,
    user_agent: str,
    accept: str = "*/*",
    *,
    service: str = "remote",
    context: str = "",
    extra_headers: dict[str, str] | None = None,
) -> bytes | None:
    return cover_provider_http._http_get_bytes(
        url,
        user_agent=user_agent,
        accept=accept,
        service=service,
        context=context,
        extra_headers=extra_headers,
        logger=LOGGER,
        app_event_logger=log_app_event,
        append_apple_request_trace=cover_provider_apple.append_apple_request_trace,
        mark_discogs_rate_limited=cover_provider_discogs_mark_rate_limited,
    )


def http_get_json(
    url: str,
    user_agent: str,
    *,
    service: str = "remote",
    context: str = "",
    extra_headers: dict[str, str] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict | None:
    return cover_provider_http._http_get_json(
        url,
        user_agent,
        service=service,
        context=context,
        extra_headers=extra_headers,
        logger=LOGGER,
        app_event_logger=log_app_event,
        musicbrainz_json_getter=musicbrainz_get_json,
        http_get_bytes=http_get_bytes,
        should_cancel=should_cancel,
    )


def http_get_json_via_curl(url: str, *, user_agent: str, context: str = "") -> dict | None:
    return cover_provider_http._http_get_json_via_curl(
        url,
        user_agent=user_agent,
        context=context,
        logger=LOGGER,
        app_event_logger=log_app_event,
    )


def http_get_json_via_subprocess(
    url: str,
    *,
    user_agent: str,
    context: str = "",
    service: str = "remote",
) -> dict | None:
    return cover_provider_http._http_get_json_via_subprocess(
        url,
        user_agent=user_agent,
        context=context,
        service=service,
        logger=LOGGER,
        app_event_logger=log_app_event,
    )


def http_get_text(url: str, user_agent: str, *, service: str = "remote", context: str = "") -> str | None:
    return cover_provider_http._http_get_text(
        url,
        user_agent=user_agent,
        service=service,
        context=context,
        logger=LOGGER,
        http_get_bytes=http_get_bytes,
    )


def http_get_text_with_url(
    url: str,
    user_agent: str,
    *,
    service: str = "remote",
    context: str = "",
) -> tuple[str | None, str]:
    return cover_provider_http._http_get_text_with_url(
        url,
        user_agent=user_agent,
        service=service,
        context=context,
        logger=LOGGER,
        http_get_bytes=http_get_bytes,
    )


def cover_provider_discogs_mark_rate_limited() -> None:
    from music_app.services import cover_provider_discogs

    cover_provider_discogs.mark_discogs_rate_limited()


def discogs_api_get_json(
    url: str,
    user_agent: str,
    *,
    params: dict[str, object] | None = None,
    context: str = "",
) -> dict | None:
    from music_app.services import cover_provider_discogs

    return cover_provider_discogs.discogs_api_get_json(
        url,
        user_agent,
        params=params,
        context=context,
        config=Config,
        logger=LOGGER,
        app_event_logger=log_app_event,
        mark_rate_limited=cover_provider_discogs.mark_discogs_rate_limited,
    )


def probe_candidate_metrics(url: str, *, user_agent: str, service: str, context: str) -> dict[str, object] | None:
    raw_bytes = http_get_bytes(
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


def probe_match_candidates(
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
    should_cancel: Callable[[], bool] | None = None,
) -> list[CoverCandidate]:
    if callable(should_cancel) and should_cancel():
        return []
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
        contenders = contenders[: max(1, int(probe_limit or 1))]
    LOGGER.verbose(
        "Cover candidate probe start source=%s artist=%r album=%r year=%r query_mode=%s best_score=%.4f cutoff=%.4f contenders=%s",
        source,
        artist,
        album,
        year,
        query_mode,
        best_score,
        cutoff,
        [{"score": round(score, 4), "url": url} for score, url, _meta in contenders],
    )
    candidates: list[CoverCandidate] = []
    probed_results: list[dict[str, object]] = []
    for score, url, meta in contenders:
        if callable(should_cancel) and should_cancel():
            break
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
                if callable(should_cancel) and should_cancel():
                    break
                metrics = probe_candidate_metrics(
                    probe_url,
                    user_agent=user_agent,
                    service=source,
                    context=f"probe:{query_mode}:{artist} - {album}",
                )
                if callable(should_cancel) and should_cancel():
                    break
                if metrics:
                    successful_url = probe_url
                    if probe_index > 1:
                        log_app_event(
                            {},
                            LOGGER,
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
                LOGGER.verbose(
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
                        LOGGER,
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
        if callable(should_cancel) and should_cancel():
            break
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
        LOGGER.verbose(
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


def select_largest_candidate(
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
    candidates = probe_match_candidates(
        source=source,
        matches=matches,
        user_agent=user_agent,
        query_mode=query_mode,
        artist=artist,
        album=album,
        year=year,
        raw_results=raw_results,
        probe_limit=APPLE_MAX_PROBE_CONTENDERS if source == "apple" else 5,
        use_score_cutoff=True,
    )
    if not candidates:
        return None
    best_candidate = cover_provider_matching.select_largest_candidate(candidates)
    if best_candidate is None:
        return None
    LOGGER.verbose(
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


def search_apple_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    allow_web_fallback: bool = True,
    should_cancel: Callable[[], bool] | None = None,
) -> list[CoverCandidate]:
    return cover_provider_apple.search_apple_candidates(
        artist,
        album,
        edition,
        year,
        user_agent,
        allow_web_fallback=allow_web_fallback,
        should_cancel=should_cancel,
        build_query_variants=cover_provider_matching.build_query_variants,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        similarity=cover_provider_matching.similarity,
        probe_candidate_metrics=probe_candidate_metrics,
        probe_match_candidates=probe_match_candidates,
        http_get_json=http_get_json,
        http_get_text=http_get_text,
        http_get_text_with_url=http_get_text_with_url,
        extract_og_image=cover_provider_fallback_web.extract_og_image,
        album_name_in_alt=cover_provider_matching.album_name_in_alt,
        dedupe_candidates=cover_provider_matching.dedupe_candidates,
        log_event=log_app_event,
        logger=LOGGER,
    )


def search_deezer_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
) -> list[CoverCandidate]:
    return cover_provider_deezer.search_deezer_cover_candidates(
        artist,
        album,
        edition,
        year,
        user_agent,
        http_get_json=http_get_json,
        build_query_variants=cover_provider_matching.build_query_variants,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=probe_match_candidates,
        dedupe_candidates=cover_provider_matching.dedupe_candidates,
        log_event=log_app_event,
        logger=LOGGER,
    )


def youtube_music_client() -> object | None:
    return cover_provider_youtube_music.youtube_music_client(log_event=log_app_event, logger=LOGGER)


def search_youtube_music_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
) -> list[CoverCandidate]:
    return cover_provider_youtube_music.search_youtube_music_candidates(
        artist,
        album,
        edition,
        year,
        user_agent,
        client_getter=lambda **_kwargs: youtube_music_client(),
        build_query_variants=cover_provider_matching.build_query_variants,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=probe_match_candidates,
        dedupe_candidates=cover_provider_matching.dedupe_candidates,
        log_event=log_app_event,
        logger=LOGGER,
    )


def spotify_request_json(
    url: str,
    *,
    method: str,
    headers: dict[str, str],
    data: bytes | None = None,
    context: str = "",
) -> dict | None:
    return cover_provider_spotify.spotify_request_json(
        url,
        method=method,
        headers=headers,
        data=data,
        context=context,
        logger=LOGGER,
        log_event=log_app_event,
    )


def spotify_access_token() -> str | None:
    return cover_provider_spotify.spotify_access_token(
        config=Config,
        api_enabled=lambda: cover_provider_spotify.spotify_api_enabled(config=Config),
        request_json=spotify_request_json,
        log_event=log_app_event,
    )


def spotify_api_get(path: str, *, params: dict[str, object] | None = None) -> dict | None:
    return cover_provider_spotify.spotify_api_get(
        path,
        params=params,
        access_token=spotify_access_token,
        request_json=spotify_request_json,
        log_event=log_app_event,
    )


def spotify_collect_album_matches(
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
        api_get=spotify_api_get,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        log_event=log_app_event,
    )


def spotify_collect_artist_album_matches(
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
        api_get=spotify_api_get,
        similarity=cover_provider_matching.similarity,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        log_event=log_app_event,
    )


def search_spotify_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
) -> list[CoverCandidate]:
    return cover_provider_spotify.search_spotify_candidates(
        artist,
        album,
        edition,
        year,
        user_agent,
        api_enabled=lambda: cover_provider_spotify.spotify_api_enabled(config=Config),
        global_rate_limit_active=cover_provider_spotify.spotify_global_rate_limit_active,
        reset_rate_limit_state=cover_provider_spotify.reset_spotify_rate_limit_state,
        rate_limited=cover_provider_spotify.spotify_rate_limited,
        search_timed_out=cover_provider_spotify.spotify_search_timed_out,
        build_query_variants=cover_provider_matching.build_query_variants,
        collect_album_matches=spotify_collect_album_matches,
        collect_artist_album_matches=spotify_collect_artist_album_matches,
        probe_match_candidates=probe_match_candidates,
        dedupe_cover_candidates=cover_provider_matching.dedupe_candidates,
        log_event=log_app_event,
    )


def spotify_candidates_from_album_url(
    normalized_url: str,
    *,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
) -> list[CoverCandidate]:
    return cover_provider_spotify.spotify_candidates_from_album_url(
        normalized_url,
        target_artist=target_artist,
        target_album=target_album,
        target_edition=target_edition,
        target_year=target_year,
        config=Config,
        api_enabled=lambda: cover_provider_spotify.spotify_api_enabled(config=Config),
        api_get=spotify_api_get,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        log_event=log_app_event,
    )


def search_genius_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
) -> list[CoverCandidate]:
    return cover_provider_fallback_web.search_genius_candidates(
        artist,
        album,
        edition,
        year,
        user_agent,
        http_get_text=http_get_text,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=probe_match_candidates,
        dedupe_candidates=cover_provider_matching.dedupe_candidates,
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        extract_album_links=cover_provider_fallback_web.extract_genius_album_links_from_search_html,
        extract_album_page_metadata=cover_provider_fallback_web.extract_genius_album_page_metadata,
    )


def search_musicbrainz_release_candidates(
    *,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    result_limit: int = 20,
    include_labels: bool = False,
    context_prefix: str = "release-search",
    should_cancel: Callable[[], bool] | None = None,
) -> list[dict]:
    return cover_provider_musicbrainz_caa.search_musicbrainz_release_candidates(
        artist=artist,
        album=album,
        edition=edition,
        year=year,
        user_agent=user_agent,
        result_limit=result_limit,
        include_labels=include_labels,
        context_prefix=context_prefix,
        normalize=cover_provider_matching.normalize,
        http_get_json=http_get_json,
        get_disk_cache=cover_provider_cache._get_musicbrainz_release_disk_cache,
        set_disk_cache=cover_provider_cache._set_musicbrainz_release_disk_cache,
        log_event=log_app_event,
        should_cancel=should_cancel,
    )


def fetch_musicbrainz_release_context(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
) -> tuple[list[str], list[str]]:
    return cover_provider_musicbrainz_caa.fetch_musicbrainz_release_context(
        artist,
        album,
        edition,
        year,
        user_agent,
        normalize=cover_provider_matching.normalize,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        search_release_candidates=search_musicbrainz_release_candidates,
        log_event=log_app_event,
    )


def fetch_musicbrainz_bandcamp_context(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, list[str]]:
    return cover_provider_musicbrainz_caa.fetch_musicbrainz_bandcamp_context(
        artist,
        album,
        edition,
        year,
        user_agent,
        normalize=cover_provider_matching.normalize,
        similarity=music_identity_matching.artist_identity_similarity,
        match_score=cover_provider_matching.match_score,
        parse_year=cover_provider_matching.parse_year,
        search_release_candidates=search_musicbrainz_release_candidates,
        http_get_json=http_get_json,
        log_event=log_app_event,
        should_cancel=should_cancel,
    )


def search_cover_art_archive_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    limit: int = 8,
) -> list[dict[str, object]]:
    return cover_provider_musicbrainz_caa.search_cover_art_archive_candidates(
        artist,
        album,
        edition,
        year,
        user_agent,
        limit=limit,
        normalize=cover_provider_matching.normalize,
        parse_year=cover_provider_matching.parse_year,
        match_score=cover_provider_matching.match_score,
        normalize_remote_image_url=normalize_remote_image_url,
        probe_candidate_metrics=probe_candidate_metrics,
        http_get_json=http_get_json,
        http_get_json_via_curl=http_get_json_via_curl,
        http_get_json_via_subprocess=http_get_json_via_subprocess,
        get_caa_disk_cache=cover_provider_cache._get_caa_results_disk_cache,
        set_caa_disk_cache=cover_provider_cache._set_caa_results_disk_cache,
        search_musicbrainz_release_candidates=search_musicbrainz_release_candidates,
        log_event=log_app_event,
    )


def cover_candidate_is_acceptable(candidate: CoverCandidate | None) -> bool:
    return cover_provider_matching.cover_candidate_is_acceptable(
        candidate,
        apple_sufficient_cover_edge=APPLE_SUFFICIENT_COVER_EDGE,
        min_authoritative_cover_edge=MIN_AUTHORITATIVE_COVER_EDGE,
    )


def write_cover_jpg(folder: Path, raw_bytes: bytes) -> Path | None:
    return write_remote_cover_bytes_as_authoritative_cover(folder, raw_bytes)
