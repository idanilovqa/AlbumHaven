from __future__ import annotations

import logging
import re
import threading
import urllib.parse
from collections.abc import Callable

from config import Config
from music_app.services import cover_provider_http
from music_app.services.app_logging import log_app_event
from music_app.services.cover_provider_availability import provider_availability
from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    build_lookup_matches_from_candidates,
)

_LOGGER = logging.getLogger(__name__)
_DISCOGS_RATE_LIMIT_LOCAL = threading.local()

JsonGetter = Callable[..., dict | None]
LogEvent = Callable[..., None]
MatchScore = Callable[..., float]
ParseYear = Callable[[object], int | None]
QueryVariants = Callable[[str, str, str | None, int | None], list[tuple[str, str, str | None, int | None]]]
ProbeCandidates = Callable[..., list[CoverCandidate]]
CancelPredicate = Callable[[], bool]


def _cancel_requested(should_cancel: CancelPredicate | None) -> bool:
    return bool(callable(should_cancel) and should_cancel())


def reset_discogs_rate_limit_state() -> None:
    _DISCOGS_RATE_LIMIT_LOCAL.hit_429 = False


def mark_discogs_rate_limited() -> None:
    _DISCOGS_RATE_LIMIT_LOCAL.hit_429 = True


def discogs_rate_limited() -> bool:
    return bool(getattr(_DISCOGS_RATE_LIMIT_LOCAL, "hit_429", False))


def parse_discogs_master_id(url: str) -> int | None:
    split = urllib.parse.urlsplit(url)
    match = re.match(r"^/master/(\d+)(?:[-/].*)?$", split.path or "", flags=re.IGNORECASE)
    if not match:
        return None
    try:
        return int(match.group(1))
    except (TypeError, ValueError):
        return None


def parse_discogs_release_id(url: str) -> int | None:
    split = urllib.parse.urlsplit(url)
    match = re.match(r"^/release/(\d+)(?:[-/].*)?$", split.path or "", flags=re.IGNORECASE)
    if not match:
        return None
    try:
        return int(match.group(1))
    except (TypeError, ValueError):
        return None


def discogs_auth_params(*, config=Config) -> dict[str, str]:
    params: dict[str, str] = {}
    if provider_availability("discogs", config=config).credentials_present:
        params["key"] = config.DISCOGS_CONSUMER_KEY
        params["secret"] = config.DISCOGS_CONSUMER_SECRET
    return params


def discogs_auth_headers(*, config=Config) -> dict[str, str]:
    if not provider_availability("discogs", config=config).credentials_present:
        return {}
    return {
        "Authorization": f"Discogs key={config.DISCOGS_CONSUMER_KEY}, secret={config.DISCOGS_CONSUMER_SECRET}",
    }


def discogs_api_get_json(
    url: str,
    user_agent: str,
    *,
    params: dict[str, object] | None = None,
    context: str = "",
    config=Config,
    http_get_json: JsonGetter | None = None,
    logger=None,
    app_event_logger: LogEvent | None = None,
    mark_rate_limited: Callable[[], None] | None = None,
) -> dict | None:
    raw_url = str(url or "").strip()
    split = urllib.parse.urlsplit(raw_url)
    original_query = split.query
    api_base_url = str(
        getattr(config, "DISCOGS_API_BASE_URL", "")
        or "https://api.discogs.com"
    ).rstrip("/")
    if not split.scheme:
        normalized_url = urllib.parse.urljoin(
            f"{api_base_url}/",
            raw_url.lstrip("/"),
        )
        split = urllib.parse.urlsplit(normalized_url)
    elif split.netloc.casefold() == "api.discogs.com":
        normalized_url = urllib.parse.urljoin(
            f"{api_base_url}/",
            split.path.lstrip("/"),
        )
        split = urllib.parse.urlsplit(normalized_url)
    else:
        normalized_url = raw_url
    query_pairs = urllib.parse.parse_qsl(
        original_query or split.query,
        keep_blank_values=True,
    )
    query_pairs.extend(
        (str(key), str(value))
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    )
    final_url = urllib.parse.urlunsplit((
        split.scheme or "https",
        split.netloc or "api.discogs.com",
        split.path,
        urllib.parse.urlencode(query_pairs),
        "",
    ))
    getter = http_get_json or cover_provider_http._http_get_json
    return getter(
        final_url,
        user_agent,
        service="discogs",
        context=context,
        extra_headers=discogs_auth_headers(config=config),
        logger=logger or _LOGGER,
        app_event_logger=app_event_logger or log_app_event,
        mark_discogs_rate_limited=mark_rate_limited or mark_discogs_rate_limited,
    )


