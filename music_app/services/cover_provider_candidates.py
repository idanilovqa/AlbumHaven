from __future__ import annotations

import hashlib
import re
import urllib.parse
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from music_app.services import cover_provider_matching


@dataclass(slots=True)
class CoverCandidate:
    source: str
    url: str
    score: float = 0.0
    width: int = 0
    height: int = 0
    raw_bytes: bytes | None = None
    matched_artist: str = ""
    matched_album: str = ""
    matched_year: int | None = None
    matched_edition: str = ""
    debug_payload: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class SelectedRemoteImage:
    id: str = ""
    url: str = ""
    thumbnail_url: str = ""
    source: str = ""
    source_label: str = ""
    lookup_group: str = ""
    album_url: str = ""
    width: int = 0
    height: int = 0
    score: float = 0.0
    display_only: bool = False
    art_kind: str = "cover"
    art_label: str = ""
    query_mode: str = ""
    variant: str = ""


CURRENT_USE_COVER_CANDIDATE_FIELDS = frozenset({
    "source",
    "url",
    "score",
    "width",
    "height",
    "raw_bytes",
    "matched_artist",
    "matched_album",
    "matched_year",
    "matched_edition",
    "debug_payload",
})

CURRENT_USE_LOOKUP_MATCH_FIELDS = frozenset({
    "id",
    "source",
    "source_label",
    "lookup_group",
    "url",
    "thumbnail_url",
    "width",
    "height",
    "resolution",
    "area",
    "artist",
    "album",
    "year",
    "score",
    "album_url",
    "query_mode",
    "variant",
    "display_only",
    "art_kind",
    "art_label",
    "debug",
})

CURRENT_USE_SELECTED_REMOTE_IMAGE_FIELDS = frozenset({
    "id",
    "url",
    "thumbnail_url",
    "source",
    "source_label",
    "lookup_group",
    "album_url",
    "width",
    "height",
    "score",
    "display_only",
    "art_kind",
    "art_label",
    "query_mode",
    "variant",
})


SERVICE_SOURCE_LABELS = {
    "apple": "Apple Music",
    "amazon": "Amazon",
    "artist_website": "Artist Website",
    "deezer": "Deezer",
    "bandcamp": "Bandcamp",
    "spotify": "Spotify",
    "youtube_music": "YouTube Music",
    "discogs": "Discogs",
    "cover_art_archive": "Cover Art Archive",
    "genius": "Genius",
    "direct_url": "Direct URL",
}

DISPLAY_ONLY_REMOTE_SOURCES = {
    "spotify",
}

CURRENT_USE_CANDIDATE_DEBUG_FIELDS = frozenset({
    "album_url",
    "art_kind",
    "art_label",
    "probed_contenders",
    "query_mode",
    "raw_results",
    "source_label",
    "thumbnail_url",
    "variant",
})

CURRENT_USE_CANDIDATE_DIAGNOSTIC_ITEM_FIELDS = frozenset({
    "album",
    "album_url",
    "area",
    "artist",
    "artists",
    "artwork_url",
    "browseId",
    "candidate_height",
    "candidate_score",
    "candidate_width",
    "date",
    "discogs_type",
    "has_cover",
    "height",
    "image",
    "label",
    "name",
    "probe_urls",
    "query_mode",
    "resource_url",
    "score",
    "sharpness",
    "source_label",
    "status",
    "thumbnail_url",
    "title",
    "type",
    "url",
    "variant",
    "width",
    "year",
})

CURRENT_USE_NESTED_DIAGNOSTIC_ITEM_FIELDS = frozenset({
    "name",
    "url",
})


def _unsupported_current_use_fields(
    payload: Mapping[str, object],
    allowed_fields: frozenset[str],
) -> list[str]:
    return sorted(str(key) for key in payload.keys() if str(key) not in allowed_fields)


