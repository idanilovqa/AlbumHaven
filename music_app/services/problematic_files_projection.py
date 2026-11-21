"""Pure Problematic Files projection helpers.

The durable worker and request-time reader share this module. It contains no
repository, route, worker, database, or process-global state.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import heapq
import itertools
import json
import os
import re
import tempfile
import unicodedata
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from os.path import basename
from pathlib import Path
from typing import BinaryIO

from music_app.services.library_roots import (
    build_root_provenance_payload,
    summarize_root_provenance_payloads,
)
from music_app.services.metadata import build_text_repairs_for_entry, normalize_exception_value
from music_app.services.edition_title_normalization import reviewable_edition_title
from music_app.services.utils import looks_like_mojibake

_UNKNOWN_VALUES = {"", "unknown", "unknown artist", "unknown album", "none", "null"}
_MAX_PERSISTED_ITEM_KEY_BYTES = 256
_MAX_PERSISTED_SORT_TEXT_BYTES = 512
_MAX_TRACK_ORDER_NUMBER = 99
_MAX_EXPANDED_MISSING_TRACK_POSITIONS = 10
_OPTIONAL_SUMMARY_FIELDS = frozenset({
    "cover_path", "cover_revision", "local_cover_width", "local_cover_height",
    "remote_cover_url", "remote_cover_thumbnail_url", "remote_cover_source",
    "remote_cover_source_label", "remote_cover_album_url", "remote_cover_width",
    "remote_cover_height", "year", "release_date", "edition", "album_rating",
    "cover_width", "cover_height", "raw_name", "raw_album_artist",
})


def text_problem_reason(
    label: str,
    value: str,
    *,
    detect_encoding: bool = True,
) -> str | None:
    normalized = (value or "").strip()
    lowered = normalized.casefold()
    if lowered in _UNKNOWN_VALUES:
        return f"Missing {label.strip().casefold()}"
    if "??" in normalized or normalized == "?" or "пїЅ" in normalized:
        return "Undecoded characters"
    if detect_encoding and looks_like_mojibake(normalized):
        return "Encoding problem"
    return None


def year_problem_reason(year: object) -> str | None:
    if year is None or str(year).strip() == "":
        return "Missing year"
    try:
        value = int(year)
    except Exception:
        return "Invalid year"
    return "Invalid year" if value <= 0 else None


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return {}
    return value if isinstance(value, Mapping) else {}


def _strings(value: object) -> list[str]:
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, (list, tuple, set)):
        values = list(value)
    else:
        values = []
    return [str(item or "").strip() for item in values if str(item or "").strip()]


def _album_base_key(
    album_artist: object,
    album_name: object,
    edition: object,
) -> str:
    parts = [
        str(album_artist or "").strip().lower(),
        str(album_name or "").strip().lower(),
    ]
    edition_text = str(edition or "").strip()
    if edition_text:
        parts.append(edition_text.lower())
    return "::".join(parts)


def _integer(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _file_type(path: object) -> str:
    filename = re.split(r"[\\/]", str(path or ""))[-1]
    _stem, separator, suffix = filename.rpartition(".")
    return suffix.upper() if separator and suffix else ""

_PROBLEM_REASON_IDENTITY_CODES = {
    "Empty audio file": "empty-audio-file",
    "Mixed album metadata in one folder": "mixed-album-folder",
    "Missing artist": "missing-artist",
    "Missing album": "missing-album",
    "Missing track title": "missing-track-title",
    "Missing track artist": "missing-track-artist",
    "Missing album artist": "missing-album-artist",
    "Missing year": "missing-year",
    "Invalid year": "invalid-year",
    "Missing track number": "missing-track-number",
    "Invalid track number": "invalid-track-number",
    "Missing cover art": "missing-cover-art",
    "Poor art quality": "poor-art-quality",
    "Duplicate files": "duplicate-files",
    "Album name mismatch": "album-name-mismatch",
    "Album artist mismatch": "album-artist-mismatch",
    "Year mismatch": "year-mismatch",
    "Inconsistent year": "inconsistent-year",
    "Undecoded characters": "undecoded-characters",
    "Encoding problem": "encoding-problem",
}
_PROBLEM_REASON_BY_IDENTITY_CODE = {
    code: reason for reason, code in _PROBLEM_REASON_IDENTITY_CODES.items()
}
_ENCODED_PROBLEM_REASON_PREFIX = "reason-b64-"

def problematic_album_identity(
    row: Mapping[str, object],
    artist_display: str,
    *,
    metadata: Mapping[str, object],
    separate_release_keys: set[str] | None = None,
    base_key: str | None = None,
) -> tuple[object, str, object]:
    artist = metadata.get("album_artist") or artist_display
    edition = metadata.get("edition", row.get("album_edition"))
    resolved_base_key = base_key or _album_base_key(artist, row.get("album_title"), edition)
    file_entry = _mapping(row.get("file_entry"))
    year = file_entry.get(
        "year", row.get("file_year", row.get("album_release_year"))
    )
    resolved_separate_release_keys = (
        separate_release_keys
        if separate_release_keys is not None
        else set(_strings(row.get("separate_release_keys")))
    )
    year_text = str(year or "").strip().lower()
    if year_text and (
        row.get("separate_release_member")
        or row.get("separate_release")
        or resolved_base_key in resolved_separate_release_keys
    ):
        key = f"{resolved_base_key}::year::{year_text}"
        return key, key, year
    album_id = row.get("album_id")
    key = str(row.get("album_key") or "").strip()
    return album_id if album_id is not None else key, key, row.get("album_release_year")


def problematic_projection_id(row: Mapping[str, object]) -> str:
    """Return the collision-free durable locator for one projected item."""
    album_id = row.get("album_id")
    opaque_key = str(row.get("album_key") or "").strip()
    if album_id is None:
        locator_kind = (
            "missing"
            if str(row.get("inventory_status") or "").strip().casefold() == "missing"
            else "loose"
        )
        locator: list[object] = [1, locator_kind, opaque_key]
    else:
        metadata = _mapping(row.get("album_metadata"))
        artist = metadata.get("album_artist") or row.get("artist_name")
        edition = metadata.get("edition", row.get("album_edition"))
        base_key = _album_base_key(artist, row.get("album_title"), edition)
        separate_release_keys = set(_strings(row.get("separate_release_keys")))
        if row.get("separate_release_member") or row.get("separate_release"):
            separate_release_keys.add(base_key)
        file_entry = _mapping(row.get("file_entry"))
        raw_year = file_entry.get(
            "year", row.get("file_year", row.get("album_release_year"))
        )
        year_text = str(raw_year or "").strip()
        split_year: object = None
        if base_key in separate_release_keys and year_text:
            split_year = int(year_text) if year_text.isdigit() else year_text.casefold()
        locator = [1, "album", album_id, split_year]
    locator_payload = json.dumps(
        locator,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    encoded = base64.urlsafe_b64encode(locator_payload).decode("ascii").rstrip("=")
    if len(encoded.encode("utf-8")) > _MAX_PERSISTED_ITEM_KEY_BYTES:
        digest = base64.urlsafe_b64encode(
            hashlib.sha256(locator_payload).digest()
        ).decode("ascii").rstrip("=")
        return f"h1:{digest}"
    return encoded


def _utf8_prefix(value: object, maximum_bytes: int) -> str:
    text = str(value or "")
    encoded = text.encode("utf-8")
    if len(encoded) <= maximum_bytes:
        return text
    return encoded[:maximum_bytes].decode("utf-8", errors="ignore")

def build_problematic_summary(
    album: Mapping[str, object],
    *,
    reasons: Iterable[str],
    repair_preview: Mapping[str, object],
) -> dict[str, object] | None:
    """Build the bounded summary shared by request-time and durable readers."""
    ordered_reasons = list(dict.fromkeys(str(reason) for reason in reasons if str(reason)))
    if (
        not ordered_reasons
        and not repair_preview.get("has_repairs")
    ):
        return None
    tracks = [
        {"path": str(track.get("path") or ""), "title": str(track.get("title") or "")}
        for track in album.get("tracks") or []
        if isinstance(track, Mapping) and str(track.get("path") or "")
    ]
    projection_source = {
        "album_id": album.get("_persisted_album_id"),
        "album_key": album.get("_persisted_album_key") or album.get("key"),
        "album_title": album.get("name"),
        "artist_name": album.get("album_artist"),
        "album_metadata": {
            "album_artist": album.get("album_artist"),
            "edition": album.get("edition"),
        },
        "file_entry": {"year": album.get("year")},
        "inventory_status": album.get("inventory_status"),
        "separate_release_keys": album.get("_separate_release_keys") or (),
    }
    payload: dict[str, object] = {
        "key": str(album.get("key") or ""),
        "album_ref": str(album.get("album_ref") or album.get("key") or ""),
        "projection_id": str(
            album.get("projection_id") or problematic_projection_id(projection_source)
        ),
        "name": str(album.get("name") or ""),
        "album_artist": str(album.get("album_artist") or ""),
        "artists": list(album.get("artists") or []),
        "is_compilation": bool(album.get("is_compilation")),
        "cover_path": album.get("cover_path") or None,
        "cover_revision": album.get("cover_revision") or None,
        "local_cover_width": album.get("local_cover_width"),
        "local_cover_height": album.get("local_cover_height"),
        "remote_cover_url": album.get("remote_cover_url"),
        "remote_cover_thumbnail_url": album.get("remote_cover_thumbnail_url"),
        "remote_cover_source": album.get("remote_cover_source"),
        "remote_cover_source_label": album.get("remote_cover_source_label"),
        "remote_cover_album_url": album.get("remote_cover_album_url"),
        "remote_cover_width": album.get("remote_cover_width"),
        "remote_cover_height": album.get("remote_cover_height"),
        "year": album.get("year"),
        "release_date": album.get("release_date"),
        "edition": album.get("edition"),
        "album_rating": _integer(album.get("album_rating")),
        "problem_reasons": ordered_reasons,
        "issue_count": len(ordered_reasons),
        "cover_width": _integer(album.get("local_cover_width")),
        "cover_height": _integer(album.get("local_cover_height")),
        "has_encoding_repairs": bool(repair_preview.get("has_repairs")),
        "raw_name": repair_preview.get("raw_name"),
        "raw_album_artist": repair_preview.get("raw_album_artist"),
        "track_count": len(tracks),
        "track_paths": [track["path"] for track in tracks],
        "file_types": sorted(
            {file_type for track in tracks if (file_type := _file_type(track["path"]))}
        ),
        "search_text": "\n".join(
            track["title"] for track in tracks if track["title"].strip()
        ),
        "detail_loaded": False,
    }
    if album.get("inventory_status") == "missing":
        payload["inventory_status"] = "missing"
        payload["missing_since"] = album.get("missing_since")
        payload["track_paths"] = []
        payload["tracks"] = []
    return {
        key: value
        for key, value in payload.items()
        if key not in _OPTIONAL_SUMMARY_FIELDS or value not in (None, "", [])
    }

def problematic_sort_key(
    item: Mapping[str, object], *, album_id: object = 0
) -> tuple[str, str, str, str, int]:
    return (
        str(item.get("name") or "").lower(),
        str(item.get("album_artist") or "").lower(),
        str(item.get("year") or ""),
        str(item.get("key") or "").lower(),
        _integer(album_id),
    )

def normalized_problematic_search_text(item: Mapping[str, object]) -> str:
    """Return the exact main UI haystack for the facts present on one item."""
    reasons = item.get("problem_reasons")
    tracks = item.get("tracks")
    repairs = item.get("repair_preview_rows")
    values = [
        item.get("name"), item.get("raw_name"), item.get("album_artist"),
        item.get("raw_album_artist"), item.get("year"),
        *(reasons if isinstance(reasons, (list, tuple)) else ()), item.get("search_text"),
    ]
    if isinstance(tracks, (list, tuple)):
        values.extend(track.get("title") for track in tracks)
    if isinstance(repairs, (list, tuple)):
        values.extend(value for row in repairs
                      for value in (row.get("track_title"), row.get("original"), row.get("repaired")))
    return "\n".join(str(value or "") for value in values).lower()


def _persisted_problematic_item(summary: Mapping[str, object]) -> dict[str, object]:
    persisted_summary = dict(summary)
    search_text = normalized_problematic_search_text(persisted_summary)
    encoded_search_text = search_text.encode("utf-8")
    search_document_truncated = len(encoded_search_text) > _MAX_SEARCH_DOCUMENT_BYTES
    if search_document_truncated:
        search_text = encoded_search_text[:_MAX_SEARCH_DOCUMENT_BYTES].decode(
            "utf-8", errors="ignore"
        )
    bookkeeping_fields = {
        field: persisted_summary.pop(field)
        for field in (
            "search_fact_count",
            "search_fact_digest",
            "search_facts_truncated",
            "track_path_fact_count",
            "track_path_fact_digest",
            "track_path_facts_truncated",
        )
        if field in persisted_summary
    }
    search_document_count = int(bookkeeping_fields.get("search_fact_count") or 0) + int(
        bookkeeping_fields.get("track_path_fact_count") or 0
    )
    search_document_digest = hashlib.sha256(encoded_search_text).hexdigest()
    persisted_summary.pop("search_text", None)
    persisted_summary.pop("track_paths", None)
    sort_title, sort_artist, sort_year, sort_album_key, _ = problematic_sort_key(
        persisted_summary
    )
    return {
        **persisted_summary,
        **bookkeeping_fields,
        "item_key": str(persisted_summary.get("projection_id") or ""),
        "sort_title": _utf8_prefix(sort_title, _MAX_PERSISTED_SORT_TEXT_BYTES),
        "sort_artist": _utf8_prefix(sort_artist, _MAX_PERSISTED_SORT_TEXT_BYTES),
        "sort_year": _utf8_prefix(sort_year, 64),
        "sort_album_key": _utf8_prefix(
            sort_album_key, _MAX_PERSISTED_SORT_TEXT_BYTES
        ),
        "search_text": search_text,
        "search_document_count": search_document_count,
        "search_document_digest": search_document_digest,
        "search_document_truncated": search_document_truncated,
        "reasons": list(persisted_summary.get("problem_reasons") or []),
        "summary": persisted_summary,
    }

def normalize_problematic_reason(reason: object) -> str:
    value = str(reason or "").strip()
    if value == "Inconsistent year" or value.startswith("Year mismatch"):
        return "Year mismatch"
    if value.startswith("Incomplete track order:"):
        return "Incomplete track order"
    return value

def problematic_filter_spec(
    filter_value: object, *, preserve_query: bool = False,
) -> tuple[str, tuple[str, ...]]:
    normalize_query = ((lambda value: str(value or "")) if preserve_query
                       else normalize_problematic_search_query)
    filter_text = str(filter_value or "")
    raw_value = filter_text.strip()
    if not raw_value:
        return normalize_query(filter_text), ()
    if len(raw_value) > 4096:
        raise ValueError("Problematic Files filter is too long.")
    if not raw_value.startswith("{"):
        return normalize_query(filter_text), ()
    try:
        payload = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid Problematic Files filter.") from exc
    if not isinstance(payload, Mapping) or set(payload) - {"query", "reasons"}:
        raise ValueError("Invalid Problematic Files filter.")
    query = normalize_query(payload.get("query"))
    raw_reasons = payload.get("reasons", [])
    if not isinstance(raw_reasons, list) or len(raw_reasons) > 64:
        raise ValueError("Invalid Problematic Files filter reasons.")
    reasons: list[str] = []
    for raw_reason in raw_reasons:
        if not isinstance(raw_reason, str) or len(raw_reason) > 256:
            raise ValueError("Invalid Problematic Files filter reasons.")
        reason = normalize_problematic_reason(raw_reason)
        if reason and reason not in reasons:
            reasons.append(reason)
    return query, tuple(reasons)

def problematic_filter_matches(item: Mapping[str, object], filter_value: str) -> bool:
    query, required_reasons = problematic_filter_spec(filter_value)
    item_reasons = {
        reason
        for raw_reason in item.get("problem_reasons") or []
        if (reason := normalize_problematic_reason(raw_reason))
    }
    if required_reasons and not item_reasons.intersection(required_reasons):
        return False
    if not query:
        return True
    return query in normalized_problematic_search_text(item)


def problematic_reason_facets(
    items: Iterable[Mapping[str, object]],
) -> list[dict[str, object]]:
    counts: dict[str, int] = {}
    for item in items:
        for reason in {
            normalize_problematic_reason(value)
            for value in item.get("problem_reasons") or []
        }:
            if reason:
                counts[reason] = counts.get(reason, 0) + 1
    return [
        {"reason": reason, "count": counts[reason]}
        for reason in sorted(counts, key=str.casefold)
    ]

def _first_inventory_value(*values: object) -> object:
    for value in values:
        if value is not None:
            return value
    return None

def _row_mapping(row: object) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if isinstance(row, (tuple, list)) and len(row) >= 3:
        return {"artist_name": row[0], "sort_name": row[1], "album_count": row[2]}
    return {}

def _coerce_int(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0

def _coerce_duration_seconds(value: object) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0

def _row_json_mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return {}
    return value if isinstance(value, Mapping) else {}

def _row_string_list(value: object) -> list[str]:
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, (list, tuple, set)):
        values = list(value)
    else:
        values = []
    return [str(item or "").strip() for item in values if str(item or "").strip()]

def _album_separate_release_key(album_artist: str, album_name: str, edition: object | None = None) -> str:
    parts = [album_artist.strip().lower(), album_name.strip().lower()]
    edition_text = str(edition or "").strip()
    if edition_text:
        parts.append(edition_text.lower())
    return "::".join(parts)

def _row_album_identity(
    row_payload: Mapping[str, object],
    artist_display: str,
    *,
    metadata: Mapping[str, object] | None = None,
    separate_release_keys: set[str] | None = None,
    base_key: str | None = None,
) -> tuple[object, str, object]:
    resolved_metadata = (
        metadata
        if metadata is not None
        else _problematic_album_metadata_from_row(row_payload)
    )
    return problematic_album_identity(
        row_payload,
        artist_display,
        metadata=resolved_metadata,
        separate_release_keys=separate_release_keys,
        base_key=base_key,
    )

def _effective_row_exception_type(row_payload: Mapping[str, object]) -> str:
    file_entry = _row_json_mapping(row_payload.get("file_entry"))
    if row_payload.get("exception_override_present") is True:
        effective_exception_value = row_payload.get("exception_type")
    elif row_payload.get("exception_override_present") is False:
        effective_exception_value = file_entry.get("exception_type")
    else:
        effective_exception_value = _first_inventory_value(
            row_payload.get("exception_type"),
            file_entry.get("exception_type"),
        )
    return normalize_exception_value(effective_exception_value)

def _duplicate_sources_for_projected_album(album: Mapping[str, object], result: Mapping[str, object]) -> list[dict[str, object]]:
    sources = result.get("duplicate_sources", [])
    if album.get("_persisted_album_key") and album.get("key") != album["_persisted_album_key"]:
        sources = [source for source in sources if all(_coerce_int(track.get("year")) == _coerce_int(album.get("year")) for track in source["tracks"])]
    return sources

def _duplicate_provenance_for_projected_album(album: Mapping[str, object], result: Mapping[str, object]) -> object:
    if album.get("_persisted_album_key") and album.get("key") != album["_persisted_album_key"]:
        return result.get("_root_provenance_by_year", {}).get(_coerce_int(album.get("year")), album.get("root_provenance"))
    return result.get("root_provenance", album.get("root_provenance"))

def _duplicate_sources_from_rows(
    rows: list[object],
    *,
    file_entries_by_path: Mapping[str, dict[str, object]] | None = None,
    defer_source_payloads: bool = False,
    path_factory=Path,
) -> dict[str, dict[str, object]]:
    """Use the domain's physical-container identity for every read projection."""
    from music_app.models.library import Album, Track
    from music_app.services.library import _link_duplicate_album_sources
    from music_app.services.album_local_membership import rejected_local_album_paths

    albums = {}
    seen_paths = set()
    rows_by_path = {}
    cover_paths = {}
    file_entries_by_path = file_entries_by_path or {}
    # SQL row order is unspecified; provenance preserves first encounter order.
    # Use physical-path identity for stable results across equivalent projections.
    payloads = sorted((_row_mapping(row) for row in rows), key=lambda payload: (
        str(payload.get("file_private_path") or "").casefold(),
        str(payload.get("file_private_path") or ""),
        str(payload.get("album_key") or ""),
    ))
    prepared_entries = []
    for payload in payloads:
        file_entry = _row_json_mapping(payload.get("file_entry"))
        entry = file_entries_by_path.get(str(payload.get("file_private_path") or "").strip())
        if entry is None:
            entry = _problematic_file_entry_from_row(payload)
        else:
            entry = dict(entry)
        if payload.get("file_entry_is_object") is not True and not file_entry:
            entry.update(album=None, album_artist=None, year=None)
        entry["duration_seconds"] = _coerce_duration_seconds(payload.get("duration_seconds"))
        entry["library_root_id"] = payload.get("file_library_root_id") or entry.get("library_root_id")
        prepared_entries.append((payload, entry))
    rejected_paths = rejected_local_album_paths([entry for _, entry in prepared_entries])
    for payload, entry in prepared_entries:
        file_entry = _row_json_mapping(payload.get("file_entry"))
        key = str(payload.get("album_key") or "")
        path = str(entry.get("path") or "")
        membership_problem = (
            entry["local_album_membership_problem"] if "local_album_membership_problem" in entry
            else payload["local_album_membership_problem"] if "local_album_membership_problem" in payload
            else file_entry.get("local_album_membership_problem")
        )
        if normalize_exception_value(entry.get("exception_type")) or path in rejected_paths or str(membership_problem or "").strip():
            continue
        if not key or not path or (key, path) in seen_paths:
            continue
        seen_paths.add((key, path))
        rows_by_path[path] = payload
        album = albums.get(key)
        if album is None:
            album = albums[key] = Album(key=key, name=str(entry.get("album") or ""), album_artist=str(entry.get("album_artist") or ""))
        cover_path = entry.get("cover_path")
        if cover_path:
            if type(cover_path) is str:
                if cover_path not in cover_paths:
                    cover_paths[cover_path] = path_factory(cover_path)
                cover_path = cover_paths[cover_path]
            else:
                cover_path = path_factory(cover_path)
        # The duplicate linker treats paths as string-like and parses one parent per
        # physical container; keep this transient track from reparsing every file.
        album.tracks.append(Track(
            path=path, title=str(entry.get("title") or ""),  # type: ignore[arg-type]
            album=entry.get("album"), album_artist=entry.get("album_artist"),
            artist=entry.get("artist"), year=entry.get("year"),
            disc_number=entry.get("disc_number"), track_number=entry.get("track_number"),
            duration_seconds=_coerce_duration_seconds(payload.get("duration_seconds")),
            edition=entry.get("edition"), release_date=entry.get("release_date"),
            cover_path=cover_path if cover_path else None,
            library_root_id=payload.get("file_library_root_id") or file_entry.get("library_root_id"),
            library_root_category=payload.get("file_library_root_category") or file_entry.get("library_root_category"),
        ))
    album_values = list(albums.values())
    duplicate_contexts = _link_duplicate_album_sources(
        album_values,
        defer_source_payloads=True,
    )

    def attach_track_references(sources: list[dict[str, object]]) -> list[dict[str, object]]:
        for source in sources:
            for track in source["tracks"]:
                row = rows_by_path[track["path"]]
                track["key"] = row.get("track_key")
                track["track_ref"] = row.get("track_key")
        return sources

    results = {}
    for (key, album), context in zip(albums.items(), duplicate_contexts):
        materialize_sources = context["materialize_sources"]

        def materialize_sources_with_track_references(
            materialize_sources=materialize_sources,
        ) -> list[dict[str, object]]:
            return attach_track_references(materialize_sources())

        sources = (
            []
            if defer_source_payloads
            else materialize_sources_with_track_references()
        )
        provenance_by_year = {}
        for track in album.tracks:
            provenance_by_year.setdefault(_coerce_int(track.year), []).append(
                build_root_provenance_payload(track.library_root_id, track.library_root_category)
            )
        for track in context["linked_tracks"]:
            provenance_by_year.setdefault(_coerce_int(track.year), []).append(
                build_root_provenance_payload(track.library_root_id, track.library_root_category)
            )
        results[key] = {
            "has_duplicate_files": bool(context["has_duplicate_files"]),
            "duplicate_sources": sources,
            "_root_provenance_by_year": {year: summarize_root_provenance_payloads(values) for year, values in provenance_by_year.items()},
            **({"root_provenance": album.root_provenance} if context["has_duplicate_files"] else {}),
            **({
                "_duplicate_source_materializer": materialize_sources_with_track_references,
                "_duplicate_source_years": [
                    {_coerce_int(track.year) for track in tracks}
                    for tracks in context["source_track_groups"]
                ],
            } if defer_source_payloads and context["has_duplicate_files"] else {}),
        }
    return results

