"""Folders that really hold several albums (2026-11-24: the multi-album rule is strict).

A physical folder is a multi-album folder only when its files carry two or more album tags, each of those
albums is complete (album_is_complete), and nothing else is in it: no song without an album tag or with an
exception type, and no album that also has files in another folder. Copies proven to belong to another album
folder don't count. Decided from the given entries' tags alone, never from folder or file names. An entry
may say its album also has files outside the given entries (_album_files_elsewhere).
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping

from music_app.services.album_completeness import album_is_complete
from music_app.services.album_local_membership import physical_album_folder

_PROVEN_COPY = "Duplicate track outside album folder"


def strict_multi_album_folders(entries: Iterable[Mapping[str, object]]) -> set[str]:
    """The physical folders (physical_album_folder keys) among the entries that hold several albums."""
    files_by_folder: dict[str, list[Mapping[str, object]]] = defaultdict(list)
    folders_by_album: dict[tuple[str, str], set[str]] = defaultdict(set)
    for entry in entries:
        path = str(entry.get("path") or "").strip()
        if not path or entry.get("local_album_membership_problem") == _PROVEN_COPY:
            continue
        folder = physical_album_folder(path)
        files_by_folder[folder].append(entry)
        if (identity := _album_identity(entry)) is not None:
            folders_by_album[identity].add(folder)
            if entry.get("_album_files_elsewhere"):
                folders_by_album[identity].add("")  # files of this album lie outside the given entries
    strict: set[str] = set()
    for folder, files in files_by_folder.items():
        albums: dict[tuple[str, str], list[Mapping[str, object]]] = defaultdict(list)
        for entry in files:
            identity = _album_identity(entry)
            if identity is None or str(entry.get("exception_type") or "").strip():
                break  # a loose song: the folder is a collection, not several albums
            albums[identity].append(entry)
        else:
            if len(albums) >= 2 and not discs_of_one_release(albums) and all(
                folders_by_album[identity] == {folder} and album_is_complete(tracks)
                for identity, tracks in albums.items()
            ):
                strict.add(folder)
    return strict


def discs_of_one_release(albums: Mapping[tuple[str, str], list[Mapping[str, object]]]) -> bool:
    """The MusicBrainz seam (owner, 2026-11-24): True once enrichment knows the folder's albums are discs of one
    release, which excludes the folder.

    Signal, per the MusicBrainz line: library.local_album_musicbrainz_releases (library_id, album_key) with
    release_mbid and disc_position. Two or more albums sharing one release_mbid with different disc_position
    values are discs of one release. disc_position is empty today and the contract is not final, so this
    reads nothing yet."""
    return False


def _album_identity(entry: Mapping[str, object]) -> tuple[str, str] | None:
    album = " ".join(str(entry.get("album") or "").casefold().split())
    if not album:
        return None
    artist = " ".join(str(entry.get("album_artist") or entry.get("artist") or "").casefold().split())
    return artist, album
