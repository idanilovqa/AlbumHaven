from __future__ import annotations

import re

from music_app.services.artist_alias_views import enrich_casefold_artist_alias_views as _enrich_casefold_artist_alias_views
from music_app.services.artist_sidebar import (
    album_member_artists as _album_member_artists,
    album_sidebar_artists as _album_sidebar_artists,
    artist_display_dedupe_key as _artist_display_dedupe_key,
    is_shared_artist_album as _is_shared_artist_album,
    is_various_album as _is_various_album,
)
from music_app.services.library import album_preview_to_dict, album_to_dict, build_artist_groups, shared_album_display_artist
from music_app.services.non_album_view_payloads import is_loose_track_album_value
from music_app.services.selected_artist_membership import (
    album_matches_group_artist as _album_matches_group_artist,
    cached_album_matches_group_artist as _service_cached_album_matches_group_artist,
    build_group_artist_display as _service_build_group_artist_display,
    build_artist_membership_groups as _service_build_artist_membership_groups,
    merge_duplicate_artist_groups as _service_merge_duplicate_artist_groups,
    preferred_group_artist_from_albums as _service_preferred_group_artist_from_albums,
    selected_artist_family_artists as _selected_artist_family_artists,
)
from music_app.services.view_search import (
    album_track_matches_query,
    artist_alias_matches_query,
    artist_match_rank,
    artist_search_buckets,
    resolve_requested_artist,
    search_term_matches_field,
    search_terms_match_fields,
    split_search_terms,
)

_UNKNOWN_VALUES = {"", "unknown", "unknown artist", "unknown album", "none", "null"}


def _has_meaningful_album_name(value: object) -> bool:
    text = str(value or "").strip()
    return bool(text and text.casefold() not in _UNKNOWN_VALUES)


def _is_loose_track_album_value(value: object) -> bool:
    return is_loose_track_album_value(value)


def _album_matches_artist(album, artist: str, alias_to_canonical: dict[str, str]) -> bool:
    target = str(artist or "").strip()
    if not target:
        return False
    raw_album_artist = str(getattr(album, "album_artist", "") or "").strip()
    if raw_album_artist and target == raw_album_artist:
        return True
    if _is_shared_artist_album(album) and not _is_various_album(album):
        shared_artist = shared_album_display_artist(album, alias_to_canonical)
        if shared_artist and target == shared_artist:
            return True
    return target in _album_member_artists(album, alias_to_canonical)


def _album_group_match_cache_key(album, artist: str) -> tuple[str, str]:
    album_key = str(getattr(album, "key", "") or "").strip()
    if not album_key:
        album_key = str(id(album))
    return album_key, str(artist or "").strip()


def _cached_album_matches_group_artist(
    album,
    artist: str,
    alias_to_canonical: dict[str, str],
    match_cache: dict[tuple[str, str], bool] | None = None,
) -> bool:
    return _service_cached_album_matches_group_artist(
        album,
        artist,
        alias_to_canonical,
        match_cache,
    )


def _album_payload_cache_key(album) -> str:
    """Return the stable cache key used for serialized album payload previews."""
    album_key = str(getattr(album, "key", "") or "").strip()
    return album_key or str(id(album))


def _build_artist_membership_groups(
    albums,
    artists: list[str],
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
    *,
    exclude_album_keys: set[str] | None = None,
    exact_group_matches: bool = False,
    album_group_match_cache: dict[tuple[str, str], bool] | None = None,
    album_payload_cache: dict[str, dict[str, object]] | None = None,
    album_serializer=None,
) -> list[dict[str, object]]:
    """Delegate grouped artist payload building to the membership service."""
    matches_group_artist = (
        lambda album, artist: _cached_album_matches_group_artist(
            album,
            artist,
            alias_to_canonical,
            album_group_match_cache,
        )
    ) if exact_group_matches else None

    return _service_build_artist_membership_groups(
        albums,
        artists,
        alias_to_canonical,
        canonical_to_aliases,
        exclude_album_keys=exclude_album_keys,
        exact_group_matches=exact_group_matches,
        matches_group_artist_for_album=matches_group_artist,
        album_payload_cache=album_payload_cache,
        album_serializer=album_serializer,
        build_group_artist_display=_build_group_artist_display,
    )

def _build_group_artist_display(
    artist: str,
    artist_display: object,
    albums: list[object] | None = None,
) -> str:
    """Delegate grouped artist display selection to the membership service."""
    return _service_build_group_artist_display(artist, artist_display, albums)


def _preferred_group_artist_from_albums(artist: str, albums: list[object] | None = None) -> str:
    """Delegate preferred grouped artist name selection to the membership service."""
    return _service_preferred_group_artist_from_albums(artist, albums)


def _merge_duplicate_artist_groups(groups: list[dict[str, object]]) -> list[dict[str, object]]:
    """Delegate duplicate grouped artist merging to the membership service."""
    return _service_merge_duplicate_artist_groups(groups)


