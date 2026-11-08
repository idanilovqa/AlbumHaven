"""Retirement of local album rows that no longer own any track.

A scan or watcher publication moves a track to another album row when its
identity changes (for example an edition or album-key change). The row it
leaves stays behind with zero tracks: it is in no gallery or Problematic Files
projection, but it still counts as an album. Retiring that row belongs to the
same transaction as the move.

A row is retired only when nothing on it records a user decision. Rows that
carry one are kept, so no manual choice is lost or reassigned by inference.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

# Tables whose foreign key to library.local_albums holds only scan-derived
# rows; deleting the album may cascade them.
SCAN_OWNED_ALBUM_CHILD_TABLES = frozenset(
    {
        "library.local_tracks",
        "library.local_album_featured_artists",
        "library.local_album_cover_candidate_snapshots",
    }
)
# Tables whose foreign key to library.local_albums may hold a user decision;
# a named guard below checks each one.
GUARDED_ALBUM_CHILD_TABLES = frozenset(
    {
        "app.album_ratings",
        "library.local_mbid_assertions",
    }
)

# Each guard is true when the album row (alias `album`) lacks that kind of
# state. A row is retirable only when every guard holds.
RETIREMENT_GUARDS: tuple[tuple[str, str], ...] = (
    # Any track row, active or stale: a missing album keeps its history.
    ("has_tracks", """not exists (
      select 1 from library.local_tracks as track
      where track.album_id = album.id)"""),
    # Ambiguous legacy `user` origins count as a cover choice too.
    ("cover_selection", """coalesce(album.metadata ->> 'cover_selection_origin', '') <> 'user'
      and coalesce(album.metadata ->> 'cover_selection_provenance', '') <> 'explicit'"""),
    # `missing` is the automatic no-evidence classification.
    ("mbid_decision", """album.mbid is null
      and album.evidence_source is null
      and album.mbid_assertion_state in ('unreviewed', 'missing')
      and not exists (
        select 1 from library.local_mbid_assertions as assertion
        where assertion.album_id = album.id)"""),
    # A rating seeded from file tags travels with the moved tracks' tags.
    ("rating", """not exists (
      select 1 from app.album_ratings as rating
      where rating.library_id = album.library_id
        and rating.album_key = album.album_key
        and rating.provenance <> 'file_tag_scan')"""),
    ("version_decision", """not exists (
      select 1 from library.manual_versions as version
      where version.library_id = album.library_id
        and album.album_key in (version.child_key, version.parent_key))
      and not exists (
        select 1 from library.ignored_versions as ignored
        where ignored.library_id = album.library_id
          and ignored.version_key = album.album_key)"""),
    ("separate_release", """not exists (
      select 1 from library.separate_releases as separate_release
      where separate_release.library_id = album.library_id
        and separate_release.release_key = album.album_key)"""),
    ("cover_lookup_task", """not exists (
      select 1 from ops.cover_lookup_tasks as cover_task
      where cover_task.library_id = album.library_id
        and cover_task.album_key = album.album_key)"""),
)

RETIRABLE_EMPTY_ALBUM_PREDICATE_SQL = "\n      and ".join(
    f"({clause})" for _name, clause in RETIREMENT_GUARDS
)


def retire_vacated_local_albums(
    connection: Any,
    vacated_album_ids: Iterable[int],
) -> None:
    """Delete the given album rows that are now empty and carry no user state.

    Call inside the publication transaction that moved tracks out of these
    rows.
    """
    album_ids = sorted({int(album_id) for album_id in vacated_album_ids})
    if album_ids:
        connection.execute(
            f"""
            delete from library.local_albums as album
            where album.id = any(%(album_ids)s::bigint[])
              and {RETIRABLE_EMPTY_ALBUM_PREDICATE_SQL}
            """,
            {"album_ids": album_ids},
        )