def discogs_release_images(
    release_payload: dict[str, object],
    fallback_payload: dict[str, object] | None = None,
) -> list[dict[str, object]]:
    candidates: list[dict[str, object]] = []
    seen_urls: set[str] = set()
    for candidate_payload in [release_payload, fallback_payload or {}]:
        if not isinstance(candidate_payload, dict):
            continue
        images = candidate_payload.get("images")
        if not isinstance(images, list):
            continue
        primary_images = [
            item for item in images
            if isinstance(item, dict) and str(item.get("type") or "").casefold() == "primary"
        ]
        ordered_images = primary_images + [
            item for item in images
            if isinstance(item, dict) and item not in primary_images
        ]
        for index, item in enumerate(ordered_images):
            if not isinstance(item, dict):
                continue
            image_url = str(item.get("uri") or item.get("resource_url") or item.get("uri150") or "").strip()
            if not image_url or image_url in seen_urls:
                continue
            seen_urls.add(image_url)
            image_type = str(item.get("type") or "").strip().casefold()
            art_kind = "cover" if image_type == "primary" else "other"
            art_label = "Front cover" if art_kind == "cover" else (str(item.get("type") or "").strip().title() or f"Booklet image {index + 1}")
            candidates.append({
                "url": image_url,
                "thumbnail_url": str(item.get("uri150") or image_url).strip() or image_url,
                "art_kind": art_kind,
                "art_label": art_label,
            })
    return candidates


def _discogs_result_artist(result: dict[str, object]) -> str:
    artist = str(result.get("artist") or result.get("artist_name") or "").strip()
    if artist:
        return re.sub(r"\s+\(\d+\)\s*$", "", artist).strip()
    title = str(result.get("title") or "").strip()
    if " - " in title:
        return title.split(" - ", 1)[0].strip()
    return ""


def _discogs_result_album(result: dict[str, object]) -> str:
    master_title = str(result.get("master_title") or "").strip()
    if master_title:
        return master_title
    title = str(result.get("title") or "").strip()
    if " - " in title:
        return title.split(" - ", 1)[1].strip()
    return title


def discogs_detail_artist(payload: dict[str, object], fallback_artist: str) -> str:
    artist = str(payload.get("artists_sort") or "").strip()
    if artist:
        return artist
    artists = payload.get("artists")
    if isinstance(artists, list):
        joined = ", ".join(
            str(item.get("name") or "").strip()
            for item in artists
            if isinstance(item, dict) and str(item.get("name") or "").strip()
        ).strip()
        if joined:
            return joined
    return fallback_artist


def _discogs_detail_match_payload(
    *,
    detail_payload: dict[str, object],
    fallback_payload: dict[str, object],
    fallback_artist: str,
    fallback_album: str,
    fallback_year: int | None,
    parse_year: ParseYear,
) -> tuple[str, str, int | None, str]:
    candidate_artist = discogs_detail_artist(detail_payload, fallback_artist)
    candidate_album = str(detail_payload.get("title") or fallback_album).strip() or fallback_album
    candidate_year = parse_year(detail_payload.get("year")) or fallback_year
    album_url = str(detail_payload.get("uri") or fallback_payload.get("uri") or "").strip()
    return candidate_artist, candidate_album, candidate_year, album_url


