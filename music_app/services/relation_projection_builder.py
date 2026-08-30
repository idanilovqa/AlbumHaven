from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from difflib import SequenceMatcher
import json
from pathlib import PurePosixPath, PureWindowsPath
import re


_VA_NAMES = {"va", "v.a.", "various artists", "various artist", "various"}
_UTILITY_FOLDERS = {
    "тексты песен",
    "картинки",
    "информация",
    "lyrics",
    "images",
    "pictures",
    "artwork",
    "covers",
    "cover art",
    "info",
    "information",
    "booklets",
    "scans",
    "photos",
}
_ARTIST_PUNCT_TRANSLATION = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201b": "'",
        "\u2032": "'",
        "\u02bc": "'",
        "\u00b4": "'",
        "`": "'",
    }
)


@dataclass(frozen=True)
class PostgresTrackLocationFact:
    library_root_id: str
    root_path: str
    relative_parts: tuple[str, ...]


@dataclass(frozen=True)
class PostgresRelationAlbumFact:
    album_id: int
    album_artist: str
    is_compilation: bool
    artists: tuple[str, ...]
    locations: tuple[PostgresTrackLocationFact, ...]
    family_artists: tuple[str, ...] = ()
    family_excluded: bool = False


def _row_mapping(row: object) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _text(row: Mapping[str, object], key: str) -> str:
    return str(row.get(key) or "").strip()


def _postgres_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    return str(value or "").strip().casefold() in {
        "1",
        "t",
        "true",
        "y",
        "yes",
        "on",
    }


def _path_flavor(root_path: str):
    if root_path.startswith("/"):
        root = PurePosixPath(root_path)
        return (PurePosixPath, root) if root.is_absolute() else None
    root = PureWindowsPath(root_path)
    return (PureWindowsPath, root) if root.is_absolute() else None


def _contains_dot_segments(value: str, *, windows: bool) -> bool:
    pieces = re.split(r"[\\/]" if windows else r"/", value)
    return any(piece in {".", ".."} for piece in pieces)


def root_relative_parts(
    row: Mapping[str, object],
) -> tuple[str, tuple[str, ...]] | None:
    root_id = _text(row, "library_root_id")
    root_text = _text(row, "root_path")
    if not root_id or not root_text:
        return None
    flavor = _path_flavor(root_text)
    if flavor is None:
        return None
    path_type, root = flavor
    windows = path_type is PureWindowsPath

    relative_text = _text(row, "relative_path")
    if relative_text and not _contains_dot_segments(relative_text, windows=windows):
        relative = path_type(relative_text)
        matches_flavor = windows or "\\" not in relative_text
        if (
            matches_flavor
            and not relative.is_absolute()
            and not relative.drive
            and not relative.root
            and relative.parts
        ):
            parts = tuple(part for part in relative.parts if part not in {"", "."})
            if parts:
                return root_id, parts

    private_text = _text(row, "private_path")
    if not private_text or _contains_dot_segments(private_text, windows=windows):
        return None
    private = path_type(private_text)
    if not private.is_absolute():
        return None
    root_parts = root.parts
    private_parts = private.parts
    if len(private_parts) <= len(root_parts):
        return None
    if windows:
        contained = tuple(part.casefold() for part in private_parts[: len(root_parts)]) == tuple(
            part.casefold() for part in root_parts
        )
    else:
        contained = private_parts[: len(root_parts)] == root_parts
    if not contained:
        return None
    parts = tuple(private_parts[len(root_parts) :])
    return (root_id, parts) if parts else None


