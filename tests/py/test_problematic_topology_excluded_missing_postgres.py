"""Native excluded-folder pagination, missing inventory, and physical-hint closure."""

from contextlib import closing
import json
from pathlib import Path

from music_app.services.jobs.models import JobState
from music_app.services.library_browse_postgres import (
    _missing_album_projection_payloads,
    _problematic_album_detail_payload,
    _problematic_album_summary_payload,
)
from music_app.services.problematic_projection_postgres import PostgresProblematicProjectionRepository, ProblematicProjectionStorageError
from tests.e2e.support import isolatedPostgres
from tests.py.test_problematic_files_projection import _topology_unit_main_records
from tests.py.test_problematic_projection_postgres import _main_search_claimed_v2, live_projection_database
from tests.py.test_problematic_topology_closure_postgres import _run_topology_worker
from tests.py.test_problematic_topology_folder_status_postgres import MIXED_REASON, _folder_facts, _seed_folder_case
from tests.py.test_problematic_topology_sql_boundaries_postgres import _assert_published_matches_main, _canonical_rows


def _album(connection, db, key):
    artist_name, title = key + " Artist", key + " Album"
    artist = connection.execute(
        "insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id",
        (db.library_id, key, artist_name),
    ).fetchone()["id"]
    album = connection.execute(
        "insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata) "
        "values(%s,%s,%s,%s,1988,%s::jsonb) returning id",
        (db.library_id, artist, key, title, json.dumps({"album_artist": artist_name, "edition": "Archive", "release_date": "1988-01-01"})),
    ).fetchone()["id"]
    return {"id": album, "artist": artist, "key": key, "artist_name": artist_name, "title": title}


def _file(connection, db, root, album, folder, key, number, *, excluded=False, stale=False):
    track = connection.execute(
        "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,disc_number,track_number,duration_seconds) "
        "values(%s,%s,%s,%s,%s,1,%s,180) returning id",
        (db.library_id, album["id"], album["artist"], key, f"Track {number}", number),
    ).fetchone()["id"]
    path = str(folder / f"{key}.flac")
    entry = {"path": path, "album": album["title"], "album_artist": album["artist_name"], "artist": album["artist_name"],
             "title": f"Track {number}", "year": 1988, "edition": "Archive", "release_date": "1988-01-01",
             "track_number": number, "disc_number": 1, "duration_seconds": 180}
    if excluded:
        entry["exception_type"] = "Non-album rarity"
    cache = {"file_entry": entry}
    if stale:
        cache["stale"] = True
        cache["stale_marked_at"] = "2026-11-20T00:00:00+00:00"
    file = connection.execute(
        "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
        "values(%s,%s,%s,%s::jsonb) returning id,scan_physical_parent",
        (track, root, path, json.dumps({"scan_cache": cache})),
    ).fetchone()
    if excluded:
        connection.execute(
            "insert into library.exception_overrides(library_id,track_key,override_payload) "
            "values(%s,%s,%s::jsonb)",
            (db.library_id, path, json.dumps({"exception_type": "Non-album rarity"})),
        )
    return file