def fetch_discogs_master_release_matches(
    master_id: int,
    *,
    normalized_url: str,
    user_agent: str,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    api_get_json: JsonGetter,
    match_score: MatchScore,
    allow_nonmatching: bool = False,
    should_cancel: CancelPredicate | None = None,
) -> list[tuple[float, str, dict[str, object]]]:
    if _cancel_requested(should_cancel):
        return []
    master_payload = api_get_json(
        f"https://api.discogs.com/masters/{master_id}",
        user_agent,
        context=f"master:{master_id}",
    ) or {}
    if _cancel_requested(should_cancel):
        return []
    versions_url = str(master_payload.get("versions_url") or f"https://api.discogs.com/masters/{master_id}/versions")
    first_page = api_get_json(
        versions_url,
        user_agent,
        params={"per_page": 100, "page": 1},
        context=f"master-versions:{master_id}:page-1",
    )
    if _cancel_requested(should_cancel):
        return []
    if not isinstance(first_page, dict):
        return []
    version_rows = [item for item in (first_page.get("versions") or []) if isinstance(item, dict)]
    pagination = first_page.get("pagination") if isinstance(first_page.get("pagination"), dict) else {}
    total_pages = max(1, min(int(pagination.get("pages") or 1), 10))
    for page in range(2, total_pages + 1):
        if _cancel_requested(should_cancel):
            return []
        payload = api_get_json(
            versions_url,
            user_agent,
            params={"per_page": 100, "page": page},
            context=f"master-versions:{master_id}:page-{page}",
        )
        if _cancel_requested(should_cancel):
            return []
        if not isinstance(payload, dict):
            continue
        version_rows.extend(item for item in (payload.get("versions") or []) if isinstance(item, dict))

    matches: list[tuple[float, str, dict[str, object]]] = []
    for version in version_rows:
        if _cancel_requested(should_cancel):
            return []
        release_resource_url = str(version.get("resource_url") or "").strip()
        if not release_resource_url:
            continue
        release_payload = api_get_json(
            release_resource_url,
            user_agent,
            context=f"release:{release_resource_url.rsplit('/', 1)[-1]}",
        )
        if _cancel_requested(should_cancel):
            return []
        if not isinstance(release_payload, dict):
            continue
        release_images = discogs_release_images(release_payload, version)
        if not release_images:
            continue
        candidate_album = str(release_payload.get("title") or version.get("title") or target_album).strip()
        candidate_artist = str(release_payload.get("artists_sort") or "").strip()
        if not candidate_artist:
            artists = release_payload.get("artists")
            if isinstance(artists, list):
                candidate_artist = ", ".join(
                    str(item.get("name") or "").strip()
                    for item in artists
                    if isinstance(item, dict) and str(item.get("name") or "").strip()
                )
        if not candidate_artist:
            candidate_artist = target_artist
        candidate_year = release_payload.get("year")
        if not isinstance(candidate_year, int):
            try:
                candidate_year = int(candidate_year or version.get("released") or 0)
            except (TypeError, ValueError):
                candidate_year = target_year
        score = match_score(
            target_artist=target_artist,
            target_album=target_album,
            target_edition=target_edition,
            target_year=target_year,
            candidate_artist=candidate_artist,
            candidate_album=candidate_album,
            candidate_year=candidate_year if isinstance(candidate_year, int) else None,
            enforce_year=False,
        )
        if score <= 0:
            if not allow_nonmatching:
                continue
            score = 1.0
        for image in release_images:
            if _cancel_requested(should_cancel):
                return []
            matches.append((
                score,
                str(image.get("url") or "").strip(),
                {
                    "album": candidate_album,
                    "artist": candidate_artist,
                    "year": candidate_year if isinstance(candidate_year, int) else target_year,
                    "album_url": str(release_payload.get("uri") or normalized_url),
                    "variant": "manual-master",
                    "host": "api.discogs.com",
                    "source_label": "Discogs",
                    "release_id": release_payload.get("id"),
                    "format": version.get("format"),
                    "country": version.get("country"),
                    "thumbnail_url": str(image.get("thumbnail_url") or image.get("url") or "").strip(),
                    "art_kind": str(image.get("art_kind") or "cover"),
                    "art_label": str(image.get("art_label") or ""),
                },
            ))
    return [] if _cancel_requested(should_cancel) else matches


