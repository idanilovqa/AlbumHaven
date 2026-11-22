"""Which cards a save folds, decided from its proposed tag values before anything is written.

The rule is publication's own (``STRAY_RULE_CTES``) and a track's destination album is the save's own
(``_structural_destination_album_projection``, ``_same_release_sql``); this module only lays the
proposed tracks and albums over the stored ones. Read-only, and bounded by the edited albums and
those sharing their folded titles.
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from typing import Any

from psycopg.types.json import Jsonb

from music_app.services import scan_cache_persistence as saves
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.library import build_albums_from_file_cache
from music_app.services.postgres_connections import leased_connection
from music_app.services.scoped_relation_projection import STRAY_RULE_CTES
from music_app.services.utils import safe_int

# The page asks when the confirmation opens. Past this it says the fold couldn't be checked.
DECISION_TIMEOUT_MS = 3000
_NUMBER_FIELDS = frozenset({"year", "track_number", "disc_number"})
_DECIDING_FIELDS = frozenset({"album", "album_artist", "artist", "edition", "title"}) | _NUMBER_FIELDS

_EDITED_SQL = """
    select files.private_path, tracks.library_id, tracks.id as track_id, tracks.album_id, tracks.title,
      tracks.disc_number, tracks.track_number, tracks.duration_seconds,
      albums.album_key, albums.artist_id, albums.release_year,
      (select count(*) from library.local_track_files copies
        where copies.track_id = tracks.id and copies.scan_cache_stale is false) as copies
    from library.local_track_files files
    join library.local_tracks tracks on tracks.id = files.track_id
    join library.local_albums albums on albums.id = tracks.album_id
    join library.libraries libraries on libraries.id = tracks.library_id
    join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
    where owners.owner_key = 'local-bootstrap-owner' and libraries.name = 'Local Library'
      and libraries.library_kind = 'local'
      and files.private_path = any(%(paths)s::text[]) and files.scan_cache_stale is false
"""

_SOURCE_FILES_SQL = """
    select count(*) as files
    from library.local_tracks tracks
    join library.local_track_files files on files.track_id = tracks.id and files.scan_cache_stale is false
    where tracks.library_id = %(library_id)s and tracks.album_id = %(album_id)s
"""

# The OFFSET 0 subqueries keep both halves on their indexes (album key; folded title, 0269).
_DESTINATION_SQL = """
    select candidates.id from (
      (select albums.id, albums.album_key from library.local_albums albums
        where albums.library_id = %(library_id)s and albums.album_key = %(destination_album_key)s
        offset 0)
      union
      (select albums.id, albums.album_key from library.local_albums albums
        where albums.library_id = %(library_id)s
          and library.duplicate_identity_text(albums.title)
            = library.duplicate_identity_text(%(destination_album_title)s)
          and """ + saves._same_release_sql(
    "albums", "%(source_artist_id)s", "%(source_year)s",
) + """
        offset 0)
    ) candidates
    where candidates.id <> %(source_album_id)s
    order by candidates.album_key <> %(destination_album_key)s, candidates.id
    limit 1
