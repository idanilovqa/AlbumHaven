from __future__ import annotations

import json
import logging
import threading
import urllib.parse
from collections.abc import Callable

from config import Config
from music_app.services.music_identity_matching import (
    automatic_artist_identity_match_allowed,
    same_artist_identity,
)

_LOGGER = logging.getLogger(__name__)
_MUSICBRAINZ_RELEASE_CACHE_LOCK = threading.Lock()
_MUSICBRAINZ_RELEASE_CACHE: dict[str, list[dict]] = {}
_BANDCAMP_CONTEXT_CACHE_LOCK = threading.Lock()
_BANDCAMP_CONTEXT_CACHE: dict[str, tuple[list[str], list[str]]] = {}
_CAA_MAX_RELEASE_FETCHES = 12
_CAA_MIN_IMAGE_EDGE = 500

Normalize = Callable[[str], str]
ParseYear = Callable[[object], int | None]
MatchScore = Callable[..., float]
JsonGetter = Callable[..., dict | None]
LogEvent = Callable[..., None]
DiskCacheGetter = Callable[[str], list[dict] | None]
DiskCacheSetter = Callable[[str, list[dict]], None]
ProbeCandidateMetrics = Callable[..., dict[str, object] | None]
NormalizeRemoteImageUrl = Callable[[str], str]


def _provider_url(base_url: str, path: str) -> str:
    return f"{str(base_url or '').strip().rstrip('/')}/{str(path or '').lstrip('/')}"


def clear_musicbrainz_release_cache() -> None:
    with _MUSICBRAINZ_RELEASE_CACHE_LOCK:
        _MUSICBRAINZ_RELEASE_CACHE.clear()


def clear_musicbrainz_release_context_cache() -> None:
    with _BANDCAMP_CONTEXT_CACHE_LOCK:
        _BANDCAMP_CONTEXT_CACHE.clear()


def _cache_key(
    *,
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    normalize: Normalize,
) -> str:
    return "::".join([
        normalize(artist),
        normalize(album),
        normalize(str(edition or "")),
        str(int(year)) if isinstance(year, int) else "",
    ])


