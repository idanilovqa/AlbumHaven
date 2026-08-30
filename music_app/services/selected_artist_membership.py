from __future__ import annotations

import re

from music_app.services.artist_alias_views import artist_casefold_key, prefer_group_artist_name
from music_app.services.artist_sidebar import artist_display_dedupe_key
from music_app.services.artist_sidebar import (
    album_member_artists,
    is_shared_artist_album,
    is_various_album,
)
from music_app.services.library import album_preview_to_dict, album_sort_key, shared_album_display_artist

_WORD_COLLAB_MARKER_RE = re.compile(r"\b(?:feat|featuring|with|vs|x)\b", re.IGNORECASE)
_FEATURED_ALIAS_SUFFIX_RE = re.compile(
    r"^feat(?:\.|uring)?(?:\s|$)",
    re.IGNORECASE,
)
_SYMBOL_COLLAB_MARKERS = (" & ", " / ", ";")
_SYMBOL_COLLAB_PREFIX_MARKERS = ("&", "/", ";")


def _merge_group_display_names(*names: object) -> str:
    """Merge artist display names while preserving order and literal slashes."""
    ordered: list[str] = []
    seen: set[str] = set()
    for raw_name in names:
        for part in str(raw_name or "").split(" / "):
            text = str(part or "").strip()
            dedupe_key = artist_casefold_key(text) or text.casefold()
            if not text or not dedupe_key or dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            ordered.append(text)

    if not ordered:
        return ""
    if len(ordered) == 1:
        return ordered[0]
    return " / ".join(ordered)


def _payload_album_value(album: object, field: str) -> object:
    """Read an album field from either dict-style payloads or model objects."""
    if isinstance(album, dict):
        return album.get(field)
    return getattr(album, field, None)


def _contains_collaboration_marker(value: object) -> bool:
    """Return whether a value contains a collaboration separator or whole-word marker."""
    text = str(value or "").strip()
    if not text:
        return False
    normalized = f" {text.casefold()} "
    return bool(_WORD_COLLAB_MARKER_RE.search(text)) or any(
        marker in normalized for marker in _SYMBOL_COLLAB_MARKERS
    )


def _starts_with_collaboration_marker(value: object) -> bool:
    """Return whether a value starts with a collaboration marker suffix."""
    text = str(value or "").strip()
    if not text:
        return False
    if any(text.startswith(marker) for marker in _SYMBOL_COLLAB_PREFIX_MARKERS):
        return True
    return bool(re.match(r"^(?:feat|featuring|with|vs|x)\b", text, re.IGNORECASE))


def _featured_alias_of(value: object, base: object) -> bool:
    """Return whether a value is a feature credit prefixed by the base artist."""
    value_key = " ".join(str(value or "").strip().casefold().split())
    base_key = " ".join(str(base or "").strip().casefold().split())
    if not value_key or not base_key or value_key == base_key:
        return False
    if not value_key.startswith(base_key):
        return False
    remainder = value_key[len(base_key):].strip()
    return bool(_FEATURED_ALIAS_SUFFIX_RE.match(remainder))


def _group_album_sort_key(album: object) -> tuple[int, str, str]:
    """Build a stable group sort key from album year, release date, and name."""
    release_date = str(_payload_album_value(album, "release_date") or "").strip()
    normalized_release_date = (
        re.sub(
            r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$",
            lambda match: f"{match.group(1)}-{match.group(2) or '99'}-{match.group(3) or '99'}",
            release_date,
        )
        if release_date
        else ""
    )
    year_value = _payload_album_value(album, "year")
    try:
        year = int(year_value)
    except (TypeError, ValueError):
        year = 9999
    return (
        year,
        normalized_release_date or "9999-99-99",
        str(_payload_album_value(album, "name") or "").casefold(),
    )


