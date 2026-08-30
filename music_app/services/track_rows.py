from __future__ import annotations

import re
from collections.abc import Iterable

from music_app.services.opinion_read_seams import (
    build_track_popularity_payload,
    resolve_viewer_opinion_preferences,
)
from music_app.services.listen_through import (
    default_album_preference_overlay,
    normalize_album_preference_overlay,
)
from music_app.services.track_playback import track_playback_state_from_source
from music_app.services.track_preferences import (
    track_preference_matches_favorite_song_projection,
    track_preference_can_edit,
    track_preference_overlay_from_source,
)
from music_app.services.source_helpers import field_from_source
from music_app.services.track_stats import track_scrobble_count_from_source
from music_app.services.utils import format_duration, safe_int


_field = field_from_source


_FEATURED_CREDIT_MARKER = r"feat\.?|feature|featured|featuring"
_BRACKETED_FEATURED_CREDIT_RE = re.compile(
    rf"^(?P<primary>.+?)\s*(?:\(|\[)\s*(?:{_FEATURED_CREDIT_MARKER})\s+"
    r"(?P<featured>[^()\[\]]+?)\s*(?:\)|\])\s*$",
    flags=re.IGNORECASE,
)
_SEPARATED_FEATURED_CREDIT_RE = re.compile(
    rf"^(?P<primary>.+?)\s+[-\N{{EN DASH}}\N{{EM DASH}}]\s+"
    rf"(?:{_FEATURED_CREDIT_MARKER})\s+(?P<featured>.+?)\s*$",
    flags=re.IGNORECASE,
)
_PLAIN_EXPLICIT_FEATURED_CREDIT_RE = re.compile(
    r"^(?P<primary>.+?)\s+feat\.?\s+(?P<featured>.+?)\s*$",
    flags=re.IGNORECASE,
)
_PLAIN_FULL_WORD_FEATURED_CREDIT_RE = re.compile(
    r"^(?P<primary>.+?)\s+(?:feature|featured|featuring)\s+(?P<featured>.+?)\s*$",
    flags=re.IGNORECASE,
)
_LOWERCASE_PLAIN_FULL_WORD_FEATURED_CREDIT_RE = re.compile(
    r"^(?P<primary>.+?)\s+(?:feature|featured|featuring)\s+(?P<featured>.+?)\s*$",
)
_STABLE_ARTIST_COMPOSITE_RE = re.compile(r"\s+/\s+")


def _normalize_artist_key(value: object) -> str:
    return " ".join(str(value or "").strip().split()).casefold()


def _extract_terminal_featured_credit(
    value: object,
    *,
    allow_plain_full_words: bool = False,
) -> tuple[str, str | None]:
    text = " ".join(str(value or "").strip().split())
    if not text:
        return "", None
    patterns = [
        _BRACKETED_FEATURED_CREDIT_RE,
        _SEPARATED_FEATURED_CREDIT_RE,
        _PLAIN_EXPLICIT_FEATURED_CREDIT_RE,
    ]
    if allow_plain_full_words:
        patterns.append(_PLAIN_FULL_WORD_FEATURED_CREDIT_RE)
    for pattern in patterns:
        match = pattern.fullmatch(text)
        if match is None:
            continue
        primary = str(match.group("primary") or "").strip()
        featured = str(match.group("featured") or "").strip()
        if primary and featured:
            return primary, featured
    return text, None


def _stable_artist_credit_members(value: object) -> list[str]:
    text = " ".join(str(value or "").strip().split())
    if not text:
        return []
    return [member.strip() for member in _STABLE_ARTIST_COMPOSITE_RE.split(text) if member.strip()]


def _stable_unique_artist_credits(values: Iterable[object]) -> list[str]:
    credits: list[str] = []
    seen: set[str] = set()
    for value in values:
        credit = " ".join(str(value or "").strip().split())
        normalized = _normalize_artist_key(credit)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        credits.append(credit)
    return credits


