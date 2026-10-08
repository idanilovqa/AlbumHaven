from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
import math
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from music_app.services.allowed_actions import AllowedActions
from music_app.services.lastfm import get_lastfm_user_timezone
from music_app.services.listen_history import load_recent_listen_history
from music_app.services.listen_history_postgres import (
    PostgresListenHistoryAdapter,
    _recent_track_ref as _normalize_track_ref,
)
from music_app.services.music_identity_matching import same_artist_identity

_RECENT_LISTEN_WINDOW = timedelta(days=7)


def _normalize_text(value: object) -> str:
    return " ".join(str(value or "").strip().split())


def _entry_source_kind(entry: dict[str, object]) -> str:
    source = entry.get("source_provenance")
    return _normalize_text(source.get("kind")).casefold() if isinstance(source, dict) else ""


def _resolve_window_timezone(config: dict[str, object], *, account_id: int) -> ZoneInfo | None:
    timezone_name = get_lastfm_user_timezone(config, account_id=account_id)
    if timezone_name:
        try:
            return ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return None


def _local_album_indexes(albums: list[dict[str, object]]):
    track_to_album = {}
    albums_by_title = defaultdict(list)
    for album in albums:
        for ref, track_id in album["legacy_track_refs"].items():
            normalized = _normalize_track_ref(ref)
            candidate = (album, track_id)
            previous = track_to_album.get(normalized)
            if normalized in track_to_album and previous != candidate:
                track_to_album[normalized] = None
            else:
                track_to_album[normalized] = candidate
        title = _normalize_text(album["name"]).casefold()
        if title:
            albums_by_title[title].append(album)
    return track_to_album, albums_by_title


def _match_local_album(entry, *, track_to_album, albums_by_title):
    for candidate in (entry.get("track_ref"), entry.get("path"), entry.get("track_key")):
        normalized = _normalize_track_ref(candidate)
        match = track_to_album.get(normalized) if normalized else None
        if match is not None:
            album, track_id = match
            return album, track_id
    artist = _normalize_text(entry.get("album_artist") or entry.get("artist"))
    title = _normalize_text(entry.get("album")).casefold()
    if not artist or not title:
        return None, None
    matches = [album for album in albums_by_title.get(title, [])
               if same_artist_identity(artist, album["album_artist"])]
    return (matches[0], None) if len(matches) == 1 else (None, None)


def _entry_track_identity(entry: dict[str, object]) -> str:
    if entry.get("track_id") is not None:
        return f"track::{entry['track_id']}"
    for candidate in (entry.get("track_ref"), entry.get("path"), entry.get("track_key")):
        normalized = _normalize_track_ref(candidate)
        if normalized:
            return normalized
    title = _normalize_text(entry.get("title")).casefold()
    number = _normalize_text(entry.get("track_number")).casefold()
    return f"title::{title}::{number}" if title else ""


def _known_nonnegative_number(value: object, *, integer=False):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number < 0 or (integer and not number.is_integer()):
        return None
    return int(number) if integer else number


def _remote_cover_url(value: object) -> str | None:
    value = _normalize_text(value)
    try:
        parsed = urlsplit(value)
        if parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username and not parsed.password:
            return value
    except ValueError:
        pass
    return None


def _summed_seconds(values):
    try:
        return round(math.fsum(values), 3)
    except OverflowError:
        # A finite event can still overflow the aggregate's numeric representation.
        return None


def _build_row(entries, album, allowed_actions_for_album):
    sample = entries[0]
    durations = defaultdict(list)
    for entry in entries:
        durations[entry["source_family"]].append(entry["listened_seconds"])
    row = {
        "row_kind": "local_album" if album else "external_album",
        "local_match_state": "matched_local" if album else "not_local",
        "name": _normalize_text(album["name"] if album else sample.get("album")),
        "album_artist": _normalize_text(album["album_artist"] if album else sample.get("album_artist") or sample.get("artist")),
        "listen_event_count": len(entries),
        "listened_track_count": len({identity for entry in entries
                                     if (identity := _entry_track_identity(entry))}),
        "album_track_count": _known_nonnegative_number(
            album["album_track_count"] if album else sample.get("album_track_count"), integer=True,
        ),
        "listened_duration_seconds": _summed_seconds(entry["listened_seconds"] for entry in entries),
        "listened_duration_by_source": {source: _summed_seconds(seconds) for source, seconds in sorted(durations.items())},
        "time_provenance": sorted({entry["time_provenance"] for entry in entries}),
        "album_duration_seconds": _known_nonnegative_number(
            album["total_duration_seconds"] if album else sample.get("album_duration_seconds"),
        ),
        "completion_state": None,
        "sitting_state": None,
        "last_listened_at": sample["played_at"].isoformat(),
        "allowed_actions": {"can_open_album": False, "can_play_album": False},
    }
    if album:
        actions = allowed_actions_for_album(album)
        if not isinstance(actions, AllowedActions):
            raise ValueError("Recent album actions require an authoritative policy projection")
        row["album_ref"] = _normalize_text(album["key"])
        can_open = bool(row["album_ref"]) and actions.allows("library.browse.read")
        row["allowed_actions"] = {
            "can_open_album": can_open,
            "can_play_album": can_open and bool(album["can_play"]) and actions.allows("library.media.read"),
        }
    else:
        row["remote_cover_url"] = _remote_cover_url(sample.get("remote_cover_url"))
        row["remote_cover_thumbnail_url"] = _remote_cover_url(sample.get("remote_cover_thumbnail_url"))
    return row