def project_problematic_albums(
    rows: Iterable[object],
    *,
    effective_exception_type=_effective_row_exception_type,
) -> list[dict[str, object]]:
    # Duplicate linking and album assembly intentionally share the same immutable
    # source snapshot. The durable worker bounds this input to one staged group.
    rows = tuple(rows)
    albums: dict[object, dict[str, object]] = {}
    seen_track_paths_by_album: dict[object, set[str]] = {}
    metadata_by_persisted_album: dict[object, dict[str, object]] = {}
    base_key_by_persisted_album: dict[object, str] = {}
    string_set_cache: dict[tuple[str, ...], set[str]] = {}
    text_problem_reason_cache: dict[tuple[str, str, bool], str | None] = {}
    previous_ignored_value: object = object()
    previous_ignored_keys: set[str] = set()
    previous_separate_value: object = object()
    previous_separate_keys: set[str] = set()
    for row in rows:
        row_payload = _row_mapping(row)
        persisted_album_id = row_payload.get("album_id")
        persisted_album_key = str(row_payload.get("album_key") or "").strip()
        if persisted_album_id is None and not persisted_album_key:
            continue
        persisted_identity = (
            persisted_album_id
            if persisted_album_id is not None
            else persisted_album_key
        )
        metadata = metadata_by_persisted_album.get(persisted_identity)
        if metadata is None:
            metadata = _problematic_album_metadata_from_row(row_payload)
            metadata_by_persisted_album[persisted_identity] = metadata
        ignored_value = row_payload.get("ignored_repair_keys")
        if isinstance(ignored_value, _SpooledIgnoredRepairMembership):
            ignored_repair_keys = ignored_value
        elif ignored_value == previous_ignored_value:
            ignored_repair_keys = previous_ignored_keys
        else:
            ignored_repair_key_values = tuple(_row_string_list(ignored_value))
            ignored_repair_keys = string_set_cache.setdefault(
                ignored_repair_key_values,
                set(ignored_repair_key_values),
            )
            previous_ignored_value = ignored_value
            previous_ignored_keys = ignored_repair_keys
        separate_value = row_payload.get("separate_release_keys")
        if separate_value == previous_separate_value:
            separate_release_keys = previous_separate_keys
        else:
            separate_release_key_values = tuple(_row_string_list(separate_value))
            separate_release_keys = string_set_cache.setdefault(
                separate_release_key_values,
                set(separate_release_key_values),
            )
            previous_separate_value = separate_value
            previous_separate_keys = separate_release_keys
        artist_display = str(row_payload.get("artist_name") or "").strip()
        base_key = base_key_by_persisted_album.get(persisted_identity)
        if base_key is None:
            base_key = _album_separate_release_key(
                str(metadata.get("album_artist") or artist_display),
                str(row_payload.get("album_title") or ""),
                metadata.get("edition", row_payload.get("album_edition")),
            )
            base_key_by_persisted_album[persisted_identity] = base_key
        album_identity, album_key, album_year = _row_album_identity(
            row_payload,
            artist_display,
            metadata=metadata,
            separate_release_keys=separate_release_keys,
            base_key=base_key,
        )
        if not album_identity:
            continue
        album = albums.get(album_identity)
        if album is None:
            artists = metadata.get("artists")
            if not isinstance(artists, list):
                artists = [artist_display] if artist_display else []
            album = {
                "_text_problem_reason_cache": text_problem_reason_cache,
                "key": album_key,
                "projection_id": problematic_projection_id(row_payload),
                "album_ref": album_key,
                "_persisted_album_id": persisted_album_id,
                "_persisted_album_key": persisted_album_key,
                "name": str(row_payload.get("album_title") or "").strip(),
                "album_artist": str(metadata.get("album_artist") or artist_display).strip(),
                "artists": [str(artist or "").strip() for artist in artists if str(artist or "").strip()],
                "is_compilation": bool(metadata.get("is_compilation")),
                "cover_path": row_payload.get("album_cover_path"),
                "inventory_status": row_payload.get("inventory_status"),
                "missing_since": row_payload.get("missing_since"),
                "spotify_cover_quota_exceeded": bool(row_payload.get("spotify_cover_quota_exceeded")),
                "cover_revision": metadata.get("cover_revision"),
                "cover_selection_origin": (
                    str(metadata.get("cover_selection_origin") or "").strip().casefold()
                    if str(metadata.get("cover_selection_origin") or "").strip().casefold()
                    in {"user", "automatic"}
                    else None
                ),
                "local_cover_width": _nullable_int(metadata.get("local_cover_width")),
                "local_cover_height": _nullable_int(metadata.get("local_cover_height")),
                "remote_cover_url": metadata.get("remote_cover_url"),
                "remote_cover_thumbnail_url": metadata.get("remote_cover_thumbnail_url"),
                "remote_cover_source": metadata.get("remote_cover_source"),
                "remote_cover_source_label": metadata.get("remote_cover_source_label"),
                "remote_cover_album_url": metadata.get("remote_cover_album_url"),
                "remote_cover_width": _nullable_int(metadata.get("remote_cover_width")),
                "remote_cover_height": _nullable_int(metadata.get("remote_cover_height")),
                "year": album_year,
                "release_date": metadata.get("release_date"),
                "edition": metadata.get("edition"),
                "album_rating": _coerce_int(metadata.get("album_rating")),
                "root_provenance": dict(_row_json_mapping(metadata.get("root_provenance"))),
                "tracks": [],
                "_file_entries": [],
                "_ignored_repair_keys": (
                    ignored_repair_keys
                    if isinstance(
                        ignored_repair_keys, _SpooledIgnoredRepairMembership
                    )
                    else set(ignored_repair_keys)
                ),
                "_separate_release_keys": set(separate_release_keys),
                "_duplicate_file_counts": {},
                "_duplicate_candidate": bool(row_payload.get("duplicate_candidate")),
            }
            albums[album_identity] = album
            seen_track_paths_by_album[album_identity] = set()
        else:
            if album["_ignored_repair_keys"] is not ignored_repair_keys:
                album["_ignored_repair_keys"].update(ignored_repair_keys)
            album["_separate_release_keys"].update(separate_release_keys)
            album["_duplicate_candidate"] = bool(
                album.get("_duplicate_candidate")
                or row_payload.get("duplicate_candidate")
            )
        track_path = str(row_payload.get("file_private_path") or "").strip()
        if not track_path or track_path in seen_track_paths_by_album[album_identity]:
            continue
        seen_track_paths_by_album[album_identity].add(track_path)
        file_entry = _problematic_file_entry_from_row(
            row_payload,
            effective_exception_type=effective_exception_type,
        )
        album["_file_entries"].append(file_entry)
        duplicate_count = _coerce_int_or_default(row_payload.get("duplicate_file_count"), 1)
        album["_duplicate_file_counts"][track_path] = duplicate_count
        album["tracks"].append(
            {
                "key": str(row_payload.get("track_key") or "").strip(),
                "track_ref": str(row_payload.get("track_key") or "").strip(),
                "path": track_path,
                "title": str(row_payload.get("track_title") or "").strip(),
                "disc_number": row_payload.get("disc_number"),
                "track_number": row_payload.get("track_number"),
                "duration_seconds": _coerce_duration_seconds(row_payload.get("duration_seconds")),
                "exception_type": file_entry["exception_type"],
            }
        )
    projected_albums = list(albums.values())
    duplicates = _duplicate_sources_from_rows(
        rows,
        file_entries_by_path={
            str(entry["path"]): entry
            for album in albums.values()
            for entry in album["_file_entries"]
        },
        defer_source_payloads=True,
    )
    for album in projected_albums:
        duplicate_result = duplicates.get(str(album.get("_persisted_album_key") or album.get("key")), {})
        sources = _duplicate_sources_for_projected_album(album, duplicate_result)
        album.update(duplicate_result)
        track_keys = [track["key"] for track in album["tracks"] if track["key"]]
        album.update(
            duplicate_sources=sources,
            has_duplicate_files=(
                bool(
                    duplicate_result.get("has_duplicate_files")
                    or album.get("_duplicate_candidate")
                )
                if not album.get("_persisted_album_key")
                or album.get("key") == album.get("_persisted_album_key")
                else {_coerce_int(album.get("year"))}
                in duplicate_result.get("_duplicate_source_years", [])
            ) or len(track_keys) != len(set(track_keys)),
        )
        album["root_provenance"] = _duplicate_provenance_for_projected_album(album, duplicate_result)
        album["tracks"].sort(
            key=lambda track: (
                track.get("disc_number") is None,
                _coerce_int_or_default(track.get("disc_number"), 0),
                track.get("track_number") is None,
                _coerce_int_or_default(track.get("track_number"), 0),
                str(track.get("title") or "").casefold(),
                str(track.get("path") or "").casefold(),
            )
        )
        album["_file_entries"].sort(key=lambda entry: str(entry.get("path") or "").casefold())
    return projected_albums

def _nullable_int(value: object) -> int | None:
    if value in (None, ""):
        return None
    return _coerce_int(value)

def _problematic_album_metadata_from_row(
    row_payload: Mapping[str, object],
) -> dict[str, object]:
    metadata = dict(_row_json_mapping(row_payload.get("album_metadata")))
    if metadata:
        return metadata
    artists = row_payload.get("album_artists")
    if isinstance(artists, str):
        try:
            artists = json.loads(artists)
        except (TypeError, ValueError):
            artists = []
    if not isinstance(artists, list):
        artists = []
    return {
        "album_artist": row_payload.get("album_artist"),
        "artists": artists,
        "is_compilation": row_payload.get("album_is_compilation"),
        "cover_revision": row_payload.get("album_cover_revision"),
        "cover_selection_origin": row_payload.get("album_cover_selection_origin"),
        "local_cover_width": row_payload.get("album_local_cover_width"),
        "local_cover_height": row_payload.get("album_local_cover_height"),
        "remote_cover_url": row_payload.get("album_remote_cover_url"),
        "remote_cover_thumbnail_url": row_payload.get("album_remote_cover_thumbnail_url"),
        "remote_cover_source": row_payload.get("album_remote_cover_source"),
        "remote_cover_source_label": row_payload.get("album_remote_cover_source_label"),
        "remote_cover_album_url": row_payload.get("album_remote_cover_album_url"),
        "remote_cover_width": row_payload.get("album_remote_cover_width"),
        "remote_cover_height": row_payload.get("album_remote_cover_height"),
        "release_date": row_payload.get("album_release_date"),
        "edition": row_payload.get("album_edition"),
        "album_rating": row_payload.get("album_rating"),
        "root_provenance": row_payload.get("album_root_provenance"),
    }

def _problematic_file_entry_from_row(
    row_payload: Mapping[str, object],
    *,
    effective_exception_type=_effective_row_exception_type,
) -> dict[str, object]:
    raw_file_entry = row_payload.get("file_entry")
    file_entry = _row_json_mapping(raw_file_entry)
    track_path = str(row_payload.get("file_private_path") or file_entry.get("path") or "").strip()
    compact_scan_entry_present = row_payload.get("file_entry_is_object") is True
    hydrated_scan_entry_present = isinstance(raw_file_entry, Mapping)
    if isinstance(raw_file_entry, str):
        try:
            hydrated_scan_entry_present = isinstance(json.loads(raw_file_entry), Mapping)
        except (TypeError, ValueError):
            hydrated_scan_entry_present = False
    scan_entry_present = compact_scan_entry_present or hydrated_scan_entry_present

    def required_text_value(
        entry_field: str,
        compact_field: str,
        canonical_value: object,
    ) -> str:
        if scan_entry_present:
            raw_value = (
                row_payload.get(compact_field)
                if compact_scan_entry_present
                else file_entry.get(entry_field)
            )
        else:
            raw_value = canonical_value
        return str(raw_value or "").strip()

    if compact_scan_entry_present:
        raw_track_number = row_payload.get("file_track_number")
        raw_year = row_payload.get("file_year")
    elif hydrated_scan_entry_present:
        raw_track_number = file_entry.get("track_number")
        raw_year = file_entry.get("year")
    else:
        raw_track_number = row_payload.get("track_number")
        raw_year = row_payload.get("album_release_year")
    return {
        "path": track_path,
        "mtime": file_entry.get("mtime"),
        "size": file_entry.get("size"),
        "_physical_file_size": row_payload.get("file_size"),
        "_mixed_album_folder": row_payload.get("file_mixed_album_folder") is True,
        "album": required_text_value("album", "file_album", row_payload.get("album_title")),
        "album_artist": required_text_value(
            "album_artist",
            "file_album_artist",
            row_payload.get("artist_name"),
        ),
        "artist": required_text_value("artist", "file_artist", row_payload.get("artist_name")),
        "title": required_text_value("title", "file_title", row_payload.get("track_title")),
        "genre": str(
            (
                row_payload.get("file_genre")
                if compact_scan_entry_present
                else file_entry.get("genre")
            )
            or ""
        ).strip(),
        "track_number": raw_track_number,
        "disc_number": (
            row_payload.get("file_disc_number")
            if compact_scan_entry_present
            else file_entry.get("disc_number", row_payload.get("disc_number"))
        ),
        "disc_number_raw": (
            row_payload.get("file_disc_number_raw")
            if compact_scan_entry_present
            else file_entry.get("disc_number_raw")
        ),
        "total_discs": (
            row_payload.get("file_total_discs")
            if compact_scan_entry_present
            else file_entry.get("total_discs")
        ),
        "disc_subtitle": (
            row_payload.get("file_disc_subtitle")
            if compact_scan_entry_present
            else file_entry.get("disc_subtitle")
        ),
        "duration_seconds": (
            row_payload.get("file_duration_seconds")
            if compact_scan_entry_present
            else file_entry.get("duration_seconds", row_payload.get("duration_seconds"))
        ),
        "cover_path": (
            row_payload.get("file_cover_path")
            if compact_scan_entry_present
            else file_entry.get("cover_path", row_payload.get("album_cover_path"))
        ),
        "cover_revision": (
            row_payload.get("file_cover_revision")
            if compact_scan_entry_present
            else file_entry.get("cover_revision", row_payload.get("album_cover_revision"))
        ),
        "year": raw_year,
        "edition": (
            row_payload.get("file_edition")
            if compact_scan_entry_present
            else file_entry.get("edition")
        ),
        "album_rating": (
            row_payload.get("file_album_rating")
            if compact_scan_entry_present
            else file_entry.get("album_rating")
        ),
        "exception_type": effective_exception_type(row_payload),
        "_text_mojibake_candidate": row_payload.get("file_text_mojibake_candidate"),
        "local_album_membership_problem": (
            row_payload["local_album_membership_problem"]
            if "local_album_membership_problem" in row_payload
            else file_entry.get("local_album_membership_problem")
        ),
    }