def _emit(log_event: LogEvent | None, message: str, **kwargs) -> None:
    if log_event is None:
        return
    log_event({}, _LOGGER, message, level="info", **kwargs)


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
    normalize: Normalize,
    http_get_json: JsonGetter,
    get_disk_cache: DiskCacheGetter,
    set_disk_cache: DiskCacheSetter,
    log_event: LogEvent | None,
    should_cancel: Callable[[], bool] | None = None,
) -> list[dict]:
    if callable(should_cancel) and should_cancel():
        return []
    artist_query = str(artist or "").replace('"', "").strip()
    album_query = str(album or "").replace('"', "").strip()
    if not artist_query or not album_query:
        return []
    cache_key = _cache_key(
        artist=artist_query,
        album=album_query,
        edition=edition,
        year=year,
        normalize=normalize,
    )
    with _MUSICBRAINZ_RELEASE_CACHE_LOCK:
        cached_releases = _MUSICBRAINZ_RELEASE_CACHE.get(cache_key)
    if callable(should_cancel) and should_cancel():
        return []
    if cached_releases is not None:
        _emit(
            log_event,
            "MusicBrainz release search cache hit",
            artist=artist,
            album=album,
            context_prefix=context_prefix,
            include_labels=include_labels,
            release_count=len(cached_releases),
        )
        return [dict(item) for item in cached_releases if isinstance(item, dict)]

    disk_cached_releases = get_disk_cache(cache_key)
    if callable(should_cancel) and should_cancel():
        return []
    if disk_cached_releases is not None:
        sanitized = [dict(item) for item in disk_cached_releases if isinstance(item, dict)]
        with _MUSICBRAINZ_RELEASE_CACHE_LOCK:
            _MUSICBRAINZ_RELEASE_CACHE[cache_key] = [dict(item) for item in sanitized]
        _emit(
            log_event,
            "MusicBrainz release search disk cache hit",
            artist=artist,
            album=album,
            context_prefix=context_prefix,
            include_labels=include_labels,
            release_count=len(sanitized),
        )
        return [dict(item) for item in sanitized]

    release_candidates: list[dict] = []
    release_seen_ids: set[str] = set()
    search_specs: list[tuple[str, str]] = []
    precise_parts = [f'artist:"{artist_query}"', f'release:"{album_query}"']
    if year:
        precise_parts.append(f"date:{int(year)}")
    search_specs.append(("precise", " AND ".join(precise_parts)))
    search_specs.append(("artist-release", f'artist:"{artist_query}" AND release:"{album_query}"'))
    search_specs.append(("release-only", f'release:"{album_query}"'))
    if edition:
        edition_query = str(edition or "").replace('"', "").strip()
        if edition_query:
            search_specs.append(("release-edition", f'release:"{album_query} {edition_query}"'))

    had_any_payload = False
    had_any_results = False
    for mode, query_text in search_specs:
        if callable(should_cancel) and should_cancel():
            return []
        query = urllib.parse.quote(query_text)
        inc_param = "&inc=labels+artist-credits" if include_labels else "&inc=artist-credits"
        search_url = _provider_url(
            Config.MUSICBRAINZ_BASE_URL,
            f"release/?query={query}&fmt=json&limit={max(1, int(result_limit or 20))}{inc_param}",
        )
        payload = http_get_json(
            search_url,
            user_agent,
            service="musicbrainz",
            context=f"{context_prefix}:{mode}:{artist_query} - {album_query}",
            should_cancel=should_cancel,
        )
        if callable(should_cancel) and should_cancel():
            return []
        releases = payload.get("releases") if isinstance(payload, dict) else []
        had_any_payload = had_any_payload or isinstance(payload, dict)
        had_any_results = had_any_results or (isinstance(releases, list) and len(releases) > 0)
        _emit(
            log_event,
            "MusicBrainz release search query completed",
            artist=artist,
            album=album,
            context_prefix=context_prefix,
            mode=mode,
            had_payload=isinstance(payload, dict),
            result_count=len(releases) if isinstance(releases, list) else 0,
        )
        if not isinstance(releases, list):
            continue
        for release in releases:
            if callable(should_cancel) and should_cancel():
                return []
            if not isinstance(release, dict):
                continue
            release_id = str(release.get("id") or "").strip()
            dedupe_key = release_id or json.dumps(release, sort_keys=True, ensure_ascii=True)
            if dedupe_key in release_seen_ids:
                continue
            release_seen_ids.add(dedupe_key)
            release_candidates.append(release)
    if not release_candidates:
        _emit(
            log_event,
            "MusicBrainz release search unavailable",
            artist=artist,
            album=album,
            context_prefix=context_prefix,
            include_labels=include_labels,
            reason=(
                "no_payload_from_primary_or_subprocess"
                if not had_any_payload
                else ("no_matching_releases" if had_any_results else "empty_payload_results")
            ),
        )
    sanitized_candidates = [dict(item) for item in release_candidates if isinstance(item, dict)]
    if callable(should_cancel) and should_cancel():
        return []
    with _MUSICBRAINZ_RELEASE_CACHE_LOCK:
        _MUSICBRAINZ_RELEASE_CACHE[cache_key] = [dict(item) for item in sanitized_candidates]
    set_disk_cache(cache_key, sanitized_candidates)
    return release_candidates