def selected_artist_family_artists(
    selected_artist: str,
    related_artists: list[str],
    canonical_to_aliases: dict[str, list[str]],
    alias_to_canonical: dict[str, str],
) -> list[str]:
    """Return the selected artist's aliases followed by deduped related artists."""
    selected_text = str(selected_artist or "").strip()
    if not selected_text:
        return []

    selected_dedupe_key = artist_display_dedupe_key(selected_text)
    selected_canonical = str(alias_to_canonical.get(selected_text, selected_text) or "").strip()
    ordered: list[str] = []
    seen = {selected_dedupe_key}

    for alias in canonical_to_aliases.get(selected_canonical, []) or []:
        alias_text = str(alias or "").strip()
        alias_key = artist_display_dedupe_key(alias_text)
        if (
            not alias_text
            or alias_key in seen
            or _featured_alias_of(alias_text, selected_canonical)
        ):
            continue
        ordered.append(alias_text)
        seen.add(alias_key)

    for artist in related_artists or []:
        artist_text = str(artist or "").strip()
        artist_key = artist_display_dedupe_key(artist_text)
        if (
            not artist_text
            or artist_key in seen
            or _featured_alias_of(artist_text, selected_canonical)
        ):
            continue
        ordered.append(artist_text)
        seen.add(artist_key)

    return ordered


def collaboration_alias_of(value: object, base: object) -> bool:
    """Return whether a value is a collaboration-form alias of the base artist."""
    value_key = " ".join(str(value or "").strip().casefold().split())
    base_key = " ".join(str(base or "").strip().casefold().split())
    if not value_key or not base_key or value_key == base_key:
        return False
    if not value_key.startswith(base_key):
        return False
    remainder = value_key[len(base_key):].strip()
    return _starts_with_collaboration_marker(remainder)


def album_matches_group_artist(
    album,
    artist: str,
    alias_to_canonical: dict[str, str],
) -> bool:
    """Return whether an album belongs to the requested group artist."""
    target = str(artist or "").strip()
    if not target:
        return False
    target_dedupe_key = artist_display_dedupe_key(target)
    raw_album_artist = str(getattr(album, "album_artist", "") or "").strip()
    if raw_album_artist and artist_display_dedupe_key(raw_album_artist) == target_dedupe_key:
        return True
    if is_shared_artist_album(album) and not is_various_album(album):
        shared_artist = shared_album_display_artist(album, alias_to_canonical)
        if shared_artist and artist_display_dedupe_key(shared_artist) == target_dedupe_key:
            return True

    raw_members = list(getattr(album, "artists", []) or [])
    if not raw_members and getattr(album, "album_artist", None):
        raw_members = [getattr(album, "album_artist")]
    normalized_members = [str(member or "").strip() for member in raw_members if str(member or "").strip()]
    if any(artist_display_dedupe_key(member) == target_dedupe_key for member in normalized_members):
        return True

    if _contains_collaboration_marker(target):
        return False

    for member in normalized_members:
        canonical_member = str(alias_to_canonical.get(member, member) or "").strip()
        if canonical_member != target:
            continue
        if member != target and collaboration_alias_of(member, target):
            continue
        return True
    return False


def album_group_match_cache_key(album, artist: str) -> tuple[str, str]:
    """Build the cache key used for album-to-artist membership lookups."""
    album_key = str(getattr(album, "key", "") or "").strip()
    if not album_key:
        album_key = str(id(album))
    return album_key, str(artist or "").strip()


def cached_album_matches_group_artist(
    album,
    artist: str,
    alias_to_canonical: dict[str, str],
    match_cache: dict[tuple[str, str], bool] | None = None,
) -> bool:
    """Memoize album group matching when a cache dictionary is supplied."""
    if match_cache is None:
        return album_matches_group_artist(album, artist, alias_to_canonical)
    cache_key = album_group_match_cache_key(album, artist)
    cached = match_cache.get(cache_key)
    if cached is not None:
        return cached
    matched = album_matches_group_artist(album, artist, alias_to_canonical)
    match_cache[cache_key] = matched
    return matched


