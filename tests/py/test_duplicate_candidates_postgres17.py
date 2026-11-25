"""Duplicate candidates below PostgreSQL 18: the keyed read's PostgreSQL 17 arm (P9-CI-024).

Below 18, library.duplicate_identity_text folds with lower(); Python's identity folds with casefold().
They differ only for non-ASCII text (ß/ss, ς/σ, ligatures). The keyed candidate read stays a superset of
Python's rule there through an arm bounded by the requested year; Python then checks every candidate.

Each live case runs in two modes:
- "native": the server as it is. Hosted CI runs PostgreSQL 17, so there the arm runs for real; on 18
  the casefold identity finds the pair by itself and the arm stays off.
- "pg17-emulated" (PostgreSQL 18 only; on 17 it is "native"): the identity helpers get their
  PostgreSQL 17 definition (lower(), 0117b's else branch) and the arm's version check is forced on.
  Without the arm the pair is lost there, which proves the arm is what finds it.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)

FOLD_MIGRATION = Path(__file__).resolve().parents[2] / "migrations" / "postgres" / "0117b_define_fold_search_accents.sql"
ARM_GATE = "current_setting('server_version_num')::integer < 180000"
YEAR = 2026
PAIRS = {
    "sharp-s": ("Straße", "STRASSE"),
    "final-sigma": ("λογοσ", "λογος"),
    "ligature": ("ﬁnale", "finale"),
}


def test_keyed_duplicate_candidates_run_on_every_server_version(monkeypatch):
    """No version gate: PostgreSQL 17 takes the keyed read too, never the whole-library identity index."""
    import music_app.services.library_browse_postgres as browse

    statements = []

    class Connection:
        info = type("Info", (), {"server_version": 170000})()

        def execute(self, sql, params=None):
            statements.append(" ".join(sql.split()))
            rows = ([{"available": True}] if "to_regprocedure" in sql
                    else [{"album_id": 1, "pg17_superset": False}, {"album_id": 2, "pg17_superset": True}])
            return type("Cursor", (), {"fetchone": lambda _self: rows[0], "fetchall": lambda _self: rows})()

    monkeypatch.setattr(browse, "_DUPLICATE_IDENTITY_HELPERS_READY", set())
    monkeypatch.setattr(browse, "_duplicate_inventory_fingerprint",
                        lambda _connection: pytest.fail("PostgreSQL 17 must not load the whole-library index"))
    repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "duplicate-pg17-keyed"})
    assert browse._load_duplicate_candidate_album_ids(Connection(), ["one"], repository=repository) == [1, 2]
    assert len(statements) == 2 and "album_key = any(%(album_keys)s::text[])" in statements[1]


class _ProbeCountingConnection:
    def __init__(self, helpers: bool):
        self.helpers, self.probes, self.statements = helpers, 0, []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        if "to_regprocedure" in sql:
            self.probes += 1
            rows = [{"available": self.helpers}]
        else:
            rows = [{"album_id": 1, "pg17_superset": False}]
        return type("Cursor", (), {"fetchone": lambda _self: rows[0], "fetchall": lambda _self: rows})()


def test_duplicate_identity_helpers_are_checked_once_per_process_and_database(monkeypatch):
    import music_app.services.library_browse_postgres as browse

    monkeypatch.setattr(browse, "_DUPLICATE_IDENTITY_HELPERS_READY", set())
    first = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "helpers-once-a"})
    other = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "helpers-once-b"})
    connection = _ProbeCountingConnection(helpers=True)
    for _batch in range(3):
        assert browse._load_duplicate_candidate_album_ids(connection, ["one"], repository=first) == [1]
    assert connection.probes == 1, "no per-batch to_regprocedure"
    browse._load_duplicate_candidate_album_ids(connection, ["one"], repository=other)
    assert connection.probes == 2, "each database is checked once"


def test_missing_duplicate_identity_helpers_fail_loudly_by_migration(monkeypatch):
    import music_app.services.library_browse_postgres as browse

    monkeypatch.setattr(browse, "_DUPLICATE_IDENTITY_HELPERS_READY", set())
    monkeypatch.setattr(browse, "_duplicate_inventory_fingerprint",
                        lambda _connection: pytest.fail("no fallback to the whole-library identity index"))
    repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "helpers-missing"})
    connection = _ProbeCountingConnection(helpers=False)
    for _attempt in range(2):  # never remembered as ready
        with pytest.raises(RuntimeError, match="0093_add_duplicate_identity_lookup_index.sql and "
                                               "0118_fold_accents_in_duplicate_identity.sql"):
            browse._load_duplicate_candidate_album_ids(connection, ["one"], repository=repository)
    assert all("to_regprocedure" in sql for sql in connection.statements)


def test_postgres17_arm_is_gated_by_version_and_bounded_by_the_requested_year():
    import music_app.services.library_browse_postgres as browse

    sql = " ".join(browse._duplicate_candidate_album_ids_for_keys_sql().split())
    assert "CI-only path for PostgreSQL 17; delete this arm when CI runs PostgreSQL 18 (P9-CI-024)" in " ".join(
        line.strip(" -") for line in browse._duplicate_candidate_album_ids_for_keys_sql().splitlines()
    )
    arms = sql[sql.index("true as pg17_superset"):sql.index("), candidate_containers as")]
    files = sql[sql.index("pg17_casefold_files as materialized"):sql.index("), identity_files as")]
    sensitive = browse._CASEFOLD_SENSITIVE_CLASS
    # A casefold-sensitive requested identity reads its year's files; nothing is scanned otherwise.
    assert ("where requested_identities.pg17_casefold_sensitive and "
            "library.duplicate_identity_year(files.scan_file_year) = requested_identities.album_year") in arms
    # Otherwise only the casefold-sensitive files of the requested year: one regex read per statement, gated
    # by the server version.
    assert "join pg17_casefold_files files on files.album_year = requested_identities.album_year" in arms
    assert f"where {ARM_GATE}" in files
    for text in ("files.scan_file_album", "files.scan_file_album_artist"):
        assert f"{text} ~ '{sensitive}'" in files, text
        assert f"{text} ~ '{sensitive}'" in sql[:sql.index("as pg17_casefold_sensitive")], text
    assert sql.count(ARM_GATE) == 2  # the casefold-sensitive files, and the requested identities' flag


def test_casefold_sensitive_class_is_every_character_casefold_and_lower_treat_differently():
    """The class matches exactly the characters whose casefold() differs from lower(), plus capital sigma
    (lower() turns it into final sigma at a word's end): text without one folds alike under both."""
    import re
    import sys

    import music_app.services.library_browse_postgres as browse

    pattern = re.compile(browse._CASEFOLD_SENSITIVE_CLASS)
    characters = [chr(code) for code in range(sys.maxunicode + 1) if not 0xD800 <= code <= 0xDFFF]
    expected = {character for character in characters if character.casefold() != character.lower()} | {"Σ"}
    assert {character for character in characters if pattern.fullmatch(character)} == expected


def _server_version(fixture) -> int:
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return int(connection.execute("show server_version_num").fetchone()["server_version_num"])


def _fold_with_lower(fixture) -> None:
    """Gives the identity helpers their PostgreSQL 17 definition: 0117b with lower() on every server."""
    migration = FOLD_MIGRATION.read_text(encoding="utf-8")
    branch = "then 'casefold' else 'lower' end"
    assert branch in migration
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(migration.replace(branch, "then 'lower' else 'lower' end"))


def _restore_fold(fixture) -> None:
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(FOLD_MIGRATION.read_text(encoding="utf-8"))


@pytest.fixture(params=["native", "pg17-emulated"])
def library(request, watcher_repair_inventory, monkeypatch):  # noqa: F811
    import music_app.services.library_browse_postgres as browse

    fixture = watcher_repair_inventory
    version = _server_version(fixture)
    emulated = request.param == "pg17-emulated"
    if emulated and version < 180000:
        pytest.skip("PostgreSQL 17 runs the arm natively (the 'native' case)")
    generate = browse._duplicate_candidate_album_ids_for_keys_sql
    fixture.emulated = emulated

    def keyed_sql(*, arm=True):
        sql = generate()
        return sql.replace(ARM_GATE, "true") if emulated and arm else sql

    fixture.keyed_sql = keyed_sql
    monkeypatch.setattr(browse, "_duplicate_candidate_album_ids_for_keys_sql", keyed_sql)
    if emulated:
        _fold_with_lower(fixture)
    try:
        yield fixture
    finally:
        if emulated:
            _restore_fold(fixture)


def _seed(library, *albums):
    """Seeds (folder, album, year) albums by one artist; returns each folder's album key. Each folder is its
    own edition: the inventory withholds two album keys of one semantic identity (artist, title, year,
    edition), while the duplicate identity reads the file tags without the edition."""
    entries = [{**library.entry(f"Owner/{folder}/01.flac", album=album), "year": year, "edition": folder}
               for folder, album, year in albums]
    library.seed(*entries)
    with isolatedPostgres._connect(library.runtime_url) as connection:
        rows = connection.execute("""
            select distinct albums.album_key, files.private_path
            from library.local_albums albums
            join library.local_tracks tracks on tracks.album_id = albums.id and tracks.library_id = albums.library_id
            join library.local_track_files files on files.track_id = tracks.id
        """).fetchall()
    return {Path(row["private_path"]).parent.name: str(row["album_key"]) for row in rows}


def _candidate_rows(library, key, *, arm=True):
    """The keyed read's rows: album id -> whether only the PostgreSQL 17 arm placed it."""
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    with PostgresLibraryBrowseRepository(library.config)._connect_to_database() as connection:
        rows = connection.execute(library.keyed_sql(arm=arm), {"album_keys": [key]}).fetchall()
    return {int(row["album_id"]): bool(row["pg17_superset"]) for row in rows}


def _album_ids(library, keys):
    with isolatedPostgres._connect(library.runtime_url) as connection:
        rows = connection.execute(
            "select album_key, id from library.local_albums where album_key = any(%s)", (list(keys),)
        ).fetchall()
    return {str(row["album_key"]): int(row["id"]) for row in rows}


def _duplicate_results(library, keys):
    """Python's exact verdict over the keyed candidates (the stored-result path)."""
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(library.config)
    with repository._connect_to_database() as connection:
        return repository.compute_duplicate_results_for_album_keys(connection, keys)


@pytest.mark.parametrize("pair", list(PAIRS), ids=list(PAIRS))
def test_non_ascii_spellings_of_one_release_are_duplicate_candidates(library, pair):
    first, second = PAIRS[pair]
    keys = _seed(library, ("One", first, YEAR), ("Two", second, YEAR), ("Other", "Other", YEAR))
    ids = _album_ids(library, keys.values())

    for requested, twin in (("One", "Two"), ("Two", "One")):
        candidates = _candidate_rows(library, keys[requested])
        assert {ids[keys[requested]], ids[keys[twin]]} <= set(candidates), (pair, requested, candidates)
        if library.emulated:
            # The emulated PostgreSQL 17 identity alone misses the twin: the arm is what finds it.
            assert ids[keys[twin]] not in _candidate_rows(library, keys[requested], arm=False)
            assert candidates[ids[keys[twin]]] is True

    results = _duplicate_results(library, [keys["One"], keys["Two"], keys["Other"]])
    assert results[keys["One"]]["has_duplicate_files"] is True
    assert results[keys["Two"]]["has_duplicate_files"] is True
    assert keys["Other"] not in results, "a superset candidate never passes Python's exact check"


def test_ascii_only_identities_add_no_superset_candidates(library):
    keys = _seed(
        library,
        ("One", "Plain", YEAR), ("Two", "PLAIN", YEAR), ("Other", "Other", YEAR),
        # Non-ASCII text in another year stays outside the requested year's bound.
        ("Elsewhere", "Straße", YEAR - 1),
    )
    ids = _album_ids(library, keys.values())

    candidates = _candidate_rows(library, keys["One"])
    assert candidates == {ids[keys["One"]]: False, ids[keys["Two"]]: False}
    results = _duplicate_results(library, [keys["One"], keys["Other"], keys["Elsewhere"]])
    assert results[keys["One"]]["has_duplicate_files"] is True
    assert keys["Other"] not in results and keys["Elsewhere"] not in results


def test_casefold_insensitive_non_ascii_identities_add_no_superset_candidates(library):
    """Cyrillic (or accented) text folds alike under lower() and casefold(): it never widens the PostgreSQL 17
    arm to the whole requested year (the hosted fixture's backfill read every same-year album otherwise)."""
    keys = _seed(
        library,
        ("One", "Ария", YEAR), ("Two", "АРИЯ", YEAR),
        ("Other", "Другой", YEAR),
    )
    ids = _album_ids(library, keys.values())

    candidates = _candidate_rows(library, keys["One"])
    assert candidates == {ids[keys["One"]]: False, ids[keys["Two"]]: False}


def test_no_keys_read_no_duplicate_candidates_and_run_no_statement():
    import music_app.services.library_browse_postgres as browse

    class Connection:
        def execute(self, sql, params=None):
            pytest.fail(f"no statement for no keys: {' '.join(sql.split())[:80]}")

    repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "no-keys"})
    assert browse._load_duplicate_candidate_album_ids(Connection(), [], repository=repository) == []


