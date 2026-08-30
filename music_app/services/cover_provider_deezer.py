from __future__ import annotations

import logging
import re
import urllib.parse
from collections.abc import Callable

from music_app.services.app_logging import log_app_event
from music_app.services.cover_provider_candidates import CoverCandidate, dedupe_cover_candidates, normalize_remote_image_url
from music_app.services import cover_provider_http

_LOGGER = logging.getLogger(__name__)
_DEEZER_ARTWORK_SIZES = (2000, 1800, 1500, 1400, 1200, 1000)

HttpGetJson = Callable[..., dict | None]
LogEvent = Callable[..., None]
MatchScore = Callable[..., float]
ParseYear = Callable[[object], int | None]
QueryVariants = Callable[[str, str, str | None, int | None], list[tuple[str, str, str | None, int | None]]]
ProbeCandidates = Callable[..., list[CoverCandidate]]
SelectCandidate = Callable[..., CoverCandidate | None]
DedupeCandidates = Callable[[list[CoverCandidate]], list[CoverCandidate]]


def deezer_candidate_url(artwork_url: str) -> str | None:
    if not artwork_url:
        return None
    upgraded = re.sub(
        r"/\d+x\d+-000000-80-0-0\.jpg$",
        "/2000x2000-000000-80-0-0.jpg",
        str(artwork_url or "").strip(),
        flags=re.IGNORECASE,
    )
    return upgraded if upgraded else None


def deezer_candidate_urls(item: dict[str, object]) -> list[str]:
    source_urls = [
        str(item.get("cover_xl") or "").strip(),
        str(item.get("cover_big") or "").strip(),
        str(item.get("cover_medium") or "").strip(),
        str(item.get("cover") or "").strip(),
    ]
    raw_candidates: list[str] = []
    for source_url in source_urls:
        if not source_url:
            continue
        for size in _DEEZER_ARTWORK_SIZES:
            upgraded = re.sub(
                r"/\d+x\d+-000000-80-0-0\.jpg$",
                f"/{size}x{size}-000000-80-0-0.jpg",
                source_url,
                flags=re.IGNORECASE,
            )
            if upgraded and upgraded != source_url:
                raw_candidates.append(upgraded)
        raw_candidates.append(source_url)
    urls: list[str] = []
    seen: set[str] = set()
    for raw_candidate in raw_candidates:
        candidate = normalize_remote_image_url(raw_candidate)
        if not candidate:
            continue
        key = candidate.casefold()
        if key in seen:
            continue
        seen.add(key)
        urls.append(candidate)
    return urls


def parse_deezer_album_id(url: str) -> str:
    split = urllib.parse.urlsplit(str(url or "").strip())
    if "deezer.com" not in split.netloc.casefold():
        return ""
    match = re.search(r"/album/(\d+)", split.path, flags=re.IGNORECASE)
    return str(match.group(1) or "").strip() if match else ""