def serialized_family_key(
    root_id: str,
    relative_parts: tuple[str, ...],
) -> str:
    return json.dumps(
        [str(root_id), *[part.casefold() for part in relative_parts]],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _normalize_spaces(text: str) -> str:
    return " ".join((text or "").strip().split())


def _normalize_key(text: str) -> str:
    return _normalize_spaces(text).translate(_ARTIST_PUNCT_TRANSLATION).casefold()


def _is_va_name(name: str) -> bool:
    return _normalize_key(name) in _VA_NAMES


def _looks_like_collaboration(name: str) -> bool:
    normalized = _normalize_key(name)
    if _is_va_name(normalized):
        return False
    if re.search(r"(?:'s|s')\s+\S", normalized):
        return True
    return any(
        marker in normalized
        for marker in ("&", "feat.", "feat", "featuring", "with", "vs", " x ", " и ", "/", ";", ",")
    )


def _display_choice(names: list[str], counts: Counter[str]) -> str:
    unique = sorted(
        set(names),
        key=lambda value: (_normalize_key(value), len(value), value.casefold()),
    )
    normalized_keys = {_normalize_key(value) for value in unique if value}
    case_only_variants = len(normalized_keys) == 1 and len(unique) > 1
    return max(
        unique,
        key=lambda value: (
            counts.get(value, 0),
            -len(value),
            -(
                sum(1 for char in value if char.isupper())
                if case_only_variants
                else -sum(1 for char in value if char.isupper())
            ),
            value.casefold(),
        ),
    )


def _prefix_match(alias_key: str, solo_key: str) -> bool:
    if not alias_key or not solo_key or alias_key == solo_key:
        return False
    if not alias_key.startswith(solo_key):
        return False
    remainder = alias_key[len(solo_key) :]
    return remainder.startswith(
        (",", " &", " feat", " featuring", " with", " vs", " x", " и", " /", ";")
    )


def _possessive_project_match(alias_key: str, solo_key: str) -> bool:
    if not alias_key or not solo_key or alias_key == solo_key:
        return False
    suffix = f" {solo_key}"
    if not alias_key.endswith(suffix):
        return False
    owner = alias_key[: -len(suffix)].rstrip()
    return bool(owner) and (owner.endswith("'s") or owner.endswith("s'"))


def _contains_single_base(alias_key: str, solo_keys: set[str]) -> str | None:
    matches = [
        solo
        for solo in solo_keys
        if solo
        and (
            alias_key == solo
            or _prefix_match(alias_key, solo)
            or _possessive_project_match(alias_key, solo)
        )
    ]
    return matches[0] if len(matches) == 1 else None


def _compact_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _normalize_key(text))


def _low_value_artist_key(text: str) -> str:
    normalized = _normalize_key(text)
    if not normalized:
        return ""
    if any(character.isalnum() and not character.isascii() for character in normalized):
        return ""
    normalized = re.sub(r"\band\b", " ", normalized)
    normalized = normalized.replace("&", " ")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return " ".join(normalized.split())


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
    return SequenceMatcher(None, left_compact, right_compact).ratio() >= 0.9


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
    canonical_aliases.update({canonical, alternate_canonical})
    for alias in alternate_aliases | {alternate}:
        if alias:
            alias_to_canonical[alias] = canonical
            canonical_aliases.add(alias)


def _album_facts(rows: list[object]) -> tuple[PostgresRelationAlbumFact, ...]:
    buckets: dict[int, dict[str, object]] = {}
    for raw_row in rows:
        row = _row_mapping(raw_row)
        try:
            album_id = int(row.get("album_id") or 0)
        except (TypeError, ValueError):
            continue
        if album_id <= 0:
            continue
        owner_artist = _text(row, "owner_artist_name")
        album_artist = _text(row, "album_artist") or owner_artist
        bucket = buckets.setdefault(
            album_id,
            {
                "album_artist": album_artist,
                "is_compilation": _postgres_bool(row.get("album_is_compilation")),
                "artists": set(),
                "family_artists": set(),
                "locations": set(),
                "family_excluded": False,
            },
        )
        member_artist = _text(row, "member_artist_name")
        for artist in (owner_artist, member_artist):
            if artist:
                bucket["artists"].add(artist)
        if owner_artist:
            bucket["family_artists"].add(owner_artist)
        if member_artist:
            if (
                _text(row, "featured_kind").casefold() != "featured_track_artist"
                or _postgres_bool(
                    row.get("member_artist_is_album_wide_track_artist")
                )
            ):
                bucket["family_artists"].add(member_artist)
        if _text(row, "relation_evidence_kind").casefold() == "soundtrack_root":
            bucket["family_excluded"] = True
        location_parts = root_relative_parts(row)
        if location_parts is not None:
            root_id, relative_parts = location_parts
            bucket["locations"].add(
                PostgresTrackLocationFact(
                    library_root_id=root_id,
                    root_path=_text(row, "root_path"),
                    relative_parts=relative_parts,
                )
            )

    facts = []
    for album_id, bucket in sorted(buckets.items()):
        album_artist = str(bucket["album_artist"] or "").strip()
        artists = tuple(sorted(bucket["artists"], key=str.casefold))
        if not artists and album_artist:
            artists = (album_artist,)
        family_artists = set(bucket["family_artists"])
        if not family_artists and album_artist:
            family_artists.add(album_artist)
        facts.append(
            PostgresRelationAlbumFact(
                album_id=album_id,
                album_artist=album_artist,
                is_compilation=bool(bucket["is_compilation"]),
                artists=artists,
                family_artists=tuple(sorted(family_artists, key=str.casefold)),
                locations=tuple(
                    sorted(
                        bucket["locations"],
                        key=lambda value: (
                            value.library_root_id,
                            tuple(part.casefold() for part in value.relative_parts),
                            value.relative_parts,
                        ),
                    )
                ),
                family_excluded=bool(bucket["family_excluded"]),
            )
        )
    return tuple(facts)


