"""Closure corruption through the normal isolated projection worker owners."""

import json
import threading
from datetime import datetime, timezone

import pytest

from music_app.jobs.problematic_projection_handlers import build_problematic_projection_handler
from music_app.jobs.dispatch import JobHandlerRegistry
from music_app.jobs.worker import ExecutionContext, Worker
from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import JobState
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.problematic_files_projection import project_problematic_files
from music_app.services.problematic_projection_postgres import (
    ProblematicProjectionIntegrityError,
    PostgresProblematicProjectionRepository,
    ProblematicProjectionStorageError,
)
from tests.e2e.support import isolatedPostgres
from tests.py.test_problematic_projection_postgres import (
    _main_search_claimed_v2,
    live_projection_database,
)


def _seed_topology_album(db, *, file_count):
    with isolatedPostgres._connect(db.setup_url) as connection:
        root = connection.execute(
            "insert into library.library_roots(library_id,root_path,root_kind,is_active) "
            "values(%s,'C:/topology-closure','main',true) returning id", (db.library_id,),
        ).fetchone()["id"]
        artist = connection.execute(
            "insert into library.local_artists(library_id,artist_key,name) "
            "values(%s,'topology-closure-artist','Topology Closure Artist') returning id",
            (db.library_id,),
        ).fetchone()["id"]
        album = connection.execute(
            "insert into library.local_albums(library_id,artist_id,album_key,title,release_year,metadata) "
            "values(%s,%s,'topology-closure-album','Topology Closure Album',1988,%s::jsonb) returning id",
            (db.library_id, artist, json.dumps({"album_artist": "Topology Closure Artist"})),
        ).fetchone()["id"]
        for number in range(1, file_count + 1):
            title = f"Closure track {number}"
            track = connection.execute(
                "insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,track_number) "
                "values(%s,%s,%s,%s,%s,%s) returning id",
                (db.library_id, album, artist, f"topology-closure-track-{number}", title, number),
            ).fetchone()["id"]
            path = f"C:/topology-closure/Album/{number:03d}.flac"
            connection.execute(
                "insert into library.local_track_files(track_id,library_root_id,private_path,metadata) "
                "values(%s,%s,%s,%s::jsonb)",
                (track, root, path, json.dumps({"scan_cache": {"file_entry": {
                    "path": path, "album": "Topology Closure Album", "album_artist": "Topology Closure Artist",
                    "artist": "Topology Closure Artist", "title": title, "year": 1988,
                    "track_number": number, "disc_number": 1, "duration_seconds": 180,
                }}})),
            )
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_source_rows source "
            "join library.local_track_files file on file.id=source.child_identity::bigint "
            "join library.library_roots root on root.id=file.library_root_id "
            "where source.library_id=%s and source.group_kind='album' and source.group_identity=%s "
            "and root.id=%s and root.is_active and file.scan_cache_stale is false",
            (db.library_id, str(album), root),
        ).fetchone()["count"] == file_count > 0
    return album


def _run_topology_worker(worker, claim):
    class Authorization:
        @staticmethod
        def authorize(_claim, _now):
            return AuthorizationDecision(True, "problematic_projection_scope_current")

    authorization = Authorization()
    clock = lambda: datetime.now(timezone.utc)
    context = ExecutionContext(claim, authorization_service=authorization, clock=clock)
    owner = Worker(
        repository=PostgresJobRepository(database_url=worker._database_url),
        authorization_service=authorization, handlers=JobHandlerRegistry(),
        lease_seconds=120, heartbeat_seconds=30, poll_seconds=1,
        max_idle_backoff_seconds=1, drain_seconds=1, clock=clock,
    )
    stop = threading.Event()
    heartbeat = threading.Thread(
        target=owner._heartbeat_job, args=(claim, context, stop),
        name=f"album-haven-test-job-heartbeat-{claim.job_id}", daemon=True,
    )
    heartbeat.start()
    try:
        return build_problematic_projection_handler(
            repository=worker, project_group=project_problematic_files,
        )(claim, context)
    finally:
        stop.set()
        heartbeat.join()
        assert not heartbeat.is_alive()
        owner.close()


