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
                # Stored path projections block a collation change, so rebuild
                # them unchanged around it inside this rolled-back transaction.
                projections = connection.execute("""
                    select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
                           pg_get_expr(d.adbin, d.adrelid) as expression
                    from pg_attribute a
                    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                    where a.attrelid = 'library.local_track_files'::regclass and a.attgenerated = 's'
                    order by a.attnum
                """).fetchall()
                for column in projections:
                    connection.execute(f'ALTER TABLE library.local_track_files DROP COLUMN "{column["name"]}"')
                connection.execute('ALTER TABLE library.local_track_files ALTER COLUMN private_path TYPE text COLLATE "C"')
                for column in projections:
                    connection.execute(
                        f'ALTER TABLE library.local_track_files ADD COLUMN "{column["name"]}" {column["type"]} '
                        f'GENERATED ALWAYS AS ({column["expression"]}) STORED'
                    )
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
    # Production reads migration 0112's stored path columns; databases without
    # them use the inline expressions. Both forms must return the same rows.
    inline, stored = (
        connection.execute(browse._problematic_files_sql(**modes, path_columns=path_columns), params).fetchall()
        for path_columns in (False, True)
    )
    rendered = lambda rows: sorted(json.dumps(row, sort_keys=True, default=str) for row in rows)
    assert rendered(inline) == rendered(stored), modes
    return stored


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


def test_loose_tracks_beside_one_album_do_not_make_its_folder_mixed(physical_catalog):
    """Loose tracks have no album, so they are not a second album in the folder."""
    connection, album, owned = physical_catalog
    album_id = album("Folder Album", "Album With Loose Tracks")
    album_track = connection.execute(
        "select library_id, artist_id, track_key from library.local_tracks where album_id = %s", (album_id,),
    ).fetchone()
    file = connection.execute("""
        select files.library_root_id, files.private_path from library.local_track_files files
        join library.local_tracks tracks on tracks.id = files.track_id where tracks.album_id = %s
    """, (album_id,)).fetchone()
    loose_path = file["private_path"].rsplit("/", 1)[0] + "/Loose Track.flac"
    loose_track = connection.execute("""
        insert into library.local_tracks (library_id, album_id, artist_id, track_key, title)
        values (%s, null, %s, %s, 'Loose Track') returning id
    """, (album_track["library_id"], album_track["artist_id"], album_track["track_key"] + "-loose")).fetchone()["id"]
    connection.execute("""
        insert into library.local_track_files (track_id, library_root_id, private_path, file_size_bytes, metadata)
        values (%s, %s, %s, 1024, %s::jsonb)
    """, (loose_track, file["library_root_id"], loose_path, json.dumps({"scan_cache": {"stale": False, "file_entry": {
        "path": loose_path, "album": "Unreleased", "title": "Loose Track", "size": 1024,
    }}})))
    _, key = owned["Folder Album"]

    assert album_id not in {row["album_id"] for row in _query(
        connection, candidate_summary=True, candidate_ids_only=True)}
    for modes in ({}, {"candidate_summary": True, "selected_album_ids": True},
                  {"targeted_problem_owners": True}, {"duplicate_candidates": True}):
        rows = _query(connection, **modes, params={"album_key": key, "album_keys": [key], "album_ids": [album_id]})
        selected_rows = [row for row in rows if row["album_id"] == album_id]
        assert selected_rows, modes
        assert all(row["file_mixed_album_folder"] is False for row in selected_rows), modes


@pytest.mark.parametrize("physical_catalog", ["explain"], indirect=True)
def test_physical_parent_migration_rejects_wrong_existing_index(physical_catalog):
    connection, _, _ = physical_catalog
    migration = (Path(__file__).resolve().parents[2] / "migrations/postgres/0088_add_active_physical_parent_index.sql").read_text()
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


@pytest.mark.parametrize("override_key", ["track", "path"])
@pytest.mark.parametrize("exception_type", ["non-album rarity", ""])
def test_exception_disc_container_preserves_source_boundaries(physical_catalog, override_key, exception_type):
    connection, album, owned = physical_catalog
    source = album("Source Disc", "release/CD1")
    exception = album("Exception Disc", "release/CD2")
    album("Different Parent", "unrelated/CD1")
    album("Named Bonus Folder", "release/Bonus")
    album("Different Root", "release/CD1", root_name="other")
    album("Different Library", "release/CD1", root_name="foreign")
    wrong_album = album("Different Album", "release/CD1")
    wrong_artist = album("Different Artist", "release/CD1")
    wrong_year = album("Different Year", "release/CD1")
    ids = [item[0] for item in owned.values()]
    connection.execute("""
        update library.local_track_files files set metadata = jsonb_set(
          files.metadata, '{scan_cache,file_entry}',
          (files.metadata #> '{scan_cache,file_entry}') ||
          jsonb_build_object('album', 'Same Release', 'album_artist', 'Same Artist', 'year', '2001'))
        from library.local_tracks tracks
        where files.track_id = tracks.id and tracks.album_id = any(%s)
    """, (ids,))
    for album_id, field, value in ((wrong_album, "album", "Other"),
                                   (wrong_artist, "album_artist", "Other"),
                                   (wrong_year, "year", "2002")):
        connection.execute("""
            update library.local_track_files files set metadata = jsonb_set(
              files.metadata, array['scan_cache','file_entry',%s], to_jsonb(%s::text))
            from library.local_tracks tracks
            where files.track_id = tracks.id and tracks.album_id = %s
        """, (field, value, album_id))
    item = connection.execute("""
        select tracks.id, tracks.library_id, files.private_path
        from library.local_tracks tracks join library.local_track_files files on files.track_id = tracks.id
        where tracks.album_id = %s
    """, (exception,)).fetchone()
    connection.execute("""
        insert into library.exception_overrides(library_id, track_id, track_key, override_payload)
        values (%s, %s, %s, %s::jsonb)
    """, (item["library_id"], item["id"] if override_key == "track" else None,
          item["private_path"] if override_key == "path" else "owned-override-" + str(item["id"]),
          json.dumps({"exception_type": exception_type})))
    sql = browse._problematic_files_sql(candidate_summary=True, candidate_ids_only=True)
    # Query the actual shared CTE, retaining its complete upstream source scope.
    prefix, body = sql.split("exception_source_tracks as materialized (", 1)
    exception_cte = body.split("\n        ),", 1)[0]
    sources = connection.execute(prefix + "exception_source_tracks as materialized (" +
                                 exception_cte + ") select source_album_id, id from exception_source_tracks").fetchall()
    assert {(row["source_album_id"], row["id"]) for row in sources} == (
        {(source, item["id"]), (exception, item["id"])} if exception_type else set())
