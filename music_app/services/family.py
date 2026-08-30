from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Callable
import re

UTILITY_FOLDERS = {
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

COLLAB_TOKENS = [" & ", " feat. ", " feat ", " featuring ", " with ", " vs ", " x "]
VA_NAMES = {
    "va",
    "v.a.",
    "various artists",
    "various artist",
    "various",
}


def _normalize_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


def _is_va_name(name: str) -> bool:
    return _normalize_name(name) in VA_NAMES


def _is_family_excluded_album(album) -> bool:
    return bool(getattr(album, "is_compilation", False)) or _is_va_name(
        str(getattr(album, "album_artist", "") or "")
    )


def _is_utility_folder(name: str) -> bool:
    return _normalize_name(name) in UTILITY_FOLDERS


def _is_album_like_folder(name: str) -> bool:
    text = name.strip()
    if re.match(r"^\d{4}\s*[-_.]", text):
        return True
    if re.match(r"^\d{4}\s*$", text):
        return True
    return False


def _is_collaboration_folder(name: str) -> bool:
    normalized = _normalize_name(name)
    return any(token in normalized for token in COLLAB_TOKENS)


def _is_ignored_folder(name: str) -> bool:
    return _is_utility_folder(name) or _is_album_like_folder(name) or _is_collaboration_folder(name)


def _relative_depth(root: Path, path: Path) -> int:
    try:
        return len(path.relative_to(root).parts)
    except Exception:
        return 0


def _iter_album_dirs(album) -> list[Path]:
    dirs: set[Path] = set()
    for track in getattr(album, "tracks", []) or []:
        try:
            dirs.add(Path(track.path).parent)
        except Exception:
            continue
    return sorted(dirs)


def _album_member_artists(album) -> list[str]:
    artists = list(getattr(album, "artists", []) or [])
    if not artists and getattr(album, "album_artist", None):
        artists = [getattr(album, "album_artist")]
    unique_artists: list[str] = []
    seen: set[str] = set()
    for artist in artists:
        name = str(artist or "").strip()
        normalized = _normalize_name(name)
        if not name or not normalized or _is_va_name(name) or normalized in seen:
            continue
        seen.add(normalized)
        unique_artists.append(name)
    return unique_artists


def build_family_index(
    music_dir: Path,
    albums: list,
    progress_callback: Callable[[int, int, str], None] | None = None,
) -> tuple[dict[str, set[str]], dict[str, set[str]], list[str]]:
    artist_names = sorted(
        {
            artist
            for album in albums
            for artist in _album_member_artists(album)
        },
        key=lambda x: x.lower(),
    )
    artist_to_related: dict[str, set[str]] = {artist: set() for artist in artist_names}
    family_to_artists: dict[str, set[str]] = {}

    dir_artists: dict[Path, set[str]] = defaultdict(set)
    container_children: dict[Path, set[Path]] = defaultdict(set)
    total = max(len(albums), 1)
    resolved_music_dir = music_dir.resolve(strict=False)

    for index, album in enumerate(albums, start=1):
        if _is_family_excluded_album(album):
            continue
        member_artists = _album_member_artists(album)
        if progress_callback:
            progress_callback(index - 1, total, f"Reading local structures: {', '.join(member_artists) or 'Unknown Artist'}")
        if not member_artists:
            continue
        for album_dir in _iter_album_dirs(album):
            try:
                resolved_dir = album_dir.resolve(strict=False)
                resolved_dir.relative_to(resolved_music_dir)
            except Exception:
                continue

            current = resolved_dir
            while True:
                try:
                    current.relative_to(resolved_music_dir)
                except Exception:
                    break
                dir_artists[current].update(member_artists)
                if current == resolved_music_dir:
                    break
                parent = current.parent
                if parent == current:
                    break
                container_children[parent].add(current)
                current = parent

        if progress_callback:
            progress_callback(index, total, f"Reading local structures: {', '.join(member_artists)}")

    container_paths = sorted(dir_artists.keys(), key=lambda value: (_relative_depth(music_dir, value), str(value).lower()))

    for container in container_paths:
        depth = _relative_depth(music_dir, container)
        if depth <= 1:
            continue

        qualifying_children = []
        for child in sorted(container_children.get(container, set()), key=lambda value: str(value).lower()):
            if _is_ignored_folder(child.name):
                continue
            child_artists = dir_artists.get(child, set())
            if child_artists:
                qualifying_children.append(child)

        if not qualifying_children:
            continue

        members = {artist for artist in dir_artists.get(container, set()) if artist in artist_to_related}
        if len(members) < 2:
            continue

        family_label = str(container.relative_to(music_dir))
        family_to_artists[family_label] = set(members)
        for artist in members:
            artist_to_related.setdefault(artist, set()).update(members - {artist})

    return family_to_artists, artist_to_related, artist_names
