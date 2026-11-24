"""Folders that really hold several albums (2026-11-24: the multi-album rule is strict).

A physical folder is a multi-album folder only when its files carry two or more album tags, each of those
albums is complete (album_is_complete), and nothing else is in it: no song without an album tag or with an
exception type, and no album that also has files in another folder. Copies proven to belong to another album
folder don't count. Decided from the given entries' tags alone, never from folder or file names. An entry
may say its album also has files outside the given entries (_album_files_elsewhere).
"""
from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable, Mapping

from music_app.services.album_completeness import album_is_complete
from music_app.services.album_local_membership import physical_album_folder

_PROVEN_COPY = "Duplicate track outside album folder"
_DISC_WORD = r"(?:disc|disk|cd|\u0434\u0438\u0441\u043a)"
_DISC_COUNT = r"(?:\s*(?:of|\u0438\u0437|/)\s*\d+)?"
# A disc marker in an album tag: bracketed anywhere ("(Disc 2)", "[CD 1 of 2]") or trailing ("- Disc 1", "disc 2").
_DISC_MARKER = re.compile(
    r"\s*[\(\[\{]\s*" + _DISC_WORD + r"\s*\.?\s*\d+" + _DISC_COUNT + r"\s*[\)\]\}]"
    r"|[\s,.:\-\u2013\u2014]+" + _DISC_WORD + r"\s*\.?\s*\d+" + _DISC_COUNT + r"\s*$",
    re.IGNORECASE,
)


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
            if len(albums) >= 2 and not _one_release_split_by_disc(albums) and not discs_of_one_release(albums) and all(
                folders_by_album[identity] == {folder} and album_is_complete(tracks)
                for identity, tracks in albums.items()
            ):
                strict.add(folder)
    return strict


def _one_release_split_by_disc(albums: Mapping[tuple[str, str], object]) -> bool:
    """Owner (2026-11-24): disc-tagged pairs are one album. Two album tags with disc markers, or one whose tag
    without its marker equals another album's tag, split one release by disc. One marked tag that differs
    beyond the marker (two tribute albums, one "Disc 1") doesn't."""
    titles = [album for _artist, album in albums]
    marked = [title for title in titles if _DISC_MARKER.search(title)]
    if len(marked) >= 2:
        return True
    unmarked = {title for title in titles if not _DISC_MARKER.search(title)}
    return any(_DISC_MARKER.sub("", title).strip(" -\u2013\u2014,.:") in unmarked for title in marked)


def discs_of_one_release(albums: Mapping[tuple[str, str], list[Mapping[str, object]]]) -> bool:
    """The MusicBrainz seam (owner, 2026-11-24): True once enrichment knows the folder's albums are discs of one
    release, which excludes the folder.

    Contract (album grouping design, rev 9, section 2.9): two albums of the folder are discs of one release only
    when both hold:
    1. both of their rows in library.local_album_musicbrainz_releases have state = 'release', the same
       release_mbid, and disc_position set and different (manual and automatic matches count alike);
    2. both albums have a row in library.album_disc_split_displays (migration 0279), so the app currently shows
       them as one album. When the owner removes that disc-split fix the cards show as tagged again, and the
       folder is flagged again.
    Not a signal: state 'release_group', the same release with an empty disc_position, or Discogs rows. The read
    is one query per folder on each table's primary key (library_id = %s and album_key = any(%s)); a change to
    either table re-decides that folder only. Showing such discs as one album belongs to album grouping; this
    seam only lifts the multi-album flag.

    Reads nothing until album grouping's line lands."""
    return False


def _album_identity(entry: Mapping[str, object]) -> tuple[str, str] | None:
    album = " ".join(str(entry.get("album") or "").casefold().split())
    if not album:
        return None
    artist = " ".join(str(entry.get("album_artist") or entry.get("artist") or "").casefold().split())
    return artist, album
