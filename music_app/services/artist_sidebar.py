from __future__ import annotations

from collections import Counter

from music_app.services.library import shared_album_display_artist
from music_app.services.utils import repair_display_text
from music_app.services.view_search import normalize_search_text


def is_shared_artist_album(album) -> bool:
    return bool(getattr(album, "is_compilation", False))


def is_various_album(album) -> bool:
    return str(getattr(album, "album_artist", "") or "").strip().casefold() in {
        "va",
        "v.a.",
        "various artists",
        "various artist",
        "various",
    }


def album_member_artists(
    album,
    alias_to_canonical: dict[str, str] | None = None,
) -> list[str]:
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


def artist_display_dedupe_key(value: object) -> str:
    text = repair_display_text(str(value or "")) or str(value or "")
    return normalize_search_text(text)


def album_sidebar_artists(
    album,
    alias_to_canonical: dict[str, str] | None = None,
) -> list[str]:
    alias_to_canonical = alias_to_canonical or {}
    if is_shared_artist_album(album) and not is_various_album(album):
        combined_artist = shared_album_display_artist(album, alias_to_canonical)
        return [combined_artist] if combined_artist else []
    album_artist = str(getattr(album, "album_artist", "") or "").strip()
    members = list(getattr(album, "artists", []) or [])
    if album_artist and not is_various_album(album) and len(members) >= 2:
        album_artist_key = artist_display_dedupe_key(album_artist)
        if album_artist_key and all(artist_display_dedupe_key(member) != album_artist_key for member in members):
            return [album_artist]
    if not members and getattr(album, "album_artist", None):
        members = [getattr(album, "album_artist")]
    sidebar_members = []
    seen = set()
    for member in members:
        artist = str(member or "").strip()
        dedupe_key = artist_display_dedupe_key(artist)
        if not artist or dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        sidebar_members.append(artist)
    return sidebar_members


def build_artists_sidebar(
    all_albums,
    relation_views=None,
    preferred_order=None,
) -> list[dict[str, object]]:
    relation_views = relation_views or {}
    counts = Counter()
    display_values: dict[str, str] = {}
    for album in all_albums:
        for artist in album_sidebar_artists(album, relation_views.get("alias_to_canonical", {})):
            artist_text = str(artist or "").strip()
            if not artist_text:
                continue
            dedupe_key = artist_display_dedupe_key(artist_text) or artist_text.casefold()
            counts[dedupe_key] += 1
            existing = display_values.get(dedupe_key, "")
            if not existing or len(artist_text) < len(existing):
                display_values[dedupe_key] = artist_text

    ordered_artists = []
    seen = set()
    for artist in preferred_order or []:
        artist_text = str(artist or "").strip()
        if not artist_text:
            continue
        dedupe_key = artist_display_dedupe_key(artist_text) or artist_text.casefold()
        if dedupe_key in counts and dedupe_key not in seen:
            ordered_artists.append(dedupe_key)
            seen.add(dedupe_key)
    for dedupe_key in sorted(counts, key=lambda value: display_values.get(value, value).casefold()):
        if dedupe_key not in seen:
            ordered_artists.append(dedupe_key)

    return [
        {
            "artist": display_values.get(artist, artist),
            "artist_display": display_values.get(artist, artist),
            "count": int(counts[artist]),
        }
        for artist in ordered_artists
    ]