def _musicbrainz_bandcamp_relation_urls(payload: object) -> list[str]:
    relations = payload.get("relations") if isinstance(payload, dict) else []
    urls: list[str] = []
    seen: set[str] = set()
    for relation in relations if isinstance(relations, list) else []:
        if not isinstance(relation, dict):
            continue
        relation_url = relation.get("url") if isinstance(relation.get("url"), dict) else {}
        resource = str((relation_url or {}).get("resource") or "").strip()
        split = urllib.parse.urlsplit(resource)
        host = str(split.hostname or "").casefold()
        if (
            split.scheme not in {"http", "https"}
            or not host
            or (host != "bandcamp.com" and not host.endswith(".bandcamp.com"))
            or split.username
            or split.password
        ):
            continue
        normalized = urllib.parse.urlunsplit((split.scheme, split.netloc, split.path or "/", "", ""))
        if normalized not in seen:
            seen.add(normalized)
            urls.append(normalized)
    return urls


def fetch_musicbrainz_bandcamp_context(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    normalize: Normalize,
    similarity: Callable[[str, str], float],
    match_score: MatchScore,
    parse_year: ParseYear,
    search_release_candidates: Callable[..., list[dict]],
    http_get_json: JsonGetter,
    log_event: LogEvent | None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, list[str]]:
    empty_context = {
        "artists": [],
        "labels": [],
        "artist_account_urls": [],
        "label_account_urls": [],
    }
    if callable(should_cancel) and should_cancel():
        return empty_context
    releases = search_release_candidates(
        artist=artist,
        album=album,
        edition=edition,
        year=year,
        user_agent=user_agent,
        result_limit=20,
        include_labels=True,
        context_prefix="bandcamp-context",
        should_cancel=should_cancel,
    )
    ranked_releases: list[tuple[float, dict]] = []
    for release in releases:
        if not isinstance(release, dict):
            continue
        release_artists = [
            str((credit or {}).get("name") or "").strip()
            for credit in (release.get("artist-credit") or [])
            if isinstance(credit, dict) and str((credit or {}).get("name") or "").strip()
        ]
        score = match_score(
            target_artist=artist,
            target_album=album,
            target_edition=edition,
            target_year=year,
            candidate_artist=", ".join(release_artists),
            candidate_album=str(release.get("title") or "").strip(),
            candidate_year=parse_year(release.get("date")),
            enforce_year=False,
        )
        if score > 0:
            ranked_releases.append((float(score), release))
    ranked_releases.sort(key=lambda item: item[0], reverse=True)

    artists: list[str] = []
    labels: list[str] = []
    artist_ids: list[str] = []
    label_ids: list[str] = []
    for _score, release in ranked_releases[:12]:
        for credit in release.get("artist-credit") or []:
            if not isinstance(credit, dict):
                continue
            name = str(credit.get("name") or "").strip()
            artist_record = credit.get("artist") if isinstance(credit.get("artist"), dict) else {}
            artist_id = str((artist_record or {}).get("id") or "").strip()
            if name and name not in artists:
                artists.append(name)
            if artist_id and artist_id not in artist_ids:
                artist_ids.append(artist_id)
        for label_info in release.get("label-info") or []:
            if not isinstance(label_info, dict):
                continue
            label_record = label_info.get("label") if isinstance(label_info.get("label"), dict) else {}
            label_name = str((label_record or {}).get("name") or "").strip()
            label_id = str((label_record or {}).get("id") or "").strip()
            if label_name and label_name not in labels:
                labels.append(label_name)
            if label_id and label_id not in label_ids:
                label_ids.append(label_id)

    if not artist_ids and not (callable(should_cancel) and should_cancel()):
        artist_text = " ".join(str(artist or "").split()).strip()
        search_url = _provider_url(
            Config.MUSICBRAINZ_BASE_URL,
            "artist/?query=" + urllib.parse.quote(f'artist:"{artist_text}"') + "&fmt=json&limit=5",
        )
        search_payload = http_get_json(
            search_url,
            user_agent,
            service="musicbrainz",
            context=f"bandcamp-artist-search:{artist_text}",
            should_cancel=should_cancel,
        )
        artist_items = search_payload.get("artists") if isinstance(search_payload, dict) else []
        best_artist_id = ""
        best_artist_name = ""
        best_artist_score = 0.0
        best_artist_is_shared_identity = False
        for item in artist_items if isinstance(artist_items, list) else []:
            if not isinstance(item, dict):
                continue
            candidate_id = str(item.get("id") or "").strip()
            candidate_name = str(item.get("name") or "").strip()
            if not candidate_id or not candidate_name:
                continue
            if not automatic_artist_identity_match_allowed(artist_text, candidate_name):
                continue
            candidate_is_shared_identity = same_artist_identity(artist_text, candidate_name)
            candidate_score = float(similarity(artist_text, candidate_name) or 0.0)
            if (
                candidate_is_shared_identity and not best_artist_is_shared_identity
            ) or (
                candidate_is_shared_identity == best_artist_is_shared_identity
                and candidate_score > best_artist_score
            ):
                best_artist_id = candidate_id
                best_artist_name = candidate_name
                best_artist_score = candidate_score
                best_artist_is_shared_identity = candidate_is_shared_identity
        if best_artist_id and best_artist_score >= 0.7:
            artist_ids.append(best_artist_id)
            if best_artist_name and best_artist_name not in artists:
                artists.append(best_artist_name)
        _emit(
            log_event,
            "MusicBrainz Bandcamp artist matched",
            artist=artist,
            matched_artist_id=best_artist_id,
            matched_artist_name=best_artist_name,
            matched_artist_score=round(best_artist_score, 4),
        )

    def relation_urls(entity_type: str, entity_ids: list[str]) -> list[str]:
        found: list[str] = []
        for entity_id in entity_ids:
            if callable(should_cancel) and should_cancel():
                break
            detail_url = _provider_url(
                Config.MUSICBRAINZ_BASE_URL,
                f"{entity_type}/{urllib.parse.quote(entity_id)}?fmt=json&inc=url-rels",
            )
            payload = http_get_json(
                detail_url,
                user_agent,
                service="musicbrainz",
                context=f"bandcamp-{entity_type}-urls:{entity_id}",
                should_cancel=should_cancel,
            )
            for url in _musicbrainz_bandcamp_relation_urls(payload):
                if url not in found:
                    found.append(url)
        return found

    artist_account_urls = relation_urls("artist", artist_ids)
    label_account_urls = relation_urls("label", label_ids)
    _emit(
        log_event,
        "MusicBrainz Bandcamp context resolved",
        artist=artist,
        album=album,
        artist_count=len(artists),
        label_count=len(labels),
        artist_account_count=len(artist_account_urls),
        label_account_count=len(label_account_urls),
    )
    return {
        "artists": artists,
        "labels": labels,
        "artist_account_urls": artist_account_urls,
        "label_account_urls": label_account_urls,
    }