def discogs_database_search_matches(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    build_query_variants: QueryVariants,
    match_score: MatchScore,
    parse_year: ParseYear,
    api_get_json: JsonGetter,
    log_event: LogEvent = log_app_event,
    logger=None,
    config=Config,
    reset_rate_limit_state: Callable[[], None] = reset_discogs_rate_limit_state,
    is_rate_limited: Callable[[], bool] = discogs_rate_limited,
    should_cancel: CancelPredicate | None = None,
) -> list[tuple[float, str, dict[str, object]]]:
    if _cancel_requested(should_cancel):
        return []
    active_logger = logger or _LOGGER
    top_results: list[tuple[float, dict[str, object]]] = []
    seen_resources: set[str] = set()
    reset_rate_limit_state()
    log_event(
        {},
        active_logger,
        "Discogs search started",
        level="info",
        artist=artist,
        album=album,
        edition=edition,
        year=year,
        has_consumer_key=bool(config.DISCOGS_CONSUMER_KEY),
        has_consumer_secret=bool(config.DISCOGS_CONSUMER_SECRET),
        auth_enabled=bool(config.DISCOGS_AUTH_ENABLED),
    )
    for variant_artist, variant_album, variant_edition, variant_year in build_query_variants(artist, album, edition, year):
        if _cancel_requested(should_cancel):
            return []
        if is_rate_limited():
            break
        search_text = " ".join(
            part for part in [variant_artist, variant_album, str(variant_edition or "").strip(), str(variant_year or "").strip()]
            if str(part or "").strip()
        ).strip()
        release_only_search_text = " ".join(
            part for part in [variant_album, str(variant_edition or "").strip(), str(variant_year or "").strip()]
            if str(part or "").strip()
        ).strip()
        search_specs = [
            ("master-artist-release", {"type": "master", "artist": variant_artist, "release_title": variant_album, "per_page": 8, "page": 1}),
            ("master-q", {"type": "master", "q": search_text or f"{variant_artist} {variant_album}".strip(), "per_page": 8, "page": 1}),
            ("release-artist-release", {"type": "release", "artist": variant_artist, "release_title": variant_album, "per_page": 8, "page": 1}),
            ("release-q", {"type": "release", "q": search_text or f"{variant_artist} {variant_album}".strip(), "per_page": 8, "page": 1}),
        ]
        if release_only_search_text:
            search_specs.append(("release-title-q", {"type": "release", "q": release_only_search_text, "per_page": 8, "page": 1}))
        edition_text = str(variant_edition or "").strip()
        if edition_text:
            search_specs.append(("release-edition", {"type": "release", "artist": variant_artist, "release_title": f"{variant_album} {edition_text}", "per_page": 8, "page": 1}))
        for query_mode, params in search_specs:
            if _cancel_requested(should_cancel):
                return []
            if is_rate_limited():
                break
            if variant_year:
                params["year"] = variant_year
            release_title = str(params.get("release_title") or "").strip()
            search_artist = str(params.get("artist") or "").strip()
            search_type = str(params.get("type") or "").strip()
            payload = api_get_json(
                "/database/search",
                user_agent,
                params=params,
                context=f"database-search:{query_mode}",
            )
            if _cancel_requested(should_cancel):
                return []
            if is_rate_limited():
                log_event(
                    {},
                    active_logger,
                    "Discogs search stopped after rate limit",
                    level="info",
                    artist=artist,
                    album=album,
                    year=year,
                    query_mode=query_mode,
                )
                break
            results = payload.get("results") if isinstance(payload, dict) else None
            raw_result_count = len(results) if isinstance(results, list) else 0
            log_event(
                {},
                active_logger,
                "Discogs search query completed",
                level="info",
                artist=artist,
                album=album,
                year=year,
                query_mode=query_mode,
                search_type=search_type,
                search_artist=search_artist,
                search_release_title=release_title,
                search_year=variant_year,
                raw_result_count=raw_result_count,
                payload_type=type(payload).__name__ if payload is not None else "none",
                result_preview=[
                    {
                        "title": str(item.get("title") or ""),
                        "type": str(item.get("type") or ""),
                        "year": item.get("year"),
                        "resource_url": str(item.get("resource_url") or ""),
                    }
                    for item in results[:5]
                    if isinstance(item, dict)
                ] if isinstance(results, list) else [],
            )
            if not isinstance(results, list):
                continue
            accepted_count = 0
            for result in results:
                if _cancel_requested(should_cancel):
                    return []
                if not isinstance(result, dict):
                    continue
                resource_url = str(result.get("resource_url") or "").strip()
                if not resource_url or resource_url in seen_resources:
                    continue
                seen_resources.add(resource_url)
                candidate_artist = _discogs_result_artist(result) or artist
                candidate_album = _discogs_result_album(result) or album
                candidate_year = parse_year(result.get("year")) or variant_year
                score = match_score(
                    target_artist=artist,
                    target_album=album,
                    target_edition=edition,
                    target_year=year,
                    candidate_artist=candidate_artist,
                    candidate_album=candidate_album,
                    candidate_year=candidate_year,
                    enforce_year=False,
                )
                if score <= 0:
                    continue
                accepted_count += 1
                top_results.append((score, {
                    **result,
                    "_query_mode": query_mode,
                    "_matched_artist": candidate_artist,
                    "_matched_album": candidate_album,
                    "_matched_year": candidate_year,
                }))
            log_event(
                {},
                active_logger,
                "Discogs search query filtered",
                level="info",
                artist=artist,
                album=album,
                year=year,
                query_mode=query_mode,
                search_type=search_type,
                raw_result_count=raw_result_count,
                accepted_result_count=accepted_count,
            )
        if is_rate_limited():
            break
    top_results.sort(
        key=lambda item: (
            -float(item[0] or 0.0),
            -int(parse_year(item[1].get("year")) or 0),
            str(item[1].get("resource_url") or ""),
        )
    )
    matches: list[tuple[float, str, dict[str, object]]] = []
    detail_attempt_count = min(8, len(top_results))
    expanded_master_count = 0
    for score, result in top_results[:8]:
        if _cancel_requested(should_cancel):
            return []
        result_type = str(result.get("type") or "").strip().casefold()
        if result_type == "master":
            master_id = 0
            try:
                master_id = int(result.get("id") or result.get("master_id") or 0)
            except (TypeError, ValueError):
                master_id = 0
            if master_id > 0:
                normalized_url = str(result.get("uri") or f"https://www.discogs.com/master/{master_id}").strip()
                master_matches = fetch_discogs_master_release_matches(
                    master_id,
                    normalized_url=normalized_url,
                    user_agent=user_agent,
                    target_artist=artist,
                    target_album=album,
                    target_edition=edition,
                    target_year=year,
                    api_get_json=api_get_json,
                    match_score=match_score,
                    should_cancel=should_cancel,
                )
                if _cancel_requested(should_cancel):
                    return []
                expanded_master_count += 1
                log_event(
                    {},
                    active_logger,
                    "Discogs master expanded",
                    level="info",
                    artist=artist,
                    album=album,
                    year=year,
                    master_id=master_id,
                    query_mode=str(result.get("_query_mode") or "database-search"),
                    title=str(result.get("title") or ""),
                    version_match_count=len(master_matches),
                )
                matches.extend(master_matches)
                continue
        detail_payload = api_get_json(
            str(result.get("resource_url") or ""),
            user_agent,
            context=f"{result_type}:{result.get('id') or ''}",
        ) or {}
        if _cancel_requested(should_cancel):
            return []
        fallback_artist = str(result.get("_matched_artist") or artist)
        fallback_album = str(result.get("_matched_album") or album)
        fallback_year = parse_year(result.get("_matched_year")) or year
        variant = f"database-search-{result_type or 'result'}"
        main_release_requested = False
        if result_type == "master":
            main_release_url = str(detail_payload.get("main_release_url") or "").strip()
            if main_release_url:
                main_release_requested = True
                release_payload = api_get_json(
                    main_release_url,
                    user_agent,
                    context=f"master-main-release:{detail_payload.get('id') or result.get('id') or ''}",
                ) or {}
                if _cancel_requested(should_cancel):
                    return []
                if release_payload:
                    detail_payload = release_payload
                    variant = "database-search-master-main-release"
        release_images = discogs_release_images(detail_payload, result)
        log_event(
            {},
            active_logger,
            "Discogs detail evaluated",
            level="info",
            artist=artist,
            album=album,
            year=year,
            discogs_type=result_type,
            discogs_id=result.get("id") or detail_payload.get("id"),
            query_mode=str(result.get("_query_mode") or "database-search"),
            score=round(float(score or 0.0), 4),
            title=str(result.get("title") or detail_payload.get("title") or ""),
            image_count=len(release_images),
            main_release_requested=main_release_requested,
            variant=variant,
        )
        if not release_images:
            continue
        candidate_artist, candidate_album, candidate_year, album_url = _discogs_detail_match_payload(
            detail_payload=detail_payload,
            fallback_payload=result,
            fallback_artist=fallback_artist,
            fallback_album=fallback_album,
            fallback_year=fallback_year,
            parse_year=parse_year,
        )
        score = match_score(
            target_artist=artist,
            target_album=album,
            target_edition=edition,
            target_year=year,
            candidate_artist=candidate_artist,
            candidate_album=candidate_album,
            candidate_year=candidate_year,
            enforce_year=False,
        )
        if score <= 0:
            continue
        for image in release_images:
            if _cancel_requested(should_cancel):
                return []
            match_payload = {
                "album": candidate_album,
                "artist": candidate_artist,
                "year": candidate_year,
                "album_url": album_url,
                "variant": variant,
                "host": "api.discogs.com",
                "source_label": "Discogs",
                "discogs_type": result_type,
                "discogs_id": result.get("id") or detail_payload.get("id"),
                "resource_url": str(result.get("resource_url") or ""),
                "query_mode": str(result.get("_query_mode") or "database-search"),
                "thumbnail_url": str(image.get("thumbnail_url") or image.get("url") or "").strip(),
                "art_kind": str(image.get("art_kind") or "cover"),
                "art_label": str(image.get("art_label") or ""),
            }
            if isinstance(result.get("format"), list):
                match_payload["format"] = ", ".join(str(item).strip() for item in result.get("format") or [] if str(item).strip())
            elif result.get("format") is not None:
                match_payload["format"] = result.get("format")
            if result.get("country") is not None:
                match_payload["country"] = result.get("country")
            matches.append((score, str(image.get("url") or "").strip(), match_payload))
    log_event(
        {},
        active_logger,
        "Discogs search matches prepared",
        level="info",
        artist=artist,
        album=album,
        year=year,
        unique_ranked_result_count=len(top_results),
        detail_attempt_count=detail_attempt_count,
        expanded_master_count=expanded_master_count,
        prepared_match_count=len(matches),
        prepared_matches=[
            {
                "artist": str(item[2].get("artist") or ""),
                "album": str(item[2].get("album") or ""),
                "year": item[2].get("year"),
                "discogs_type": str(item[2].get("discogs_type") or ""),
                "query_mode": str(item[2].get("query_mode") or ""),
                "score": round(float(item[0] or 0.0), 4),
                "url": str(item[1] or ""),
            }
            for item in matches[:6]
        ],
    )
    return [] if _cancel_requested(should_cancel) else matches


