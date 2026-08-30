from __future__ import annotations
from collections import Counter
from copy import deepcopy
from difflib import SequenceMatcher
from pathlib import Path
import re
import time
from music_app.models.library import Album, Track
from music_app.services.move_planner import build_move_availability_payload
from music_app.services.library_roots import build_root_provenance_payload, summarize_root_provenance_payloads
from music_app.services.client_surfaces import resolve_client_surface_class
from music_app.services.album_note_read_seams import (
    build_album_note_payload,
    build_visible_album_notes_payload,
)
from music_app.services.album_display_metadata import (
    build_album_display_metadata_payload,
    has_album_display_metadata_values,
)
from music_app.services.artist_credits import deduplicate_repeated_album_artist_members
from music_app.services.listen_through import (
    album_top_item_visible_for_viewer,
    default_album_preference_overlay,
    default_top_viewer_overlay,
    filter_album_top_items_for_viewer,
    normalize_album_preference_overlay,
    normalize_top_viewer_overlay,
)
from music_app.services.opinion_read_seams import (
    build_album_popularity_payload,
    build_crowd_opinion_payload,
    build_friends_opinion_payload,
    build_track_popularity_payload,
    resolve_viewer_opinion_preferences,
)
from music_app.services.page_resource_seams import build_album_page_seam
from music_app.services.track_rows import (
    build_album_gallery_list_block,
    build_track_rows,
)
from music_app.services.track_preferences import default_track_preference_overlay, strip_private_track_rows
from music_app.services.utils import safe_int, format_duration, repair_display_text
from music_app.services.metadata import normalize_exception_value

_NON_ALBUM_ALBUM_VALUE_RE = re.compile(r"^[!\-\s\[\(]*non[\s\-_]*album(?:\b.*)?$", re.IGNORECASE)
_DISC_FOLDER_RE = re.compile(r"(?<![A-Za-z0-9])(?:cd|disc|disk)\s*[-_.]?\s*(\d{1,2})(?![A-Za-z0-9])", re.IGNORECASE)
_VARIOUS_ARTIST_KEYS = {"va", "v.a.", "various artists", "various artist", "various"}
_FEATURE_ARTIST_SPLIT_RE = re.compile(r"\s+(?:feat\.?|featuring|with|vs|x)\s+", re.IGNORECASE)
_SPLIT_ARTIST_SPLIT_RE = re.compile(r"\s+(?:and|\u0438)\s+|(?:\s*&\s*)|/|;|,", re.IGNORECASE)
_ARTIST_PUNCT_TRANSLATION = str.maketrans({
    "\u2018": "'",
    "\u2019": "'",
    "\u201b": "'",
    "\u2032": "'",
    "\u02bc": "'",
    "\u00b4": "'",
    "`": "'",
})
_COLLAB_REMAINDER_PREFIXES = (",", "&", "feat", "featuring", "with", "vs", "x", "/", ";", "\u0438")

def _is_loose_track_album_value(value: object) -> bool:
    text = " ".join(str(value or "").strip().split())
    if not text:
        return False
    return bool(_NON_ALBUM_ALBUM_VALUE_RE.match(text))


def _normalize_artist_key(value: object) -> str:
    text = " ".join(str(value or "").strip().split())
    return text.translate(_ARTIST_PUNCT_TRANSLATION).casefold()


def _is_various_artist(value: object) -> bool:
    return _normalize_artist_key(value) in _VARIOUS_ARTIST_KEYS


def _compact_artist_key(value: object) -> str:
    return re.sub(r"[\W_]+", "", _normalize_artist_key(value), flags=re.UNICODE)


def _are_probable_artist_typos(left: object, right: object) -> bool:
    left_text = str(left or "").strip()
    right_text = str(right or "").strip()
    if not left_text or not right_text or _normalize_artist_key(left_text) == _normalize_artist_key(right_text):
        return False
    left_compact = _compact_artist_key(left_text)
    right_compact = _compact_artist_key(right_text)
    if not left_compact or not right_compact:
        return False
    if left_compact[0] != right_compact[0]:
        return False
    if abs(len(left_compact) - len(right_compact)) > 2:
        return False
    return SequenceMatcher(None, left_compact, right_compact).ratio() >= 0.9


def _is_collaboration_variant(value: object, base: object) -> bool:
    value_key = _normalize_artist_key(value)
    base_key = _normalize_artist_key(base)
    if not value_key or not base_key or value_key == base_key:
        return False
    if not value_key.startswith(base_key):
        return False
    remainder = value_key[len(base_key):].strip()
    return any(remainder.startswith(prefix) for prefix in _COLLAB_REMAINDER_PREFIXES)


def _normalize_display_artist_name(value: object) -> str:
    return repair_display_text(str(value or "")) or str(value or "")


def _split_album_artist_members(value: object) -> list[str]:
    text = _normalize_display_artist_name(value).strip()
    if not text or _is_various_artist(text):
        return []
    if _FEATURE_ARTIST_SPLIT_RE.search(text):
        return []
    parts = [part.strip() for part in _SPLIT_ARTIST_SPLIT_RE.split(text) if part and part.strip()]
    unique_parts = []
    seen = set()
    for part in parts:
        normalized = _normalize_artist_key(part)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_parts.append(part)
    return unique_parts if len(unique_parts) >= 2 else []


def _canonicalize_artist_names(names: list[str]) -> tuple[list[str], Counter[str]]:
    canonical_names: list[str] = []
    counts: Counter[str] = Counter()
    for raw_name in names:
        name = _normalize_display_artist_name(raw_name).strip()
        if not name or _is_various_artist(name):
            continue
        collaboration_match = next((
            existing for existing in canonical_names
            if _is_collaboration_variant(name, existing)
        ), None)
        if collaboration_match:
            counts[collaboration_match] += 1
            continue
        simpler_match = next((
            existing for existing in canonical_names
            if _is_collaboration_variant(existing, name)
        ), None)
        if simpler_match:
            counts[name] += counts.pop(simpler_match, 0) + 1
            canonical_names = [name if existing == simpler_match else existing for existing in canonical_names]
            continue
        match = next((
            existing for existing in canonical_names
            if _normalize_artist_key(existing) == _normalize_artist_key(name) or _are_probable_artist_typos(existing, name)
        ), None)
        canonical = match or name
        if not match:
            canonical_names.append(name)
        counts[canonical] += 1
    return canonical_names, counts


def _format_shared_album_artist(member_artists: list[str]) -> str:
    if len(member_artists) > 3:
        return "Various Artists"
    if member_artists:
        combined_artist = " / ".join(member_artists)
        deduplicated_members = deduplicate_repeated_album_artist_members(
            combined_artist
        )
        return (
            " / ".join(deduplicated_members)
            if deduplicated_members
            else combined_artist
        )
    return "Various Artists"


def _main_disc_entries(entries: list[dict[str, object]]) -> list[dict[str, object]]:
    if not entries:
        return []
    disc_numbers = [
        safe_int(entry.get("disc_number"))
        for entry in entries
        if safe_int(entry.get("disc_number")) is not None
    ]
    if not disc_numbers:
        return list(entries)
    main_disc = min(disc_numbers)
    return [
        entry for entry in entries
        if safe_int(entry.get("disc_number")) == main_disc
    ] or list(entries)


def _feature_style_album_override(
    entries: list[dict[str, object]],
    primary_artist: str,
    distinct_track_artists: list[str],
) -> bool:
    primary_artist = _normalize_display_artist_name(primary_artist).strip()
    if not primary_artist or not distinct_track_artists:
        return False
    main_disc_track_artists = [
        _normalize_display_artist_name(entry.get("artist")).strip()
        for entry in _main_disc_entries(entries)
        if str(entry.get("artist") or "").strip()
    ]
    canonical_main_disc_artists, _main_disc_counts = _canonicalize_artist_names(main_disc_track_artists)
    differing_artists = [
        artist for artist in canonical_main_disc_artists
        if artist and _normalize_artist_key(artist) != _normalize_artist_key(primary_artist)
    ]
    if not (1 <= len(differing_artists) <= 4):
        return False
    return all(_is_collaboration_variant(artist, primary_artist) for artist in differing_artists)