def _build_alias_views(
    albums: tuple[PostgresRelationAlbumFact, ...],
) -> dict[str, object]:
    artist_counts: Counter[str] = Counter()
    normalized_buckets: dict[str, list[str]] = defaultdict(list)
    container_to_artists: dict[tuple[str, tuple[str, ...]], set[str]] = defaultdict(set)
    for album in albums:
        candidates = list(dict.fromkeys((album.album_artist, *album.artists)))
        containers = {
            (location.library_root_id, location.relative_parts[:2])
            for location in album.locations
            if location.relative_parts
        }
        for artist in candidates:
            artist = str(artist or "").strip()
            if not artist:
                continue
            artist_counts[artist] += 1
            normalized = _normalize_key(artist)
            if normalized:
                normalized_buckets[normalized].append(artist)
            for container in containers:
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

    signature_groups: dict[str, list[str]] = defaultdict(list)
    for canonical in list(canonical_to_aliases):
        if canonical and not _is_va_name(canonical):
            signature = _low_value_artist_key(canonical)
            if signature:
                signature_groups[signature].append(canonical)
    for names in signature_groups.values():
        unique = sorted(set(names), key=str.casefold)
        if len(unique) >= 2:
            canonical = _display_choice(unique, artist_counts)
            for alternate in unique:
                _merge_artist_alias(canonical, alternate, alias_to_canonical, canonical_to_aliases)

    for artists in container_to_artists.values():
        if len(artists) < 2:
            continue
        local_signatures: dict[str, list[str]] = defaultdict(list)
        for artist in artists:
            if artist and not _is_va_name(artist) and _looks_like_collaboration(artist):
                signature = _low_value_artist_key(alias_to_canonical.get(artist, artist))
                if signature:
                    local_signatures[signature].append(artist)
        for names in local_signatures.values():
            canonical_names = sorted(
                {
                    alias_to_canonical.get(name, name)
                    for name in names
                    if alias_to_canonical.get(name, name)
                },
                key=str.casefold,
            )
            if len(canonical_names) >= 2:
                canonical = _display_choice(canonical_names, artist_counts)
                for alternate in canonical_names:
                    _merge_artist_alias(
                        canonical,
                        alternate,
                        alias_to_canonical,
                        canonical_to_aliases,
                    )

        solo_candidates = {}
        for artist in artists:
            if artist and not _is_va_name(artist) and not _looks_like_collaboration(artist):
                canonical_artist = alias_to_canonical.get(artist, artist)
                normalized = _normalize_key(canonical_artist)
                if normalized:
                    solo_candidates[normalized] = canonical_artist
        solo_keys = set(solo_candidates)
        for artist in artists:
            if not artist or _is_va_name(artist) or not _looks_like_collaboration(artist):
                continue
            matched = _contains_single_base(_normalize_key(artist), solo_keys)
            if matched:
                _merge_artist_alias(
                    solo_candidates[matched],
                    artist,
                    alias_to_canonical,
                    canonical_to_aliases,
                )
        solo_artists = sorted(
            {
                alias_to_canonical.get(artist, artist)
                for artist in artists
                if artist and not _is_va_name(artist) and not _looks_like_collaboration(artist)
            },
            key=str.casefold,
        )
        for index, left in enumerate(solo_artists):
            for right in solo_artists[index + 1 :]:
                if _are_probable_artist_typos(left, right):
                    canonical = _display_choice([left, right], artist_counts)
                    _merge_artist_alias(
                        canonical,
                        right if canonical == left else left,
                        alias_to_canonical,
                        canonical_to_aliases,
                    )

    artists_sidebar = []
    for canonical in sorted(canonical_to_aliases, key=str.casefold):
        count = sum(artist_counts.get(alias, 0) for alias in canonical_to_aliases[canonical])
        artists_sidebar.append({"artist": canonical, "count": int(count)})
    return {
        "alias_to_canonical": alias_to_canonical,
        "canonical_to_aliases": {
            canonical: sorted(aliases, key=str.casefold)
            for canonical, aliases in canonical_to_aliases.items()
        },
        "artists_sidebar": artists_sidebar,
    }