def search_discogs_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    build_query_variants: QueryVariants,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
    api_get_json: JsonGetter,
    log_event: LogEvent = log_app_event,
    logger=None,
    config=Config,
    should_cancel: CancelPredicate | None = None,
) -> list[CoverCandidate]:
    if _cancel_requested(should_cancel):
        return []
    active_logger = logger or _LOGGER
    matches = discogs_database_search_matches(
        artist,
        album,
        edition,
        year,
        user_agent,
        build_query_variants=build_query_variants,
        match_score=match_score,
        parse_year=parse_year,
        api_get_json=api_get_json,
        log_event=log_event,
        logger=active_logger,
        config=config,
        should_cancel=should_cancel,
    )
    if _cancel_requested(should_cancel):
        return []
    if not matches:
        log_event(
            {},
            active_logger,
            "Discogs search produced no prepared matches",
            level="info",
            artist=artist,
            album=album,
            year=year,
        )
        return []
    candidates = probe_match_candidates(
        source="discogs",
        matches=matches,
        user_agent=user_agent,
        query_mode="database-search",
        artist=artist,
        album=album,
        year=year,
        raw_results=[
            {
                "artist": str(item[2].get("artist") or ""),
                "album": str(item[2].get("album") or ""),
                "year": item[2].get("year"),
                "album_url": str(item[2].get("album_url") or ""),
                "resource_url": str(item[2].get("resource_url") or ""),
                "discogs_type": str(item[2].get("discogs_type") or ""),
            }
            for item in matches[:8]
        ],
        probe_limit=min(6, max(1, len(matches))),
        use_score_cutoff=False,
        should_cancel=should_cancel,
    )
    if _cancel_requested(should_cancel):
        return []
    log_event(
        {},
        active_logger,
        "Discogs search probe completed",
        level="info",
        artist=artist,
        album=album,
        year=year,
        prepared_match_count=len(matches),
        probed_candidate_count=len(candidates),
        selected_urls=[str(item.url or "") for item in candidates[:6]],
    )
    return candidates


