"""Shared-P work ownership; returned rows never stand in for SQL rows visited."""

from collections import Counter
from datetime import datetime, timezone
import json
import os
import re

from psycopg import sql
import pytest

from music_app.jobs import problematic_projection_handlers as handlers
from music_app.services import problematic_files_projection as projection
from music_app.services.jobs.models import JobState, JobTransitionResult
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.problematic_projection_postgres import ProblematicProjectionStorageError
from tests.e2e.support import isolatedPostgres
from tests.py.test_problematic_files_projection import _topology_unit_main_records
from tests.py.test_problematic_projection_postgres import _main_search_claimed_v2, live_projection_database
from tests.py.test_problematic_topology_closure_postgres import _run_topology_worker, _state_topology_proof
from tests.py.test_problematic_topology_sql_boundaries_postgres import (
    _assert_published_matches_main,
    _canonical_rows,
)


def _bytes(value):
    return len(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8"))


def _key(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _seed_shared_parent(db, root_path, groups):
    owners = {}
    paths = {}
    with isolatedPostgres._connect(db.setup_url) as connection:
        root = connection.execute(
            "insert into library.library_roots(library_id,root_path,root_kind,is_active) "
            "values(%s,%s,'main',true) returning id", (db.library_id, str(root_path)),
        ).fetchone()["id"]
        for index in range(groups):
            key = f"shared-owner-{index:02d}"
            artist_name, album_title, edition = f"Shared Artist {index:02d}", f"Shared Album {index:02d}", f"Edition {index:02d}"
            year = 1980 + index
            metadata = {"album_artist": artist_name, "artists": [artist_name], "edition": edition,
                        "release_date": f"{year}-01-01"}
            artist = connection.execute(
                "insert into library.local_artists(library_id,artist_key,name) values(%s,%s,%s) returning id",
                (db.library_id, key, artist_name),
            ).fetchone()["id"]
            album = connection.execute(
                "insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata) "
                "values(%s,%s,%s,%s,%s,%s::jsonb) returning id",
                (db.library_id, artist, key, album_title, year, json.dumps(metadata)),
            ).fetchone()["id"]
            owners[album] = key
            paths[key] = []
            for disc in (1, 2):
                title = f"Owner {index:02d} disc {disc} unique title"
                track = connection.execute(
                    "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,"
                    "disc_number,track_number,duration_seconds) values(%s,%s,%s,%s,%s,%s,1,180) returning id",
                    (db.library_id, album, artist, f"{key}-disc-{disc}", title, disc),
                ).fetchone()["id"]
                path = str(root_path / "P" / str(disc) / f"{key}.flac")
                entry = {"path": path, "album": album_title, "album_artist": artist_name, "artist": artist_name,
                         "title": title, "year": year, "edition": edition, "release_date": metadata["release_date"],
                         "disc_number": disc, "track_number": 1, "duration_seconds": 180}
                connection.execute(
                    "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
                    "values(%s,%s,%s,%s::jsonb)",
                    (track, root, path, json.dumps({"scan_cache": {"file_entry": entry}})),
                )
                paths[key].append(path)
    return owners, paths


def _cache_snapshot(db, claim, build):
    scope = (claim.job_id, claim.attempt, build.revision)
    with isolatedPostgres._connect(db.setup_url) as connection:
        facts = connection.execute(
            "select group_kind,group_identity,fact_kind,semantic_child_identity,fact_value "
            "from ops.problematic_projection_group_facts where job_id=%s and attempt=%s and revision=%s "
            "order by group_kind,group_identity,fact_kind,semantic_child_identity", scope,
        ).fetchall()
        sources = connection.execute(
            "select group_kind,group_identity,child_kind,child_identity,payload,octet_length(payload::text) as bytes "
            "from ops.problematic_projection_source_staging where job_id=%s and attempt=%s and revision=%s "
            "and source_kind='topology_input' order by group_kind,group_identity,child_kind,child_identity", scope,
        ).fetchall()
        certificates = connection.execute(
            "select group_kind,group_identity,payload from ops.problematic_projection_source_staging "
            "where job_id=%s and attempt=%s and revision=%s and source_kind='topology_certificate' "
            "order by group_kind,group_identity", scope,
        ).fetchall()
        proof = _state_topology_proof(connection, db.library_id)
        certificate_proof = connection.execute(
            "select count(*) as count,coalesce(bit_xor(('x'||encode(sha256(convert_to("
            "payload::text,'UTF8')),'hex'))::bit(256)),0::bit(256))::text as fingerprint "
            "from ops.problematic_projection_source_staging where job_id=%s and attempt=%s and revision=%s "
            "and source_kind='topology_certificate'", scope,
        ).fetchone()
    return {"facts": facts, "sources": sources, "certificates": certificates,
            "proof": proof, "certificate_proof": certificate_proof}


def _observe_shared_work(monkeypatch, worker, owners):
    metrics = {"reductions": Counter(), "node_completions": Counter(), "reducer_rows": Counter(), "reducer_bytes": Counter(),
               "entry_rows": Counter(), "entry_bytes": Counter(), "full_payload_reads": Counter(),
               "full_payload_bytes": Counter(), "own_rows": Counter(), "own_fact_rows": Counter(),
               "candidate_reads": Counter(), "candidate_bytes": Counter(), "sql_calls": Counter(),
               "sql_returned_rows": Counter(), "sql_returned_bytes": Counter(), "descriptors": Counter(),
               "foreign_owner_rows": 0, "rank_payload_rows": 0,
               "own_offer_rows": 0, "own_offer_bytes": 0,
               "work_calls": 0, "work_bytes": 0, "work_forced": 0}

    def reducer(label, original):
        def measured(entries, key, *arguments, **kwargs):
            metrics["reductions"][(label, _key(key))] += 1

            def rows():
                for stage_id, row in entries:
                    metrics["reducer_rows"][label] += 1
                    metrics["reducer_bytes"][label] += _bytes(row)
                    yield stage_id, row

            yield from original(rows(), key, *arguments, **kwargs)
        return measured

    for name, label in (("_prepare_problematic_topology_parent_partition", "parent"),
                        ("_derive_problematic_topology_numeric_bucket", "numeric"),
                        ("_derive_problematic_topology_own_rank", "rank"),
                        ("_derive_problematic_topology_address", "address")):
        monkeypatch.setattr(handlers, name, reducer(label, getattr(handlers, name)))

    work_factory = handlers._problematic_topology_work

    def charged_work(check_stop=None):
        work = work_factory(check_stop)

        def measured(size=0, *, force=False):
            metrics["work_calls"] += 1
            metrics["work_bytes"] += size
            metrics["work_forced"] += int(force)
            return work(size, force=force)
        return measured

    monkeypatch.setattr(handlers, "_problematic_topology_work", charged_work)
    entries = worker.iter_claimed_source_group_entries

    def measured_entries(**kwargs):
        owner = kwargs["group_key"]
        with handlers._owned_topology_iterator(entries(**kwargs)) as stream:
            for stage_id, row in stream:
                metrics["entry_rows"][owner[0]] += 1
                metrics["entry_bytes"][owner[0]] += _bytes(row)
                if owner[0] == "album":
                    metrics["own_rows"][owner[1]] += 1
                    foreign = row.get("album_key") != owners[owner[1]]
                    metrics["foreign_owner_rows"] += int(foreign)
                    assert not foreign
                elif "file_private_path" in row:
                    metrics["full_payload_reads"][(owner, stage_id)] += 1
                    label = "rank" if owner[1].startswith("rank:") else owner[0]
                    metrics["rank_payload_rows"] += int(label == "rank")
                    metrics["full_payload_bytes"][label] += _bytes(row)
                yield stage_id, row

    monkeypatch.setattr(worker, "iter_claimed_source_group_entries", measured_entries)
    facts = worker.iter_claimed_group_facts

    def measured_facts(**kwargs):
        with handlers._owned_topology_iterator(facts(**kwargs)) as stream:
            for fact in stream:
                if kwargs["group_key"][0] == "album" and fact[1] == "row":
                    identity = kwargs["group_key"][1]
                    metrics["own_fact_rows"][identity] += 1
                    assert fact[2]["album_key"] == owners[identity]
                yield fact

    monkeypatch.setattr(worker, "iter_claimed_group_facts", measured_facts)
    descriptors = worker.iter_claimed_topology_descriptors

    def measured_descriptors(**kwargs):
        with handlers._owned_topology_iterator(descriptors(**kwargs)) as stream:
            for descriptor in stream:
                if kwargs["group_key"][0] == "album":
                    metrics["descriptors"][descriptor["fact_kind"]] += 1
                    assert descriptor["fact_kind"] != "topology_companion_descriptor"
                    assert "file_private_path" not in json.dumps(descriptor) and '"payload"' not in json.dumps(descriptor)
                yield descriptor

    monkeypatch.setattr(worker, "iter_claimed_topology_descriptors", measured_descriptors)
    load = worker.load_claimed_topology_node

    def measured_candidates(**kwargs):
        page = load(**kwargs)
        relation = page["expected_cursor"].get("relation")
        for row in page["rows"]:
            if "path" in row:
                assert set(row) == {"file_id", "root_id", "track_id", "path"}
                metrics["candidate_reads"][(kwargs["node_key"], relation, row["file_id"])] += 1
                metrics["candidate_bytes"][relation] += _bytes(row)
        return page

    monkeypatch.setattr(worker, "load_claimed_topology_node", measured_candidates)
    complete_node = worker.complete_claimed_topology_node

    def completed_node(**kwargs):
        value = complete_node(**kwargs)
        metrics["node_completions"][kwargs["node_key"]] += 1
        return value

    monkeypatch.setattr(worker, "complete_claimed_topology_node", completed_node)

    def database_call(original):
        def measured(connection, statement, parameters):
            value = original(connection, statement, parameters)
            function = re.search(r"ops\.([a-z_]+)\(", statement)
            label = function.group(1) if function else "other"
            metrics["sql_calls"][label] += 1
            rows = value if isinstance(value, list) else [] if value is None else [value]
            metrics["sql_returned_rows"][label] += len(rows)
            metrics["sql_returned_bytes"][label] += _bytes(rows)
            if label == "load_claimed_problematic_projection_source":
                for chunk in rows:
                    for payload in chunk.get("rows", []):
                        if "file_private_path" in payload:
                            metrics["own_offer_rows"] += 1
                            metrics["own_offer_bytes"] += _bytes(payload)
            return value
        return measured

    monkeypatch.setattr(worker, "_all", database_call(worker._all))
    monkeypatch.setattr(worker, "_one", database_call(worker._one))
    return metrics


@pytest.mark.parametrize("groups,retry", [(4, False), (8, False), (16, False), (4, True)],
                         ids=["G4", "G8", "G16", "G4-known-retry"])
def test_live_shared_numeric_parent_work_is_job_scoped(
    live_projection_database, tmp_path, monkeypatch, groups, retry,
):
    db = live_projection_database
    root_path = tmp_path / "Shared"
    owners, paths = _seed_shared_parent(db, root_path, groups)
    n = 2 * groups
    browse, canonical_rows = _canonical_rows(db)
    assert len(canonical_rows) == n and {row["album_id"] for row in canonical_rows} == set(owners)
    canonical = projection._duplicate_sources_from_rows(canonical_rows)
    assert all(not canonical[key]["has_duplicate_files"] for key in owners.values())
    expected = _topology_unit_main_records(canonical_rows)
    assert len(expected) == groups and all(record["summary"]["track_count"] == 2 for record in expected.values())
    assert all("Duplicate files" not in record["summary"]["problem_reasons"] for record in expected.values())

    worker, claim, build, _now = _main_search_claimed_v2(db)
    metrics = _observe_shared_work(monkeypatch, worker, owners)
    complete = worker.complete_claimed_source_group
    publish = worker.publish_claimed_snapshot
    first_cache = []
    published_cache = []
    interrupted = []

    def completed_owner(**kwargs):
        if not first_cache:
            first_cache.append(_cache_snapshot(db, kwargs["claim"], kwargs["build"]))
        complete(**kwargs)
        if retry and not interrupted:
            interrupted.append(True)
            raise ProblematicProjectionStorageError("shared context interrupted after real owner completion")

    def publishing(**kwargs):
        published_cache.append(_cache_snapshot(db, kwargs["claim"], kwargs["build"]))
        return publish(**kwargs)

    monkeypatch.setattr(worker, "complete_claimed_source_group", completed_owner)
    monkeypatch.setattr(worker, "publish_claimed_snapshot", publishing)
    outcome = _run_topology_worker(worker, claim)
    if retry:
        assert outcome.next_state is JobState.RETRY_WAIT
        assert outcome.reason_code == "problematic_projection_storage_unavailable"
        checkpoint = _cache_snapshot(db, claim, build)
        now = datetime.now(timezone.utc)
        jobs = PostgresJobRepository(database_url=db.worker_url)
        assert jobs.finish(claim, JobTransitionResult(JobState.RETRY_WAIT, outcome.reason_code, scheduled_at=now), now=now)
        resumed_claim = jobs.claim(worker_id="shared-parent-resume", now=now, lease_seconds=120,
                                   kinds=("problematic_files_projection",))
        assert resumed_claim is not None and resumed_claim.job_id == claim.job_id
        assert resumed_claim.attempt == claim.attempt + 1
        resumed = worker.prepare_claimed_build(claim=resumed_claim, now=now)
        assert resumed.revision == build.revision
        transferred = _cache_snapshot(db, resumed_claim, resumed)
        assert transferred == checkpoint
        claim, build = resumed_claim, resumed
        outcome = _run_topology_worker(worker, claim)
    assert outcome.next_state is JobState.SUCCEEDED

    assert len(first_cache) == len(published_cache) == 1
    cache = published_cache[0]
    facts = cache["facts"]
    address = [fact["fact_value"] for fact in facts if fact["fact_kind"] == "topology_address_result"]
    parent = os.path.normcase(str(root_path / "P"))
    wanted_addresses = {parent, os.path.normcase(str(root_path / "P" / "1")), os.path.normcase(str(root_path / "P" / "2"))}
    assert {value["key"][1] for value in address} == wanted_addresses
    assert {value["key"][1]: value["status"] for value in address} == {
        value: "MIXED" if value == parent else "EMPTY" for value in wanted_addresses
    }
    assert sum(value["member_count"] for value in address) == n
    for label, count in (("address", 3), ("parent", 1), ("numeric", groups), ("rank", groups)):
        calls = {key: value for (kind, key), value in metrics["reductions"].items() if kind == label}
        assert len(calls) == count and set(calls.values()) == {1}
    assert metrics["reducer_rows"] == {"address": 2 * n, "parent": n, "numeric": n, "rank": n}
    numeric = [fact["fact_value"] for fact in facts if fact["fact_kind"] == "topology_numeric_bucket_result"]
    ranks = [fact["fact_value"] for fact in facts if fact["fact_kind"] == "topology_own_rank_result"]
    assert len(numeric) == len(ranks) == groups
    assert {value["key"][1] for value in numeric} == set(owners.values())
    assert all(value["complete"] is True and value["collapse"] is True and value["input_count"] == 2 for value in numeric)
    for rank in ranks:
        key = rank["key"][1]
        assert rank["input_count"] == 2
        assert rank["rank"] == list(min((path.casefold(), path, key) for path in paths[key]))
    partitions = [fact for fact in facts if fact["fact_kind"] == "topology_parent_partition"]
    assert len(partitions) == n and len({fact["fact_value"]["file_id"] for fact in partitions}) == n
    assert all(fact["fact_value"]["excluded"] is False for fact in partitions)
    assert metrics["own_rows"] == metrics["own_fact_rows"] == {identity: 2 for identity in owners}
    assert metrics["own_offer_rows"] == n
    assert metrics["foreign_owner_rows"] == 0
    assert max(metrics["candidate_reads"].values()) == 1
    assert Counter(relation for _owner, relation, _file in metrics["candidate_reads"]) == {
        "default": n, "numeric_parent": n, "parent": n, "own_rank": n,
    }
    assert max(metrics["full_payload_reads"].values()) <= 2
    definitions = {(fact["group_kind"], fact["group_identity"]) for fact in facts
                   if fact["fact_kind"] == "topology_definition"}
    assert metrics["node_completions"] == {definition: 1 for definition in definitions}
    assert len(definitions) == 2 * groups + 4
    reusable = {"topology_address_result", "topology_address_member", "topology_numeric_bucket_result",
                "topology_parent_partition", "topology_parent_partition_end", "topology_own_rank_result", "topology_own_rank_end"}
    assert [fact for fact in first_cache[0]["facts"] if fact["fact_kind"] in reusable] == [
        fact for fact in facts if fact["fact_kind"] in reusable
    ]

    retained = [source for source in cache["sources"] if "file_private_path" in source["payload"]]
    rank_inputs = [source for source in retained if source["child_kind"] == "own_rank"]
    context_inputs = [source for source in retained if source["child_kind"] != "own_rank"]
    membership_counts = Counter(source["child_kind"] for source in context_inputs)
    rank_bytes = sum(_bytes(source["payload"]) for source in rank_inputs)
    context_bytes = sum(_bytes(source["payload"]) for source in context_inputs)
    assert len(rank_inputs) == metrics["rank_payload_rows"] == n
    assert metrics["full_payload_bytes"]["rank"] == rank_bytes
    assert sum(metrics["full_payload_bytes"].values()) - rank_bytes <= 2 * context_bytes
    assert sum(metrics["full_payload_reads"].values()) - n <= 2 * (3 * n)
    assert cache["proof"] == cache["certificate_proof"]
    assert cache["proof"]["count"] == len(cache["certificates"]) == 2 * groups + 3
    assert Counter(certificate["group_kind"] for certificate in cache["certificates"]) == {
        "album": groups, "topology_numeric_bucket": groups, "topology_address": 3,
    }
    identities = [fact["fact_value"] for fact in facts if fact["fact_kind"] == "topology_identity_result"]
    assert identities == []
    assert not any(certificate["group_identity"].startswith(("input:", "rank:")) for certificate in cache["certificates"])
    for table in ("source_staging", "item_staging", "group_accumulators", "group_facts", "reason_fact_staging", "search_fact_staging"):
        with isolatedPostgres._connect(db.setup_url) as connection:
            assert connection.execute(
                sql.SQL("select count(*) as count from ops.{} where job_id=%s and revision=%s").format(
                    sql.Identifier("problematic_projection_" + table)), (claim.job_id, build.revision),
            ).fetchone()["count"] == 0
    _assert_published_matches_main(db, build, browse, canonical_rows)

    print(json.dumps({"G": groups, "N": n, "retry": retry, "producer_helper_calls": None,
                      "context_memberships": dict(membership_counts), "rank_memberships": len(rank_inputs),
                      "context_payload_bytes": context_bytes, "rank_payload_bytes": rank_bytes,
                      "client_full_payload_rows": sum(metrics["full_payload_reads"].values()),
                      "client_full_payload_bytes": dict(metrics["full_payload_bytes"]),
                      "reducer_rows": dict(metrics["reducer_rows"]), "reducer_bytes": dict(metrics["reducer_bytes"]),
                      "candidate_id_path_rows": len(metrics["candidate_reads"]),
                      "candidate_id_path_bytes": dict(metrics["candidate_bytes"]),
                      "own_rows": sum(metrics["own_rows"].values()), "foreign_owner_rows": metrics["foreign_owner_rows"],
                      "own_offer_rows": metrics["own_offer_rows"], "own_offer_bytes": metrics["own_offer_bytes"],
                      "client_sql_calls": dict(metrics["sql_calls"]), "client_sql_returned_rows": dict(metrics["sql_returned_rows"]),
                      "client_sql_returned_json_bytes": dict(metrics["sql_returned_bytes"]),
                      "charged_work_bytes": metrics["work_bytes"], "charged_work_calls": metrics["work_calls"],
                      "charged_work_forced": metrics["work_forced"],
                      "sql_physical_rows_visited": None, "physical_spool_io_bytes": None,
                      "unknown_reason": "Server hydration calls, nested SQL row visits and physical spool IO require Unit4 scoped provisioning-admin instrumentation."},
                     sort_keys=True))
    # Strict approved ownership bound: identity discovery is not a free payload pass.
    assert len(context_inputs) <= 3 * n, dict(membership_counts)