def fetch_musicbrainz_release_context(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    normalize: Normalize,
    match_score: MatchScore,
    parse_year: ParseYear,
    search_release_candidates: Callable[..., list[dict]],
    log_event: LogEvent | None,
) -> tuple[list[str], list[str]]:
    artist_query = str(artist or "").replace('"', "").strip()
    album_query = str(album or "").replace('"', "").strip()
    if not artist_query or not album_query:
        return [], []
    cache_key = _cache_key(
        artist=artist_query,
        album=album_query,
        edition=edition,
        year=year,
        normalize=normalize,
    )
    with _BANDCAMP_CONTEXT_CACHE_LOCK:
        cached = _BANDCAMP_CONTEXT_CACHE.get(cache_key)
    if cached is not None:
        cached_artists, cached_labels = cached
        _emit(
            log_event,
            "MusicBrainz release context cache hit",
            artist=artist,
            album=album,
            artist_count=len(cached_artists),
            label_count=len(cached_labels),
        )
        return list(cached_artists), list(cached_labels)

    release_candidates = search_release_candidates(
        artist=artist,
        album=album,
        edition=edition,
        year=year,
        user_agent=user_agent,
        result_limit=20,
        include_labels=True,
        context_prefix="bandcamp-context",
    )
    if not release_candidates:
        _emit(
            log_event,
            "MusicBrainz release context unavailable",
            artist=artist,
            album=album,
            reason="no_release_context",
        )
        return [], []

    labels: list[str] = []
    artists: list[str] = []
    seen_labels: set[str] = set()
    seen_artists: set[str] = set()
    scored_releases: list[tuple[float, dict]] = []
    release_debug: list[dict[str, object]] = []
    for release in release_candidates:
        if not isinstance(release, dict):
            continue
        release_title = str(release.get("title") or "").strip()
        release_artists = [
            str((credit or {}).get("name") or "").strip()
            for credit in (release.get("artist-credit") or [])
            if isinstance(credit, dict) and str((credit or {}).get("name") or "").strip()
        ]
        release_artist = ", ".join(release_artists)
        score = match_score(
            target_artist=artist,
            target_album=album,
            target_edition=edition,
            target_year=year,
            candidate_artist=release_artist,
            candidate_album=release_title,
            candidate_year=parse_year(release.get("date")),
            enforce_year=False,
        )
        if score > 0:
            scored_releases.append((score, release))
            release_debug.append({
                "title": release_title,
                "artist": release_artist,
                "date": str(release.get("date") or "").strip(),
                "score": round(float(score), 4),
                "labels": [
                    str((((label_info or {}).get("label") or {}).get("name") or "")).strip()
                    for label_info in (release.get("label-info") or [])
                    if isinstance(label_info, dict)
                    and str((((label_info or {}).get("label") or {}).get("name") or "")).strip()
                ][:6],
            })
    scored_releases.sort(key=lambda item: item[0], reverse=True)
    if release_debug:
        release_debug.sort(key=lambda item: float(item.get("score") or 0.0), reverse=True)
        _emit(
            log_event,
            "MusicBrainz release context candidates",
            artist=artist,
            album=album,
            release_count=len(release_debug),
            releases=release_debug[:12],
        )
    if not scored_releases:
        if artist and artist not in seen_artists:
            artists.append(artist)
        with _BANDCAMP_CONTEXT_CACHE_LOCK:
            _BANDCAMP_CONTEXT_CACHE[cache_key] = (list(artists), list(labels))
        return artists, labels

    best_score = max(score for score, _release in scored_releases)
    selected_releases: list[dict] = []
    for score, release in scored_releases:
        if len(selected_releases) >= 12:
            break
        if score + 0.12 < best_score and len(selected_releases) >= 5:
            continue
        selected_releases.append(release)
    for release in selected_releases:
        for credit in (release.get("artist-credit") or []):
            if not isinstance(credit, dict):
                continue
            name = str(credit.get("name") or "").strip()
            if name and name not in seen_artists:
                seen_artists.add(name)
                artists.append(name)
        for label_info in (release.get("label-info") or []):
            if not isinstance(label_info, dict):
                continue
            label = label_info.get("label") if isinstance(label_info.get("label"), dict) else {}
            name = str((label or {}).get("name") or "").strip()
            if name and name not in seen_labels:
                seen_labels.add(name)
                labels.append(name)
    if artist and artist not in seen_artists:
        artists.insert(0, artist)
    with _BANDCAMP_CONTEXT_CACHE_LOCK:
        _BANDCAMP_CONTEXT_CACHE[cache_key] = (list(artists), list(labels))
    return artists, labels