def _track_row_display_values(track: object, *, album: object = None) -> tuple[object, str | None]:
    raw_title = _field(track, "title", None)
    track_artist = str(_field(track, "artist", "") or "").strip()
    album_artist = str(
        (_field(album, "album_artist", "") if album is not None else _field(track, "album_artist", ""))
        or ""
    ).strip()
    artist_credits: list[object] = []
    featured_artist_keys: set[str] = set()
    corroborating_artist_credits: list[object] = []
    if track_artist and _normalize_artist_key(track_artist) != _normalize_artist_key(album_artist):
        for track_artist_member in _stable_artist_credit_members(track_artist):
            primary_track_artist, track_featured_artist = _extract_terminal_featured_credit(
                track_artist_member,
            )
            corroborating_artist_credits.append(primary_track_artist)
            if _normalize_artist_key(primary_track_artist) != _normalize_artist_key(album_artist):
                artist_credits.append(primary_track_artist)
            if track_featured_artist:
                corroborating_artist_credits.append(track_featured_artist)
                artist_credits.append(track_featured_artist)
                featured_artist_keys.add(_normalize_artist_key(track_featured_artist))
    title, title_featured_artist = _extract_terminal_featured_credit(raw_title)
    if title_featured_artist is None:
        contextual_title, contextual_featured_artist = _extract_terminal_featured_credit(
            raw_title,
            allow_plain_full_words=True,
        )
        corroborating_credits = _stable_unique_artist_credits(corroborating_artist_credits)
        contextual_featured_key = _normalize_artist_key(contextual_featured_artist)
        normalized_raw_title = " ".join(str(raw_title or "").strip().split())
        has_lowercase_plain_marker = (
            _LOWERCASE_PLAIN_FULL_WORD_FEATURED_CREDIT_RE.fullmatch(normalized_raw_title)
            is not None
        )
        has_single_distinct_primary_artist = (
            len(corroborating_credits) == 1
            and _normalize_artist_key(corroborating_credits[0])
            == _normalize_artist_key(track_artist)
            and contextual_featured_key
            not in {
                _normalize_artist_key(track_artist),
                _normalize_artist_key(album_artist),
            }
        )
        has_matching_album_artist_with_distinct_guest = (
            _normalize_artist_key(track_artist)
            and _normalize_artist_key(track_artist) == _normalize_artist_key(album_artist)
            and contextual_featured_key
            not in {
                _normalize_artist_key(track_artist),
                _normalize_artist_key(album_artist),
            }
        )
        has_corroborated_multi_credit = (
            contextual_featured_artist
            and len(corroborating_credits) >= 2
            and _normalize_artist_key(corroborating_credits[-1]) == contextual_featured_key
            and any(
                _normalize_artist_key(credit) != contextual_featured_key
                for credit in corroborating_credits[:-1]
            )
        )
        if contextual_featured_artist and (
            (has_lowercase_plain_marker and has_single_distinct_primary_artist)
            or (has_lowercase_plain_marker and has_matching_album_artist_with_distinct_guest)
            or has_corroborated_multi_credit
        ):
            title = contextual_title
            title_featured_artist = contextual_featured_artist
    if title_featured_artist:
        title_featured_key = _normalize_artist_key(title_featured_artist)
        featured_artist_keys.add(title_featured_key)
        if title_featured_key not in {
            _normalize_artist_key(track_artist),
            _normalize_artist_key(album_artist),
        }:
            artist_credits.append(title_featured_artist)
    secondary_artists = _stable_unique_artist_credits(artist_credits)
    secondary_artist_labels = [
        f"feat. {artist}"
        if _normalize_artist_key(artist) in featured_artist_keys
        else artist
        for artist in secondary_artists
    ]
    display_title = title if title else raw_title
    persisted_secondary_credit = " ".join(
        str(_field(track, "secondary_credit", "") or "").strip().split()
    )
    if persisted_secondary_credit:
        return display_title, persisted_secondary_credit
    return display_title, (" / ".join(secondary_artist_labels) if secondary_artist_labels else None)


def build_track_title_display_payload() -> dict[str, object]:
    return {
        "active_mode": "local_tags",
        "supported_modes": ["local_tags", "provider_title"],
        "provider_title": None,
        "provider_title_state": "unavailable",
        "mismatch_state": "hidden",
        "apply_provider_to_tags_action": {
            "is_available": False,
            "action_kind": "apply_provider_title_to_tags",
            "request_route": None,
            "request_method": None,
            "action_state": "noop",
        },
    }


def track_secondary_artist(track: object, *, album: object = None) -> str | None:
    _display_title, secondary_artist = _track_row_display_values(track, album=album)
    return secondary_artist


