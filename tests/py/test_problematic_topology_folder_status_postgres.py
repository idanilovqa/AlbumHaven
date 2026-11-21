"""Native root-scoped physical-folder status, separate from global topology."""

from collections import defaultdict
from contextlib import closing
import json

import pytest

from music_app.services.jobs.models import JobState
from music_app.services.problematic_projection_postgres import ProblematicProjectionStorageError
from tests.e2e.support import isolatedPostgres
from tests.py.test_problematic_files_projection import _topology_unit_main_records
from tests.py.test_problematic_projection_postgres import _main_search_claimed_v2, live_projection_database
from tests.py.test_problematic_topology_closure_postgres import _run_topology_worker
from tests.py.test_problematic_topology_sql_boundaries_postgres import (
    _assert_published_matches_main,
    _canonical_rows,
)


MIXED_REASON = "Mixed album metadata in one folder"


def _seed_folder_case(db, root_path, case):
    owners = {}
    files = {}
    with isolatedPostgres._connect(db.setup_url) as connection:
        roots = [connection.execute(
            "insert into library.library_roots(library_id,root_path,root_kind,is_active) "
            "values(%s,%s,'main',true) returning id", (db.library_id, str(root_path)),
        ).fetchone()["id"]]
        if case == "cross-root":
            # Persisted-provenance boundary only; overlapping configured roots remain unsupported.
            roots.append(connection.execute(
                "insert into library.library_roots(library_id,root_path,root_kind,is_active) "
                "values(%s,%s,'main',true) returning id", (db.library_id, str(root_path / "P")),
            ).fetchone()["id"])
        for index, label in enumerate(("a", "b")):
            key, artist_name, title = f"folder-owner-{label}", f"Folder Artist {label}", f"Folder Album {label}"
            artist = connection.execute(
                "insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id",
                (db.library_id, key, artist_name),
            ).fetchone()["id"]
            album = connection.execute(
                "insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata) "
                "values(%s,%s,%s,%s,1988,%s::jsonb) returning id",
                (db.library_id, artist, key, title, json.dumps({"album_artist": artist_name})),
            ).fetchone()["id"]
            owners[album] = key
            track_key = f"folder-track-{label}"
            track = connection.execute(
                "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,track_number) "
                "values(%s,%s,%s,%s,%s,1) returning id",
                (db.library_id, album, artist, track_key, f"Folder track {label}"),
            ).fetchone()["id"]
            path = str(root_path / "P" / "Album" / f"{label}.flac")
            entry = {"path": path, "album": title, "album_artist": artist_name, "artist": artist_name,
                     "title": f"Folder track {label}", "year": 1988, "disc_number": 1,
                     "track_number": 1, "duration_seconds": 180}
            if case == "excluded-member" and label == "b":
                entry["exception_type"] = "Non-album rarity"
            files[label] = connection.execute(
                "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
                "values(%s,%s,%s,%s::jsonb) returning id,library_root_id,scan_physical_parent",
                (track, roots[index] if case == "cross-root" else roots[0], path,
                 json.dumps({"scan_cache": {"file_entry": entry}})),
            ).fetchone()
            files[label]["track_key"] = track_key
            if case == "excluded-member" and label == "b":
                connection.execute(
                    "insert into library.exception_overrides(library_id,track_key,override_payload) "
                    "values(%s,%s,%s::jsonb)",
                    (db.library_id, path, json.dumps({"exception_type": "Non-album rarity"})),
                )
        source = connection.execute(
            "select file.id,root.id as root_id,root.is_active,file.scan_cache_stale "
            "from ops.problematic_projection_source_rows source "
            "join library.local_track_files file on file.id=source.child_identity::bigint "
            "join library.library_roots root on root.id=file.library_root_id "
            "where source.library_id=%s and source.group_kind='album' and file.id in (%s,%s)",
            (db.library_id, files["a"]["id"], files["b"]["id"]),
        ).fetchall()
        expected = connection.execute(
            "select file.library_root_id as root_id,file.scan_physical_parent as physical_parent,"
            "count(*) as input_count,count(distinct track.album_id)>1 as mixed "
            "from library.local_track_files file join library.local_tracks track on track.id=file.track_id "
            "join library.library_roots root on root.id=file.library_root_id and root.library_id=track.library_id "
            "where track.library_id=%s and root.is_active and file.scan_cache_stale is false "
            "group by file.library_root_id,file.scan_physical_parent order by file.library_root_id",
            (db.library_id,),
        ).fetchall()
    assert len(source) == 2 and all(row["is_active"] and not row["scan_cache_stale"] for row in source)
    assert {row["id"] for row in source} == {value["id"] for value in files.values()}
    assert files["a"]["scan_physical_parent"] == files["b"]["scan_physical_parent"]
    assert len({row["root_id"] for row in source}) == (2 if case == "cross-root" else 1)
    assert [row["mixed"] for row in expected] == ([False, False] if case == "cross-root" else [True])
    return owners, files, expected


