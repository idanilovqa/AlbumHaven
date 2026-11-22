"""A tag save writes its albums' duplicate results in its own transaction, so a fresh view is
right the moment the save commits, with no evaluator having run (owner, 2026-11-22)."""

from __future__ import annotations

import threading

import pytest

from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)


@pytest.fixture
def library(watcher_repair_inventory, monkeypatch):
    import psycopg

    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    from tests.e2e.support import isolatedPostgres

    fixture = watcher_repair_inventory
    # conftest switches the index off to keep its backfill away from other tests.
    monkeypatch.setenv("ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED", "1")
    monkeypatch.setattr(problematic_index, "queue_maintenance", lambda _repository: None)
    from tests.py.runtime_testing import publish_relations_with_each_save

    publish_relations_with_each_save(monkeypatch)

    class Library:
        url = fixture.runtime_url
        repository = PostgresLibraryBrowseRepository(fixture.config)
        adapter = PostgresScanCacheAdapter(fixture.config, connect=isolatedPostgres._connect)

        def album(self, folder, album, year=2001):
            entry = fixture.entry(f"Pair/{folder}/01.flac", artist="Pair", album=album)
            entry.update(album_artist="Pair", year=year)
            return entry

        def seed(self, *entries):
            fixture.seed(*entries)
            problematic_index.prepare_for_serving(self.repository)

        def save(self, entry, *, before_commit=None, **changes):
            updated = {**entry, **changes}
            self.adapter.persist_structural_tag_edit(
                changed_paths={entry["path"]}, previous_file_entries={entry["path"]: entry},
                updated_file_entries={entry["path"]: updated}, changed_field_names=set(changes),
                # As Edit Tags saves an identity field: the patch moves stray ownership too.
                rebuild_relation_projection=True,
                before_commit=before_commit,
            )
            entry.update(updated)

        def sql(self, statement, params=None):
            with psycopg.connect(self.url) as connection:
                return connection.execute(statement, params).fetchall()

        def key(self, entry):
            return self.sql(
                """select albums.album_key from library.local_track_files files
                   join library.local_tracks tracks on tracks.id = files.track_id
                   join library.local_albums albums on albums.id = tracks.album_id
                   where files.private_path = %s and files.scan_cache_stale is false""",
                (entry["path"],),
            )[0][0]

        def marked(self, *entries):
            """What a fresh card reads, without letting that read evaluate anything."""
            stored = dict(self.sql(
                """select album_key, coalesce((result ->> 'has_duplicate_files')::boolean, false)
                   from library.album_duplicate_results where album_key <> ''""",
            ))
            return [bool(stored.get(self.key(entry))) for entry in entries]

    return Library()


def test_live_a_save_stores_both_albums_results_while_maintenance_is_held(library):
    import psycopg
    from psycopg.rows import dict_row

    from music_app.services import problematic_index

    first, second = library.album("One", "Same Release"), library.album("Two", "Other Release")
    library.seed(first, second)
    assert library.marked(first, second) == [False, False]

    with psycopg.connect(library.url, autocommit=True, row_factory=dict_row) as maintenance:
        library_id = library.sql("select library_id from library.local_albums limit 1")[0][0]
        assert problematic_index._locked(maintenance, library_id)

        library.save(second, album="Same Réléase")
        assert library.marked(first, second) == [True, True], "Forming a pair marks both at commit."

        library.save(second, album="Other Release")
        assert library.marked(first, second) == [False, False], "Breaking it clears both at commit."
        assert library.sql("select count(*) from library.problematic_index_dirty_albums where album_id <> 0")[0][0], (
            "The marks stay: the Problematic Files items still need them."
        )


def test_live_saved_results_equal_the_evaluators(library):
    entries = [library.album("One", "Same Release"), library.album("Two", "Other Release"),
               library.album("Three", "Same Release Three"), library.album("Four", "Same Réléase Three")]
    library.seed(*entries)

    for entry, album in ((entries[1], "Same Réléase"), (entries[3], "Sámé Release"), (entries[0], "Moved Away")):
        library.save(entry, album=album)
        keys = [library.key(each) for each in entries]
        saved = {
            key: (result, sorted(linked))
            for key, result, linked in library.sql(
                """select album_key, result, linked_album_ids from library.album_duplicate_results
                   where album_key = any(%s) and result <> '{}'::jsonb""", (keys,),
            )
        }
        from music_app.services import library_browse_postgres as browse
        from tests.e2e.support import isolatedPostgres
        import json

        with isolatedPostgres._connect(library.url) as connection:
            computed = library.repository.compute_duplicate_results_for_album_keys(connection, keys)
        expected = {
            key: (json.loads(browse.encode_duplicate_result(result)), sorted(result["_linked_album_ids"]))
            for key, result in computed.items()
        }
        differences = {
            key: {"saved": saved.get(key), "computed": expected.get(key)}
            for key in {*saved, *expected} if saved.get(key) != expected.get(key)
        }
        assert not differences, f"After renaming to {album}: {json.dumps(differences, sort_keys=True)}"


def test_live_a_save_never_reads_the_whole_identity_index(library, monkeypatch):
    from music_app.services import library_browse_postgres as browse

    first, second = library.album("One", "Same Release"), library.album("Two", "Other Release")
    library.seed(first, second)
    monkeypatch.setattr(
        browse, "_load_duplicate_candidate_album_ids",
        lambda *_a, **_k: pytest.fail("a save's candidates are its affected scope"),
    )

    library.save(second, album="Same Réléase")

    assert library.marked(first, second) == [True, True]


def test_live_a_failed_save_rolls_its_results_back(library):
    first, second = library.album("One", "Same Release"), library.album("Two", "Other Release")
    library.seed(first, second)
    stored = library.sql("select * from library.album_duplicate_results order by album_id")

    def fail(_connection):
        raise RuntimeError("the save fails after its results were written")

    with pytest.raises(RuntimeError, match="after its results"):
        library.save(second, before_commit=fail, album="Same Réléase")

    assert library.sql("select * from library.album_duplicate_results order by album_id") == stored


@pytest.mark.parametrize("change", ["forms", "breaks"])
def test_live_an_older_evaluation_neither_blocks_a_save_nor_overwrites_it(library, monkeypatch, change):
    from music_app.services import problematic_index

    first = library.album("One", "Same Release")
    second = library.album("Two", "Other Release" if change == "forms" else "Same Réléase")
    library.seed(first, second)
    library.sql("select library.mark_problematic_album_dirty(library_id, id) from library.local_albums")

    evaluated, release = threading.Event(), threading.Event()
    write = problematic_index._write

    def paused(*arguments, **options):
        evaluated.set()
        assert release.wait(60)
        return write(*arguments, **options)

    monkeypatch.setattr(problematic_index, "_write", paused)
    evaluation = threading.Thread(target=problematic_index._maintain, args=(library.repository,))
    evaluation.start()
    expected = [change == "forms"] * 2
    try:
        assert evaluated.wait(30), "The evaluation never reached its write."
        saving = threading.Thread(
            target=library.save, args=(second,),
            kwargs={"album": "Same Réléase" if change == "forms" else "Other Release"},
        )
        saving.start()
        saving.join(20)
        assert not saving.is_alive(), "The save waited for the evaluation."
        assert library.marked(first, second) == expected
    finally:
        release.set()
        evaluation.join(60)

    assert library.marked(first, second) == expected, "An older evaluation overwrote the save."
    assert library.sql("select count(*) from library.problematic_index_dirty_albums where album_id <> 0")[0][0] == 0, (
        "The pass retries what the save outran."
    )