def grouped_selected_artist_names_for_album(
    album,
    target_artists: list[str],
    alias_to_canonical: dict[str, str],
    *,
    exact_group_matches: bool = False,
    matches_group_artist=None,
) -> list[str]:
    """Return the matching selected-artist names that an album should group under."""
    ordered_targets = [str(artist or "").strip() for artist in target_artists if str(artist or "").strip()]
    if not ordered_targets:
        return []
    ordered_target_set = set(ordered_targets)

    raw_combined_artist = str(getattr(album, "album_artist", "") or "").strip()
    combined_artist = (
        shared_album_display_artist(album, alias_to_canonical)
        if is_shared_artist_album(album) and not is_various_album(album)
        else (
            str(alias_to_canonical.get(raw_combined_artist, raw_combined_artist) or "").strip()
            if raw_combined_artist and not _contains_collaboration_marker(raw_combined_artist)
            else raw_combined_artist
        )
    )
    matching_members = (
        [
            artist for artist in ordered_targets
            if (
                matches_group_artist(artist)
                if matches_group_artist is not None
                else album_matches_group_artist(album, artist, alias_to_canonical)
            )
        ]
        if exact_group_matches
        else [artist for artist in album_member_artists(album, alias_to_canonical) if artist in ordered_target_set]
    )
    exact_album_artist_selected = (
        combined_artist
        and not is_various_album(album)
        and any(
            artist_display_dedupe_key(combined_artist) == artist_display_dedupe_key(artist)
            for artist in ordered_targets
        )
    )
    if not matching_members and not exact_album_artist_selected:
        return []
    if exact_album_artist_selected:
        return [combined_artist]
    if is_shared_artist_album(album) and combined_artist and not is_various_album(album) and matching_members:
        return [combined_artist]
    return matching_members


def build_artist_membership_groups(
    albums,
    artists: list[str],
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
    *,
    exclude_album_keys: set[str] | None = None,
    exact_group_matches: bool = False,
    matches_group_artist_for_album=None,
    album_payload_cache: dict[str, dict[str, object]] | None = None,
    album_serializer=None,
    build_group_artist_display=None,
) -> list[dict[str, object]]:
    """Build grouped artist payloads for the supplied albums and target artists."""
    groups = []
    serializer = album_serializer or album_preview_to_dict
    excluded = exclude_album_keys or set()
    target_artists = [artist for artist in artists if str(artist or "").strip()]
    if not target_artists:
        return groups
    ordered_group_artists: list[str] = []
    albums_by_artist: dict[str, list[object]] = {}

    def ensure_group_artist(group_artist: str) -> None:
        if group_artist not in albums_by_artist:
            albums_by_artist[group_artist] = []
        if group_artist not in ordered_group_artists:
            ordered_group_artists.append(group_artist)

    def cached_album_payload(album: object) -> dict[str, object]:
        if album_payload_cache is None:
            return serializer(album)
        cache_key = str(getattr(album, "key", "") or "").strip()
        if not cache_key:
            cache_key = str(id(album))
        cached = album_payload_cache.get(cache_key)
        if cached is not None:
            return cached
        payload = serializer(album)
        album_payload_cache[cache_key] = payload
        return payload

    for album in albums:
        album_key = str(getattr(album, "key", "") or "")
        if album_key in excluded:
            continue
        group_artists = grouped_selected_artist_names_for_album(
            album,
            target_artists,
            alias_to_canonical,
            exact_group_matches=exact_group_matches,
            matches_group_artist=(
                (lambda artist: matches_group_artist_for_album(album, artist))
                if matches_group_artist_for_album is not None
                else None
            ),
        )
        if not group_artists:
            continue
        for artist in group_artists:
            ensure_group_artist(artist)
            albums_by_artist[artist].append(album)

    for artist in ordered_group_artists:
        matched_albums = albums_by_artist.get(artist, [])
        if not matched_albums:
            continue
        matched_albums.sort(key=album_sort_key)
        aliases = canonical_to_aliases.get(artist, [artist]) or [artist]
        display_names = []
        seen = set()
        for name in [artist, *[value for value in aliases if value != artist]]:
            text = str(name or "").strip()
            dedupe_key = artist_display_dedupe_key(text)
            if not text or dedupe_key in seen:
                continue
            if text != artist and collaboration_alias_of(text, artist):
                continue
            seen.add(dedupe_key)
            display_names.append(text)
        artist_display = " / ".join(display_names) if display_names else artist
        groups.append({
            "artist": artist,
            "artist_display": (
                build_group_artist_display(artist, artist_display, matched_albums)
                if build_group_artist_display is not None
                else artist_display
            ),
            "albums": [cached_album_payload(album) for album in matched_albums],
        })
    return groups


