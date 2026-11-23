"""A tag save writes its albums' duplicate results in its own transaction, so a fresh view is
right the moment the save commits, with no evaluator having run (owner, 2026-11-22)."""

from __future__ import annotations

import threading
from types import SimpleNamespace

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
        setup_url = fixture.setup_url
        repository = PostgresLibraryBrowseRepository(fixture.config)
        adapter = PostgresScanCacheAdapter(fixture.config, connect=isolatedPostgres._connect)

        def album(self, folder, album, year=2001, track=1):
            entry = fixture.entry(f"Pair/{folder}/{track:02d}.flac", artist="Pair", album=album)
            entry.update(album_artist="Pair", year=year)
            return entry

        def seed(self, *entries):
            fixture.seed(*entries)
            problematic_index.prepare_for_serving(self.repository)

        def save(self, entry, *, before_commit=None, **changes):
            self.save_files([entry], before_commit=before_commit, **changes)

        def save_files(self, entries, *, before_commit=None, **changes):
            previous = {entry["path"]: dict(entry) for entry in entries}
            updated = {path: {**entry, **changes} for path, entry in previous.items()}
            self.adapter.persist_structural_tag_edit(
                changed_paths=set(previous), previous_file_entries=previous,
                updated_file_entries=updated, changed_field_names=set(changes),
                # As Edit Tags saves an identity field: the patch moves stray ownership too.
                rebuild_relation_projection=True,
                before_commit=before_commit,
            )
            for entry in entries:
                entry.update(changes)

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
        assert maintenance.execute(  # what a maintenance pass holds for its whole run
            "select pg_try_advisory_lock(%s, %s::integer) as locked", (problematic_index._LOCK_NAMESPACE, library_id),
        ).fetchone()["locked"]

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


# Plan rows the write's reads produce for each track of an affected album: at most 48.6 as
# measured (16 of them the scope query's, the rest mostly the source rows').
ROWS_PER_AFFECTED_TRACK = 50


def _assert_no_read_grew(small, large):
    """Statement by statement: one read's fall must not hide another's growth."""
    assert small.keys() == large.keys(), (small, large)
    grown = {read: (small[read], rows) for read, rows in large.items() if rows > small[read] + 5}
    assert not grown, f"The library's size costs nothing: {grown}"


class _CountingReads:
    """The save's connection: counts its statements, and the rows every plan node of its reads
    produced. Sequential scans are off, as a planner leaves them at library size, so reading
    a whole table or index shows as growth with the library."""

    def __init__(self, connection, counts):
        self._connection, self._counts = connection, counts

    def execute(self, query, params=None, **options):
        from psycopg.rows import tuple_row

        from tests.py.bounded_interactions import explain_actual_rows

        self._counts["statements"] += 1
        if str(query).lstrip().lower().startswith(("select", "with")):
            plans = SimpleNamespace(cursor=lambda: self._connection.cursor(row_factory=tuple_row))
            rows = explain_actual_rows(plans, query, params)
            self._counts["plan_rows"] += rows
            # Which read grew, when one does.
            self._counts[f"{self._counts['statements']}: {' '.join(str(query).split())[:70]}"] = rows
        return self._connection.execute(query, params, **options)

    def cursor(self, *arguments, **options):
        self._counts["statements"] += 1
        return self._connection.cursor(*arguments, **options)

    def __getattr__(self, name):
        return getattr(self._connection, name)


def test_live_a_saves_write_reads_the_same_rows_whatever_the_library_size(library, monkeypatch):
    import psycopg

    from music_app.services import saved_duplicate_results

    first, second = library.album("One", "Same Release"), library.album("Two", "Other Release")
    write, counts = saved_duplicate_results.write_saved_duplicate_results, {}

    def counted(connection, config):
        connection.execute("set local enable_seqscan = off")
        write(_CountingReads(connection, counts), config)

    monkeypatch.setattr(saved_duplicate_results, "write_saved_duplicate_results", counted)

    def save_among(unrelated):
        others = []
        for number in range(unrelated):
            entry = library.album(f"Unrelated {number}", f"Unrelated {number}")
            entry["album_artist"] = entry["artist"] = f"Artist {number}"
            others.append(entry)
        library.seed(first, second, *others)
        with psycopg.connect(library.setup_url, autocommit=True) as connection:
            connection.execute("analyze")
        counts.clear()
        counts.update(statements=0, plan_rows=0)
        library.save(second, album="Same Réléase")
        measured = dict(counts)
        library.save(second, album="Other Release")
        return measured

    small, large = save_among(50), save_among(1000)

    assert large["statements"] == small["statements"] <= 12
    _assert_no_read_grew(small, large)


