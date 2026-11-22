"""Native regression contracts for topology page, payload, and version boundaries."""

from datetime import datetime, timezone
import json
from types import SimpleNamespace

import pytest

from music_app.services.jobs.models import JobState
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.library_browse_postgres import (
    PostgresLibraryBrowseRepository, _load_duplicate_candidate_album_ids_for_keys,
)
from music_app.services.problematic_files_projection import _duplicate_sources_from_rows
from music_app.services.problematic_projection_postgres import PostgresProblematicProjectionRepository
from tests.e2e.support import isolatedPostgres
from tests.py.test_problematic_files_projection import _topology_unit_main_records, _topology_unit_row
from tests.py.test_problematic_projection_postgres import _main_search_claimed_v2, live_projection_database
from tests.py.test_problematic_topology_closure_postgres import _run_topology_worker
from tests.py.test_problematic_topology_derived_identity import _seed_native_overlap


def _copy_rows():
    rows = []
    for key, folder, album_id in (("a-owner", "P", 71), ("b-copy", "Q", 72)):
        for number in (1, 2):
            identity = len(rows) + 1
            row = _topology_unit_row(
                f"C:/TopologyDerived/{folder}/{number}.flac", identity,
                original_key=key, album_id=album_id, number=number,
            )
            row["track_title"] = f"Matching track {number}"
            row["file_entry"]["title"] = row["track_title"]
            rows.append(row)
    return rows


def _scope(claim, build):
    return (claim.job_id, claim.attempt, claim.worker_id, claim.lease_token,
            build.library_id, build.source_generation, build.rebuild_epoch,
            build.revision)


def _progress(db, claim, build):
    with isolatedPostgres._connect(db.setup_url) as connection:
        state = connection.execute(
            "select to_jsonb(state) as value from ops.problematic_projection_state state "
            "where library_id=%s", (db.library_id,),
        ).fetchone()["value"]
        facts = connection.execute(
            "select group_kind,group_identity,projection_id,fact_kind,semantic_child_identity,"
            "stage_id,fact_value from ops.problematic_projection_group_facts "
            "where job_id=%s and attempt=%s and revision=%s "
            "order by group_kind,group_identity,projection_id,fact_kind,semantic_child_identity",
            (claim.job_id, claim.attempt, build.revision),
        ).fetchall()
        accumulators = connection.execute(
            "select to_jsonb(owner) as value from ops.problematic_projection_group_accumulators owner "
            "where job_id=%s and attempt=%s and revision=%s order by group_kind,group_identity",
            (claim.job_id, claim.attempt, build.revision),
        ).fetchall()
        sources = connection.execute(
            "select to_jsonb(source) as value from ops.problematic_projection_source_staging source "
            "where job_id=%s and attempt=%s and revision=%s order by stage_id",
            (claim.job_id, claim.attempt, build.revision),
        ).fetchall()
    return state, facts, accumulators, sources


def _reject(db, claim, build, sql, arguments, *, sqlstate="22023", message=None):
    before = _progress(db, claim, build)
    with pytest.raises(Exception) as error:
        with isolatedPostgres._connect(db.worker_url) as connection:
            connection.execute(sql, arguments).fetchall()
    assert getattr(error.value, "sqlstate", None) == sqlstate
    if message is not None:
        assert message in str(error.value)
    assert _progress(db, claim, build) == before


@pytest.mark.parametrize("invalid", [
    "registration-limit", "registration-cursor", "node-limit",
    "descriptor-limit", "descriptor-cursor",
])
def test_live_topology_null_page_arguments_reject_without_progress(
    live_projection_database, monkeypatch, invalid,
):
    db = live_projection_database
    _seed_native_overlap(db, _copy_rows())
    worker, claim, build, now = _main_search_claimed_v2(db)
    load = worker.load_claimed_topology_node
    checked = []

    def check_registered_owner(**kwargs):
        kind, identity = kwargs["node_key"]
        if not checked and kind in ("topology_identity", "topology_address"):
            assert worker.validate_claimed_build(claim=claim, build=build, now=now)
            base = _scope(claim, build) + (kind, identity)
            if invalid.startswith("registration"):
                cursor, limit = (None, 100) if invalid.endswith("cursor") else (0, None)
                sql = "select * from ops.register_claimed_problematic_topology_nodes(" + ",".join(["%s"] * 13) + ")"
                arguments = base + (cursor, limit, now)
            elif invalid == "node-limit":
                sql = "select * from ops.load_claimed_problematic_topology_node(" + ",".join(["%s"] * 12) + ")"
                arguments = base + (None, now)
            else:
                cursor, limit = (None, 100) if invalid.endswith("cursor") else ("", None)
                sql = "select * from ops.load_claimed_problematic_topology_descriptors(" + ",".join(["%s"] * 13) + ")"
                arguments = base + (cursor, limit, now)
            _reject(db, claim, build, sql, arguments)
            assert worker.validate_claimed_build(claim=claim, build=build, now=now)
            checked.append(True)
        return load(**kwargs)

    monkeypatch.setattr(worker, "load_claimed_topology_node", check_registered_owner)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert checked == [True]


def _canonical_rows(db):
    browse = PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url})
    return browse, browse._load_problematic_file_rows(candidate_summary=False)


def _assert_published_matches_main(db, build, browse, rows):
    expected = _topology_unit_main_records(rows)
    assert expected
    page = PostgresProblematicProjectionRepository(database_url=db.app_url).read_page(
        library_id=db.library_id, limit=200,
    )
    actual = {item["projection_id"]: item for item in page.items}
    assert actual.keys() == expected.keys()
    for identity, record in expected.items():
        assert actual[identity]["problem_reasons"] == record["summary"]["problem_reasons"]
        detail = browse.build_problematic_file_detail_payload(projection_id=identity)
        assert detail is not None
        assert detail.get("duplicate_sources", []) == record["detail"].get("duplicate_sources", [])
        assert detail.get("root_provenance") == record["detail"].get("root_provenance")
        with isolatedPostgres._connect(db.setup_url) as connection:
            chunks = connection.execute(
                "select normalized_text from ops.problematic_projection_search_facts "
                "where library_id=%s and revision=%s and item_key=%s and fact_kind='main_search' "
                "order by semantic_child_identity", (db.library_id, build.revision, identity),
            ).fetchall()
        assert [chunk["normalized_text"] for chunk in chunks] == [record["document"]]


