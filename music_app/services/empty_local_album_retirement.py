"""Retirement of local album rows that no longer own any track.

A scan or watcher publication moves a track to another album row when its
identity changes (for example an edition or album-key change). The row it
leaves stays behind with zero tracks: it is in no gallery or Problematic Files
projection, but it still counts as an album. Retiring that row belongs to the
same transaction as the move.

A row is retired only when nothing on it records a user decision. Rows that
carry one are kept, so no manual choice is lost or reassigned by inference.
Ratings (album and disc) and the album's MusicBrainz artist identity are never
dropped: when every moved track went to one successor row, each is carried
there unless the successor already holds its own, and the row is retired only
when the successor holds an equal one for every one. Otherwise the row is kept.
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
        "app.album_disc_ratings",
        "library.local_album_artist_identities",
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
    # Any rating, whatever its provenance; a move carries it first (below).
    ("rating", """not exists (
      select 1 from app.album_ratings as rating
      where rating.library_id = album.library_id
        and rating.album_key = album.album_key)"""),
    ("disc_rating", """not exists (
      select 1 from app.album_disc_ratings as rating
      where rating.library_id = album.library_id
        and rating.album_key = album.album_key)"""),
    ("artist_identity", """not exists (
      select 1 from library.local_album_artist_identities as identity
      where identity.library_id = album.library_id
        and identity.album_key = album.album_key)"""),
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


# State a move carries to the successor row, by guard: its table, the columns that
# identify one row beside the album, the value that must match, and the columns copied.
_RATING_COPY = ("provenance", "created_at", "updated_at", "metadata")
_CARRIED_TABLES = {
    "rating": ("app.album_ratings", ("account_id",), "rating", _RATING_COPY),
    "disc_rating": ("app.album_disc_ratings", ("account_id", "disc_key"), "rating", _RATING_COPY),
    "artist_identity": ("library.local_album_artist_identities", (), "artist_mbid",
                        ("decision_source", "evidence", "tag_differs", "matcher_version", "created_at", "updated_at")),
}
_UNRATED_GUARDS_SQL = "\n      and ".join(
    f"({clause})" for name, clause in RETIREMENT_GUARDS if name not in _CARRIED_TABLES
)
# Vacated rows (alias `album`) that pass every guard but the carried ones,
# with their single successor row (alias `successor`), when there is one.
_VACATED_ALBUMS_SQL = f"""
    from unnest(%(album_ids)s::bigint[], %(successor_ids)s::bigint[])
      as move(album_id, successor_id)
    join library.local_albums as album on album.id = move.album_id
    left join library.local_albums as successor on successor.id = move.successor_id
    where {_UNRATED_GUARDS_SQL}
"""


def retire_vacated_local_albums(
    connection: Any,
    moves: Iterable[tuple[int, int | None]],
) -> None:
    """Retire album rows that tracks moved out of, keeping user state.

    `moves` pairs each vacated album id with the album id a track moved to
    (None when it left the album without a new one). Call inside the
    publication transaction that made those moves.
    """
    successors: dict[int, set[int | None]] = {}
    for album_id, successor_id in moves:
        successors.setdefault(int(album_id), set()).add(successor_id)
    if not successors:
        return
    album_ids = sorted(successors)
    parameters = {
        "album_ids": album_ids,
        "successor_ids": [
            next(iter(targets)) if len(targets) == 1 else None
            for targets in (successors[album_id] for album_id in album_ids)
        ],
    }
    uncarried = []
    for table, keys, value, copied in _CARRIED_TABLES.values():
        columns = ", ".join((*keys, value, *copied))
        source_columns = ", ".join(f"state.{column}" for column in (*keys, value, *copied))
        conflict_columns = "".join(f", {key}" for key in keys)
        same_keys = "".join(f"and carried.{key} = state.{key} " for key in keys)
        connection.execute(
            f"""
            insert into {table} (library_id, album_key, {columns})
            select state.library_id, vacated.successor_key, {source_columns}
            from (select album.library_id, album.album_key,
                         successor.album_key as successor_key
                  {_VACATED_ALBUMS_SQL}) as vacated
            join {table} as state
              on state.library_id = vacated.library_id
             and state.album_key = vacated.album_key
            where vacated.successor_key is not null
            on conflict (library_id, album_key{conflict_columns}) do nothing
            """,
            parameters,
        )
        # Retired only when the successor holds an equal value for every one.
        uncarried.append(f"""not exists (
            select 1 from {table} as state
            where state.library_id = retired.library_id
              and state.album_key = retired.album_key
              and not exists (
                select 1 from {table} as carried
                where carried.library_id = state.library_id
                  and carried.album_key = vacated.successor_key
                  {same_keys}and carried.{value} is not distinct from state.{value}))""")
    connection.execute(
        f"""
        delete from library.local_albums as retired
        using (select album.id, successor.album_key as successor_key
               {_VACATED_ALBUMS_SQL}) as vacated
        where retired.id = vacated.id
          and {' and '.join(uncarried)}
        """,
        parameters,
    )