def test_no_whole_library_duplicate_identity_index_remains():
    """Candidates always come from the keyed, indexed read: nothing builds, caches or refreshes a
    whole-library identity index (startup, save or request)."""
    import music_app.services.library_browse_postgres as browse

    for gone in ("_duplicate_identity_index_rows_sql", "_duplicate_candidate_index_from_rows",
                 "_duplicate_candidate_ids_from_index"):
        assert not hasattr(browse, gone), gone
    assert "duplicate-identities" not in browse._UTILITY_PROJECTION_KINDS


def test_one_album_save_refresh_runs_no_whole_library_identity_sql(monkeypatch):
    import music_app.services.library_browse_postgres as browse

    statements = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def execute(self, sql, params=None):
            statements.append(" ".join(sql.split()))
            rows = ([{"library_id": 1, "inventory_revision": "2", "root_versions": [], "root_count": 1,
                      "override_versions": None, "override_count": 0, "observed_at": 2}]
                    if "inventory_mutation_revision" in sql else [])
            return type("Cursor", (), {"fetchone": lambda _self: rows[0] if rows else None,
                                       "fetchall": lambda _self: rows})()

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "one-album-save-refresh"}
    monkeypatch.setattr(browse, "_connect", lambda _url: Connection())
    monkeypatch.setattr(browse.problematic_index, "queue_maintenance", lambda _repository: None)
    repository = browse.PostgresLibraryBrowseRepository(config)
    repository._set_cached_utility_projection("duplicate-absence", {
        "fingerprint": (1, "1", [], 1, None, 0), "observed_at": 1, "albums": {},
    })
    # A process that still held an identity index (the old startup prewarm's) gets no refresh SQL for it.
    repository._set_cached_utility_projection("duplicate-identities", {
        "fingerprint": (1, "1", [], 1, None, 0), "observed_at": 1, "index": [(1, "a::b", ("a", "b", 2001))],
    })
    browse.refresh_postgres_utility_projections_after_edit(
        config, track_paths=["/music/a/01.flac"],
        previous_entries=[{"album_artist": "A", "album": "B", "year": 2001}],
    )
    assert statements, "the refresh ran"
    assert not [sql for sql in statements if "select distinct albums.id as album_id" in sql], statements
    browse.invalidate_postgres_utility_projection_cache()


