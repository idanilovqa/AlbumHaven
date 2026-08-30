from __future__ import annotations

import base64
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

from config import Config
from music_app.services.app_logging import log_app_event
from music_app.services.cover_provider_availability import provider_availability
from music_app.services.cover_provider_candidates import CoverCandidate, normalize_remote_image_url
from music_app.services import music_identity_matching

_LOGGER = logging.getLogger(__name__)
_SPOTIFY_RATE_LIMIT_LOCAL = threading.local()
_SPOTIFY_TOKEN_CACHE_LOCK = threading.Lock()
_SPOTIFY_TOKEN_CACHE: dict[str, object] = {}
_SPOTIFY_REQUEST_PACING_LOCK = threading.Lock()
_SPOTIFY_REQUEST_PACING: dict[str, float] = {
    "next_allowed_at": 0.0,
    "rate_limited_until": 0.0,
}
_SPOTIFY_MIN_REQUEST_INTERVAL_SECONDS = 0.35
_SPOTIFY_SEARCH_TIMEOUT_SECONDS = 30.0

LogEvent = Callable[..., None]
RequestJson = Callable[..., dict | None]
ApiGet = Callable[..., dict | None]
MatchScore = Callable[..., float]
ParseYear = Callable[[object], int | None]
Similarity = Callable[[str, str], float]
QueryVariants = Callable[[str, str, str | None, int | None], list[tuple[str, str, str | None, int | None]]]
ProbeCandidates = Callable[..., list[CoverCandidate]]
SelectCandidate = Callable[..., CoverCandidate | None]
DedupeCandidates = Callable[[list[CoverCandidate]], list[CoverCandidate]]


def reset_spotify_rate_limit_state() -> None:
    _SPOTIFY_RATE_LIMIT_LOCAL.hit_429 = False


def mark_spotify_rate_limited() -> None:
    _SPOTIFY_RATE_LIMIT_LOCAL.hit_429 = True


def spotify_rate_limited() -> bool:
    return bool(getattr(_SPOTIFY_RATE_LIMIT_LOCAL, "hit_429", False))


def spotify_wait_for_request_slot() -> None:
    wait_seconds = 0.0
    with _SPOTIFY_REQUEST_PACING_LOCK:
        now = time.time()
        next_allowed_at = float(_SPOTIFY_REQUEST_PACING.get("next_allowed_at") or 0.0)
        if next_allowed_at > now:
            wait_seconds = next_allowed_at - now
        scheduled_at = max(now, next_allowed_at) + _SPOTIFY_MIN_REQUEST_INTERVAL_SECONDS
        _SPOTIFY_REQUEST_PACING["next_allowed_at"] = scheduled_at
    if wait_seconds > 0:
        time.sleep(wait_seconds)


def spotify_apply_retry_after(retry_after_seconds: float) -> None:
    cooldown = max(_SPOTIFY_MIN_REQUEST_INTERVAL_SECONDS, float(retry_after_seconds or 0.0))
    with _SPOTIFY_REQUEST_PACING_LOCK:
        rate_limited_until = time.time() + cooldown
        _SPOTIFY_REQUEST_PACING["next_allowed_at"] = max(
            float(_SPOTIFY_REQUEST_PACING.get("next_allowed_at") or 0.0),
            rate_limited_until,
        )
        _SPOTIFY_REQUEST_PACING["rate_limited_until"] = max(
            float(_SPOTIFY_REQUEST_PACING.get("rate_limited_until") or 0.0),
            rate_limited_until,
        )


def spotify_global_rate_limit_active() -> bool:
    with _SPOTIFY_REQUEST_PACING_LOCK:
        rate_limited_until = float(_SPOTIFY_REQUEST_PACING.get("rate_limited_until") or 0.0)
    return rate_limited_until > time.time()


def spotify_search_timed_out(started_at: float) -> bool:
    return (time.perf_counter() - float(started_at or 0.0)) >= _SPOTIFY_SEARCH_TIMEOUT_SECONDS


def spotify_api_enabled(*, config=Config) -> bool:
    return provider_availability("spotify", config=config).available