def _one_off_guest_album_override(
    dominant_track_artist: str,
    track_artist_counts: Counter[str],
) -> bool:
    dominant_track_artist = _normalize_display_artist_name(dominant_track_artist).strip()
    if not dominant_track_artist or not track_artist_counts:
        return False
    dominant_key = _normalize_artist_key(dominant_track_artist)
    dominant_count = next(
        (
            int(count or 0)
            for artist, count in track_artist_counts.items()
            if _normalize_artist_key(artist) == dominant_key
        ),
        0,
    )
    if dominant_count < 2:
        return False
    guest_counts = [
        int(count or 0)
        for artist, count in track_artist_counts.items()
        if _normalize_artist_key(artist) != dominant_key
    ]
    if not guest_counts:
        return False
    if any(count != 1 for count in guest_counts):
        return False
    return dominant_count > sum(guest_counts)


def _dominant_track_artist(track_artist_counts: Counter[str]) -> str:
    if not track_artist_counts:
        return ""
    return max(
        track_artist_counts,
        key=lambda artist: (
            int(track_artist_counts.get(artist, 0)),
            -len(str(artist or "")),
            str(artist or "").casefold(),
        ),
    )


def _classify_album_artists(entries: list[dict[str, object]]) -> tuple[bool, str, list[str]]:
    persisted_compilation_states = {
        entry.get("is_compilation")
        for entry in entries
        if type(entry.get("is_compilation")) is bool
    }
    persisted_compilation_state = (
        next(iter(persisted_compilation_states))
        if len(persisted_compilation_states) == 1
        else None
    )

    def compilation_state(inferred_state: bool) -> bool:
        if persisted_compilation_state is None:
            return inferred_state
        return persisted_compilation_state

    album_artist_values = [
        _normalize_display_artist_name(entry.get("album_artist")).strip()
        for entry in entries
        if str(entry.get("album_artist") or "").strip()
    ]
    track_artist_values = [
        _normalize_display_artist_name(entry.get("artist")).strip()
        for entry in entries
        if str(entry.get("artist") or "").strip()
    ]
    canonical_track_artists, track_artist_counts = _canonicalize_artist_names(track_artist_values)
    distinct_track_artists = [artist for artist in canonical_track_artists if artist]
    total_tracks = sum(track_artist_counts.values())
    top_artist_count = max(track_artist_counts.values()) if track_artist_counts else 0
    top_artist_share = (top_artist_count / total_tracks) if total_tracks else 1
    significant_artist_count = sum(1 for count in track_artist_counts.values() if count >= 2)
    explicit_various = any(_is_various_artist(value) for value in album_artist_values)
    album_artist_members = _split_album_artist_members(album_artist_values[0]) if len({_normalize_artist_key(value) for value in album_artist_values if value}) <= 1 and album_artist_values else []
    matched_album_artist_members = [
        member for member in album_artist_members
        if any(_normalize_artist_key(member) == _normalize_artist_key(track_artist) or _are_probable_artist_typos(member, track_artist) for track_artist in distinct_track_artists)
    ]
    primary_artist = next((value for value in album_artist_values if value.strip()), "")
    if not primary_artist and distinct_track_artists:
        primary_artist = distinct_track_artists[0]
    dominant_track_artist = _dominant_track_artist(track_artist_counts)
    override_primary_artist = primary_artist
    if not override_primary_artist or _is_various_artist(override_primary_artist):
        override_primary_artist = dominant_track_artist

    if dominant_track_artist and _one_off_guest_album_override(dominant_track_artist, track_artist_counts):
        return compilation_state(False), dominant_track_artist, [dominant_track_artist]

    if (
        override_primary_artist
        and _feature_style_album_override(entries, override_primary_artist, distinct_track_artists)
    ):
        return compilation_state(False), override_primary_artist, [override_primary_artist]

    is_shared_album = explicit_various
    if not is_shared_album and len(distinct_track_artists) >= 2:
        is_shared_album = bool(
            len(matched_album_artist_members) >= 2
            or significant_artist_count >= 2
            or top_artist_share <= 0.7
        )

    if not is_shared_album:
        repeated_album_artist_members = deduplicate_repeated_album_artist_members(primary_artist)
        if repeated_album_artist_members:
            return (
                compilation_state(False),
                " / ".join(repeated_album_artist_members),
                repeated_album_artist_members,
            )
        return (
            compilation_state(False),
            primary_artist or "Unknown Artist",
            [primary_artist or "Unknown Artist"],
        )

    member_artists = matched_album_artist_members or distinct_track_artists
    display_album_artist = "Various Artists" if explicit_various else _format_shared_album_artist(member_artists)
    if display_album_artist == "Various Artists" and len(member_artists) <= 3 and member_artists:
        display_album_artist = _format_shared_album_artist(member_artists)
    normalized_members = member_artists if display_album_artist != "Various Artists" else member_artists
    return (
        compilation_state(True),
        display_album_artist or "Various Artists",
        normalized_members,
    )


def _album_key(album_artist: str, album_name: str, edition: str | None = None, year: object | None = None) -> str:
    parts = [album_artist.strip().lower(), album_name.strip().lower()]
    edition_text = (edition or '').strip()
    if edition_text:
        parts.append(edition_text.lower())
    if year is not None and str(year).strip():
        parts.extend(["year", str(year).strip().lower()])
    return '::'.join(parts)


def album_separate_release_key(album_artist: str, album_name: str, edition: str | None = None) -> str:
    return _album_key(album_artist, album_name, edition)


def _entry_album_container(entry: dict[str, object]) -> str:
    raw_path = str(entry.get("path") or "").strip()
    if not raw_path:
        return ""
    parent = Path(raw_path).parent
    if _DISC_FOLDER_RE.search(parent.name) and parent.parent != parent:
        parent = parent.parent
    return str(parent).strip().lower()


def _track_album_container(path_value: object) -> str:
    raw_path = str(path_value or "").strip()
    if not raw_path:
        return ""
    parent = Path(raw_path).parent
    if _DISC_FOLDER_RE.search(parent.name) and parent.parent != parent:
        parent = parent.parent
    return str(parent).strip()


def _normalize_duplicate_text(value: object) -> str:
    text = repair_display_text(str(value or "")) or str(value or "")
    text = text.translate(_ARTIST_PUNCT_TRANSLATION).casefold()
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)


def _duplicate_text_matches(left: object, right: object) -> bool:
    left_key = _normalize_duplicate_text(left)
    right_key = _normalize_duplicate_text(right)
    if not left_key or not right_key:
        return left_key == right_key
    if left_key == right_key:
        return True
    if min(len(left_key), len(right_key)) >= 6 and (left_key in right_key or right_key in left_key):
        return True
    return SequenceMatcher(None, left_key, right_key).ratio() >= 0.92


def _duplicate_track_sort_key(track: Track) -> tuple[int, int, str, str, int]:
    disc_number = safe_int(getattr(track, "disc_number", None)) or 0
    track_number = safe_int(getattr(track, "track_number", None)) or 0
    title_key = _normalize_duplicate_text(getattr(track, "title", ""))
    artist_key = _normalize_artist_key(getattr(track, "artist", ""))
    duration = safe_int(getattr(track, "duration_seconds", None)) or 0
    return (disc_number, track_number, title_key, artist_key, duration)


