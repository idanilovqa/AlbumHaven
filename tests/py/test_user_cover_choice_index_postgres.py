"""The automatic cover writer's check of who chose a file reads the same rows at any library size.

It runs under the inventory publication lock for every automatic cover write (scan_cache_persistence's
`_user_cover_choices_sql`), so it must use migration 0290's indexes, never read every album.
Generated rows and a throwaway database only.
"""
import json

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401

SIZES = (1_000, 5_000)
SCANNED = {"local_albums", "local_album_additional_artworks"}


def _grow_to(setup_url, albums):
    """Albums up to `albums`, a third of them chosen by their user, each with its own cover file."""
    with isolatedPostgres._connect(setup_url) as connection:
        library = connection.execute("select id from library.libraries where library_kind = 'local' limit 1").fetchone()["id"]
        have = connection.execute("select count(*) as n from library.local_albums").fetchone()["n"]
        connection.execute(
            """insert into library.local_albums (library_id, album_key, title, cover_path, metadata)
               select %(library)s, 'generated::' || n, 'Generated ' || n, 'N:/Generated/' || n || '/cover.jpg',
                      jsonb_build_object('cover_selection_origin', case when n %% 3 = 0 then 'user' else 'automatic' end,
                                         'selected_local_cover_source_path', 'N:/Generated/' || n || '/back.jpg')
               from generate_series(%(first)s::bigint, %(last)s::bigint) as n""",
            {"library": library, "first": have + 1, "last": albums},
        )
        connection.execute(
            """insert into library.local_album_additional_artworks (album_id, slot, source_kind, cover_path)
               select id, 1, 'local', replace(cover_path, 'cover.jpg', 'second.jpg')
               from library.local_albums
               where album_key like 'generated::%' and id % 10 = 0  -- no parameters: a single % is literal
               on conflict (album_id, slot) do nothing"""
        )
        connection.commit()
        connection.execute("analyze library.local_albums")
        connection.execute("analyze library.local_album_additional_artworks")
        connection.commit()


def _rows_read(setup_url, track_paths):
    """Rows the check reads from the two album tables, as EXPLAIN ANALYZE counts them."""
    from music_app.services.scan_cache_persistence import _user_cover_choices_sql

    with isolatedPostgres._connect(setup_url) as connection:
        plan = connection.execute(
            "explain (analyze, format json) " + _user_cover_choices_sql(),
            {"track_paths": list(track_paths), "cover_paths": ["N:/Generated/4242/cover.jpg"]},
        ).fetchone()
        connection.rollback()
    root = next(iter(plan.values()))
    root = json.loads(root) if isinstance(root, str) else root
    read, nodes = 0, [root[0]["Plan"]]
    while nodes:
        node = nodes.pop()
        nodes.extend(node.get("Plans") or [])
        if node.get("Relation Name") in SCANNED:
            loops = int(node.get("Actual Loops") or 1)
            read += (int(node.get("Actual Rows") or 0) + int(node.get("Rows Removed by Filter") or 0)
                     + int(node.get("Rows Removed by Index Recheck") or 0)) * loops
    return read


def test_live_the_automatic_writers_choice_check_reads_the_same_rows_at_any_library_size(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    entry = fixture.entry("Owner/Album/01.flac", album="Checked Album")
    fixture.seed(entry)

    read = {}
    for size in SIZES:
        _grow_to(fixture.setup_url, size)
        read[size] = _rows_read(fixture.setup_url, {entry["path"]})

    assert read[SIZES[0]] == read[SIZES[1]], f"the check reads more rows in a larger library: {read}"
    assert read[SIZES[1]] < 10, f"the check reads {read[SIZES[1]]} album rows for one file"