def normalize_spotify_album_url(url: str) -> str:
    if not url:
        return ""
    split = urllib.parse.urlsplit(str(url).strip())
    if "spotify.com" not in split.netloc.casefold():
        return ""
    if "/album/" not in split.path.casefold():
        return ""
    return urllib.parse.urlunsplit((split.scheme or "https", split.netloc, split.path, "", ""))


def spotify_album_id_from_url(url: str) -> str:
    normalized = normalize_spotify_album_url(url)
    if not normalized:
        return ""
    split = urllib.parse.urlsplit(normalized)
    match = re.search(r"/album/([A-Za-z0-9]+)", split.path, flags=re.IGNORECASE)
    return str(match.group(1) or "").strip() if match else ""


def spotify_image_candidate(images: list[dict]) -> tuple[str, int, int] | None:
    if not isinstance(images, list):
        return None
    best_url = ""
    best_width = 0
    best_height = 0
    for image in images:
        if not isinstance(image, dict):
            continue
        url = normalize_remote_image_url(str(image.get("url") or "").strip())
        width = int(image.get("width") or 0)
        height = int(image.get("height") or 0)
        if not url:
            continue
        if (width * height) > (best_width * best_height):
            best_url = url
            best_width = width
            best_height = height
    if not best_url:
        return None
    return best_url, best_width, best_height


def spotify_artist_names(value: object) -> str:
    artists = []
    for item in value or []:
        if isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            if name:
                artists.append(name)
    return ", ".join(artists)


def _emit(log_event: LogEvent | None, action: str, **fields) -> None:
    if log_event is None:
        return
    log_event({}, _LOGGER, action, level="info", **fields)