def _is_ignored_folder(name: str) -> bool:
    normalized = " ".join(name.strip().lower().split())
    return (
        normalized in _UTILITY_FOLDERS
        or bool(re.match(r"^\d{4}\s*(?:[-_.]|$)", name.strip()))
    )


def _build_family_views(
    albums: tuple[PostgresRelationAlbumFact, ...],
    alias_to_canonical: Mapping[str, str],
) -> dict[str, object]:
    dir_artists: dict[tuple[str, tuple[str, ...]], set[str]] = defaultdict(set)
    container_children: dict[
        tuple[str, tuple[str, ...]],
        set[tuple[str, tuple[str, ...]]],
    ] = defaultdict(set)
    for album in albums:
        if album.family_excluded or _is_va_name(album.album_artist):
            continue
        family_source_artists = (
            (album.album_artist,)
            if album.is_compilation
            else album.family_artists
        )
        members = {
            alias_to_canonical.get(artist, artist)
            for artist in family_source_artists
            if artist and not _is_va_name(artist)
        }
        members.discard("")
        if not members:
            continue
        for location in album.locations:
            track_parent = location.relative_parts[:-1]
            for depth in range(len(track_parent), -1, -1):
                current = (location.library_root_id, track_parent[:depth])
                dir_artists[current].update(members)
                if depth:
                    parent = (location.library_root_id, track_parent[: depth - 1])
                    container_children[parent].add(current)

    family_to_artists: dict[str, set[str]] = {}
    family_labels: dict[str, str] = {}
    folder_related: dict[str, set[str]] = defaultdict(set)
    for root_id, parts in sorted(
        dir_artists,
        key=lambda value: (
            value[0],
            len(value[1]),
            tuple(part.casefold() for part in value[1]),
            value[1],
        ),
    ):
        if len(parts) <= 1:
            continue
        children = container_children.get((root_id, parts), set())
        if not any(
            child_parts
            and not _is_ignored_folder(child_parts[-1])
            and dir_artists.get((child_root, child_parts))
            for child_root, child_parts in children
        ):
            continue
        members = set(dir_artists[(root_id, parts)])
        if len(members) < 2:
            continue
        family = serialized_family_key(root_id, parts)
        family_to_artists[family] = members
        family_labels[family] = "/".join(parts)
        for artist in members:
            folder_related[artist].update(members - {artist})

    sidebar_families = [
        {
            "family": family,
            "label": family_labels[family],
            "artists": sorted(members, key=str.casefold),
            "count": len(members),
        }
        for family, members in sorted(
            family_to_artists.items(),
            key=lambda item: (family_labels[item[0]].casefold(), item[0]),
        )
    ]
    return {
        "family_to_artists": family_to_artists,
        "folder_related": {
            artist: set(sorted(related, key=str.casefold))
            for artist, related in folder_related.items()
        },
        "sidebar_families": sidebar_families,
    }


def build_postgres_relation_views(rows: list[object]) -> dict[str, object]:
    albums = _album_facts(rows)
    alias_views = _build_alias_views(albums)
    family_views = _build_family_views(albums, alias_views["alias_to_canonical"])
    artists_sidebar = alias_views["artists_sidebar"]
    return {
        "artists": [entry["artist"] for entry in artists_sidebar],
        "artists_sidebar": artists_sidebar,
        **family_views,
        "alias_to_canonical": alias_views["alias_to_canonical"],
        "canonical_to_aliases": alias_views["canonical_to_aliases"],
    }