def _duplicate_track_groups_match(left_tracks: list[Track], right_tracks: list[Track]) -> bool:
    if len(left_tracks) != len(right_tracks):
        return False
    left_sorted = sorted(left_tracks, key=_duplicate_track_sort_key)
    right_sorted = sorted(right_tracks, key=_duplicate_track_sort_key)
    for left_track, right_track in zip(left_sorted, right_sorted):
        if (safe_int(getattr(left_track, "disc_number", None)) or 0) != (safe_int(getattr(right_track, "disc_number", None)) or 0):
            return False
        if (safe_int(getattr(left_track, "track_number", None)) or 0) != (safe_int(getattr(right_track, "track_number", None)) or 0):
            return False
        if _normalize_artist_key(getattr(left_track, "artist", "")) != _normalize_artist_key(getattr(right_track, "artist", "")):
            return False
        if _normalize_duplicate_text(getattr(left_track, "album", "")) != _normalize_duplicate_text(getattr(right_track, "album", "")):
            return False
        if (safe_int(getattr(left_track, "year", None)) or 0) != (safe_int(getattr(right_track, "year", None)) or 0):
            return False
        if _normalize_duplicate_text(getattr(left_track, "edition", "")) != _normalize_duplicate_text(getattr(right_track, "edition", "")):
            return False
        left_duration = safe_int(getattr(left_track, "duration_seconds", None)) or 0
        right_duration = safe_int(getattr(right_track, "duration_seconds", None)) or 0
        if abs(left_duration - right_duration) > 2:
            return False
        if not _duplicate_text_matches(getattr(left_track, "title", ""), getattr(right_track, "title", "")):
            return False
    return True


def _track_to_dict(track: Track) -> dict[str, object]:
    return {
        "path": str(track.path),
        "title": track.title,
        "track_number": track.track_number,
        "disc_number": track.disc_number,
        "disc_number_raw": track.disc_number_raw,
        "artist": track.artist,
        "album": track.album,
        "album_artist": track.album_artist,
        "genre": getattr(track, "genre", None),
        "year": track.year,
        "release_date": getattr(track, "release_date", None),
        "edition": track.edition,
        "album_rating": int(track.album_rating or 0),
        "exception_type": track.exception_type,
        "cover_path": str(track.cover_path) if track.cover_path else None,
        "cover_revision": getattr(track, "cover_revision", None),
        "local_cover_width": getattr(track, "local_cover_width", None),
        "local_cover_height": getattr(track, "local_cover_height", None),
        "remote_cover_url": getattr(track, "remote_cover_url", None),
        "remote_cover_thumbnail_url": getattr(track, "remote_cover_thumbnail_url", None),
        "remote_cover_source": getattr(track, "remote_cover_source", None),
        "remote_cover_source_label": getattr(track, "remote_cover_source_label", None),
        "remote_cover_album_url": getattr(track, "remote_cover_album_url", None),
        "remote_cover_width": getattr(track, "remote_cover_width", None),
        "remote_cover_height": getattr(track, "remote_cover_height", None),
        "duration_seconds": track.duration_seconds,
        "track_preference_overlay": getattr(track, "track_preference_overlay", None),
        "playback_state_overlay": getattr(track, "playback_state_overlay", None),
        "track_scrobble_count": getattr(track, "track_scrobble_count", None),
        "track_popularity": getattr(track, "track_popularity", None),
        "library_root_id": getattr(track, "library_root_id", None),
        "library_root_category": getattr(track, "library_root_category", None),
        "root_provenance": getattr(track, "root_provenance", None),
    }


def _build_album_detail_track_payloads(
    album: Album,
    *,
    client_surface_class: object,
    viewer_opinion_preferences: dict[str, object],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    track_payloads = [_track_to_dict(track) for track in album.tracks]
    track_rows = build_track_rows(
        album.tracks,
        album=album,
        client_surface_class=client_surface_class,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )
    return track_payloads, track_rows


def _strip_private_track_payloads(track_payloads: object) -> list[dict[str, object]]:
    if not isinstance(track_payloads, list):
        return []

    sanitized_tracks: list[dict[str, object]] = []
    for track_payload in track_payloads:
        if not isinstance(track_payload, dict):
            continue
        sanitized_track = dict(track_payload)
        sanitized_track["track_preference_overlay"] = None
        sanitized_track["track_preference"] = default_track_preference_overlay()
        sanitized_track["can_edit_preferences"] = False
        sanitized_track["playback_state_overlay"] = None
        sanitized_track["track_scrobble_count"] = None
        sanitized_track["track_popularity"] = _hidden_track_popularity_payload()
        sanitized_tracks.append(sanitized_track)
    return sanitized_tracks


def _album_tag_rating(value: object) -> int | None:
    return safe_int(value)


def _album_preference_to_dict() -> dict[str, object]:
    return default_album_preference_overlay()


def _top_viewer_overlay_to_dict() -> dict[str, object]:
    return default_top_viewer_overlay()


def _hidden_crowd_opinion_payload() -> dict[str, object]:
    return build_crowd_opinion_payload({})


def _hidden_friends_opinion_payload() -> dict[str, object]:
    return build_friends_opinion_payload({})


def _hidden_album_popularity_payload() -> dict[str, object]:
    return build_album_popularity_payload({})


def _hidden_track_popularity_payload() -> dict[str, object]:
    return build_track_popularity_payload({})


def _strip_public_track_rows(track_rows: object) -> list[dict[str, object]]:
    sanitized_rows = strip_private_track_rows(track_rows)
    for sanitized_row in sanitized_rows:
        sanitized_row["track_popularity"] = _hidden_track_popularity_payload()
    return sanitized_rows


def _freeze_payload_signature(value: object) -> object:
    if isinstance(value, dict):
        return tuple(
            (str(key), _freeze_payload_signature(item_value))
            for key, item_value in sorted(value.items(), key=lambda item: str(item[0]))
        )
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_payload_signature(item) for item in value)
    if isinstance(value, set):
        return tuple(sorted(_freeze_payload_signature(item) for item in value))
    return value


def strip_private_album_preference_overlays(album_payload: dict[str, object]) -> dict[str, object]:
    if not isinstance(album_payload, dict):
        return {}

    sanitized_payload = dict(album_payload)
    sanitized_payload.pop("album_note", None)
    sanitized_payload.pop("visible_album_notes", None)
    sanitized_payload["album_preference"] = _album_preference_to_dict()
    sanitized_payload["top_viewer_overlay"] = _top_viewer_overlay_to_dict()
    sanitized_payload["crowd_opinion"] = _hidden_crowd_opinion_payload()
    sanitized_payload["friends_opinion"] = _hidden_friends_opinion_payload()
    sanitized_payload["album_popularity"] = _hidden_album_popularity_payload()
    if "tracks" in sanitized_payload:
        sanitized_payload["tracks"] = _strip_private_track_payloads(sanitized_payload.get("tracks"))
    sanitized_payload["track_rows"] = _strip_public_track_rows(sanitized_payload.get("track_rows"))

    gallery_list_block = sanitized_payload.get("gallery_list_block")
    if isinstance(gallery_list_block, dict):
        sanitized_gallery_list_block = dict(gallery_list_block)
        summary = sanitized_gallery_list_block.get("summary")
        if isinstance(summary, dict):
            sanitized_summary = dict(summary)
            sanitized_summary["album_preference"] = _album_preference_to_dict()
            sanitized_summary["crowd_opinion"] = _hidden_crowd_opinion_payload()
            sanitized_summary["friends_opinion"] = _hidden_friends_opinion_payload()
            sanitized_summary["album_popularity"] = _hidden_album_popularity_payload()
            sanitized_gallery_list_block["summary"] = sanitized_summary
        sanitized_gallery_list_block["track_rows"] = _strip_public_track_rows(
            sanitized_gallery_list_block.get("track_rows")
        )
        sanitized_payload["gallery_list_block"] = sanitized_gallery_list_block

    duplicate_sources = sanitized_payload.get("duplicate_sources")
    if isinstance(duplicate_sources, list):
        sanitized_sources: list[dict[str, object]] = []
        for duplicate_source in duplicate_sources:
            if not isinstance(duplicate_source, dict):
                continue
            sanitized_source = dict(duplicate_source)
            sanitized_source["tracks"] = _strip_private_track_payloads(sanitized_source.get("tracks"))
            sanitized_sources.append(sanitized_source)
        sanitized_payload["duplicate_sources"] = sanitized_sources

    return sanitized_payload