def _normalized_problem_year(value: object) -> int | None:
    try:
        normalized_year = int(value)
    except (TypeError, ValueError):
        return None
    return normalized_year if normalized_year > 0 else None

def _album_file_year_mismatch(album: Mapping[str, object]) -> bool:
    album_year = _normalized_problem_year(album.get("year"))
    if album_year is None:
        return False
    ignored_repair_keys = album.get("_ignored_repair_keys") or set()
    for entry in album.get("_file_entries") or []:
        if not isinstance(entry, Mapping):
            continue
        path = str(entry.get("path") or "")
        if f"{path}::year" in ignored_repair_keys:
            continue
        file_year = _normalized_problem_year(entry.get("year"))
        if file_year is not None and file_year != album_year:
            return True
    return False

def _encoded_problem_reason_identity(reason: str) -> str:
    encoded_reason = base64.urlsafe_b64encode(reason.encode("utf-8")).decode("ascii")
    return f"{_ENCODED_PROBLEM_REASON_PREFIX}{encoded_reason.rstrip('=')}"


def _decoded_problem_reason_identity(reason_code: str) -> str:
    predefined_reason = _PROBLEM_REASON_BY_IDENTITY_CODE.get(reason_code)
    if predefined_reason is not None:
        return predefined_reason
    if not reason_code.startswith(_ENCODED_PROBLEM_REASON_PREFIX):
        return ""
    encoded_reason = reason_code.removeprefix(_ENCODED_PROBLEM_REASON_PREFIX)
    padding = "=" * (-len(encoded_reason) % 4)
    try:
        decoded_reason = base64.b64decode(
            f"{encoded_reason}{padding}",
            altchars=b"-_",
            validate=True,
        )
        return decoded_reason.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return ""

def _problem_reason_identity_code(reason: object) -> str:
    normalized_reason = str(reason or "").strip()
    code = _PROBLEM_REASON_IDENTITY_CODES.get(normalized_reason)
    if code is not None:
        return code
    return _encoded_problem_reason_identity(normalized_reason)

def _problem_identity_row_key(
    path: object,
    reason: object,
    *,
    scope: str,
) -> str:
    return "::".join(
        (
            str(path or ""),
            f"problem-{scope}",
            _problem_reason_identity_code(reason),
        )
    )

def _problem_reason_is_ignored(
    ignored_repair_keys: object,
    path: object,
    reason: object,
    *,
    scope: str,
    legacy_field: str | None = None,
) -> bool:
    if not ignored_repair_keys:
        return False
    if _problem_identity_row_key(path, reason, scope=scope) in ignored_repair_keys:
        return True
    return bool(
        legacy_field
        and f"{str(path or '')}::{legacy_field}" in ignored_repair_keys
    )

def _problematic_album_scope_reasons(album: Mapping[str, object]) -> list[str]:
    """Return only problems owned by the album-level exclusion surface."""
    if album.get("inventory_status") == "missing":
        return ["Album not found"]
    reasons: list[str] = []
    ignored_repair_keys = album.get("_ignored_repair_keys") or set()
    album_problem_identity = str(
        album.get("album_ref") or album.get("key") or ""
    )

    def add(reason: str | None) -> None:
        if (
            reason
            and reason not in reasons
            and not _problem_reason_is_ignored(
                ignored_repair_keys,
                album_problem_identity,
                reason,
                scope="album",
            )
        ):
            reasons.append(reason)

    add(_cached_problematic_text_reason(album, "Artist", str(album.get("album_artist") or "")))
    add(_cached_problematic_text_reason(album, "Album", str(album.get("name") or "")))
    add(year_problem_reason(album.get("year")))

    if album.get("spotify_cover_quota_exceeded"):
        add("Spotify cover search quota exceeded")

    if not album.get("cover_path"):
        add("Missing cover art")
    else:
        width = _coerce_int(album.get("local_cover_width"))
        height = _coerce_int(album.get("local_cover_height"))
        if width > 0 and height > 0 and (width < 600 or height < 600):
            add("Poor art quality")

    if album.get("has_duplicate_files"):
        add("Duplicate files")

    file_entries = [
        entry
        for entry in album.get("_file_entries") or []
        if isinstance(entry, dict)
    ]
    album_values = {
        str(entry.get("album") or "").strip().casefold()
        for entry in file_entries
        if str(entry.get("album") or "").strip()
    }
    artist_values = {
        str(entry.get("album_artist") or "").strip().casefold()
        for entry in file_entries
        if str(entry.get("album_artist") or "").strip()
    }
    valid_years = {
        int(entry.get("year"))
        for entry in file_entries
        if str(entry.get("year") or "").strip().isdigit()
    }
    raw_years = {
        str(entry.get("year") or "").strip()
        for entry in file_entries
        if str(entry.get("year") or "").strip()
    }
    if len(album_values) > 1:
        add("Album name mismatch")
    if len(artist_values) > 1 and not bool(album.get("is_compilation")):
        add("Album artist mismatch")
    if len(valid_years) > 1:
        add("Year mismatch")
    elif len(raw_years) > 1 and not valid_years:
        add("Inconsistent year")
    if _album_file_year_mismatch(album):
        add("Year mismatch")
    return reasons

def _text_problem_reason_fast(
    label: str,
    value: str,
    *,
    detect_encoding: bool = True,
) -> str | None:
    normalized_value = str(value or "")
    return text_problem_reason(
        label,
        normalized_value,
        detect_encoding=detect_encoding and not normalized_value.isascii(),
    )

def cached_problematic_text_reason(
    album: Mapping[str, object],
    label: str,
    value: str,
    *,
    detect_encoding: bool = True,
) -> str | None:
    cache = album.setdefault("_text_problem_reason_cache", {}) if isinstance(album, dict) else {}
    cache_key = (label, value, detect_encoding)
    if cache_key not in cache:
        cache[cache_key] = _text_problem_reason_fast(
            label,
            value,
            detect_encoding=detect_encoding,
        )
    return cache[cache_key]


_cached_problematic_text_reason = cached_problematic_text_reason

def _track_number_problem(value: object) -> str | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return "Missing track number"
    number = _strict_integer(value)
    if number is None or not 1 <= number <= _MAX_TRACK_ORDER_NUMBER:
        return "Invalid track number"
    return None


def _strict_integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"([+-]?)(\d+)", value.strip())
    if match is None:
        return None
    significant_digits = match.group(2).lstrip("0") or "0"
    if len(significant_digits) > 18:
        return None
    sign = -1 if match.group(1) == "-" else 1
    return sign * int(significant_digits)


def _positive_track_number(value: object) -> int | None:
    number = _strict_integer(value)
    return number if number is not None and number > 0 else None


def _valid_track_order_number(value: object) -> int | None:
    number = _positive_track_number(value)
    if number is None or number > _MAX_TRACK_ORDER_NUMBER:
        return None
    return number

def _leading_filename_track_number(path: object) -> int | None:
    filename = Path(str(path or "")).name
    match = re.match(r"^(\d+)(?:\.|\s*-\s*)", filename)
    if match is None:
        return None
    return _valid_track_order_number(match.group(1))

def _effective_track_order_number(
    track: Mapping[str, object],
    file_entry: Mapping[str, object],
) -> int | None:
    track_number = track.get("track_number")
    if track_number is not None and str(track_number).strip():
        return _valid_track_order_number(track_number)
    file_track_number = file_entry.get("track_number")
    if file_track_number is not None and str(file_track_number).strip():
        return _valid_track_order_number(file_track_number)
    return _leading_filename_track_number(
        track.get("path") or file_entry.get("path")
    )


def _track_order_missing_ranges(
    track_numbers: Iterable[int],
) -> tuple[tuple[int, int], ...]:
    missing_ranges: list[tuple[int, int]] = []
    expected = 1
    for number in sorted(set(track_numbers)):
        if number > expected:
            missing_ranges.append((expected, number - 1))
        expected = number + 1
    return tuple(missing_ranges)


def _track_order_missing_count(
    missing_ranges: Iterable[tuple[int, int]],
) -> int:
    return sum(last - first + 1 for first, last in missing_ranges)


def _expanded_missing_track_numbers(
    missing_ranges: Iterable[tuple[int, int]],
) -> list[int] | None:
    ranges = tuple(missing_ranges)
    if (
        _track_order_missing_count(ranges)
        > _MAX_EXPANDED_MISSING_TRACK_POSITIONS
    ):
        return None
    return [
        number
        for first, last in ranges
        for number in range(first, last + 1)
    ]


def _missing_track_ranges_need_compaction(
    missing_ranges: Iterable[tuple[int, int]],
) -> bool:
    return any(last - first + 1 >= 3 for first, last in missing_ranges)


def _track_order_issue_reason(issue: Mapping[str, object]) -> str:
    missing_numbers = issue.get("missing_track_numbers")
    if isinstance(missing_numbers, list):
        return (
            "Incomplete track order: "
            f"Disc {issue.get('disc_number')} missing "
            + ", ".join(str(number) for number in missing_numbers)
        )
    missing_ranges = tuple(issue.get("missing_track_ranges") or ())
    missing_parts = []
    for first, last in missing_ranges:
        count = last - first + 1
        if count >= 3:
            missing_parts.append(f"{count} tracks: {first}-{last}")
        else:
            missing_parts.extend(str(number) for number in range(first, last + 1))
    missing_text = ", ".join(missing_parts)
    return (
        "Incomplete track order: "
        f"Disc {issue.get('disc_number')} missing {missing_text}"
    )

def _track_order_issues(album: Mapping[str, object]) -> list[dict[str, object]]:
    cached_issues = album.get("_track_order_issues")
    if isinstance(cached_issues, list):
        return cached_issues
    file_entries_by_path = {
        str(entry.get("path") or ""): entry
        for entry in album.get("_file_entries") or []
        if isinstance(entry, Mapping)
    }
    track_numbers_by_disc: dict[int, set[int]] = {}
    for track in album.get("tracks") or []:
        if not isinstance(track, Mapping):
            continue
        if normalize_exception_value(track.get("exception_type")):
            continue
        path = str(track.get("path") or "")
        file_entry = file_entries_by_path.get(path, {})
        effective_track_number = _effective_track_order_number(track, file_entry)
        if effective_track_number is None:
            continue
        disc_number = (
            _positive_track_number(track.get("disc_number"))
            or _positive_track_number(file_entry.get("disc_number"))
            or 1
        )
        track_numbers_by_disc.setdefault(disc_number, set()).add(
            effective_track_number
        )
    issues: list[dict[str, object]] = []
    for disc_number, track_numbers in sorted(track_numbers_by_disc.items()):
        if not track_numbers:
            continue
        missing_ranges = _track_order_missing_ranges(track_numbers)
        if missing_ranges:
            missing_numbers = (
                None
                if _missing_track_ranges_need_compaction(missing_ranges)
                else _expanded_missing_track_numbers(missing_ranges)
            )
            if missing_numbers is not None:
                issues.append(
                    {
                        "disc_number": disc_number,
                        "missing_track_numbers": missing_numbers,
                    }
                )
            else:
                issues.append(
                    {
                        "disc_number": disc_number,
                        "missing_track_ranges": missing_ranges,
                        "missing_track_count": _track_order_missing_count(
                            missing_ranges
                        ),
                    }
                )
    if isinstance(album, dict):
        album["_track_order_issues"] = issues
    return issues

def _coerce_int_or_default(value: object, default: int) -> int:
    try:
        return int(value or default)
    except (TypeError, ValueError, OverflowError):
        try:
            return int(float(value or default))
        except (TypeError, ValueError, OverflowError):
            return int(default)

def _problematic_encoding_repair_preview(
    album: Mapping[str, object],
    *,
    include_preview_rows: bool,
) -> dict[str, object]:
    cached_preview = album.get("_encoding_repair_preview_full")
    if isinstance(cached_preview, dict):
        if include_preview_rows:
            return cached_preview
        return {**cached_preview, "preview_rows": []}
    ignored_repair_keys = album.get("_ignored_repair_keys") or set()
    file_entries = [entry for entry in album.get("_file_entries") or [] if isinstance(entry, dict)]
    preview_rows: list[dict[str, object]] = []
    has_repairs = False
    raw_name = ""
    raw_album_artist = ""
    for entry in file_entries:
        path = str(entry.get("path") or "")
        if not raw_name:
            raw_name = str(entry.get("album") or "").strip()
        if not raw_album_artist:
            raw_album_artist = str(entry.get("album_artist") or "").strip()
        repair_values = (
            str(entry.get("album") or ""),
            str(entry.get("album_artist") or ""),
            str(entry.get("artist") or ""),
            str(entry.get("title") or ""),
        )
        repairs = (
            {}
            if entry.get("_text_mojibake_candidate") is False
            or all(value.isascii() for value in repair_values)
            else build_text_repairs_for_entry(entry)
        )
        for field_name, repaired in repairs.items():
            original = str(entry.get(field_name) or "").strip()
            if not original or f"{path}::{field_name}" in ignored_repair_keys:
                continue
            has_repairs = True
            preview_rows.append(
                {
                    "row_key": f"{path}::{field_name}",
                    "path": path,
                    "track_title": str(entry.get("title") or "").strip() or Path(path).stem,
                    "field": field_name,
                    "original": original,
                    "repaired": repaired,
                }
            )
    preview_rows.sort(
        key=lambda item: (
            str(item.get("track_title") or "").casefold(),
            str(item.get("field") or ""),
            str(item.get("original") or "").casefold(),
        )
    )
    result = {
        "has_repairs": bool(preview_rows) or has_repairs,
        "raw_name": raw_name or str(album.get("name") or ""),
        "raw_album_artist": raw_album_artist or str(album.get("album_artist") or ""),
        "preview_rows": preview_rows,
    }
    if isinstance(album, dict):
        album["_encoding_repair_preview_full"] = result
    return result if include_preview_rows else {**result, "preview_rows": []}

def _physical_file_problem_reasons(entry: Mapping[str, object]) -> Iterable[str]:
    # Cached scan entries can synthesize size=0 when the canonical size is unknown.
    size = entry.get("_physical_file_size")
    if type(size) is int and size == 0:
        yield "Empty audio file"
    if entry.get("_mixed_album_folder") is True:
        yield "Mixed album metadata in one folder"
    if entry.get("local_album_membership_problem"):
        yield str(entry["local_album_membership_problem"])
    if reviewable_edition_title(entry.get("album"), entry.get("edition")):
        yield "Edition descriptor in album name"

def _iter_problematic_track_reasons(
    album: Mapping[str, object],
    *,
    track_order_issues: list[dict[str, object]],
    include_repair_metadata: bool,
    path_factory=Path,
) -> Iterable[tuple[str, str, list[str], dict[str, str] | None]]:
    ignored_repair_keys = album.get("_ignored_repair_keys") or set()
    album_problem_identity = str(album.get("album_ref") or album.get("key") or "")
    album_year = _normalized_problem_year(album.get("year"))
    include_complete_repair_scope = bool(track_order_issues)
    track_order_issue_by_disc = {
        int(issue["disc_number"]): issue
        for issue in track_order_issues
    }
    tracks_by_path = {
        str(track.get("path") or ""): track
        for track in album.get("tracks") or []
        if isinstance(track, Mapping) and str(track.get("path") or "")
    } if include_complete_repair_scope else {}
    entries_by_path = {
        str(entry.get("path") or ""): entry
        for entry in album.get("_file_entries") or []
        if isinstance(entry, dict) and str(entry.get("path") or "")
    }
    ordered_entries = [
        entries_by_path.pop(str(track.get("path") or ""))
        for track in album.get("tracks") or []
        if isinstance(track, Mapping)
        and str(track.get("path") or "") in entries_by_path
    ]
    ordered_entries.extend(
        sorted(
            entries_by_path.values(),
            key=lambda entry: str(entry.get("path") or "").casefold(),
        )
    )
    from music_app.services.album_local_membership import rejected_local_album_paths

    # The full physical scan preserves mixed-folder membership. Within this
    # album's diagnostic scope, also retain independently proven song copies.
    mixed_paths = {
        str(entry.get("path") or "") for entry in ordered_entries
        if entry.get("_mixed_album_folder") is True
        or entry.get("local_album_membership_problem") == "Mixed album metadata in one folder"
    }
    duplicate_problem_by_path = (
        rejected_local_album_paths(ordered_entries) if mixed_paths else {}
    )
    for entry in ordered_entries:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or "")
        if not path:
            continue
        reasons: list[str] = []
        reason_fields: dict[str, str] | None = {} if include_repair_metadata else None

        def add(reason: str | None, field: str) -> None:
            if (
                reason
                and reason not in reasons
                and not _problem_reason_is_ignored(
                    ignored_repair_keys,
                    album_problem_identity,
                    reason,
                    scope="album",
                )
                and not _problem_reason_is_ignored(
                    ignored_repair_keys,
                    path,
                    reason,
                    scope="file",
                    legacy_field=field,
                )
            ):
                reasons.append(reason)
                if reason_fields is not None:
                    reason_fields[reason] = field

        for reason in _physical_file_problem_reasons(entry):
            add(reason, "problem-file")
        if path in mixed_paths and duplicate_problem_by_path.get(path) == "Duplicate track outside album folder":
            add("Duplicate track outside album folder", "problem-file")
        for field_name, label in (
            ("album", "Album"),
            ("title", "Track title"),
            ("artist", "Track artist"),
            ("album_artist", "Album artist"),
        ):
            if f"{path}::{field_name}" in ignored_repair_keys:
                continue
            add(
                _cached_problematic_text_reason(album, label, str(entry.get(field_name) or "")),
                field_name,
            )
        if f"{path}::year" not in ignored_repair_keys:
            add(year_problem_reason(entry.get("year")), "year")
            file_year = _normalized_problem_year(entry.get("year"))
            if (
                album_year is not None
                and file_year is not None
                and file_year != album_year
            ):
                add("Year mismatch", "year")
        if f"{path}::track_number" not in ignored_repair_keys:
            add(_track_number_problem(entry.get("track_number")), "track_number")
        if include_complete_repair_scope:
            track = tracks_by_path.get(path, {})
            effective_disc_number = (
                _positive_track_number(track.get("disc_number"))
                or _positive_track_number(entry.get("disc_number"))
                or 1
            )
            issue = track_order_issue_by_disc.get(effective_disc_number)
            if issue is not None:
                add(_track_order_issue_reason(issue), "track_number")
        if not reasons and not include_complete_repair_scope:
            continue
        filename = basename(path)
        if filename in ("", "."):
            filename = path_factory(path).name
        yield path, filename, reasons, reason_fields