_INVENTORY_TABLES = {"local_albums", "local_tracks", "local_track_files", "local_artists"}


def _rows_scanned(plan) -> int:
    """Rows a plan read from the inventory tables: rows produced plus rows its filters discarded."""
    own = 0
    if plan.get("Relation Name") in _INVENTORY_TABLES:
        loops = int(plan.get("Actual Loops", 1))
        own = round((plan.get("Actual Rows", 0) + plan.get("Rows Removed by Filter", 0)
                     + plan.get("Rows Removed by Index Recheck", 0)) * loops)
    return own + sum(_rows_scanned(child) for child in plan.get("Plans", ()))


def _source_rows_read(fixture, albums: int, candidates: int) -> int:
    """Rows the duplicate source-rows read scans in the inventory tables, for ``candidates`` albums of a
    library of ``albums`` (one file each)."""
    import psycopg

    import music_app.services.library_browse_postgres as browse

    fixture.seed(*(fixture.entry(f"Size{albums}/Artist {index:04d}/Album/01.flac", artist=f"Artist {index:04d}",
                                 album=f"Album {index:04d}") for index in range(albums)))
    with psycopg.connect(fixture.runtime_url) as connection:
        connection.execute("analyze")
        ids = [row[0] for row in connection.execute(
            "select id from library.local_albums order by id limit %s", (candidates,)).fetchall()]
        document = connection.execute(
            "explain (analyze, format json) " + browse._duplicate_source_rows_for_album_ids_sql(),
            {"album_ids": ids}).fetchone()[0]
    return _rows_scanned(document[0]["Plan"])


def test_duplicate_source_rows_read_only_the_candidates_rows_at_any_library_size(watcher_repair_inventory):  # noqa: F811
    """6.5 (11-24): a duplicate absence miss reads the candidate albums' source rows by key. The rows it reads
    follow the candidates, not the library (it scanned every track and artist: 169,348 rows for 550)."""
    # Sizes where the planner costs the tables as tables (a few dozen rows are cheaper to filter than to look up).
    candidates = 5
    small = _source_rows_read(watcher_repair_inventory, 400, candidates)
    large = _source_rows_read(watcher_repair_inventory, 1000, candidates)
    print(f"source-rows read: {small} rows at 400 albums, {large} at 1000")
    # Each candidate's own album, track, file and artist rows, plus a few index-recheck rows: never the library.
    assert max(small, large) <= 10 * candidates, (small, large)