def _state_topology_proof(connection, library_id):
    return connection.execute(
        "select to_jsonb(state)->'topology_completed_group_count' as count,"
        "to_jsonb(state)->'topology_completed_group_fingerprint' as fingerprint "
        "from ops.problematic_projection_state state where library_id=%s", (library_id,),
    ).fetchone()


@pytest.mark.parametrize(
    ("interruption", "reason_code"),
    [("cancel", "problematic_projection_canceled"),
     ("lease-lost", "problematic_projection_lease_lost")],
    ids=["cancel", "lease-lost"],
)
def test_live_topology_signature_stop_closes_resources_without_publication(
    live_projection_database, monkeypatch, interruption, reason_code,
):
    from music_app.services import problematic_files_projection as projection
    from music_app.services.library import _normalized_duplicate_card_text
    from tests.py.test_problematic_files_projection import (
        _persist_semantic_facts, _topology_unit_row, _tracked_projection_spools,
    )
    from tests.py.test_problematic_topology_derived_identity import _seed_native_overlap
    from tests.py.test_problematic_topology_sql_boundaries_postgres import _canonical_rows

    db = live_projection_database
    expanded_title = "\ufdfa" * 2000
    assert len(expanded_title.encode("utf-8")) < projection._MAX_REDUCER_FACT_BYTES
    assert len(_normalized_duplicate_card_text(expanded_title).encode("utf-8")) > projection._MAX_REDUCER_FACT_BYTES
    rows = []
    for folder, album in (("P", "Café"), ("Q", "Cafe")):
        for number, title in ((1, expanded_title), (2, "Closing")):
            row = _topology_unit_row(
                f"C:/TopologyDerived/{folder}/{number}.flac", len(rows) + 1,
                original_key="a-owner", title=album, number=number,
            )
            row["track_title"] = row["file_entry"]["title"] = title
            rows.append(row)
    album_id = _seed_native_overlap(db, rows)
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert len(connection.execute(
            "update library.local_tracks set duration_seconds=180,disc_number=1 "
            "where library_id=%s and album_id=%s returning id", (db.library_id, album_id),
        ).fetchall()) == 4
    _browse, persisted_rows = _canonical_rows(db)
    assert len(persisted_rows) == 4
    assert all(row["duration_seconds"] == 180 for row in persisted_rows)
    canonical = projection._duplicate_sources_from_rows(persisted_rows)["a-owner"]
    assert canonical["has_duplicate_files"] is True
    assert len(canonical["duplicate_sources"]) == 2
    assert all(len(source["tracks"]) == 2 for source in canonical["duplicate_sources"])
    worker, claim, build, _now = _main_search_claimed_v2(db)
    page = worker.load_claimed_source_page(
        claim=claim, build=build, limit=100, child_limit=100, now=_now,
    )
    source_rows = [row for chunk in page.chunks for row in chunk.rows]
    assert len(source_rows) == 4
    identities = {(row["file_private_path"], row["track_key"]) for row in source_rows}
    assert len(identities) == 4
    assert identities == {(row["file_private_path"], row["track_key"]) for row in persisted_rows}
    assert worker.load_claimed_source_page(
        claim=claim, build=build, limit=100, child_limit=100, now=_now,
    ) == page
    facts = _persist_semantic_facts(projection.ProblematicGroupAccumulator(), enumerate(source_rows, 1))
    assert max(len(json.dumps(value, ensure_ascii=True).encode("utf-8"))
               for _stage, _kind, value in facts) <= projection._MAX_REDUCER_FACT_BYTES

    contexts, signatures, binary_spools, interrupted, cleanup = [], set(), [], [], []
    real_context = ExecutionContext
    real_write = projection._ProblematicSignatureStore.write_refs
    real_compare = projection._ProblematicSignatureStore.compare
    real_cleanup = worker.cancel_claimed_build
    _projection, spools = _tracked_projection_spools(monkeypatch)

    def capture_context(*args, **kwargs):
        context = real_context(*args, **kwargs)
        contexts.append(context)
        return context

    def record_signature(store, tokens):
        reference = real_write(store, tokens)
        signatures.add((id(store), reference["offset"], reference["length"]))
        binary_spools.append(store._file)
        return reference

    def interrupt_comparison(store, left, right):
        if not interrupted and left["offset"] != right["offset"] and all(
            (id(store), reference["offset"], reference["length"]) in signatures
            for reference in (left, right)
        ):
            assert len(contexts) == 1
            assert min(left["length"], right["length"]) > projection._MAX_REDUCER_FACT_BYTES
            interrupted.append(True)
            if interruption == "cancel":
                contexts[0].request_cancellation()
            else:
                with isolatedPostgres._connect(db.setup_url) as connection:
                    expired = connection.execute(
                        "update ops.jobs set lease_expires_at=clock_timestamp()-interval '1 second' "
                        "where id=%s and attempt_count=%s and lease_token=%s returning id",
                        (claim.job_id, claim.attempt, claim.lease_token),
                    ).fetchone()
                    assert expired == {"id": claim.job_id}
                contexts[0].mark_lease_lost()
        return real_compare(store, left, right)

    def record_cleanup(**kwargs):
        cleanup.append(kwargs["reason_code"])
        return real_cleanup(**kwargs)

    monkeypatch.setattr(f"{__name__}.ExecutionContext", capture_context)
    monkeypatch.setattr(projection._ProblematicSignatureStore, "write_refs", record_signature)
    monkeypatch.setattr(projection._ProblematicSignatureStore, "compare", interrupt_comparison)
    monkeypatch.setattr(worker, "cancel_claimed_build", record_cleanup)
    result = _run_topology_worker(worker, claim)

    assert interrupted == [True]
    assert result.next_state is JobState.CANCELED
    assert result.reason_code == reason_code
    assert spools and all(spool.closed for spool in spools)
    assert binary_spools and all(spool.closed for spool in binary_spools)
    assert cleanup == ([reason_code] if interruption == "cancel" else [])
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert connection.execute(
            "select committed_revision from ops.problematic_projection_state where library_id=%s",
            (db.library_id,),
        ).fetchone() == {"committed_revision": None}
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_headers where library_id=%s",
            (db.library_id,),
        ).fetchone() == {"count": 0}
        scope = (claim.job_id, claim.attempt, build.revision)
        for table in ("item_staging", "search_fact_staging"):
            assert connection.execute(
                f"select count(*) as count from ops.problematic_projection_{table} "
                "where job_id=%s and attempt=%s and revision=%s", scope,
            ).fetchone() == {"count": 0}
        for table in ("source_staging", "group_accumulators", "group_facts"):
            count = connection.execute(
                f"select count(*) as count from ops.problematic_projection_{table} "
                "where job_id=%s and attempt=%s and revision=%s", scope,
            ).fetchone()["count"]
            assert (count == 0) if interruption == "cancel" else (count > 0)