def _build_deezer_queries(
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
        queries.append((f'artist:"{query_artist}" album:"{query_album_text}" "{query_year}"', True, f"artist+album+year:{query_suffix}"))
    queries.append((f'artist:"{query_artist}" album:"{query_album_text}"', False, f"artist+album:{query_suffix}"))
    return queries


def _search_url(normalized_query: str, *, limit: int) -> str:
    query = urllib.parse.quote(normalized_query)
    return f"https://api.deezer.com/search/album?q={query}&limit={limit}"


def search_deezer_cover(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_json: HttpGetJson | None = None,
    build_query_variants: QueryVariants,
    match_score: MatchScore,
    parse_year: ParseYear,
    select_largest_candidate: SelectCandidate,
) -> CoverCandidate | None:
    getter = http_get_json or cover_provider_http._http_get_json
    seen_queries: set[str] = set()
    for query_artist, query_album, query_edition, query_year in build_query_variants(artist, album, edition, year):
        for query_text, enforce_year, query_mode in _build_deezer_queries(
            query_artist,
            query_album,
            query_edition,
            query_year,
            native_artist=artist,
            native_album=album,
        ):
            normalized_query = " ".join(query_text.split()).strip()
            if not normalized_query or normalized_query in seen_queries:
                continue
            seen_queries.add(normalized_query)
            data = getter(_search_url(normalized_query, limit=10), user_agent, service="deezer", context=f"search:{normalized_query}")
            if not data:
                continue
            matches: list[tuple[float, str, dict]] = []
            for item in data.get("data") or []:
                if not isinstance(item, dict):
                    continue
                candidate_url = deezer_candidate_url(str(item.get("cover_xl") or item.get("cover_big") or item.get("cover") or ""))
                score = match_score(
                    target_artist=artist,
                    target_album=album,
                    target_edition=edition,
                    target_year=year,
                    candidate_artist=str((item.get("artist") or {}).get("name") or ""),
                    candidate_album=str(item.get("title") or ""),
                    candidate_year=parse_year(item.get("release_date")),
                    enforce_year=enforce_year,
                )
                if candidate_url:
                    matches.append((score, candidate_url, item))
            matches.sort(key=lambda item: item[0], reverse=True)
            best_candidate = select_largest_candidate(
                source="deezer",
                matches=matches,
                user_agent=user_agent,
                query_mode=query_mode,
                artist=artist,
                album=album,
                year=year,
            )
            if best_candidate:
                return best_candidate
    return None


def search_deezer_cover_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    http_get_json: HttpGetJson | None = None,
    build_query_variants: QueryVariants,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
    dedupe_candidates: DedupeCandidates = dedupe_cover_candidates,
    log_event: LogEvent | None = log_app_event,
    logger=None,
) -> list[CoverCandidate]:
    getter = http_get_json or cover_provider_http._http_get_json
    active_logger = logger or _LOGGER
    seen_queries: set[str] = set()
    candidates: list[CoverCandidate] = []
    _emit(log_event, active_logger, "Deezer search started", artist=artist, album=album, edition=edition, year=year)
    for query_artist, query_album, query_edition, query_year in build_query_variants(artist, album, edition, year):
        for query_text, enforce_year, query_mode in _build_deezer_queries(
            query_artist,
            query_album,
            query_edition,
            query_year,
            native_artist=artist,
            native_album=album,
        ):
            normalized_query = " ".join(query_text.split()).strip()
            if not normalized_query or normalized_query in seen_queries:
                if normalized_query:
                    _emit(
                        log_event,
                        active_logger,
                        "Deezer search query skipped",
                        artist=artist,
                        album=album,
                        year=year,
                        query=normalized_query,
                        query_mode=query_mode,
                        reason="duplicate",
                    )
                continue
            seen_queries.add(normalized_query)
            _emit(
                log_event,
                active_logger,
                "Deezer search query issued",
                artist=artist,
                album=album,
                edition=edition,
                year=year,
                query_artist=query_artist,
                query_album=query_album,
                query_edition=query_edition,
                query_year=query_year,
                query=normalized_query,
                query_mode=query_mode,
                enforce_year=enforce_year,
            )
            data = getter(_search_url(normalized_query, limit=25), user_agent, service="deezer", context=f"search:{normalized_query}")
            if not data:
                _emit(
                    log_event,
                    active_logger,
                    "Deezer search returned no data",
                    artist=artist,
                    album=album,
                    year=year,
                    query=normalized_query,
                    query_mode=query_mode,
                    reason="empty_payload",
                )
                continue
            raw_items = data.get("data") if isinstance(data, dict) else None
            if not isinstance(raw_items, list):
                _emit(
                    log_event,
                    active_logger,
                    "Deezer search payload missing data list",
                    artist=artist,
                    album=album,
                    year=year,
                    query=normalized_query,
                    query_mode=query_mode,
                    payload_keys=sorted(data.keys()) if isinstance(data, dict) else [],
                )
                continue
            matches: list[tuple[float, str, dict]] = []
            match_diagnostics: list[dict[str, object]] = []
            for item in raw_items:
                item_dict = item if isinstance(item, dict) else {}
                candidate_probe_urls = deezer_candidate_urls(item_dict)
                candidate_url = candidate_probe_urls[0] if candidate_probe_urls else None
                artist_payload = item_dict.get("artist") if isinstance(item_dict.get("artist"), dict) else {}
                candidate_artist = str((artist_payload or {}).get("name") or "")
                candidate_album = str(item_dict.get("title") or "")
                candidate_year = parse_year(item_dict.get("release_date"))
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
                if len(match_diagnostics) < 12:
                    match_diagnostics.append({
                        "artist": candidate_artist,
                        "album": candidate_album,
                        "year": candidate_year,
                        "score": round(float(score or 0.0), 4),
                        "has_cover": bool(candidate_url),
                        "album_url": str(item_dict.get("link") or ""),
                        "probe_urls": candidate_probe_urls[:5],
                    })
                if candidate_url and score > 0:
                    enriched_item = dict(item_dict)
                    enriched_item["artist"] = candidate_artist
                    enriched_item["album"] = candidate_album
                    enriched_item["year"] = candidate_year
                    enriched_item["album_url"] = str(item_dict.get("link") or "")
                    enriched_item["probe_urls"] = list(candidate_probe_urls)
                    matches.append((score, candidate_url, enriched_item))
                else:
                    _verbose(
                        active_logger,
                        "Deezer candidate rejected artist=%r album=%r query=%s query_mode=%s candidate_artist=%r candidate_album=%r candidate_year=%r has_cover=%s score=%.4f",
                        artist,
                        album,
                        normalized_query,
                        query_mode,
                        candidate_artist,
                        candidate_album,
                        candidate_year,
                        bool(candidate_url),
                        score,
                    )
            matches.sort(key=lambda item: item[0], reverse=True)
            _emit(
                log_event,
                active_logger,
                "Deezer search candidate summary",
                artist=artist,
                album=album,
                year=year,
                query=normalized_query,
                query_mode=query_mode,
                result_count=len(raw_items),
                viable_match_count=len(matches),
                top_results=match_diagnostics,
            )
            if matches:
                probed_candidates = probe_match_candidates(
                    source="deezer",
                    matches=matches,
                    user_agent=user_agent,
                    query_mode=query_mode,
                    artist=artist,
                    album=album,
                    year=year,
                    probe_limit=None,
                    use_score_cutoff=False,
                )
                _emit(
                    log_event,
                    active_logger,
                    "Deezer search probe completed",
                    artist=artist,
                    album=album,
                    year=year,
                    query=normalized_query,
                    query_mode=query_mode,
                    viable_match_count=len(matches),
                    probed_candidate_count=len(probed_candidates),
                    selected_urls=[str(item.url or "") for item in probed_candidates[:8]],
                )
                deduped_candidates = dedupe_candidates(probed_candidates)
                _emit(
                    log_event,
                    active_logger,
                    "Deezer search stopping after probing successful query batch",
                    artist=artist,
                    album=album,
                    year=year,
                    query=normalized_query,
                    query_mode=query_mode,
                    matched_result_count=len(matches),
                    candidate_count=len(deduped_candidates),
                    candidate_urls=[str(item.url or "") for item in deduped_candidates[:10]],
                )
                return deduped_candidates
            _emit(
                log_event,
                active_logger,
                "Deezer search found no viable candidate",
                artist=artist,
                album=album,
                year=year,
                query=normalized_query,
                query_mode=query_mode,
                reason="no_positive_scored_matches",
                result_count=len(raw_items),
            )
    deduped_candidates = dedupe_candidates(candidates)
    _emit(
        log_event,
        active_logger,
        "Deezer search finished",
        artist=artist,
        album=album,
        edition=edition,
        year=year,
        query_count=len(seen_queries),
        candidate_count=len(candidates),
        deduped_candidate_count=len(deduped_candidates),
        candidate_urls=[str(item.url or "") for item in deduped_candidates[:10]],
    )
    return deduped_candidates


