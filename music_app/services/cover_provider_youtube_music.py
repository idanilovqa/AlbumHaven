from __future__ import annotations

import logging
import re
import threading
import time
import urllib.parse
from collections.abc import Callable
from html import unescape

from music_app.services.app_logging import log_app_event
from music_app.services.cover_provider_availability import provider_availability
from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    dedupe_cover_candidates,
    normalize_remote_image_url,
)

try:
    from ytmusicapi import YTMusic
except ImportError:
    YTMusic = None

_LOGGER = logging.getLogger(__name__)
_YTMUSIC_CLIENT_LOCK = threading.Lock()
_YTMUSIC_CLIENT: object | bool | None = None

ClientGetter = Callable[..., object | None]
DedupeCandidates = Callable[[list[CoverCandidate]], list[CoverCandidate]]
ExtractMetaContent = Callable[..., str]
ExtractOgImage = Callable[[str], str | None]
HttpGetText = Callable[..., str | None]
LogEvent = Callable[..., None]
MatchScore = Callable[..., float]
ParseYear = Callable[[object], int | None]
ProbeCandidates = Callable[..., list[CoverCandidate]]
QueryVariants = Callable[[str, str, str | None, int | None], list[tuple[str, str, str | None, int | None]]]


def reset_youtube_music_client_state() -> None:
    global _YTMUSIC_CLIENT
    with _YTMUSIC_CLIENT_LOCK:
        _YTMUSIC_CLIENT = None


def youtube_music_enabled(*, config, youtube_music_client_class=None) -> bool:
    client_class = YTMusic if youtube_music_client_class is None else youtube_music_client_class
    return provider_availability("youtube_music", config=config, youtube_music_client_class=client_class).available


