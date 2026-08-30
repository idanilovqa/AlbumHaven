from __future__ import annotations

from pathlib import Path
import re
from typing import Any

from music_app.services.utility_rule_fallbacks import fallback_version_album_payload
from music_app.services.utils import looks_like_mojibake


UNKNOWN_VALUES = {"", "unknown", "unknown artist", "unknown album", "none", "null"}
COLLAB_MARKERS = ("&", "feat", "featuring", "with", "vs", " x ", "/", ";", ",")


def looks_like_collaboration_name(value: object) -> bool:
    text = " ".join(str(value or "").strip().casefold().split())
    if not text:
        return False
    return any(marker in text for marker in COLLAB_MARKERS)


def resolve_manual_version_root(album_key: str, manual_version_links: dict[str, str]) -> str:
    current = str(album_key or "").strip()
    seen = set()
    while current and current not in seen:
        seen.add(current)
        parent = str(manual_version_links.get(current, "") or "").strip()
        if not parent:
            break
        current = parent
    return current


def album_member_artists(album: object, alias_to_canonical: dict[str, str] | None = None) -> list[str]:
    alias_to_canonical = alias_to_canonical or {}
    members = list(getattr(album, "artists", []) or [])
    if not members and getattr(album, "album_artist", None):
        members = [getattr(album, "album_artist")]
    canonical_members = []
    seen = set()
    for member in members:
        artist = str(member or "").strip()
        if not artist:
            continue
        canonical = str(alias_to_canonical.get(artist, artist) or "").strip()
        if not canonical or canonical in seen:
            continue
        seen.add(canonical)
        canonical_members.append(canonical)
    return canonical_members


def albums_share_any_artist(
    album: object,
    other_album: object,
    alias_to_canonical: dict[str, str] | None = None,
) -> bool:
    left_members = set(album_member_artists(album, alias_to_canonical))
    right_members = set(album_member_artists(other_album, alias_to_canonical))
    if not left_members or not right_members:
        return False
    return bool(left_members & right_members)


def text_problem_reason(label: str, value: str, *, detect_encoding: bool = True) -> str | None:
    normalized = (value or "").strip()
    lowered = normalized.casefold()
    short_label = label.strip().casefold()
    if lowered in UNKNOWN_VALUES:
        return f"Missing {short_label}"
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
    if value <= 0:
        return "Invalid year"
    return None


def artist_alias_problem_reason(
    value: object,
    alias_to_canonical: dict[str, str] | None = None,
) -> str | None:
    raw_value = str(value or "").strip()
    if not raw_value:
        return None
    if looks_like_collaboration_name(raw_value):
        return None
    alias_to_canonical = alias_to_canonical or {}
    canonical_value = str(alias_to_canonical.get(raw_value, raw_value) or "").strip()
    if looks_like_collaboration_name(canonical_value):
        return None
    if not canonical_value or canonical_value == raw_value:
        return None
    if canonical_value.casefold() == raw_value.casefold():
        return "Artist name casing differs from canonical"
    return "Artist name variant differs from canonical"


def build_utility_rules_payload(
    *,
    config: dict[str, object],
    albums: list[object],
    file_cache: dict[str, object],
    ignored_version_keys: set[str],
    ignored_repair_keys: set[str],
    album_to_dict: Any,
    alias_to_canonical: dict[str, str] | None = None,
) -> dict[str, object]:
    _ = config
    alias_to_canonical = {
        str(alias).strip(): str(canonical).strip()
        for alias, canonical in (alias_to_canonical or {}).items()
        if str(alias).strip() and str(canonical).strip()
    }

    version_albums = []
    if ignored_version_keys:
        albums_by_key = {
            key: album_to_dict(album)
            for album in albums
            for key in [str(getattr(album, "key", ""))]
            if key and key in ignored_version_keys
        }
    else:
        albums_by_key = {}

    for key in sorted(ignored_version_keys):
        album = albums_by_key.get(key)
        if album:
            version_albums.append(album)
        else:
            version_albums.append(fallback_version_album_payload(key))

    problem_ignores = []
    for row_key in sorted(ignored_repair_keys):
        path, _, field = row_key.partition("::")
        entry = file_cache.get(path) if isinstance(file_cache, dict) else None
        album_name = str(entry.get("album") or "") if isinstance(entry, dict) else ""
        artist_name = str(entry.get("album_artist") or entry.get("artist") or "") if isinstance(entry, dict) else ""
        reason = ""
        if isinstance(entry, dict):
            if field == "year":
                reason = year_problem_reason(entry.get("year")) or ""
            elif field == "album_artist":
                reason = (
                    artist_alias_problem_reason(entry.get("album_artist"), alias_to_canonical)
                    or text_problem_reason("Album artist", str(entry.get("album_artist") or ""), detect_encoding=True)
                    or ""
                )
            elif field == "artist":
                reason = text_problem_reason("Track artist", str(entry.get("artist") or ""), detect_encoding=True) or ""
            elif field == "title":
                reason = text_problem_reason("Track title", str(entry.get("title") or ""), detect_encoding=True) or ""
            elif field == "album":
                reason = text_problem_reason("Album", str(entry.get("album") or ""), detect_encoding=True) or ""
        album_group_key = " :: ".join(part for part in [artist_name.strip(), album_name.strip()] if part) or str(Path(path).parent)
        problem_ignores.append({
            "row_key": row_key,
            "path": path,
            "filename": Path(path).name if path else row_key,
            "field": field or "problem",
            "album": album_name,
            "artist": artist_name,
            "year": str(entry.get("year") or "") if isinstance(entry, dict) else "",
            "problem_reason": reason,
            "album_group_key": album_group_key,
        })

    return {
        "ok": True,
        "rules": [{
            "key": "version-exceptions",
            "title": "Version exceptions",
            "description": "Albums that should not be counted as versions of another album with the same title.",
            "count": len(version_albums),
            "albums": version_albums,
        }, {
            "key": "problem-ignores",
            "title": "Problem ignores",
            "description": "Files marked as Not a problem in Detected Problems.",
            "count": len(problem_ignores),
            "items": problem_ignores,
        }],
        "ignored_version_keys": sorted(ignored_version_keys),
    }