def expand_deezer_album_url_candidates(
    normalized_url: str,
    *,
    user_agent: str,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    http_get_json: HttpGetJson | None = None,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
) -> list[CoverCandidate] | None:
    album_id = parse_deezer_album_id(normalized_url)
    if not album_id:
        return None
    getter = http_get_json or cover_provider_http._http_get_json
    payload = getter(
        f"https://api.deezer.com/album/{album_id}",
        user_agent,
        service="deezer",
        context=f"manual-album:{album_id}",
    ) or {}
    if not isinstance(payload, dict):
        return []
    image_urls = deezer_candidate_urls(payload)
    if not image_urls:
        return []
    image_url = str(image_urls[0] or "").strip()
    if not image_url:
        return []
    candidate_album = str(payload.get("title") or target_album).strip() or target_album
    artist_payload = payload.get("artist") if isinstance(payload.get("artist"), dict) else {}
    candidate_artist = str((artist_payload or {}).get("name") or target_artist).strip() or target_artist
    candidate_year = parse_year(payload.get("release_date")) or target_year
    score = match_score(
        target_artist=target_artist,
        target_album=target_album,
        target_edition=target_edition,
        target_year=target_year,
        candidate_artist=candidate_artist,
        candidate_album=candidate_album,
        candidate_year=candidate_year,
        enforce_year=False,
    ) or 1.0
    split = urllib.parse.urlsplit(normalized_url)
    return probe_match_candidates(
        source="deezer",
        matches=[(
            score,
            image_url,
            {
                "album": candidate_album,
                "artist": candidate_artist,
                "year": candidate_year,
                "album_url": normalized_url,
                "variant": "manual-album",
                "host": split.netloc,
                "source_label": "Deezer",
            },
        )],
        user_agent=user_agent,
        query_mode="manual-deezer",
        artist=target_artist,
        album=target_album,
        year=target_year,
        probe_limit=1,
        use_score_cutoff=False,
    )


def _emit(log_event: LogEvent | None, logger, action: str, **fields) -> None:
    if log_event is None:
        return
    log_event({}, logger or _LOGGER, action, level="info", **fields)


def _verbose(logger, message: str, *args) -> None:
    verbose = getattr(logger or _LOGGER, "verbose", None)
    if callable(verbose):
        verbose(message, *args)