@pytest.fixture
def _nfc_greek_copies(live_projection_database):
    from music_app.services.metadata import extract_year, first_tag

    db = live_projection_database
    rows = _copy_rows()
    forms = {"a-owner": "\u1fb4", "b-copy": "\u03b1\u0345\u0301"}
    for row in rows:
        tags = {"album": [forms[row["album_key"]]],
                "albumartist": [forms[row["album_key"]]], "date": ["1988"]}
        album = first_tag(tags, ["album"])
        artist = first_tag(tags, ["albumartist"])
        year = extract_year(tags)
        assert album == artist == forms[row["album_key"]]
        assert type(year) is int and year == 1988
        row.update(album_title=album, artist_name=artist,
                   album_metadata={"album_artist": artist})
        row["file_entry"].update(album=album, album_artist=artist, artist=artist, year=year)
    owner_id = _seed_native_overlap(db, rows)
    with isolatedPostgres._connect(db.setup_url) as connection:
        owners = connection.execute(
            "select id,album_key from library.local_albums "
            "where library_id=%s and album_key=any(%s::text[])",
            (db.library_id, list(forms)),
        ).fetchall()
        ids = {row["album_key"]: row["id"] for row in owners}
        assert set(ids) == set(forms) and ids["a-owner"] == owner_id
        updated = connection.execute(
            "update library.local_tracks set duration_seconds=180,disc_number=1 "
            "where library_id=%s and album_id=any(%s::bigint[]) returning id",
            (db.library_id, list(ids.values())),
        ).fetchall()
        assert len(updated) == 4
        files = connection.execute(
            "select file.id,file.private_path from library.local_track_files file "
            "join library.local_tracks track on track.id=file.track_id "
            "where track.library_id=%s and track.album_id=any(%s::bigint[])",
            (db.library_id, list(ids.values())),
        ).fetchall()
    paths = {row["id"]: row["private_path"] for row in files}
    assert len(paths) == 4 and set(paths.values()) == {row["file_private_path"] for row in rows}
    browse, native_rows = _canonical_rows(db)
    assert len(native_rows) == 4
    assert all(row["duration_seconds"] == 180 for row in native_rows)
    assert all(row["file_entry"]["album"] == row["file_entry"]["album_artist"]
               == forms[row["album_key"]] for row in native_rows)
    assert all(type(row["file_entry"]["year"]) is int and row["file_entry"]["year"] == 1988
               for row in native_rows)
    expected = _topology_unit_main_records(native_rows)
    assert len(expected) == 2
    assert {record["summary"]["key"] for record in expected.values()} == set(forms)
    assert all(len(record["detail"]["duplicate_sources"]) == 2 for record in expected.values())
    assert all("Duplicate files" in record["summary"]["problem_reasons"] for record in expected.values())
    return SimpleNamespace(db=db, browse=browse, native_rows=native_rows,
                           owners=ids, paths=paths, expected=expected)


def test_live_targeted_duplicate_candidates_and_opaque_detail_preserve_nfc_greek_copies(
    _nfc_greek_copies,
):
    fixture = _nfc_greek_copies
    with isolatedPostgres._connect(fixture.db.app_url) as connection:
        candidates = _load_duplicate_candidate_album_ids_for_keys(
            connection, ["a-owner"], canonical_library=True,
        )
    assert set(candidates) == set(fixture.owners.values())
    worker, claim, _build, _now = _main_search_claimed_v2(fixture.db)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    page = fixture.browse.build_problematic_files_page(limit=50)
    selected = next(item for item in page["items"] if item["key"] == "a-owner")
    expected = fixture.expected[selected["projection_id"]]["detail"]["duplicate_sources"]
    detail = fixture.browse.build_problematic_file_detail_payload(
        projection_id=selected["projection_id"],
    )
    assert detail is not None and detail["projection_id"] == selected["projection_id"]
    assert len(detail["duplicate_sources"]) == len(expected) == 2
    assert [(source["folder_path"], [track["track_ref"] for track in source["tracks"]])
            for source in detail["duplicate_sources"]] == [
                (source["folder_path"], [track["track_ref"] for track in source["tracks"]])
                for source in expected
            ]


def test_live_topology_identity_discovery_and_publication_preserve_nfc_greek_copies(
    _nfc_greek_copies, monkeypatch,
):
    fixture = _nfc_greek_copies
    worker, claim, build, _now = _main_search_claimed_v2(fixture.db)
    load = worker.load_claimed_topology_node
    discovered = set()

    def record_identity_page(**options):
        page = load(**options)
        if options["node_key"][0] == "topology_identity":
            for row in page["rows"]:
                assert fixture.paths[row["file_id"]] == row["path"]
                discovered.add(row["file_id"])
        return page

    monkeypatch.setattr(worker, "load_claimed_topology_node", record_identity_page)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert discovered == set(fixture.paths)
    _assert_published_matches_main(fixture.db, build, fixture.browse, fixture.native_rows)


def test_live_topology_present_null_exception_clear_matches_main(live_projection_database):
    db = live_projection_database
    rows = _copy_rows()
    for row in rows:
        row["file_entry"]["exception_type"] = "Non-album rarity"
    _seed_native_overlap(db, rows)
    with isolatedPostgres._connect(db.setup_url) as connection:
        for row in rows:
            connection.execute(
                "insert into library.exception_overrides(library_id,track_key,override_payload) "
                "values(%s,%s,%s::jsonb)",
                (db.library_id, row["file_private_path"], json.dumps({"exception_type": None})),
            )
    browse, native_rows = _canonical_rows(db)
    assert len(native_rows) == 4
    assert all(row["exception_override_present"] and row["exception_type"] is None for row in native_rows)
    assert _duplicate_sources_from_rows(native_rows)["a-owner"]["has_duplicate_files"]
    worker, claim, build, _now = _main_search_claimed_v2(db)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    _assert_published_matches_main(db, build, browse, native_rows)