def _folder_facts(db, claim, build, node_key=None):
    with isolatedPostgres._connect(db.setup_url) as connection:
        return connection.execute(
            "select * from ops.problematic_projection_group_facts "
            "where job_id=%s and attempt=%s and revision=%s and projection_id='topology' "
            "and fact_kind='topology_folder_status' and (%s::text is null or (group_kind=%s and group_identity=%s)) "
            "order by group_kind,group_identity,semantic_child_identity",
            (claim.job_id, claim.attempt, build.revision,
             node_key[0] if node_key else None, node_key[0] if node_key else None, node_key[1] if node_key else None),
        ).fetchall()


def _assert_folder_facts(db, facts, expected):
    actual = [{key: fact["fact_value"][key] for key in ("root_id", "physical_parent", "input_count", "mixed")}
              for fact in facts]
    assert sorted(actual, key=lambda row: row["root_id"]) == expected
    with isolatedPostgres._connect(db.setup_url) as connection:
        for fact in facts:
            value = fact["fact_value"]
            identity = connection.execute(
                "select encode(sha256(convert_to(jsonb_build_array(%s::bigint,%s::text)::text,'UTF8')),'hex') as value",
                (value["root_id"], value["physical_parent"]),
            ).fetchone()["value"]
            assert fact["group_kind"] == "topology_address"
            assert fact["semantic_child_identity"] == identity


@pytest.mark.parametrize("case", ["same-root", "cross-root", "excluded-member"])
def test_live_topology_folder_status_matches_canonical_root_scope(
    live_projection_database, tmp_path, monkeypatch, case,
):
    db = live_projection_database
    owners, files, expected_folders = _seed_folder_case(db, tmp_path / "FolderStatus", case)
    browse, canonical_rows = _canonical_rows(db)
    canonical = {row["track_key"]: row for row in canonical_rows if row["file_private_path"] is not None}
    assert set(canonical) == {value["track_key"] for value in files.values()}
    for label, file in files.items():
        row = canonical[file["track_key"]]
        assert row["file_library_root_id"] == file["library_root_id"]
        assert row["file_mixed_album_folder"] is (case != "cross-root")
        if case == "excluded-member" and label == "b":
            assert row["exception_type"] == "Non-album rarity"
    expected_items = _topology_unit_main_records(canonical_rows)
    own_a = next(record for record in expected_items.values() if record["summary"]["key"] == "folder-owner-a")
    assert (MIXED_REASON in own_a["summary"]["problem_reasons"]) is (case != "cross-root")
    worker, claim, build, _now = _main_search_claimed_v2(db)
    complete = worker.complete_claimed_topology_node
    publish = worker.publish_claimed_snapshot
    descriptors = worker.iter_claimed_topology_descriptors
    completed = []
    published = []
    seen = defaultdict(set)

    def complete_with_folders(**kwargs):
        if kwargs["node_key"][0] == "topology_address" and not kwargs["node_key"][1].startswith("rank:"):
            facts = _folder_facts(db, kwargs["claim"], kwargs["build"], kwargs["node_key"])
            _assert_folder_facts(db, facts, expected_folders)
            with isolatedPostgres._connect(db.setup_url) as connection:
                result = connection.execute(
                    "select fact_value from ops.problematic_projection_group_facts "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
                    "and projection_id='topology' and fact_kind='topology_address_result' and semantic_child_identity='result'",
                    (claim.job_id, kwargs["claim"].attempt, build.revision, *kwargs["node_key"]),
                ).fetchone()["fact_value"]
            assert result["status"] == ("CLEAN" if case == "excluded-member" else "MIXED")
            assert result["member_count"] == (1 if case == "excluded-member" else 2)
            completed.append(True)
        return complete(**kwargs)

    def capture_descriptors(**kwargs):
        with closing(descriptors(**kwargs)) as stream:
            for descriptor in stream:
                if kwargs["group_key"][0] == "album" and descriptor["fact_kind"] == "topology_folder_descriptor":
                    value = descriptor["fact_value"]
                    seen[owners[kwargs["group_key"][1]]].add((value["root_id"], value["physical_parent"], value["mixed"]))
                yield descriptor

    def publish_with_folders(**kwargs):
        facts = _folder_facts(db, kwargs["claim"], kwargs["build"])
        _assert_folder_facts(db, facts, expected_folders)
        with isolatedPostgres._connect(db.setup_url) as connection:
            inputs = connection.execute(
                "select child_kind from ops.problematic_projection_source_staging "
                "where job_id=%s and attempt=%s and revision=%s and source_kind='topology_input' "
                "and payload ? 'file_private_path'", (claim.job_id, claim.attempt, build.revision),
            ).fetchall()
        assert sum(row["child_kind"] != "own_rank" for row in inputs) <= 3 * len(files)
        assert sum(row["child_kind"] == "own_rank" for row in inputs) <= len(files)
        published.append(True)
        return publish(**kwargs)

    monkeypatch.setattr(worker, "complete_claimed_topology_node", complete_with_folders)
    monkeypatch.setattr(worker, "iter_claimed_topology_descriptors", capture_descriptors)
    monkeypatch.setattr(worker, "publish_claimed_snapshot", publish_with_folders)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert completed == published == [True]
    a = files["a"]
    assert (a["library_root_id"], a["scan_physical_parent"], case != "cross-root") in seen["folder-owner-a"]
    _assert_published_matches_main(db, build, browse, canonical_rows)