def _finalize_album_payload_for_viewer(
    payload: dict[str, object],
    *,
    public_safe: bool,
) -> dict[str, object]:
    return strip_private_album_preference_overlays(payload) if public_safe else payload


def _album_tag_rating_source(tag_album_rating: object) -> str | None:
    return "file_tag" if _album_tag_rating(tag_album_rating) is not None else None


def _preview_open_directory_paths(album: Album) -> list[str]:
    cached_paths = getattr(album, "_cached_preview_open_directory_paths", None)
    if isinstance(cached_paths, list):
        return list(cached_paths)

    paths: list[str] = []
    seen: set[str] = set()
    for track in getattr(album, "tracks", []) or []:
        directory = _track_album_container(getattr(track, "path", ""))
        directory_key = directory.casefold()
        if not directory or directory_key in seen:
            continue
        seen.add(directory_key)
        paths.append(directory)

    setattr(album, "_cached_preview_open_directory_paths", list(paths))
    return paths


def _album_payload_signature_core(
    album: Album,
    *,
    viewer_opinion_preferences: dict[str, object],
) -> tuple[object, ...]:
    return (
        getattr(album, "key", None),
        getattr(album, "name", None),
        getattr(album, "album_artist", None),
        tuple(getattr(album, "artists", []) or []),
        bool(getattr(album, "is_compilation", False)),
        str(getattr(album, "cover_path", "") or ""),
        str(getattr(album, "cover_revision", "") or "").strip() or None,
        getattr(album, "local_cover_width", None),
        getattr(album, "local_cover_height", None),
        getattr(album, "remote_cover_url", None),
        getattr(album, "remote_cover_thumbnail_url", None),
        getattr(album, "remote_cover_source", None),
        getattr(album, "remote_cover_source_label", None),
        getattr(album, "remote_cover_album_url", None),
        getattr(album, "remote_cover_width", None),
        getattr(album, "remote_cover_height", None),
        getattr(album, "year", None),
        getattr(album, "release_date", None),
        getattr(album, "edition", None),
        int(getattr(album, "album_rating", 0) or 0),
        getattr(album, "total_duration_seconds", None),
        getattr(album, "library_root_id", None),
        getattr(album, "library_root_category", None),
        repr(getattr(album, "root_provenance", None)),
        repr(getattr(album, "album_display_metadata", None)),
        repr(getattr(album, "crowd_opinion", None)),
        repr(getattr(album, "friends_opinion", None)),
        repr(getattr(album, "album_popularity", None)),
        tuple(sorted(viewer_opinion_preferences.items())),
    )


def _album_preview_payload_signature(
    album: Album,
    *,
    viewer_opinion_preferences: dict[str, object],
    include_album_note_seams: bool,
    album_note_payload: object,
    visible_album_notes_payload: object,
    move_availability: object = None,
) -> tuple[object, ...]:
    return (
        *_album_payload_signature_core(
            album,
            viewer_opinion_preferences=viewer_opinion_preferences,
        ),
        len(getattr(album, "tracks", []) or []),
        tuple(_preview_open_directory_paths(album)),
        include_album_note_seams,
        _freeze_payload_signature(album_note_payload),
        _freeze_payload_signature(visible_album_notes_payload),
        _freeze_payload_signature(move_availability),
    )


def _album_payload_signature(
    album: Album,
    *,
    client_surface_class: object,
    viewer_opinion_preferences: dict[str, object],
    move_availability: object,
    album_note_payload: object,
    visible_album_notes_payload: object,
) -> tuple[object, ...]:
    return (
        client_surface_class,
        *_album_payload_signature_core(
            album,
            viewer_opinion_preferences=viewer_opinion_preferences,
        ),
        tuple(
            _album_payload_track_signature(track)
            for track in getattr(album, "tracks", []) or []
        ),
        _freeze_payload_signature(move_availability),
        _freeze_payload_signature(album_note_payload),
        _freeze_payload_signature(visible_album_notes_payload),
    )


def _album_payload_track_signature(track: Track) -> tuple[object, ...]:
    return (
        str(getattr(track, "path", "") or ""),
        getattr(track, "title", None),
        getattr(track, "track_number", None),
        getattr(track, "disc_number", None),
        getattr(track, "disc_number_raw", None),
        getattr(track, "artist", None),
        getattr(track, "album", None),
        getattr(track, "album_artist", None),
        getattr(track, "genre", None),
        getattr(track, "year", None),
        getattr(track, "release_date", None),
        getattr(track, "edition", None),
        int(getattr(track, "album_rating", 0) or 0),
        getattr(track, "exception_type", None),
        str(getattr(track, "cover_path", "") or ""),
        str(getattr(track, "cover_revision", "") or "").strip() or None,
        getattr(track, "local_cover_width", None),
        getattr(track, "local_cover_height", None),
        getattr(track, "remote_cover_url", None),
        getattr(track, "remote_cover_thumbnail_url", None),
        getattr(track, "remote_cover_source", None),
        getattr(track, "remote_cover_source_label", None),
        getattr(track, "remote_cover_album_url", None),
        getattr(track, "remote_cover_width", None),
        getattr(track, "remote_cover_height", None),
        getattr(track, "duration_seconds", None),
        repr(getattr(track, "track_preference_overlay", None)),
        repr(getattr(track, "playback_state_overlay", None)),
        getattr(track, "track_scrobble_count", None),
        repr(getattr(track, "track_popularity", None)),
        getattr(track, "library_root_id", None),
        getattr(track, "library_root_category", None),
        repr(getattr(track, "root_provenance", None)),
    )


def _apply_gallery_summary_opinion_payloads(
    gallery_list_block: dict[str, object],
    *,
    crowd_opinion: dict[str, object],
    friends_opinion: dict[str, object],
    album_popularity: dict[str, object],
) -> dict[str, object]:
    gallery_summary = gallery_list_block.setdefault("summary", {})
    if isinstance(gallery_summary, dict):
        gallery_summary["crowd_opinion"] = crowd_opinion
        gallery_summary["friends_opinion"] = friends_opinion
        gallery_summary["album_popularity"] = album_popularity
    return gallery_list_block


def _build_album_detail_gallery_list_block(
    album: Album,
    *,
    track_rows: list[dict[str, object]],
    album_preference: dict[str, object],
    tag_album_rating: int | None,
    tag_album_rating_source: str | None,
    crowd_opinion: dict[str, object],
    friends_opinion: dict[str, object],
    album_popularity: dict[str, object],
) -> dict[str, object]:
    gallery_list_block = build_album_gallery_list_block(
        album_key=album.key,
        album_name=album.name,
        album_artist=album.album_artist,
        album_year=album.year,
        album_rating=album.album_rating,
        total_duration_seconds=album.total_duration_seconds,
        track_count=len(track_rows),
        track_rows=track_rows,
        track_rows_source="inline",
        album_preference=album_preference,
        tag_album_rating=tag_album_rating,
        tag_album_rating_source=tag_album_rating_source,
    )
    return _apply_gallery_summary_opinion_payloads(
        gallery_list_block,
        crowd_opinion=crowd_opinion,
        friends_opinion=friends_opinion,
        album_popularity=album_popularity,
    )


def _build_album_opinion_payloads(
    album: Album,
    *,
    viewer_opinion_preferences: dict[str, object],
) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    crowd_opinion = build_crowd_opinion_payload(album, viewer_opinion_preferences=viewer_opinion_preferences)
    friends_opinion = build_friends_opinion_payload(album, viewer_opinion_preferences=viewer_opinion_preferences)
    album_popularity = build_album_popularity_payload(album, viewer_opinion_preferences=viewer_opinion_preferences)
    return crowd_opinion, friends_opinion, album_popularity


