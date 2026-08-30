from __future__ import annotations

from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path
import re

from music_app.services.family import build_family_index

VA_NAMES = {
    "va",
    "v.a.",
    "various artists",
    "various artist",
    "various",
}

_ARTIST_PUNCT_TRANSLATION = str.maketrans({
    "\u2018": "'",
    "\u2019": "'",
    "\u201b": "'",
    "\u2032": "'",
    "\u02bc": "'",
    "\u00b4": "'",
    "`": "'",
})

COLLAB_MARKERS = [
    " & ", " feat. ", " feat ", " featuring ", " with ", " vs ", " x ",
    " и ", " / ", "; ", ", ", ",",
]


def _normalize_spaces(text: str) -> str:
    return " ".join((text or "").strip().split())


def _normalize_key(text: str) -> str:
    return _normalize_spaces(text).translate(_ARTIST_PUNCT_TRANSLATION).casefold()


def _is_va_name(name: str) -> bool:
    return _normalize_key(name) in VA_NAMES


def _looks_like_collaboration(name: str) -> bool:
    normalized = _normalize_key(name)
    if _is_va_name(normalized):
        return False
    if re.search(r"(?:'s|s')\s+\S", normalized):
        return True
    return any(marker.strip() in normalized for marker in ["&", "feat.", "feat", "featuring", "with", "vs", " x ", " и ", "/", ";", ","])


def _display_choice(names: list[str], counts: Counter[str]) -> str:
    unique = sorted(set(names), key=lambda value: (_normalize_key(value), len(value), value.casefold()))
    normalized_keys = {_normalize_key(value) for value in unique if value}
    case_only_variants = len(normalized_keys) == 1 and len(unique) > 1
    return max(
        unique,
        key=lambda value: (
            counts.get(value, 0),
            -len(value),
            -(sum(1 for ch in value if ch.isupper()) if case_only_variants else -sum(1 for ch in value if ch.isupper())),
            value.casefold(),
        ),
    )


def _album_container_key(album, music_dir: Path) -> str | None:
    for track in getattr(album, "tracks", []) or []:
        try:
            rel = Path(track.path).resolve(strict=False).relative_to(music_dir.resolve(strict=False))
        except Exception:
            continue
        parts = rel.parts
        if len(parts) >= 2:
            return "/".join(parts[:2])
        if len(parts) == 1:
            return parts[0]
    return None


def _prefix_match(alias_key: str, solo_key: str) -> bool:
    if not alias_key or not solo_key or alias_key == solo_key:
        return False
    if not alias_key.startswith(solo_key):
        return False
    if len(alias_key) == len(solo_key):
        return False
    remainder = alias_key[len(solo_key):]
    return remainder.startswith((",", " &", " feat", " featuring", " with", " vs", " x", " и", " /", ";"))


def _possessive_project_match(alias_key: str, solo_key: str) -> bool:
    if not alias_key or not solo_key or alias_key == solo_key:
        return False
    suffix = f" {solo_key}"
    if not alias_key.endswith(suffix):
        return False
    owner = alias_key[: -len(suffix)].rstrip()
    if not owner:
        return False
    return owner.endswith("'s") or owner.endswith("s'")


def _contains_single_base(alias_key: str, solo_keys: set[str]) -> str | None:
    matches = [
        solo
        for solo in solo_keys
        if solo and (
            alias_key == solo
            or _prefix_match(alias_key, solo)
            or _possessive_project_match(alias_key, solo)
        )
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def _compact_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _normalize_key(text))


def _low_value_artist_key(text: str) -> str:
    normalized = _normalize_key(text)
    if not normalized:
        return ""
    normalized = re.sub(r"\band\b", " ", normalized)
    normalized = normalized.replace("&", " ")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return " ".join(part for part in normalized.split() if part)


def _are_probable_artist_typos(left: str, right: str) -> bool:
    if not left or not right or left == right:
        return False
    left_compact = _compact_key(left)
    right_compact = _compact_key(right)
    if not left_compact or not right_compact:
        return False
    if left_compact[0] != right_compact[0]:
        return False
    if abs(len(left_compact) - len(right_compact)) > 2:
        return False
    ratio = SequenceMatcher(None, left_compact, right_compact).ratio()
    return ratio >= 0.9