def test_live_late_excluded_folder_keys_preserve_retained_mixed_reason(live_projection_database, tmp_path, monkeypatch):
    db = live_projection_database
    root_path = tmp_path / "LateFolders"
    with isolatedPostgres._connect(db.setup_url) as connection:
        root = connection.execute(
            "insert into library.library_roots(library_id,root_path,root_kind,is_active) "
            "values(%s,%s,'main',true) returning id", (db.library_id, str(root_path)),
        ).fetchone()["id"]
        pool = connection.execute(
            "with paths as (select folder,case when library.local_path_style(folder)='windows' "
            "then replace(library.local_path_key(folder),chr(92),'/') else library.local_path_key(folder) end as parent "
            "from unnest(%s::text[]) folders(folder)), ranked as (select folder,parent,"
            "encode(sha256(convert_to(jsonb_build_array(%s::bigint,parent)::text,'UTF8')),'hex') as key from paths) "
            "select * from ranked order by key collate \"C\"",
            ([str(root_path / f"Folder{index:03d}") for index in range(128)], root),
        ).fetchall()
        assert len(pool) == len({row["key"] for row in pool}) == 128
        excluded, target = pool[:101], pool[-1]
        assert max(row["key"] for row in excluded) < target["key"]
        own, foreign = _album(connection, db, "late-own"), _album(connection, db, "late-foreign")
        p_own = _file(connection, db, root, own, Path(target["folder"]), "retained-a", 1)
        p_foreign = _file(connection, db, root, foreign, Path(target["folder"]), "retained-b", 1)
        assert p_own["scan_physical_parent"] == p_foreign["scan_physical_parent"] == target["parent"]
        for index, folder in enumerate(excluded):
            row = _file(connection, db, root, own, Path(folder["folder"]), f"excluded-{index:03d}", 1, excluded=True)
            assert row["scan_physical_parent"] == folder["parent"]
    browse, canonical = _canonical_rows(db)
    assert len(canonical) == 103
    own_rows = [row for row in canonical if row["album_id"] == own["id"]]
    assert len(own_rows) == 102 and sum(bool(row["exception_type"]) for row in own_rows) == 101
    expected = _topology_unit_main_records(canonical)
    assert MIXED_REASON in next(record for record in expected.values() if record["summary"]["key"] == own["key"])["summary"]["problem_reasons"]
    worker, claim, build, _now = _main_search_claimed_v2(db)
    facts = worker.iter_claimed_group_facts
    original_all = worker._all
    witnessed = []
    pages = []
    needed_keys = [row["key"] for row in excluded] + [target["key"]]

    def before_finalization(**kwargs):
        if kwargs["group_key"] == ("album", own["id"]):
            with isolatedPostgres._connect(db.setup_url) as connection:
                keys = connection.execute(
                    "select semantic_child_identity from ops.problematic_projection_group_facts "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind='album' and group_identity=%s "
                    "and fact_kind='topology_folder_reference' order by semantic_child_identity collate \"C\"",
                    (claim.job_id, claim.attempt, build.revision, str(own["id"])),
                ).fetchall()
                assert [row["semantic_child_identity"] for row in keys] == needed_keys
                assert needed_keys.index(target["key"]) > 100
                scalars = [fact for fact in _folder_facts(db, claim, build)
                           if fact["fact_value"]["root_id"] == root and fact["fact_value"]["physical_parent"] == target["parent"]]
                assert len(scalars) == 1 and scalars[0]["fact_value"]["mixed"] is True
                assert scalars[0]["fact_value"]["input_count"] == 2
                inputs = connection.execute(
                    "select payload->>'file_id' as file_id from ops.problematic_projection_source_staging "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
                    "and source_kind='topology_input'",
                    (claim.job_id, claim.attempt, build.revision, scalars[0]["group_kind"], scalars[0]["group_identity"]),
                ).fetchall()
                assert {int(row["file_id"]) for row in inputs} == {p_own["id"], p_foreign["id"]}
            witnessed.append(True)
        with closing(facts(**kwargs)) as stream:
            yield from stream

    def bounded_pages(connection, statement, parameters):
        rows = original_all(connection, statement, parameters)
        if "load_claimed_problematic_topology_descriptors(" in statement and parameters["group_kind"] == "album" and str(parameters["group_identity"]) == str(own["id"]):
            assert 1 <= parameters["limit"] <= 100 and len(rows) <= parameters["limit"]
            pages.append((parameters["after_reference_key"], rows))
        return rows

    monkeypatch.setattr(worker, "iter_claimed_group_facts", before_finalization)
    monkeypatch.setattr(worker, "_all", bounded_pages)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert witnessed == [True]
    cycles = []
    for after, rows in pages:
        if after == "":
            cycles.append([])
        assert cycles
        cycles[-1].append(rows)
    ready = [cycle for cycle in cycles if any(row["fact_kind"] == "topology_folder_descriptor" for page in cycle for row in page)]
    assert ready
    for cycle in ready:
        folder_pages = [[row["reference_key"][3:] for row in page if row["fact_kind"] == "topology_folder_descriptor"] for page in cycle]
        assert [key for page in folder_pages for key in page] == needed_keys
        assert sum(bool(page) for page in folder_pages) >= 2
        assert target["key"] not in next(page for page in folder_pages if page)
    _assert_published_matches_main(db, build, browse, canonical)