def test_live_topology_source_stager_cannot_mark_a_prefix_complete(live_projection_database):
    db = live_projection_database
    album_id = _seed_topology_album(db, file_count=101)
    worker, claim, build, now = _main_search_claimed_v2(db)
    page = worker.load_claimed_source_page(claim=claim, build=build, limit=100,
                                           child_limit=100, now=now)
    assert page.chunks
    chunk = page.chunks[0]
    assert chunk.group_key == ("album", album_id)
    assert chunk.rows and not chunk.complete
    with pytest.raises((ProblematicProjectionIntegrityError, ProblematicProjectionStorageError)):
        worker.stage_claimed_source_chunk(
            claim=claim, build=build, group_key=chunk.group_key,
            source_cursor=chunk.cursor, rows=chunk.rows, complete=True, now=now,
        )
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_source_staging "
            "where job_id=%s and attempt=%s and revision=%s",
            (claim.job_id, claim.attempt, build.revision),
        ).fetchone() == {"count": 0}
    worker.stage_claimed_source_chunk(
        claim=claim, build=build, group_key=chunk.group_key, source_cursor=chunk.cursor,
        rows=chunk.rows, complete=chunk.complete, now=now,
    )
    assert worker.validate_claimed_build(claim=claim, build=build, now=now)


@pytest.mark.parametrize("damage", ["topology_source_end", "topology_discovery_end", "topology_certificate"])
def test_live_topology_missing_terminal_or_certificate_cannot_publish(
    live_projection_database, monkeypatch, damage,
):
    db = live_projection_database
    album_id = _seed_topology_album(db, file_count=1)
    worker, claim, build, _now = _main_search_claimed_v2(db)
    deleted = []

    def remove_required_fact():
        with isolatedPostgres._connect(db.setup_url) as connection:
            if damage == "topology_certificate":
                rows = connection.execute(
                    "delete from ops.problematic_projection_source_staging "
                    "where job_id=%s and attempt=%s and revision=%s "
                    "and source_kind='topology_certificate' and group_kind='album' and group_identity=%s "
                    "returning stage_id",
                    (claim.job_id, claim.attempt, build.revision, str(album_id)),
                ).fetchall()
            else:
                rows = connection.execute(
                    "delete from ops.problematic_projection_group_facts "
                    "where job_id=%s and attempt=%s and revision=%s and group_kind='album' "
                    "and group_identity=%s and fact_kind=%s returning semantic_child_identity",
                    (claim.job_id, claim.attempt, build.revision, str(album_id), damage),
                ).fetchall()
            deleted.append(len(rows))

    if damage == "topology_certificate":
        publish = worker.publish_claimed_snapshot

        def publish_without_certificate(**kwargs):
            remove_required_fact()
            return publish(**kwargs)

        monkeypatch.setattr(worker, "publish_claimed_snapshot", publish_without_certificate)
    else:
        complete = worker.complete_claimed_source_group

        def complete_without_terminal(**kwargs):
            assert kwargs["group_key"] == ("album", album_id)
            remove_required_fact()
            return complete(**kwargs)

        monkeypatch.setattr(worker, "complete_claimed_source_group", complete_without_terminal)

    result = _run_topology_worker(worker, claim)
    assert result.next_state is not JobState.SUCCEEDED
    assert result.reason_code in {
        "problematic_projection_integrity_failed", "problematic_projection_storage_unavailable",
        "problematic_projection_stale",
    }
    assert deleted == [1], "the injected loss must remove exactly one authoritative fact"
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_headers "
            "where library_id=%s and revision=%s", (db.library_id, build.revision),
        ).fetchone() == {"count": 0}