def cover_candidate_from_current_use_payload(payload: Mapping[str, object]) -> CoverCandidate:
    unsupported_fields = _unsupported_current_use_fields(
        payload,
        CURRENT_USE_COVER_CANDIDATE_FIELDS,
    )
    if unsupported_fields:
        raise ValueError(
            "Unsupported cover provider candidate field(s): "
            + ", ".join(unsupported_fields)
        )
    return CoverCandidate(**{
        key: payload[key]
        for key in CURRENT_USE_COVER_CANDIDATE_FIELDS
        if key in payload
    })


def current_use_lookup_match_payload(match: Mapping[str, object]) -> dict[str, object]:
    unsupported_fields = _unsupported_current_use_fields(match, CURRENT_USE_LOOKUP_MATCH_FIELDS)
    if unsupported_fields:
        raise ValueError(
            "Unsupported cover lookup match field(s): "
            + ", ".join(unsupported_fields)
        )
    shaped_match = dict(match)
    debug_payload = shaped_match.get("debug")
    if isinstance(debug_payload, dict):
        shaped_match["debug"] = {
            key: _current_use_candidate_diagnostic_items(value)
            for key, value in debug_payload.items()
            if key in {"raw_results", "probed_contenders"}
        }
    return shaped_match


def _current_use_diagnostic_scalar(value: object) -> object:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _current_use_nested_diagnostic_mapping(payload: Mapping[str, object]) -> dict[str, object]:
    return {
        key: _current_use_diagnostic_scalar(value)
        for key, value in payload.items()
        if key in CURRENT_USE_NESTED_DIAGNOSTIC_ITEM_FIELDS
    }


def _current_use_diagnostic_value(value: object) -> object:
    if isinstance(value, list):
        shaped_values: list[object] = []
        for item in value:
            if isinstance(item, Mapping):
                shaped_item = _current_use_nested_diagnostic_mapping(item)
                if shaped_item:
                    shaped_values.append(shaped_item)
            elif item is None or isinstance(item, (str, int, float, bool)):
                shaped_values.append(item)
        return shaped_values
    if isinstance(value, Mapping):
        return _current_use_nested_diagnostic_mapping(value)
    return _current_use_diagnostic_scalar(value)


def _first_present(payload: Mapping[str, object], *keys: str) -> object:
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return value
    return None


def _diagnostic_year_from_date(value: object) -> int | None:
    if isinstance(value, int):
        return value
    match = re.match(r"\s*(\d{4})", str(value or ""))
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _provider_key_diagnostic_summary(payload: Mapping[str, object]) -> dict[str, object]:
    summary: dict[str, object] = {}

    artist = _first_present(payload, "artistName")
    if artist is not None:
        summary["artist"] = artist
    album = _first_present(payload, "collectionName")
    if album is not None:
        summary["album"] = album
    release_date = _first_present(payload, "releaseDate")
    if release_date is not None:
        summary["date"] = release_date
        release_year = _diagnostic_year_from_date(release_date)
        if release_year is not None:
            summary["year"] = release_year
    album_url = _first_present(payload, "collectionViewUrl")
    if album_url is not None:
        summary["album_url"] = album_url
    artwork_url = _first_present(
        payload,
        "artworkUrl100",
        "artworkUrl600",
        "artworkUrl512",
        "artworkUrl60",
        "artworkUrl30",
    )
    if artwork_url is not None:
        summary["artwork_url"] = artwork_url
        summary["thumbnail_url"] = artwork_url
    artwork_width = _first_present(payload, "artworkWidth")
    if artwork_width is not None:
        summary["width"] = artwork_width
    artwork_height = _first_present(payload, "artworkHeight")
    if artwork_height is not None:
        summary["height"] = artwork_height
    return summary


def current_use_candidate_diagnostic_item(payload: object) -> dict[str, object]:
    if not isinstance(payload, Mapping):
        return {}
    summarized_payload = {
        **_provider_key_diagnostic_summary(payload),
        **payload,
    }
    return {
        key: _current_use_diagnostic_value(value)
        for key, value in summarized_payload.items()
        if key in CURRENT_USE_CANDIDATE_DIAGNOSTIC_ITEM_FIELDS
    }


def _current_use_candidate_diagnostic_items(payload: object) -> list[dict[str, object]]:
    if not isinstance(payload, list):
        return []
    return [
        shaped_item
        for item in payload
        if (shaped_item := current_use_candidate_diagnostic_item(item))
    ]


