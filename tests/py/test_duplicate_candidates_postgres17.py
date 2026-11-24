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

    monkeypatch.setattr(browse, "_duplicate_inventory_fingerprint",
                        lambda _connection: pytest.fail("PostgreSQL 17 must not load the whole-library index"))
    repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "duplicate-pg17-keyed"})
    assert browse._load_duplicate_candidate_album_ids(Connection(), ["one"], repository=repository) == [1, 2]
    assert len(statements) == 2 and "album_key = any(%(album_keys)s::text[])" in statements[1]


def test_postgres17_arm_is_gated_by_version_and_bounded_by_the_requested_year():
    import music_app.services.library_browse_postgres as browse

    sql = " ".join(browse._duplicate_candidate_album_ids_for_keys_sql().split())
    arm = sql[sql.index("true as pg17_superset"):sql.index("), candidate_containers as")]
    assert "CI-only path for PostgreSQL 17; delete this arm when CI runs PostgreSQL 18 (P9-CI-024)" in " ".join(
        line.strip(" -") for line in browse._duplicate_candidate_album_ids_for_keys_sql().splitlines()
    )
    assert f"where {ARM_GATE}" in arm
    assert ("on library.duplicate_identity_year(files.scan_file_year) = requested_identities.album_year"
            in arm), "the arm reads only the requested year's files"
    for text in ("requested_identities.album_artist_identity", "requested_identities.album_identity",
                 "files.scan_file_album_artist", "files.scan_file_album"):
        assert f"octet_length({text}) <> length({text})" in arm, text
    assert sql.count(ARM_GATE) == 1


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