def _merge_artist_alias(
    canonical: str,
    alternate: str,
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, set[str]],
) -> None:
    canonical = str(canonical or "").strip()
    alternate = str(alternate or "").strip()
    if not canonical or not alternate or canonical == alternate:
        return

    alternate_canonical = str(alias_to_canonical.get(alternate, alternate) or "").strip()
    if not alternate_canonical:
        return

    canonical_aliases = canonical_to_aliases.setdefault(canonical, set())
    alternate_aliases = canonical_to_aliases.pop(alternate_canonical, set())
    canonical_aliases.add(canonical)
    canonical_aliases.add(alternate_canonical)
    for alias in alternate_aliases | {alternate}:
        if not alias:
            continue
        alias_to_canonical[alias] = canonical
        canonical_aliases.add(alias)


def _album_member_artists(album) -> list[str]:
    artists = list(getattr(album, "artists", []) or [])
    if not artists and getattr(album, "album_artist", None):
        artists = [getattr(album, "album_artist")]
    return [str(artist or "").strip() for artist in artists if str(artist or "").strip()]


def _album_alias_candidate_artists(album) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    album_artist = str(getattr(album, "album_artist", "") or "").strip()
    if album_artist:
        seen.add(album_artist)
        candidates.append(album_artist)

    for artist in _album_member_artists(album):
        if artist in seen:
            continue
        seen.add(artist)
        candidates.append(artist)

    return candidates


def build_artist_alias_views(albums: list, music_dir: Path) -> dict[str, object]:
    artist_counts = Counter()
    normalized_buckets: dict[str, list[str]] = defaultdict(list)
    container_to_artists: dict[str, set[str]] = defaultdict(set)

    for album in albums:
        alias_candidates = _album_alias_candidate_artists(album)
        if not alias_candidates:
            continue
        container = _album_container_key(album, music_dir)
        for artist in alias_candidates:
            artist_counts[artist] += 1
            normalized_key = _normalize_key(artist)
            if normalized_key:
                normalized_buckets[normalized_key].append(artist)
            if container:
                container_to_artists[container].add(artist)

    normalized_display = {
        normalized: _display_choice(names, artist_counts)
        for normalized, names in normalized_buckets.items()
    }

    alias_to_canonical: dict[str, str] = {}
    canonical_to_aliases: dict[str, set[str]] = defaultdict(set)

    for normalized, names in normalized_buckets.items():
        canonical = normalized_display[normalized]
        for name in names:
            alias_to_canonical[name] = canonical
            canonical_to_aliases[canonical].add(name)

    global_signature_groups: dict[str, list[str]] = defaultdict(list)
    for canonical in list(canonical_to_aliases):
        if not canonical or _is_va_name(canonical):
            continue
        signature = _low_value_artist_key(canonical)
        if signature:
            global_signature_groups[signature].append(canonical)

    for canonical_names in global_signature_groups.values():
        unique_names = sorted(set(canonical_names), key=lambda value: value.casefold())
        if len(unique_names) < 2:
            continue
        canonical = _display_choice(unique_names, artist_counts)
        for alternate in unique_names:
            _merge_artist_alias(canonical, alternate, alias_to_canonical, canonical_to_aliases)

    for _container, artists in container_to_artists.items():
        if len(artists) < 2:
            continue
        signature_groups: dict[str, list[str]] = defaultdict(list)
        for artist in artists:
            if not artist or _is_va_name(artist) or not _looks_like_collaboration(artist):
                continue
            signature = _low_value_artist_key(alias_to_canonical.get(artist, artist))
            if signature:
                signature_groups[signature].append(artist)
        for names in signature_groups.values():
            canonical_names = sorted(
                {alias_to_canonical.get(name, name) for name in names if alias_to_canonical.get(name, name)},
                key=lambda value: value.casefold(),
            )
            if len(canonical_names) < 2:
                continue
            canonical = _display_choice(canonical_names, artist_counts)
            for alternate in canonical_names:
                _merge_artist_alias(canonical, alternate, alias_to_canonical, canonical_to_aliases)

    for _container, artists in container_to_artists.items():
        if len(artists) < 2:
            continue

        solo_candidates = {}
        for artist in artists:
            if not artist or _is_va_name(artist) or _looks_like_collaboration(artist):
                continue
            canonical_artist = alias_to_canonical.get(artist, artist)
            normalized_key = _normalize_key(canonical_artist)
            if not normalized_key:
                continue
            solo_candidates[normalized_key] = canonical_artist
        solo_keys = set(solo_candidates.keys())
        if not solo_keys:
            continue

        for artist in artists:
            if not artist or _is_va_name(artist) or not _looks_like_collaboration(artist):
                continue
            artist_key = _normalize_key(artist)
            matched_key = _contains_single_base(artist_key, solo_keys)
            if not matched_key:
                continue
            canonical = solo_candidates[matched_key]
            _merge_artist_alias(canonical, artist, alias_to_canonical, canonical_to_aliases)

        solo_artists = sorted(
            {
                alias_to_canonical.get(artist, artist)
                for artist in artists
                if artist and not _is_va_name(artist) and not _looks_like_collaboration(artist)
            },
            key=lambda value: value.casefold(),
        )
        for index, left in enumerate(solo_artists):
            for right in solo_artists[index + 1:]:
                if not _are_probable_artist_typos(left, right):
                    continue
                canonical = _display_choice([left, right], artist_counts)
                alternate = right if canonical == left else left
                _merge_artist_alias(canonical, alternate, alias_to_canonical, canonical_to_aliases)

    artists_sidebar = []
    for canonical in sorted(canonical_to_aliases, key=lambda value: value.casefold()):
        count = sum(int(artist_counts.get(alias, 0)) for alias in canonical_to_aliases[canonical])
        artists_sidebar.append({"artist": canonical, "count": count})

    return {
        "alias_to_canonical": dict(alias_to_canonical),
        "canonical_to_aliases": {artist: sorted(list(aliases), key=lambda value: value.casefold()) for artist, aliases in canonical_to_aliases.items()},
        "artists_sidebar": artists_sidebar,
    }