def current_use_candidate_debug_payload(debug_payload: dict[str, object] | None) -> dict[str, object]:
    if not isinstance(debug_payload, dict):
        return {}
    shaped_debug: dict[str, object] = {}
    for key, value in debug_payload.items():
        if key not in CURRENT_USE_CANDIDATE_DEBUG_FIELDS:
            continue
        if key in {"raw_results", "probed_contenders"}:
            shaped_debug[key] = _current_use_candidate_diagnostic_items(value)
        else:
            shaped_debug[key] = value
    return shaped_debug


def normalize_remote_image_url(url: str) -> str:
    split = urllib.parse.urlsplit(str(url or "").strip())
    if not split.netloc:
        return str(url or "").strip()
    scheme = split.scheme or "https"
    if scheme == "http" and "coverartarchive.org" in split.netloc.casefold():
        scheme = "https"
    return urllib.parse.urlunsplit((scheme, split.netloc, split.path, split.query, ""))


def normalize_pasted_cover_url(url: str) -> str:
    trimmed = str(url or "").strip()
    if not trimmed:
        return ""
    split = urllib.parse.urlsplit(trimmed)
    if not split.scheme and not split.netloc:
        first_path_part = split.path.split("/", 1)[0]
        if first_path_part and "." in first_path_part and not any(char.isspace() for char in first_path_part):
            split = urllib.parse.urlsplit(f"https://{trimmed}")
    return urllib.parse.urlunsplit((split.scheme or "https", split.netloc, split.path, split.query, ""))


def normalize_pasted_cover_urls(raw_urls: list[str]) -> list[str]:
    normalized_urls: list[str] = []
    seen_raw_urls: set[str] = set()
    seen_normalized_urls: set[str] = set()
    for raw_url in raw_urls:
        trimmed_url = str(raw_url or "").strip()
        if not trimmed_url or trimmed_url in seen_raw_urls:
            continue
        seen_raw_urls.add(trimmed_url)
        normalized_url = normalize_pasted_cover_url(trimmed_url)
        normalized_key = normalized_url.casefold()
        if not normalized_url or normalized_key in seen_normalized_urls:
            continue
        seen_normalized_urls.add(normalized_key)
        normalized_urls.append(normalized_url)
    return normalized_urls


def manual_source_details(url: str) -> tuple[str, str]:
    normalized_url = str(url or "").strip()
    split = urllib.parse.urlsplit(normalized_url)
    host = (split.netloc or "").casefold()
    if "music.apple.com" in host or "itunes.apple.com" in host:
        return "apple", "Apple Music"
    if "amazon." in host:
        return "amazon", "Amazon"
    if "discogs.com" in host or "api.discogs.com" in host or "i.discogs.com" in host:
        return "discogs", "Discogs"
    if "spotify.com" in host or "scdn.co" in host:
        return "spotify", "Spotify"
    if "deezer.com" in host or "dzcdn.net" in host:
        return "deezer", "Deezer"
    if "bandcamp.com" in host or "bcbits.com" in host:
        return "bandcamp", "Bandcamp"
    if "music.youtube.com" in host or "ytimg.com" in host:
        return "youtube_music", "YouTube Music"
    return "direct_url", split.netloc or normalized_url


def dedupe_cover_candidates(candidates: list[CoverCandidate]) -> list[CoverCandidate]:
    return cover_provider_matching.dedupe_candidates(candidates)