@pytest.mark.parametrize("damage", ["drop", "root", "parent", "count", "mixed"])
def test_live_topology_unsealed_folder_corruption_blocks_worker_publication(
    live_projection_database, tmp_path, monkeypatch, damage,
):
    db = live_projection_database
    _owners, _files, expected_folders = _seed_folder_case(db, tmp_path / "FolderCorruption", "same-root")
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_headers where library_id=%s", (db.library_id,),
        ).fetchone()["count"] == 0
    worker, claim, build, _now = _main_search_claimed_v2(db)
    complete = worker.complete_claimed_topology_node
    publish = worker.publish_claimed_snapshot
    changed = []
    rejected = []
    published = []

    def corrupt_before_seal(**kwargs):
        kind, identity = kwargs["node_key"]
        if kind != "topology_address" or identity.startswith("rank:"):
            return complete(**kwargs)
        assert not changed
        facts = _folder_facts(db, kwargs["claim"], kwargs["build"], kwargs["node_key"])
        _assert_folder_facts(db, facts, expected_folders)
        assert len(facts) == 1 and facts[0]["fact_value"]["mixed"] is True
        fact = facts[0]
        scope = (claim.job_id, claim.attempt, build.revision, kind, identity)
        with isolatedPostgres._connect(db.setup_url) as connection:
            assert connection.execute(
                "select count(*) as count from ops.problematic_projection_source_staging "
                "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
                "and source_kind='topology_certificate'", scope,
            ).fetchone()["count"] == 0
            if damage == "drop":
                mutated = connection.execute(
                    "delete from ops.problematic_projection_group_facts where job_id=%s and attempt=%s "
                    "and revision=%s and group_kind=%s and group_identity=%s and projection_id='topology' "
                    "and fact_kind='topology_folder_status' and semantic_child_identity=%s "
                    "returning semantic_child_identity", scope + (fact["semantic_child_identity"],),
                ).fetchall()
            else:
                value = dict(fact["fact_value"])
                field, replacement = {
                    "root": ("root_id", value["root_id"] + 100000),
                    "parent": ("physical_parent", value["physical_parent"] + "/wrong"),
                    "count": ("input_count", value["input_count"] + 1),
                    "mixed": ("mixed", False),
                }[damage]
                assert value[field] != replacement
                value[field] = replacement
                mutated = connection.execute(
                    "update ops.problematic_projection_group_facts set fact_value=%s::jsonb "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
                    "and projection_id='topology' and fact_kind='topology_folder_status' "
                    "and semantic_child_identity=%s returning semantic_child_identity",
                    (json.dumps(value),) + scope + (fact["semantic_child_identity"],),
                ).fetchall()
        assert mutated == [{"semantic_child_identity": fact["semantic_child_identity"]}]
        actual = _folder_facts(db, kwargs["claim"], kwargs["build"], kwargs["node_key"])
        if damage == "drop":
            assert actual == []
        else:
            assert len(actual) == 1 and actual[0]["fact_value"] == value
            assert actual[0]["fact_value"] != fact["fact_value"]
        changed.append(True)
        try:
            complete(**kwargs)
        except ProblematicProjectionStorageError as error:
            native = error
            while native is not None and getattr(native, "sqlstate", None) is None:
                native = native.__cause__
            assert native is not None and native.sqlstate == "55000"
            assert native.diag.message_primary == "topology physical folder stream is incomplete"
            rejected.append(True)
            raise
        pytest.fail("A real unsealed folder mutation unexpectedly completed")

    def observe_publication(**kwargs):
        published.append(True)
        return publish(**kwargs)

    monkeypatch.setattr(worker, "complete_claimed_topology_node", corrupt_before_seal)
    monkeypatch.setattr(worker, "publish_claimed_snapshot", observe_publication)
    result = _run_topology_worker(worker, claim)
    assert result.next_state is JobState.RETRY_WAIT
    assert result.reason_code == "problematic_projection_storage_unavailable"
    assert changed == rejected == [True] and published == []
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_headers where library_id=%s", (db.library_id,),
        ).fetchone()["count"] == 0
        state = connection.execute(
            "select verified,committed_revision from ops.problematic_projection_state where library_id=%s",
            (db.library_id,),
        ).fetchone()
    assert state["verified"] is False and state["committed_revision"] is None