def build_relation_views(albums: list, config: dict, progress_callback=None) -> dict[str, object]:
    alias_views = build_artist_alias_views(albums, config["MUSIC_DIR"])
    alias_to_canonical = alias_views["alias_to_canonical"]
    canonical_to_aliases = alias_views["canonical_to_aliases"]

    def _progress(processed: int, total: int, phase: str) -> None:
        if progress_callback:
            progress_callback(processed, total, phase, "local")

    family_to_artists, folder_related, artists = build_family_index(config["MUSIC_DIR"], albums, progress_callback=_progress)

    canonical_family_to_artists: dict[str, set[str]] = {}
    canonical_related: dict[str, set[str]] = defaultdict(set)

    for family, members in family_to_artists.items():
        canonical_members = {alias_to_canonical.get(member, member) for member in members if alias_to_canonical.get(member, member)}
        if len(canonical_members) < 2:
            continue
        canonical_family_to_artists[family] = canonical_members
        for artist in canonical_members:
            canonical_related[artist].update(canonical_members - {artist})

    for artist, related in folder_related.items():
        canonical_artist = alias_to_canonical.get(artist, artist)
        for other in related:
            canonical_other = alias_to_canonical.get(other, other)
            if canonical_other and canonical_other != canonical_artist:
                canonical_related[canonical_artist].add(canonical_other)

    sidebar_families = [
        {
            "family": family,
            "artists": sorted(list(members), key=lambda x: x.casefold()),
            "count": len(members),
        }
        for family, members in sorted(canonical_family_to_artists.items(), key=lambda item: item[0].casefold())
    ]

    artists_sidebar = alias_views["artists_sidebar"]
    artists = [entry["artist"] for entry in artists_sidebar]

    if progress_callback:
        progress_callback(len(artists), max(len(artists), 1), "Finished reading local structures", "local")

    return {
        "artists": artists,
        "artists_sidebar": artists_sidebar,
        "family_to_artists": canonical_family_to_artists,
        "folder_related": {artist: set(sorted(values, key=lambda x: x.casefold())) for artist, values in canonical_related.items()},
        "sidebar_families": sidebar_families,
        "alias_to_canonical": alias_to_canonical,
        "canonical_to_aliases": canonical_to_aliases,
    }



def get_related_for_artist(selected_artist: str, relation_views: dict[str, object], config: dict) -> tuple[list[str], dict[str, object]]:
    if not selected_artist:
        return [], {
            "folders_used": False,
            "musicbrainz_enabled": False,
            "musicbrainz_used": False,
            "musicbrainz_cache_hit": False,
            "musicbrainz_status": "disabled",
        }

    folder_related = relation_views.get("folder_related", {}) or {}
    related = set(folder_related.get(selected_artist, set()))
    if not related:
        canonical_artist = str((relation_views.get("alias_to_canonical", {}) or {}).get(selected_artist, selected_artist) or "").strip()
        if canonical_artist and canonical_artist != selected_artist:
            related = set(folder_related.get(canonical_artist, set()))

    meta = {
        "folders_used": True,
        "musicbrainz_enabled": False,
        "musicbrainz_used": False,
        "musicbrainz_cache_hit": False,
        "musicbrainz_status": "disabled",
    }
    return sorted(related, key=lambda x: x.casefold()), meta