def test_live_topology_known_retry_transfers_certificates_without_recounting(
    live_projection_database, monkeypatch,
):
    from music_app.services.jobs.models import JobTransitionResult

    db = live_projection_database
    _seed_topology_album(db, file_count=1)
    worker, claim, build, _now = _main_search_claimed_v2(db)
    complete = worker.complete_claimed_source_group

    def interrupted_after_completion(**kwargs):
        complete(**kwargs)
        raise ProblematicProjectionStorageError("injected storage interruption after certified completion")

    monkeypatch.setattr(worker, "complete_claimed_source_group", interrupted_after_completion)
    result = _run_topology_worker(worker, claim)
    assert result.next_state is JobState.RETRY_WAIT
    assert result.reason_code == "problematic_projection_storage_unavailable"
    with isolatedPostgres._connect(db.setup_url) as connection:
        proof = _state_topology_proof(connection, db.library_id)
        assert proof["count"] is not None and proof["count"] > 0
        assert proof["fingerprint"] is not None
        certificates = connection.execute(
            "select group_kind,group_identity,payload from ops.problematic_projection_source_staging "
            "where job_id=%s and attempt=%s and revision=%s and source_kind='topology_certificate' "
            "order by group_kind,group_identity", (claim.job_id, claim.attempt, build.revision),
        ).fetchall()
        assert len(certificates) == proof["count"]
    jobs = PostgresJobRepository(database_url=db.worker_url)
    now = datetime.now(timezone.utc)
    assert jobs.finish(claim, JobTransitionResult(
        JobState.RETRY_WAIT, result.reason_code, scheduled_at=now,
    ), now=now)
    retry = jobs.claim(worker_id="topology-known-retry", now=now, lease_seconds=120,
                       kinds=("problematic_files_projection",))
    assert retry is not None and retry.job_id == claim.job_id and retry.attempt == claim.attempt + 1
    resumed = worker.prepare_claimed_build(claim=retry, now=now)
    assert resumed.revision == build.revision
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert _state_topology_proof(connection, db.library_id) == proof
        assert connection.execute(
            "select group_kind,group_identity,payload from ops.problematic_projection_source_staging "
            "where job_id=%s and attempt=%s and revision=%s and source_kind='topology_certificate' "
            "order by group_kind,group_identity", (retry.job_id, retry.attempt, resumed.revision),
        ).fetchall() == certificates
        assert connection.execute(
            "select count(*) as count from ops.problematic_projection_source_staging "
            "where job_id=%s and attempt=%s and revision=%s",
            (claim.job_id, claim.attempt, build.revision),
        ).fetchone() == {"count": 0}
    monkeypatch.setattr(worker, "complete_claimed_source_group", complete)
    outcome = _run_topology_worker(worker, retry)
    assert outcome.next_state is JobState.SUCCEEDED
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert connection.execute(
            "select to_jsonb(header)->'topology_completed_group_count' as count,"
            "to_jsonb(header)->'topology_completed_group_fingerprint' as fingerprint "
            "from ops.problematic_projection_headers header where library_id=%s and revision=%s",
            (db.library_id, resumed.revision),
        ).fetchone() == proof