def _problematic_surviving_reasons(
    album: Mapping[str, object],
    *,
    album_scope_reasons: list[str] | None = None,
    track_problem_rows: list[dict[str, object]] | None = None,
) -> list[str]:
    """Return ordered distinct reasons that still have a visible scoped owner."""
    reasons: list[str] = []

    def add(reason: object) -> None:
        value = str(reason or "")
        if value and value not in reasons:
            reasons.append(value)

    for reason in (
        album_scope_reasons
        if album_scope_reasons is not None
        else _problematic_album_scope_reasons(album)
    ):
        add(reason)
    if track_problem_rows is not None:
        for row in track_problem_rows:
            for reason in row.get("reasons") or []:
                add(reason)
        return reasons

    track_order_issues = _track_order_issues(album)
    first_positions: dict[str, tuple[str, int, int]] = {}
    for row_index, (_, filename, row_reasons, _) in enumerate(_iter_problematic_track_reasons(
        album, track_order_issues=track_order_issues, include_repair_metadata=False,
    )):
        filename_key = "" if track_order_issues else filename.casefold()
        for reason_index, reason in enumerate(row_reasons):
            if reason in reasons:
                continue
            position = (filename_key, row_index, reason_index)
            previous = first_positions.get(reason)
            if previous is None or position < previous:
                first_positions[reason] = position
    # Match the stable detail-row order while sorting only distinct reasons.
    reasons.extend(sorted(first_positions, key=first_positions.__getitem__))
    return reasons

def _problematic_page_sort_key(
    item: Mapping[str, object],
    *,
    album_id: object = 0,
) -> tuple[str, str, str, str, int]:
    return problematic_sort_key(item, album_id=album_id)

def _problematic_page_filter_spec(filter_value: object) -> tuple[str, tuple[str, ...]]:
    return problematic_filter_spec(filter_value)

def _problematic_page_filter_matches(
    item: Mapping[str, object],
    filter_value: str,
) -> bool:
    return problematic_filter_matches(item, filter_value)

def _problematic_reason_facets(
    items: Iterable[Mapping[str, object]],
) -> list[dict[str, object]]:
    return problematic_reason_facets(items)

def problematic_album_summary_payload(
    album: Mapping[str, object],
    *,
    album_scope_reasons: list[str] | None = None,
    track_problem_rows: list[dict[str, object]] | None = None,
) -> dict[str, object] | None:
    reasons = _problematic_surviving_reasons(
        album,
        album_scope_reasons=album_scope_reasons,
        track_problem_rows=track_problem_rows,
    )
    repair_preview = _problematic_encoding_repair_preview(album, include_preview_rows=False)
    return build_problematic_summary(
        album,
        reasons=reasons,
        repair_preview=repair_preview,
    )

@dataclass(frozen=True)
class ProblematicGroupCheckpoint:
    after_stage_id: int = 0
    next_batch_index: int = 0
    row_count: int = 0


_MAX_SEARCH_DOCUMENT_BYTES = 32_768
_MAX_SEARCH_QUERY_BYTES = 4_096
_SEARCH_FACT_OVERLAP_BYTES = _MAX_SEARCH_QUERY_BYTES - 1
_MAX_REDUCER_FACT_BYTES = 65_536
_MAX_DUPLICATE_SUMMARY_SOURCES = 3
_MAX_DUPLICATE_ROOTS = 16
_MAX_DISPLAY_REASONS = 64


class ProblematicProjectionFactLimitError(ValueError):
    """The bounded reducer cannot preserve exact semantics for this group."""


@dataclass(frozen=True)
class ProblematicProjectionReasonFact:
    item_key: str
    normalized_reason: str
    display_reason: str
    category_reason: str


class _ProblematicReasonFactStream(Iterator[ProblematicProjectionReasonFact]):
    def __init__(
        self,
        values: Iterable[ProblematicProjectionReasonFact],
        close_owner: Callable[[], None],
    ) -> None:
        self._values = iter(values)
        self._close_owner = close_owner
        self.closed = False

    def __iter__(self) -> Iterator[ProblematicProjectionReasonFact]:
        return self

    def __next__(self) -> ProblematicProjectionReasonFact:
        if self.closed:
            raise StopIteration
        try:
            return next(self._values)
        except StopIteration:
            self.close()
            raise
        except BaseException as error:
            try:
                self.close()
            except BaseException as cleanup_error:
                add_note = getattr(error, "add_note", None)
                if add_note is not None:
                    add_note(f"reason stream cleanup failed: {cleanup_error!r}")
            raise

    def close(self) -> None:
        if self.closed:
            return
        failure: BaseException | None = None
        close_values = getattr(self._values, "close", None)
        if close_values is not None:
            try:
                close_values()
            except BaseException as error:
                failure = error
        try:
            self._close_owner()
        except BaseException as error:
            if failure is None:
                failure = error
            else:
                add_note = getattr(failure, "add_note", None)
                if add_note is not None:
                    add_note(f"reason stream owner cleanup failed: {error!r}")
        if failure is not None:
            raise failure
        self.closed = True


@dataclass(frozen=True)
class ProblematicProjectedItem(Mapping[str, object]):
    item: Mapping[str, object]
    reason_facts: Iterable[ProblematicProjectionReasonFact] = field(compare=False)
    search_facts: Iterable[Mapping[str, object]] = field(default=(), compare=False)

    def __getitem__(self, key: str) -> object:
        return self.item[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self.item)

    def __len__(self) -> int:
        return len(self.item)

    @property
    def closed(self) -> bool:
        return bool(getattr(self.reason_facts, "closed", False)
                    and getattr(self.search_facts, "closed", True))

    def close(self) -> None:
        failure: BaseException | None = None
        for facts in (self.reason_facts, self.search_facts):
            close_facts = getattr(facts, "close", None)
            if close_facts is not None:
                try:
                    close_facts()
                except BaseException as error:
                    if failure is None:
                        failure = error
                    else:
                        failure.add_note(f"projection fact cleanup failed: {error!r}")
        if failure is not None:
            raise failure

    def __enter__(self) -> "ProblematicProjectedItem":
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.close()


class _BoundedFactValues:
    """Retain an exact prefix while counting and hashing every ordered fact."""

    def __init__(self) -> None:
        self.text = ""
        self.retained_bytes = 0
        self.count = 0
        self.first_value: str | None = None
        self.digest = hashlib.sha256()
        self.truncated = False

    def add(self, value: str) -> None:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        encoded_bytes = encoded.encode("utf-8")
        if self.truncated or (
            self.retained_bytes + len(encoded_bytes) + 1
            > _MAX_REDUCER_FACT_BYTES
        ):
            self.truncated = True
        else:
            self.text = f"{self.text}{encoded}\n"
            self.retained_bytes += len(encoded_bytes) + 1
        self.count += 1
        if self.first_value is None:
            self.first_value = value
        self.digest.update(encoded.encode("utf-8"))
        self.digest.update(b"\n")

    def values(self) -> list[str]:
        return [json.loads(line) for line in self.text.splitlines()]


class _BoundedDuplicateTopology:
    """Keep counts plus a bounded display sample; detail remains relational."""

    def __init__(self) -> None:
        self.companion_count = 0
        self.root_count = 0
        self.root_digest = hashlib.sha256()
        self._root_payloads: list[tuple[bool, dict[str, object]]] = []

    @staticmethod
    def _root_sort_key(
        entry: tuple[bool, Mapping[str, object]],
    ) -> tuple[object, ...]:
        primary, payload = entry
        root_id = str(payload.get("root_id") or "")
        numeric = root_id.lstrip("-").isdigit()
        identity_key: tuple[object, ...] = (
            (0, int(root_id), root_id) if numeric else (1, root_id.casefold(), root_id)
        )
        return (not primary, *identity_key, str(payload.get("category") or ""))

    def _add_root(self, *, root_id: object, category: object, primary: bool) -> None:
        payload = build_root_provenance_payload(root_id, category)
        root_key = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        self.root_digest.update(root_key.encode("utf-8"))
        self.root_digest.update(b"\n")
        self.root_count += 1
        self._root_payloads.append((primary, payload))
        self._root_payloads.sort(key=self._root_sort_key)
        del self._root_payloads[_MAX_DUPLICATE_ROOTS:]

    def add_source(self, *, root_id: object, category: object) -> None:
        self._add_root(root_id=root_id, category=category, primary=False)

    def add_primary_source(self, *, root_id: object, category: object) -> None:
        self._add_root(root_id=root_id, category=category, primary=True)

    def add_companion(self, fact: Mapping[str, object]) -> None:
        self.companion_count += 1

    def apply(self, summary: dict[str, object]) -> None:
        if not self.companion_count:
            return
        retained_payloads = [payload for _primary, payload in self._root_payloads]
        summary["duplicate_companion_count"] = self.companion_count
        summary["duplicate_sources"] = [
            {
                "root_id": payload["root_id"],
                "root_category": payload["category"],
            }
            for payload in retained_payloads[:_MAX_DUPLICATE_SUMMARY_SOURCES]
        ]
        summary["duplicate_topology"] = {
            "companion_count": self.companion_count,
            "root_count": self.root_count,
            "root_digest": self.root_digest.hexdigest(),
            "roots_truncated": self.root_count > len(retained_payloads),
        }


def _problematic_fact_identity(kind: str, *values: object) -> str:
    payload = json.dumps(
        (kind, *values), ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).decode(
        "ascii"
    ).rstrip("=")


def _problematic_ignored_repair_identity(repair_key: str) -> str:
    encoded_key = repair_key.encode("utf-8")
    payload = (
        f"ignored_repair:{len(encoded_key)}:".encode("ascii") + encoded_key
    )
    return base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).decode(
        "ascii"
    ).rstrip("=")


_PROBLEMATIC_FACT_IDENTITY_BYTES = 43
_PROBLEMATIC_FACT_RECORD_BYTES = _PROBLEMATIC_FACT_IDENTITY_BYTES + 1
_PROBLEMATIC_FACT_MERGE_FAN_IN = 16


def _open_problematic_identity_run(path: Path, mode: str) -> BinaryIO:
    return path.open(mode)


class _SpooledIgnoredRepairMembership:
    """Exact ignored-repair membership with bounded resident memory."""

    def __init__(self) -> None:
        self._file = tempfile.SpooledTemporaryFile(
            max_size=_MAX_REDUCER_FACT_BYTES,
            mode="w+b",
        )
        self._count = 0
        self._previous_identity: bytes | None = None
        self._legacy_file = None
        self._legacy_count = 0
        self._lookup_file = None
        self._lookup_count = 0

    @staticmethod
    def _records(owner: object, count: int) -> Iterator[bytes]:
        owner.seek(0)
        for _index in range(count):
            record = owner.read(_PROBLEMATIC_FACT_RECORD_BYTES)
            if (
                len(record) != _PROBLEMATIC_FACT_RECORD_BYTES
                or record[-1:] != b"\n"
            ):
                raise ValueError("invalid ignored repair spool record")
            yield record[:-1]

    def _invalidate_lookup(self) -> None:
        if self._lookup_file is not None:
            self._lookup_file.close()
            self._lookup_file = None
            self._lookup_count = 0

    def add_row_values(self, values: Iterable[str]) -> None:
        identities: list[bytes] = []
        retained_bytes = 0
        for value in values:
            retained_bytes += len(
                json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(
                    "utf-8"
                )
            ) + 1
            if retained_bytes > _MAX_REDUCER_FACT_BYTES:
                raise ProblematicProjectionFactLimitError(
                    "legacy ignored-repair row exceeds source payload limit"
                )
            identities.append(
                _problematic_ignored_repair_identity(value).encode("ascii")
            )
        for identity in identities:
            if self._legacy_file is None:
                self._legacy_file = tempfile.SpooledTemporaryFile(
                    max_size=_MAX_REDUCER_FACT_BYTES,
                    mode="w+b",
                )
            self._legacy_file.seek(0, 2)
            self._legacy_file.write(identity + b"\n")
            self._legacy_count += 1
        if identities:
            self._invalidate_lookup()

    def add_identity(self, value: str) -> None:
        identity = value.encode("ascii")
        if len(identity) != _PROBLEMATIC_FACT_IDENTITY_BYTES:
            raise ValueError("invalid problematic fact identity width")
        if self._previous_identity is not None:
            if identity == self._previous_identity:
                return
            if identity < self._previous_identity:
                raise ValueError("ignored repair fact order regressed")
        self._file.seek(0, 2)
        self._file.write(identity + b"\n")
        self._count += 1
        self._previous_identity = identity
        self._invalidate_lookup()

    def add(self, repair_key: str) -> None:
        # Persisted pre-hash facts are ordered by their legacy semantic identity,
        # not by the replacement hash. Merge them into the sorted membership
        # instead of applying the new-fact streaming order contract.
        self.add_row_values((repair_key,))

    def _ensure_lookup(self) -> tuple[object, int]:
        if self._lookup_file is not None:
            return self._lookup_file, self._lookup_count
        if not self._legacy_count:
            return self._file, self._count
        if self._legacy_file is None:
            raise ValueError("missing ignored repair legacy spool")

        chunk_record_count = max(
            1,
            _MAX_REDUCER_FACT_BYTES // _PROBLEMATIC_FACT_RECORD_BYTES,
        )
        lookup_file = tempfile.SpooledTemporaryFile(
            max_size=_MAX_REDUCER_FACT_BYTES,
            mode="w+b",
        )
        try:
            with tempfile.TemporaryDirectory(
                prefix="album-haven-problematic-identities-"
            ) as run_directory_value:
                run_directory = Path(run_directory_value)
                run_generation = 0
                runs: list[tuple[Path, int]] = []
                legacy_records = self._records(
                    self._legacy_file,
                    self._legacy_count,
                )
                while True:
                    chunk = list(
                        itertools.islice(legacy_records, chunk_record_count)
                    )
                    if not chunk:
                        break
                    identities = sorted(set(chunk))
                    run_path = run_directory / f"run-0-{len(runs):08d}.bin"
                    with _open_problematic_identity_run(run_path, "wb") as run:
                        for identity in identities:
                            run.write(identity + b"\n")
                    runs.append((run_path, len(identities)))

                if _PROBLEMATIC_FACT_MERGE_FAN_IN < 2:
                    raise ValueError("problematic identity merge fan-in is too small")
                final_run_limit = _PROBLEMATIC_FACT_MERGE_FAN_IN - bool(
                    self._count
                )
                while len(runs) > final_run_limit:
                    run_generation += 1
                    merged_runs: list[tuple[Path, int]] = []
                    for offset in range(
                        0,
                        len(runs),
                        _PROBLEMATIC_FACT_MERGE_FAN_IN,
                    ):
                        run_batch = runs[
                            offset : offset + _PROBLEMATIC_FACT_MERGE_FAN_IN
                        ]
                        if len(run_batch) == 1:
                            merged_runs.append(run_batch[0])
                            continue
                        merged_path = run_directory / (
                            f"run-{run_generation}-{len(merged_runs):08d}.bin"
                        )
                        with ExitStack() as stack:
                            merged_run = stack.enter_context(
                                _open_problematic_identity_run(merged_path, "wb")
                            )
                            sources = []
                            for run_path, run_count in run_batch:
                                run = stack.enter_context(
                                    _open_problematic_identity_run(run_path, "rb")
                                )
                                sources.append(self._records(run, run_count))
                            previous_identity: bytes | None = None
                            merged_count = 0
                            for identity in heapq.merge(*sources):
                                if identity == previous_identity:
                                    continue
                                merged_run.write(identity + b"\n")
                                merged_count += 1
                                previous_identity = identity
                        for run_path, _run_count in run_batch:
                            run_path.unlink()
                        merged_runs.append((merged_path, merged_count))
                    runs = merged_runs

                with ExitStack() as stack:
                    sources = [self._records(self._file, self._count)]
                    for run_path, run_count in runs:
                        run = stack.enter_context(
                            _open_problematic_identity_run(run_path, "rb")
                        )
                        sources.append(self._records(run, run_count))
                    previous_identity = None
                    lookup_count = 0
                    for identity in heapq.merge(*sources):
                        if identity == previous_identity:
                            continue
                        lookup_file.write(identity + b"\n")
                        lookup_count += 1
                        previous_identity = identity
        except BaseException:
            lookup_file.close()
            raise

        self._lookup_file = lookup_file
        self._lookup_count = lookup_count
        return lookup_file, lookup_count

    def __contains__(self, repair_key: object) -> bool:
        if self._file.closed or not (self._count or self._legacy_count):
            return False
        lookup_file, lookup_count = self._ensure_lookup()
        identity = _problematic_ignored_repair_identity(str(repair_key)).encode(
            "ascii"
        )
        lower = 0
        upper = lookup_count
        while lower < upper:
            middle = (lower + upper) // 2
            lookup_file.seek(middle * _PROBLEMATIC_FACT_RECORD_BYTES)
            candidate = lookup_file.read(_PROBLEMATIC_FACT_IDENTITY_BYTES)
            if candidate < identity:
                lower = middle + 1
            else:
                upper = middle
        if lower >= lookup_count:
            return False
        lookup_file.seek(lower * _PROBLEMATIC_FACT_RECORD_BYTES)
        return lookup_file.read(_PROBLEMATIC_FACT_IDENTITY_BYTES) == identity

    def __bool__(self) -> bool:
        return bool(self._count or self._legacy_count)

    def close(self) -> None:
        self._file.close()
        if self._legacy_file is not None:
            self._legacy_file.close()
        if self._lookup_file is not None:
            self._lookup_file.close()