def search_cover_art_archive_candidates(
    artist: str,
    album: str,
    edition: str | None,
    year: int | None,
    user_agent: str,
    *,
    limit: int = 8,
    normalize: Normalize,
    parse_year: ParseYear,
    match_score: MatchScore,
    normalize_remote_image_url: NormalizeRemoteImageUrl,
    probe_candidate_metrics: ProbeCandidateMetrics,
    http_get_json: JsonGetter,
    http_get_json_via_curl: JsonGetter,
    http_get_json_via_subprocess: JsonGetter,
    get_caa_disk_cache: DiskCacheGetter,
    set_caa_disk_cache: DiskCacheSetter,
    search_musicbrainz_release_candidates: Callable[..., list[dict]],
    should_cancel: Callable[[], bool] | None = None,
    log_event: LogEvent | None = None,
) -> list[dict[str, object]]:
    if callable(should_cancel) and should_cancel():
        return []
    normalized_artist = str(artist or "").strip()
    normalized_album = str(album or "").strip()
    if not normalized_artist or not normalized_album:
        _emit(
            log_event,
            "Cover Art Archive lookup skipped",
            artist=normalized_artist,
            album=normalized_album,
            edition=str(edition or ""),
            year=year,
            reason="missing_artist_or_album",
        )
        return []
    cache_key = _cache_key(
        artist=normalized_artist,
        album=normalized_album,
        edition=edition,
        year=year,
        normalize=normalize,
    )
    cached_candidates = get_caa_disk_cache(cache_key)
    if callable(should_cancel) and should_cancel():
        return []
    if cached_candidates is not None:
        _emit(
            log_event,
            "Cover Art Archive results cache hit",
            artist=normalized_artist,
            album=normalized_album,
            candidate_count=len(cached_candidates),
        )
        return [dict(item) for item in cached_candidates if isinstance(item, dict)]

    artist_query = normalized_artist.replace('"', "")
    album_query = normalized_album.replace('"', "")
    query_parts = [f'artist:"{artist_query}"', f'release:"{album_query}"']
    if year:
        query_parts.append(f"date:{int(year)}")
    if edition:
        edition_text = str(edition).strip()
        if edition_text:
            sanitized_edition = edition_text.replace('"', "")
            query_parts.append(f'"{sanitized_edition}"')
    _emit(
        log_event,
        "Cover Art Archive lookup started",
        artist=normalized_artist,
        album=normalized_album,
        edition=str(edition or ""),
        year=year,
        limit=limit,
        query_parts=query_parts,
    )
    _emit(
        log_event,
        "CAA code marker",
        artist=normalized_artist,
        album=normalized_album,
        marker="2026-05-07-caa-ranked-release-search-v2",
    )
    if callable(should_cancel) and should_cancel():
        return []
    releases = search_musicbrainz_release_candidates(
        artist=normalized_artist,
        album=normalized_album,
        edition=edition,
        year=year,
        user_agent=user_agent,
        result_limit=max(20, int(limit or 8) * 3),
        include_labels=False,
        context_prefix="cover-art-archive-release-search",
    )
    if callable(should_cancel) and should_cancel():
        return []
    if not releases:
        _emit(
            log_event,
            "Cover Art Archive lookup finished",
            artist=normalized_artist,
            album=normalized_album,
            reason="musicbrainz_release_search_returned_no_results",
        )
        return []
    _emit(
        log_event,
        "Cover Art Archive release search completed",
        artist=normalized_artist,
        album=normalized_album,
        release_count=len(releases),
        release_ids=[str((release or {}).get("id") or "") for release in releases[:5] if isinstance(release, dict)],
    )

    ranked_releases: list[tuple[float, dict[str, object]]] = []
    for release in releases:
        if not isinstance(release, dict):
            continue
        release_title = str(release.get("title") or "").strip()
        artist_credit = ", ".join(
            str((credit or {}).get("name") or "").strip()
            for credit in (release.get("artist-credit") or [])
            if isinstance(credit, dict) and str((credit or {}).get("name") or "").strip()
        )
        release_year = parse_year(release.get("date"))
        release_score = match_score(
            target_artist=normalized_artist,
            target_album=normalized_album,
            target_edition=edition,
            target_year=year,
            candidate_artist=artist_credit,
            candidate_album=release_title,
            candidate_year=release_year,
            enforce_year=bool(year),
        )
        if release_score <= 0:
            continue
        ranked_releases.append((release_score, release))
    ranked_releases.sort(
        key=lambda item: (
            -float(item[0] or 0.0),
            -int(parse_year((item[1] or {}).get("date")) == year) if isinstance(year, int) else 0,
        ),
    )
    release_fetch_limit = min(len(ranked_releases), max(int(limit or 8) * 2, _CAA_MAX_RELEASE_FETCHES))
    _emit(
        log_event,
        "Cover Art Archive ranked release candidates",
        artist=normalized_artist,
        album=normalized_album,
        year=year,
        ranked_release_count=len(ranked_releases),
        release_fetch_limit=release_fetch_limit,
        releases=[
            {
                "release_id": str((release or {}).get("id") or ""),
                "title": str((release or {}).get("title") or ""),
                "artist": ", ".join(
                    str((credit or {}).get("name") or "").strip()
                    for credit in ((release or {}).get("artist-credit") or [])
                    if isinstance(credit, dict) and str((credit or {}).get("name") or "").strip()
                ),
                "year": parse_year((release or {}).get("date")),
                "score": round(float(score or 0.0), 4),
            }
            for score, release in ranked_releases[:10]
        ],
    )

    candidates: list[dict[str, object]] = []
    seen_urls: set[str] = set()
    releases_examined = 0
    for release_score, release in ranked_releases[:release_fetch_limit]:
        if callable(should_cancel) and should_cancel():
            return []
        release_id = str(release.get("id") or "").strip()
        if not release_id:
            continue
        releases_examined += 1
        release_title = str(release.get("title") or "").strip()
        artist_credit = ", ".join(
            str((credit or {}).get("name") or "").strip()
            for credit in (release.get("artist-credit") or [])
            if isinstance(credit, dict) and str((credit or {}).get("name") or "").strip()
        )
        release_year = parse_year(release.get("date"))
        _emit(
            log_event,
            "Cover Art Archive release candidate accepted",
            artist=normalized_artist,
            album=normalized_album,
            release_id=release_id,
            release_title=release_title,
            release_artist=artist_credit,
            release_year=release_year,
            release_score=round(float(release_score or 0.0), 4),
        )
        release_art_url = _provider_url(Config.COVER_ART_ARCHIVE_BASE_URL, f"release/{release_id}")
        if callable(should_cancel) and should_cancel():
            return []
        art_payload = http_get_json(
            release_art_url,
            user_agent,
            service="coverartarchive",
            context=f"release-art:{release_id}",
        )
        if callable(should_cancel) and should_cancel():
            return []
        if art_payload is None:
            if callable(should_cancel) and should_cancel():
                return []
            art_payload = http_get_json_via_curl(
                release_art_url,
                user_agent=user_agent,
                context=f"release-art:{release_id}",
            )
            if callable(should_cancel) and should_cancel():
                return []
        if art_payload is None:
            if callable(should_cancel) and should_cancel():
                return []
            art_payload = http_get_json_via_subprocess(
                release_art_url,
                user_agent=user_agent,
                context=f"release-art:{release_id}",
                service="coverartarchive",
            )
            if callable(should_cancel) and should_cancel():
                return []
        _emit(
            log_event,
            "Cover Art Archive payload diagnostics",
            artist=normalized_artist,
            album=normalized_album,
            release_id=release_id,
            release_title=release_title,
            payload_type=type(art_payload).__name__ if art_payload is not None else "none",
            payload_keys=sorted(list(art_payload.keys()))[:12] if isinstance(art_payload, dict) else [],
            has_images_key=isinstance(art_payload, dict) and "images" in art_payload,
            images_value_type=type(art_payload.get("images")).__name__ if isinstance(art_payload, dict) and "images" in art_payload else "missing",
        )
        images = art_payload.get("images") if isinstance(art_payload, dict) else []
        if not isinstance(images, list):
            _emit(
                log_event,
                "Cover Art Archive release returned no images list",
                artist=normalized_artist,
                album=normalized_album,
                release_id=release_id,
                release_title=release_title,
            )
            continue
        _emit(
            log_event,
            "Cover Art Archive release images fetched",
            artist=normalized_artist,
            album=normalized_album,
            release_id=release_id,
            release_title=release_title,
            image_count=len(images),
            front_image_count=sum(1 for item in images if isinstance(item, dict) and item.get("front")),
        )
        for image_index, image in enumerate(images):
            if callable(should_cancel) and should_cancel():
                return []
            if not isinstance(image, dict):
                continue
            is_front = bool(image.get("front"))
            image_types = [str(item).strip() for item in (image.get("types") or []) if str(item).strip()]
            image_url = normalize_remote_image_url(str(image.get("image") or "").strip())
            if not image_url or image_url in seen_urls:
                continue
            seen_urls.add(image_url)
            width = int(image.get("width") or 0)
            height = int(image.get("height") or 0)
            if width <= 0 or height <= 0:
                if callable(should_cancel) and should_cancel():
                    return []
                metrics = probe_candidate_metrics(
                    image_url,
                    user_agent=user_agent,
                    service="coverartarchive",
                    context=f"probe:caa:{release_id}",
                )
                if callable(should_cancel) and should_cancel():
                    return []
                if metrics:
                    width = int(metrics.get("width") or 0)
                    height = int(metrics.get("height") or 0)
            if width > 0 and height > 0 and (width < _CAA_MIN_IMAGE_EDGE or height < _CAA_MIN_IMAGE_EDGE):
                _emit(
                    log_event,
                    "Cover Art Archive image skipped",
                    artist=normalized_artist,
                    album=normalized_album,
                    release_id=release_id,
                    release_title=release_title,
                    width=width,
                    height=height,
                    reason="below_minimum_edge",
                )
                continue
            area = width * height if width > 0 and height > 0 else 0
            thumb_payload = image.get("thumbnails") if isinstance(image.get("thumbnails"), dict) else {}
            thumb_url = normalize_remote_image_url(str(thumb_payload.get("large") or thumb_payload.get("small") or image_url).strip())
            art_kind = "cover" if is_front else "other"
            art_label = "Front cover" if is_front else ", ".join(image_types) or ("Back cover" if image.get("back") else "Other art")
            candidates.append({
                "id": f"{release_id}:{image_index}",
                "source": "cover_art_archive",
                "url": image_url,
                "thumbnail_url": thumb_url or image_url,
                "width": width,
                "height": height,
                "area": area,
                "artist": artist_credit,
                "album": release_title,
                "year": release_year,
                "release_mbid": release_id,
                "art_kind": art_kind,
                "art_label": art_label,
                "score": round(float(release_score or 0.0), 4),
            })
            if len(candidates) >= max(1, int(limit or 8)):
                _emit(
                    log_event,
                    "Cover Art Archive lookup stopped early",
                    artist=normalized_artist,
                    album=normalized_album,
                    year=year,
                    candidate_count=len(candidates),
                    releases_examined=releases_examined,
                    release_fetch_limit=release_fetch_limit,
                    reason="candidate_limit_reached",
                )
                if callable(should_cancel) and should_cancel():
                    return []
                set_caa_disk_cache(cache_key, [item for item in candidates if isinstance(item, dict)])
                return candidates
    _emit(
        log_event,
        "Cover Art Archive lookup finished",
        artist=normalized_artist,
        album=normalized_album,
        releases_examined=releases_examined,
        release_fetch_limit=release_fetch_limit,
        candidate_count=len(candidates),
        candidates=[
            {
                "release_mbid": str(item.get("release_mbid") or ""),
                "album": str(item.get("album") or ""),
                "artist": str(item.get("artist") or ""),
                "year": item.get("year"),
                "score": item.get("score"),
                "width": int(item.get("width") or 0),
                "height": int(item.get("height") or 0),
                "art_label": str(item.get("art_label") or ""),
                "url": str(item.get("url") or ""),
            }
            for item in candidates[:8]
        ],
    )
    if callable(should_cancel) and should_cancel():
        return []
    set_caa_disk_cache(cache_key, [item for item in candidates if isinstance(item, dict)])
    return candidates
