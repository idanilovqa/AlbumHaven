"""Actual PostgreSQL proof for recovered-cover batch connection bounds."""
from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime, timezone
from contextvars import ContextVar
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
import wave

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_cover_batch_bounded_contracts import _record_recovered_cover_proof
from tests.py.test_isolated_postgres_live import (
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    _skip_or_fail_ci,
)


@pytest.fixture
def recovered_cover_database(monkeypatch):
    setup_url, app_url = _dedicated_database_urls_or_skip(monkeypatch)
    worker_url = str(os.environ.get("ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL")
                     or os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "").strip()
    if not worker_url:
        _skip_or_fail_ci("Dedicated isolated PostgreSQL worker URL is required for native cover proof.")
    from urllib.parse import urlparse

    assert len({urlparse(url).path for url in (setup_url, app_url, worker_url)}) == 1
    with isolatedPostgres._connect(worker_url) as connection:
        isolatedPostgres._assert_connected_role(connection, "album_haven_worker")
    _drop_application_schemas(setup_url)
    isolatedPostgres.prepare_isolated_database(setup_url, app_url)
    worker_pools = []
    try:
        yield SimpleNamespace(setup_url=setup_url, app_url=app_url, worker_url=worker_url,
                              worker_pools=worker_pools)
    finally:
        for pool in worker_pools:
            pool.close()
        isolatedPostgres.reset_application_tables(setup_url)


@pytest.mark.parametrize("mode", ["manual", "post_scan"])
def test_live_claimed_cover_refresh_reuses_connections_for_recovered_existing_covers(
    recovered_cover_database, tmp_path, monkeypatch, request, mode,
):
    _assert_claimed_cover_refresh(
        recovered_cover_database, tmp_path, monkeypatch, request, mode,
    )


@pytest.mark.parametrize("mode", ["manual", "post_scan"])
def test_live_claimed_cover_refresh_skips_configured_root_lost_after_admission(
    recovered_cover_database, tmp_path, monkeypatch, request, mode, caplog,
):
    _assert_claimed_cover_refresh(
        recovered_cover_database, tmp_path, monkeypatch, request, mode,
        cardinalities=(2,), offline_after_admission=True, caplog=caplog,
    )