def _build_album_preview_gallery_list_block(
    *,
    album_key: object,
    album_name: object,
    album_artist: object,
    album_year: object,
    album_rating: object,
    total_duration_seconds: object,
    track_count: int,
    album_preference: dict[str, object],
    tag_album_rating: int | None,
    tag_album_rating_source: str | None,
    gallery_list_block: dict[str, object] | None = None,
) -> dict[str, object]:
    preview_gallery_list_block = (
        dict(gallery_list_block)
        if isinstance(gallery_list_block, dict)
        else build_album_gallery_list_block(
            album_key=album_key,
            album_name=album_name,
            album_artist=album_artist,
            album_year=album_year,
            album_rating=album_rating,
            total_duration_seconds=total_duration_seconds,
            track_count=track_count,
            track_rows=[],
            track_rows_source="album_details",
            album_preference=album_preference,
            tag_album_rating=tag_album_rating,
            tag_album_rating_source=tag_album_rating_source,
        )
    )
    gallery_summary = preview_gallery_list_block.get("summary")
    if isinstance(gallery_summary, dict):
        normalized_summary = dict(gallery_summary)
        summary_album_preference = normalized_summary.get("album_preference")
        if summary_album_preference is None:
            normalized_summary["album_preference"] = dict(album_preference)
        else:
            normalized_summary["album_preference"] = normalize_album_preference_overlay(summary_album_preference)
        preview_gallery_list_block["summary"] = normalized_summary
    return preview_gallery_list_block

def _build_album_detail_setup_payloads(
    album: Album,
    *,
    config: object = None,
) -> tuple[list[dict[str, object]], dict[str, object] | None]:
    duplicate_sources = get_album_duplicate_sources(album)
    resolved_config = config
    move_availability = (
        build_move_availability_payload(album, resolved_config)
        if resolved_config is not None
        else None
    )
    return duplicate_sources, move_availability


def _build_album_base_payload(
    album: Album,
    *,
    album_ref: str,
    album_preference: dict[str, object],
    tag_album_rating: int | None,
    tag_album_rating_source: str | None,
    move_availability: dict[str, object] | None,
) -> dict[str, object]:
    stored_cover_selection_origin = str(
        getattr(album, "cover_selection_origin", None) or ""
    ).strip().casefold()
    cover_selection_origin = (
        stored_cover_selection_origin
        if stored_cover_selection_origin in {"user", "automatic"}
        else None
    )
    return {
        "key": album.key,
        "album_ref": album_ref,
        "name": album.name,
        "album_artist": _album_artist_display_value(album.album_artist),
        "artists": list(getattr(album, "artists", []) or []),
        "is_compilation": bool(getattr(album, "is_compilation", False)),
        "cover_path": str(album.cover_path) if album.cover_path else None,
        "cover_revision": getattr(album, "cover_revision", None),
        "cover_selection_origin": cover_selection_origin,
        "local_cover_width": getattr(album, "local_cover_width", None),
        "local_cover_height": getattr(album, "local_cover_height", None),
        "remote_cover_url": getattr(album, "remote_cover_url", None),
        "remote_cover_thumbnail_url": getattr(album, "remote_cover_thumbnail_url", None),
        "remote_cover_source": getattr(album, "remote_cover_source", None),
        "remote_cover_source_label": getattr(album, "remote_cover_source_label", None),
        "remote_cover_album_url": getattr(album, "remote_cover_album_url", None),
        "remote_cover_width": getattr(album, "remote_cover_width", None),
        "remote_cover_height": getattr(album, "remote_cover_height", None),
        "year": album.year,
        "release_date": getattr(album, "release_date", None),
        "edition": album.edition,
        "album_rating": int(album.album_rating or 0),
        "album_preference": album_preference,
        "top_viewer_overlay": _top_viewer_overlay_to_dict(),
        "tag_album_rating": tag_album_rating,
        "tag_album_rating_source": tag_album_rating_source,
        "total_duration_seconds": album.total_duration_seconds,
        "total_duration_display": format_duration(album.total_duration_seconds),
        "library_root_id": getattr(album, "library_root_id", None),
        "library_root_category": getattr(album, "library_root_category", None),
        "root_provenance": getattr(album, "root_provenance", None),
        "move_availability": move_availability,
    }


def _album_artist_display_value(value: object) -> str:
    raw_value = str(value or "").strip()
    deduplicated_members = deduplicate_repeated_album_artist_members(raw_value)
    return " / ".join(deduplicated_members) if deduplicated_members else raw_value


def _normalize_album_preview_payload(
    payload: dict[str, object],
    *,
    track_count: int,
    open_directory_paths: list[str],
) -> dict[str, object]:
    album_key = str(payload.get("key") or "").strip()
    payload["album_artist"] = _album_artist_display_value(payload.get("album_artist"))
    payload.setdefault("album_ref", album_key)
    payload.setdefault("artists", list(payload.get("artists") or []))
    payload.setdefault("is_compilation", bool(payload.get("is_compilation", False)))
    payload.setdefault("track_count_preview", track_count)
    payload.setdefault("preview_only", True)
    payload.setdefault("has_duplicate_files", False)
    payload.setdefault("duplicate_sources", [])
    payload.setdefault("tracks", [])
    payload.setdefault("open_directory_paths", list(open_directory_paths))
    payload["album_preference"] = normalize_album_preference_overlay(payload.get("album_preference"))
    payload["top_viewer_overlay"] = normalize_top_viewer_overlay(payload.get("top_viewer_overlay"))
    payload.setdefault("tag_album_rating", _album_tag_rating(payload.get("album_rating")))
    payload.setdefault("tag_album_rating_source", _album_tag_rating_source(payload.get("album_rating")))
    payload["gallery_list_block"] = _build_album_preview_gallery_list_block(
        album_key=payload.get("key"),
        album_name=payload.get("name"),
        album_artist=payload.get("album_artist"),
        album_year=payload.get("year"),
        album_rating=payload.get("album_rating", 0),
        total_duration_seconds=payload.get("total_duration_seconds"),
        track_count=track_count,
        album_preference=payload["album_preference"],
        tag_album_rating=payload.get("tag_album_rating"),
        tag_album_rating_source=payload.get("tag_album_rating_source"),
        gallery_list_block=payload.get("gallery_list_block"),
    )
    return payload


def _apply_album_display_metadata_if_present(
    payload: dict[str, object],
    album: Album | dict[str, object],
) -> dict[str, object]:
    album_display_metadata = build_album_display_metadata_payload(album)
    if has_album_display_metadata_values(album_display_metadata):
        payload["album_display_metadata"] = album_display_metadata
    return payload


def _apply_album_note_seams(
    payload: dict[str, object],
    *,
    album_note_payload: object,
    visible_album_notes_payload: object,
    enabled: bool = True,
) -> dict[str, object]:
    if not enabled:
        return payload
    payload["album_note"] = album_note_payload
    payload["visible_album_notes"] = visible_album_notes_payload
    return payload