def test_live_topology_new_active_zero_proof_does_not_hide_previous_known_header(live_projection_database):
    db = live_projection_database
    _seed_topology_album(db, file_count=1)
    worker, claim, build, _now = _main_search_claimed_v2(db)
    result = _run_topology_worker(worker, claim)
    assert result.next_state is JobState.SUCCEEDED
    jobs = PostgresJobRepository(database_url=db.worker_url)
    assert jobs.finish(claim, result, now=datetime.now(timezone.utc))
    reader = PostgresProblematicProjectionRepository(database_url=db.app_url)
    committed = reader.read_page(library_id=db.library_id, limit=50)
    assert committed.revision == build.revision and committed.total == 1
    with isolatedPostgres._connect(db.setup_url) as connection:
        header = connection.execute(
            "select to_jsonb(header)->'topology_completed_group_count' as count "
            "from ops.problematic_projection_headers header where library_id=%s and revision=%s",
            (db.library_id, build.revision),
        ).fetchone()
        assert header["count"] is not None and header["count"] > 0
    _next_worker, next_claim, next_build, _now = _main_search_claimed_v2(db)
    assert next_claim.job_id != claim.job_id and next_build.revision != build.revision
    with isolatedPostgres._connect(db.setup_url) as connection:
        assert _state_topology_proof(connection, db.library_id) == {"count": 0, "fingerprint": "0" * 256}
    retained = reader.read_page(library_id=db.library_id, limit=50)
    assert retained.revision == committed.revision
    assert retained.total == committed.total and retained.items == committed.items