def build_group_artist_display(
    artist: str,
    artist_display: object,
    albums: list[object] | None = None,
) -> str:
    """Choose a stable display label for a grouped artist payload entry."""
    canonical_artist = str(artist or "").strip()
    if not canonical_artist:
        return str(artist_display or "").strip()

    names: list[object] = [canonical_artist, artist_display]
    target_key = artist_display_dedupe_key(canonical_artist)
    for album in albums or []:
        album_artist = str(_payload_album_value(album, "album_artist") or "").strip()
        if not album_artist:
            continue
        if target_key and artist_display_dedupe_key(album_artist) != target_key:
            continue
        names.append(album_artist)

    merged_display = _merge_group_display_names(*names)
    return merged_display or canonical_artist


def preferred_group_artist_from_albums(artist: str, albums: list[object] | None = None) -> str:
    """Pick the preferred display artist from a group's album collection."""
    preferred_artist = str(artist or "").strip()
    if not preferred_artist:
        return preferred_artist
    target_key = artist_display_dedupe_key(preferred_artist)
    for album in albums or []:
        album_artist = str(_payload_album_value(album, "album_artist") or "").strip()
        if not album_artist:
            continue
        if target_key and artist_display_dedupe_key(album_artist) != target_key:
            continue
        preferred_artist = prefer_group_artist_name(preferred_artist, album_artist)
    return preferred_artist


def merge_duplicate_artist_groups(groups: list[dict[str, object]]) -> list[dict[str, object]]:
    """Merge duplicate artist-group payloads while preserving payload order."""
    merged: list[dict[str, object]] = []
    index_by_key: dict[str, int] = {}

    for group in groups or []:
        if not isinstance(group, dict):
            continue
        artist = str(group.get("artist") or "").strip()
        dedupe_key = artist_display_dedupe_key(artist) or artist.casefold()
        if not dedupe_key:
            merged.append(group)
            continue
        existing_index = index_by_key.get(dedupe_key)
        if existing_index is None:
            index_by_key[dedupe_key] = len(merged)
            merged.append(dict(group))
            continue

        existing = merged[existing_index]
        preferred_artist = prefer_group_artist_name(
            str(existing.get("artist") or "").strip(),
            artist,
        )
        merged_display = _merge_group_display_names(
            existing.get("artist_display"),
            existing.get("artist"),
            group.get("artist_display"),
            group.get("artist"),
        )
        existing["artist"] = preferred_artist
        existing["artist_display"] = merged_display or preferred_artist
        existing["albums"] = list(existing.get("albums") or []) + list(group.get("albums") or [])

    for group in merged:
        albums = list(group.get("albums") or [])
        albums.sort(key=_group_album_sort_key)
        group["albums"] = albums
        group_artist = preferred_group_artist_from_albums(
            str(group.get("artist") or "").strip(),
            albums,
        )
        group["artist"] = group_artist
        group["artist_display"] = build_group_artist_display(
            group_artist,
            group.get("artist_display"),
            albums,
        )

    return merged