def album_preview_to_dict(
    album: Album,
    *,
    public_safe: bool = False,
    include_album_note_seams: bool = True,
    config: object = None,
    viewer_opinion_preferences: object = None,
) -> dict[str, object]:
    if isinstance(album, dict):
        payload = deepcopy(album)
        payload = _normalize_album_preview_payload(
            payload,
            track_count=len(payload.get("tracks") or []),
            open_directory_paths=list(payload.get("open_directory_paths") or []),
        )
        payload = _apply_album_display_metadata_if_present(payload, payload)
        if public_safe:
            return strip_private_album_preference_overlays(payload)
        return payload

    viewer_opinion_preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    cached_signature = getattr(album, "_cached_album_preview_payload_signature", None)
    cached_payload = getattr(album, "_cached_album_preview_payload", None)
    album_note_payload = None
    visible_album_notes_payload = None
    if include_album_note_seams:
        album_note_payload = build_album_note_payload(album, album_ref=getattr(album, "key", None))
        visible_album_notes_payload = build_visible_album_notes_payload(album, album_ref=getattr(album, "key", None))
    resolved_config = config
    move_availability = (
        build_move_availability_payload(album, resolved_config)
        if resolved_config is not None
        else None
    )
    payload_signature = _album_preview_payload_signature(
        album,
        viewer_opinion_preferences=viewer_opinion_preferences,
        include_album_note_seams=include_album_note_seams,
        album_note_payload=album_note_payload,
        visible_album_notes_payload=visible_album_notes_payload,
        move_availability=move_availability,
    )
    if cached_signature == payload_signature and isinstance(cached_payload, dict):
        return _finalize_album_payload_for_viewer(cached_payload, public_safe=public_safe)

    album_ref = str(getattr(album, "key", "") or "").strip()
    album_preference = _album_preference_to_dict()
    tag_album_rating = _album_tag_rating(getattr(album, "album_rating", None))
    tag_album_rating_source = _album_tag_rating_source(getattr(album, "album_rating", None))
    payload = {
        **_build_album_base_payload(
            album,
            album_ref=album_ref,
            album_preference=album_preference,
            tag_album_rating=tag_album_rating,
            tag_album_rating_source=tag_album_rating_source,
            move_availability=move_availability,
        ),
    }
    payload = _normalize_album_preview_payload(
        payload,
        track_count=len(getattr(album, "tracks", []) or []),
        open_directory_paths=_preview_open_directory_paths(album),
    )
    payload = _apply_album_display_metadata_if_present(payload, album)
    payload = _apply_album_note_seams(
        payload,
        album_note_payload=album_note_payload,
        visible_album_notes_payload=visible_album_notes_payload,
        enabled=include_album_note_seams,
    )
    crowd_opinion, friends_opinion, album_popularity = _build_album_opinion_payloads(
        album,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )
    _apply_gallery_summary_opinion_payloads(
        payload["gallery_list_block"],
        crowd_opinion=crowd_opinion,
        friends_opinion=friends_opinion,
        album_popularity=album_popularity,
    )
    setattr(album, "_cached_album_preview_payload_signature", payload_signature)
    setattr(album, "_cached_album_preview_payload", payload)
    return _finalize_album_payload_for_viewer(payload, public_safe=public_safe)


def get_album_duplicate_sources(album: Album) -> list[dict[str, object]]:
    cached_sources = getattr(album, "_cached_duplicate_sources", None)
    if isinstance(cached_sources, list):
        return cached_sources

    ordered_groups = _ordered_album_duplicate_track_groups(getattr(album, "tracks", []) or [])
    if not ordered_groups:
        setattr(album, "_cached_duplicate_sources", [])
        return []

    duplicate_sources: list[dict[str, object]] = []
    for index, (folder_path, tracks) in enumerate(ordered_groups, start=1):
        duplicate_sources.append(
            _build_album_duplicate_source_payload(
                index=index - 1,
                folder_path=folder_path,
                tracks=tracks,
            )
        )

    setattr(album, "_cached_duplicate_sources", duplicate_sources)
    return duplicate_sources


def _ordered_album_duplicate_track_groups(
    tracks: list[Track],
) -> list[tuple[str, list[Track]]]:
    grouped_tracks: dict[str, list[Track]] = {}
    for track in tracks:
        container = _track_album_container(getattr(track, "path", ""))
        if not container:
            return []
        grouped_tracks.setdefault(container, []).append(track)

    if len(grouped_tracks) <= 1:
        return []

    ordered_groups = sorted(
        grouped_tracks.items(),
        key=lambda item: (Path(item[0]).name.casefold(), item[0].casefold()),
    )
    reference_tracks = ordered_groups[0][1]
    if not all(_duplicate_track_groups_match(reference_tracks, candidate_tracks) for _, candidate_tracks in ordered_groups[1:]):
        return []

    return ordered_groups


def _build_album_duplicate_source_payload(
    *,
    index: int,
    folder_path: str,
    tracks: list[Track],
) -> dict[str, object]:
    sorted_tracks = sorted(tracks, key=lambda track: (
        safe_int(getattr(track, "disc_number", None)) or 999,
        safe_int(getattr(track, "track_number", None)) or 999,
        str(getattr(track, "title", "") or "").casefold(),
    ))
    total_duration_seconds = sum(safe_int(getattr(track, "duration_seconds", None)) or 0 for track in sorted_tracks)
    folder_name = Path(folder_path).name or folder_path
    return {
        "index": index,
        "label": str(index + 1),
        "folder_path": folder_path,
        "folder_name": folder_name,
        "track_count": len(sorted_tracks),
        "total_duration_seconds": total_duration_seconds,
        "total_duration_display": format_duration(total_duration_seconds),
        "tracks": [_track_to_dict(track) for track in sorted_tracks],
    }


def _shared_album_bucket_key(entry: dict[str, object]) -> tuple[str, str, str]:
    album_name = repair_display_text(str(entry.get("album") or "")) or str(entry.get("album") or "")
    raw_edition = str(entry.get("edition") or "").strip()
    edition = (repair_display_text(raw_edition) or raw_edition) if raw_edition else ""
    return (_entry_album_container(entry), album_name.strip().casefold(), edition.strip().casefold())