def build_track_row_payload(
    track: object,
    *,
    album: object = None,
    scrobble_count_resolver=None,
    track_preference_resolver=None,
    client_surface_class: object = None,
    viewer_opinion_preferences: object = None,
) -> dict[str, object]:
    track_path = str(_field(track, "path", "") or "")
    duration_seconds = safe_int(_field(track, "duration_seconds", None)) or 0
    display_title, secondary_artist = _track_row_display_values(track, album=album)
    if callable(track_preference_resolver):
        resolved_track_preference = track_preference_resolver(track)
    else:
        resolved_track_preference = None
    track_preference = (
        resolved_track_preference
        if isinstance(resolved_track_preference, dict)
        else track_preference_overlay_from_source(
            track,
            client_surface_class=client_surface_class,
        )
    )
    playback_state = track_playback_state_from_source(track)
    if callable(scrobble_count_resolver):
        scrobble_count = max(0, safe_int(scrobble_count_resolver(track)) or 0)
    else:
        scrobble_count = track_scrobble_count_from_source(track)
    resolved_viewer_opinion_preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    return {
        "track_ref": track_path,
        "path": track_path,
        "track_number": safe_int(_field(track, "track_number", None)),
        "disc_number": safe_int(_field(track, "disc_number", None)),
        "disc_number_raw": _field(track, "disc_number_raw", None),
        "title": display_title,
        "secondary_artist": secondary_artist,
        "title_display": build_track_title_display_payload(),
        "duration_seconds": duration_seconds,
        "duration_display": format_duration(duration_seconds),
        "track_preference": track_preference,
        "track_stats": {
            "scrobble_count": scrobble_count,
        },
        "track_popularity": build_track_popularity_payload(
            track,
            viewer_opinion_preferences=resolved_viewer_opinion_preferences,
        ),
        "playback_state": playback_state,
        "can_edit_preferences": track_preference_can_edit(
            track_preference,
            client_surface_class=client_surface_class,
        ),
    }


def build_track_rows(
    tracks: Iterable[object],
    *,
    album: object = None,
    scrobble_count_resolver=None,
    track_preference_resolver=None,
    client_surface_class: object = None,
    viewer_opinion_preferences: object = None,
) -> list[dict[str, object]]:
    return [
        build_track_row_payload(
            track,
            album=album,
            scrobble_count_resolver=scrobble_count_resolver,
            track_preference_resolver=track_preference_resolver,
            client_surface_class=client_surface_class,
            viewer_opinion_preferences=viewer_opinion_preferences,
        )
        for track in tracks
    ]


def build_favorite_song_track_rows(
    tracks: Iterable[object],
    *,
    love_tier: object = None,
    scrobble_count_resolver=None,
    client_surface_class: object = None,
    viewer_opinion_preferences: object = None,
) -> list[dict[str, object]]:
    favorite_tracks = []
    for track in tracks:
        track_preference = track_preference_overlay_from_source(
            track,
            client_surface_class=client_surface_class,
        )
        if not track_preference_matches_favorite_song_projection(
            track_preference,
            love_tier=love_tier,
            client_surface_class=client_surface_class,
        ):
            continue
        favorite_tracks.append(track)
    return build_track_rows(
        favorite_tracks,
        scrobble_count_resolver=scrobble_count_resolver,
        client_surface_class=client_surface_class,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )


def build_playlist_track_row_payload(
    track: object,
    *,
    scrobble_count_resolver=None,
    client_surface_class: object = None,
    viewer_opinion_preferences: object = None,
) -> dict[str, object]:
    payload = build_track_row_payload(
        track,
        scrobble_count_resolver=scrobble_count_resolver,
        client_surface_class=client_surface_class,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )
    return {
        "playlist_item_id": _field(track, "playlist_item_id", None),
        "playlist_position": safe_int(_field(track, "playlist_position", None)),
        "album_title": _field(track, "album_title", None),
        **payload,
    }


def build_playlist_track_rows(
    tracks: Iterable[object],
    *,
    scrobble_count_resolver=None,
    client_surface_class: object = None,
    viewer_opinion_preferences: object = None,
) -> list[dict[str, object]]:
    return [
        build_playlist_track_row_payload(
            track,
            scrobble_count_resolver=scrobble_count_resolver,
            client_surface_class=client_surface_class,
            viewer_opinion_preferences=viewer_opinion_preferences,
        )
        for track in tracks
    ]


def build_album_gallery_list_block(
    *,
    album_key: object,
    album_name: object,
    album_artist: object,
    album_year: object,
    album_rating: object,
    total_duration_seconds: object,
    track_count: int,
    track_rows: list[dict[str, object]],
    track_rows_source: str,
    album_preference: dict[str, object] | None = None,
    tag_album_rating: object = None,
    tag_album_rating_source: object = None,
) -> dict[str, object]:
    normalized_total_duration_seconds = safe_int(total_duration_seconds) or 0
    return {
        "block_kind": "album",
        "album_key": str(album_key or "").strip(),
        "summary": {
            "title": album_name,
            "album_artist": album_artist,
            "year": album_year,
            "album_rating": int(album_rating or 0),
            "album_preference": normalize_album_preference_overlay(album_preference),
            "tag_album_rating": tag_album_rating,
            "tag_album_rating_source": tag_album_rating_source,
            "track_count": track_count,
            "total_duration_seconds": normalized_total_duration_seconds,
            "total_duration_display": format_duration(normalized_total_duration_seconds),
        },
        "track_rows_source": track_rows_source,
        "track_rows": list(track_rows),
        "trailing_divider": {
            "total_duration_seconds": normalized_total_duration_seconds,
            "total_duration_display": format_duration(normalized_total_duration_seconds),
        },
    }
