"""Real SQL contracts; use only a pre-provisioned, validated isolated database."""

import json
import os
from pathlib import Path
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres
from music_app.services import library_browse_postgres as browse
from music_app.services.utils import MOJIBAKE_CANDIDATE_PATTERN, MOJIBAKE_ENCODING_CANDIDATE_CHARS


@pytest.fixture
def physical_catalog(request):
    psycopg = pytest.importorskip("psycopg")
    if not os.environ.get("ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL"):
        pytest.skip("A pre-provisioned isolated Postgres database is required.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    # The Python job provisions a pristine database without loading a fixture.
    # Prepare the application schemas here so this contract owns its bootstrap
    # data instead of assuming an unrelated E2E fixture was loaded first.
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    # EXPLAIN's owned dense fixture needs ANALYZE inside the same uncommitted
    # transaction. Ordinary SQL contracts continue to exercise runtime grants.
    fixture_mode = getattr(request, "param", None)
    database_url = setup_url if fixture_mode in {"explain", "c-collation"} else runtime_url
    token = uuid4().hex
    with psycopg.connect(database_url, row_factory=psycopg.rows.dict_row) as connection:
        try:
            if fixture_mode == "c-collation":
                connection.execute('ALTER TABLE library.local_track_files ALTER COLUMN private_path TYPE text COLLATE "C"')
            owner = connection.execute("""
                select l.id, l.owner_account_id from library.libraries l
                join app.bootstrap_owners b on b.account_id = l.owner_account_id
                where b.owner_key = 'local-bootstrap-owner'
                  and l.name = 'Local Library' and l.library_kind = 'local'
            """).fetchone()
            assert owner is not None, "Provision the isolated fixture before running this contract."
            library_id = owner["id"]
            other_library = connection.execute("""
                insert into library.libraries(owner_account_id, name, library_kind)
                values (%s, %s, 'local') returning id
            """, (owner["owner_account_id"], f"Physical contract {token}")).fetchone()["id"]
            base = f"/physical-contract-{token}" if fixture_mode == "posix" else f"C:/physical-contract-{token}"

            def root(library, suffix, active=True):
                return connection.execute("""
                    insert into library.library_roots(library_id, root_path, root_kind, is_active)
                    values (%s, %s, 'main', %s) returning id
                """, (library, base + suffix, active)).fetchone()["id"]

            roots = {"main": root(library_id, ""), "other": root(library_id, "/root-scope"),
                     "foreign": root(other_library, ""), "inactive": root(library_id, "/inactive-scope", False)}
            owned = {}

            def album(label, directory, *, root_name="main", stale=False, size=1024,
                      cached_size="same", compilation=False):
                library = other_library if root_name == "foreign" else library_id
                artist = connection.execute("""
                    insert into library.local_artists(library_id, artist_key, name)
                    values (%s, %s, 'Contract Artist') returning id
                """, (library, f"{token}-{label}")).fetchone()["id"]
                key = f"{token}-{label}"
                metadata = {"album_artist": "Contract Artist", "artists": ["Contract Artist"],
                            "local_cover_width": 1000, "local_cover_height": 1000,
                            "is_compilation": compilation}
                album_id = connection.execute("""
                    insert into library.local_albums
                      (library_id, artist_id, album_key, title, release_year, cover_path, metadata)
                    values (%s, %s, %s, %s, 2001, %s, %s::jsonb) returning id
                """, (library, artist, key, label, base + "/cover.jpg", json.dumps(metadata))).fetchone()["id"]
                track = connection.execute("""
                    insert into library.local_tracks
                      (library_id, album_id, artist_id, track_key, title, disc_number, track_number)
                    values (%s, %s, %s, %s, 'Track', 1, 1) returning id
                """, (library, album_id, artist, key)).fetchone()["id"]
                path = f"{base}/{directory}/{label}.flac"
                entry = {"path": path, "album": label, "album_artist": "Contract Artist",
                         "artist": "Guest Artist" if compilation else "Contract Artist",
                         "title": "Track", "year": "2001", "track_number": 1,
                         "disc_number": 1, "size": size if cached_size == "same" else cached_size}
                connection.execute("""
                    insert into library.local_track_files
                      (track_id, library_root_id, private_path, file_size_bytes, metadata)
                    values (%s, %s, %s, %s, %s::jsonb)
                """, (track, roots[root_name], path, size,
                      json.dumps({"scan_cache": {"stale": stale, "file_entry": entry}})))
                if compilation:
                    second_track = connection.execute("""
                        insert into library.local_tracks
                          (library_id, album_id, artist_id, track_key, title, disc_number, track_number)
                        values (%s, %s, %s, %s, 'Second Track', 1, 2) returning id
                    """, (library, album_id, artist, key + "-second")).fetchone()["id"]
                    second_path = f"{base}/{directory}/{label}-second.flac"
                    second_entry = {**entry, "path": second_path, "artist": "Another Guest Artist",
                                    "title": "Second Track", "track_number": 2}
                    connection.execute("""
                        insert into library.local_track_files
                          (track_id, library_root_id, private_path, file_size_bytes, metadata)
                        values (%s, %s, %s, %s, %s::jsonb)
                    """, (second_track, roots[root_name], second_path, size,
                          json.dumps({"scan_cache": {"stale": stale, "file_entry": second_entry}})))
                owned[label] = (album_id, key)
                return album_id

            yield connection, album, owned
        finally:
            connection.rollback()


def _query(connection, **modes):
    params = {"album_key": None, "album_ids": [], "album_keys": [], "file_paths": [],
              "mojibake_candidate_pattern": MOJIBAKE_CANDIDATE_PATTERN,
              "encoding_candidate_chars": MOJIBAKE_ENCODING_CANDIDATE_CHARS}
    params.update(modes.pop("params", {}))
    return connection.execute(browse._problematic_files_sql(**modes), params).fetchall()


def test_physical_categories_real_sql_candidates_selection_and_detail(physical_catalog):
    connection, album, owned = physical_catalog
    first = album("Mixed One", "mixed")
    second = album("Mixed Two", "mixed")
    empty = album("Empty Audio", "empty", size=0)
    canonical_empty = album("Canonical Empty", "canonical-empty", size=0, cached_size=1024)
    album("Stale Cached Zero", "stale-zero", size=1024, cached_size=0)
    album("Synthetic Cached Zero", "synthetic-zero", size=None, cached_size=0)
    album("Unknown Size", "unknown", size=None)
    album("Compilation", "compilation", compilation=True)
    album("Disc One", "release/CD1")
    album("Disc Two", "release/CD2")
    album("Stale Control", "stale")
    album("Stale Sibling", "stale", stale=True)
    album("Root Control", "root-scope")
    album("Root Sibling", "root-scope", root_name="other")
    album("Library Control", "library-scope")
    album("Library Sibling", "library-scope", root_name="foreign")
    album("Foreign Mixed One", "foreign-mixed", root_name="foreign")
    album("Foreign Mixed Two", "foreign-mixed", root_name="foreign")
    album("Foreign Empty", "foreign-empty", root_name="foreign", size=0)
    album("Inactive Control", "inactive-scope")
    album("Inactive Sibling", "inactive-scope", root_name="inactive")
    album("Inactive Mixed One", "inactive-scope/mixed", root_name="inactive")
    album("Inactive Mixed Two", "inactive-scope/mixed", root_name="inactive")
    album("Inactive Empty", "inactive-scope/empty", root_name="inactive", size=0)

    candidate_ids = {row["album_id"] for row in _query(
        connection, candidate_summary=True, candidate_ids_only=True)}
    owned_ids = {value[0] for value in owned.values()}
    assert candidate_ids & owned_ids == {first, second, empty, canonical_empty}

    # Simulate page-sized selected-ID reads after candidate selection: every
    # affected record must retain context even when its companion is off-page.
    summaries = []
    for album_id, reason in [(first, "Mixed album metadata in one folder"),
                             (second, "Mixed album metadata in one folder"),
                             (empty, "Empty audio file"),
                             (canonical_empty, "Empty audio file")]:
        rows = _query(connection, candidate_summary=True, selected_album_ids=True,
                      params={"album_ids": [album_id]})
        selected = [item for item in browse._problematic_album_projection_payloads(rows)
                    if item["_persisted_album_key"] == next(
                        key for identifier, key in owned.values() if identifier == album_id)]
        assert len(selected) == 1
        summary = browse._problematic_album_summary_payload(selected[0])
        assert reason in summary["problem_reasons"]
        summaries.append(summary)
        key = next(key for identifier, key in owned.values() if identifier == album_id)
        detail_rows = _query(connection, params={"album_key": key})
        details = [browse._problematic_album_detail_payload(item)
                   for item in browse._problematic_album_projection_payloads(detail_rows)]
        assert len(details) == 1
        assert reason in details[0]["problem_reasons"]
    assert sum("Mixed album metadata in one folder" in item["problem_reasons"]
               for item in summaries) == 2
    assert sum("Empty audio file" in item["problem_reasons"] for item in summaries) == 2


@pytest.mark.parametrize("physical_catalog", ["explain"], indirect=True)
def test_targeted_physical_context_explain_avoids_unrelated_inventory(physical_catalog, record_property):
    connection, album, owned = physical_catalog
    selected_id = album("Selected", "selected")
    album("Offpage Companion", "selected")
    unrelated_id = album("Unrelated", "unrelated")
    seed = connection.execute("""
        select tracks.library_id, tracks.artist_id, files.library_root_id, files.private_path
        from library.local_tracks tracks
        join library.local_track_files files on files.track_id = tracks.id
        where tracks.album_id = %s
    """, (unrelated_id,)).fetchone()
    base = seed["private_path"].rsplit("/", 1)[0]
    connection.execute("""
        with added_tracks as (
          insert into library.local_tracks
            (library_id, album_id, artist_id, track_key, title, disc_number, track_number)
          select %(library_id)s, %(album_id)s, %(artist_id)s,
            %(base)s || '/dense-' || n, 'Track ' || n, 1, n
          from generate_series(2, 3001) n
          returning id, title, track_number
        )
        insert into library.local_track_files
          (track_id, library_root_id, private_path, file_size_bytes, metadata)
        select id, %(root_id)s, %(base)s || '/dense-' || track_number || '.flac', 1024,
          jsonb_build_object('scan_cache', jsonb_build_object('stale', false,
            'file_entry', jsonb_build_object('album', 'Unrelated', 'album_artist', 'Contract Artist',
              'artist', 'Contract Artist', 'title', title, 'year', '2001', 'track_number', track_number)))
        from added_tracks
    """, {"library_id": seed["library_id"], "album_id": unrelated_id,
          "artist_id": seed["artist_id"], "root_id": seed["library_root_id"], "base": base})
    connection.execute("ANALYZE library.local_tracks, library.local_track_files, library.local_albums, library.library_roots")

    def nodes(plan):
        yield plan
        for child in plan.get("Plans", []):
            yield from nodes(child)

    metrics = []
    for modes in ({}, {"candidate_summary": True, "selected_album_ids": True},
                  {"targeted_problem_owners": True}, {"duplicate_candidates": True}):
        key = owned["Selected"][1]
        params = {"album_key": key, "album_keys": [key], "album_ids": [selected_id], "file_paths": [],
                  "mojibake_candidate_pattern": MOJIBAKE_CANDIDATE_PATTERN,
                  "encoding_candidate_chars": MOJIBAKE_ENCODING_CANDIDATE_CHARS}
        explained = connection.execute(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + browse._problematic_files_sql(**modes), params,
        ).fetchone()["QUERY PLAN"][0]
        plan_nodes = list(nodes(explained["Plan"]))
        context = [node for node in plan_nodes if node.get("Subplan Name") == "CTE active_problem_rows"]
        assert len(context) == 1
        assert context[0]["Actual Rows"] == 2
        ranges = [node for node in plan_nodes
                  if node.get("Index Name") == "local_track_files_active_physical_parent_idx"
                  and "physical_parent" in node.get("Index Cond", "")]
        assert ranges, "Targeted folder reads must use the normalized-parent equality index."
        metrics.append({"modes": modes, "context_rows": context[0]["Actual Rows"],
                        "range_index_nodes": len(ranges), "unrelated_files": 3001})
    record_property("targeted_physical_explain", json.dumps(metrics))
    print("TARGETED_PHYSICAL_EXPLAIN=" + json.dumps(metrics))


@pytest.mark.parametrize("physical_catalog", ["c-collation"], indirect=True)
def test_windows_case_variants_keep_global_and_targeted_folder_context_equal(physical_catalog):
    connection, album, owned = physical_catalog
    selected_id = album("Case Selected", "Same Folder")
    companion_id = album("Case Companion", "Same Folder")
    connection.execute("""
        update library.local_track_files files
        set private_path = upper(files.private_path)
        from library.local_tracks tracks
        where tracks.id = files.track_id and tracks.album_id = %s
    """, (companion_id,))
    candidates = {row["album_id"] for row in _query(
        connection, candidate_summary=True, candidate_ids_only=True)}
    assert {selected_id, companion_id} <= candidates
    for album_id, key in owned.values():
        for modes in ({}, {"candidate_summary": True, "selected_album_ids": True},
                      {"targeted_problem_owners": True}, {"duplicate_candidates": True}):
            rows = _query(connection, **modes, params={
                "album_key": key, "album_keys": [key], "album_ids": [album_id],
            })
            selected_rows = [row for row in rows if row["album_id"] == album_id]
            assert selected_rows
            assert all(row["file_mixed_album_folder"] is True for row in selected_rows), modes


@pytest.mark.parametrize("physical_catalog", ["explain"], indirect=True)
def test_physical_parent_migration_rejects_wrong_existing_index(physical_catalog):
    connection, _, _ = physical_catalog
    migration = (Path(__file__).resolve().parents[2] / "migrations/postgres/0083_add_active_physical_parent_index.sql").read_text()
    connection.execute(migration)
    connection.execute("DROP INDEX library.local_track_files_active_physical_parent_idx")
    connection.execute("CREATE INDEX local_track_files_active_physical_parent_idx ON library.local_track_files (private_path)")
    import psycopg
    with pytest.raises(psycopg.errors.RaiseException, match="physical-parent index definition"):
        connection.execute(migration)


@pytest.mark.parametrize("physical_catalog", ["posix"], indirect=True)
@pytest.mark.parametrize("directories", [(r"A\B", "A/B"), ("Case", "case")])
def test_posix_distinct_physical_parents_do_not_create_mixed_warnings(physical_catalog, directories):
    connection, album, owned = physical_catalog
    first = album("Distinct One", directories[0])
    second = album("Distinct Two", directories[1])
    candidates = {row["album_id"] for row in _query(
        connection, candidate_summary=True, candidate_ids_only=True)}
    assert not {first, second} & candidates
    for album_id, key in owned.values():
        for modes in ({}, {"candidate_summary": True, "selected_album_ids": True},
                      {"targeted_problem_owners": True}, {"duplicate_candidates": True}):
            rows = _query(connection, **modes, params={
                "album_key": key, "album_keys": [key], "album_ids": [album_id],
            })
            selected_rows = [row for row in rows if row["album_id"] == album_id]
            assert selected_rows
            assert all(row["file_mixed_album_folder"] is False for row in selected_rows), modes