def test_live_topology_folder_string_boolean_checkpoint_cannot_seal(
    live_projection_database, tmp_path, monkeypatch,
):
    db = live_projection_database
    _seed_folder_case(db, tmp_path / "FolderJsonType", "same-root")
    worker, claim, build, _now = _main_search_claimed_v2(db)
    checkpoint = worker.checkpoint_claimed_group_facts
    complete = worker.complete_claimed_topology_node
    publish = worker.publish_claimed_snapshot
    submitted = []
    rejected = []
    published = []

    def checkpoint_string_boolean(**kwargs):
        entries = []
        altered = False
        for stage_id, kind, value in kwargs["entries"]:
            if kind == "topology_folder_status":
                assert not submitted and value["mixed"] is True
                value = {**value, "mixed": "true"}
                altered = True
            entries.append((stage_id, kind, value))
        if not altered:
            return checkpoint(**kwargs)
        assert kwargs["group_key"][0] == "topology_address"
        with isolatedPostgres._connect(db.setup_url) as connection:
            assert connection.execute(
                "select count(*) as count from ops.problematic_projection_source_staging "
                "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
                "and source_kind='topology_certificate'",
                (claim.job_id, claim.attempt, build.revision, *kwargs["group_key"]),
            ).fetchone()["count"] == 0
        result = checkpoint(**{**kwargs, "entries": tuple(entries)})
        facts = _folder_facts(db, claim, build, kwargs["group_key"])
        assert len(facts) == 1 and facts[0]["fact_value"]["mixed"] == "true"
        with isolatedPostgres._connect(db.setup_url) as connection:
            assert connection.execute(
                "select jsonb_typeof(fact_value->'mixed') as type "
                "from ops.problematic_projection_group_facts where job_id=%s and attempt=%s and revision=%s "
                "and group_kind=%s and group_identity=%s and projection_id='topology' "
                "and fact_kind='topology_folder_status'",
                (claim.job_id, claim.attempt, build.revision, *kwargs["group_key"]),
            ).fetchone()["type"] == "string"
        submitted.append(kwargs["group_key"])
        return result

    def reject_at_seal(**kwargs):
        if kwargs["node_key"][0] != "topology_address" or kwargs["node_key"][1].startswith("rank:"):
            return complete(**kwargs)
        assert submitted == [kwargs["node_key"]]
        try:
            complete(**kwargs)
        except ProblematicProjectionStorageError as error:
            native = error
            while native is not None and getattr(native, "sqlstate", None) is None:
                native = native.__cause__
            assert native is not None and native.sqlstate == "55000"
            assert native.diag.message_primary == "topology physical folder stream is incomplete"
            rejected.append(True)
            raise
        pytest.fail("A JSON string boolean submitted through a real checkpoint unexpectedly sealed")

    def observe_publication(**kwargs):
        published.append(True)
        return publish(**kwargs)

    monkeypatch.setattr(worker, "checkpoint_claimed_group_facts", checkpoint_string_boolean)
    monkeypatch.setattr(worker, "complete_claimed_topology_node", reject_at_seal)
    monkeypatch.setattr(worker, "publish_claimed_snapshot", observe_publication)
    result = _run_topology_worker(worker, claim)
    assert result.next_state is JobState.RETRY_WAIT
    assert result.reason_code == "problematic_projection_storage_unavailable"
    assert len(submitted) == 1 and rejected == [True] and published == []
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_headers where library_id=%s", (db.library_id,),
        ).fetchone()["count"] == 0
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_source_staging "
            "where job_id=%s and attempt=%s and revision=%s and group_kind=%s and group_identity=%s "
            "and source_kind='topology_certificate'",
            (claim.job_id, claim.attempt, build.revision, *submitted[0]),
        ).fetchone()["count"] == 0


