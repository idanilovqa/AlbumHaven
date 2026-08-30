from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from music_app.services.gallery_playback_context import album_can_play_in_gallery_context
from music_app.services.lastfm import get_lastfm_user_timezone
from music_app.services.listen_history import is_meaningful_listen_session, load_listen_history
from music_app.services.music_identity_matching import same_artist_identity

_RECENT_LISTEN_WINDOW = timedelta(days=7)
_SITTING_GAP = timedelta(minutes=20)


def _value(source: object, field: str, default=None):
    if isinstance(source, dict):
        return source.get(field, default)
    return getattr(source, field, default)


def _normalize_text(value: object) -> str:
    return " ".join(str(value or "").strip().split())


def _normalize_track_ref(value: object) -> str:
    return _normalize_text(value).replace("/", "\\").casefold()


def _parse_timestamp(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _entry_last_listened_at(entry: dict[str, object]) -> datetime | None:
    for field in ("recorded_at", "ended_at", "started_at"):
        parsed = _parse_timestamp(entry.get(field))
        if parsed is not None:
            return parsed
    return None


def _entry_started_at(entry: dict[str, object]) -> datetime | None:
    return _parse_timestamp(entry.get("started_at")) or _entry_last_listened_at(entry)


def _entry_ended_at(entry: dict[str, object]) -> datetime | None:
    return _parse_timestamp(entry.get("ended_at")) or _entry_last_listened_at(entry)


def _entry_source_kind(entry: dict[str, object]) -> str:
    source = entry.get("source_provenance")
    if isinstance(source, dict):
        return _normalize_text(source.get("kind")).casefold()
    return ""


def _is_local_source_entry(entry: dict[str, object]) -> bool:
    return _entry_source_kind(entry) == "local_playback"


def _album_identity_key(album: object) -> tuple[str, str]:
    return (
        _normalize_text(_value(album, "album_artist")).casefold(),
        _normalize_text(_value(album, "name")).casefold(),
    )


def _entry_album_identity(entry: dict[str, object]) -> tuple[str, str]:
    return (
        _normalize_text(entry.get("album_artist") or entry.get("artist")).casefold(),
        _normalize_text(entry.get("album")).casefold(),
    )


def _resolve_window_timezone(config: dict[str, object]) -> ZoneInfo | datetime.tzinfo:
    timezone_name = get_lastfm_user_timezone(config)
    if timezone_name:
        try:
            return ZoneInfo(timezone_name)
        except Exception:
            pass
    return datetime.now().astimezone().tzinfo or timezone.utc


def _local_album_indexes(albums: list[object]) -> tuple[dict[str, object], dict[str, list[object]]]:
    track_to_album: dict[str, object] = {}
    albums_by_title: dict[str, list[object]] = defaultdict(list)
    for album in albums or []:
        for track in list(_value(album, "tracks", []) or []):
            for candidate in (_value(track, "path"), _value(track, "track_ref")):
                normalized = _normalize_track_ref(candidate)
                if normalized:
                    track_to_album[normalized] = album
        _artist_key, album_title_key = _album_identity_key(album)
        if album_title_key:
            albums_by_title[album_title_key].append(album)
    return track_to_album, albums_by_title


def _match_local_album(
    entry: dict[str, object],
    *,
    track_to_album: dict[str, object],
    albums_by_title: dict[str, list[object]],
) -> object | None:
    for candidate in (entry.get("track_ref"), entry.get("path")):
        normalized = _normalize_track_ref(candidate)
        if normalized and normalized in track_to_album:
            return track_to_album[normalized]
    entry_artist, entry_album = _entry_album_identity(entry)
    if not entry_artist or not entry_album:
        return None
    matches = [
        album
        for album in albums_by_title.get(entry_album, [])
        if same_artist_identity(
            entry_artist,
            _value(album, "album_artist") or next(iter(_value(album, "artists", []) or []), ""),
        )
    ]
    return matches[0] if len(matches) == 1 else None


def _build_group_key(entry: dict[str, object], matched_album: object | None) -> tuple[str, str]:
    if matched_album is not None:
        return ("local", _normalize_text(_value(matched_album, "key")))
    artist_text = _normalize_text(entry.get("album_artist") or entry.get("artist")).casefold()
    album_text = _normalize_text(entry.get("album")).casefold()
    return ("external", f"{artist_text}::{album_text}")


def _known_album_track_count(entry: dict[str, object], matched_album: object | None) -> int | None:
    if matched_album is not None:
        return len(list(_value(matched_album, "tracks", []) or []))
    raw_value = entry.get("album_track_count")
    try:
        return int(raw_value) if raw_value is not None else None
    except (TypeError, ValueError):
        return None


def _known_album_duration_seconds(entry: dict[str, object], matched_album: object | None) -> int | None:
    raw_value = _value(matched_album, "total_duration_seconds", None) if matched_album is not None else entry.get("album_duration_seconds")
    try:
        return int(raw_value) if raw_value is not None else None
    except (TypeError, ValueError):
        return None


def _completion_state(*, listened_track_count: int, album_track_count: int | None) -> str | None:
    if album_track_count is None or album_track_count <= 0:
        return None
    return "full" if listened_track_count >= album_track_count else "partial"


def _entry_track_identity(entry: dict[str, object]) -> str:
    for candidate in (entry.get("track_ref"), entry.get("path")):
        normalized = _normalize_track_ref(candidate)
        if normalized:
            return normalized
    title_key = _normalize_text(entry.get("title")).casefold()
    track_number_key = _normalize_text(entry.get("track_number")).casefold()
    if title_key and track_number_key:
        return f"title::{title_key}::{track_number_key}"
    if title_key:
        return f"title::{title_key}"
    return ""


def _sitting_state(entries: list[dict[str, object]]) -> str | None:
    session_count = 0
    previous_end: datetime | None = None
    for entry in sorted(entries, key=lambda item: _entry_started_at(item) or datetime.min.replace(tzinfo=timezone.utc)):
        started_at = _entry_started_at(entry)
        ended_at = _entry_ended_at(entry) or started_at
        if started_at is None:
            continue
        if previous_end is None or started_at - previous_end > _SITTING_GAP:
            session_count += 1
        previous_end = ended_at or started_at
    if session_count <= 0:
        return None
    return "one_sitting" if session_count == 1 else "multiple_sittings"


def _build_local_row(album: object, entries: list[dict[str, object]], last_listened_at: datetime) -> dict[str, object]:
    track_refs = {
        track_identity
        for entry in entries
        for track_identity in (_entry_track_identity(entry),)
        if track_identity
    }
    album_track_count = _known_album_track_count(entries[0], album)
    listened_duration_seconds = round(sum(float(entry.get("total_listened_seconds") or 0) for entry in entries), 3)
    return {
        "row_kind": "local_album",
        "local_match_state": "matched_local",
        "album_ref": _normalize_text(_value(album, "key")),
        "name": _normalize_text(_value(album, "name")),
        "album_artist": _normalize_text(_value(album, "album_artist")),
        "listened_track_count": len(track_refs),
        "album_track_count": album_track_count,
        "listened_duration_seconds": listened_duration_seconds,
        "album_duration_seconds": _known_album_duration_seconds(entries[0], album),
        "completion_state": _completion_state(
            listened_track_count=len(track_refs),
            album_track_count=album_track_count,
        ),
        "sitting_state": _sitting_state(entries),
        "last_listened_at": last_listened_at.isoformat(),
        "allowed_actions": {
            "can_open_album": bool(_normalize_text(_value(album, "key"))),
            "can_play_album": album_can_play_in_gallery_context(album),
        },
    }


def _build_external_row(entries: list[dict[str, object]], last_listened_at: datetime) -> dict[str, object]:
    sample = entries[0]
    track_keys = {
        track_identity
        for entry in entries
        for track_identity in (_entry_track_identity(entry),)
        if track_identity
    }
    album_track_count = _known_album_track_count(sample, None)
    listened_duration_seconds = round(sum(float(entry.get("total_listened_seconds") or 0) for entry in entries), 3)
    return {
        "row_kind": "external_album",
        "local_match_state": "not_local",
        "name": _normalize_text(sample.get("album")),
        "album_artist": _normalize_text(sample.get("album_artist") or sample.get("artist")),
        "listened_track_count": len(track_keys),
        "album_track_count": album_track_count,
        "listened_duration_seconds": listened_duration_seconds,
        "album_duration_seconds": _known_album_duration_seconds(sample, None),
        "completion_state": _completion_state(
            listened_track_count=len(track_keys),
            album_track_count=album_track_count,
        ),
        "sitting_state": _sitting_state(entries),
        "last_listened_at": last_listened_at.isoformat(),
        "remote_cover_url": _normalize_text(sample.get("remote_cover_url")) or None,
        "remote_cover_thumbnail_url": _normalize_text(sample.get("remote_cover_thumbnail_url")) or None,
        "allowed_actions": {
            "can_open_album": False,
            "can_play_album": False,
        },
    }


def build_recent_listen_payloads(
    config: dict[str, object],
    albums: list[object],
    *,
    now: datetime | None = None,
) -> dict[str, list[dict[str, object]]]:
    window_timezone = _resolve_window_timezone(config)
    effective_now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    window_start = effective_now.astimezone(window_timezone) - _RECENT_LISTEN_WINDOW
    track_to_album, albums_by_title = _local_album_indexes(albums or [])

    grouped_entries: dict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
    matched_albums: dict[tuple[str, str], object] = {}
    latest_by_group: dict[tuple[str, str], datetime] = {}

    for raw_entry in load_listen_history(config):
        if not isinstance(raw_entry, dict) or not is_meaningful_listen_session(raw_entry):
            continue
        last_listened_at = _entry_last_listened_at(raw_entry)
        if last_listened_at is None:
            continue
        if last_listened_at.astimezone(window_timezone) < window_start:
            continue

        matched_album = _match_local_album(
            raw_entry,
            track_to_album=track_to_album,
            albums_by_title=albums_by_title,
        )
        if matched_album is None and _is_local_source_entry(raw_entry):
            continue

        group_key = _build_group_key(raw_entry, matched_album)
        grouped_entries[group_key].append(raw_entry)
        if matched_album is not None:
            matched_albums[group_key] = matched_album
        previous_latest = latest_by_group.get(group_key)
        if previous_latest is None or last_listened_at > previous_latest:
            latest_by_group[group_key] = last_listened_at

    local_rows: list[tuple[datetime, dict[str, object]]] = []
    external_rows: list[tuple[datetime, dict[str, object]]] = []
    for group_key, entries in grouped_entries.items():
        last_listened_at = latest_by_group[group_key]
        matched_album = matched_albums.get(group_key)
        if matched_album is not None:
            local_rows.append((last_listened_at, _build_local_row(matched_album, entries, last_listened_at)))
        else:
            external_rows.append((last_listened_at, _build_external_row(entries, last_listened_at)))

    local_rows.sort(key=lambda item: item[0], reverse=True)
    external_rows.sort(key=lambda item: item[0], reverse=True)
    return {
        "recent_local_albums": [row for _, row in local_rows],
        "recent_not_local_albums": [row for _, row in external_rows],
    }