def _normalized_release_date(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.match(r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$", text)
    if not match:
        return ""
    year = match.group(1)
    month = match.group(2) or "99"
    day = match.group(3) or "99"
    return f"{year}-{month}-{day}"


def album_sort_key(album: Album) -> tuple[str, int, str, str]:
    release_date = _normalized_release_date(getattr(album, "release_date", None))
    year = safe_int(getattr(album, "year", None)) or 9999
    name = str(getattr(album, "name", "") or "").casefold()
    return (
        str(getattr(album, "album_artist", "") or "").casefold(),
        year,
        release_date or "9999-99-99",
        name,
    )


_COOPERATIVE_ALBUM_BUILD_MIN_ENTRIES = 1000
_COOPERATIVE_ALBUM_BUILD_YIELD_INTERVAL = 250


def _cooperative_album_build_yield(processed: int, *, enabled: bool) -> None:
    if enabled and processed > 0 and processed % _COOPERATIVE_ALBUM_BUILD_YIELD_INTERVAL == 0:
        time.sleep(0)


def build_albums_from_file_cache(file_cache: dict[str, dict[str, object]], separate_release_keys: set[str] | None = None) -> list[Album]:
    separate_release_keys = separate_release_keys or set()
    albums: dict[str, Album] = {}
    grouped_entries: dict[tuple[str, str, str], list[dict[str, object]]] = {}
    display_text_cache: dict[str, str] = {}
    path_cache: dict[str, Path] = {}
    root_provenance_cache: dict[tuple[str | None, str | None], dict[str, object]] = {}
    cooperative_yields_enabled = len(file_cache) >= _COOPERATIVE_ALBUM_BUILD_MIN_ENTRIES

    def cached_display_text(value: object) -> str:
        raw_value = str(value or "")
        cached = display_text_cache.get(raw_value)
        if cached is not None:
            return cached
        repaired = repair_display_text(raw_value) or raw_value
        display_text_cache[raw_value] = repaired
        return repaired

    def cached_path(value: object) -> Path:
        raw_value = str(value or "")
        cached = path_cache.get(raw_value)
        if cached is None:
            cached = Path(raw_value)
            path_cache[raw_value] = cached
        return cached

    def cached_root_provenance(root_id: object, category: object) -> dict[str, object]:
        normalized_root_id = str(root_id or "").strip() or None
        normalized_category = str(category or "").strip() or None
        cache_key = (normalized_root_id, normalized_category)
        cached = root_provenance_cache.get(cache_key)
        if cached is None:
            cached = build_root_provenance_payload(normalized_root_id, normalized_category)
            root_provenance_cache[cache_key] = cached
        return cached

    for grouping_count, entry in enumerate(file_cache.values(), start=1):
        _cooperative_album_build_yield(grouping_count, enabled=cooperative_yields_enabled)
        if normalize_exception_value(entry.get("exception_type")):
            continue
        album_name = cached_display_text(entry["album"])
        if _is_loose_track_album_value(album_name):
            continue
        grouped_entries.setdefault(_shared_album_bucket_key(entry), []).append(entry)

    construction_count = 0
    for bucket_entries in grouped_entries.values():
        is_compilation, display_album_artist, member_artists = _classify_album_artists(bucket_entries)
        identity_album_artist = display_album_artist
        raw_album_artist_values = [
            _normalize_display_artist_name(entry.get("album_artist")).strip()
            for entry in bucket_entries
            if str(entry.get("album_artist") or "").strip()
        ]
        unique_raw_album_artists = {
            _normalize_artist_key(value)
            for value in raw_album_artist_values
            if value
        }
        if not is_compilation and len(unique_raw_album_artists) == 1:
            raw_album_artist = raw_album_artist_values[0]
            raw_album_artist_members = deduplicate_repeated_album_artist_members(raw_album_artist)
            if (
                raw_album_artist_members == member_artists
                and " / ".join(raw_album_artist_members) == display_album_artist
            ):
                identity_album_artist = raw_album_artist

        for entry in bucket_entries:
            construction_count += 1
            album_name = cached_display_text(entry["album"])
            raw_edition = str(entry.get('edition') or '').strip()
            edition = cached_display_text(raw_edition) if raw_edition else None
            base_key = album_separate_release_key(identity_album_artist, album_name, edition)
            key = _album_key(identity_album_artist, album_name, edition, entry.get("year")) if base_key in separate_release_keys else base_key
            track_root_provenance = cached_root_provenance(
                entry.get("library_root_id"),
                entry.get("library_root_category"),
            )
            if key not in albums:
                cover_value = entry.get("cover_path")
                albums[key] = Album(
                    key=key,
                    name=album_name,
                    album_artist=display_album_artist,
                    artists=list(member_artists),
                    is_compilation=is_compilation,
                    cover_path=Path(cover_value) if cover_value else None,
                    cover_revision=str(entry.get("cover_revision") or "").strip() or None,
                    cover_selection_origin=(
                        str(entry.get("cover_selection_origin") or "").strip().casefold()
                        if str(entry.get("cover_selection_origin") or "").strip().casefold()
                        in {"user", "automatic"}
                        else None
                    ),
                    local_cover_width=safe_int(entry.get("local_cover_width")),
                    local_cover_height=safe_int(entry.get("local_cover_height")),
                    remote_cover_url=str(entry.get("remote_cover_url") or "").strip() or None,
                    remote_cover_thumbnail_url=str(entry.get("remote_cover_thumbnail_url") or "").strip() or None,
                    remote_cover_source=str(entry.get("remote_cover_source") or "").strip() or None,
                    remote_cover_source_label=str(entry.get("remote_cover_source_label") or "").strip() or None,
                    remote_cover_album_url=str(entry.get("remote_cover_album_url") or "").strip() or None,
                    remote_cover_width=safe_int(entry.get("remote_cover_width")),
                    remote_cover_height=safe_int(entry.get("remote_cover_height")),
                    year=safe_int(entry.get("year")),
                    release_date=str(entry.get("release_date") or "").strip() or None,
                    edition=edition,
                    album_rating=safe_int(entry.get("album_rating")),
                    library_root_id=str(entry.get("library_root_id") or "").strip() or None,
                    library_root_category=str(entry.get("library_root_category") or "").strip() or None,
                    root_provenance=track_root_provenance,
                )
                setattr(albums[key], "_root_provenance_keys", {
                    (
                        track_root_provenance.get("root_id"),
                        track_root_provenance.get("category"),
                    )
                })
                setattr(albums[key], "_root_provenance_payloads", [track_root_provenance])
            duration = safe_int(entry.get("duration_seconds")) or 0
            album = albums[key]
            album.total_duration_seconds += duration
            if album.year is None:
                album.year = safe_int(entry.get("year"))
            if not getattr(album, "release_date", None) and entry.get("release_date"):
                album.release_date = str(entry.get("release_date")).strip() or None
            if album.edition is None and entry.get('edition'):
                album.edition = str(entry.get('edition')).strip() or None
            if album.album_rating is None:
                album.album_rating = safe_int(entry.get("album_rating"))
            if album.cover_path is None and entry.get("cover_path"):
                album.cover_path = Path(str(entry["cover_path"]))
            if not getattr(album, "cover_revision", None) and entry.get("cover_revision"):
                album.cover_revision = str(entry.get("cover_revision") or "").strip() or None
            if not getattr(album, "cover_selection_origin", None):
                candidate_origin = str(
                    entry.get("cover_selection_origin") or ""
                ).strip().casefold()
                if candidate_origin in {"user", "automatic"}:
                    album.cover_selection_origin = candidate_origin
            if getattr(album, "local_cover_width", None) is None:
                album.local_cover_width = safe_int(entry.get("local_cover_width"))
            if getattr(album, "local_cover_height", None) is None:
                album.local_cover_height = safe_int(entry.get("local_cover_height"))
            if not getattr(album, "remote_cover_url", None) and entry.get("remote_cover_url"):
                album.remote_cover_url = str(entry.get("remote_cover_url") or "").strip() or None
                album.remote_cover_thumbnail_url = str(entry.get("remote_cover_thumbnail_url") or "").strip() or None
                album.remote_cover_source = str(entry.get("remote_cover_source") or "").strip() or None
                album.remote_cover_source_label = str(entry.get("remote_cover_source_label") or "").strip() or None
                album.remote_cover_album_url = str(entry.get("remote_cover_album_url") or "").strip() or None
                album.remote_cover_width = safe_int(entry.get("remote_cover_width"))
                album.remote_cover_height = safe_int(entry.get("remote_cover_height"))
            root_provenance_keys = getattr(album, "_root_provenance_keys", set())
            root_provenance_payloads = getattr(album, "_root_provenance_payloads", [])
            track_root_key = (
                track_root_provenance.get("root_id"),
                track_root_provenance.get("category"),
            )
            if track_root_key not in root_provenance_keys:
                root_provenance_keys.add(track_root_key)
                root_provenance_payloads.append(track_root_provenance)
                setattr(album, "_root_provenance_keys", root_provenance_keys)
                setattr(album, "_root_provenance_payloads", root_provenance_payloads)
            if not getattr(album, "library_root_id", None):
                album.library_root_id = str(entry.get("library_root_id") or "").strip() or None
            if not getattr(album, "library_root_category", None):
                album.library_root_category = str(entry.get("library_root_category") or "").strip() or None
            album.tracks.append(Track(
                path=cached_path(entry["path"]), title=cached_display_text(entry["title"]),
                track_number=safe_int(entry.get("track_number")), disc_number=safe_int(entry.get("disc_number")),
                disc_number_raw=str(entry.get("disc_number_raw")) if entry.get("disc_number_raw") else None,
                artist=cached_display_text(entry["artist"]) if entry.get("artist") else None,
                album=album_name,
                album_artist=cached_display_text(entry["album_artist"]),
                genre=str(entry.get("genre") or "").strip() or None,
                year=safe_int(entry.get("year")),
                release_date=str(entry.get("release_date") or "").strip() or None,
                edition=str(entry.get("edition")).strip() if entry.get("edition") else None,
                album_rating=safe_int(entry.get("album_rating")),
                exception_type=normalize_exception_value(entry.get("exception_type")) or None,
                cover_path=cached_path(entry["cover_path"]) if entry.get("cover_path") else None,
                cover_revision=str(entry.get("cover_revision") or "").strip() or None,
                local_cover_width=safe_int(entry.get("local_cover_width")),
                local_cover_height=safe_int(entry.get("local_cover_height")),
                remote_cover_url=str(entry.get("remote_cover_url") or "").strip() or None,
                remote_cover_thumbnail_url=str(entry.get("remote_cover_thumbnail_url") or "").strip() or None,
                remote_cover_source=str(entry.get("remote_cover_source") or "").strip() or None,
                remote_cover_source_label=str(entry.get("remote_cover_source_label") or "").strip() or None,
                remote_cover_album_url=str(entry.get("remote_cover_album_url") or "").strip() or None,
                remote_cover_width=safe_int(entry.get("remote_cover_width")),
                remote_cover_height=safe_int(entry.get("remote_cover_height")),
                duration_seconds=safe_int(entry.get("duration_seconds")),
                library_root_id=str(entry.get("library_root_id") or "").strip() or None,
                library_root_category=str(entry.get("library_root_category") or "").strip() or None,
                root_provenance=track_root_provenance,
            ))
            _cooperative_album_build_yield(construction_count, enabled=cooperative_yields_enabled)

    album_list = list(albums.values())
    for finalization_count, album in enumerate(album_list, start=1):
        root_provenance_payloads = getattr(album, "_root_provenance_payloads", None)
        if isinstance(root_provenance_payloads, list):
            album.root_provenance = summarize_root_provenance_payloads(root_provenance_payloads)
        album.tracks.sort(key=lambda t: (
            t.disc_number if t.disc_number is not None else 999,
            t.track_number if t.track_number is not None else 999,
            t.title.lower(),
        ))
        _cooperative_album_build_yield(finalization_count, enabled=cooperative_yields_enabled)
    album_list.sort(key=album_sort_key)
    return album_list


def album_to_dict(
    album: Album,
    *,
    public_safe: bool = False,
    client_surface_class: object = None,
    config: object = None,
    viewer_opinion_preferences: object = None,
) -> dict[str, object]:
    client_surface_class = resolve_client_surface_class(client_surface_class)
    viewer_opinion_preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    duplicate_sources, move_availability = _build_album_detail_setup_payloads(album, config=config)
    cached_signature = getattr(album, "_cached_album_payload_signature", None)
    cached_payload = getattr(album, "_cached_album_payload", None)
    album_note_payload = build_album_note_payload(album, album_ref=getattr(album, "key", None))
    visible_album_notes_payload = build_visible_album_notes_payload(album, album_ref=getattr(album, "key", None))
    payload_signature = _album_payload_signature(
        album,
        client_surface_class=client_surface_class,
        viewer_opinion_preferences=viewer_opinion_preferences,
        move_availability=move_availability,
        album_note_payload=album_note_payload,
        visible_album_notes_payload=visible_album_notes_payload,
    )
    if cached_signature == payload_signature and isinstance(cached_payload, dict):
        return _finalize_album_payload_for_viewer(cached_payload, public_safe=public_safe)

    tracks_payload, track_rows = _build_album_detail_track_payloads(
        album,
        client_surface_class=client_surface_class,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )
    album_ref = str(getattr(album, "key", "") or "").strip()
    album_preference = _album_preference_to_dict()
    tag_album_rating = _album_tag_rating(getattr(album, "album_rating", None))
    tag_album_rating_source = _album_tag_rating_source(getattr(album, "album_rating", None))
    payload = {
        **_build_album_base_payload(
            album,
            album_ref=album_ref,
            album_preference=album_preference,
            tag_album_rating=tag_album_rating,
            tag_album_rating_source=tag_album_rating_source,
            move_availability=move_availability,
        ),
        **build_album_page_seam(getattr(album, "key", None)),
        "has_duplicate_files": bool(duplicate_sources),
        "duplicate_sources": duplicate_sources,
        "tracks": tracks_payload,
        "track_rows": track_rows,
    }
    payload = _apply_album_display_metadata_if_present(payload, album)
    (
        payload["crowd_opinion"],
        payload["friends_opinion"],
        payload["album_popularity"],
    ) = _build_album_opinion_payloads(
        album,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )
    payload["gallery_list_block"] = _build_album_detail_gallery_list_block(
        album,
        track_rows=track_rows,
        album_preference=album_preference,
        tag_album_rating=tag_album_rating,
        tag_album_rating_source=tag_album_rating_source,
        crowd_opinion=payload["crowd_opinion"],
        friends_opinion=payload["friends_opinion"],
        album_popularity=payload["album_popularity"],
    )
    payload = _apply_album_note_seams(
        payload,
        album_note_payload=album_note_payload,
        visible_album_notes_payload=visible_album_notes_payload,
    )
    setattr(album, "_cached_album_payload_signature", payload_signature)
    setattr(album, "_cached_album_payload", payload)
    return _finalize_album_payload_for_viewer(payload, public_safe=public_safe)


def shared_album_display_artist(
    album: Album | dict[str, object],
    alias_to_canonical: dict[str, str] | None = None,
) -> str:
    alias_to_canonical = alias_to_canonical or {}
    if isinstance(album, dict):
        combined_artist = str(album.get("album_artist") or "").strip()
        is_compilation = bool(album.get("is_compilation", False))
        members = list(album.get("artists") or [])
    else:
        combined_artist = str(getattr(album, "album_artist", "") or "").strip()
        is_compilation = bool(getattr(album, "is_compilation", False))
        members = list(getattr(album, "artists", []) or [])
    if not is_compilation or _is_various_artist(combined_artist):
        return combined_artist

    canonical_members: list[str] = []
    seen = set()
    for member in members:
        artist = str(member or "").strip()
        if not artist:
            continue
        canonical = str(alias_to_canonical.get(artist, artist) or "").strip()
        canonical_key = _normalize_artist_key(canonical)
        if not canonical or canonical_key in seen:
            continue
        seen.add(canonical_key)
        canonical_members.append(canonical)
    if len(canonical_members) >= 2:
        return _format_shared_album_artist(canonical_members)
    return str(alias_to_canonical.get(combined_artist, combined_artist) or combined_artist).strip()


def build_artist_groups(
    albums: list[Album],
    alias_to_canonical: dict[str, str] | None = None,
    canonical_to_aliases: dict[str, list[str]] | None = None,
    *,
    album_serializer=None,
) -> list[dict[str, object]]:
    alias_to_canonical = alias_to_canonical or {}
    canonical_to_aliases = canonical_to_aliases or {}
    serializer = album_serializer or album_to_dict
    groups: dict[str, list[Album]] = {}
    for album in albums:
        album_artist = (
            str(album.get("album_artist") or "").strip()
            if isinstance(album, dict)
            else str(getattr(album, "album_artist", "") or "").strip()
        )
        is_compilation = (
            bool(album.get("is_compilation", False))
            if isinstance(album, dict)
            else bool(getattr(album, "is_compilation", False))
        )
        if is_compilation and not _is_various_artist(album_artist):
            artist = shared_album_display_artist(album, alias_to_canonical)
        else:
            artist = alias_to_canonical.get(album_artist, album_artist)
        groups.setdefault(artist, []).append(album)
    artist_groups = []
    for artist in sorted(groups, key=lambda value: value.lower()):
        aliases = canonical_to_aliases.get(artist, [artist]) or [artist]
        display_names = []
        seen = set()
        ordered_aliases = []
        if artist:
            ordered_aliases.append(artist)
        ordered_aliases.extend(name for name in aliases if name != artist)
        for name in ordered_aliases:
            text = str(name or "").strip()
            if not text:
                continue
            if text != artist and _is_collaboration_variant(text, artist):
                continue
            key = _normalize_artist_key(text)
            if key in seen:
                continue
            seen.add(key)
            display_names.append(text)
        artist_groups.append({
            "artist": artist,
            "artist_display": " / ".join(display_names) if display_names else artist,
            "albums": [serializer(album) for album in groups[artist]],
        })
    return artist_groups