@pytest.mark.parametrize("groups", [4, 8, 16], ids=["G4", "G8", "G16"])
def test_live_topology_distinct_folder_descriptors_are_owner_bounded(
    live_projection_database, tmp_path, monkeypatch, groups,
):
    import os
    from music_app.services.library import _contextual_album_containers

    db = live_projection_database
    root_path = tmp_path / "FolderFanout"
    parent = os.path.normcase(str(root_path / "P"))
    owners = {}
    needed = defaultdict(set)
    with isolatedPostgres._connect(db.setup_url) as connection:
        root = connection.execute(
            "insert into library.library_roots(library_id,root_path,root_kind,is_active) "
            "values(%s,%s,'main',true) returning id", (db.library_id, str(root_path)),
        ).fetchone()["id"]
        for index in range(groups):
            key, artist_name, title = f"fanout-owner-{index:02d}", f"Fanout Artist {index:02d}", f"Fanout Album {index:02d}"
            year, edition = 1980 + index, f"Edition {index:02d}"
            artist = connection.execute(
                "insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id",
                (db.library_id, key, artist_name),
            ).fetchone()["id"]
            album = connection.execute(
                "insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata) "
                "values(%s,%s,%s,%s,%s,%s::jsonb) returning id",
                (db.library_id, artist, key, title, year,
                 json.dumps({"album_artist": artist_name, "edition": edition, "release_date": f"{year}-01-01"})),
            ).fetchone()["id"]
            owners[album] = key
            for ordinal in (2 * index + 1, 2 * index + 2):
                track_title = f"Fanout owner {index:02d} ordinal {ordinal}"
                track = connection.execute(
                    "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,disc_number,track_number) "
                    "values(%s,%s,%s,%s,%s,%s,1) returning id",
                    (db.library_id, album, artist, f"{key}-{ordinal}", track_title, ordinal),
                ).fetchone()["id"]
                path = str(root_path / "P" / str(ordinal) / f"{key}.flac")
                entry = {"path": path, "album": title, "album_artist": artist_name, "artist": artist_name,
                         "title": track_title, "year": year, "edition": edition, "release_date": f"{year}-01-01",
                         "disc_number": ordinal, "track_number": 1, "duration_seconds": 180}
                row = connection.execute(
                    "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
                    "values(%s,%s,%s,%s::jsonb) returning library_root_id,scan_physical_parent",
                    (track, root, path, json.dumps({"scan_cache": {"file_entry": entry}})),
                ).fetchone()
                needed[album].add((row["library_root_id"], row["scan_physical_parent"]))
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_source_rows source "
            "join library.local_track_files file on file.id=source.child_identity::bigint "
            "join library.library_roots root on root.id=file.library_root_id "
            "where source.library_id=%s and source.group_kind='album' and root.is_active "
            "and file.scan_cache_stale is false", (db.library_id,),
        ).fetchone()["count"] == 2 * groups
    assert all(len(keys) == 2 for keys in needed.values())
    assert len(set().union(*needed.values())) == 2 * groups
    browse, canonical_rows = _canonical_rows(db)
    assert len(canonical_rows) == 2 * groups
    assert all(row["file_mixed_album_folder"] is False for row in canonical_rows)
    for album in owners:
        own = [row for row in canonical_rows if row["album_id"] == album]
        assert len(own) == 2
        containers = _contextual_album_containers([
            (row["file_private_path"], row["file_entry"]["disc_number"],
             row["file_entry"]["album"], row["file_entry"].get("edition")) for row in own
        ])
        assert {os.path.normcase(value) for value in containers} == {parent}
    expected = _topology_unit_main_records(canonical_rows)
    assert len(expected) == groups
    assert all(record["summary"]["track_count"] == 2 and MIXED_REASON not in record["summary"]["problem_reasons"]
               and "Duplicate files" not in record["summary"]["problem_reasons"] for record in expected.values())
    worker, claim, build, _now = _main_search_claimed_v2(db)
    descriptors = worker.iter_claimed_topology_descriptors
    complete = worker.complete_claimed_source_group
    publish = worker.publish_claimed_snapshot
    deliveries = defaultdict(list)
    references = []
    published = []

    def bounded_descriptors(**kwargs):
        with closing(descriptors(**kwargs)) as stream:
            for descriptor in stream:
                if kwargs["group_key"][0] == "album" and descriptor["fact_kind"] == "topology_folder_descriptor":
                    album = kwargs["group_key"][1]
                    value = descriptor["fact_value"]
                    folder = (value["root_id"], value["physical_parent"])
                    assert folder in needed[album]
                    assert value["mixed"] is False and value["input_count"] == 1
                    deliveries[album].append(folder)
                yield descriptor

    def complete_with_own_references(**kwargs):
        album = kwargs["group_key"][1]
        with isolatedPostgres._connect(db.setup_url) as connection:
            facts = connection.execute(
                "select reference.semantic_child_identity,reference.fact_value,reference.stage_id,source.payload "
                "from ops.problematic_projection_group_facts reference "
                "join ops.problematic_projection_source_staging source on source.stage_id=reference.stage_id "
                "and source.job_id=reference.job_id and source.attempt=reference.attempt and source.revision=reference.revision "
                "and source.group_kind=reference.group_kind and source.group_identity=reference.group_identity "
                "where reference.job_id=%s and reference.attempt=%s and reference.revision=%s "
                "and reference.group_kind='album' and reference.group_identity=%s "
                "and reference.projection_id='topology' and reference.fact_kind='topology_folder_reference'",
                (claim.job_id, claim.attempt, build.revision, str(album)),
            ).fetchall()
            assert len(facts) == 2
            assert {(fact["fact_value"]["root_id"], fact["fact_value"]["physical_parent"]) for fact in facts} == needed[album]
            for fact in facts:
                value, payload = fact["fact_value"], fact["payload"]
                assert set(value) == {"root_id", "physical_parent"}
                assert fact["stage_id"] > 0 and payload["album_key"] == owners[album]
                assert value == {"root_id": payload["file_library_root_id"], "physical_parent": payload["file_physical_parent"]}
                assert connection.execute(
                    "select encode(sha256(convert_to(jsonb_build_array(%s::bigint,%s::text)::text,'UTF8')),'hex') as value",
                    (value["root_id"], value["physical_parent"]),
                ).fetchone()["value"] == fact["semantic_child_identity"]
        references.append(album)
        return complete(**kwargs)

    def publish_bounded_context(**kwargs):
        with isolatedPostgres._connect(db.setup_url) as connection:
            results = connection.execute(
                "select fact_value from ops.problematic_projection_group_facts "
                "where job_id=%s and attempt=%s and revision=%s and fact_kind='topology_address_result' "
                "and fact_value->'key'->>1=%s", (claim.job_id, claim.attempt, build.revision, parent),
            ).fetchall()
            assert len(results) == 1 and results[0]["fact_value"]["status"] == "MIXED"
            assert results[0]["fact_value"]["member_count"] == 2 * groups
            inputs = connection.execute(
                "select child_kind from ops.problematic_projection_source_staging "
                "where job_id=%s and attempt=%s and revision=%s and source_kind='topology_input' "
                "and payload ? 'file_private_path'", (claim.job_id, claim.attempt, build.revision),
            ).fetchall()
        assert sum(row["child_kind"] != "own_rank" for row in inputs) <= 3 * (2 * groups)
        assert sum(row["child_kind"] == "own_rank" for row in inputs) == 2 * groups
        published.append(True)
        return publish(**kwargs)

    monkeypatch.setattr(worker, "iter_claimed_topology_descriptors", bounded_descriptors)
    monkeypatch.setattr(worker, "complete_claimed_source_group", complete_with_own_references)
    monkeypatch.setattr(worker, "publish_claimed_snapshot", publish_bounded_context)
    assert _run_topology_worker(worker, claim).next_state is JobState.SUCCEEDED
    assert set(references) == set(deliveries) == set(owners) and len(references) == groups
    assert published == [True]
    for album in owners:
        assert set(deliveries[album]) == needed[album]
        assert len(deliveries[album]) <= 4
    _assert_published_matches_main(db, build, browse, canonical_rows)
