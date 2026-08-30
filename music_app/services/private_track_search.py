from __future__ import annotations

import shlex
from collections import defaultdict
from collections.abc import Iterable

from music_app.services.track_preferences import (
    track_preference_matches_favorite_song_projection,
    track_preference_overlay_from_source,
)
from music_app.services.source_helpers import field_from_source
from music_app.services.utils import safe_int
from music_app.services.view_search import (
    build_search_query_contract,
    normalize_search_text,
    search_term_matches_field,
)

_PRIVATE_SHORTCUTS = {
    ":loved": ("love", "loved"),
    ":obsessed": ("love", "obsessed"),
    ":returns_to": ("return", "returns_to"),
    ":not_often": ("replay", "not_often"),
}
_PRIVATE_FIELDS = {"love", "return", "replay"}
_TRACK_SHARED_FIELDS = {"title", "artist", "album", "genre", "mood", "style"}
_REPLAY_PROJECTION_FIELDS = {"return", "replay"}
_DURATION_COMPARATORS = ("<=", ">=", "<", ">", "=")


_field = field_from_source


def _surface_result_kind(surface: str) -> str:
    normalized_surface = str(surface or "").strip()
    if normalized_surface == "favorite_songs":
        return "favorite_song_rows"
    if normalized_surface == "playlist_detail":
        return "playlist_rows"
    return "track_rows"


def build_private_track_search_contract() -> dict[str, object]:
    base_contract = build_search_query_contract()
    field_terms = dict(base_contract["grammar"]["field_terms"])
    field_terms["title"] = {
        "value_type": "string",
        "supports_quotes": True,
        "supports_fuzzy_commit": True,
        "availability": "shared",
    }
    field_terms["album"] = {
        "value_type": "string",
        "supports_quotes": True,
        "supports_fuzzy_commit": True,
        "availability": "shared",
    }
    return {
        "shared_surfaces": [
            "favorite_songs",
            "playlist_detail",
        ],
        "supported_result_kinds": [
            "favorite_song_rows",
            "playlist_rows",
        ],
        "draft_commit_model": dict(base_contract["draft_commit_model"]),
        "grammar": {
            "shortcut_tokens": [token["token"] for token in base_contract["grammar"]["shortcut_tokens"]],
            "field_terms": field_terms,
        },
        "unsupported_filter_policy": {
            "behavior": "fail_closed",
            "returns_feedback": True,
        },
    }


def _duration_seconds_from_token(raw_value: str) -> int | None:
    value = str(raw_value or "").strip().casefold()
    if not value:
        return None
    if value.endswith("ms"):
        return None
    total_seconds = 0
    remaining = value
    hours_index = remaining.find("h")
    if hours_index != -1:
        hours = safe_int(remaining[:hours_index])
        if hours is None:
            return None
        total_seconds += int(hours) * 3600
        remaining = remaining[hours_index + 1 :]
    minutes_index = remaining.find("m")
    if minutes_index != -1:
        minutes = safe_int(remaining[:minutes_index])
        if minutes is None:
            return None
        total_seconds += int(minutes) * 60
        remaining = remaining[minutes_index + 1 :]
    seconds_text = remaining[:-1] if remaining.endswith("s") else remaining
    if seconds_text:
        seconds = safe_int(seconds_text)
        if seconds is None:
            return None
        total_seconds += int(seconds)
    return total_seconds


def _parse_duration_filter(value: str) -> tuple[str, int] | None:
    raw_value = str(value or "").strip()
    if not raw_value:
        return None
    comparator = "="
    remainder = raw_value
    for candidate in _DURATION_COMPARATORS:
        if raw_value.startswith(candidate):
            comparator = candidate
            remainder = raw_value[len(candidate) :]
            break
    duration_seconds = _duration_seconds_from_token(remainder)
    if duration_seconds is None:
        return None
    return comparator, duration_seconds


def _normalize_source_values(source: object, field_name: str) -> list[str]:
    raw_value = _field(source, field_name, None)
    if raw_value is None:
        return []
    if isinstance(raw_value, (list, tuple, set)):
        values = list(raw_value)
    else:
        values = [raw_value]
    normalized_values: list[str] = []
    seen = set()
    for value in values:
        text = " ".join(str(value or "").strip().split())
        if not text:
            continue
        normalized_key = text.casefold()
        if normalized_key in seen:
            continue
        seen.add(normalized_key)
        normalized_values.append(text)
    return normalized_values