def _assert_claimed_cover_refresh(
    recovered_cover_database, tmp_path, monkeypatch, request, mode,
    *, cardinalities=(20, 1000), offline_after_admission=False, caplog=None,
):
    import psycopg
    from PIL import Image
    from psycopg_pool import ConnectionPool

    from music_app.jobs.cover_handlers import (
        build_cover_bulk_refresh_resource_validator, build_cover_refresh_handler,
    )
    from music_app.jobs.worker import ExecutionContext, create_worker_pool
    from scripts.run_jobs_worker import _worker_database_connection
    from music_app.jobs.scan_handlers import build_post_scan_cover_refresh_resource_validator
    from music_app.services import (
        cover_mutations_postgres, cover_refresh_execution, cover_refresh_provider,
        cover_refresh_runtime, postgres_connections, state,
        scan_cache_persistence,
    )
    from music_app.services.cover_jobs_postgres import PostgresCoverJobRepository
    from music_app.services.jobs.authorization import (
        JobAuthorizationService, PostgresJobAuthorizationContextRepository,
    )
    from music_app.services.jobs.models import JobState, JobTransitionResult
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
    from music_app.services.policy_evaluator import PolicyEvaluator
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    database = recovered_cover_database
    image = BytesIO()
    with Image.new("RGB", (1200, 1200), "teal") as cover:
        cover.save(image, format="JPEG")
    cover_bytes = image.getvalue()
    cover_revision = hashlib.sha256(cover_bytes).hexdigest()
    audio = BytesIO()
    with wave.open(audio, "wb") as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(8000)
        recording.writeframes(b"\0\0" * 800)
    media_bytes = audio.getvalue()
    proof_scales = []
    real_recover = cover_refresh_execution._recover_existing_cover_selection
    real_run_jobs = state.run_cover_jobs
    real_default_connect = cover_mutations_postgres._default_connect
    real_scan_cache_connect = scan_cache_persistence._connect

    for cardinality in cardinalities:
        isolatedPostgres.reset_application_tables(database.setup_url)
        isolatedPostgres.seed_bootstrap_owner_and_library(database.setup_url)
        root = tmp_path / f"{mode}-{cardinality}"
        root.mkdir()
        config = {
            "ALBUM_HAVEN_APP_DATABASE_URL": database.worker_url,
            "MUSIC_DIR": str(root), "APP_NAME": "Album Haven",
            "SUPPORTED_EXTENSIONS": {".wav"}, "IMAGE_EXTENSIONS": {".jpg"},
            "COVER_CACHE_PATH": root / "cover-search.json", "CACHE_PATH": root / "inventory.json",
            "MUSICBRAINZ_USER_AGENT": "AlbumHavenTests/native-recovered-cover",
            "BULK_COVER_JOB_WORKERS": 1,
        }
        setup_config = {**config, "ALBUM_HAVEN_APP_DATABASE_URL": database.setup_url}
        PostgresLibraryRootSettingsStore(setup_config).save_settings({
            "main_library_roots": [{"id": "recovered-covers", "path": str(root), "layout_mode": "artist"}],
            "hoarding_library_roots": [], "new_arrivals_roots": [],
        })
        entries = {}
        for index in range(cardinality):
            path = root / f"Artist {index:04d}" / f"Album {index:04d}" / "01.wav"
            path.parent.mkdir(parents=True)
            path.write_bytes(media_bytes)
            entries[str(path)] = {
                "path": str(path), "mtime": path.stat().st_mtime, "size": len(media_bytes),
                "album": f"Album {index:04d}", "album_artist": f"Artist {index:04d}",
                "artist": f"Artist {index:04d}", "title": "One", "track_number": 1,
                "disc_number": 1, "duration_seconds": 0.1, "year": 2026,
                "library_root_id": "recovered-covers", "library_root_category": "main_library",
            }
        # Inventory setup is migrator-owned; the measured runtime never receives
        # that role or a prebuilt runtime/cache scope.
        PostgresScanCacheAdapter(setup_config).save_snapshot(
            Path("unused-native-cover-snapshot"), entries, "native-recovered-cover", 1.0,
            observed_library_root_ids={"recovered-covers"},
        )
        for path in entries:
            Path(path).with_name("cover.jpg").write_bytes(cover_bytes)
        origin = f"native-recovered-cover-{uuid4().hex}"
        with isolatedPostgres._connect(database.setup_url) as connection:
            scope = connection.execute(
                "select owner.account_id, owned.id library_id, "
                "owned.metadata ->> 'inventory_mutation_revision' inventory_revision, "
                "library.read_cover_mutation_revision(owned.id) cover_revision "
                "from app.bootstrap_owners owner join library.libraries owned "
                "on owned.owner_account_id=owner.account_id "
                "where owner.owner_key='local-bootstrap-owner' "
                "and owned.name='Local Library' and owned.library_kind='local'"
            ).fetchone()
            connection.execute(
                "insert into library.library_memberships (library_id,account_id,membership_role) "
                "values (%s,%s,'owner')", (scope["library_id"], scope["account_id"]),
            )
            connection.execute(
                "insert into app.request_origins (account_id,client_surface_class,origin_type,origin_key) "
                "values (%s,'private_web','browser',%s)", (scope["account_id"], origin),
            )
        recovered, providers, defaults, runtime_states = [], [], [], []
        runtime_results, runtime_errors = [], []
        physical, checkouts, pools, backend_ids = [], [], {}, []
        physical_owners, checkout_owners, all_connections = [], [], []
        measuring = [False]
        connection_owner = ContextVar("native_cover_proof_connection_owner", default="other")

        class CountedConnection(psycopg.Connection):
            @classmethod
            def connect(cls, conninfo="", **options):
                connection = super().connect(conninfo, **options)
                all_connections.append(connection)
                if measuring[0]:
                    physical.append(connection)
                    physical_owners.append(connection_owner.get())
                backend_ids.append(connection.info.backend_pid)
                return connection

        def counted_connect(conninfo="", **options):
            connection = CountedConnection.connect(conninfo, **options)
            checkouts.append(connection)
            checkout_owners.append(connection_owner.get())
            return connection

        def counted_cover_connect(database_url):
            token = connection_owner.set("cover-transaction")
            try:
                return real_scan_cache_connect(database_url)
            finally:
                connection_owner.reset(token)

        class CountedLockConnection(CountedConnection):
            @classmethod
            def connect(cls, conninfo="", **options):
                token = connection_owner.set("cover-lock")
                try:
                    return super().connect(conninfo, **options)
                finally:
                    connection_owner.reset(token)

        class CountedWorkerConnection(CountedConnection):
            @classmethod
            def connect(cls, conninfo="", **options):
                token = connection_owner.set("worker-pool")
                try:
                    return super().connect(conninfo, **options)
                finally:
                    connection_owner.reset(token)

        class CountedPool(ConnectionPool):
            def __init__(self, *args, **kwargs):
                is_cover_lock = kwargs.get("kwargs", {}).get("autocommit") is True
                self._proof_owner = "cover-lock" if is_cover_lock else "worker-repository"
                super().__init__(*args,
                                 connection_class=CountedLockConnection if is_cover_lock else CountedWorkerConnection,
                                 **kwargs)

            def getconn(self, timeout=None):
                connection = super().getconn(timeout=timeout)
                if measuring[0]:
                    checkouts.append(connection)
                    checkout_owners.append("cover-lock" if self._proof_owner == "cover-lock"
                                           else connection_owner.get())
                return connection

        # Match build_worker: every worker repository and authorization read
        # uses the same dedicated worker pool, while scan_config has worker DSN.
        worker_pool = create_worker_pool(
            SimpleNamespace(database_url=database.worker_url, concurrency=1), pool_factory=CountedPool,
        )
        database.worker_pools.append(worker_pool)

        @contextmanager
        def worker_connect(_database_url):
            token = connection_owner.set("worker-repository")
            try:
                with _worker_database_connection(worker_pool, _database_url) as connection:
                    yield connection
            finally:
                connection_owner.reset(token)

        @contextmanager
        def authorization_connect(_database_url):
            token = connection_owner.set("authorization")
            try:
                with _worker_database_connection(worker_pool, _database_url) as connection:
                    yield connection
            finally:
                connection_owner.reset(token)

        jobs = PostgresJobRepository(database_url=database.worker_url, connect_to_database=worker_connect)
        scans = PostgresScanJobRepository(database_url=database.worker_url, connect_to_database=worker_connect,
                                         job_repository=jobs)
        if mode == "manual":
            app_covers = PostgresCoverJobRepository(database_url=database.app_url)
            accepted = app_covers.accept_bulk_refresh(
                task_key=origin, library_id=scope["library_id"], account_id=scope["account_id"],
                request_origin_ref=f"browser:{origin}", deployment_mode="self_hosted_private_web",
                client_surface="private_web", mode="manual", force_search=True,
                resource_revision=int(scope["inventory_revision"] or 0), scheduled_at=datetime.now(timezone.utc),
            )
            expected_job_id = accepted.job_id
            claimed_kind = "cover_bulk_refresh"
        else:
            # A post-scan refresh is server-owned work created atomically by a
            # real scan publication, never manual admission with a changed mode.
            accepted_scan = PostgresScanJobRepository(database_url=database.app_url).enqueue_full_scan(
                library_id=scope["library_id"], account_id=scope["account_id"], capability_key="library.refresh",
                request_origin_ref=f"browser:{origin}", deployment_mode="self_hosted_private_web",
                client_surface="private_web", root_ids=("recovered-covers",),
                mode="manual_full_rescan", force=True, scheduled_at=datetime.now(timezone.utc),
            )
            scan_claim = jobs.claim(worker_id=origin, now=datetime.now(timezone.utc), lease_seconds=3600,
                                    kinds=("full_scan",))
            assert scan_claim is not None and scan_claim.job_id == accepted_scan.job_id
            intent = scans.load_claimed_full_scan(job_id=scan_claim.job_id, worker_id=scan_claim.worker_id,
                                                  lease_token=scan_claim.lease_token)
            claimed_scope = scans.load_claimed_full_scan_scope(
                intent_id=intent.intent_id, library_id=intent.library_id, job_id=scan_claim.job_id,
                attempt=scan_claim.attempt, worker_id=scan_claim.worker_id,
                lease_token=scan_claim.lease_token, now=datetime.now(timezone.utc),
            )
            assert claimed_scope.scope_complete
            publication = scans.publish_claimed_full_scan(
                claim=scan_claim, intent_id=accepted_scan.intent_id,
                expected_inventory_mutation_revision=intent.inventory_mutation_revision,
                inventory=PostgresScanCacheAdapter(setup_config).prepare_full_scan_inventory(entries),
                observed_root_ids=[item["id"] for item in claimed_scope.roots], now=datetime.now(timezone.utc),
            )
            assert publication["publication_won"] is True, publication
            assert jobs.finish(scan_claim, JobTransitionResult(JobState.SUCCEEDED, "full_scan_completed"),
                               now=datetime.now(timezone.utc))
            with isolatedPostgres._connect(database.setup_url) as connection:
                parent = connection.execute(
                    "select state from ops.jobs where id=%s", (scan_claim.job_id,),
                ).fetchone()
                assert parent["state"] == "succeeded"
                follow_up = connection.execute(
                    "select id, account_id, capability_key, request_origin_id from ops.jobs "
                    "where library_id=%s and kind='post_scan_cover_refresh' and resource_revision=%s",
                    (scope["library_id"], publication["inventory_mutation_revision"]),
                ).fetchone()
                assert follow_up and all(follow_up[key] is None for key in
                                         ("account_id", "capability_key", "request_origin_id"))
                expected_job_id = follow_up["id"]
                scope["inventory_revision"] = publication["inventory_mutation_revision"]
            claimed_kind = "post_scan_cover_refresh"
        claim = jobs.claim(worker_id=origin, now=datetime.now(timezone.utc), lease_seconds=3600,
                           kinds=(claimed_kind,))
        assert claim is not None and claim.job_id == expected_job_id
        covers = PostgresCoverJobRepository(database_url=database.worker_url, connect_to_database=worker_connect,
                                           job_repository=jobs)
        authorization = JobAuthorizationService(
            context_repository=PostgresJobAuthorizationContextRepository(
                database.worker_url, connect_to_database=authorization_connect,
            ),
            policy_evaluator=PolicyEvaluator(),
            resource_validators={"cover_bulk_refresh": build_cover_bulk_refresh_resource_validator(
                cover_repository=covers,
            ), "post_scan_cover_refresh": build_post_scan_cover_refresh_resource_validator(scan_repository=scans)},
        )
        context = ExecutionContext(claim, authorization_service=authorization,
                                   clock=lambda: datetime.now(timezone.utc))
        assert context.reauthorize().allowed
        # Full-scan publication may already have advanced cover authority.
        with isolatedPostgres._connect(database.setup_url) as connection:
            starting_cover_revision = connection.execute(
                "select library.read_cover_mutation_revision(%s) revision", (scope["library_id"],),
            ).fetchone()["revision"]
            original_selections = connection.execute(
                "select album.id,album.cover_path,album.metadata from library.local_albums album "
                "where album.library_id=%s order by album.id", (scope["library_id"],),
            ).fetchall()
            original_candidates = connection.execute(
                "select snapshot.* from library.local_album_cover_candidate_snapshots snapshot "
                "join library.local_albums album on album.id=snapshot.album_id "
                "where album.library_id=%s order by snapshot.album_id", (scope["library_id"],),
            ).fetchall()
        detached_root = root.with_name(root.name + "-detached")
        root_probes = []
        real_isdir = cover_refresh_execution.os.path.isdir

        def observe_isdir(path):
            root_probes.append(str(path))
            return real_isdir(path)
        def observe_recovery(**options):
            result = real_recover(**options)
            assert result == (True, False)
            recovered.append(str(options["cover_path"]))
            return result

        def provider_miss(**options):
            providers.append(options)
            return None, [{"status": "not_found"}]

        def default_connect(url):
            defaults.append(url)
            return real_default_connect(url)

        def observe_engine(**options):
            runtime_states.append(options["get_state"]())
            return real_run_jobs(**options)

        def measured_refresh(**options):
            # Observe the actual claimed-runtime boundary, including preparation. All
            # SQL still uses psycopg and the production transaction/pool owners.
            if offline_after_admission:
                # The real handler has admitted/loaded its scope; only this root
                # disappears, while its parent and drive remain accessible.
                assert options["scope"].file_cache
                root.rename(detached_root)
                assert not root.exists() and root.parent.is_dir()
                assert Path(root.anchor).is_dir()
            with monkeypatch.context() as patch:
                patch.setattr(psycopg, "connect", counted_connect)
                patch.setattr(scan_cache_persistence, "_connect", counted_cover_connect)
                patch.setattr(postgres_connections, "ConnectionPool", CountedPool)
                patch.setattr(postgres_connections, "_pools", pools)
                patch.setattr(cover_mutations_postgres, "_default_connect", default_connect)
                measuring[0] = True
                try:
                    result = cover_refresh_runtime.run_claimed_cover_refresh(**options)
                    runtime_results.append(result)
                except Exception as error:
                    from traceback import format_exc

                    runtime_errors.append((type(error).__name__, str(error), format_exc()))
                    print(format_exc(), flush=True)
                    raise
                finally:
                    measuring[0] = False
                    for pool in pools.values():
                        pool.close()
            return result

        with monkeypatch.context() as patch:
            patch.setattr(cover_refresh_execution, "_recover_existing_cover_selection", observe_recovery)
            patch.setattr(cover_refresh_provider, "search_primary_remote_cover", provider_miss)
            patch.setattr(state, "run_cover_jobs", observe_engine)
            if offline_after_admission:
                patch.setattr(cover_refresh_execution.os.path, "isdir", observe_isdir)
            outcome = build_cover_refresh_handler(
                cover_repository=covers, config=config, logger=logging.getLogger("test.native.recovered.cover"),
                run_refresh=measured_refresh,
            )(claim, context)
        worker_pool.close()
        assert all(connection.closed for connection in all_connections)
        assert not runtime_errors, runtime_errors
        assert outcome.next_state is JobState.SUCCEEDED, outcome
        assert len(runtime_results) == 1
        assert runtime_results[0]["processed"] == cardinality
        assert runtime_results[0]["downloaded"] == runtime_results[0]["failed"] == 0
        if offline_after_admission:
            result = runtime_results[0]
            if caplog is not None:
                warnings = [record.getMessage() for record in caplog.records
                            if "Library roots unavailable for the cover reachability probe" in record.getMessage()]
                if warnings:
                    print("Root reachability supporting warnings:", warnings, flush=True)
            assert providers == [], "an offline configured root must never trigger provider search"
            assert recovered == [], "an offline configured root must never publish cover recovery"
            assert result["skipped"] == cardinality
            assert {item["reason"] for item in result["job_results"]} == {"library_root_unavailable"}
            assert all("offline" in item["message"].casefold() for item in result["job_results"])
            assert root_probes.count(str(root)) == 1, root_probes
            assert str(root.anchor) not in root_probes, root_probes
            assert not root.exists(), "cover work must not recreate the offline root"
            for path in entries:
                retained = detached_root / Path(path).relative_to(root)
                assert retained.read_bytes() == media_bytes
                assert retained.with_name("cover.jpg").read_bytes() == cover_bytes
            with isolatedPostgres._connect(database.setup_url) as connection:
                assert connection.execute(
                    "select album.id,album.cover_path,album.metadata from library.local_albums album "
                    "where album.library_id=%s order by album.id", (scope["library_id"],),
                ).fetchall() == original_selections
                assert connection.execute(
                    "select snapshot.* from library.local_album_cover_candidate_snapshots snapshot "
                    "join library.local_albums album on album.id=snapshot.album_id "
                    "where album.library_id=%s order by snapshot.album_id", (scope["library_id"],),
                ).fetchall() == original_candidates
                assert connection.execute(
                    "select library.read_cover_mutation_revision(%s) revision", (scope["library_id"],),
                ).fetchone()["revision"] == int(starting_cover_revision)
                assert connection.execute(
                    "select count(*) count from pg_stat_activity where pid=any(%s)", (backend_ids,),
                ).fetchone()["count"] == 0
                assert connection.execute(
                    "select count(*) count from pg_locks where pid=any(%s)", (backend_ids,),
                ).fetchone()["count"] == 0
            isolatedPostgres.reset_application_tables(database.setup_url)
            continue
        connection_breakdown = {
            "physical": {owner: physical_owners.count(owner) for owner in set(physical_owners)},
            "checkouts": {owner: checkout_owners.count(owner) for owner in set(checkout_owners)},
        }
        # Keep the approved claimed-runtime assertion honest. Authorization is
        # live; its connections remain in the total and cannot be relabeled away.
        assert 0 < len(physical) <= 3, connection_breakdown
        assert 0 < len(checkouts) <= cardinality + 2, connection_breakdown
        assert len(recovered) == len(set(recovered)) == cardinality
        assert defaults == []
        assert len(providers) == (cardinality if mode == "manual" else 0)
        assert len(runtime_states) == 1
        runtime_entries = runtime_states[0]["file_cache"]
        assert set(runtime_entries) == set(entries)
        for path, entry in runtime_entries.items():
            assert entry["cover_path"] == str(Path(path).with_name("cover.jpg"))
            assert entry["cover_revision"] == cover_revision
            assert Path(path).read_bytes() == media_bytes
            assert Path(entry["cover_path"]).read_bytes() == cover_bytes
        with isolatedPostgres._connect(database.setup_url) as connection:
            persisted = connection.execute(
                "select album.cover_path, album.metadata from library.local_albums album "
                "where album.library_id=%s order by album.id", (scope["library_id"],),
            ).fetchall()
            assert len(persisted) == cardinality
            assert {row["cover_path"] for row in persisted} == set(recovered)
            assert all(row["metadata"]["cover_revision"] == cover_revision for row in persisted)
            assert all(row["metadata"]["cover_selection_origin"] == "automatic" for row in persisted)
            revision = connection.execute(
                "select library.read_cover_mutation_revision(%s) revision", (scope["library_id"],),
            ).fetchone()["revision"]
            assert revision == int(starting_cover_revision) + cardinality
        # Closed sessions cannot retain advisory locks. Inspect their exact
        # backend identities rather than assuming a quiet pool is cleaned up.
        with isolatedPostgres._connect(database.setup_url) as connection:
            assert connection.execute(
                "select count(*) count from pg_stat_activity where pid=any(%s)", (backend_ids,),
            ).fetchone()["count"] == 0
            assert connection.execute(
                "select count(*) count from pg_locks where pid=any(%s)", (backend_ids,),
            ).fetchone()["count"] == 0
        isolatedPostgres.reset_application_tables(database.setup_url)
        proof_scales.append({
            "cardinality": cardinality, "physicalConnections": len(physical),
            "checkouts": len(checkouts), "recoveryHits": len(recovered),
            "defaultConnectorCalls": len(defaults), "cleanupComplete": True,
        })
    if not offline_after_admission:
        _record_recovered_cover_proof(
            node_id=request.node.nodeid, kind="real-postgres", mode=mode, scales=proof_scales,
        )