def youtube_music_client(
    *,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> object | None:
    if YTMusic is None:
        return None
    global _YTMUSIC_CLIENT
    cached_client = _YTMUSIC_CLIENT
    if cached_client is False:
        return None
    if cached_client is not None:
        return cached_client
    with _YTMUSIC_CLIENT_LOCK:
        cached_client = _YTMUSIC_CLIENT
        if cached_client is False:
            return None
        if cached_client is not None:
            return cached_client
        try:
            cached_client = YTMusic()
        except Exception as exc:
            _YTMUSIC_CLIENT = False
            _emit(
                log_event,
                logger,
                "YouTube Music client initialization failed",
                reason=type(exc).__name__,
                detail=str(exc),
            )
            return None
        _YTMUSIC_CLIENT = cached_client
        return cached_client


def youtube_music_artist_names(value: object) -> str:
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if name:
            parts.append(name)
    return ", ".join(parts)


def youtube_music_best_thumbnail(value: object) -> tuple[str, int, int] | None:
    if not isinstance(value, list):
        return None
    best_url = ""
    best_width = 0
    best_height = 0
    best_area = 0
    for item in value:
        if not isinstance(item, dict):
            continue
        raw_url = str(item.get("url") or "").strip()
        if not raw_url:
            continue
        width = int(item.get("width") or 0)
        height = int(item.get("height") or 0)
        area = (width * height) if width and height else 0
        if not best_url or area > best_area:
            best_url = _promote_googleusercontent_original_size(normalize_remote_image_url(raw_url))
            best_width = width
            best_height = height
            best_area = area
    if not best_url:
        return None
    return best_url, best_width, best_height


def extract_youtube_music_page_thumbnails(
    html: str,
    *,
    extract_og_image: ExtractOgImage,
) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()
    patterns = (
        r'https://(?:lh3\.googleusercontent\.com|yt3\.googleusercontent\.com)[^"\']+',
        r'https://i\.ytimg\.com/[^"\']+',
        r'https:\\/\\/(?:lh3\.googleusercontent\.com|yt3\.googleusercontent\.com|i\.ytimg\.com)[^"\']+',
        r'"thumbnailUrl"\s*:\s*"([^"]+)"',
        r'"og:image"\s+content="([^"]+)"',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, html or "", flags=re.IGNORECASE):
            raw_value = match.group(1) if match.groups() else match.group(0)
            candidate = _normalize_page_thumbnail(raw_value)
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            candidates.append(candidate)
    og_image = _normalize_page_thumbnail(extract_og_image(html) or "")
    if og_image and og_image not in seen:
        candidates.insert(0, og_image)
    return candidates


def search_youtube_music_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    client_getter: ClientGetter | None = None,
    build_query_variants: QueryVariants,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
    dedupe_candidates: DedupeCandidates = dedupe_cover_candidates,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> list[CoverCandidate]:
    active_logger = logger or _LOGGER
    getter = client_getter or youtube_music_client
    client = getter(log_event=log_event, logger=active_logger)
    if client is None:
        _emit(
            log_event,
            active_logger,
            "YouTube Music search skipped",
            artist=artist,
            album=album,
            year=year,
            reason="client_unavailable",
        )
        return []
    _emit(
        log_event,
        active_logger,
        "YouTube Music search started",
        artist=artist,
        album=album,
        year=year,
        edition=edition or "",
    )
    seen_queries: set[str] = set()
    candidates: list[CoverCandidate] = []
    for query_artist, query_album, query_edition, query_year in build_query_variants(artist, album, edition, year):
        queries = _build_search_queries(
            query_artist,
            query_album,
            query_edition,
            query_year,
            native_artist=artist,
            native_album=album,
        )
        for query_text, enforce_year, query_mode in queries:
            normalized_query = " ".join(str(query_text or "").split()).strip()
            if not normalized_query or normalized_query in seen_queries:
                continue
            seen_queries.add(normalized_query)
            _emit(
                log_event,
                active_logger,
                "YouTube Music search query issued",
                artist=artist,
                album=album,
                year=year,
                query=normalized_query,
                query_mode=query_mode,
                enforce_year=enforce_year,
            )
            try:
                started_at = time.perf_counter()
                raw_results = client.search(
                    normalized_query,
                    filter="albums",
                    limit=10,
                    ignore_spelling=True,
                ) or []
            except Exception as exc:
                _emit(
                    log_event,
                    active_logger,
                    "YouTube Music search failed",
                    artist=artist,
                    album=album,
                    year=year,
                    query=normalized_query,
                    query_mode=query_mode,
                    reason=type(exc).__name__,
                    detail=str(exc),
                )
                continue
            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            raw_result_count = len(raw_results) if isinstance(raw_results, list) else 0
            _emit(
                log_event,
                active_logger,
                "YouTube Music search results received",
                artist=artist,
                album=album,
                year=year,
                query=normalized_query,
                query_mode=query_mode,
                result_count=raw_result_count,
                elapsed_ms=elapsed_ms,
            )
            matches = _collect_result_matches(
                raw_results,
                artist=artist,
                album=album,
                edition=edition,
                year=year,
                enforce_year=enforce_year,
                query_mode=query_mode,
                match_score=match_score,
                parse_year=parse_year,
            )
            _emit(
                log_event,
                active_logger,
                "YouTube Music candidate summary",
                artist=artist,
                album=album,
                year=year,
                query=normalized_query,
                query_mode=query_mode,
                result_count=raw_result_count,
                viable_match_count=len(matches),
                top_results=[
                    {
                        "album": str((meta or {}).get("title") or ""),
                        "artist": youtube_music_artist_names((meta or {}).get("artists") or []),
                        "year": (meta or {}).get("year"),
                        "album_url": str((meta or {}).get("album_url") or ""),
                        "score": round(float(score or 0.0), 4),
                    }
                    for score, _image_url, meta in matches[:5]
                ],
            )
            if matches:
                _emit(
                    log_event,
                    active_logger,
                    "YouTube Music probe started",
                    artist=artist,
                    album=album,
                    year=year,
                    query=normalized_query,
                    query_mode=query_mode,
                    match_count=len(matches),
                )
                probed_candidates = probe_match_candidates(
                    source="youtube_music",
                    matches=matches,
                    user_agent=user_agent,
                    query_mode=query_mode,
                    artist=artist,
                    album=album,
                    year=year,
                    raw_results=[item for item in raw_results if isinstance(item, dict)],
                    probe_limit=None,
                    use_score_cutoff=False,
                )
                _emit(
                    log_event,
                    active_logger,
                    "YouTube Music probe completed",
                    artist=artist,
                    album=album,
                    year=year,
                    query=normalized_query,
                    query_mode=query_mode,
                    probed_candidate_count=len(probed_candidates),
                    selected_urls=[str(item.url or "") for item in probed_candidates[:5]],
                )
                candidates.extend(probed_candidates)
            else:
                _emit(
                    log_event,
                    active_logger,
                    "YouTube Music search found no viable matches",
                    artist=artist,
                    album=album,
                    year=year,
                    query=normalized_query,
                    query_mode=query_mode,
                )
    deduped_candidates = dedupe_candidates(candidates)
    _emit(
        log_event,
        active_logger,
        "YouTube Music search completed",
        artist=artist,
        album=album,
        year=year,
        candidate_count=len(deduped_candidates),
        raw_candidate_count=len(candidates),
    )
    return deduped_candidates


def youtube_music_candidates_from_page_url(
    normalized_url: str,
    *,
    user_agent: str,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    http_get_text: HttpGetText,
    extract_meta_content: ExtractMetaContent,
    extract_og_image: ExtractOgImage,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
) -> list[CoverCandidate] | None:
    split = urllib.parse.urlsplit(str(normalized_url or "").strip())
    if "music.youtube.com" not in split.netloc.casefold():
        return None
    html = http_get_text(
        normalized_url,
        user_agent,
        service="youtube_music",
        context=f"manual-page:{normalized_url}",
    )
    if not html:
        return []
    page_title = extract_meta_content(html, "og:title", "title").strip()
    page_description = extract_meta_content(html, "og:description", "description").strip()
    image_urls = extract_youtube_music_page_thumbnails(html, extract_og_image=extract_og_image)
    if not image_urls:
        return []
    score = match_score(
        target_artist=target_artist,
        target_album=target_album,
        target_edition=target_edition,
        target_year=target_year,
        candidate_artist=target_artist,
        candidate_album=page_title or target_album,
        candidate_year=parse_year(page_description or page_title),
        enforce_year=False,
    ) or 1.0
    return probe_match_candidates(
        source="youtube_music",
        matches=[
            (
                score,
                image_url,
                {
                    "album": page_title or target_album,
                    "artist": target_artist,
                    "year": target_year,
                    "album_url": normalized_url,
                    "variant": "manual-page",
                    "host": split.netloc,
                    "source_label": "YouTube Music",
                },
            )
            for image_url in image_urls
        ],
        user_agent=user_agent,
        query_mode="manual-youtube-music",
        artist=target_artist,
        album=target_album,
        year=target_year,
        probe_limit=max(1, len(image_urls)),
        use_score_cutoff=False,
    )


def _collect_result_matches(
    raw_results: object,
    *,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    enforce_year: bool,
    query_mode: str,
    match_score: MatchScore,
    parse_year: ParseYear,
) -> list[tuple[float, str, dict[str, object]]]:
    matches: list[tuple[float, str, dict[str, object]]] = []
    if not isinstance(raw_results, list):
        return matches
    for item in raw_results:
        if not isinstance(item, dict):
            continue
        browse_id = str(item.get("browseId") or "").strip()
        thumbnail = youtube_music_best_thumbnail(item.get("thumbnails"))
        if not browse_id or not thumbnail:
            continue
        image_url, _width, _height = thumbnail
        candidate_artist = youtube_music_artist_names(item.get("artists")) or artist
        candidate_album = str(item.get("title") or "").strip() or album
        candidate_year = parse_year(item.get("year"))
        score = match_score(
            target_artist=artist,
            target_album=album,
            target_edition=edition,
            target_year=year,
            candidate_artist=candidate_artist,
            candidate_album=candidate_album,
            candidate_year=candidate_year,
            enforce_year=enforce_year,
        )
        if score <= 0:
            continue
        album_url = f"https://music.youtube.com/browse/{browse_id}"
        matches.append(
            (
                score,
                image_url,
                {
                    "title": candidate_album,
                    "artists": item.get("artists") if isinstance(item.get("artists"), list) else [],
                    "year": candidate_year,
                    "browseId": browse_id,
                    "album_url": album_url,
                    "source_label": "YouTube Music",
                    "query_mode": query_mode,
                    "variant": "album-search",
                },
            )
        )
    matches.sort(key=lambda item: item[0], reverse=True)
    return matches


def _build_search_queries(
    query_artist: str,
    query_album: str,
    query_edition: str | None,
    query_year: int | None,
    *,
    native_artist: str,
    native_album: str,
) -> list[tuple[str, bool, str]]:
    query_suffix = "translit" if (query_artist, query_album) != (native_artist, native_album) else "native"
    query_album_text = " ".join(part for part in [query_album, query_edition or ""] if str(part).strip())
    queries: list[tuple[str, bool, str]] = []
    if query_year:
        queries.append((f"{query_artist} {query_album_text} {query_year}", True, f"artist+album+year:{query_suffix}"))
    queries.append((f"{query_artist} {query_album_text}", False, f"artist+album:{query_suffix}"))
    return queries


def _normalize_page_thumbnail(value: object) -> str:
    candidate = normalize_remote_image_url(unescape(str(value or "")).replace("\\/", "/").strip())
    if not candidate:
        return ""
    if any(token in candidate for token in ("/avatar-", "/channel_", "/photo.jpg")):
        return ""
    return _promote_original_size(candidate)


def _promote_googleusercontent_original_size(url: str) -> str:
    split = urllib.parse.urlsplit(url or "")
    if "yt3.googleusercontent.com" in split.netloc.casefold() and "=" in url:
        return re.sub(r"=([^/?#]+)$", "=s0", url)
    return url


def _promote_original_size(url: str) -> str:
    split = urllib.parse.urlsplit(url or "")
    if ("googleusercontent.com" in split.netloc.casefold() or "ytimg.com" in split.netloc.casefold()) and "=" in url:
        return re.sub(r"=([^/?#]+)$", "=s0", url)
    return url


def _emit(log_event: LogEvent | None, logger, action: str, **fields) -> None:
    if log_event is None:
        return
    log_event({}, logger or _LOGGER, action, level="info", **fields)