def _build_unsupported_filter(token: str, field: str, value: str, reason: str) -> dict[str, str]:
    return {
        "token": token,
        "field": field,
        "value": value,
        "reason": reason,
    }


def _parse_private_track_query(
    query: object,
    *,
    authorized_private: bool,
) -> dict[str, object]:
    raw_query = " ".join(str(query or "").strip().split())
    parsed = {
        "free_text_terms": [],
        "field_filters": [],
        "duration_filters": [],
        "unsupported_filters": [],
    }
    if not raw_query:
        return parsed

    try:
        raw_tokens = shlex.split(raw_query)
    except ValueError:
        parsed["unsupported_filters"].append(
            _build_unsupported_filter(raw_query, "", "", "invalid_filter")
        )
        return parsed

    for raw_token in raw_tokens:
        negated = raw_token.startswith("-")
        token = raw_token[1:] if negated else raw_token
        if not token:
            continue
        shortcut = _PRIVATE_SHORTCUTS.get(token)
        if shortcut is not None:
            field_name, filter_value = shortcut
            if not authorized_private:
                parsed["unsupported_filters"].append(
                    _build_unsupported_filter(token, field_name, filter_value, "unauthorized_private_filter")
                )
                continue
            if field_name in _REPLAY_PROJECTION_FIELDS:
                parsed["unsupported_filters"].append(
                    _build_unsupported_filter(token, field_name, filter_value, "projection_unavailable")
                )
                continue
            parsed["field_filters"].append(
                {
                    "field": field_name,
                    "value": filter_value,
                    "negated": negated,
                    "token": token,
                }
            )
            continue

        if ":" not in token:
            parsed["free_text_terms"].append(
                {
                    "value": normalize_search_text(token),
                    "negated": negated,
                    "token": token,
                }
            )
            continue

        field_name, raw_value = token.split(":", 1)
        normalized_field = str(field_name or "").strip().casefold()
        normalized_value = str(raw_value or "").strip()
        if not normalized_field or not normalized_value:
            parsed["unsupported_filters"].append(
                _build_unsupported_filter(token, normalized_field, normalized_value, "invalid_filter")
            )
            continue
        if normalized_field == "duration":
            duration_filter = _parse_duration_filter(normalized_value)
            if duration_filter is None:
                parsed["unsupported_filters"].append(
                    _build_unsupported_filter(token, normalized_field, normalized_value, "invalid_filter")
                )
                continue
            comparator, duration_seconds = duration_filter
            parsed["duration_filters"].append(
                {
                    "field": "duration",
                    "comparator": comparator,
                    "seconds": duration_seconds,
                    "negated": negated,
                    "token": token,
                }
            )
            continue
        if normalized_field in _PRIVATE_FIELDS:
            if not authorized_private:
                parsed["unsupported_filters"].append(
                    _build_unsupported_filter(token, normalized_field, normalized_value, "unauthorized_private_filter")
                )
                continue
            if normalized_field in _REPLAY_PROJECTION_FIELDS:
                parsed["unsupported_filters"].append(
                    _build_unsupported_filter(token, normalized_field, normalized_value, "projection_unavailable")
                )
                continue
            parsed["field_filters"].append(
                {
                    "field": normalized_field,
                    "value": normalized_value.casefold(),
                    "negated": negated,
                    "token": token,
                }
            )
            continue
        if normalized_field in _TRACK_SHARED_FIELDS:
            parsed["field_filters"].append(
                {
                    "field": normalized_field,
                    "value": normalized_value,
                    "negated": negated,
                    "token": token,
                }
            )
            continue
        parsed["unsupported_filters"].append(
            _build_unsupported_filter(token, normalized_field, normalized_value, "unknown_field")
        )
    return parsed


def _matches_duration(duration_seconds: int, comparator: str, expected_seconds: int) -> bool:
    if comparator == "<":
        return duration_seconds < expected_seconds
    if comparator == "<=":
        return duration_seconds <= expected_seconds
    if comparator == ">":
        return duration_seconds > expected_seconds
    if comparator == ">=":
        return duration_seconds >= expected_seconds
    return duration_seconds == expected_seconds