def build_recent_listen_payloads(
    config: dict[str, object], *, account_id: int, library_id: int,
    allowed_actions_for_album: Callable[[dict[str, object]], AllowedActions],
    now: datetime | None = None,
) -> dict[str, list[dict[str, object]]]:
    if any(type(value) is not int or value <= 0 for value in (account_id, library_id)):
        raise ValueError("Exact recent listen account and library scope is required")
    if not callable(allowed_actions_for_album):
        raise ValueError("Recent album actions require an authoritative policy projection")
    effective_now = now if now is not None else datetime.now(timezone.utc)
    if not isinstance(effective_now, datetime) or effective_now.tzinfo is None or effective_now.utcoffset() is None:
        raise ValueError("Recent listen time must be timezone-aware")
    effective_now = effective_now.astimezone(timezone.utc)
    window_timezone = _resolve_window_timezone(config, account_id=account_id)
    local_now = effective_now.astimezone(window_timezone)
    if window_timezone is None:
        # A naive local boundary lets astimezone apply the server rules at that
        # date, rather than carrying the current fixed UTC offset across DST.
        local_now = local_now.replace(tzinfo=None)
    window_start = (local_now - _RECENT_LISTEN_WINDOW).astimezone(timezone.utc)
    entries = load_recent_listen_history(
        config, account_id=account_id, library_id=library_id,
        window_start=window_start, window_end=effective_now,
    )
    result = {"recent_local_albums": [], "recent_not_local_albums": []}
    if not entries:
        return result
    entries.sort(key=lambda entry: (entry["played_at"], entry["row_id"]), reverse=True)
    legacy_refs = list({str(ref) for entry in entries if entry["measurement_version"] is None
                        for ref in (entry.get("track_ref"), entry.get("path"), entry.get("track_key")) if ref})
    albums = PostgresListenHistoryAdapter(config).load_recent_album_candidates(
        library_id=library_id, legacy_track_refs=legacy_refs,
    )
    albums_by_id = {album["id"]: album for album in albums}
    track_to_album, albums_by_title = _local_album_indexes(albums)
    grouped = defaultdict(list)
    matched_albums = {}
    for entry in entries:
        entry = dict(entry)
        if entry["measurement_version"] == "rendered-pcm-v1":
            # A removed measured identity must never fall through to fuzzy legacy matching.
            album = albums_by_id.get(entry["album_id"]) if entry["track_id"] is not None else None
            if album is None:
                continue
        else:
            album = albums_by_id.get(entry["album_id"]) if entry["track_id"] is not None else None
            track_id = entry["track_id"] if album is not None else None
            if album is None:
                album, track_id = _match_local_album(
                    entry, track_to_album=track_to_album, albums_by_title=albums_by_title,
                )
            entry["track_id"] = track_id
            if album is None and _entry_source_kind(entry) != "lastfm_import":
                continue
        if album is not None:
            key = ("local", album["id"])
            matched_albums[key] = album
        else:
            key = ("external", _normalize_text(entry.get("album_artist") or entry.get("artist")).casefold(),
                   _normalize_text(entry.get("album")).casefold())
        grouped[key].append(entry)
    for key, grouped_entries in sorted(grouped.items(), key=lambda item: (
        item[1][0]["played_at"], item[1][0]["row_id"],
    ), reverse=True):
        album = matched_albums.get(key)
        target = "recent_local_albums" if album else "recent_not_local_albums"
        result[target].append(_build_row(grouped_entries, album, allowed_actions_for_album))
    return result