def test_live_excluded_only_owners_keep_physical_mixed_reason(live_projection_database, tmp_path, monkeypatch):
    db = live_projection_database
    _owners, files, _folders = _seed_folder_case(db, tmp_path / "ExcludedOnly", "excluded-member")
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert len(connection.execute(
            "insert into library.exception_overrides(library_id,track_key,override_payload) "
            "select %s,private_path,%s::jsonb from library.local_track_files where id=%s returning id",
            (db.library_id, json.dumps({"exception_type": "Non-album rarity"}), files["a"]["id"]),
        ).fetchall()) == 1
    browse, canonical = _canonical_rows(db)
    assert len(canonical) == 2 and all(row["exception_type"] == "Non-album rarity" and row["file_mixed_album_folder"] is True for row in canonical)
    expected = _topology_unit_main_records(canonical)
    assert len(expected) == 2 and all(MIXED_REASON in record["summary"]["problem_reasons"] for record in expected.values())
    worker, claim, build, _now = _main_search_claimed_v2(db)
    publish = worker.publish_claimed_snapshot
    checked = []

    def physical_only(**kwargs):
        with isolatedPostgres._connect(db.setup_url) as connection:
            definitions = connection.execute(
                "select group_kind,group_identity from ops.problematic_projection_group_facts "
                "where job_id=%s and attempt=%s and revision=%s and fact_kind='topology_definition'",
                (claim.job_id, claim.attempt, build.revision),
            ).fetchall()
            results = connection.execute(
                "select fact_value from ops.problematic_projection_group_facts where job_id=%s and attempt=%s "
                "and revision=%s and fact_kind='topology_address_result'", (claim.job_id, claim.attempt, build.revision),
            ).fetchall()
        assert len(definitions) == 1 and definitions[0]["group_kind"] == "topology_address"
        assert not definitions[0]["group_identity"].startswith("rank:")
        assert len(results) == 1 and results[0]["fact_value"]["status"] == "EMPTY" and results[0]["fact_value"]["member_count"] == 0
        scalars = _folder_facts(db, claim, build)
        assert len(scalars) == 1 and scalars[0]["fact_value"]["mixed"] is True and scalars[0]["fact_value"]["input_count"] == 2
        checked.append(True)
        return publish(**kwargs)

    monkeypatch.setattr(worker, "publish_claimed_snapshot", physical_only)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert checked == [True]
    _assert_published_matches_main(db, build, browse, canonical)


def test_live_all_stale_copy_containers_only_report_album_not_found(live_projection_database, tmp_path, monkeypatch):
    db = live_projection_database
    with isolatedPostgres._connect(db.setup_url) as connection:
        root = connection.execute(
            "insert into library.library_roots(library_id,root_path,root_kind,is_active) "
            "values(%s,%s,'main',true) returning id", (db.library_id, str(tmp_path / "Missing")),
        ).fetchone()["id"]
        album = _album(connection, db, "all-stale")
        for container in ("CopyOne", "CopyTwo"):
            for number in (1, 2):
                _file(connection, db, root, album, tmp_path / "Missing" / container, f"{container}-{number}", number, stale=True)
        assert connection.execute(
            "select count(*) as count,bool_and(file.scan_cache_stale) as all_stale "
            "from library.local_track_files file join library.local_tracks track on track.id=file.track_id "
            "where track.album_id=%s", (album["id"],),
        ).fetchone() == {"count": 4, "all_stale": True}
        containers = connection.execute(
            "select file.scan_physical_parent,array_agg(track.track_number order by track.track_number) as numbers "
            "from library.local_track_files file join library.local_tracks track on track.id=file.track_id "
            "where track.album_id=%s group by file.scan_physical_parent", (album["id"],),
        ).fetchall()
        assert len(containers) == 2 and all(row["numbers"] == [1, 2] for row in containers)
    browse, _ordinary = _canonical_rows(db)
    raw_missing = browse._load_missing_album_rows(album_key=album["key"], canonical_library=True)
    assert len(raw_missing) == 4
    missing = _missing_album_projection_payloads(raw_missing)
    assert len(missing) == 1 and missing[0]["inventory_status"] == "missing" and missing[0]["tracks"] == []
    summary = _problematic_album_summary_payload(missing[0])
    detail = _problematic_album_detail_payload(missing[0])
    assert summary is not None and detail is not None
    assert summary["problem_reasons"] == detail["problem_reasons"] == ["Album not found"]
    worker, claim, build, _now = _main_search_claimed_v2(db)
    complete = worker.complete_claimed_source_group
    checked = []

    def no_stale_topology(**kwargs):
        assert kwargs["group_key"] == ("missing_album", album["id"])
        with isolatedPostgres._connect(db.setup_url) as connection:
            assert connection.execute(
                "select count(*) as count from ops.problematic_projection_group_facts where job_id=%s "
                "and attempt=%s and revision=%s and fact_kind in ('topology_definition','topology_reference',"
                "'topology_physical_reference','topology_folder_reference','topology_rank_reference')",
                (claim.job_id, claim.attempt, build.revision),
            ).fetchone()["count"] == 0
        checked.append(True)
        return complete(**kwargs)

    monkeypatch.setattr(worker, "complete_claimed_source_group", no_stale_topology)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert checked == [True]
    reader = PostgresProblematicProjectionRepository(database_url=db.app_url)
    page = reader.read_page(library_id=db.library_id, limit=200)
    assert len(page.items) == 1
    actual = page.items[0]
    assert actual["projection_id"] == summary["projection_id"]
    assert actual["problem_reasons"] == ["Album not found"] and actual["issue_count"] == 1
    assert actual["inventory_status"] == "missing" and actual["track_count"] == 0
    assert "track_paths" not in actual
    assert reader.read_page(library_id=db.library_id, limit=200, query="Duplicate files").total == 0
    visible_detail = browse.build_problematic_file_detail_payload(projection_id=actual["projection_id"])
    assert visible_detail is not None and visible_detail["problem_reasons"] == ["Album not found"]
    assert visible_detail["tracks"] == [] and not visible_detail.get("duplicate_sources")