def test_live_topology_irrelevant_metadata_keeps_pages_bounded_and_content_exact(
    live_projection_database, monkeypatch,
):
    db = live_projection_database
    rows = _copy_rows()
    for row in rows:
        row["album_metadata"]["irrelevant_review_blob"] = "album padding " * 20000
        row["file_entry"]["irrelevant_review_blob"] = "file padding " * 20000
        row["track_title"] += " — intact required search tail"
        row["file_entry"]["title"] = row["track_title"]
    _seed_native_overlap(db, rows)
    browse, native_rows = _canonical_rows(db)
    assert _duplicate_sources_from_rows(native_rows)["a-owner"]["has_duplicate_files"]
    worker, claim, build, _now = _main_search_claimed_v2(db)
    load = worker.load_claimed_topology_node
    stage = worker.stage_claimed_topology_node
    measured = []
    hydrated = []

    def measure_page(**kwargs):
        page = load(**kwargs)
        if page["rows"]:
            encoded = json.dumps(list(page["rows"]), ensure_ascii=False)
            size = len(encoded.encode("utf-8"))
            assert len(page["rows"]) <= 100 and size <= 65536
            assert "irrelevant_review_blob" not in encoded
            measured.append(size)
        return page

    def measure_hydrated_inputs(**kwargs):
        stage(**kwargs)
        with isolatedPostgres._connect(db.setup_url) as connection:
            inputs = connection.execute(
                "select octet_length(payload::text) as bytes,payload "
                "from ops.problematic_projection_source_staging where job_id=%s and attempt=%s "
                "and revision=%s and source_kind='topology_input' and group_kind=%s and group_identity=%s",
                (claim.job_id, claim.attempt, build.revision, *kwargs["node_key"]),
            ).fetchall()
        for item in inputs:
            assert item["bytes"] <= 65536
            assert "irrelevant_review_blob" not in json.dumps(item["payload"], ensure_ascii=False)
        hydrated.extend(item["bytes"] for item in inputs)

    monkeypatch.setattr(worker, "load_claimed_topology_node", measure_page)
    monkeypatch.setattr(worker, "stage_claimed_topology_node", measure_hydrated_inputs)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert measured and hydrated
    _assert_published_matches_main(db, build, browse, native_rows)


def test_live_topology_numeric_candidates_filter_before_hydration_and_bind_terminal(
    live_projection_database, monkeypatch,
):
    db = live_projection_database
    rows = []
    folders = ("1", "١", "Artist", "Bonus", "Ⅰ", "猫")
    for identity, folder in enumerate(folders, 1):
        own = identity <= 2
        row = _topology_unit_row(
            f"C:/TopologyDerived/P/{folder}/{identity}.flac", identity,
            original_key="a-owner" if own else f"unrelated-{identity}",
            album_id=71 if own else 71 + identity,
        )
        if not own:
            row["album_metadata"]["irrelevant_review_blob"] = "unrelated album " * 10000
            row["file_entry"]["irrelevant_review_blob"] = "unrelated file " * 10000
        rows.append(row)
    _seed_native_overlap(db, rows)
    worker, claim, build, now = _main_search_claimed_v2(db)
    load = worker.load_claimed_topology_node
    stage = worker.stage_claimed_topology_node
    complete = worker.complete_claimed_topology_node
    offered = []
    offered_rows = {}
    dispositions = []
    terminal_checked = []
    with isolatedPostgres._connect(db.setup_url) as connection:
        paths = {row["id"]: row["private_path"] for row in connection.execute(
            "select id,private_path from library.local_track_files",
        ).fetchall()}

    def capture_offers(**kwargs):
        page = load(**kwargs)
        if page["sealed"]:
            assert page["complete"] is True and not page["rows"]
            assert page["expected_cursor"] == {}
            return page
        relation = page["expected_cursor"]["relation"]
        if relation in ("parent", "numeric_parent"):
            for row in page["rows"]:
                assert set(row) == {"file_id", "root_id", "track_id", "path"}
                assert row["path"] == paths[row["file_id"]]
                offered.append((kwargs["node_key"], relation, row["file_id"]))
                offered_rows[(kwargs["node_key"], relation, row["file_id"])] = dict(row)
        return page

    def capture_dispositions(**kwargs):
        relation = kwargs["expected_cursor"]["relation"]
        if relation in ("parent", "numeric_parent"):
            for row in kwargs["rows"]:
                assert type(row["retain"]) is bool
                dispositions.append((kwargs["node_key"], relation, row["file_id"], row["retain"]))
        return stage(**kwargs)

    def check_parent_terminal(**kwargs):
        kind, identity = kwargs["node_key"]
        if not terminal_checked and kind == "topology_numeric_bucket" and identity.startswith("input:"):
            scope = (claim.job_id, claim.attempt, build.revision, kind, identity)
            with isolatedPostgres._connect(db.setup_url) as connection:
                terminal = connection.execute(
                    "select fact_value from ops.problematic_projection_group_facts "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
                    "and projection_id='topology' and fact_kind='topology_source_end' "
                    "and semantic_child_identity='parent'", scope,
                ).fetchone()["fact_value"]
                candidate = connection.execute(
                    "select count(*) as count,coalesce(bit_xor(('x'||encode(sha256(convert_to("
                    "fact_value::text,'UTF8')),'hex'))::bit(256)),0::bit(256))::text as fingerprint "
                    "from ops.problematic_projection_group_facts where job_id=%s and attempt=%s "
                    "and revision=%s and group_kind=%s and group_identity=%s "
                    "and projection_id='topology' and fact_kind='topology_candidate_disposition'",
                    scope,
                ).fetchone()
                facts = connection.execute(
                    "select * from ops.problematic_projection_group_facts "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
                    "and projection_id='topology' and fact_kind='topology_candidate_disposition' "
                    "order by semantic_child_identity", scope,
                ).fetchall()
                sources = connection.execute(
                    "select payload from ops.problematic_projection_source_staging "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
                    "and source_kind='topology_input' and child_kind='parent'", scope,
                ).fetchall()
                source_proof = connection.execute(
                    "select count(*) as count,coalesce(bit_xor(('x'||encode(sha256(convert_to("
                    "jsonb_build_array(child_kind,child_identity,payload)::text,'UTF8')),'hex'))::bit(256)),"
                    "0::bit(256))::text as fingerprint from ops.problematic_projection_source_staging "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
                    "and source_kind='topology_input' and child_kind='parent'", scope,
                ).fetchone()
                for fact in facts:
                    value = fact["fact_value"]
                    assert set(value) == {"relation", "file_id", "retain", "candidate_digest"}
                    assert fact["stage_id"] == 0
                    assert fact["semantic_child_identity"] == f"parent:{value['file_id']:020d}"
                    offered_row = offered_rows[((kind, identity), "parent", value["file_id"])]
                    digest = connection.execute(
                        "select encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex') as value",
                        (json.dumps(offered_row),),
                    ).fetchone()["value"]
                    assert value["candidate_digest"] == digest
            assert terminal["candidate_count"] == candidate["count"] == 4
            assert terminal["candidate_fingerprint"] == candidate["fingerprint"]
            retained = {fact["fact_value"]["file_id"] for fact in facts if fact["fact_value"]["retain"]}
            assert terminal["source_count"] == len(retained) == 2
            assert terminal["source_count"] == source_proof["count"]
            assert terminal["source_fingerprint"] == source_proof["fingerprint"]
            assert {source["payload"]["file_id"] for source in sources} == retained
            rejected = [fact for fact in facts if not fact["fact_value"]["retain"]]
            assert {paths[fact["fact_value"]["file_id"]] for fact in rejected} == {
                rows[4]["file_private_path"], rows[5]["file_private_path"],
            }
            lost = rejected[0]
            with isolatedPostgres._connect(db.setup_url) as connection:
                connection.execute(
                    "delete from ops.problematic_projection_group_facts where job_id=%s and attempt=%s "
                    "and revision=%s and group_kind=%s and group_identity=%s and projection_id='topology' "
                    "and fact_kind='topology_candidate_disposition' and semantic_child_identity=%s",
                    scope + (lost["semantic_child_identity"],),
                )
            sql = "select * from ops.complete_claimed_problematic_topology_node(" + ",".join(["%s"] * 11) + ")"
            _reject(
                db, claim, build, sql, _scope(claim, build) + (kind, identity, now),
                sqlstate="55000", message="topology candidate terminals differ from dispositions",
            )
            with isolatedPostgres._connect(db.setup_url) as connection:
                connection.execute(
                    "insert into ops.problematic_projection_group_facts(job_id,attempt,revision,group_kind,"
                    "group_identity,stage_id,projection_id,fact_kind,semantic_child_identity,fact_value,created_at) "
                    "values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)",
                    tuple(lost[key] for key in ("job_id", "attempt", "revision", "group_kind", "group_identity",
                                               "stage_id", "projection_id", "fact_kind", "semantic_child_identity"))
                    + (json.dumps(lost["fact_value"]), lost["created_at"]),
                )
            terminal_checked.append(True)
        return complete(**kwargs)

    monkeypatch.setattr(worker, "load_claimed_topology_node", capture_offers)
    monkeypatch.setattr(worker, "stage_claimed_topology_node", capture_dispositions)
    monkeypatch.setattr(worker, "complete_claimed_topology_node", check_parent_terminal)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert terminal_checked == [True]
    assert offered and len(offered) == len(set(offered))
    offered_paths = {paths[file_id] for _owner, _relation, file_id in offered}
    assert rows[2]["file_private_path"] not in offered_paths
    assert rows[3]["file_private_path"] not in offered_paths
    assert rows[1]["file_private_path"] in offered_paths
    for _owner, _relation, file_id, retain in dispositions:
        assert retain is (paths[file_id] in {rows[0]["file_private_path"], rows[1]["file_private_path"]})
    parent_visits = [file_id for _owner, relation, file_id in offered if relation == "parent"]
    assert len(parent_visits) == len(set(parent_visits)) == 4


