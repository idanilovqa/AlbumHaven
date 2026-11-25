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


# The SQL definition of the same rule, read by every browse surface (Problematic Files rows, Album Details).
# DUPLICATE DEFINITION of strict_multi_album_folders above, kept only for the in-memory cover paths:
# tests/py/test_strict_multi_album_folder_duplicate_definition_postgres.py runs one case table through both.
def strict_multi_album_folders_sql(files_sql: str, other_parent_sql) -> str:
    """CTEs ending in strict_mixed_folders(library_id, library_root_id, physical_parent): the folders of
    ``files_sql`` that hold several albums. ``files_sql`` selects the files of every folder it may decide, with
    library_id, library_root_id, physical_parent, file_id, album_id, disc_number, track_number and
    membership_problem. The tags the rule reads come from the files of folders with more than one album only.
    ``other_parent_sql(path)`` is the physical parent of another file, for an album's files outside the folder.

    Set-based and per folder: only folders with more than one album are decided, and an album's files elsewhere
    are found by its id (local_tracks album index)."""
    # The same disc-marker pattern: Postgres regular expressions read (?:), \d, \s and \uXXXX alike.
    marker = _DISC_MARKER.pattern.replace("'", "''")
    folder = "library_id, library_root_id, physical_parent"
    return f"""
        strict_candidate_folders as materialized (
          select {folder} from (
            select distinct {folder}, album_id from ({files_sql}) files where album_id is not null
          ) folder_albums
          group by {folder} having count(*) > 1
        ),
        strict_folder_tagged_files as materialized (
          -- _album_identity: the album tag, and the album artist tag or else the artist tag, case- and space-folded.
          select files.*,
            nullif(regexp_replace(lower(btrim(coalesce(tags.metadata #>> '{{scan_cache,file_entry,album}}', ''))),
              '[[:space:]]+', ' ', 'g'), '') as album_title,
            regexp_replace(lower(btrim(coalesce(
              nullif(btrim(tags.metadata #>> '{{scan_cache,file_entry,album_artist}}'), ''),
              tags.metadata #>> '{{scan_cache,file_entry,artist}}', ''))), '[[:space:]]+', ' ', 'g') as album_artist,
            case when tags.metadata #>> '{{scan_cache,file_entry,total_tracks}}' ~ '^[0-9]{{1,6}}$'
              then (tags.metadata #>> '{{scan_cache,file_entry,total_tracks}}')::integer end as total_tracks,
            btrim(coalesce(tags.metadata #>> '{{scan_cache,file_entry,exception_type}}', '')) as exception_type
          from ({files_sql}) files
          join strict_candidate_folders using ({folder})
          join library.local_track_files tags on tags.id = files.file_id
          -- A proven copy of another album's track does not count (multi_album_folders._PROVEN_COPY).
          where coalesce(files.membership_problem, '') <> '{_PROVEN_COPY}'
        ),
        strict_folder_files as materialized (
          select files.*, case when album_title is not null then album_artist || chr(31) || album_title end as album_key
          from strict_folder_tagged_files files
        ),
        strict_folder_albums as materialized (
          select {folder}, album_key, max(album_title) as album_title, bool_and(complete) as complete
          from (
            -- album_completeness.album_is_complete: per disc the numbers run 1..N, N the tagged total or the highest.
            select {folder}, album_key, max(album_title) as album_title,
              bool_and(coalesce(track_number, 0) > 0) and min(track_number) = 1
                and count(distinct track_number) = max(track_number)
                and coalesce(max(total_tracks) filter (where total_tracks > 0), max(track_number)) = max(track_number)
                as complete
            from strict_folder_files
            where album_key is not null
            group by {folder}, album_key, coalesce(nullif(disc_number, 0), 1)
          ) discs
          group by {folder}, album_key
        ),
        strict_folder_shapes as materialized (
          select {folder},
            count(*) as albums, bool_and(complete) as complete,
            count(*) filter (where album_title ~* '{marker}') as disc_marked
          from strict_folder_albums group by {folder}
        ),
        strict_folder_disc_splits as materialized (
          -- One release split by disc: a marked tag that equals another album's tag once its marker goes.
          select distinct marked.library_id, marked.library_root_id, marked.physical_parent
          from strict_folder_albums marked
          join strict_folder_albums unmarked using ({folder})
          where marked.album_title ~* '{marker}' and unmarked.album_title !~* '{marker}'
            and btrim(regexp_replace(marked.album_title, '{marker}', '', 'gi'), ' -\u2013\u2014,.:') = unmarked.album_title
        ),
        strict_folder_album_ids as materialized (
          select distinct {folder}, album_id from strict_folder_files where album_id is not null
        ),
        strict_folders_with_albums_elsewhere as materialized (
          select distinct folder_albums.library_id, folder_albums.library_root_id, folder_albums.physical_parent
          from strict_folder_album_ids folder_albums
          where exists (
            select 1 from library.local_tracks other_tracks
            join library.local_track_files other_files
              on other_files.track_id = other_tracks.id and other_files.scan_cache_stale is false
            where other_tracks.album_id = folder_albums.album_id
              and {other_parent_sql("other_files.private_path")} <> folder_albums.physical_parent
          )
        ),
        strict_folders_with_loose_songs as materialized (
          -- A song without an album tag, or with an exception type, makes the folder a collection.
          select distinct {folder} from strict_folder_files
          where album_key is null or coalesce(exception_type, '') <> ''
        ),
        strict_mixed_folders as materialized (
          select {folder} from strict_folder_shapes shapes
          where shapes.albums >= 2 and shapes.complete and shapes.disc_marked < 2
            and ({folder}) not in (select {folder} from strict_folders_with_loose_songs)
            and ({folder}) not in (select {folder} from strict_folder_disc_splits)
            and ({folder}) not in (select {folder} from strict_folders_with_albums_elsewhere)
        )"""