def cover_candidate_to_lookup_match(candidate: CoverCandidate, *, lookup_group: str) -> dict[str, object]:
    debug_payload = candidate.debug_payload if isinstance(candidate.debug_payload, dict) else {}
    album_url = str(debug_payload.get("album_url") or "")
    query_mode = str(debug_payload.get("query_mode") or "")
    variant = str(debug_payload.get("variant") or "")
    art_kind = str(debug_payload.get("art_kind") or "cover").strip() or "cover"
    art_label = str(debug_payload.get("art_label") or "").strip()
    normalized_url = normalize_remote_image_url(candidate.url)
    thumbnail_url = normalize_remote_image_url(str(debug_payload.get("thumbnail_url") or candidate.url or "").strip())
    candidate_key = "|".join([
        str(lookup_group or ""),
        str(candidate.source or ""),
        str(candidate.matched_artist or ""),
        str(candidate.matched_album or ""),
        str(candidate.matched_year or ""),
        normalized_url,
    ])
    match = {
        "id": hashlib.sha1(candidate_key.encode("utf-8", "ignore")).hexdigest(),
        "source": candidate.source,
        "source_label": str(debug_payload.get("source_label") or SERVICE_SOURCE_LABELS.get(candidate.source, str(candidate.source or "").title())),
        "lookup_group": lookup_group,
        "url": normalized_url,
        "thumbnail_url": thumbnail_url or normalized_url,
        "width": int(candidate.width or 0),
        "height": int(candidate.height or 0),
        "resolution": f"{int(candidate.width or 0)}x{int(candidate.height or 0)}" if candidate.width and candidate.height else "Unknown",
        "area": int(candidate.width or 0) * int(candidate.height or 0),
        "artist": candidate.matched_artist,
        "album": candidate.matched_album,
        "year": candidate.matched_year,
        "score": round(float(candidate.score or 0.0), 4),
        "album_url": album_url,
        "query_mode": query_mode,
        "variant": variant,
        "display_only": candidate.source in DISPLAY_ONLY_REMOTE_SOURCES or art_kind != "cover",
        "art_kind": art_kind,
        "art_label": art_label,
    }
    raw_results = debug_payload.get("raw_results")
    probed_contenders = debug_payload.get("probed_contenders")
    if isinstance(raw_results, list) or isinstance(probed_contenders, list):
        match["debug"] = {
            "raw_results": _current_use_candidate_diagnostic_items(raw_results),
            "probed_contenders": _current_use_candidate_diagnostic_items(probed_contenders),
        }
    return current_use_lookup_match_payload(match)


def selected_remote_image_from_lookup_match(match: dict[str, object]) -> SelectedRemoteImage:
    art_kind = str(match.get("art_kind") or "cover").strip() or "cover"
    normalized_url = normalize_remote_image_url(str(match.get("url") or ""))
    thumbnail_url = normalize_remote_image_url(str(match.get("thumbnail_url") or normalized_url))
    return SelectedRemoteImage(
        id=str(match.get("id") or "").strip(),
        url=normalized_url,
        thumbnail_url=thumbnail_url or normalized_url,
        source=str(match.get("source") or "").strip(),
        source_label=str(match.get("source_label") or "").strip(),
        lookup_group=str(match.get("lookup_group") or "").strip(),
        album_url=str(match.get("album_url") or "").strip(),
        width=int(match.get("width") or 0),
        height=int(match.get("height") or 0),
        score=float(match.get("score") or 0.0),
        display_only=bool(match.get("display_only")),
        art_kind=art_kind,
        art_label=str(match.get("art_label") or "").strip(),
        query_mode=str(match.get("query_mode") or "").strip(),
        variant=str(match.get("variant") or "").strip(),
    )


def build_lookup_matches_from_candidates(
    candidates: list[CoverCandidate],
    *,
    lookup_group: str = "services",
) -> list[dict[str, object]]:
    return [
        cover_candidate_to_lookup_match(candidate, lookup_group=lookup_group)
        for candidate in dedupe_cover_candidates(candidates)
    ]


def build_manual_lookup_matches_from_candidates(
    candidates: list[CoverCandidate],
    *,
    fallback_source_label: str = "Manual link",
    build_matches: Callable[..., list[dict[str, object]]] = build_lookup_matches_from_candidates,
) -> list[dict[str, object]]:
    matches = build_matches(candidates, lookup_group="manual_links")
    for item in matches:
        if str(item.get("source_label") or "").strip():
            continue
        debug_payload = item.get("debug_payload") if isinstance(item.get("debug_payload"), dict) else {}
        manual_source_label = str((debug_payload or {}).get("source_label") or "").strip()
        item["source_label"] = manual_source_label or fallback_source_label
    return matches