def _claimed_version(db, version):
    if version == 3:
        return _main_search_claimed_v2(db)
    with isolatedPostgres._connect(db.app_url) as connection:
        queued = connection.execute(
            "select * from ops.enqueue_problematic_projection_rebuild(%s,%s)",
            (db.library_id, "topology-v1-boundary-control"),
        ).fetchone()
    now = datetime.now(timezone.utc)
    claim = PostgresJobRepository(database_url=db.worker_url).claim(
        worker_id="topology-v1-boundary-control", now=now, lease_seconds=120,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == queued["job_id"]
    assert claim.parameters.get("builder_version", 1) == 1
    with isolatedPostgres._connect(db.worker_url) as connection:
        prepared = connection.execute(
            "select * from ops.prepare_claimed_problematic_projection(%s,%s,%s,%s,%s)",
            (claim.job_id, claim.attempt, claim.worker_id, claim.lease_token, now),
        ).fetchone()
    assert prepared is not None and not prepared["committed"]
    build = SimpleNamespace(**{key: prepared[key] for key in (
        "library_id", "source_generation", "rebuild_epoch", "revision",
    )})
    return None, claim, build, now


def _source_call(claim, build, now, *, version, chunk=None):
    arguments = _scope(claim, build)
    if chunk is None:
        name = "load_claimed_problematic_projection_source"
        arguments += (100, 100, now)
    else:
        name = "stage_claimed_problematic_projection_source"
        arguments += tuple(chunk[key] for key in (
            "group_kind", "group_identity", "source_kind", "source_identity", "child_kind", "child_identity",
        )) + (json.dumps(chunk["rows"]), chunk["group_complete"], now)
    if version is not None:
        arguments += (version,)
    return f"select * from ops.{name}(" + ",".join(["%s"] * len(arguments)) + ")", arguments


@pytest.mark.parametrize("persisted,requested,operation", [
    (3, None, "load"), (3, None, "stage"), (3, 1, "load"), (3, 1, "stage"),
    (3, 2, "load"), (3, 2, "stage"), (1, 2, "load"), (1, 2, "stage"),
    (1, 3, "load"), (1, 3, "stage"),
], ids=["v3-legacy-load", "v3-legacy-stage", "v3-v1-load", "v3-v1-stage",
        "v3-v2-load", "v3-v2-stage", "v1-v2-load", "v1-v2-stage", "v1-v3-load", "v1-v3-stage"])
def test_live_topology_source_version_mismatch_rejects_without_progress(
    live_projection_database, persisted, requested, operation,
):
    db = live_projection_database
    _seed_native_overlap(db, _copy_rows())
    _worker, claim, build, now = _claimed_version(db, persisted)
    matching = persisted if persisted == 3 else None
    sql, arguments = _source_call(claim, build, now, version=matching)
    with isolatedPostgres._connect(db.worker_url) as connection:
        page = connection.execute(sql, arguments).fetchall()
    assert page and page[0]["rows"] and not page[0]["group_complete"]
    sql, arguments = _source_call(
        claim, build, now, version=requested, chunk=page[0] if operation == "stage" else None,
    )
    _reject(db, claim, build, sql, arguments)
    sql, arguments = _source_call(claim, build, now, version=matching, chunk=page[0])
    with isolatedPostgres._connect(db.worker_url) as connection:
        assert connection.execute(sql, arguments).fetchone()["accepted"] is True


@pytest.mark.parametrize("version", [None, 1], ids=["legacy-signature", "versioned-v1"])
def test_live_topology_v1_source_load_and_stage_controls(live_projection_database, version):
    db = live_projection_database
    _seed_native_overlap(db, _copy_rows())
    _worker, claim, build, now = _claimed_version(db, 1)
    sql, arguments = _source_call(claim, build, now, version=version)
    with isolatedPostgres._connect(db.worker_url) as connection:
        page = connection.execute(sql, arguments).fetchall()
    assert page and page[0]["rows"] and not page[0]["group_complete"]
    sql, arguments = _source_call(claim, build, now, version=version, chunk=page[0])
    with isolatedPostgres._connect(db.worker_url) as connection:
        assert connection.execute(sql, arguments).fetchone()["accepted"] is True


def test_live_topology_unassigned_producer_keys_match_source_eligibility(
    live_projection_database, monkeypatch,
):
    from music_app.services.problematic_files_projection import _problematic_topology_seed

    db = live_projection_database
    with isolatedPostgres._connect(db.setup_url) as connection:
        root = connection.execute(
            "insert into library.library_roots(library_id,root_path,root_kind,is_active) "
            "values(%s,'C:/TopologyProducer','main',true) returning id", (db.library_id,),
        ).fetchone()["id"]
        artist = connection.execute(
            "insert into library.local_artists(library_id,artist_key,name) "
            "values(%s,'topology-producer-artist','Producer Artist') returning id", (db.library_id,),
        ).fetchone()["id"]
        files = {}
        for label, problem in (("eligible", "Cached membership needs repair"), ("unrelated", None)):
            track = connection.execute(
                "insert into library.local_tracks(library_id,artist_id,album_id,track_key,title,track_number) "
                "values(%s,%s,null,%s,%s,1) returning id",
                (db.library_id, artist, f"topology-producer-{label}", label),
            ).fetchone()["id"]
            path = f"C:/TopologyProducer/Loose/{label}.flac"
            entry = {"path": path, "album": "Cached Album", "album_artist": "Producer Artist",
                     "artist": "Producer Artist", "title": label, "year": 1988,
                     "track_number": 1, "disc_number": 1, "duration_seconds": 180}
            if problem is not None:
                entry["local_album_membership_problem"] = problem
            files[label] = connection.execute(
                "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
                "values(%s,%s,%s,%s::jsonb) returning id",
                (track, root, path, json.dumps({"scan_cache": {"file_entry": entry}})),
            ).fetchone()["id"]
        authoritative = connection.execute(
            "select group_kind,group_identity,child_kind,child_identity "
            "from ops.problematic_projection_source_rows where library_id=%s "
            "and child_identity in (%s,%s) order by child_identity",
            (db.library_id, str(files["eligible"]), str(files["unrelated"])),
        ).fetchall()
        payloads = {label: connection.execute(
            "select ops.problematic_projection_topology_file_payload(%s,%s) as payload",
            (db.library_id, file_id),
        ).fetchone()["payload"] for label, file_id in files.items()}
    assert authoritative == [{"group_kind": "loose_source", "group_identity": str(files["eligible"]),
                              "child_kind": "file", "child_identity": str(files["eligible"])}]
    loose_key = f"loose-source::{files['eligible']}"
    assert payloads["eligible"]["album_key"] == loose_key
    assert payloads["eligible"]["local_album_membership_problem"] == "Cached membership needs repair"
    assert payloads["unrelated"]["album_key"] == ""
    assert payloads["unrelated"]["local_album_membership_problem"] is None
    for label, payload in payloads.items():
        assert payload["album_id"] is None and payload["file_id"] == files[label]
        seed = _problematic_topology_seed(payload)
        assert seed is not None and seed["excluded"] is True
        assert seed["original_album_key"] == payload["album_key"]
        assert "identity" not in seed and "default_container" not in seed

    worker, claim, build, now = _main_search_claimed_v2(db)
    page = worker.load_claimed_source_page(claim=claim, build=build, limit=100, child_limit=100, now=now)
    assert len(page.chunks) == 1
    chunk = page.chunks[0]
    assert chunk.group_key == ("loose_source", files["eligible"])
    assert [row["album_key"] for row in chunk.rows] == [loose_key]
    complete = worker.complete_claimed_source_group
    checked = []

    def check_no_surviving_topology_owner(**kwargs):
        assert kwargs["group_key"] == ("loose_source", files["eligible"])
        with isolatedPostgres._connect(db.setup_url) as connection:
            facts = connection.execute(
                "select group_kind,group_identity,fact_kind,fact_value from ops.problematic_projection_group_facts "
                "where job_id=%s and attempt=%s and revision=%s "
                "and fact_kind in ('topology_seed','topology_definition','topology_reference',"
                "'topology_physical_reference','topology_rank_reference','topology_own_address_seed',"
                "'topology_owned_address','topology_address_result','topology_address_member','topology_folder_status')",
                (claim.job_id, claim.attempt, build.revision),
            ).fetchall()
            nodes = connection.execute(
                "select group_kind,group_identity from ops.problematic_projection_group_accumulators "
                "where job_id=%s and attempt=%s and revision=%s "
                "and group_kind in ('topology_identity','topology_numeric_bucket','topology_address')",
                (claim.job_id, claim.attempt, build.revision),
            ).fetchall()
            inputs = connection.execute(
                "select child_kind,payload from ops.problematic_projection_source_staging "
                "where job_id=%s and attempt=%s and revision=%s and source_kind='topology_input'",
                (claim.job_id, claim.attempt, build.revision),
            ).fetchall()
        assert len(nodes) == 1 and nodes[0]["group_kind"] == "topology_address"
        assert not nodes[0]["group_identity"].startswith("rank:")
        assert not any(fact["fact_kind"] in ("topology_reference", "topology_rank_reference",
                                            "topology_own_address_seed", "topology_owned_address", "topology_address_member")
                       for fact in facts)
        seeds = [fact["fact_value"] for fact in facts if fact["fact_kind"] == "topology_seed"]
        assert seeds and all(seed["excluded"] is True for seed in seeds)
        assert {seed["original_album_key"] for seed in seeds} == {loose_key, ""}
        physical = [fact for fact in facts if fact["fact_kind"] == "topology_physical_reference"]
        assert len(physical) == 1 and physical[0]["group_kind"] == "loose_source"
        assert physical[0]["group_identity"] == str(files["eligible"])
        assert physical[0]["fact_value"] == {"node_kind": "topology_address", "node_identity": nodes[0]["group_identity"]}
        results = [fact["fact_value"] for fact in facts if fact["fact_kind"] == "topology_address_result"]
        assert len(results) == 1 and results[0]["status"] == "EMPTY" and results[0]["member_count"] == 0
        folders = [fact["fact_value"] for fact in facts if fact["fact_kind"] == "topology_folder_status"]
        assert len(folders) == 1 and folders[0]["mixed"] is False and folders[0]["input_count"] == 2
        assert len(inputs) == 2 and all(row["child_kind"] == "default" for row in inputs)
        assert {row["payload"]["file_id"] for row in inputs} == set(files.values())
        assert {row["payload"]["album_key"] for row in inputs} == {loose_key, ""}
        checked.append(True)
        return complete(**kwargs)

    monkeypatch.setattr(worker, "complete_claimed_source_group", check_no_surviving_topology_owner)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert checked == [True]
    visible = PostgresProblematicProjectionRepository(database_url=db.app_url).read_page(library_id=db.library_id, limit=200)
    assert all(item["key"] != f"loose-source::{files['unrelated']}" and "Duplicate files" not in item["problem_reasons"]
               for item in visible.items)


def test_live_topology_root_deactivation_excludes_inactive_nonstale_own_copy(
    live_projection_database, tmp_path,
):
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore

    db = live_projection_database
    root_paths = {label: str((tmp_path / label).resolve()) for label in ("RootP", "RootQ")}
    definitions = [{"id": label, "path": path, "layout_mode": "artist"}
                   for label, path in root_paths.items()]
    roots = PostgresLibraryRootSettingsStore({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url})
    saved = roots.save_settings({"main_library_roots": definitions})
    assert {root["id"] for root in saved["main_library_roots"]} == {"RootP", "RootQ"}
    inactive_title = "inactiveonlyrootsentinel"
    retained_titles = {f"Retained track {number}" for number in (1, 2)}
    with isolatedPostgres._connect(db.setup_url) as connection:
        root_ids = {row["root_id"]: row["id"] for row in connection.execute(
            "select id,metadata->>'root_id' as root_id from library.library_roots "
            "where library_id=%s and is_active", (db.library_id,),
        ).fetchall()}
        artist = connection.execute(
            "insert into library.local_artists(library_id,artist_key,name) "
            "values(%s,'root-fence-artist','Root Fence Artist') returning id", (db.library_id,),
        ).fetchone()["id"]
        album = connection.execute(
            "insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata) "
            "values(%s,%s,'root-fence-owned','Root Fence Album',1988,%s::jsonb) returning id",
            (db.library_id, artist, json.dumps({"album_artist": "Root Fence Artist"})),
        ).fetchone()["id"]
        files = {"RootP": [], "RootQ": []}
        for label in root_paths:
            for number in (1, 2):
                title = f"Retained track {number}" if label == "RootP" else f"{inactive_title} {number}"
                path = str(tmp_path / label / "Album" / f"{number}.flac")
                track = connection.execute(
                    "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,track_number) "
                    "values(%s,%s,%s,%s,%s,%s) returning id",
                    (db.library_id, album, artist, f"root-fence-{label}-{number}", title, number),
                ).fetchone()["id"]
                entry = {"path": path, "album": "Root Fence Album", "album_artist": "Root Fence Artist",
                         "artist": "Root Fence Artist", "title": title, "year": 1988,
                         "track_number": number, "disc_number": 1, "duration_seconds": 180}
                files[label].append(connection.execute(
                    "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
                    "values(%s,%s,%s,%s::jsonb) returning id",
                    (track, root_ids[label], path, json.dumps({"scan_cache": {"file_entry": entry}})),
                ).fetchone()["id"])
        file_paths = {row["id"]: row["private_path"] for row in connection.execute(
            "select file.id,file.private_path from library.local_track_files file "
            "join library.local_tracks track on track.id=file.track_id where track.album_id=%s",
            (album,),
        ).fetchall()}

    browse, before_rows = _canonical_rows(db)
    assert len(before_rows) == 4 and {row["album_id"] for row in before_rows} == {album}
    assert {row["file_private_path"] for row in before_rows} == {
        file_paths[file_id] for file_id in files["RootP"] + files["RootQ"]
    }
    assert _duplicate_sources_from_rows(before_rows)["root-fence-owned"]["has_duplicate_files"]
    before_records = _topology_unit_main_records(before_rows)
    assert len(before_records) == 1
    identity, before = next(iter(before_records.items()))
    assert before["summary"]["track_count"] == 4
    assert "Duplicate files" in before["summary"]["problem_reasons"]
    assert before["summary"].get("inventory_status") != "missing"
    assert inactive_title in before["document"]
    worker, claim, first_build, _now = _main_search_claimed_v2(db)
    outcome = _run_topology_worker(worker, claim)
    assert outcome.next_state is JobState.SUCCEEDED
    _assert_published_matches_main(db, first_build, browse, before_rows)
    assert PostgresJobRepository(database_url=db.worker_url).finish(
        claim, outcome, now=datetime.now(timezone.utc),
    )
    reader = PostgresProblematicProjectionRepository(database_url=db.app_url)
    assert reader.read_page(library_id=db.library_id, limit=200, query=inactive_title).total == 1

    saved = roots.save_settings({"main_library_roots": [definitions[0]]})
    assert [root["id"] for root in saved["main_library_roots"]] == ["RootP"]
    with isolatedPostgres._connect(db.setup_url) as connection:
        state = connection.execute(
            "select source_generation,verified,committed_revision from ops.problematic_projection_state "
            "where library_id=%s", (db.library_id,),
        ).fetchone()
        root_state = connection.execute(
            "select id,is_active from library.library_roots where id in (%s,%s)",
            (root_ids["RootP"], root_ids["RootQ"]),
        ).fetchall()
        remaining = connection.execute(
            "select file.id,file.scan_cache_stale,root.is_active,track.id as track_id,track.track_key "
            "from library.local_track_files file join library.library_roots root on root.id=file.library_root_id "
            "join library.local_tracks track on track.id=file.track_id where track.album_id=%s",
            (album,),
        ).fetchall()
    assert {row["id"]: row["is_active"] for row in root_state} == {
        root_ids["RootP"]: True, root_ids["RootQ"]: False,
    }
    assert len(remaining) == 4 and all(row["scan_cache_stale"] is False for row in remaining)
    assert {row["id"] for row in remaining if not row["is_active"]} == set(files["RootQ"])
    assert state["source_generation"] > first_build.source_generation and state["verified"] is False
    assert str(state["committed_revision"]) == str(first_build.revision)

    browse, after_rows = _canonical_rows(db)
    physical_rows = [row for row in after_rows if row["file_private_path"] is not None]
    placeholders = [row for row in after_rows if row["file_private_path"] is None]
    assert len(after_rows) == len(remaining) == 4
    assert len(physical_rows) == len(placeholders) == 2
    assert {row["file_private_path"] for row in physical_rows} == {
        file_paths[file_id] for file_id in files["RootP"]
    }
    assert {row["track_title"] for row in physical_rows} == retained_titles
    assert {row["track_id"] for row in placeholders} == {
        row["track_id"] for row in remaining if not row["is_active"]
    }
    assert {row["track_key"] for row in placeholders} == {
        row["track_key"] for row in remaining if not row["is_active"]
    }
    assert all(row["album_id"] == album and row["file_library_root_id"] is None
               and row["file_library_root_category"] is None and row["file_entry"] is None
               for row in placeholders)
    assert not _duplicate_sources_from_rows(after_rows)["root-fence-owned"]["has_duplicate_files"]
    expected = _topology_unit_main_records(after_rows)[identity]
    assert expected["summary"]["track_count"] == 2
    assert expected["summary"].get("inventory_status") != "missing"
    assert "Duplicate files" not in expected["summary"]["problem_reasons"]
    assert "Album not found" not in expected["summary"]["problem_reasons"]
    assert inactive_title not in expected["document"]
    worker, claim, build, _now = _main_search_claimed_v2(db)
    assert build.source_generation == state["source_generation"]
    assert build.revision != first_build.revision
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    _assert_published_matches_main(db, build, browse, after_rows)
    page = reader.read_page(library_id=db.library_id, limit=200)
    assert len(page.items) == 1
    actual = page.items[0]
    assert actual["projection_id"] == identity and actual["track_count"] == 2
    assert "track_paths" not in actual
    assert actual.get("root_provenance") == expected["summary"].get("root_provenance")
    assert actual["problem_reasons"] == expected["summary"]["problem_reasons"]
    assert actual.get("inventory_status") != "missing"
    assert "search_text" not in actual
    inactive_page = reader.read_page(library_id=db.library_id, limit=200, query=inactive_title)
    assert inactive_page.total == 0 and inactive_page.items == ()
    for title in retained_titles:
        retained_page = reader.read_page(library_id=db.library_id, limit=200, query=title)
        assert retained_page.total == 1
        assert [item["projection_id"] for item in retained_page.items] == [identity]
    detail = browse.build_problematic_file_detail_payload(projection_id=identity)
    assert detail is not None and len(detail["tracks"]) == 2
    assert {track["title"] for track in detail["tracks"]} == retained_titles
    assert detail["problem_reasons"] == expected["detail"]["problem_reasons"]
    assert detail.get("duplicate_sources", []) == expected["detail"].get("duplicate_sources", []) == []
    assert inactive_title not in json.dumps(detail, ensure_ascii=False)


@pytest.mark.parametrize("change", ["number", "string", "array", "null"])
def test_live_topology_numeric_source_receipt_preserves_jsonb_equality(
    live_projection_database, change,
):
    from tests.py.test_problematic_topology_closure_postgres import _seed_topology_album

    db = live_projection_database
    album = _seed_topology_album(db, file_count=1)
    with isolatedPostgres._connect(db.setup_url) as connection:
        durations = connection.execute(
            "update library.local_tracks set duration_seconds=180.000::numeric(12,3) "
            "where album_id=%s returning duration_seconds::text as duration", (album,),
        ).fetchall()
    assert durations == [{"duration": "180.000"}]
    worker, claim, build, now = _main_search_claimed_v2(db)
    page = worker.load_claimed_source_page(claim=claim, build=build, limit=100, child_limit=100, now=now)
    assert len(page.chunks) == 1
    chunk = page.chunks[0]
    assert chunk.group_key == ("album", album) and len(chunk.rows) == 1 and not chunk.complete
    assert type(chunk.rows[0]["duration_seconds"]) is float and chunk.rows[0]["duration_seconds"] == 180.0
    load_sql, load_arguments = _source_call(claim, build, now, version=3)
    with isolatedPostgres._connect(db.worker_url) as connection:
        native = connection.execute(
            "select page.*,page.rows::text as exact_rows from (" + load_sql + ") page "
            "where page.group_kind is not null", load_arguments,
        ).fetchone()
        oracle = connection.execute(
            "select %s::jsonb=%s::jsonb as equal,%s::jsonb::text=%s::jsonb::text as same_text",
            (native["exact_rows"], json.dumps(chunk.rows), native["exact_rows"], json.dumps(chunk.rows)),
        ).fetchone()
    assert '"duration_seconds": 180.000' in native["exact_rows"]
    assert oracle == {"equal": True, "same_text": False}
    worker.stage_claimed_source_chunk(
        claim=claim, build=build, group_key=chunk.group_key, source_cursor=chunk.cursor,
        rows=chunk.rows, complete=chunk.complete, now=now,
    )
    before_replay = _progress(db, claim, build)
    stage_sql, _arguments = _source_call(claim, build, now, version=3, chunk=native)
    semantic_replay = _scope(claim, build) + tuple(native[key] for key in (
        "group_kind", "group_identity", "source_kind", "source_identity", "child_kind", "child_identity",
    )) + (native["exact_rows"], native["group_complete"], now, 3)
    with isolatedPostgres._connect(db.worker_url) as connection:
        assert connection.execute(stage_sql, semantic_replay).fetchone()["accepted"] is True
    worker.stage_claimed_source_chunk(
        claim=claim, build=build, group_key=chunk.group_key, source_cursor=chunk.cursor,
        rows=chunk.rows, complete=chunk.complete, now=now,
    )
    assert _progress(db, claim, build) == before_replay
    with isolatedPostgres._connect(db.setup_url) as connection:
        persisted = connection.execute(
            "select (payload->'duration_seconds')::text as duration,payload=%s::jsonb as equal "
            "from ops.problematic_projection_source_staging where job_id=%s and attempt=%s "
            "and revision=%s and group_kind='album' and group_identity=%s and child_kind='file' "
            "and child_identity=%s",
            (json.dumps(chunk.rows[0]), claim.job_id, claim.attempt, build.revision, str(album), native["child_identity"]),
        ).fetchone()
    assert persisted == {"duration": "180.0", "equal": True}
    changed = {**native, "rows": [dict(row) for row in native["rows"]]}
    changed["rows"][0]["duration_seconds"] = {
        "number": 181.0, "string": "180.0", "array": [180.0], "null": None,
    }[change]
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert connection.execute(
            "select %s::jsonb=%s::jsonb as equal", (native["exact_rows"], json.dumps(changed["rows"])),
        ).fetchone()["equal"] is False
    changed_sql, changed_arguments = _source_call(claim, build, now, version=3, chunk=changed)
    _reject(db, claim, build, changed_sql, changed_arguments, sqlstate="55000",
            message="projection source page differs from authoritative cursor")
    assert worker.validate_claimed_build(claim=claim, build=build, now=now)


@pytest.mark.parametrize("left,right,equal", [
    ('{"outer":[180.000,{"ratio":1.2300,"zero":0.000,"s":"001.00","n":null}]}',
     '{"outer":[180.0,{"n":null,"s":"001.00","zero":0,"ratio":1.23}]}', True),
    ('{"outer":[180.000,{"ratio":1.2300}]}', '{"outer":[180.0,{"ratio":1.24}]}', False),
    ('{"outer":["180.000"]}', '{"outer":["180.0"]}', False),
    ('{"outer":[1.000,null,2.00]}', '{"outer":[2,null,1]}', False),
    ('{"outer":{"value":null}}', '{"outer":{"value":"null"}}', False),
    ('{"outer":{"value":null}}', '{"outer":{}}', False),
], ids=["nested-scale-equal", "nested-number-change", "number-string-change", "array-order-change",
        "null-string-change", "absent-null-change"])
def test_live_topology_source_digest_matches_native_jsonb_semantics(
    live_projection_database, left, right, equal,
):
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        result = connection.execute(
            "select %s::jsonb=%s::jsonb as equal,"
            "ops.problematic_projection_source_digest_value(%s::jsonb)::text="
            "ops.problematic_projection_source_digest_value(%s::jsonb)::text as digest_equal,"
            "ops.problematic_projection_source_digest_value(%s::jsonb)=%s::jsonb as left_preserved,"
            "ops.problematic_projection_source_digest_value(%s::jsonb)=%s::jsonb as right_preserved",
            (left, right, left, right, left, left, right, right),
        ).fetchone()
    assert result == {"equal": equal, "digest_equal": equal, "left_preserved": True, "right_preserved": True}


def test_live_topology_source_digest_helper_permissions_are_closed(live_projection_database):
    db = live_projection_database
    signature = "ops.problematic_projection_source_digest_value(jsonb)"
    with isolatedPostgres._connect(db.setup_url) as connection:
        privilege = connection.execute(
            "select has_function_privilege(current_user,%s::regprocedure,'EXECUTE') as allowed", (signature,),
        ).fetchone()["allowed"]
        public = connection.execute(
            "select exists(select 1 from pg_proc routine cross join lateral "
            "aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) access_entry "
            "where routine.oid=%s::regprocedure and access_entry.grantee=0 "
            "and access_entry.privilege_type='EXECUTE') as allowed", (signature,),
        ).fetchone()["allowed"]
        readonly_role = "album_haven_readonly_" + isolatedPostgres._database_name(db.app_url).removeprefix("album_haven_ci_")
        readonly = connection.execute("select rolname from pg_roles where rolname=%s", (readonly_role,)).fetchone()
        if readonly is not None:
            assert connection.execute(
                "select has_function_privilege(%s,%s::regprocedure,'EXECUTE') as allowed", (readonly_role, signature),
            ).fetchone()["allowed"] is False
    assert privilege is True and public is False
    for database_url in (db.app_url, db.worker_url):
        with isolatedPostgres._connect(database_url) as connection:
            assert connection.execute(
                "select has_function_privilege(current_user,%s::regprocedure,'EXECUTE') as allowed", (signature,),
            ).fetchone()["allowed"] is False
        with pytest.raises(Exception) as denied:
            with isolatedPostgres._connect(database_url) as connection:
                connection.execute("select ops.problematic_projection_source_digest_value(%s::jsonb)", ('{"n":180.000}',))
        assert getattr(denied.value, "sqlstate", None) == "42501"
    if readonly is None:
        print("UNPROVED scoped readonly-role helper permission: fixture exposes no matching readonly role; verifier must check it.")