def normalize_problematic_text(value: object) -> str:
    """Canonicalize persisted projection text and reader inputs identically."""
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()


_ECMASCRIPT_TRIM_CHARACTERS = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007"
    "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def normalize_problematic_search_query(value: object) -> str:
    """Match the main UI's trim and ordinary lowercase without folding facts."""
    normalized = str(value or "").strip(_ECMASCRIPT_TRIM_CHARACTERS).lower()
    if len(normalized.encode("utf-8")) > _MAX_SEARCH_QUERY_BYTES:
        raise ValueError("problematic projection search query exceeds 4096 bytes")
    return normalized


def _problematic_search_chunks(parts: Iterable[str]) -> Iterator[str]:
    pending = bytearray()
    for part in parts:
        encoded = part.encode("utf-8")
        for offset in range(0, len(encoded), _MAX_SEARCH_DOCUMENT_BYTES):
            pending.extend(encoded[offset:offset + _MAX_SEARCH_DOCUMENT_BYTES])
            while len(pending) > _MAX_SEARCH_DOCUMENT_BYTES:
                end = _MAX_SEARCH_DOCUMENT_BYTES
                while pending[end] & 0xC0 == 0x80:
                    end -= 1
                yield pending[:end].decode("utf-8")
                start = max(0, end - _SEARCH_FACT_OVERLAP_BYTES)
                while start and pending[start] & 0xC0 == 0x80:
                    start -= 1
                if start <= 0:
                    raise ValueError("problematic projection search chunk did not advance")
                del pending[:start]
    if pending:
        yield pending.decode("utf-8")


def _normalized_problematic_search_chunks(value: object) -> tuple[str, ...]:
    return tuple(_problematic_search_chunks((str(value or "").lower(),)))


class _ProblematicSortedSearchValues:
    """Order complete search facts with bounded runs and merge fan-in."""

    def __init__(self, *, work=None, compare_keys=None) -> None:
        self._work = work
        self._compare_keys = compare_keys
        self._file = tempfile.SpooledTemporaryFile(
            max_size=_MAX_REDUCER_FACT_BYTES, mode="w+t", encoding="utf-8", newline="\n",
        )
        self._sorted = False

    def add(self, key: tuple[object, ...], value: object) -> None:
        self._file.seek(0, 2)
        line = json.dumps((key, value), ensure_ascii=False, separators=(",", ":")) + "\n"
        if self._work is not None:
            self._work(len(line.encode("utf-8")))
        self._file.write(line)
        self._sorted = False

    def _records(self, owner: object) -> Iterator[list[object]]:
        for line in owner:
            if self._work is not None:
                self._work(len(line.encode("utf-8")))
            yield json.loads(line)

    def _sort(self) -> None:
        from functools import cmp_to_key

        ordered_key = cmp_to_key(self._compare_keys) if self._compare_keys is not None else lambda key: key
        if _PROBLEMATIC_FACT_MERGE_FAN_IN < 2:
            raise ValueError("problematic search merge fan-in is too small")
        with tempfile.TemporaryDirectory(prefix="album-haven-problematic-search-") as directory:
            root = Path(directory)
            self._file.seek(0)
            count = 0
            batch = []
            batch_bytes = 0

            def flush() -> None:
                nonlocal count, batch_bytes
                if self._work is not None:
                    self._work(force=True)
                batch.sort(key=lambda record: ordered_key(record[0]))
                with (root / f"run-0-{count}.jsonl").open("w", encoding="utf-8", newline="\n") as run:
                    for _key, line in batch:
                        run.write(line)
                if self._work is not None:
                    self._work(force=True)
                count += 1
                batch.clear()
                batch_bytes = 0

            for line in self._file:
                line_bytes = len(line.encode("utf-8"))
                if self._work is not None:
                    self._work(line_bytes)
                if batch and batch_bytes + line_bytes > _MAX_REDUCER_FACT_BYTES:
                    flush()
                batch.append((json.loads(line)[0], line))
                batch_bytes += line_bytes
            if batch:
                flush()
            generation = 0
            while count > 1:
                next_count = 0
                for start in range(0, count, _PROBLEMATIC_FACT_MERGE_FAN_IN):
                    if self._work is not None:
                        self._work(force=True)
                    inputs = [root / f"run-{generation}-{index}.jsonl"
                              for index in range(start, min(start + _PROBLEMATIC_FACT_MERGE_FAN_IN, count))]
                    with ExitStack() as stack:
                        sources = [self._records(stack.enter_context(path.open("r", encoding="utf-8")))
                                   for path in inputs]
                        target = root / f"run-{generation + 1}-{next_count}.jsonl"
                        with target.open("w", encoding="utf-8", newline="\n") as run:
                            for record in heapq.merge(*sources, key=lambda record: ordered_key(record[0])):
                                run.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                    for path in inputs:
                        path.unlink()
                    if self._work is not None:
                        self._work(force=True)
                    next_count += 1
                count = next_count
                generation += 1
            self._file.seek(0)
            self._file.truncate()
            if count:
                with (root / f"run-{generation}-0.jsonl").open("r", encoding="utf-8") as run:
                    for line in run:
                        if self._work is not None:
                            self._work(len(line.encode("utf-8")))
                        self._file.write(line)
            self._sorted = True

    def values(self) -> Iterator[object]:
        if not self._sorted:
            self._sort()
        self._file.seek(0)
        for record in self._records(self._file):
            yield record[1]

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> "_ProblematicSortedSearchValues":
        return self

    def __exit__(self, _exc_type, error, _traceback) -> None:
        try:
            self.close()
        except BaseException as cleanup_error:
            if error is None:
                raise
            error.add_note(f"problematic spool cleanup failed: {cleanup_error!r}")


def _problematic_signature_digest():
    """Candidate bucket only; exact bounded comparison decides equality."""
    return hashlib.sha256()