def search_discogs_cover_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    build_query_variants: QueryVariants,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
    api_get_json: JsonGetter,
    log_event: LogEvent = log_app_event,
    logger=None,
    config=Config,
    should_cancel: CancelPredicate | None = None,
) -> list[dict[str, object]]:
    if _cancel_requested(should_cancel):
        return []
    candidates = search_discogs_candidates(
        artist,
        album,
        edition,
        year,
        user_agent,
        build_query_variants=build_query_variants,
        match_score=match_score,
        parse_year=parse_year,
        probe_match_candidates=probe_match_candidates,
        api_get_json=api_get_json,
        log_event=log_event,
        logger=logger,
        config=config,
        should_cancel=should_cancel,
    )
    if _cancel_requested(should_cancel):
        return []
    return build_lookup_matches_from_candidates(candidates, lookup_group="services")


def expand_discogs_url_candidates(
    normalized_url: str,
    *,
    user_agent: str,
    target_artist: str,
    target_album: str,
    target_edition: str | None,
    target_year: int | None,
    api_get_json: JsonGetter,
    match_score: MatchScore,
    parse_year: ParseYear,
    probe_match_candidates: ProbeCandidates,
    log_event: LogEvent = log_app_event,
    logger=None,
) -> list[CoverCandidate] | None:
    split = urllib.parse.urlsplit(normalized_url)
    if "discogs.com" not in split.netloc.casefold():
        return None
    active_logger = logger or _LOGGER
    master_id = parse_discogs_master_id(normalized_url)
    release_id = parse_discogs_release_id(normalized_url)
    if master_id:
        log_event(
            {},
            active_logger,
            "Manual Discogs master link detected",
            level="info",
            artist=target_artist,
            album=target_album,
            url=normalized_url,
            master_id=master_id,
        )
        discogs_matches = fetch_discogs_master_release_matches(
            master_id,
            normalized_url=normalized_url,
            user_agent=user_agent,
            target_artist=target_artist,
            target_album=target_album,
            target_edition=target_edition,
            target_year=target_year,
            api_get_json=api_get_json,
            match_score=match_score,
            allow_nonmatching=True,
        )
        if not discogs_matches:
            log_event(
                {},
                active_logger,
                "Manual Discogs master images missing",
                level="info",
                artist=target_artist,
                album=target_album,
                url=normalized_url,
                master_id=master_id,
            )
            return []
        log_event(
            {},
            active_logger,
            "Manual Discogs master images extracted",
            level="info",
            artist=target_artist,
            album=target_album,
            url=normalized_url,
            master_id=master_id,
            image_count=len(discogs_matches),
        )
        return probe_match_candidates(
            source="discogs",
            matches=discogs_matches,
            user_agent=user_agent,
            query_mode="manual-master",
            artist=target_artist,
            album=target_album,
            year=target_year,
            probe_limit=max(1, len(discogs_matches)),
            use_score_cutoff=False,
        )
    if release_id:
        release_payload = api_get_json(
            f"https://api.discogs.com/releases/{release_id}",
            user_agent,
            context=f"manual-release:{release_id}",
        ) or {}
        release_images = discogs_release_images(release_payload, {})
        if not release_images:
            return []
        candidate_artist = discogs_detail_artist(release_payload, target_artist)
        candidate_album = str(release_payload.get("title") or target_album).strip() or target_album
        candidate_year = parse_year(release_payload.get("year")) or target_year
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
        album_url = str(release_payload.get("uri") or normalized_url)
        resource_url = f"https://api.discogs.com/releases/{release_id}"
        raw_results = [{
            "artist": candidate_artist,
            "album": candidate_album,
            "year": candidate_year,
            "album_url": album_url,
            "resource_url": resource_url,
            "discogs_type": "release",
        }]
        return probe_match_candidates(
            source="discogs",
            matches=[(
                score,
                str(image.get("url") or "").strip(),
                {
                    "album": candidate_album,
                    "artist": candidate_artist,
                    "year": candidate_year,
                    "album_url": album_url,
                    "variant": "manual-release",
                    "host": "api.discogs.com",
                    "source_label": "Discogs",
                    "discogs_type": "release",
                    "discogs_id": release_id,
                    "resource_url": resource_url,
                    "thumbnail_url": str(image.get("thumbnail_url") or image.get("url") or "").strip(),
                    "art_kind": str(image.get("art_kind") or "cover"),
                    "art_label": str(image.get("art_label") or ""),
                },
            ) for image in release_images],
            user_agent=user_agent,
            query_mode="manual-release",
            artist=target_artist,
            album=target_album,
            year=target_year,
            raw_results=raw_results,
            probe_limit=max(1, len(release_images)),
            use_score_cutoff=False,
        )
    return None
