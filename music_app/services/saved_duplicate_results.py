"""A tag save's own write of the duplicate results it changes (migration 0268).

Gallery and search cards read stored results, so the save stores them before it commits: a
fresh view is then right at once, whether or not an evaluator is free. The journal marks
stay for the Problematic Files items, whose evaluation later rewrites the same rows.

Only the save's affected scope is read. Every album in it gets a row, an explicit
no-duplicate one where nothing changes a card (readers treat that as absent): the row is
what makes an evaluator with an older snapshot fail its write and retry, instead of
overwriting this save.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from music_app.services import problematic_index
from music_app.services.edit_tag_timings import persistence_stage

NO_DUPLICATE = "{}"

# The albums this transaction changed, as the journal's triggers marked them: old and new
# identities, and any stray ownership it moved. None while the results are not ready; their
# backfill and the marks then cover the save.
_CHANGED_ALBUMS_SQL = """
    select marks.library_id, array_agg(marks.album_id order by marks.album_id) as album_ids
    from library.problematic_index_dirty_albums marks
    join library.album_duplicate_results_state state
      on state.library_id = marks.library_id and state.version = %s and state.status = 'ready'
    where marks.marked_xid = pg_current_xact_id() and marks.album_id <> 0
    group by marks.library_id
"""


def _linked(connection: Any, library_id: int, album_ids: list[int]) -> list[int]:
    return sorted({
        int(problematic_index._value(row, "album_id"))
        for row in connection.execute(
            problematic_index._LINKED_ALBUMS_SQL, {"library_id": library_id, "album_ids": album_ids},
        ).fetchall()
    })


def _scope(connection: Any, library_id: int, album_ids: list[int], old_identities: list[str]) -> list[object]:
    return connection.execute(
        problematic_index._SCOPE_SQL,
        {"library_id": library_id, "album_ids": album_ids, "old_identities": old_identities},
    ).fetchall()


def write_saved_duplicate_results(connection: Any, config: Mapping[str, object]) -> None:
    """Store the duplicate results this transaction changed. Call it last before the commit."""
    if not problematic_index._enabled(config):
        return
    value = problematic_index._value
    with persistence_stage("duplicate_results.changed_albums"):
        changed = connection.execute(
            _CHANGED_ALBUMS_SQL, (problematic_index.DUPLICATE_RESULTS_VERSION,),
        ).fetchone()
    if changed is None:
        return
    library_id = int(value(changed, "library_id"))
    # Compiling these reads costs more than running them over a few albums.
    connection.execute("set local jit = off")
    with persistence_stage("duplicate_results.linked_albums"):
        album_ids = _linked(connection, library_id, [int(album_id) for album_id in value(changed, "album_ids")])
    with persistence_stage("duplicate_results.old_identities"):
        old_identities = [
            str(identity)
            for row in connection.execute(
                """select unnest(duplicate_identities) as identity from library.problematic_index_items
                   where library_id = %s and album_id = any(%s::bigint[])""",
                (library_id, album_ids),
            ).fetchall()
            if (identity := value(row, "identity"))
        ]
    with persistence_stage("duplicate_results.scope"):
        scope = _scope(connection, library_id, album_ids, old_identities)
        scoped_ids = sorted({int(value(row, "album_id")) for row in scope})
    with persistence_stage("duplicate_results.candidates"):
        # An album pulled in as a peer may have peers of its own, through another identity
        # or a stray link: its result needs those as candidates, though they need no rewrite.
        known = set(old_identities)
        further = set()
        for row in scope:
            identities = set(value(row, "identities") or [])
            (known if int(value(row, "album_id")) in album_ids else further).update(identities)
        peers = _linked(connection, library_id, scoped_ids)
        candidate_ids = scoped_ids
        if further - known or set(peers) - set(scoped_ids):
            candidate_ids = sorted({*scoped_ids, *peers, *(
                int(value(row, "album_id")) for row in _scope(connection, library_id, peers, [])
            )})

    browse = problematic_index._browse()
    albums = {str(key): int(value(row, "album_id")) for row in scope if (key := value(row, "album_key"))}
    results = browse.PostgresLibraryBrowseRepository(dict(config)).compute_duplicate_results_for_album_keys(
        connection, albums, candidate_album_ids=candidate_ids,
    ) if albums else {}
    # An album this save emptied keeps a row under no key, for the same reason.
    rows = {
        album_id: {"library_id": library_id, "album_id": album_id, "album_key": "",
                   "result": NO_DUPLICATE, "linked_album_ids": []}
        for album_id in scoped_ids
    }
    for key, album_id in albums.items():
        rows[album_id]["album_key"] = key
        if key in results:
            rows[album_id].update(
                result=browse.encode_duplicate_result(results[key]),
                linked_album_ids=results[key]["_linked_album_ids"],
            )
    with persistence_stage("duplicate_results.write"):
        # In album order, as the evaluators write, so the two cannot deadlock.
        connection.cursor().executemany(
            problematic_index._DUPLICATE_RESULT_SQL, [rows[album_id] for album_id in scoped_ids],
        )