class _ProblematicSignatureStore:
    def __init__(self, work):
        self._file = None
        self._work = work

    def text(self, title):
        if self._file is None:
            self._file = tempfile.TemporaryFile(mode="w+b")
        self._file.seek(0, 2)
        offset = self._file.tell()
        for start in range(0, len(title), max(1, _MAX_REDUCER_FACT_BYTES // 4)):
            encoded = title[start:start + max(1, _MAX_REDUCER_FACT_BYTES // 4)].encode("utf-8")
            self._work(len(encoded))
            self._file.write(encoded)
        return {"offset": offset, "length": self._file.tell() - offset}

    def token(self, disc, number, title, duration):
        reference = self.text(title)
        return (disc, number, reference["offset"], reference["length"], duration)

    def compare_tokens(self, left, right):
        self._work()
        if left[:2] != right[:2]:
            return -1 if left[:2] < right[:2] else 1
        compared = self.compare({"offset": left[2], "length": left[3]},
                                {"offset": right[2], "length": right[3]})
        return compared or (left[4] > right[4]) - (left[4] < right[4])

    def write(self, tokens):
        with _ProblematicSortedSearchValues(work=self._work, compare_keys=self.compare_tokens) as ordered:
            for token in tokens:
                reference = self.token(*token)
                ordered.add(reference, reference)
            return self.write_refs(ordered.values())

    def write_refs(self, tokens):
        if self._file is None:
            self._file = tempfile.TemporaryFile(mode="w+b")
        self._file.seek(0, 2)
        offset = destination = self._file.tell()
        digest = _problematic_signature_digest()
        count = 0
        for token in tokens:
            header = (json.dumps([token[0], token[1], token[3], token[4]], separators=(",", ":")) + "\n").encode("utf-8")
            for start in range(0, len(header), max(1, _MAX_REDUCER_FACT_BYTES // 2)):
                block = header[start:start + max(1, _MAX_REDUCER_FACT_BYTES // 2)]
                self._file.seek(destination)
                self._file.write(block)
                destination += len(block)
                digest.update(block)
                self._work(len(block))
            position, remaining = token[2], token[3]
            while remaining:
                self._file.seek(position)
                block = self._file.read(min(remaining, max(1, _MAX_REDUCER_FACT_BYTES // 2)))
                if not block:
                    raise ValueError("signature title reference exceeds its owned stream")
                self._file.seek(destination)
                self._file.write(block)
                destination += len(block)
                position += len(block)
                remaining -= len(block)
                digest.update(block)
                self._work(2 * len(block))
            count += 1
        return {"offset": offset, "length": destination - offset,
                "count": count, "digest": digest.hexdigest()}

    def compare(self, left, right):
        self._work()
        left_offset, right_offset = left["offset"], right["offset"]
        left_remaining, right_remaining = left["length"], right["length"]
        while left_remaining and right_remaining:
            size = min(left_remaining, right_remaining, max(1, _MAX_REDUCER_FACT_BYTES // 2))
            self._file.seek(left_offset)
            first = self._file.read(size)
            self._work(len(first))
            self._file.seek(right_offset)
            second = self._file.read(size)
            self._work(len(second))
            if len(first) != size or len(second) != size:
                raise ValueError("signature reference exceeds its owned stream")
            if first != second:
                return -1 if first < second else 1
            left_offset += size
            right_offset += size
            left_remaining -= size
            right_remaining -= size
        return (left_remaining > right_remaining) - (left_remaining < right_remaining)

    def close(self):
        if self._file is not None:
            self._file.close()

    def __enter__(self):
        return self

    def __exit__(self, _kind, error, _traceback):
        try:
            self.close()
        except BaseException as cleanup_error:
            if error is None:
                raise
            error.add_note(f"signature spool cleanup failed: {cleanup_error!r}")


def _problematic_equivalent_witnesses(candidates, signatures, *, work):
    """Find actual compatible witnesses with bounded sorted references and top-two scalars."""
    from music_app.services.library import _RELEASE_TYPE_EDITIONS

    def compare_keys(left, right):
        work()
        if left[:-2] != right[:-2]:
            return -1 if left[:-2] < right[:-2] else 1
        return signatures.compare({"offset": left[-2], "length": left[-1]},
                                  {"offset": right[-2], "length": right[-1]})

    def remember(values, container):
        if container not in values and len(values) < 2:
            values.append(container)

    def compare_text_keys(left, right):
        work()
        if left[0] != right[0]:
            return -1 if left[0] < right[0] else 1
        return signatures.compare({"offset": left[1], "length": left[2]},
                                  {"offset": right[1], "length": right[2]})

    with ExitStack() as stack:
        ordered = stack.enter_context(_ProblematicSortedSearchValues(work=work, compare_keys=compare_keys))
        pairs = stack.enter_context(_ProblematicSortedSearchValues(work=work))
        originals = stack.enter_context(_ProblematicSortedSearchValues(work=work))
        texts = stack.enter_context(_ProblematicSortedSearchValues(work=work, compare_keys=compare_text_keys))
        assigned = stack.enter_context(_ProblematicSortedSearchValues(work=work))
        for ordinal, candidate in enumerate(candidates):
            references = candidate.get("card_refs")
            if references is None:
                card = candidate["card"]
                references = [signatures.text(card[index]) for index in (0, 1, 3, 4)]
                edition_role = card[3] if card[3] in _RELEASE_TYPE_EDITIONS or not card[3] else None
                date_blank = not card[4]
                year = card[2]
            else:
                edition_role, date_blank = candidate["edition_role"], candidate["date_blank"]
                year = candidate["year"]
            originals.add((ordinal,), {"ordinal": ordinal, "album": candidate["album"],
                                       "container": candidate["container"], "signature": candidate["signature"],
                                       "year": year, "edition_role": edition_role, "date_blank": date_blank})
            for field, reference in enumerate(references):
                texts.add((field, reference["offset"], reference["length"]),
                          {"ordinal": ordinal, "field": field, "reference": reference})
        previous_text = None
        text_id = 0
        for row in texts.values():
            if (previous_text is None or row["field"] != previous_text["field"]
                    or signatures.compare(row["reference"], previous_text["reference"]) != 0):
                text_id += 1
            previous_text = row
            assigned.add((row["ordinal"], row["field"]), {"ordinal": row["ordinal"], "field": row["field"], "id": text_id})
        assignments = iter(assigned.values())
        assignment = next(assignments, None)
        for candidate in originals.values():
            card = [None] * 4
            while assignment is not None and assignment["ordinal"] == candidate["ordinal"]:
                card[assignment["field"]] = assignment["id"]
                assignment = next(assignments, None)
            if any(value is None for value in card):
                raise ValueError("signature candidate lacks canonical metadata references")
            candidate["card"] = [card[0], card[1], candidate["year"], card[2], card[3]]
            signature = candidate["signature"]
            key = (candidate["album"], *candidate["card"][:3], signature["digest"], signature["count"],
                   signature["offset"], signature["length"])
            ordered.add(key, candidate)
        previous = None
        class_id = 0
        for candidate in ordered.values():
            signature = candidate["signature"]
            if (previous is None or candidate["album"] != previous["album"]
                    or candidate["card"][:3] != previous["card"][:3]
                    or signature["digest"] != previous["signature"]["digest"]
                    or signature["count"] != previous["signature"]["count"]
                    or signatures.compare(signature, previous["signature"]) != 0):
                class_id += 1
            previous = candidate
            edition, date = candidate["card"][3:]
            domains = [(("self", edition), 0)]
            if candidate["edition_role"] == "":
                domains.extend((("cross", value), 0) for value in sorted(_RELEASE_TYPE_EDITIONS))
            elif candidate["edition_role"] is not None:
                domains.append((("cross", candidate["edition_role"]), 1))
            for domain, role in domains:
                pairs.add((class_id, domain, role, date, candidate["container"]),
                          {**candidate, "class": class_id, "domain": domain, "role": role, "date": date})
        for (class_id, domain), records in itertools.groupby(pairs.values(), key=lambda row: (row["class"], row["domain"])):
            with _ProblematicSortedSearchValues(work=work) as replay, _ProblematicSortedSearchValues(work=work) as dated:
                all_dates, blank_dates = [[], []], [[], []]
                for (role, date), rows in itertools.groupby(records, key=lambda row: (row["role"], row["date"])):
                    top = []
                    for row in rows:
                        remember(all_dates[role], row["container"])
                        if row["date_blank"]:
                            remember(blank_dates[role], row["container"])
                        remember(top, row["container"])
                        replay.add((date, role, row["container"]), row)
                    for container in top:
                        dated.add((date, role, container), {"date": date, "role": role, "container": container})
                date_stream = iter(dated.values())
                date_row = next(date_stream, None)
                for date, rows in itertools.groupby(replay.values(), key=lambda row: row["date"]):
                    same_date = [[], []]
                    while date_row is not None and date_row["date"] < date:
                        date_row = next(date_stream, None)
                    while date_row is not None and date_row["date"] == date:
                        remember(same_date[date_row["role"]], date_row["container"])
                        date_row = next(date_stream, None)
                    for row in rows:
                        role = 1 - row["role"] if domain[0] == "cross" else row["role"]
                        choices = all_dates[role] if row["date_blank"] else same_date[role] + blank_dates[role]
                        witness = next((value for value in choices if value != row["container"]), None)
                        if witness is not None:
                            yield {"album": row["album"], "container": row["container"], "witness": witness}


def _problematic_topology_work(check_stop=None):
    records = decoded_bytes = 0

    def work(size=0, *, force=False):
        nonlocal records, decoded_bytes
        records += 1
        decoded_bytes += size
        if force or records >= 100 or decoded_bytes >= _MAX_REDUCER_FACT_BYTES:
            if check_stop is not None:
                check_stop()
            records = decoded_bytes = 0

    return work


@contextmanager
def _prepared_problematic_topology(facts, *, check_stop=None):
    """Derive topology from the immutable supplied universe, using bounded runs."""
    from music_app.services.library import (
        _duplicate_album_identity_values,
        _numeric_album_container_candidate,
        _track_album_container,
        _normalized_duplicate_card_text,
        _RELEASE_TYPE_EDITIONS,
        safe_int,
    )

    work = _problematic_topology_work(check_stop)

    stack = ExitStack()

    def spool():
        return stack.enter_context(_ProblematicSortedSearchValues(work=work))

    def identity(entry):
        value = _duplicate_album_identity_values(
            entry.get("album_artist"), entry.get("album"), entry.get("year")
        )
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")) if value else ""

    try:
        work(force=True)
        output, prepared, row_facts = spool(), spool(), spool()
        external_numeric, external_addresses, external_companions, targets = spool(), spool(), spool(), spool()
        external_folders, ordered_rows = spool(), spool()
        external_topology = external_complete = False

        def emit(stage, kind, fact):
            key = (str(fact["projection_id"]), kind, str(fact["semantic_child_identity"]))
            if kind == "duplicate_root":
                key += (fact.get("primary") is not True,)
            output.add(key, [stage, kind, fact])

        row_derived_kinds = {
            "track_key", "track_title", "private_path", "private_path_locator",
            "duplicate_lookup", "album_value", "artist_value", "raw_year",
            "valid_year", "track_number",
        }
        previous = None
        for stage, kind, fact in facts:
            projection = str(fact.get("projection_id") or "")
            semantic = str(fact.get("semantic_child_identity") or "")
            if not projection:
                raise ValueError("problematic projection fact lacks projection_id")
            if not semantic:
                raise ValueError("problematic projection fact lacks semantic child identity")
            key = (projection, kind, semantic)
            if previous is not None and key < previous:
                raise ValueError("problematic projection fact order regressed")
            if key == previous:
                continue
            previous = key
            if kind == "topology_descriptor":
                external_topology = True
                descriptor_kind = fact.get("descriptor_kind")
                descriptor = fact.get("descriptor")
                if not isinstance(descriptor, Mapping):
                    raise ValueError("invalid topology descriptor")
                if descriptor_kind == "topology_descriptor_start":
                    continue
                if descriptor_kind == "topology_descriptor_end":
                    external_complete = descriptor.get("complete") is True
                elif descriptor_kind == "topology_numeric_descriptor":
                    external_numeric.add(tuple(descriptor["key"]), descriptor)
                elif descriptor_kind == "topology_address_descriptor":
                    external_addresses.add((descriptor["key"][1],), descriptor)
                elif descriptor_kind == "topology_companion_descriptor":
                    external_companions.add((descriptor["original_album_key"], descriptor["file_id"]), descriptor)
                elif descriptor_kind == "topology_folder_descriptor":
                    external_folders.add((descriptor["root_id"], descriptor["physical_parent"]), descriptor)
                else:
                    raise ValueError("unknown topology descriptor")
                continue
            if kind.startswith("topology_"):
                continue
            if kind != "row":
                if kind in row_derived_kinds or (kind == "duplicate_root" and fact.get("primary") is True):
                    continue
                emit(stage, kind, fact)
                if kind == "duplicate_companion":
                    root_id = fact.get("companion_library_root_id")
                    category = fact.get("companion_root_category")
                    emit(stage, "duplicate_root", {
                        "projection_id": projection,
                        "semantic_child_identity": _problematic_fact_identity("duplicate_root", root_id, category),
                        "root_id": root_id, "category": category, "primary": False,
                    })
                continue
            path = str(fact.get("file_private_path") or "").strip()
            row_facts.add((_coerce_int(fact.get("file_library_root_id")),
                           str(fact.get("file_physical_parent") or ""), projection, path, semantic), [stage, kind, fact])

        def folder_decisions():
            for folder, versions in itertools.groupby(external_folders.values(), key=lambda value: (value["root_id"], value["physical_parent"])):
                yield folder, any(value["mixed"] is True for value in versions)

        decisions = iter(folder_decisions())
        stack.callback(decisions.close)
        decision = next(decisions, None)
        for stage, kind, fact in row_facts.values():
            folder = (_coerce_int(fact.get("file_library_root_id")), str(fact.get("file_physical_parent") or ""))
            while decision is not None and decision[0] < folder:
                decision = next(decisions, None)
            if decision is not None and decision[0] == folder:
                fact = {**fact, "file_mixed_album_folder": decision[1]}
            ordered_rows.add((str(fact["projection_id"]), str(fact.get("file_private_path") or "").strip(),
                              str(fact["semantic_child_identity"])), [stage, kind, fact])

        previous_path = None
        for stage, kind, fact in ordered_rows.values():
            projection = str(fact["projection_id"])
            path = str(fact.get("file_private_path") or "").strip()
            path_key = (projection, path)
            row_winner = not path or path_key != previous_path
            if row_winner:
                emit(stage, kind, fact)
                # Persisted value facts have merged away their row origin; rebuild from winners.
                for _stage, derived_kind, derived in ProblematicGroupAccumulator().consume(((max(1, stage), fact),)):
                    if derived_kind != "row" and not derived_kind.startswith("topology_"):
                        emit(stage, derived_kind, derived)
            previous_path = path_key
            if fact.get("inventory_status") == "missing":
                continue
            # Topology excludes before its separate original-album path deduplication.
            entry = _problematic_topology_entry(fact)
            album = str(fact.get("album_key") or "")
            path = str(entry.get("path") or "")
            if row_winner and album and path:
                split = _row_album_identity(fact, str(fact.get("artist_name") or ""))[1] != album
                target = [album, "year", str(_coerce_int(entry.get("year")))] if split else [album, "all", ""]
                targets.add((*target, projection), {"key": target, "album": album,
                            "projection": projection, "split": split})
            if (not album or not path or normalize_exception_value(entry.get("exception_type"))
                    or str(entry.get("local_album_membership_problem") or "").strip()):
                continue
            prepared.add((album, path.casefold(), path), {
                "album": album, "path": path, "entry": entry, "projection": projection,
                "split": _row_album_identity(fact, str(fact.get("artist_name") or ""))[1] != album,
            })

        if external_topology and not external_complete:
            raise ValueError("topology descriptor stream is incomplete")
        numeric = spool()
        for album, rows in itertools.groupby(prepared.values(), key=lambda row: row["album"]):
            previous_path = None
            rank = None
            for row in rows:
                path = row["path"]
                if path == previous_path:
                    continue
                previous_path = path
                rank = rank or [path.casefold(), path, album]
                row["rank"] = rank
                entry = row["entry"]
                candidate = _numeric_album_container_candidate(
                    path, entry.get("disc_number"), entry.get("album"), entry.get("edition")
                )
                row["container"] = _track_album_container(path)
                if candidate is None:
                    bucket = [album, "", path]
                else:
                    group, folder, ordinal, matches, parent = candidate
                    bucket = [album, "numeric", *group]
                    row.update(folder=folder, ordinal=ordinal, matches=matches, parent=parent)
                row["bucket"] = bucket
                numeric.add((*bucket, path.casefold(), path), row)

        by_container, global_paths = spool(), spool()
        numeric_stream = iter(external_numeric.values())
        numeric_decision = next(numeric_stream, None)
        for _bucket, rows in itertools.groupby(numeric.values(), key=lambda row: row["bucket"]):
            with _ProblematicSortedSearchValues(work=work) as replay:
                first_folder = first_ordinal = None
                different_folder = different_ordinal = False
                matches = True
                for row in rows:
                    if "folder" in row:
                        first_folder = first_folder if first_folder is not None else row["folder"]
                        first_ordinal = first_ordinal if first_ordinal is not None else row["ordinal"]
                        different_folder |= row["folder"] != first_folder
                        different_ordinal |= row["ordinal"] != first_ordinal
                        matches &= row["matches"]
                    replay.add((row["path"].casefold(), row["path"]), row)
                collapse = different_folder and different_ordinal and matches
                if external_topology and _bucket[1] == "numeric":
                    expected_bucket = ["bucket", _bucket[0], *_bucket[2:]]
                    while numeric_decision is not None and numeric_decision["key"] < expected_bucket:
                        numeric_decision = next(numeric_stream, None)
                    if (numeric_decision is None or numeric_decision["key"] != expected_bucket
                            or type(numeric_decision.get("collapse")) is not bool):
                        raise ValueError("topology projection lacks certified numeric decision")
                    collapse = numeric_decision["collapse"]
                for row in replay.values():
                    if collapse:
                        row["container"] = row["parent"]
                    row["container_key"] = os.path.normcase(row["container"])
                    row["identity"] = identity(row["entry"])
                    by_container.add((row["container_key"], row["album"], row["path"]), row)
                    global_paths.add((row["container_key"], os.path.normcase(row["path"]),
                                      row["rank"], row["path"].casefold(), row["path"]), row)

        containers, linked = spool(), spool()
        address_stream = iter(external_addresses.values())
        address = next(address_stream, None)
        for container, rows in itertools.groupby(global_paths.values(), key=lambda row: row["container_key"]):
            found = None
            clean = True
            for _path, versions in itertools.groupby(rows, key=lambda row: os.path.normcase(row["path"])):
                winner = None
                for winner in versions:
                    work()
                value = winner["identity"]
                if found is None:
                    found = value
                clean &= bool(value) and value == found
            if external_topology:
                while address is not None and address["key"][1] < container:
                    address = next(address_stream, None)
                if address is None or address["key"][1] != container or address.get("status") not in ("CLEAN", "MIXED", "EMPTY"):
                    raise ValueError("topology projection lacks certified address")
                if type(address.get("linked")) is not bool:
                    raise ValueError("invalid topology address link decision")
                if address["status"] == "CLEAN":
                    address_identity = address.get("identity")
                    if (not isinstance(address_identity, list) or len(address_identity) != 3
                            or _duplicate_album_identity_values(*address_identity) != tuple(address_identity)):
                        raise ValueError("invalid canonical topology address identity")
                if address["status"] == "CLEAN" and address["linked"]:
                    linked.add((container,), {"identity": json.dumps(address["identity"], ensure_ascii=False, separators=(",", ":")),
                                             "container": container})
                continue
            if clean and found:
                containers.add((found, container), {"identity": found, "container": container})

        for _identity, rows in itertools.groupby(containers.values(), key=lambda row: row["identity"]):
            with _ProblematicSortedSearchValues(work=work) as replay:
                count = 0
                for row in rows:
                    count += 1
                    replay.add((row["container"],), row)
                if count > 1:
                    for row in replay.values():
                        linked.add((row["container"],), row)

        positives = iter(linked.values())
        positive = next(positives, None)
        local = spool()
        for container, rows in itertools.groupby(by_container.values(), key=lambda row: row["container_key"]):
            while positive is not None and positive["container"] < container:
                positive = next(positives, None)
            exact = positive is not None and positive["container"] == container
            for row in rows:
                row["exact"] = exact
                row["exact_year"] = json.loads(positive["identity"])[2] if exact else None
                local.add((row["album"], container, row["path"]), row)

        families, signature_candidates = spool(), spool()
        has_signature_candidates = False
        signatures = stack.enter_context(_ProblematicSignatureStore(work))
        for (album, container), rows in itertools.groupby(local.values(), key=lambda row: (row["album"], row["container_key"])):
            with _ProblematicSortedSearchValues(work=work) as replay:
                found = year = None
                clean = uniform_year = True
                exact = False
                track_count = 0
                for row in rows:
                    track_count += 1
                    value = row["identity"]
                    found = value if found is None else found
                    clean &= bool(value) and value == found
                    row_year = _coerce_int(row["entry"].get("year"))
                    year = row_year if year is None else year
                    uniform_year &= row_year == year
                    exact |= row["exact"]
                    replay.add((row["projection"], row["path"]), row)
                for row in replay.values():
                    families.add((album, found if clean else "", container, row["projection"], row["path"]), {
                        **row, "local_identity": found if clean else "", "source_year": year if uniform_year else None,
                        "exact": exact, "container_track_count": track_count,
                    })

        decisions, eligible_rows, album_modes = spool(), spool(), spool()
        for album, rows in itertools.groupby(families.values(), key=lambda row: row["album"]):
            with _ProblematicSortedSearchValues(work=work) as replay:
                any_exact = False
                unqualified = False
                for local_identity, members in itertools.groupby(rows, key=lambda row: row["local_identity"]):
                    with _ProblematicSortedSearchValues(work=work) as family:
                        first = None
                        repeated = False
                        for row in members:
                            first = first if first is not None else row["container_key"]
                            repeated |= row["container_key"] != first
                            any_exact |= row["exact"]
                            family.add((row["projection"], row["path"]), row)
                        for row in family.values():
                            row["fallback"] = bool(local_identity and repeated)
                            unqualified |= bool(local_identity) and not row["fallback"] and row["container_track_count"] >= 2
                            replay.add((row["fallback"], row["container_key"], row["projection"], row["path"]), row)
                needs_equivalent = not any_exact and unqualified
                has_unqualified_signature = False
                for (qualified, container), members in itertools.groupby(replay.values(), key=lambda row: (row["fallback"], row["container_key"])):
                    prepare_signature = needs_equivalent and (not qualified or has_unqualified_signature)
                    with ExitStack() as signature_stack:
                        tokens = signature_stack.enter_context(_ProblematicSortedSearchValues(
                            work=work, compare_keys=signatures.compare_tokens,
                        )) if prepare_signature else None
                        card = local_identity = None
                        valid_signature = prepare_signature
                        for row in members:
                            eligible_rows.add((album, container, row["projection"], row["path"]), row)
                            if not prepare_signature:
                                continue
                            local_identity = row["local_identity"]
                            if not local_identity:
                                valid_signature = False
                                continue
                            entry = row["entry"]
                            current_card = (_normalized_duplicate_card_text(entry.get("edition")),
                                            str(entry.get("release_date") or "").strip())
                            if card is None:
                                card = current_card
                            valid_signature &= current_card == card
                            number = safe_int(entry.get("track_number"))
                            duration = safe_int(entry.get("duration_seconds"))
                            title = _normalized_duplicate_card_text(entry.get("title"))
                            if number is None or duration is None or duration <= 0 or not title:
                                valid_signature = False
                            else:
                                token = signatures.token(safe_int(entry.get("disc_number")) or 1, number, title, duration)
                                tokens.add(token, token)
                        if valid_signature and local_identity:
                            signature = signatures.write_refs(tokens.values())
                            if signature["count"] >= 2:
                                has_unqualified_signature |= not qualified
                                artist, title, identity_year = json.loads(local_identity)
                                signature_candidates.add((album, container), {
                                    "album": album, "container": container, "signature": signature,
                                    "card_refs": [signatures.text(_normalized_duplicate_card_text(artist)),
                                                  signatures.text(_normalized_duplicate_card_text(title).removeprefix("the ")),
                                                  signatures.text(card[0]), signatures.text(card[1])],
                                    "year": identity_year,
                                    "edition_role": card[0] if not card[0] or card[0] in _RELEASE_TYPE_EDITIONS else None,
                                    "date_blank": not card[1],
                                })
                                has_signature_candidates = True
                album_modes.add((album,), {"album": album, "exact": any_exact})
        equivalent = spool()
        if has_signature_candidates:
            for witness in _problematic_equivalent_witnesses(signature_candidates.values(), signatures, work=work):
                equivalent.add((witness["album"], witness["container"]), witness)
        witnesses = iter(equivalent.values())
        witness = next(witnesses, None)
        modes = iter(album_modes.values())
        mode = next(modes, None)
        for (album, container), rows in itertools.groupby(eligible_rows.values(), key=lambda row: (row["album"], row["container_key"])):
            while mode is not None and mode["album"] < album:
                mode = next(modes, None)
            while witness is not None and (witness["album"], witness["container"]) < (album, container):
                witness = next(witnesses, None)
            has_witness = witness is not None and (witness["album"], witness["container"]) == (album, container)
            any_exact = mode["exact"]
            for row in rows:
                qualifies = row["exact"] if any_exact else row["fallback"] or has_witness
                if qualifies:
                    source_year = row["exact_year"] if any_exact else row["source_year"]
                    source_keys = [(album, "all", "")]
                    if source_year is not None:
                        source_keys.append((album, "year", str(source_year)))
                    for source_key in source_keys:
                        decisions.add((*source_key, 0), {"key": source_key, "fallback": not any_exact})
        companion_join = spool()
        for _target, records in itertools.groupby(targets.values(), key=lambda row: (*row["key"], row["projection"])):
            row = next(records)
            decisions.add((*row["key"], 1, row["projection"]), {"key": row["key"], "row": row})
            companion_join.add((*row["key"], 0, row["projection"]), {"key": row["key"], "projection": row["projection"]})
        for _key, rows in itertools.groupby(decisions.values(), key=lambda row: row["key"]):
            qualifies = fallback = False
            for decision in rows:
                if "row" not in decision:
                    qualifies = True
                    fallback = decision["fallback"]
                    continue
                if qualifies:
                    row = decision["row"]
                    fact = {
                        "projection_id": row["projection"],
                        "semantic_child_identity": _problematic_fact_identity("topology", row["album"], row["projection"]),
                        "fallback_unsplit": fallback and not row["split"],
                    }
                    output.add((row["projection"], "duplicate_topology", fact["semantic_child_identity"]),
                               [0, "duplicate_topology", fact])
        for companion in external_companions.values():
            album = companion["original_album_key"]
            year = str(companion["identity"][2])
            for companion_key in ([album, "all", ""], [album, "year", year]):
                companion_join.add((*companion_key, 1, companion["file_id"]),
                                   {"key": companion_key, "companion": companion})
        for _target, records in itertools.groupby(companion_join.values(), key=lambda row: row["key"]):
            with _ProblematicSortedSearchValues(work=work) as projections:
                for record in records:
                    if "projection" in record:
                        projections.add((record["projection"],), record["projection"])
                        continue
                    companion = record["companion"]
                    for projection in projections.values():
                        root_id, category = companion["root_id"], companion["category"]
                        emit(0, "duplicate_companion", {
                            "projection_id": projection,
                            "semantic_child_identity": _problematic_fact_identity("duplicate_companion",
                                companion["file_id"], companion["path"].casefold(), root_id, category),
                            "companion_file_id": companion["file_id"], "companion_private_path": companion["path"],
                            "companion_library_root_id": root_id, "companion_root_category": category,
                        })
                        emit(0, "duplicate_root", {
                            "projection_id": projection,
                            "semantic_child_identity": _problematic_fact_identity("duplicate_root", root_id, category),
                            "root_id": root_id, "category": category, "primary": False,
                        })
        work(force=True)
        yield output.values()
    except BaseException as error:
        try:
            stack.close()
        except BaseException as cleanup_error:
            error.add_note(f"topology cleanup failed: {cleanup_error!r}")
        raise
    else:
        stack.close()


class _ProblematicSearchFactStream(Iterator[Mapping[str, object]]):
    """Own complete chunks independently of the reducer's reason resources."""

    def __init__(self, item_key: str, parts: Iterable[str]) -> None:
        self._file = tempfile.SpooledTemporaryFile(
            max_size=_MAX_REDUCER_FACT_BYTES, mode="w+t", encoding="utf-8", newline="\n",
        )
        self._item_key = item_key
        self._index = 0
        self.count = 0
        self.prefix = ""
        self.byte_count = 0
        self.digest = hashlib.sha256()

        def measured_parts() -> Iterator[str]:
            for part in parts:
                normalized = part.lower()
                encoded = normalized.encode("utf-8")
                self.byte_count += len(encoded)
                self.digest.update(encoded)
                yield normalized

        try:
            for chunk in _problematic_search_chunks(measured_parts()):
                if self.count == 0:
                    self.prefix = chunk
                self._file.write(json.dumps(chunk, ensure_ascii=False) + "\n")
                self.count += 1
            self._file.seek(0)
        except BaseException as error:
            try:
                self.close()
            except BaseException as cleanup_error:
                error.add_note(f"search stream cleanup failed: {cleanup_error!r}")
            raise

    @property
    def closed(self) -> bool:
        return self._file.closed

    def __iter__(self) -> "_ProblematicSearchFactStream":
        return self

    def __next__(self) -> Mapping[str, object]:
        if self.closed:
            raise StopIteration
        try:
            line = self._file.readline()
            if not line:
                self.close()
                raise StopIteration
            fact = {
                "item_key": self._item_key,
                "fact_kind": "main_search",
                "semantic_child_identity": f"{self._index:020d}",
                "normalized_text": json.loads(line),
            }
            self._index += 1
            return fact
        except BaseException as error:
            try:
                self.close()
            except BaseException as cleanup_error:
                error.add_note(f"search stream cleanup failed: {cleanup_error!r}")
            raise

    def close(self) -> None:
        self._file.close()


class _ProblematicItemReducer:
    """Reduce one repository-ordered projection identity without retaining rows."""

    def __init__(self, projection_id: str) -> None:
        self.projection_id = projection_id
        self.summary: dict[str, object] | None = None
        self.seed_row: Mapping[str, object] | None = None
        self.path_count = 0
        self.album_value_count = 0
        self.artist_value_count = 0
        self.valid_year_count = 0
        self.raw_year_count = 0
        self.track_order_reasons: list[str] = []
        self.track_order_disc_count = 0
        self.track_order_missing_count = 0
        self._track_order_reason_count = 0
        self._track_order_reason_file = tempfile.SpooledTemporaryFile(
            max_size=_MAX_REDUCER_FACT_BYTES,
            mode="w+t",
            encoding="utf-8",
            newline="\n",
        )
        self._track_disc: int | None = None
        self._track_number = 0
        self._track_missing_ranges: list[tuple[int, int]] = []
        self._previous_grouped_track_identity: str | None = None
        self.has_duplicate_files = False
        self._featured_artist_facts = _BoundedFactValues()
        self._ignored_repair_facts = _SpooledIgnoredRepairMembership()
        self._track_title_facts = _BoundedFactValues()
        self._private_path_facts = _BoundedFactValues()
        self._search_rows = _ProblematicSortedSearchValues()
        self._duplicate_topology = _BoundedDuplicateTopology()

    def _flush_track_order_reason(self) -> None:
        if self._track_missing_ranges and self._track_disc is not None:
            missing_count = _track_order_missing_count(self._track_missing_ranges)
            self.track_order_disc_count += 1
            self.track_order_missing_count += missing_count
            missing_numbers = (
                None
                if _missing_track_ranges_need_compaction(
                    self._track_missing_ranges
                )
                else _expanded_missing_track_numbers(self._track_missing_ranges)
            )
            issue: dict[str, object]
            if missing_numbers is not None:
                issue = {
                    "disc_number": self._track_disc,
                    "missing_track_numbers": missing_numbers,
                }
            else:
                issue = {
                    "disc_number": self._track_disc,
                    "missing_track_ranges": tuple(
                        self._track_missing_ranges
                    ),
                    "missing_track_count": missing_count,
                }
            reason = _track_order_issue_reason(issue)
            self._track_order_reason_count += 1
            self._track_order_reason_file.write(
                f"{json.dumps(reason, ensure_ascii=False, separators=(',', ':'))}\n"
            )
            if len(self.track_order_reasons) < _MAX_DISPLAY_REASONS:
                self.track_order_reasons.append(reason)
        self._track_missing_ranges = []

    @staticmethod
    def _needs_row_projection(row: Mapping[str, object]) -> bool:
        entry = _mapping(row.get("file_entry"))
        raw_year = str(entry.get("year") or "").strip()
        return (
            not str(entry.get("title", row.get("track_title")) or "").strip()
            or not str(entry.get("artist", row.get("artist_name")) or "").strip()
            or not str(entry.get("album") or "").strip()
            or _track_number_problem(
                entry.get("track_number", row.get("track_number"))
            ) is not None
            or _positive_track_number(
                entry.get("disc_number", row.get("disc_number"))
            ) is None
            or _coerce_int(row.get("duration_seconds")) <= 0
            or row.get("file_size") == 0
            or row.get("file_mixed_album_folder") is True
            or bool(row.get("local_album_membership_problem"))
            or row.get("file_text_mojibake_candidate") is True
            or bool(raw_year and not raw_year.isdigit())
        )

    def _consume_row(self, row: Mapping[str, object]) -> None:
        row = dict(row)
        path = str(row.get("file_private_path") or "").strip()
        if path:
            self._search_rows.add((path, self.path_count), {"position": self.path_count, "row": row})
        if self._featured_artist_facts.count:
            names = sorted(
                self._featured_artist_facts.values(), key=str.casefold
            )
            row["album_featured_artist_names"] = names
            if not str(row.get("artist_name") or "").strip():
                row["artist_name"] = ", ".join(names)
        self._ignored_repair_facts.add_row_values(
            _row_string_list(row.get("ignored_repair_keys"))
        )
        if self._ignored_repair_facts:
            row["ignored_repair_keys"] = self._ignored_repair_facts
        if self.seed_row is None:
            self.seed_row = row
        # SQL candidates stay provisional until bounded topology facts prove a copy.
        self.has_duplicate_files = bool(
            self.has_duplicate_files
            or _coerce_int(row.get("duplicate_companion_count")) > 0
        )

        if self.summary is None or self._needs_row_projection(row):
            projected = project_problematic_files((row,))
            if projected:
                row_summary = dict(projected[0])
                row_summary["problem_reasons"] = [
                    reason
                    for reason in row_summary.get("problem_reasons") or []
                    if not str(reason).startswith("Incomplete track order:")
                ]
                row_summary["issue_count"] = len(row_summary["problem_reasons"])
                if self.summary is None:
                    self.summary = row_summary
                else:
                    reasons = list(self.summary.get("problem_reasons") or [])
                    reasons.extend(
                        reason
                        for reason in row_summary.get("problem_reasons") or []
                        if reason not in reasons
                    )
                    self.summary["problem_reasons"] = reasons
                    self.summary["has_encoding_repairs"] = bool(
                        self.summary.get("has_encoding_repairs")
                        or row_summary.get("has_encoding_repairs")
                    )

    def consume(self, fact_kind: str, fact: Mapping[str, object]) -> None:
        if fact_kind == "duplicate_topology":
            self.has_duplicate_files = True
            return
        if fact_kind == "row":
            try:
                self.path_count += 1
                self._consume_row(fact)
            except BaseException:
                self.close()
                raise
            return
        if fact_kind == "track_key":
            grouped_track_identity = str(
                fact.get("grouped_track_identity") or ""
            ).strip()
            if not grouped_track_identity:
                return
            if grouped_track_identity == self._previous_grouped_track_identity:
                self.has_duplicate_files = True
            self._previous_grouped_track_identity = grouped_track_identity
            return
        if fact_kind == "duplicate_companion":
            self.has_duplicate_files = True
            self._duplicate_topology.add_companion(fact)
            return
        if fact_kind == "duplicate_root":
            add_root = (
                self._duplicate_topology.add_primary_source
                if fact.get("primary") is True
                else self._duplicate_topology.add_source
            )
            add_root(root_id=fact.get("root_id"), category=fact.get("category"))
            return
        if fact_kind == "track_title":
            title = str(fact.get("title") or "").strip()
            if title:
                self._track_title_facts.add(title)
            return
        if fact_kind == "private_path":
            path = str(fact.get("path") or "").strip()
            if path:
                self._private_path_facts.add(path)
            return
        if fact_kind in (
            "track_title_search",
            "private_path_search",
            "private_path_locator",
            "album_title_search",
            "album_artist_search",
            "album_key_search",
        ):
            return
        if fact_kind == "duplicate_lookup":
            return
        if fact_kind == "featured_artist":
            name = str(fact.get("name") or "").strip()
            if name:
                self._featured_artist_facts.add(name)
            return
        if fact_kind == "ignored_repair":
            repair_hash = str(fact.get("repair_hash") or "").strip()
            if repair_hash:
                self._ignored_repair_facts.add_identity(repair_hash)
                return
            repair_key = str(fact.get("repair_key") or "").strip()
            if repair_key:
                self._ignored_repair_facts.add(repair_key)
            return
        if fact_kind == "album_value":
            self.album_value_count += 1
            return
        if fact_kind == "artist_value":
            self.artist_value_count += 1
            return
        if fact_kind == "raw_year":
            self.raw_year_count += 1
            return
        if fact_kind == "valid_year":
            self.valid_year_count += 1
            return
        if fact_kind != "track_number":
            raise ValueError(f"unknown problematic projection fact kind: {fact_kind}")
        disc_number = _positive_track_number(fact.get("disc_number")) or 1
        track_number = _valid_track_order_number(fact.get("track_number"))
        if track_number is None:
            return
        if self._track_disc != disc_number:
            self._flush_track_order_reason()
            self._track_disc = disc_number
            self._track_number = 0
        if track_number > self._track_number + 1:
            first_missing = self._track_number + 1
            last_missing = track_number - 1
            self._track_missing_ranges.append((first_missing, last_missing))
        self._track_number = track_number

    def close(self) -> None:
        failure: BaseException | None = None
        for owner in (self._track_order_reason_file, self._ignored_repair_facts, self._search_rows):
            try:
                owner.close()
            except BaseException as error:
                if failure is None:
                    failure = error
                else:
                    failure.add_note(f"reducer cleanup failed: {error!r}")
        if failure is not None:
            raise failure

    def _build_search_facts(self, reasons: Iterable[str]) -> _ProblematicSearchFactStream:
        search_facts: _ProblematicSearchFactStream | None = None
        try:
            with _ProblematicSortedSearchValues() as tracks, _ProblematicSortedSearchValues() as repairs:
                previous_path = None
                first_raw_fields: dict[str, tuple[tuple[object, ...], str]] = {}
                for source in self._search_rows.values():
                    row = source["row"]
                    position = source["position"]
                    path = str(row.get("file_private_path") or "").strip()
                    if path == previous_path:
                        continue
                    previous_path = path
                    entry = _problematic_file_entry_from_row(row)
                    title = str(row.get("track_title") or "").strip()
                    tracks.add((
                        row.get("disc_number") is None,
                        _coerce_int_or_default(row.get("disc_number"), 0),
                        row.get("track_number") is None,
                        _coerce_int_or_default(row.get("track_number"), 0),
                        title.casefold(), path.casefold(), position,
                    ), title)
                    file_order = (path.casefold(), position)
                    for target, field_name in (("raw_name", "album"), ("raw_album_artist", "album_artist")):
                        value = str(entry.get(field_name) or "").strip()
                        if value and (target not in first_raw_fields or file_order < first_raw_fields[target][0]):
                            first_raw_fields[target] = (file_order, value)
                    preview = _problematic_encoding_repair_preview({
                        "_file_entries": [entry],
                        "_ignored_repair_keys": self._ignored_repair_facts,
                    }, include_preview_rows=True)
                    for repair in preview["preview_rows"]:
                        repairs.add((
                            str(repair["track_title"]).casefold(), repair["field"],
                            str(repair["original"]).casefold(), *file_order,
                        ), (repair["track_title"], repair["original"], repair["repaired"]))
                for target, fallback in (("raw_name", "name"), ("raw_album_artist", "album_artist")):
                    self.summary[target] = first_raw_fields[target][1] if target in first_raw_fields else self.summary.get(fallback, "")

                def parts() -> Iterator[str]:
                    values = [self.summary.get(field_name) for field_name in (
                        "name", "raw_name", "album_artist", "raw_album_artist", "year",
                    )]
                    for index, value in enumerate(itertools.chain(values, reasons)):
                        if index:
                            yield "\n"
                        yield str(value or "")
                    yield "\n"
                    first_title = True
                    for title in tracks.values():
                        if not title.strip():
                            continue
                        if not first_title:
                            yield "\n"
                        yield title
                        first_title = False
                    for title in tracks.values():
                        yield "\n"
                        yield title
                    for repair_values in repairs.values():
                        for value in repair_values:
                            yield "\n"
                            yield str(value or "")

                search_facts = _ProblematicSearchFactStream(self.projection_id, parts())
        except BaseException as error:
            if search_facts is not None:
                try:
                    search_facts.close()
                except BaseException as cleanup_error:
                    error.add_note(f"search stream cleanup failed: {cleanup_error!r}")
            raise
        return search_facts

    def finish(self) -> ProblematicProjectedItem | None:
        self._flush_track_order_reason()
        is_missing = (self.seed_row or {}).get("inventory_status") == "missing"
        album_reasons: list[str] = []
        if self.has_duplicate_files:
            album_reasons.append("Duplicate files")
        if self.album_value_count > 1:
            album_reasons.append("Album name mismatch")
        if self.artist_value_count > 1 and not bool(
            _problematic_album_metadata_from_row(self.seed_row or {}).get("is_compilation")
        ):
            album_reasons.append("Album artist mismatch")
        if self.valid_year_count > 1:
            album_reasons.append("Year mismatch")
        elif self.raw_year_count > 1 and self.valid_year_count == 0:
            album_reasons.append("Inconsistent year")
        if is_missing:
            album_reasons = []
        track_order_reasons = self.track_order_reasons

        all_cross_reasons = [*album_reasons, *track_order_reasons]
        if self.summary is None and all_cross_reasons and self.seed_row is not None:
            albums = project_problematic_albums((self.seed_row,))
            if albums:
                album = albums[0]
                self.summary = build_problematic_summary(
                    album,
                    reasons=all_cross_reasons,
                    repair_preview=_problematic_encoding_repair_preview(
                        album, include_preview_rows=False
                    ),
                )
        if self.summary is None:
            self.close()
            return None
        reasons = list(self.summary.get("problem_reasons") or [])
        seed_album_reasons: set[str] = set()
        if self.seed_row is not None:
            seed_albums = project_problematic_albums((self.seed_row,))
            if seed_albums:
                seed_album_reasons.update(
                    _problematic_album_scope_reasons(seed_albums[0])
                )
        first_track_reason = next(
            (
                index
                for index, reason in enumerate(reasons)
                if reason not in seed_album_reasons
            ),
            len(reasons),
        )
        for reason in reversed(album_reasons):
            if reason not in reasons:
                reasons.insert(first_track_reason, reason)
        exact_non_track_reasons = tuple(reasons)
        if not exact_non_track_reasons and self._track_order_reason_count == 0:
            self.close()
            return None
        display_reasons = [*exact_non_track_reasons, *track_order_reasons][
            :_MAX_DISPLAY_REASONS
        ]
        self.summary["problem_reasons"] = display_reasons
        self.summary["issue_count"] = (
            len(exact_non_track_reasons) + self._track_order_reason_count
        )
        self.summary["track_count"] = 0 if is_missing else self.path_count
        self.summary["projection_id"] = self.projection_id
        self.summary["search_text"] = "\n".join(self._track_title_facts.values())
        self.summary["track_paths"] = [] if is_missing else self._private_path_facts.values()
        self.summary["search_fact_count"] = self._track_title_facts.count
        self.summary["search_fact_digest"] = self._track_title_facts.digest.hexdigest()
        self.summary["search_facts_truncated"] = self._track_title_facts.truncated
        self.summary["track_path_fact_count"] = self._private_path_facts.count
        self.summary["track_path_fact_digest"] = self._private_path_facts.digest.hexdigest()
        self.summary["track_path_facts_truncated"] = self._private_path_facts.truncated
        self._duplicate_topology.apply(self.summary)
        # The canonical summary omits provenance; domain/detail own its full value.
        self.summary.pop("root_provenance", None)
        for compatibility_field in ("file_types",):
            self.summary.pop(compatibility_field, None)
        def search_reasons() -> Iterator[str]:
            yield from exact_non_track_reasons
            self._track_order_reason_file.seek(0)
            for line in self._track_order_reason_file:
                yield str(json.loads(line))

        try:
            search_facts = self._build_search_facts(search_reasons())
        except BaseException:
            self.close()
            raise
        try:
            item = _persisted_problematic_item(self.summary)
            item["search_text"] = search_facts.prefix
            item["search_document_count"] = search_facts.count
            item["search_document_digest"] = search_facts.digest.hexdigest()
            item["search_document_truncated"] = search_facts.byte_count > _MAX_SEARCH_DOCUMENT_BYTES
        except BaseException:
            search_facts.close()
            raise
        item_key = str(item.get("item_key") or "")

        def reason_facts() -> Iterable[ProblematicProjectionReasonFact]:
            try:
                for reason in exact_non_track_reasons:
                    category_reason = normalize_problematic_reason(reason)
                    yield ProblematicProjectionReasonFact(
                        item_key=item_key,
                        normalized_reason=normalize_problematic_text(category_reason),
                        display_reason=reason,
                        category_reason=category_reason,
                    )
                self._track_order_reason_file.seek(0)
                for line in self._track_order_reason_file:
                    reason = str(json.loads(line))
                    category_reason = normalize_problematic_reason(reason)
                    yield ProblematicProjectionReasonFact(
                        item_key=item_key,
                        normalized_reason=normalize_problematic_text(category_reason),
                        display_reason=reason,
                        category_reason=category_reason,
                    )
            finally:
                self.close()

        return ProblematicProjectedItem(
            item=item,
            reason_facts=_ProblematicReasonFactStream(
                reason_facts(), self.close
            ),
            search_facts=search_facts,
        )


def _problematic_topology_entry(row: Mapping[str, object]) -> dict[str, object]:
    entry = _problematic_file_entry_from_row(row)
    entry["duration_seconds"] = _coerce_duration_seconds(row.get("duration_seconds"))
    if row.get("file_entry_is_object") is not True and not _row_json_mapping(row.get("file_entry")):
        entry.update(album=None, album_artist=None, year=None)
    return entry


def _problematic_topology_node_identity(key) -> str:
    return hashlib.sha256(json.dumps(key, ensure_ascii=False, separators=(", ", ": ")).encode("utf-8")).hexdigest()


def _problematic_topology_seed(row: Mapping[str, object]) -> dict[str, object] | None:
    from music_app.services.library import (
        _duplicate_album_identity_values, _numeric_album_container_candidate,
        _track_album_container,
    )

    file_id = row.get("file_id")
    album_key = str(row.get("album_key") or "")
    if not file_id:
        return None
    entry = _problematic_topology_entry(row)
    path = str(entry.get("path") or "")
    physical_container = os.path.normcase(_track_album_container(path)) if path else None
    if (not album_key or not path or normalize_exception_value(entry.get("exception_type"))
            or str(entry.get("local_album_membership_problem") or "").strip()):
        return {"file_id": file_id, "original_album_key": album_key,
                "path": path, "excluded": True, "physical_container": physical_container}
    numeric = _numeric_album_container_candidate(
        path, entry.get("disc_number"), entry.get("album"), entry.get("edition")
    )
    return {
        "file_id": file_id, "original_album_key": album_key, "path": path,
        "excluded": False,
        "physical_container": physical_container,
        "identity": _duplicate_album_identity_values(
            entry.get("album_artist"), entry.get("album"), entry.get("year")
        ),
        "default_container": os.path.normcase(_track_album_container(path)),
        "numeric_bucket": [album_key, *numeric[0]] if numeric is not None else None,
        "numeric_parent": numeric[4] if numeric is not None else None,
    }


def _prepare_problematic_topology_parent_partition(entries, parent, *, check_stop=None, work=None):
    """Classify each unique persisted parent input once into an indexed bucket."""
    from music_app.services.library import _numeric_album_container_candidate

    work = work or _problematic_topology_work(check_stop)
    work(force=True)
    for stage_id, row in entries:
        work(len(json.dumps(row, ensure_ascii=False).encode("utf-8")))
        entry = _problematic_topology_entry(row)
        seed = _problematic_topology_seed(row)
        if seed is None:
            raise ValueError("topology parent input lacks file identity")
        candidate = _numeric_album_container_candidate(
            entry.get("path"), entry.get("disc_number"), entry.get("album"), entry.get("edition")
        )
        excluded = seed["excluded"] or candidate is None or candidate[0][0] != parent
        key = ["bucket", seed["original_album_key"], *candidate[0]] if candidate is not None else None
        yield stage_id, "topology_parent_partition", {
            "projection_id": _problematic_topology_node_identity(key) if key is not None else "excluded",
            "semantic_child_identity": f"{int(seed['file_id']):020d}",
            "file_id": seed["file_id"], "source_stage_id": stage_id, "excluded": bool(excluded), "key": key,
            "folder": os.path.basename(candidate[1]) if candidate is not None else None,
            "ordinal": candidate[2] if candidate is not None else None,
            "matches": candidate[3] if candidate is not None else False,
        }
    work(force=True)


def _derive_problematic_topology_numeric_bucket(entries, key, *, previous=None, check_stop=None, work=None):
    work = work or _problematic_topology_work(check_stop)
    previous = previous or {}
    work(force=True)
    count = _coerce_int(previous.get("input_count"))
    last_stage = pending = 0
    first_folder, first_ordinal = previous.get("first_folder"), previous.get("first_ordinal")
    different_folder, different_ordinal = bool(previous.get("different_folder")), bool(previous.get("different_ordinal"))
    matches = previous.get("matches", True) is True

    def result(complete):
        return last_stage, "topology_numeric_bucket_result", {
            "projection_id": "topology", "semantic_child_identity": "result", "key": key,
            "input_count": count, "collapse": bool(different_folder and different_ordinal and matches),
            "first_folder": first_folder, "first_ordinal": first_ordinal,
            "different_folder": different_folder, "different_ordinal": different_ordinal,
            "matches": matches, "complete": complete,
        }

    for stage_id, row in entries:
        work(len(json.dumps(row, ensure_ascii=False).encode("utf-8")))
        count += 1
        pending += 1
        last_stage = max(last_stage, stage_id)
        if row.get("key") != key:
            raise ValueError("topology bucket input key differs")
        if not row.get("excluded"):
            folder, ordinal = row["folder"], row["ordinal"]
            first_folder = folder if first_folder is None else first_folder
            first_ordinal = ordinal if first_ordinal is None else first_ordinal
            different_folder |= folder != first_folder
            different_ordinal |= ordinal != first_ordinal
            matches &= row["matches"] is True
        if pending == 100:
            yield result(False)
            pending = 0
    work(force=True)
    yield result(True)


def _derive_problematic_topology_own_rank(entries, key, *, previous=None, check_stop=None, work=None):
    """Checkpoint the exact Python first-prepared-path scalar without sorting rows."""
    work = work or _problematic_topology_work(check_stop)
    previous = previous or {}
    rank = previous.get("rank")
    count = _coerce_int(previous.get("input_count"))
    last_stage = pending = 0

    def result():
        return last_stage, "topology_own_rank_result", {
            "projection_id": "topology", "semantic_child_identity": "result",
            "key": key, "rank": rank, "input_count": count,
        }

    work(force=True)
    for stage_id, row in entries:
        work(len(json.dumps(row, ensure_ascii=False).encode("utf-8")))
        count += 1
        pending += 1
        last_stage = stage_id
        if str(row.get("album_key") or "") != key[1]:
            raise ValueError("topology own rank input album differs")
        seed = _problematic_topology_seed(row)
        if seed is None:
            raise ValueError("topology own rank input lacks file identity")
        if not seed["excluded"]:
            path = seed["path"]
            candidate = [path.casefold(), path, key[1]]
            if rank is None or candidate < rank:
                rank = candidate
        if pending == 100:
            yield result()
            pending = 0
    if pending or count == 0:
        yield result()
    work(force=True)


def _derive_problematic_topology_address(entries, key, numeric_decisions, own_ranks, *, check_stop=None, work=None):
    """Reduce one complete address using sealed numeric and original-album scalars."""
    from music_app.services.library import (
        _duplicate_album_identity_values, _numeric_album_container_candidate, _track_album_container,
    )

    work = work or _problematic_topology_work(check_stop)
    with ExitStack() as stack:
        def spool():
            return stack.enter_context(_ProblematicSortedSearchValues(work=work))

        prepared, numeric, mapped, decisions, ranks, winners, members, folders = [spool() for _ in range(8)]
        input_count = last_stage = 0
        work(force=True)
        for stage_id, row in entries:
            work(len(json.dumps(row, ensure_ascii=False).encode("utf-8")))
            input_count += 1
            last_stage = max(last_stage, stage_id)
            folders.add((_coerce_int(row.get("file_library_root_id")), str(row.get("file_physical_parent") or "")),
                        {"album_id": row.get("album_id"), "root_id": _coerce_int(row.get("file_library_root_id")),
                         "physical_parent": str(row.get("file_physical_parent") or "")})
            seed = _problematic_topology_seed(row)
            if seed is None:
                raise ValueError("topology address input lacks file identity")
            if seed["excluded"]:
                continue
            path, album = seed["path"], seed["original_album_key"]
            prepared.add((album, path.casefold(), path, stage_id), {
                "stage_id": stage_id, "payload": row, "entry": _problematic_topology_entry(row),
                "path": path, "album": album,
            })
        for folder, rows in itertools.groupby(folders.values(), key=lambda value: (value["root_id"], value["physical_parent"])):
            first_album = None
            mixed = False
            count = 0
            for row in rows:
                count += 1
                if row["album_id"] is not None:
                    if first_album is None:
                        first_album = row["album_id"]
                    mixed |= row["album_id"] != first_album
            yield last_stage, "topology_folder_status", {
                "projection_id": "topology", "semantic_child_identity": _problematic_topology_node_identity(list(folder)),
                "root_id": folder[0], "physical_parent": folder[1], "input_count": count, "mixed": mixed,
            }
        previous = None
        for row in prepared.values():
            path_key = (row["album"], row["path"])
            if path_key == previous:
                continue
            previous = path_key
            entry = row["entry"]
            candidate = _numeric_album_container_candidate(
                row["path"], entry.get("disc_number"), entry.get("album"), entry.get("edition")
            )
            row["container"] = _track_album_container(row["path"])
            if candidate is None:
                if os.path.normcase(row["container"]) == key[1]:
                    mapped.add((row["album"], row["path"]), row)
            else:
                row["bucket"] = ["bucket", row["album"], *candidate[0]]
                row["parent"] = candidate[4]
                numeric.add((*row["bucket"], row["path"]), row)
        for decision in numeric_decisions:
            decisions.add(tuple(decision["key"]), decision)
        decision_stream = iter(decisions.values())
        decision = next(decision_stream, None)
        for bucket, rows in itertools.groupby(numeric.values(), key=lambda row: row["bucket"]):
            while decision is not None and decision["key"] < bucket:
                decision = next(decision_stream, None)
            if decision is None or decision["key"] != bucket or type(decision.get("collapse")) is not bool:
                raise ValueError("topology address lacks sealed numeric decision")
            for row in rows:
                if decision["collapse"]:
                    row["container"] = row["parent"]
                if os.path.normcase(row["container"]) == key[1]:
                    mapped.add((row["album"], row["path"]), row)
        for rank in own_ranks:
            ranks.add((rank["key"][1],), rank)
        rank_stream = iter(ranks.values())
        rank = next(rank_stream, None)
        for album, rows in itertools.groupby(mapped.values(), key=lambda row: row["album"]):
            while rank is not None and rank["key"][1] < album:
                rank = next(rank_stream, None)
            if rank is None or rank["key"][1] != album or rank.get("rank") is None:
                raise ValueError("topology address lacks sealed original-album rank")
            if rank["rank"][2] != album:
                raise ValueError("topology original-album rank key differs")
            for row in rows:
                winners.add((os.path.normcase(row["path"]), rank["rank"], row["path"].casefold(), row["path"]), row)
        identity = None
        clean = True
        member_count = member_fingerprint = 0
        for _path, versions in itertools.groupby(winners.values(), key=lambda row: os.path.normcase(row["path"])):
            winner = None
            for winner in versions:
                work()
            entry = winner["entry"]
            value = _duplicate_album_identity_values(entry.get("album_artist"), entry.get("album"), entry.get("year"))
            value = list(value) if value is not None else None
            identity = value if member_count == 0 else identity
            clean &= value is not None and value == identity
            payload = winner["payload"]
            file_id = int(payload["file_id"])
            member_count += 1
            member_fingerprint ^= int(_problematic_topology_node_identity([file_id, winner["path"]]), 16)
            member = {"projection_id": "topology", "semantic_child_identity": f"{file_id:020d}",
                      "file_id": file_id, "path": winner["path"], "source_stage_id": winner["stage_id"],
                      "root_id": payload.get("file_library_root_id"), "category": payload.get("file_library_root_category")}
            members.add((winner["stage_id"], file_id), [winner["stage_id"], "topology_address_member", member])
        yield from members.values()
        yield last_stage, "topology_address_result", {
            "projection_id": "topology", "semantic_child_identity": "result", "key": key,
            "input_count": input_count, "status": "EMPTY" if member_count == 0 else "CLEAN" if clean else "MIXED",
            "identity": identity if clean and member_count else None,
            "member_count": member_count, "member_fingerprint": f"{member_fingerprint:0256b}",
        }
        work(force=True)
class ProblematicGroupAccumulator:
    """Scalar progress whose row-derived facts are persisted separately."""

    def __init__(
        self,
        *,
        after_stage_id: int = 0,
        next_batch_index: int = 0,
        row_count: int = 0,
    ) -> None:
        self._after_stage_id = int(after_stage_id)
        self._next_batch_index = int(next_batch_index)
        self._row_count = int(row_count)

    @classmethod
    def from_checkpoint(cls, checkpoint: object) -> "ProblematicGroupAccumulator":
        return cls(
            after_stage_id=int(getattr(checkpoint, "after_stage_id", 0)),
            next_batch_index=int(getattr(checkpoint, "next_batch_index", 0)),
            row_count=int(getattr(checkpoint, "row_count", 0)),
        )

    def consume(
        self,
        entries: Iterable[tuple[int, Mapping[str, object]]],
    ) -> Iterable[tuple[int, str, dict[str, object]]]:
        for stage_id, payload in entries:
            normalized_stage_id = int(stage_id)
            if normalized_stage_id <= self._after_stage_id:
                raise ValueError("problematic projection stage order regressed")
            projection_id = str(payload.get("projection_id") or "").strip()
            if not projection_id:
                projection_id = problematic_projection_id(payload)

            def fact(
                fact_kind: str,
                semantic_identity: str,
                values: Mapping[str, object],
            ) -> tuple[int, str, dict[str, object]]:
                return normalized_stage_id, fact_kind, {
                    **values,
                    "projection_id": projection_id,
                    "semantic_child_identity": semantic_identity,
                }

            if payload.get("source_child_kind") == "featured_artist":
                name = str(payload.get("featured_artist_name") or "").strip()
                if name:
                    yield fact(
                        "featured_artist",
                        _problematic_fact_identity(
                        "featured_artist", normalize_problematic_text(name)
                        ),
                        {"name": name},
                    )
            elif payload.get("source_child_kind") == "ignored_repair":
                repair_hash = str(
                    payload.get("ignored_repair_hash") or ""
                ).strip()
                if repair_hash:
                    yield fact(
                        "ignored_repair",
                        repair_hash,
                        {"repair_hash": repair_hash},
                    )
                    continue
                repair_key = str(payload.get("ignored_repair_key") or "").strip()
                if repair_key:
                    yield fact(
                        "ignored_repair",
                        _problematic_ignored_repair_identity(repair_key),
                        {"repair_key": repair_key},
                    )
            elif payload.get("source_child_kind") == "duplicate_companion":
                companion_values = {
                    "companion_file_id": payload.get("companion_file_id"),
                    "companion_private_path": payload.get("companion_private_path"),
                    "companion_library_root_id": payload.get(
                        "companion_library_root_id"
                    ),
                    "companion_root_category": payload.get(
                        "companion_root_category"
                    ),
                }
                yield fact(
                    "duplicate_companion",
                    _problematic_fact_identity(
                        "duplicate_companion",
                    companion_values["companion_file_id"],
                    str(companion_values["companion_private_path"] or "").casefold(),
                    companion_values["companion_library_root_id"],
                    companion_values["companion_root_category"],
                    ),
                companion_values,
                )
                yield fact(
                    "duplicate_root",
                    _problematic_fact_identity(
                        "duplicate_root",
                        companion_values["companion_library_root_id"],
                        companion_values["companion_root_category"],
                    ),
                    {
                        "root_id": companion_values["companion_library_root_id"],
                        "category": companion_values["companion_root_category"],
                        "primary": False,
                    },
                )
            else:
                entry = _mapping(payload.get("file_entry"))
                path = str(payload.get("file_private_path") or "").strip()
                row_fact = dict(payload)
                source_child_identity = str(
                    payload.get("source_child_identity") or normalized_stage_id
                )
                sortable_child_identity = (
                    f"n:{int(source_child_identity):020d}"
                    if source_child_identity.lstrip("-").isdigit()
                    else f"t:{source_child_identity}"
                )
                row_semantic_identity = (
                    f"{sortable_child_identity}:"
                    f"{_problematic_fact_identity('row', path.casefold())}"
                )
                lookup_values = {
                    "owner_file_id": payload.get("duplicate_lookup_owner_file_id"),
                    "owner_track_id": payload.get("duplicate_lookup_owner_track_id"),
                    "library_root_id": payload.get("file_library_root_id"),
                    "album_artist_identity": payload.get(
                        "duplicate_lookup_album_artist_identity"
                    ),
                    "album_identity": payload.get("duplicate_lookup_album_identity"),
                    "year_identity": payload.get("duplicate_lookup_year_identity"),
                    "physical_album_container": payload.get(
                        "duplicate_lookup_physical_album_container"
                    ),
                }
                if payload.get("projection_owner_album_id") is not None and all(
                    value not in (None, "") for value in lookup_values.values()
                ):
                    yield fact(
                        "duplicate_lookup",
                        _problematic_fact_identity(
                            "duplicate_lookup", *lookup_values.values()
                        ),
                        lookup_values,
                    )
                yield fact(
                    "row",
                    row_semantic_identity,
                    row_fact,
                )
                topology_seed = _problematic_topology_seed(payload)
                if topology_seed is not None:
                    yield fact("topology_seed", row_semantic_identity, topology_seed)
                track_key = str(payload.get("track_key") or "").strip()
                if track_key:
                    yield fact(
                        "track_key",
                        (
                            f"{_problematic_fact_identity('track_key', track_key)}:"
                            f"{_problematic_fact_identity('row', path)}"
                        ),
                        {"grouped_track_identity": track_key},
                    )
                title = str(
                    entry.get("title", payload.get("track_title")) or ""
                ).strip()
                if title:
                    normalized_title = normalize_problematic_text(title)
                    title_identity = _problematic_fact_identity(
                        "track_title", normalized_title
                    )
                    yield fact(
                        "track_title",
                        title_identity,
                        {"title": title},
                    )
                if path:
                    normalized_path = normalize_problematic_text(path)
                    path_identity = _problematic_fact_identity(
                        "private_path", normalized_path
                    )
                    yield fact(
                        "private_path",
                        path_identity,
                        {"path": path},
                    )
                    yield fact(
                        "private_path_locator",
                        _problematic_fact_identity("private_path_locator", path),
                        {"normalized_text": path},
                    )
                root_id = payload.get("file_library_root_id")
                root_category = payload.get("file_library_root_category")
                yield fact(
                    "duplicate_root",
                    _problematic_fact_identity(
                        "duplicate_root", root_id, root_category
                    ),
                    {
                        "root_id": root_id,
                        "category": root_category,
                        "primary": True,
                    },
                )
                album_value = normalize_problematic_text(entry.get("album"))
                if album_value:
                    yield fact(
                        "album_value",
                        _problematic_fact_identity("album_value", album_value),
                        {"value": album_value},
                    )
                artist_value = normalize_problematic_text(entry.get("album_artist"))
                if artist_value:
                    yield fact(
                        "artist_value",
                        _problematic_fact_identity("artist_value", artist_value),
                        {"value": artist_value},
                    )
                raw_year = str(entry.get("year") or "").strip().casefold()
                if raw_year:
                    yield fact(
                        "raw_year",
                        _problematic_fact_identity("raw_year", raw_year),
                        {"value": raw_year},
                    )
                    if raw_year.isdigit():
                        yield fact(
                            "valid_year",
                            f"{int(raw_year):020d}",
                            {"value": int(raw_year)},
                        )
                order_file_entry = _problematic_file_entry_from_row(payload)
                track_number = _effective_track_order_number(
                    payload,
                    order_file_entry,
                )
                if track_number is not None and not normalize_exception_value(
                    order_file_entry.get("exception_type")
                ):
                    disc_number = (
                        _positive_track_number(payload.get("disc_number"))
                        or _positive_track_number(
                            order_file_entry.get("disc_number")
                        )
                        or 1
                    )
                    yield fact(
                        "track_number",
                        f"{disc_number:020d}:{track_number:020d}",
                        {
                            "disc_number": disc_number,
                            "track_number": track_number,
                        },
                    )
            self._after_stage_id = normalized_stage_id
            self._row_count += 1

    def checkpoint(self) -> ProblematicGroupCheckpoint:
        return ProblematicGroupCheckpoint(
            after_stage_id=self._after_stage_id,
            next_batch_index=self._next_batch_index,
            row_count=self._row_count,
        )

    def advance_batch(self) -> None:
        self._next_batch_index += 1

    def finalize(
        self,
        facts: Iterable[tuple[int, str, Mapping[str, object]]],
        *,
        check_stop: Callable[[], None] | None = None,
    ) -> Iterable[ProblematicProjectedItem]:
        with _prepared_problematic_topology(facts, check_stop=check_stop) as prepared:
            yield from self._finalize_prepared(prepared)

    def _finalize_prepared(
        self,
        facts: Iterable[tuple[int, str, Mapping[str, object]]],
    ) -> Iterable[ProblematicProjectedItem]:
        reducer: _ProblematicItemReducer | None = None
        previous_fact_key: tuple[str, str, str] | None = None
        try:
            for _stage_id, fact_kind, fact_value in facts:
                projection_id = str(fact_value.get("projection_id") or "")
                if not projection_id:
                    raise ValueError("problematic projection fact lacks projection_id")
                semantic_child_identity = str(
                    fact_value.get("semantic_child_identity") or ""
                )
                if not semantic_child_identity:
                    raise ValueError(
                        "problematic projection fact lacks semantic child identity"
                    )
                fact_key = (projection_id, fact_kind, semantic_child_identity)
                if fact_key == previous_fact_key:
                    continue
                if previous_fact_key is not None and fact_key < previous_fact_key:
                    raise ValueError("problematic projection fact order regressed")
                previous_fact_key = fact_key
                if reducer is None or projection_id != reducer.projection_id:
                    if reducer is not None:
                        projected = reducer.finish()
                        reducer = None
                        if projected is not None:
                            try:
                                yield projected
                            except BaseException as error:
                                try:
                                    projected.close()
                                except BaseException as cleanup_error:
                                    error.add_note(f"projection item cleanup failed: {cleanup_error!r}")
                                raise
                    reducer = _ProblematicItemReducer(projection_id)
                reducer.consume(fact_kind, fact_value)
            if reducer is not None:
                projected = reducer.finish()
                reducer = None
                if projected is not None:
                    try:
                        yield projected
                    except BaseException as error:
                        try:
                            projected.close()
                        except BaseException as cleanup_error:
                            error.add_note(f"projection item cleanup failed: {cleanup_error!r}")
                        raise
        finally:
            if reducer is not None:
                reducer.close()


def project_problematic_files(
    rows: Iterable[Mapping[str, object]],
) -> list[dict[str, object]]:
    summaries = [
        summary
        for album in project_problematic_albums(rows)
        if (summary := problematic_album_summary_payload(album)) is not None
    ]
    return sorted(summaries, key=problematic_sort_key)


project_problematic_files.accumulator_type = ProblematicGroupAccumulator


_problematic_album_projection_payloads = project_problematic_albums
_problematic_album_summary_payload = problematic_album_summary_payload