def test_live_a_save_neither_waits_for_nor_is_lost_to_a_running_backfill(library, monkeypatch):
    from music_app.services import problematic_index

    first, second = library.album("One", "Same Release"), library.album("Two", "Other Release")
    library.seed(first, second)
    evaluate, filling, release, failures = problematic_index._duplicate_result_rows, threading.Event(), threading.Event(), []

    def paused(*arguments):
        rows = evaluate(*arguments)
        if not filling.is_set():
            filling.set()
            assert release.wait(60)
        return rows

    def fill():
        try:
            problematic_index.prepare_for_serving(library.repository, rebuild_duplicates=True)
        except Exception as error:
            failures.append(error)

    monkeypatch.setattr(problematic_index, "_duplicate_result_rows", paused)
    backfill = threading.Thread(target=fill)
    backfill.start()
    try:
        assert filling.wait(30), "The backfill never evaluated."
        saving = threading.Thread(target=library.save, args=(second,), kwargs={"album": "Same Réléase"})
        saving.start()
        saving.join(20)
        assert not saving.is_alive(), "The save waited for the backfill."
    finally:
        release.set()
        backfill.join(60)

    assert failures == []
    assert library.marked(first, second) == [True, True], "The backfill's older snapshot lost the save."


@pytest.mark.parametrize("change", ["forms", "breaks"])
def test_live_a_save_behind_an_evaluators_final_write_waits_only_for_its_commit(library, monkeypatch, change):
    from music_app.services import problematic_index

    first = library.album("One", "Same Release")
    second = library.album("Two", "Other Release" if change == "forms" else "Same Réléase")
    library.seed(first, second)
    library.sql("select library.mark_problematic_album_dirty(library_id, id) from library.local_albums")
    write, written, release, failures = problematic_index._write, threading.Event(), threading.Event(), []

    def holding(*arguments, **options):
        write(*arguments, **options)
        if not written.is_set():
            written.set()
            assert release.wait(60)

    def save():
        try:
            library.save(second, album="Same Réléase" if change == "forms" else "Other Release")
        except Exception as error:
            failures.append(error)

    monkeypatch.setattr(problematic_index, "_write", holding)
    evaluation = threading.Thread(target=problematic_index._maintain, args=(library.repository,))
    saving = threading.Thread(target=save)
    evaluation.start()
    try:
        assert written.wait(30), "The evaluation never wrote."
        saving.start()
        # Long enough to reach the rows the uncommitted evaluation holds.
        saving.join(3)
    finally:
        release.set()
        evaluation.join(60)
    saving.join(30)

    assert not saving.is_alive() and failures == [], "The save deadlocked or failed behind the evaluation."
    assert library.marked(first, second) == [change == "forms"] * 2, "The later save's result stands."


def test_live_a_five_file_edit_inside_a_pair_costs_its_albums_tracks_not_the_library(library, monkeypatch):
    """Owner's budget case (2026-11-22): five files edited inside two copies of one album. The
    write's reads grow linearly with the copies' tracks, and not at all with the library."""
    import psycopg

    from music_app.services import saved_duplicate_results

    write, counts = saved_duplicate_results.write_saved_duplicate_results, {}

    def counted(connection, config):
        connection.execute("set local enable_seqscan = off")
        write(_CountingReads(connection, counts), config)

    monkeypatch.setattr(saved_duplicate_results, "write_saved_duplicate_results", counted)

    def edit_five(tracks, unrelated):
        copies, others = [], []
        for folder in ("One", "Two"):
            for number in range(1, tracks + 1):
                entry = library.album(folder, "Same Release", track=number)
                entry.update(track_number=number, title=f"Song {number}")
                copies.append(entry)
        for number in range(unrelated):
            entry = library.album(f"Unrelated {number}", f"Unrelated {number}")
            entry["album_artist"] = entry["artist"] = f"Artist {number}"
            others.append(entry)
        library.seed(*copies, *others)
        with psycopg.connect(library.setup_url, autocommit=True) as connection:
            connection.execute("analyze")
        assert library.marked(copies[0]) == [True], "The copies start as one pair."
        measured = []
        # Copies with different track lists are no pair: the split breaks it.
        for album, paired in (("Moved Away", False), ("Same Release", True)):
            counts.clear()
            counts.update(statements=0, plan_rows=0)
            library.save_files(copies[-5:], album=album)
            assert library.marked(copies[0]) == [paired]
            measured.append(dict(counts))
        return measured

    small, middle, large = (edit_five(tracks, 50) for tracks in (20, 80, 247))
    in_a_large_library = edit_five(247, 1000)

    print("PAIR-CONTRACT", small, middle, large, in_a_large_library)
    for low, mid, high, wide in zip(small, middle, large, in_a_large_library):
        assert low["statements"] == mid["statements"] == high["statements"] == wide["statements"] <= 12
        _assert_no_read_grew(high, wide)
        per_track = (mid["plan_rows"] - low["plan_rows"]) / (2 * (80 - 20))
        further = (high["plan_rows"] - mid["plan_rows"]) / (2 * (247 - 80))
        assert further <= per_track * 1.1, "The reads grow linearly with the affected albums' tracks."
        assert max(per_track, further) <= ROWS_PER_AFFECTED_TRACK, (per_track, further)