def _source_matches_field_filter(source: object, field_name: str, value: str) -> bool:
    if field_name == "love":
        overlay = track_preference_overlay_from_source(source)
        return track_preference_matches_favorite_song_projection(overlay, love_tier=value)
    source_values = _normalize_source_values(source, field_name)
    if not source_values:
        return False
    normalized_query = normalize_search_text(value)
    if not normalized_query:
        return False
    for source_value in source_values:
        normalized_source = normalize_search_text(source_value)
        if not normalized_source:
            continue
        if " " in normalized_query:
            if normalized_query == normalized_source or normalized_query in normalized_source:
                return True
            continue
        if search_term_matches_field(normalized_query, normalized_source):
            return True
    return False


def _source_matches_free_text(source: object, term: str) -> bool:
    if not term:
        return True
    search_fields: list[str] = []
    for field_name in ("title", "artist", "album"):
        search_fields.extend(_normalize_source_values(source, field_name))
    return any(search_term_matches_field(term, normalize_search_text(field_value)) for field_value in search_fields)


def _source_matches_duration_filter(source: object, duration_filter: dict[str, object]) -> bool:
    duration_seconds = safe_int(_field(source, "duration_seconds", None)) or 0
    return _matches_duration(
        duration_seconds,
        str(duration_filter["comparator"]),
        int(duration_filter["seconds"]),
    )


def _matches_grouped_field_filters(source: object, field_filters: list[dict[str, object]]) -> bool:
    positive_by_field: dict[str, list[dict[str, object]]] = defaultdict(list)
    negative_filters: list[dict[str, object]] = []
    for field_filter in field_filters:
        if field_filter["negated"]:
            negative_filters.append(field_filter)
            continue
        positive_by_field[str(field_filter["field"])].append(field_filter)

    for negative_filter in negative_filters:
        if _source_matches_field_filter(source, str(negative_filter["field"]), str(negative_filter["value"])):
            return False

    for field_name, grouped_filters in positive_by_field.items():
        if not any(
            _source_matches_field_filter(source, field_name, str(grouped_filter["value"]))
            for grouped_filter in grouped_filters
        ):
            return False
    return True


def _matches_free_text_terms(source: object, free_text_terms: list[dict[str, object]]) -> bool:
    for term in free_text_terms:
        term_matches = _source_matches_free_text(source, str(term["value"]))
        if term["negated"]:
            if term_matches:
                return False
            continue
        if not term_matches:
            return False
    return True


def _matches_duration_filters(source: object, duration_filters: list[dict[str, object]]) -> bool:
    for duration_filter in duration_filters:
        duration_matches = _source_matches_duration_filter(source, duration_filter)
        if duration_filter["negated"]:
            if duration_matches:
                return False
            continue
        if not duration_matches:
            return False
    return True


def _base_surface_sources(
    sources: Iterable[object],
    *,
    surface: str,
) -> list[object]:
    candidate_sources = list(sources or [])
    if surface != "favorite_songs":
        return candidate_sources
    favorite_sources: list[object] = []
    for source in candidate_sources:
        if track_preference_matches_favorite_song_projection(track_preference_overlay_from_source(source)):
            favorite_sources.append(source)
    return favorite_sources


def filter_private_track_sources(
    sources: Iterable[object],
    *,
    query: object = None,
    surface: str,
    authorized_private: bool,
) -> dict[str, object]:
    parsed_query = _parse_private_track_query(query, authorized_private=authorized_private)
    scoped_sources = _base_surface_sources(sources, surface=surface)
    if parsed_query["unsupported_filters"]:
        matched_sources: list[object] = []
    else:
        matched_sources = [
            source
            for source in scoped_sources
            if _matches_grouped_field_filters(source, list(parsed_query["field_filters"]))
            and _matches_free_text_terms(source, list(parsed_query["free_text_terms"]))
            and _matches_duration_filters(source, list(parsed_query["duration_filters"]))
        ]
    return {
        "surface": surface,
        "result_kind": _surface_result_kind(surface),
        "query": " ".join(str(query or "").strip().split()),
        "matched_sources": matched_sources,
        "unsupported_filters": list(parsed_query["unsupported_filters"]),
    }