def test_live_omitted_physical_hint_cannot_bypass_closure(live_projection_database, tmp_path, monkeypatch):
    db = live_projection_database
    _seed_folder_case(db, tmp_path / "OmittedHint", "same-root")
    _browse, canonical = _canonical_rows(db)
    expected = _topology_unit_main_records(canonical)
    assert expected and all(MIXED_REASON in record["summary"]["problem_reasons"] for record in expected.values())
    worker, claim, build, _now = _main_search_claimed_v2(db)
    checkpoint = worker.checkpoint_claimed_group_facts
    register = worker.register_claimed_topology_nodes
    publish = worker.publish_claimed_snapshot
    submitted = []
    rejected = []
    published = []

    def omit_hint(**kwargs):
        if kwargs["group_key"][0] != "album":
            return checkpoint(**kwargs)
        entries = []
        changed = False
        for stage_id, kind, value in kwargs["entries"]:
            if kind == "topology_seed":
                assert value.get("physical_container") and value.get("default_container") and value.get("identity")
                assert value["excluded"] is False
                value = dict(value)
                del value["physical_container"]
                changed = True
            entries.append((stage_id, kind, value))
        result = checkpoint(**{**kwargs, "entries": tuple(entries)})
        if changed:
            with isolatedPostgres._connect(db.setup_url) as connection:
                seeds = connection.execute(
                    "select fact_value from ops.problematic_projection_group_facts where job_id=%s and attempt=%s "
                    "and revision=%s and group_kind=%s and group_identity=%s and fact_kind='topology_seed'",
                    (claim.job_id, claim.attempt, build.revision, kwargs["group_key"][0], str(kwargs["group_key"][1])),
                ).fetchall()
            assert seeds and all("physical_container" not in row["fact_value"] for row in seeds)
            submitted.append(kwargs["group_key"])
        return result

    def registration_rejects(**kwargs):
        try:
            return register(**kwargs)
        except ProblematicProjectionStorageError as error:
            native = error
            while native is not None and getattr(native, "sqlstate", None) is None:
                native = native.__cause__
            assert submitted and native is not None and native.sqlstate == "55000"
            assert native.diag.message_primary == "topology physical container hint is missing"
            rejected.append(True)
            raise

    def observe_publish(**kwargs):
        published.append(True)
        return publish(**kwargs)

    monkeypatch.setattr(worker, "checkpoint_claimed_group_facts", omit_hint)
    monkeypatch.setattr(worker, "register_claimed_topology_nodes", registration_rejects)
    monkeypatch.setattr(worker, "publish_claimed_snapshot", observe_publish)
    result = _run_topology_worker(worker, claim)
    assert result.next_state is JobState.RETRY_WAIT and submitted and rejected == [True] and published == []
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_headers where library_id=%s", (db.library_id,),
        ).fetchone()["count"] == 0