"""

_DECISION_SQL = """
        with proposed_albums as materialized (
          select * from jsonb_to_recordset(%(albums)s::jsonb)
            as proposed(id bigint, album_key text, title text, release_year integer, album_artist text)
        ), proposed_tracks as materialized (
          select * from jsonb_to_recordset(%(tracks)s::jsonb)
            as proposed(id bigint, album_id bigint, title text, disc_number integer, track_number integer,
              duration_seconds double precision, paths text[])
        ), seed_albums as materialized (
          select albums.id, library.duplicate_identity_text(albums.title) as title_identity
          from library.local_albums albums
          where albums.library_id=%(library_id)s
            and (
              albums.id=any(%(album_ids)s::bigint[])
              or albums.metadata #>> '{stray_duplicate_of,album_id}'
                   = any(%(album_id_texts)s::text[])
            )
        ), title_identities as materialized (
          select title_identity from seed_albums
          where title_identity <> '' and not (id = any(%(proposed_album_ids)s::bigint[]))
          union
          select library.duplicate_identity_text(title) from proposed_albums
          where library.duplicate_identity_text(title) <> ''
        ), scoped_albums as materialized (
          select albums.id, albums.album_key, albums.title, albums.release_year,
            library.duplicate_identity_text(albums.title) as title_identity,
            library.duplicate_identity_text(
              coalesce(nullif(albums.metadata ->> 'album_artist', ''), artists.name)
            ) as artist_identity
          from library.local_albums albums
          join library.local_artists artists on artists.id=albums.artist_id
          join title_identities
            on title_identities.title_identity=library.duplicate_identity_text(albums.title)
          where albums.library_id=%(library_id)s
            and not (albums.id = any(%(proposed_album_ids)s::bigint[]))
          union all
          select id, album_key, title, release_year,
            library.duplicate_identity_text(title), library.duplicate_identity_text(album_artist)
          from proposed_albums
        ), tracks_after as materialized (
          select tracks.id, tracks.album_id, tracks.title, tracks.disc_number, tracks.track_number,
            tracks.duration_seconds::double precision as duration_seconds, stored.paths
          from library.local_tracks tracks
          cross join lateral (
            select array_agg(files.private_path) as paths
            from library.local_track_files files
            where files.track_id=tracks.id and files.scan_cache_stale is false
              and not (files.private_path = any(%(edited_paths)s::text[]))
          ) stored
          where tracks.album_id = any(array(select id from scoped_albums))
            and tracks.library_id=%(library_id)s
            and stored.paths is not null
          union all
          select id, album_id, title, disc_number, track_number, duration_seconds, paths
          from proposed_tracks
          where album_id = any(array(select id from scoped_albums))
        ), active_tracks as materialized (
          select id, album_id, library.duplicate_identity_text(title) as title_identity, duration_seconds,
            row_number() over (
              partition by album_id
              order by coalesce(disc_number, 1), coalesce(track_number, 2147483647), id
            ) as track_position
          from tracks_after
""" + STRAY_RULE_CTES + """        ), members as materialized (
          select tracks_after.album_id, array_agg(path order by path) as paths
          from tracks_after, unnest(tracks_after.paths) path
          group by tracks_after.album_id
        )
        select scoped_albums.album_key, members.paths as track_paths, owners.paths as folds_into,
          owner_albums.album_key as folds_into_key,
          coalesce(stored.metadata ? 'stray_duplicate_of', false) as was_folded,
          stored.metadata #>> '{stray_duplicate_of,album_key}' as was_folded_into_key,
          former.paths as was_folded_into,
          scoped_albums.title, scoped_albums.release_year,
          coalesce(nullif(proposed.album_artist, ''), nullif(stored.metadata ->> 'album_artist', ''),
            artists.name) as album_artist,
          stored.cover_path, stored.metadata ->> 'cover_revision' as cover_revision
        from desired
        join scoped_albums on scoped_albums.id=desired.id
        join members on members.album_id=desired.id
        left join members owners on owners.album_id=(desired.ownership ->> 'album_id')::bigint
        left join scoped_albums owner_albums on owner_albums.id=(desired.ownership ->> 'album_id')::bigint
        left join library.local_albums stored on stored.id=desired.id
        left join proposed_albums proposed on proposed.id=desired.id
        left join library.local_artists artists on artists.id=stored.artist_id
        left join members former
          on former.album_id=(stored.metadata #>> '{stray_duplicate_of,album_id}')::bigint
"""


def decide_stray_folds(
    connection: Any,
    *,
    previous_entries: Mapping[str, dict[str, object]],
    updated_entries: Mapping[str, dict[str, object]],
    changed_fields: set[str],
) -> dict[str, object]:
    """Every album the save can fold or unfold, with the album it would fold into."""
    # Read first: a save committing while this decides makes the answer read as stale.
    revision = int(saves._load_inventory_mutation_revision(connection) or 0)
    previous, updated = dict(previous_entries), dict(updated_entries)
    edited = {row["private_path"]: row for row in connection.execute(
        _EDITED_SQL, {"paths": sorted(previous)},
    ).fetchall()}
    if not edited:
        return {"inventory_mutation_revision": revision, "albums": []}
    library_id = next(iter(edited.values()))["library_id"]
    paths = sorted(edited)
    groups, *_rest = saves._structural_tag_edit_groups(connection, paths, previous, updated, set(changed_fields))
    moves_albums = not set(changed_fields) <= saves._TARGETED_INVENTORY_EDIT_FIELDS
    separate_keys = saves._load_separate_release_keys(connection) if moves_albums else set()

    albums: dict[int, dict[str, object]] = {}
    album_of_path = {path: edited[path]["album_id"] for path in paths}
    new_album_of_key: dict[str, int] = {}
    for group in groups if moves_albums else ():
        source = edited[group[0]]
        destination = saves._structural_destination_album_projection(
            build_albums_from_file_cache, {path: updated[path] for path in group},
            frozenset(changed_fields), separate_keys,
        )
        album = _destination_album(
            connection, library_id, source, group, destination, changed_fields, separate_keys,
            new_album_of_key,
        )
        for path in group:
            album_of_path[path] = album["id"]
        if "album_key" in album:
            albums[album["id"]] = album
            new_album_of_key[str(album["album_key"])] = album["id"]

    scope = {row["album_id"] for row in edited.values()} | {album for album in album_of_path.values() if album > 0}
    rows = connection.execute(_DECISION_SQL, {
        "library_id": library_id,
        "album_ids": sorted(scope),
        "album_id_texts": [str(album) for album in sorted(scope)],
        "albums": Jsonb(list(albums.values())),
        "proposed_album_ids": sorted(albums),
        "tracks": Jsonb(_proposed_tracks(edited, updated, album_of_path)),
        "edited_paths": paths,
    }).fetchall()
    return {
        "inventory_mutation_revision": revision,
        "albums": [
            {
                "album_key": row["album_key"],
                "track_paths": row["track_paths"],
                "folds_into": row["folds_into"],
                "folds_into_key": row["folds_into_key"],
                "was_folded_into_key": row["was_folded_into_key"],
                "was_folded_into": row["was_folded_into"],
                # The page holds no card for a folded copy, so one that unfolds brings its own.
                "card": _unfolded_card(row) if row["was_folded"] and not row["folds_into"] else None,
            }
            for row in rows
        ],
    }


def decide_stray_folds_for_save(
    config: Mapping[str, object], updates: Mapping[str, Mapping[str, object]],
) -> dict[str, object]:
    """The decision for exactly these updates, or a readable reason there is none."""
    from psycopg import errors

    with leased_connection(str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")) as connection:
        connection.execute(f"set local statement_timeout = {DECISION_TIMEOUT_MS}")
        made_from = saves._load_inventory_mutation_revision(connection)
        previous = PostgresLibraryBrowseRepository(config).build_track_file_entries_by_paths(set(updates))
        if set(updates) - set(previous):
            return {"ok": False, "code": "outdated"}
        updated, changed_fields = {}, set()
        for path, values in updates.items():
            entry = dict(previous[path])
            for field in _DECIDING_FIELDS & set(values):
                value, was = _tag_value(field, values[field]), _tag_value(field, entry.get(field))
                if value != was:
                    entry[field] = value
                    changed_fields.add(field)
            updated[path] = entry
        if not changed_fields:
            return {"ok": True, "inventory_mutation_revision": made_from, "albums": []}
        try:
            decision = decide_stray_folds(
                connection, previous_entries=previous, updated_entries=updated, changed_fields=changed_fields,
            )
        except (errors.QueryCanceled, errors.LockNotAvailable):
            connection.rollback()
            return {"ok": False, "code": "timed_out"}
        except (saves.StructuralTagEditDestinationConflict, ValueError):
            connection.rollback()
            return {"ok": False, "code": "undecidable"}
        # Another writer committed while this decided: its answer may no longer be the save's.
        if saves._load_inventory_mutation_revision(connection) != made_from:
            return {"ok": False, "code": "outdated"}
    return {"ok": True, **decision}


def _tag_value(field: str, value: object) -> object:
    text = str(value if value is not None else "").strip()
    return safe_int(text.split("/", 1)[0]) if field in _NUMBER_FIELDS else text


def _unfolded_card(row: Mapping[str, object]) -> dict[str, object]:
    return {
        "key": row["album_key"],
        "name": row["title"],
        "album_artist": row["album_artist"],
        "year": row["release_year"],
        "cover_path": row["cover_path"],
        "cover_revision": row["cover_revision"],
        "track_count_preview": len(row["track_paths"]),
        "track_paths": row["track_paths"],
        "tracks": [],
        "preview_only": True,
        "has_duplicate_files": False,
    }


def _destination_album(
    connection, library_id, source, group, destination, changed_fields, separate_keys, new_album_of_key,
) -> dict[str, object]:
    """The album a group's tracks are in after the save: only an id when it stays as stored."""
    key = str(getattr(destination, "key", "") or "").strip()
    if key in new_album_of_key:
        return {"id": new_album_of_key[key]}
    title = str(getattr(destination, "name", "") or "Unknown Album")
    edition = str(getattr(destination, "edition", None) or "").strip()
    updates_year = "year" in changed_fields
    explicit = updates_year and saves.album_separate_release_key(
        str(destination.album_artist or ""), title, getattr(destination, "edition", None),
    ) in separate_keys
    year = safe_int(getattr(destination, "year", None))
    partial = len(group) < connection.execute(
        _SOURCE_FILES_SQL, {"library_id": library_id, "album_id": source["album_id"]},
    ).fetchone()["files"]
    if not explicit or partial:
        existing = connection.execute(_DESTINATION_SQL, {
            "library_id": library_id,
            "source_album_id": source["album_id"],
            "source_artist_id": source["artist_id"],
            "source_year": source["release_year"],
            "destination_album_key": key,
            "destination_album_title": title,
            "destination_edition": edition,
            "destination_release_year": year,
            "updates_release_year": updates_year,
        }).fetchone()
        if existing:
            return {"id": existing["id"]}
        if partial and not updates_year and key == source["album_key"]:
            return {"id": source["album_id"]}
    return {
        # A new album publishes after every stored one, so it loses an equal-size tie: keep it above them.
        "id": _NEW_ALBUM_IDS + len(new_album_of_key) if partial else source["album_id"],
        "album_key": source["album_key"] if explicit and not partial else key,
        "title": title,
        "release_year": year if updates_year else source["release_year"],
        "album_artist": destination.album_artist,
    }


# Above every sequence-issued album id, below bigint's limit.
_NEW_ALBUM_IDS = 2**62


def _proposed_tracks(edited, updated, album_of_path) -> list[dict[str, object]]:
    selected = defaultdict(list)
    for path, row in edited.items():
        selected[row["track_id"]].append(path)
    tracks = []
    for track_id, paths in selected.items():
        row, entry = edited[paths[0]], updated[paths[0]]
        tracks.append({
            # Editing some copies of a track gives them a track of their own, issued after the others.
            "id": _NEW_ALBUM_IDS + track_id if len(paths) < row["copies"] else track_id,
            "album_id": album_of_path[paths[0]],
            "title": entry.get("title") or row["title"],
            "disc_number": safe_int(entry.get("disc_number", row["disc_number"])),
            "track_number": safe_int(entry.get("track_number", row["track_number"])),
            "duration_seconds": float(row["duration_seconds"]) if row["duration_seconds"] is not None else None,
            "paths": [str(updated[path].get("path") or path) for path in paths],
        })
    return tracks