def spotify_request_json(
    url: str,
    *,
    method: str,
    headers: dict[str, str],
    data: bytes | None = None,
    context: str = "",
    logger=None,
    log_event: LogEvent | None = log_app_event,
) -> dict | None:
    request = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
    active_logger = logger or _LOGGER
    _emit(
        log_event,
        "Spotify request waiting for request slot",
        context=context,
        url=url,
        method=method.upper(),
    )
    spotify_wait_for_request_slot()
    _emit(
        log_event,
        "Spotify request issuing HTTP request",
        context=context,
        url=url,
        method=method.upper(),
    )
    try:
        _emit(
            log_event,
            "Spotify request waiting on HTTP response",
            context=context,
            url=url,
            method=method.upper(),
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = response.read()
    except Exception as exc:
        error_body = ""
        if isinstance(exc, urllib.error.HTTPError):
            if int(getattr(exc, "code", 0) or 0) == 429:
                mark_spotify_rate_limited()
                retry_after_seconds = 0.0
                try:
                    retry_after_seconds = float(exc.headers.get("Retry-After") or 0.0)
                except Exception:
                    retry_after_seconds = 0.0
                spotify_apply_retry_after(retry_after_seconds or 5.0)
            try:
                error_body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                error_body = ""
        verbose = getattr(active_logger, "verbose", None)
        if callable(verbose):
            verbose("Spotify API request failed context=%s url=%s error=%r", context, url, exc)
        _emit(
            log_event,
            "Spotify API request failed",
            context=context,
            url=url,
            method=method.upper(),
            error_type=type(exc).__name__,
            error=str(exc),
            error_body=error_body[:500],
        )
        return None
    _emit(
        log_event,
        "Spotify request received HTTP response",
        context=context,
        url=url,
        method=method.upper(),
        payload_bytes=len(payload or b""),
    )
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception as exc:
        verbose = getattr(active_logger, "verbose", None)
        if callable(verbose):
            verbose("Spotify API decode failed context=%s url=%s error=%r", context, url, exc)
        _emit(
            log_event,
            "Spotify API decode failed",
            context=context,
            url=url,
            method=method.upper(),
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return None


def spotify_access_token(
    *,
    config=Config,
    api_enabled: Callable[[], bool] | None = None,
    request_json: RequestJson | None = None,
    log_event: LogEvent | None = log_app_event,
) -> str | None:
    enabled = api_enabled() if api_enabled is not None else spotify_api_enabled(config=config)
    if not enabled:
        _emit(
            log_event,
            "Spotify API credentials unavailable",
            has_client_id=bool(config.SPOTIFY_CLIENT_ID),
            has_client_secret=bool(config.SPOTIFY_CLIENT_SECRET),
        )
        return None
    _emit(log_event, "Spotify token request stage", stage="waiting_for_token")
    now = time.time()
    with _SPOTIFY_TOKEN_CACHE_LOCK:
        cached_token = str(_SPOTIFY_TOKEN_CACHE.get("token") or "").strip()
        expires_at = float(_SPOTIFY_TOKEN_CACHE.get("expires_at") or 0.0)
        if cached_token and expires_at - now > 60:
            _emit(log_event, "Spotify token cache hit", expires_in_seconds=round(expires_at - now, 2))
            return cached_token
    basic = base64.b64encode(f"{config.SPOTIFY_CLIENT_ID}:{config.SPOTIFY_CLIENT_SECRET}".encode("utf-8")).decode("ascii")
    requester = request_json or spotify_request_json
    payload = requester(
        "https://accounts.spotify.com/api/token",
        method="POST",
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data=b"grant_type=client_credentials",
        context="token",
    )
    token = str((payload or {}).get("access_token") or "").strip()
    expires_in = int((payload or {}).get("expires_in") or 0)
    if not token:
        _emit(
            log_event,
            "Spotify token request returned no token",
            has_payload=bool(payload),
            payload_keys=sorted((payload or {}).keys()) if isinstance(payload, dict) else [],
        )
        return None
    _emit(log_event, "Spotify token acquired", expires_in_seconds=expires_in)
    with _SPOTIFY_TOKEN_CACHE_LOCK:
        _SPOTIFY_TOKEN_CACHE["token"] = token
        _SPOTIFY_TOKEN_CACHE["expires_at"] = now + max(60, expires_in)
    return token


def spotify_api_get(
    path: str,
    *,
    params: dict[str, object] | None = None,
    access_token: Callable[[], str | None] | None = None,
    request_json: RequestJson | None = None,
    log_event: LogEvent | None = log_app_event,
) -> dict | None:
    _emit(log_event, "Spotify API GET stage", stage="waiting_for_token", path=path)
    token = access_token() if access_token is not None else spotify_access_token(request_json=request_json, log_event=log_event)
    if not token:
        _emit(log_event, "Spotify API GET skipped without token", path=path)
        return None
    query_params = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    query = urllib.parse.urlencode(query_params)
    url = f"https://api.spotify.com/v1{path}"
    if query:
        url = f"{url}?{query}"
    _emit(log_event, "Spotify API GET stage", stage="issuing_request", path=path, url=url)
    requester = request_json or spotify_request_json
    return requester(
        url,
        method="GET",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        context=path,
    )


def spotify_album_matches_from_items(
    items: list[dict],
    *,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    enforce_year: bool,
    query_mode: str,
    match_score: MatchScore,
    parse_year: ParseYear,
) -> tuple[list[tuple[float, str, dict]], list[dict]]:
    matches: list[tuple[float, str, dict]] = []
    raw_results: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        image = spotify_image_candidate(item.get("images") or [])
        candidate_artist = spotify_artist_names(item.get("artists") or [])
        candidate_album = str(item.get("name") or "")
        candidate_year = parse_year(item.get("release_date"))
        raw_results.append({
            "name": candidate_album,
            "artist": candidate_artist,
            "year": candidate_year,
            "album_url": str((item.get("external_urls") or {}).get("spotify") or ""),
        })
        if not image:
            continue
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
        image_url, width, height = image
        matches.append((score, image_url, {
            "album": candidate_album,
            "artist": candidate_artist,
            "year": candidate_year,
            "album_url": str((item.get("external_urls") or {}).get("spotify") or ""),
            "variant": query_mode,
            "prefetched_width": width,
            "prefetched_height": height,
        }))
    matches.sort(key=lambda item: item[0], reverse=True)
    return matches, raw_results


def spotify_collect_album_matches(
    query_text: str,
    *,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    enforce_year: bool,
    query_mode: str,
    config=Config,
    api_get: ApiGet,
    match_score: MatchScore,
    parse_year: ParseYear,
    log_event: LogEvent | None = log_app_event,
) -> tuple[list[tuple[float, str, dict]], list[dict]]:
    data = api_get("/search", params={
        "q": query_text,
        "type": "album",
        "limit": 10,
        "market": config.SPOTIFY_MARKET,
    })
    items = (((data or {}).get("albums") or {}).get("items") or [])
    matches, raw_results = spotify_album_matches_from_items(
        items if isinstance(items, list) else [],
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
        "Spotify album search diagnostics",
        artist=artist,
        album=album,
        year=year,
        query=query_text,
        query_mode=query_mode,
        api_item_count=len(items) if isinstance(items, list) else 0,
        raw_result_count=len(raw_results),
        image_candidate_count=len(matches),
        positive_score_match_count=sum(1 for score, _url, _meta in matches if score > 0),
    )
    return matches, raw_results


def spotify_collect_artist_album_matches(
    query_artist: str,
    *,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    enforce_year: bool,
    query_mode: str,
    config=Config,
    api_get: ApiGet,
    similarity: Similarity,
    match_score: MatchScore,
    parse_year: ParseYear,
    log_event: LogEvent | None = log_app_event,
) -> tuple[list[tuple[float, str, dict]], list[dict]]:
    search = api_get("/search", params={
        "q": f'artist:"{query_artist}"',
        "type": "artist",
        "limit": 5,
        "market": config.SPOTIFY_MARKET,
    })
    artists_payload = (((search or {}).get("artists") or {}).get("items") or [])
    exact_artists: list[tuple[float, dict]] = []
    fuzzy_artists: list[tuple[float, dict]] = []
    for item in artists_payload if isinstance(artists_payload, list) else []:
        if not isinstance(item, dict):
            continue
        candidate_artist = str(item.get("name") or "")
        if not music_identity_matching.automatic_artist_identity_match_allowed(
            artist,
            candidate_artist,
        ):
            continue
        score = similarity(artist, candidate_artist)
        target = (
            exact_artists
            if music_identity_matching.same_artist_identity(artist, candidate_artist)
            else fuzzy_artists
        )
        target.append((score, item))
    ranked_artists = exact_artists or fuzzy_artists
    best_score, best_artist = max(ranked_artists, default=(0.0, None), key=lambda entry: entry[0])
    artist_id = str((best_artist or {}).get("id") or "").strip()
    if not artist_id:
        _emit(
            log_event,
            "Spotify artist fallback found no artist",
            artist=artist,
            album=album,
            query_artist=query_artist,
            query_mode=query_mode,
            artist_result_count=len(artists_payload) if isinstance(artists_payload, list) else 0,
        )
        return [], []
    payload = api_get(f"/artists/{artist_id}/albums", params={
        "include_groups": "album,single",
        "limit": 10,
        "market": config.SPOTIFY_MARKET,
    })
    items = (payload or {}).get("items") or []
    matches, raw_results = spotify_album_matches_from_items(
        items if isinstance(items, list) else [],
        artist=artist,
        album=album,
        edition=edition,
        year=year,
        enforce_year=enforce_year,
        query_mode=f"{query_mode}:artist-albums",
        match_score=match_score,
        parse_year=parse_year,
    )
    _emit(
        log_event,
        "Spotify artist fallback diagnostics",
        artist=artist,
        album=album,
        year=year,
        query_artist=query_artist,
        query_mode=query_mode,
        artist_result_count=len(artists_payload) if isinstance(artists_payload, list) else 0,
        matched_artist=str((best_artist or {}).get("name") or ""),
        matched_artist_score=round(best_score, 4),
        artist_album_count=len(items) if isinstance(items, list) else 0,
        image_candidate_count=len(matches),
        positive_score_match_count=sum(1 for score, _url, _meta in matches if score > 0),
    )
    return matches, raw_results


def search_spotify(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    config=Config,
    api_enabled: Callable[[], bool],
    global_rate_limit_active: Callable[[], bool],
    reset_rate_limit_state: Callable[[], None],
    rate_limited: Callable[[], bool],
    search_timed_out: Callable[[float], bool],
    build_query_variants: QueryVariants,
    collect_album_matches: Callable[..., tuple[list[tuple[float, str, dict]], list[dict]]],
    collect_artist_album_matches: Callable[..., tuple[list[tuple[float, str, dict]], list[dict]]],
    select_largest_candidate: SelectCandidate,
    log_event: LogEvent | None = log_app_event,
) -> CoverCandidate | None:
    if not api_enabled():
        _emit(
            log_event,
            "Spotify search skipped because API is disabled",
            artist=artist,
            album=album,
            year=year,
        )
        return None
    if global_rate_limit_active():
        _emit(
            log_event,
            "Spotify search skipped during global rate limit cooldown",
            artist=artist,
            album=album,
            year=year,
        )
        return None
    reset_rate_limit_state()
    started_at = time.perf_counter()
    seen_queries: set[str] = set()
    for query_artist, query_album, query_edition, query_year in build_query_variants(artist, album, edition, year):
        if search_timed_out(started_at):
            _emit(log_event, "Spotify search timed out", artist=artist, album=album, year=year, elapsed_ms=round((time.perf_counter() - started_at) * 1000, 2))
            break
        if rate_limited():
            break
        queries: list[tuple[str, bool, str]] = []
        query_suffix = "translit" if (query_artist, query_album) != (artist, album) else "native"
        query_album_text = " ".join(part for part in [query_album, query_edition or ""] if str(part).strip())
        if query_year:
            queries.append((f'album:"{query_album_text}" artist:"{query_artist}" year:{query_year}', True, f"artist+album+year:{query_suffix}"))
        queries.append((f'album:"{query_album_text}" artist:"{query_artist}"', False, f"artist+album:{query_suffix}"))
        for query_text, enforce_year, query_mode in queries:
            if search_timed_out(started_at):
                _emit(log_event, "Spotify search timed out before query", artist=artist, album=album, year=year, query_mode=query_mode, elapsed_ms=round((time.perf_counter() - started_at) * 1000, 2))
                break
            if rate_limited():
                break
            normalized_query = " ".join(query_text.split()).strip()
            if not normalized_query or normalized_query in seen_queries:
                continue
            seen_queries.add(normalized_query)
            matches, raw_results = collect_album_matches(normalized_query, artist=artist, album=album, edition=edition, year=year, enforce_year=enforce_year, query_mode=query_mode)
            if rate_limited():
                _emit(log_event, "Spotify search stopped after rate limit", artist=artist, album=album, year=year, query=normalized_query, query_mode=query_mode)
                break
            if search_timed_out(started_at):
                _emit(log_event, "Spotify search timed out after album search", artist=artist, album=album, year=year, query=normalized_query, query_mode=query_mode, elapsed_ms=round((time.perf_counter() - started_at) * 1000, 2))
                break
            if not matches:
                matches, raw_results = collect_artist_album_matches(query_artist, artist=artist, album=album, edition=edition, year=year, enforce_year=enforce_year, query_mode=query_mode)
            if rate_limited():
                _emit(log_event, "Spotify artist fallback stopped after rate limit", artist=artist, album=album, year=year, query_artist=query_artist, query_mode=query_mode)
                break
            if search_timed_out(started_at):
                _emit(log_event, "Spotify search timed out after artist fallback", artist=artist, album=album, year=year, query_artist=query_artist, query_mode=query_mode, elapsed_ms=round((time.perf_counter() - started_at) * 1000, 2))
                break
            _emit(
                log_event,
                "Spotify search candidate summary",
                artist=artist,
                album=album,
                year=year,
                query=normalized_query,
                query_mode=query_mode,
                match_count=len(matches),
                positive_score_match_count=sum(1 for score, _url, _meta in matches if score > 0),
                raw_result_count=len(raw_results),
            )
            matches.sort(key=lambda item: item[0], reverse=True)
            best_candidate = select_largest_candidate(
                source="spotify",
                matches=matches,
                user_agent=user_agent,
                query_mode=query_mode,
                artist=artist,
                album=album,
                year=year,
                raw_results=raw_results,
            )
            if best_candidate:
                _emit(
                    log_event,
                    "Spotify search selected candidate",
                    artist=artist,
                    album=album,
                    year=year,
                    query=normalized_query,
                    query_mode=query_mode,
                    matched_artist=best_candidate.matched_artist,
                    matched_album=best_candidate.matched_album,
                    matched_year=best_candidate.matched_year,
                    width=best_candidate.width,
                    height=best_candidate.height,
                    score=round(best_candidate.score, 4),
                    url=best_candidate.url,
                )
                return best_candidate
            _emit(log_event, "Spotify search found no candidate", artist=artist, album=album, year=year, query=normalized_query, query_mode=query_mode, raw_result_count=len(raw_results))
        if rate_limited():
            break
    return None


def search_spotify_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    api_enabled: Callable[[], bool],
    global_rate_limit_active: Callable[[], bool],
    reset_rate_limit_state: Callable[[], None],
    rate_limited: Callable[[], bool],
    search_timed_out: Callable[[float], bool],
    build_query_variants: QueryVariants,
    collect_album_matches: Callable[..., tuple[list[tuple[float, str, dict]], list[dict]]],
    collect_artist_album_matches: Callable[..., tuple[list[tuple[float, str, dict]], list[dict]]],
    probe_match_candidates: ProbeCandidates,
    dedupe_cover_candidates: DedupeCandidates,
    log_event: LogEvent | None = log_app_event,
) -> list[CoverCandidate]:
    if not api_enabled():
        return []
    if global_rate_limit_active():
        _emit(log_event, "Spotify candidate search skipped during global rate limit cooldown", artist=artist, album=album, year=year)
        return []
    reset_rate_limit_state()
    started_at = time.perf_counter()
    seen_queries: set[str] = set()
    candidates: list[CoverCandidate] = []
    for query_artist, query_album, query_edition, query_year in build_query_variants(artist, album, edition, year):
        if search_timed_out(started_at):
            _emit(log_event, "Spotify candidate search timed out", artist=artist, album=album, year=year, elapsed_ms=round((time.perf_counter() - started_at) * 1000, 2))
            break
        if rate_limited():
            _emit(log_event, "Spotify candidate search aborted before query batch", artist=artist, album=album, year=year, query_artist=query_artist, query_album=query_album)
            break
        queries: list[tuple[str, bool, str]] = []
        query_suffix = "translit" if (query_artist, query_album) != (artist, album) else "native"
        query_album_text = " ".join(part for part in [query_album, query_edition or ""] if str(part).strip())
        if query_year:
            queries.append((f'album:"{query_album_text}" artist:"{query_artist}" year:{query_year}', True, f"artist+album+year:{query_suffix}"))
        queries.append((f'album:"{query_album_text}" artist:"{query_artist}"', False, f"artist+album:{query_suffix}"))
        for query_text, enforce_year, query_mode in queries:
            if search_timed_out(started_at):
                _emit(log_event, "Spotify candidate search timed out before query", artist=artist, album=album, year=year, query_mode=query_mode, elapsed_ms=round((time.perf_counter() - started_at) * 1000, 2))
                break
            if rate_limited():
                _emit(log_event, "Spotify candidate search stopped before query due to rate limit", artist=artist, album=album, year=year, query_mode=query_mode)
                break
            normalized_query = " ".join(query_text.split()).strip()
            if not normalized_query or normalized_query in seen_queries:
                continue
            seen_queries.add(normalized_query)
            matches, raw_results = collect_album_matches(normalized_query, artist=artist, album=album, edition=edition, year=year, enforce_year=enforce_year, query_mode=query_mode)
            if rate_limited():
                _emit(log_event, "Spotify candidate search stopped after rate limit", artist=artist, album=album, year=year, query=normalized_query, query_mode=query_mode)
                break
            if search_timed_out(started_at):
                _emit(log_event, "Spotify candidate search timed out after album search", artist=artist, album=album, year=year, query=normalized_query, query_mode=query_mode, elapsed_ms=round((time.perf_counter() - started_at) * 1000, 2))
                break
            if not matches:
                matches, raw_results = collect_artist_album_matches(query_artist, artist=artist, album=album, edition=edition, year=year, enforce_year=enforce_year, query_mode=query_mode)
            if rate_limited():
                _emit(log_event, "Spotify candidate artist fallback stopped after rate limit", artist=artist, album=album, year=year, query_artist=query_artist, query_mode=query_mode)
                break
            if search_timed_out(started_at):
                _emit(log_event, "Spotify candidate search timed out after artist fallback", artist=artist, album=album, year=year, query_artist=query_artist, query_mode=query_mode, elapsed_ms=round((time.perf_counter() - started_at) * 1000, 2))
                break
            matches.sort(key=lambda item: item[0], reverse=True)
            if matches:
                probed_candidates = probe_match_candidates(
                    source="spotify",
                    matches=matches,
                    user_agent=user_agent,
                    query_mode=query_mode,
                    artist=artist,
                    album=album,
                    year=year,
                    raw_results=raw_results,
                    probe_limit=None,
                    use_score_cutoff=False,
                )
                candidates.extend(probed_candidates)
                _emit(log_event, "Spotify candidate search probe completed", artist=artist, album=album, year=year, query=normalized_query, query_mode=query_mode, probed_candidate_count=len(probed_candidates))
        if rate_limited():
            break
    deduped_candidates = dedupe_cover_candidates(candidates)
    _emit(log_event, "Spotify candidate search completed", artist=artist, album=album, year=year, candidate_count=len(deduped_candidates), rate_limited=rate_limited())
    return deduped_candidates


def spotify_candidates_from_album_url(
    normalized_url: str,
    *,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    config=Config,
    api_enabled: Callable[[], bool] | None = None,
    api_get: ApiGet,
    match_score: MatchScore,
    parse_year: ParseYear,
    log_event: LogEvent | None = log_app_event,
) -> list[CoverCandidate]:
    spotify_album_id = spotify_album_id_from_url(normalized_url)
    enabled = api_enabled() if api_enabled is not None else spotify_api_enabled(config=config)
    if not spotify_album_id or not enabled:
        return []
    _emit(
        log_event,
        "Manual Spotify album link detected",
        artist=target_artist,
        album=target_album,
        url=normalized_url,
        spotify_album_id=spotify_album_id,
    )
    payload = api_get(f"/albums/{spotify_album_id}", params={"market": config.SPOTIFY_MARKET})
    if not isinstance(payload, dict):
        _emit(
            log_event,
            "Manual Spotify album fetch failed",
            artist=target_artist,
            album=target_album,
            url=normalized_url,
            spotify_album_id=spotify_album_id,
            reason="empty_payload",
        )
        return []
    image = spotify_image_candidate(payload.get("images") or [])
    candidate_artist = spotify_artist_names(payload.get("artists") or [])
    candidate_album = str(payload.get("name") or "").strip()
    candidate_year = parse_year(payload.get("release_date"))
    album_url = str((payload.get("external_urls") or {}).get("spotify") or normalized_url).strip() or normalized_url
    if not image:
        _emit(
            log_event,
            "Manual Spotify album image missing",
            artist=target_artist,
            album=target_album,
            url=normalized_url,
            spotify_album_id=spotify_album_id,
            candidate_artist=candidate_artist,
            candidate_album=candidate_album,
            candidate_year=candidate_year,
        )
        return []
    image_url, width, height = image
    score = match_score(
        target_artist=target_artist,
        target_album=target_album,
        target_edition=target_edition,
        target_year=target_year,
        candidate_artist=candidate_artist or target_artist,
        candidate_album=candidate_album or target_album,
        candidate_year=candidate_year,
        enforce_year=False,
    ) or 1.0
    candidate = CoverCandidate(
        source="spotify",
        url=image_url,
        score=score,
        width=width,
        height=height,
        matched_artist=candidate_artist or target_artist,
        matched_album=candidate_album or target_album,
        matched_year=candidate_year if isinstance(candidate_year, int) else target_year,
        debug_payload={
            "query_mode": "manual-url",
            "variant": "manual-url",
            "album_url": album_url,
            "raw_results": [],
            "probed_contenders": [{
                "score": round(float(score), 4),
                "width": width,
                "height": height,
                "album": candidate_album or target_album,
                "artist": candidate_artist or target_artist,
                "url": image_url,
                "year": candidate_year if isinstance(candidate_year, int) else target_year,
                "variant": "manual-url",
                "album_url": album_url,
            }],
        },
    )
    _emit(
        log_event,
        "Manual Spotify album candidate created",
        artist=target_artist,
        album=target_album,
        url=normalized_url,
        spotify_album_id=spotify_album_id,
        candidate_artist=candidate_artist,
        candidate_album=candidate_album,
        candidate_year=candidate_year,
        width=width,
        height=height,
        score=round(float(score), 4),
    )
    return [candidate]
