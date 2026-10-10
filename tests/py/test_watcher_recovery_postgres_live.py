from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib
import json
import os
from pathlib import Path
from threading import Event, Thread
import time
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

from music_app.services.jobs.models import JobKind, JobState, JobTransitionResult
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.library_watch import LibraryEvent, LibraryEventKind
from tests.e2e.support import isolatedPostgres


NOW = datetime.now(timezone.utc)


def _skip_or_fail_ci(message: str) -> None:
    if any(
        str(os.environ.get(name) or "").strip().casefold() in {"1", "true", "yes"}
        for name in ("CI", "GITHUB_ACTIONS")
    ):
        pytest.fail(message, pytrace=False)
    pytest.skip(message)


def _urls_or_skip() -> tuple[str, str, str]:
    try:
        setup_url, app_url = isolatedPostgres.resolve_isolated_database_urls()
    except RuntimeError:
        _skip_or_fail_ci("Dedicated watcher recovery Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "").strip()
    if not worker_url:
        _skip_or_fail_ci("Dedicated watcher worker Postgres URL is unavailable.")
    if not Path(str(os.environ.get("PGPASSFILE") or "")).is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")
    identities = {
        (
            (urlparse(value).hostname or "").casefold(),
            urlparse(value).port or 5432,
            urlparse(value).path.lstrip("/"),
        )
        for value in (setup_url, app_url, worker_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Watcher role URLs do not share one isolated database.")
    return setup_url, app_url, worker_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("drop schema if exists app, integration, library, ops cascade")


def _module():
    try:
        return importlib.import_module("music_app.services.watcher_recovery_postgres")
    except ModuleNotFoundError as exc:
        if exc.name == "music_app.services.watcher_recovery_postgres":
            pytest.fail("durable watcher recovery repository is not implemented")
        raise


def _repository(database_url: str):
    return _module().PostgresWatcherRecoveryRepository(
        database_url=database_url,
        connect_to_database=isolatedPostgres._connect,
    )


@pytest.fixture
def live_watcher_database(tmp_path_factory):
    setup_url, app_url, worker_url = _urls_or_skip()
    private_root = tmp_path_factory.mktemp("watcher-recovery")
    root_paths = {
        "root-a": private_root / "root-a",
        "root-b": private_root / "root-b",
        "root-c": private_root / "root-c",
        "root-d": private_root / "root-d",
    }
    for path in root_paths.values():
        path.mkdir()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, app_url)
        with isolatedPostgres._connect(setup_url) as connection:
            account_id = int(
                connection.execute(
                    """
                    insert into app.accounts (
                      display_name, username_display, username_normalized,
                      contact_email, contact_email_normalized, account_kind, is_active
                    ) values (
                      'Watcher Recovery', 'watcher-recovery', 'watcher-recovery',
                      'watcher-recovery@example.invalid',
                      'watcher-recovery@example.invalid', 'managed', true
                    ) returning id
                    """
                ).fetchone()["id"]
            )
            account_id = int(
                connection.execute(
                    "select account_id from app.bootstrap_owners "
                    "where owner_key = 'local-bootstrap-owner'"
                ).fetchone()["account_id"]
            )
            connection.execute(
                "update library.libraries set name = 'Watcher Recovery Seed' "
                "where owner_account_id = %s and name = 'Local Library' "
                "and library_kind = 'local'",
                (account_id,),
            )
            library_id = int(
                connection.execute(
                    """
                    insert into library.libraries (owner_account_id, name, library_kind)
                    values (%s, 'Local Library', 'local') returning id
                    """,
                    (account_id,),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.library_memberships (
                    library_id, account_id, membership_role
                ) values (%s, %s, 'owner')
                """,
                (library_id, account_id),
            )
            connection.execute(
                """
                insert into app.capabilities (
                    account_id, capability_key, scope_kind, scope_id
                ) values (%s, 'library.refresh', 'library', %s)
                """,
                (account_id, library_id),
            )
            root_database_ids = {}
            for logical_id, path in root_paths.items():
                root_database_ids[logical_id] = int(
                    connection.execute(
                        """
                        insert into library.library_roots (
                          library_id, root_path, root_kind, is_active, metadata
                        ) values (%s, %s, 'main', true, %s::jsonb)
                        returning id
                        """,
                        (library_id, str(path), json.dumps({"root_id": logical_id})),
                    ).fetchone()["id"]
                )
        yield SimpleNamespace(
            setup_url=setup_url,
            app_url=app_url,
            worker_url=worker_url,
            account_id=account_id,
            library_id=library_id,
            root_paths=root_paths,
            root_database_ids=root_database_ids,
        )
    finally:
        _drop_schemas(setup_url)


def _created(scope, root_id: str, relative_path: str) -> LibraryEvent:
    return LibraryEvent(
        LibraryEventKind.CREATED,
        root_id,
        scope.root_paths[root_id] / relative_path,
    )


def _moved(scope, source_root: str, destination_root: str, name: str) -> LibraryEvent:
    return LibraryEvent(
        LibraryEventKind.MOVED,
        source_root,
        scope.root_paths[source_root] / f"old/{name}",
        destination=scope.root_paths[destination_root] / f"new/{name}",
        destination_root_id=destination_root,
    )


def test_runtime_roles_have_no_direct_watcher_table_privileges(live_watcher_database):
    scope = live_watcher_database
    tables = (
        "targeted_reconciliation_intent_paths",
        "targeted_reconciliation_intent_moves",
        "watcher_lanes",
        "watcher_generation_participants",
        "watcher_barriers",
        "watcher_barrier_participants",
        "watcher_incidents",
        "watcher_repairs",
        "watcher_repair_roots",
        "watcher_generation_repairs",
        "watcher_legacy_health_imports",
        "watcher_incident_acknowledgements",
    )
    sequences = ("watcher_barriers_id_seq", "watcher_repairs_id_seq")
    with isolatedPostgres._connect(scope.setup_url) as connection:
        for role in ("album_haven_app", "album_haven_worker", "album_haven_readonly"):
            for table in tables:
                for privilege in (
                    "SELECT",
                    "INSERT",
                    "UPDATE",
                    "DELETE",
                    "TRUNCATE",
                    "REFERENCES",
                    "TRIGGER",
                ):
                    privileges = connection.execute(
                        "select has_table_privilege(%s, %s, %s) as allowed",
                        (role, f"library.{table}", privilege),
                    ).fetchone()
                    assert privileges["allowed"] is False
            for sequence in sequences:
                for privilege in ("USAGE", "SELECT", "UPDATE"):
                    privileges = connection.execute(
                        "select has_sequence_privilege(%s, %s, %s) as allowed",
                        (role, f"library.{sequence}", privilege),
                    ).fetchone()
                    assert privileges["allowed"] is False


def test_watcher_function_privilege_matrix_and_raw_scope_denial(
    live_watcher_database,
):
    import psycopg

    scope = live_watcher_database
    expectations = (
        (
            "album_haven_app",
            "library.accept_watcher_event(bigint,bigint,jsonb,timestamptz)",
            True,
        ),
        (
            "album_haven_worker",
            "library.accept_watcher_event(bigint,bigint,jsonb,timestamptz)",
            False,
        ),
        (
            "album_haven_worker",
            "library.dispatch_ready_watcher_generations(timestamptz,integer)",
            True,
        ),
        (
            "album_haven_app",
            "library.dispatch_ready_watcher_generations(timestamptz,integer)",
            False,
        ),
        (
            "album_haven_app",
            "library.mark_watcher_roots_dirty(bigint,text[],varchar,timestamptz)",
            True,
        ),
        (
            "album_haven_worker",
            "library.mark_watcher_roots_dirty(bigint,text[],varchar,timestamptz)",
            False,
        ),
        (
            "album_haven_app",
            "library.load_local_watcher_incident_acknowledgements(bigint)",
            True,
        ),
        (
            "album_haven_worker",
            "library.load_local_watcher_incident_acknowledgements(bigint)",
            False,
        ),
        (
            "album_haven_readonly",
            "library.load_local_watcher_incident_acknowledgements(bigint)",
            False,
        ),
        (
            "album_haven_app",
            "library.acknowledge_local_watcher_incidents(bigint,uuid[])",
            True,
        ),
        (
            "album_haven_worker",
            "library.acknowledge_local_watcher_incidents(bigint,uuid[])",
            False,
        ),
        (
            "album_haven_readonly",
            "library.acknowledge_local_watcher_incidents(bigint,uuid[])",
            False,
        ),
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        for role, signature, allowed in expectations:
            row = connection.execute(
                "select has_function_privilege(%s, %s, 'EXECUTE') as allowed",
                (role, signature),
            ).fetchone()
            assert row["allowed"] is allowed
    with isolatedPostgres._connect(scope.app_url) as connection:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as denied:
            connection.execute(
                "select * from library.targeted_reconciliation_intent_paths"
            ).fetchall()
    assert denied.value.sqlstate == "42501"


def _publish_watcher_generation(scope, generation_id: int, *, now: datetime, worker_id: str):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    recovery = _repository(scope.worker_url)
    assert generation_id in recovery.dispatch_ready(now=now, limit=32)
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id=worker_id,
        now=now,
        lease_seconds=300,
        kinds=(JobKind.TARGETED_RECONCILIATION,),
    )
    assert claim is not None
    generation = recovery.claim_generation(claim=claim, now=now)
    assert generation is not None
    assert generation.generation_id == generation_id
    scans = PostgresScanJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    publication = scans.publish_claimed_targeted_reconciliation(
        claim=claim,
        intent_id=generation_id,
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        stale_scopes=(),
        now=now,
    )
    assert publication["publication_won"] is True, publication
    return publication


def test_idempotent_targeted_publication_replay_revalidates_file_scope(
    live_watcher_database,
):
    import psycopg

    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    recovery = _repository(scope.worker_url)
    accepted = _repository(scope.app_url).accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "Album/01.flac"),
        accepted_at=now,
    )
    assert recovery.dispatch_ready(now=now, limit=32) == (accepted.generation_id,)
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="watcher-replay-scope-worker",
        now=now,
        lease_seconds=300,
        kinds=(JobKind.TARGETED_RECONCILIATION,),
    )
    assert claim is not None
    assert recovery.claim_generation(claim=claim, now=now) is not None
    scans = PostgresScanJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    empty_inventory = {
        "artists": [],
        "albums": [],
        "featured_artists": [],
        "tracks": [],
        "track_files": [],
    }
    assert scans.publish_claimed_targeted_reconciliation(
        claim=claim,
        intent_id=accepted.generation_id,
        inventory=empty_inventory,
        stale_scopes=(),
        now=now,
    )["publication_won"] is True

    replay = scans.publish_claimed_targeted_reconciliation(
        claim=claim,
        intent_id=accepted.generation_id,
        inventory=empty_inventory,
        stale_scopes=(),
        now=now + timedelta(microseconds=1),
    )
    assert replay["publication_won"] is True

    with pytest.raises(
        psycopg.errors.RaiseException,
        match="targeted publication file scope is invalid",
    ):
        scans.publish_claimed_targeted_reconciliation(
            claim=claim,
            intent_id=accepted.generation_id,
            inventory={
                **empty_inventory,
                "tracks": [{"track_key": "tampered-track"}],
                "track_files": [
                    {
                        "track_key": "tampered-track",
                        "private_path": str(
                            scope.root_paths["root-b"] / "Outside/99.flac"
                        ),
                    }
                ],
            },
            stale_scopes=(),
            now=now + timedelta(milliseconds=1),
        )


def _seed_scanning_repair(scope, *, now: datetime, logical_root_id: str) -> int:
    root_id = scope.root_database_ids[logical_root_id]
    with isolatedPostgres._connect(scope.setup_url) as connection:
        repair_id = int(
            connection.execute(
                """
                insert into library.watcher_repairs (
                  library_id, repair_generation, state, started_at
                )
                select %s, coalesce(max(repair_generation), 0) + 1,
                       'scanning', %s
                from library.watcher_repairs where library_id = %s
                returning id
                """,
                (scope.library_id, now, scope.library_id),
            ).fetchone()["id"]
        )
        connection.execute(
            """
            insert into library.watcher_repair_roots (
              repair_id, library_id, root_id, incident_id,
              captured_accepted_sequence, captured_dirty_generation
            )
            select %s, lane.library_id, lane.root_id, incident.incident_id,
                   lane.accepted_sequence, lane.dirty_generation
            from library.watcher_lanes as lane
            join library.watcher_incidents as incident
              on incident.library_id = lane.library_id
             and incident.root_id = lane.root_id
             and incident.resolved_at is null
            where lane.library_id = %s and lane.root_id = %s
            """,
            (repair_id, scope.library_id, root_id),
        )
    return repair_id


def _enqueue_linked_full_scan(
    scope, *, repair_id: int, now: datetime, request_ref: str
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    app_scans = PostgresScanJobRepository(
        database_url=scope.app_url,
        connect_to_database=isolatedPostgres._connect,
    )
    accepted = app_scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref=request_ref,
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-a",),
        mode="manual_full_rescan",
        force=True,
        scheduled_at=now - timedelta(seconds=1),
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            """
            update library.full_scan_intents set watcher_repair_id = %s
            where id = %s
            """,
            (repair_id, accepted.intent_id),
        )
    return app_scans, accepted


def _claim_enqueued_full_scan(
    scope,
    *,
    now: datetime,
    request_ref: str,
    worker_id: str | None = None,
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id=worker_id or f"{request_ref}-worker",
        now=now,
        lease_seconds=300,
        kinds=(JobKind.FULL_SCAN,),
    )
    assert claim is not None
    worker_scans = PostgresScanJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    intent = worker_scans.load_claimed_full_scan(
        job_id=claim.job_id,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
    )
    scope_result = worker_scans.load_claimed_full_scan_scope(
        intent_id=intent.intent_id,
        library_id=intent.library_id,
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=now,
    )
    assert scope_result.scope_complete is True
    return worker_scans, claim, intent, scope_result


def _claim_linked_full_scan(
    scope,
    *,
    repair_id: int,
    now: datetime,
    request_ref: str,
    worker_id: str | None = None,
):
    _, accepted = _enqueue_linked_full_scan(
        scope,
        repair_id=repair_id,
        now=now,
        request_ref=request_ref,
    )
    worker_scans, claim, intent, scope_result = _claim_enqueued_full_scan(
        scope,
        now=now,
        request_ref=request_ref,
        worker_id=worker_id,
    )
    return worker_scans, accepted, claim, intent, scope_result


def _publish_linked_full_scan(
    scans,
    accepted,
    claim,
    intent,
    claimed_scope,
    *,
    now: datetime,
):
    publication = scans.publish_claimed_full_scan(
        claim=claim,
        intent_id=accepted.intent_id,
        expected_inventory_mutation_revision=intent.inventory_mutation_revision,
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        observed_root_ids=[root["id"] for root in claimed_scope.roots],
        now=now,
    )
    assert publication["publication_won"] is True, publication
    return publication


def test_repair_replays_generation_that_completed_before_full_publication(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_recovery = _repository(scope.app_url)
    initial = app_recovery.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now,
    )
    repair_id = _seed_scanning_repair(scope, now=now, logical_root_id="root-a")
    _, accepted = _enqueue_linked_full_scan(
        scope,
        repair_id=repair_id,
        now=now,
        request_ref="watcher:repair-completed-before-full",
    )
    assert app_recovery.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "completed-before-full.flac"),
        accepted_at=now + timedelta(seconds=1),
    ).generation_id == initial.generation_id
    _publish_watcher_generation(
        scope,
        initial.generation_id,
        now=now + timedelta(seconds=2),
        worker_id="repair-pre-full-targeted",
    )
    worker_scans, claim, intent, scope_result = _claim_enqueued_full_scan(
        scope,
        now=now + timedelta(seconds=2),
        request_ref="watcher:repair-completed-before-full",
    )
    _publish_linked_full_scan(
        worker_scans,
        accepted,
        claim,
        intent,
        scope_result,
        now=now + timedelta(seconds=3),
    )

    with isolatedPostgres._connect(scope.setup_url) as connection:
        waiting = connection.execute(
            """
            select repair.state, repair.completed_at, incident.resolved_at,
                   lane.successor_generation_id
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            join library.watcher_lanes as lane
              on lane.library_id = repair_root.library_id
             and lane.root_id = repair_root.root_id
            where repair.id = %s
            """,
            (repair_id,),
        ).fetchone()
        repair_links = connection.execute(
            """
            select generation_id from library.watcher_generation_repairs
            where repair_id = %s
            """,
            (repair_id,),
        ).fetchall()
    successor_id = waiting["successor_generation_id"]
    assert waiting["state"] == "catch_up"
    assert waiting["completed_at"] is None
    assert waiting["resolved_at"] is None
    assert successor_id is not None and successor_id != initial.generation_id
    assert {row["generation_id"] for row in repair_links} == {successor_id}

    _publish_watcher_generation(
        scope,
        successor_id,
        now=now + timedelta(seconds=4),
        worker_id="repair-post-full-catch-up",
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state, repair.completed_at, incident.resolved_at
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            where repair.id = %s
            """,
            (repair_id,),
        ).fetchone()
    assert completed["state"] == "complete"
    assert completed["completed_at"] is not None
    assert completed["resolved_at"] is not None


def test_repair_publication_removes_fully_covered_successor(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_recovery = _repository(scope.app_url)
    covered = app_recovery.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now,
    )
    repair_id = _seed_scanning_repair(scope, now=now, logical_root_id="root-a")
    _, accepted = _enqueue_linked_full_scan(
        scope,
        repair_id=repair_id,
        now=now,
        request_ref="watcher:fully-covered-successor",
    )
    worker_scans, claim, intent, scope_result = _claim_enqueued_full_scan(
        scope,
        now=now,
        request_ref="watcher:fully-covered-successor",
    )

    _publish_linked_full_scan(
        worker_scans,
        accepted,
        claim,
        intent,
        scope_result,
        now=now + timedelta(seconds=1),
    )

    with isolatedPostgres._connect(scope.setup_url) as connection:
        state = connection.execute(
            """
            select repair.state, lane.successor_generation_id,
                   exists (
                     select 1 from library.targeted_reconciliation_intents
                     where id = %s
                   ) as covered_generation_exists
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_lanes as lane
              on lane.library_id = repair_root.library_id
             and lane.root_id = repair_root.root_id
            where repair.id = %s
            """,
            (covered.generation_id, repair_id),
        ).fetchone()
    assert state == {
        "state": "complete",
        "successor_generation_id": None,
        "covered_generation_exists": False,
    }

    later = app_recovery.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "after-repair.flac"),
        accepted_at=now + timedelta(seconds=2),
    )
    assert later.generation_id != covered.generation_id
    assert _repository(scope.worker_url).dispatch_ready(
        now=now + timedelta(seconds=2), limit=32
    ) == (later.generation_id,)


def test_repair_waits_for_captured_cross_root_barrier_peer_generation(
    live_watcher_database,
):
    import psycopg

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_recovery = _repository(scope.app_url)
    repaired_generation = app_recovery.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now,
    )
    _publish_watcher_generation(
        scope,
        repaired_generation.generation_id,
        now=now + timedelta(seconds=1),
        worker_id="repair-barrier-root",
    )
    peer_generation = app_recovery.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-b", "barrier-peer.flac"),
        accepted_at=now + timedelta(seconds=2),
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        barrier_id = int(
            connection.execute(
                """
                insert into library.watcher_barriers (library_id, created_at)
                values (%s, %s) returning id
                """,
                (scope.library_id, now + timedelta(seconds=2)),
            ).fetchone()["id"]
        )
        connection.execute(
            """
            insert into library.watcher_barrier_participants (
              barrier_id, generation_id, library_id, root_id, accepted_sequence
            )
            select %s, %s, lane.library_id, lane.root_id, lane.accepted_sequence
            from library.watcher_lanes as lane
            where lane.library_id = %s and lane.root_id = %s
            union all
            select %s, %s, lane.library_id, lane.root_id, lane.accepted_sequence
            from library.watcher_lanes as lane
            where lane.library_id = %s and lane.root_id = %s
            """,
            (
                barrier_id,
                repaired_generation.generation_id,
                scope.library_id,
                scope.root_database_ids["root-a"],
                barrier_id,
                peer_generation.generation_id,
                scope.library_id,
                scope.root_database_ids["root-b"],
            ),
        )
    repair_id = _seed_scanning_repair(scope, now=now, logical_root_id="root-a")
    full = _claim_linked_full_scan(
        scope,
        repair_id=repair_id,
        now=now + timedelta(seconds=3),
        request_ref="watcher:repair-barrier-peer",
    )

    _publish_linked_full_scan(*full, now=now + timedelta(seconds=4))

    with isolatedPostgres._connect(scope.setup_url) as connection:
        waiting = connection.execute(
            """
            select repair.state, repair.completed_at, incident.resolved_at,
                   barrier.completed_at as barrier_completed_at
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            join library.watcher_barrier_participants as touched
              on touched.library_id = repair_root.library_id
             and touched.root_id = repair_root.root_id
            join library.watcher_barriers as barrier on barrier.id = touched.barrier_id
            where repair.id = %s and barrier.id = %s
            """,
            (repair_id, barrier_id),
        ).fetchone()
        links = connection.execute(
            """
            select generation_id from library.watcher_generation_repairs
            where repair_id = %s
            """,
            (repair_id,),
        ).fetchall()
    assert waiting["state"] == "catch_up"
    assert waiting["completed_at"] is None
    assert waiting["resolved_at"] is None
    assert waiting["barrier_completed_at"] is None
    assert {row["generation_id"] for row in links} == {peer_generation.generation_id}

    _publish_watcher_generation(
        scope,
        peer_generation.generation_id,
        now=now + timedelta(seconds=5),
        worker_id="repair-barrier-peer-targeted",
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state, repair.completed_at, incident.resolved_at,
                   barrier.completed_at as barrier_completed_at
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            join library.watcher_barrier_participants as touched
              on touched.library_id = repair_root.library_id
             and touched.root_id = repair_root.root_id
            join library.watcher_barriers as barrier on barrier.id = touched.barrier_id
            where repair.id = %s and barrier.id = %s
            """,
            (repair_id, barrier_id),
        ).fetchone()
    assert completed["state"] == "complete"
    assert completed["completed_at"] is not None
    assert completed["resolved_at"] is not None
    assert completed["barrier_completed_at"] is not None
    with isolatedPostgres._connect(scope.worker_url) as connection:
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as denied:
            connection.execute(
                "select * from library.targeted_reconciliation_intent_moves"
            ).fetchall()
        assert denied.value.sqlstate == "42501"


def test_internal_watcher_helpers_are_denied_to_every_runtime_role(
    live_watcher_database,
):
    scope = live_watcher_database
    helper_signatures = (
        "library.local_root_relative_path(text,text)",
        "library.reject_watcher_incident_identity_change()",
        "library.prepare_legacy_watcher_rollback(timestamptz)",
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        for signature in helper_signatures:
            assert connection.execute(
                "select to_regprocedure(%s) is not null as present",
                (signature,),
            ).fetchone()["present"] is True
            for role in (
                "album_haven_app",
                "album_haven_worker",
                "album_haven_readonly",
            ):
                assert connection.execute(
                    "select has_function_privilege(%s, %s, 'EXECUTE') as allowed",
                    (role, signature),
                ).fetchone()["allowed"] is False


def test_worker_startup_preflight_requires_live_watcher_functions_and_grants(
    live_watcher_database,
):
    scope = live_watcher_database
    registered_kinds = sorted(kind.value for kind in JobKind)

    with isolatedPostgres._connect(scope.worker_url) as connection:
        row = connection.execute(
            "select ops.validate_durable_worker_startup(%s::text[]) as valid",
            (registered_kinds,),
        ).fetchone()

    assert row["valid"] is True


def test_same_root_events_coalesce_into_one_durable_successor(live_watcher_database):
    scope = live_watcher_database
    repository = _repository(scope.app_url)

    first = repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "first.mp3"),
        accepted_at=NOW,
    )
    second = repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "second.mp3"),
        accepted_at=NOW + timedelta(milliseconds=1),
    )

    assert second.generation_id == first.generation_id
    assert second.coalesced is True
    with isolatedPostgres._connect(scope.setup_url) as connection:
        lane = connection.execute(
            """
            select accepted_sequence, successor_generation_id
            from library.watcher_lanes where library_id = %s and root_id = %s
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()
    assert lane["accepted_sequence"] == 2
    assert lane["successor_generation_id"] == first.generation_id


def test_sql_coalescing_algebra_owns_scope_reduction(live_watcher_database):
    scope = live_watcher_database
    repository = _repository(scope.app_url)
    move_chain = (
        LibraryEvent(
            LibraryEventKind.MOVED,
            "root-a",
            scope.root_paths["root-a"] / "a.mp3",
            destination=scope.root_paths["root-a"] / "b.mp3",
            destination_root_id="root-a",
        ),
        LibraryEvent(
            LibraryEventKind.MOVED,
            "root-a",
            scope.root_paths["root-a"] / "b.mp3",
            destination=scope.root_paths["root-a"] / "c.mp3",
            destination_root_id="root-a",
        ),
        LibraryEvent(
            LibraryEventKind.DELETED,
            "root-a",
            scope.root_paths["root-a"] / "c.mp3",
        ),
    )
    move_generation = None
    for offset, event in enumerate(move_chain):
        move_generation = repository.accept_event(
            library_id=scope.library_id,
            event=event,
            accepted_at=NOW + timedelta(milliseconds=offset),
        ).generation_id

    directory_generation = repository.accept_event(
        library_id=scope.library_id,
        event=LibraryEvent(
            LibraryEventKind.DELETED,
            "root-b",
            scope.root_paths["root-b"] / "dir",
            is_directory=True,
        ),
        accepted_at=NOW,
    ).generation_id
    assert repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-b", "dir/child.mp3"),
        accepted_at=NOW + timedelta(milliseconds=1),
    ).generation_id == directory_generation
    cross_generation = repository.accept_event(
        library_id=scope.library_id,
        event=_moved(scope, "root-c", "root-d", "cross.mp3"),
        accepted_at=NOW,
    ).generation_id

    with isolatedPostgres._connect(scope.setup_url) as connection:
        move_paths = connection.execute(
            """
            select path_kind, relative_path
            from library.targeted_reconciliation_intent_paths
            where intent_id = %s
            order by path_kind, relative_path
            """,
            (move_generation,),
        ).fetchall()
        directory_paths = connection.execute(
            """
            select path_kind, relative_path
            from library.targeted_reconciliation_intent_paths
            where intent_id = %s
            order by path_kind, relative_path
            """,
            (directory_generation,),
        ).fetchall()
        cross_move = connection.execute(
            """
            select source_relative_path, destination_relative_path,
                   source_root_id, destination_root_id, is_directory
            from library.targeted_reconciliation_intent_moves
            where intent_id = %s
            """,
            (cross_generation,),
        ).fetchone()
    assert [dict(row) for row in move_paths] == [
        {"path_kind": "deleted", "relative_path": "a.mp3"},
        {"path_kind": "deleted", "relative_path": "b.mp3"},
        {"path_kind": "deleted", "relative_path": "c.mp3"},
    ]
    assert [dict(row) for row in directory_paths] == [
        {"path_kind": "active", "relative_path": "dir/child.mp3"},
        {"path_kind": "deleted_subtree", "relative_path": "dir"},
        {"path_kind": "preserved_subtree", "relative_path": "dir"},
    ]
    assert dict(cross_move) == {
        "source_relative_path": "old/cross.mp3",
        "destination_relative_path": "new/cross.mp3",
        "source_root_id": scope.root_database_ids["root-c"],
        "destination_root_id": scope.root_database_ids["root-d"],
        "is_directory": False,
    }


def test_cross_root_move_destination_cancels_matching_tombstone(
    live_watcher_database,
):
    scope = live_watcher_database
    repository = _repository(scope.app_url)
    original = scope.root_paths["root-a"] / "Album/01.flac"
    temporary = scope.root_paths["root-b"] / "Album/01.flac"
    first = repository.accept_event(
        library_id=scope.library_id,
        event=LibraryEvent(
            LibraryEventKind.MOVED,
            "root-a",
            original,
            destination=temporary,
            destination_root_id="root-b",
        ),
        accepted_at=NOW,
    )
    second = repository.accept_event(
        library_id=scope.library_id,
        event=LibraryEvent(
            LibraryEventKind.MOVED,
            "root-b",
            temporary,
            destination=original,
            destination_root_id="root-a",
        ),
        accepted_at=NOW + timedelta(milliseconds=1),
    )

    assert second.generation_id == first.generation_id
    with isolatedPostgres._connect(scope.setup_url) as connection:
        rows = connection.execute(
            """
            select root.metadata ->> 'root_id' as root_id,
                   path.path_kind, path.relative_path
            from library.targeted_reconciliation_intent_paths as path
            join library.library_roots as root on root.id = path.root_id
            where path.intent_id = %s
            order by root_id, path_kind
            """,
            (first.generation_id,),
        ).fetchall()

    assert {
        (row["root_id"], row["path_kind"], row["relative_path"])
        for row in rows
    } == {
        ("root-a", "active", "Album/01.flac"),
        ("root-b", "deleted", "Album/01.flac"),
    }


def test_cross_root_generation_publishes_stale_scope_for_each_root(
    live_watcher_database,
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_recovery = _repository(scope.app_url)
    source = scope.root_paths["root-a"] / "old/01.flac"
    destination = scope.root_paths["root-b"] / "new/01.flac"
    accepted = app_recovery.accept_event(
        library_id=scope.library_id,
        event=LibraryEvent(
            LibraryEventKind.MOVED,
            "root-a",
            source,
            destination=destination,
            destination_root_id="root-b",
        ),
        accepted_at=now,
    )
    removed = scope.root_paths["root-b"] / "removed/02.flac"
    assert app_recovery.accept_event(
        library_id=scope.library_id,
        event=LibraryEvent(LibraryEventKind.DELETED, "root-b", removed),
        accepted_at=now + timedelta(milliseconds=1),
    ).generation_id == accepted.generation_id
    worker_recovery = _repository(scope.worker_url)
    assert worker_recovery.dispatch_ready(
        now=now + timedelta(milliseconds=1), limit=32
    ) == (accepted.generation_id,)
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="watcher-multi-root-scope-worker",
        now=now + timedelta(milliseconds=1),
        lease_seconds=300,
        kinds=(JobKind.TARGETED_RECONCILIATION,),
    )
    assert claim is not None
    assert worker_recovery.claim_generation(
        claim=claim, now=now + timedelta(milliseconds=1)
    ) is not None
    scans = PostgresScanJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )

    result = scans.publish_claimed_targeted_reconciliation(
        claim=claim,
        intent_id=accepted.generation_id,
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        stale_scopes=(
            {"root_id": "root-a", "paths": [str(source)], "subtrees": []},
            {"root_id": "root-b", "paths": [str(removed)], "subtrees": []},
        ),
        now=now + timedelta(milliseconds=1),
    )

    assert result["publication_won"] is True


def test_acceptance_denies_an_inactive_root_without_creating_lane_or_intent(
    live_watcher_database,
):
    scope = live_watcher_database
    repository = _repository(scope.app_url)
    root_database_id = scope.root_database_ids["root-a"]
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            "update library.library_roots set is_active = false where id = %s",
            (root_database_id,),
        )

    with pytest.raises(ValueError, match="missing|inactive"):
        repository.accept_event(
            library_id=scope.library_id,
            event=_created(scope, "root-a", "inactive.mp3"),
            accepted_at=NOW,
        )

    with isolatedPostgres._connect(scope.setup_url) as connection:
        state = connection.execute(
            """
            select
              (select count(*) from library.watcher_lanes
               where library_id = %s and root_id = %s) as lane_count,
              (select count(*) from library.targeted_reconciliation_intents
               where library_id = %s and watcher_generation_kind is not null)
                as intent_count
            """,
            (scope.library_id, root_database_id, scope.library_id),
        ).fetchone()
    assert state == {"lane_count": 0, "intent_count": 0}


def test_cross_root_move_reserves_one_barrier_for_both_roots(live_watcher_database):
    scope = live_watcher_database
    repository = _repository(scope.app_url)
    accepted = repository.accept_event(
        library_id=scope.library_id,
        event=_moved(scope, "root-c", "root-d", "barrier.mp3"),
        accepted_at=NOW + timedelta(seconds=1),
    )

    with isolatedPostgres._connect(scope.setup_url) as connection:
        participants = connection.execute(
            """
            select participant.barrier_id, participant.root_id
            from library.watcher_barrier_participants participant
            where participant.generation_id = %s
            order by participant.root_id
            """,
            (accepted.generation_id,),
        ).fetchall()

    assert [row["root_id"] for row in participants] == sorted(
        (scope.root_database_ids["root-c"], scope.root_database_ids["root-d"])
    )
    assert len({row["barrier_id"] for row in participants}) == 1


def test_cross_root_move_merges_distinct_successors_without_losing_scope(
    live_watcher_database,
):
    scope = live_watcher_database
    repository = _repository(scope.app_url)
    source = repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "source-before.mp3"),
        accepted_at=NOW,
    )
    destination = repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-b", "destination-before.mp3"),
        accepted_at=NOW + timedelta(milliseconds=1),
    )
    assert source.generation_id != destination.generation_id

    merged = repository.accept_event(
        library_id=scope.library_id,
        event=_moved(scope, "root-a", "root-b", "moving.mp3"),
        accepted_at=NOW + timedelta(milliseconds=2),
    )

    assert merged.generation_id == min(source.generation_id, destination.generation_id)
    with isolatedPostgres._connect(scope.setup_url) as connection:
        lanes = connection.execute(
            """
            select successor_generation_id from library.watcher_lanes
            where library_id = %s and root_id = any(%s::bigint[])
            order by root_id
            """,
            (
                scope.library_id,
                [
                    scope.root_database_ids["root-a"],
                    scope.root_database_ids["root-b"],
                ],
            ),
        ).fetchall()
        exact_paths = connection.execute(
            """
            select relative_path from library.targeted_reconciliation_intent_paths
            where intent_id = %s order by relative_path
            """,
            (merged.generation_id,),
        ).fetchall()
    assert {row["successor_generation_id"] for row in lanes} == {
        merged.generation_id
    }
    assert {row["relative_path"] for row in exact_paths} == {
        "source-before.mp3",
        "destination-before.mp3",
        "old/moving.mp3",
        "new/moving.mp3",
    }


def test_successor_merge_locks_outer_participant_before_mutating_the_closure(
    live_watcher_database,
):
    scope = live_watcher_database
    repository = _repository(scope.app_url)
    first = repository.accept_event(
        library_id=scope.library_id,
        event=_moved(scope, "root-a", "root-c", "first.flac"),
        accepted_at=NOW,
    )
    second = repository.accept_event(
        library_id=scope.library_id,
        event=_moved(scope, "root-b", "root-d", "second.flac"),
        accepted_at=NOW + timedelta(milliseconds=1),
    )
    assert first.generation_id < second.generation_id

    second_connection_opened = Event()
    completed = Event()
    outcome = {}
    connection_count = 0

    def connect_with_signal(database_url):
        nonlocal connection_count
        connection = isolatedPostgres._connect(database_url)
        connection_count += 1
        if connection_count == 2:
            second_connection_opened.set()
        return connection

    merge_repository = _module().PostgresWatcherRecoveryRepository(
        database_url=scope.app_url,
        connect_to_database=connect_with_signal,
    )

    def merge_successors():
        try:
            outcome["accepted"] = merge_repository.accept_event(
                library_id=scope.library_id,
                event=_moved(scope, "root-a", "root-b", "merge.flac"),
                accepted_at=NOW + timedelta(milliseconds=2),
            )
        except BaseException as exc:
            outcome["error"] = exc
        finally:
            completed.set()

    thread = Thread(target=merge_successors, daemon=True)
    with isolatedPostgres._connect(scope.setup_url) as blocker:
        blocker.execute(
            """
            select 1 from library.watcher_lanes
            where library_id = %s and root_id = %s
            for update
            """,
            (scope.library_id, scope.root_database_ids["root-c"]),
        )
        thread.start()
        assert second_connection_opened.wait(10)
        completed_while_outer_participant_was_locked = completed.wait(2)
        blocker.rollback()

    thread.join(10)
    assert not thread.is_alive()
    assert not completed_while_outer_participant_was_locked
    assert "error" not in outcome
    assert outcome["accepted"].generation_id == first.generation_id


@pytest.mark.parametrize("reason_code", ["overflow", "root_unavailable"])
def test_mark_dirty_is_atomic_stable_and_single_successor(
    live_watcher_database,
    reason_code,
):
    scope = live_watcher_database
    repository = _repository(scope.app_url)
    root_id = "root-b"

    first = repository.mark_dirty(
        library_id=scope.library_id,
        logical_root_id=root_id,
        reason_code=reason_code,
        observed_at=NOW + timedelta(seconds=2),
    )
    second = repository.mark_dirty(
        library_id=scope.library_id,
        logical_root_id=root_id,
        reason_code=reason_code,
        observed_at=NOW + timedelta(seconds=3),
    )

    assert second.generation_id == first.generation_id
    assert second.incident_id == first.incident_id
    assert second.warning_token == first.warning_token
    with isolatedPostgres._connect(scope.setup_url) as connection:
        incident = connection.execute(
            """
            select occurrence_count from library.watcher_incidents
            where incident_id = %s
            """,
            (first.incident_id,),
        ).fetchone()
        generation = connection.execute(
            """
            select watcher_generation_kind from library.targeted_reconciliation_intents
            where id = %s
            """,
            (first.generation_id,),
        ).fetchone()
    assert incident["occurrence_count"] == 2
    assert generation["watcher_generation_kind"] == "root_catch_up"


def test_unresolved_watcher_incident_is_projected_through_health_store(
    live_watcher_database,
):
    from music_app.services.library_watch_health import (
        PostgresLibraryWatchHealthStore,
    )

    scope = live_watcher_database
    accepted = _repository(scope.app_url).mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=NOW,
    )

    store = PostgresLibraryWatchHealthStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": scope.app_url},
        connect=isolatedPostgres._connect,
    )
    problems = store.load()

    assert [
        (problem.root_id, problem.state, problem.event_id)
        for problem in problems
    ] == [("root-a", "overflow", accepted.warning_token)]


def test_app_acknowledges_durable_incidents_without_table_access(
    live_watcher_database,
):
    from music_app.services.library_warning_dismissals import (
        PostgresLibraryWarningDismissals,
        warning_token,
    )
    from music_app.services.library_watch_health import (
        PostgresLibraryWatchHealthStore,
    )

    scope = live_watcher_database
    _repository(scope.app_url).mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=NOW,
    )
    health = PostgresLibraryWatchHealthStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": scope.app_url},
        connect=isolatedPostgres._connect,
    ).load()
    expected = warning_token({
        "state": "warning",
        "problems": [problem.as_public_dict() for problem in health],
    })
    acknowledgements = PostgresLibraryWarningDismissals(
        {"ALBUM_HAVEN_APP_DATABASE_URL": scope.app_url},
        connect=isolatedPostgres._connect,
    )

    assert acknowledgements.load(scope.account_id) == ""
    acknowledgements.save(
        scope.account_id,
        expected,
        {
            "state": "warning",
            "problems": [problem.as_public_dict() for problem in health],
        },
    )
    assert acknowledgements.load(scope.account_id) == expected

    with isolatedPostgres._connect(scope.setup_url) as connection:
        count = connection.execute(
            """
            select count(*) as count
            from library.watcher_incident_acknowledgements
            where account_id = %s
            """,
            (scope.account_id,),
        ).fetchone()["count"]
        assert count == 1


def test_running_full_scan_repairs_a_later_incident_through_root_catch_up(
    live_watcher_database,
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    scans = PostgresScanJobRepository(
        database_url=scope.app_url,
        connect_to_database=isolatedPostgres._connect,
    )
    accepted = scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:running-background-scan",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-a",),
        mode="background",
        force=False,
        scheduled_at=now - timedelta(seconds=1),
    )
    worker_scans, claim, intent, claimed_scope = _claim_enqueued_full_scan(
        scope,
        now=now,
        request_ref="watcher:running-background-scan",
        worker_id="watcher-running-full-scan",
    )
    assert claim is not None and claim.job_id == accepted.job_id
    _repository(scope.app_url).mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now + timedelta(seconds=1),
    )

    repair_request = scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:repair-after-running-scan",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-a",),
        mode="manual_full_rescan",
        force=True,
        scheduled_at=now + timedelta(seconds=2),
    )
    assert repair_request.intent_id == accepted.intent_id
    assert repair_request.job_id == accepted.job_id

    _publish_linked_full_scan(
        worker_scans,
        repair_request,
        claim,
        intent,
        claimed_scope,
        now=now + timedelta(seconds=3),
    )

    with isolatedPostgres._connect(scope.setup_url) as connection:
        state = connection.execute(
            """
            select intent.watcher_repair_id, repair.state, incident.resolved_at,
                   lane.successor_generation_id
            from library.full_scan_intents as intent
            join library.watcher_repairs as repair
              on repair.id = intent.watcher_repair_id
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            join library.watcher_lanes as lane
              on lane.library_id = repair_root.library_id
             and lane.root_id = repair_root.root_id
            where intent.id = %s
            """,
            (accepted.intent_id,),
        ).fetchone()
    assert state["watcher_repair_id"] is not None
    assert state["state"] == "catch_up"
    assert state["resolved_at"] is None
    assert state["successor_generation_id"] is not None

    _publish_watcher_generation(
        scope,
        state["successor_generation_id"],
        now=now + timedelta(seconds=4),
        worker_id="watcher-running-full-scan-catch-up",
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state, incident.resolved_at
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            where repair.id = %s
            """,
            (state["watcher_repair_id"],),
        ).fetchone()
    assert completed["state"] == "complete"
    assert completed["resolved_at"] is not None


def test_queued_full_scan_extends_scope_and_completes_later_root_repair(
    live_watcher_database,
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    scans = PostgresScanJobRepository(
        database_url=scope.app_url,
        connect_to_database=isolatedPostgres._connect,
    )
    existing = scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:queued-narrow-scan",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-a",),
        mode="background",
        force=False,
        scheduled_at=now,
    )
    _repository(scope.app_url).mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-b",
        reason_code="overflow",
        observed_at=now + timedelta(seconds=1),
    )
    repair_request = scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:queued-scope-extension",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-b",),
        mode="manual_full_rescan",
        force=True,
        scheduled_at=now + timedelta(seconds=2),
    )
    assert repair_request.intent_id == existing.intent_id
    assert repair_request.job_id == existing.job_id

    worker_scans, claim, intent, claimed_scope = _claim_enqueued_full_scan(
        scope,
        now=now + timedelta(seconds=2),
        request_ref="watcher:queued-scope-extension",
    )
    assert {root["id"] for root in claimed_scope.roots} == {"root-a", "root-b"}
    _publish_linked_full_scan(
        worker_scans,
        repair_request,
        claim,
        intent,
        claimed_scope,
        now=now + timedelta(seconds=3),
    )

    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state, incident.resolved_at
            from library.full_scan_intents as intent
            join library.watcher_repairs as repair
              on repair.id = intent.watcher_repair_id
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            where intent.id = %s and repair_root.root_id = %s
            """,
            (existing.intent_id, scope.root_database_ids["root-b"]),
        ).fetchone()
    assert completed["state"] == "complete"
    assert completed["resolved_at"] is not None


def test_active_full_scan_retry_extends_its_existing_repair_without_relinking(
    live_watcher_database,
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    recovery = _repository(scope.app_url)
    scans = PostgresScanJobRepository(
        database_url=scope.app_url,
        connect_to_database=isolatedPostgres._connect,
    )
    recovery.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now,
    )
    accepted = scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:repair-broad-scope",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-a", "root-b"),
        mode="manual_full_rescan",
        force=True,
        scheduled_at=now + timedelta(seconds=3),
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        original_repair_id = connection.execute(
            "select watcher_repair_id from library.full_scan_intents where id = %s",
            (accepted.intent_id,),
        ).fetchone()["watcher_repair_id"]

    recovery.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-b",
        reason_code="root_unavailable",
        observed_at=now + timedelta(seconds=1),
    )
    retried = scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:repair-narrower-retry",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-b",),
        mode="manual_full_rescan",
        force=True,
        scheduled_at=now + timedelta(seconds=2),
    )

    assert retried.intent_id == accepted.intent_id
    assert retried.job_id == accepted.job_id
    with isolatedPostgres._connect(scope.setup_url) as connection:
        linked = connection.execute(
            """
            select intent.watcher_repair_id,
                   pg_catalog.array_agg(root.metadata ->> 'root_id' order by root.id)
                     as logical_root_ids,
                   (select pg_catalog.count(*)
                    from library.watcher_repairs as repair
                    where repair.library_id = intent.library_id
                      and repair.state = 'scanning') as scanning_repairs
            from library.full_scan_intents as intent
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = intent.watcher_repair_id
            join library.library_roots as root
              on root.library_id = repair_root.library_id
             and root.id = repair_root.root_id
            where intent.id = %s
            group by intent.id
            """,
            (accepted.intent_id,),
        ).fetchone()
    assert linked == {
        "watcher_repair_id": original_repair_id,
        "logical_root_ids": ["root-a", "root-b"],
        "scanning_repairs": 1,
    }


@pytest.mark.parametrize("preexisting_full_scan", [False, True])
def test_manual_full_scan_automatically_completes_durable_watcher_repair(
    live_watcher_database, preexisting_full_scan,
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    scans = PostgresScanJobRepository(
        database_url=scope.app_url,
        connect_to_database=isolatedPostgres._connect,
    )
    existing = None
    if preexisting_full_scan:
        existing = scans.enqueue_full_scan(
            library_id=scope.library_id,
            account_id=scope.account_id,
            capability_key="library.refresh",
            request_origin_ref="watcher:existing-background-scan",
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            root_ids=("root-a",),
            mode="background",
            force=False,
            scheduled_at=now - timedelta(seconds=2),
        )
    _repository(scope.app_url).mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now,
    )
    accepted = scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:auto-repair",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-a",),
        mode="manual_full_rescan",
        force=True,
        scheduled_at=now - timedelta(seconds=1),
    )
    if existing is not None:
        assert accepted.intent_id == existing.intent_id
        assert accepted.job_id == existing.job_id
    with isolatedPostgres._connect(scope.setup_url) as connection:
        linked = connection.execute(
            """
            select intent.watcher_repair_id,
                   repair.state,
                   repair_root.captured_accepted_sequence,
                   repair_root.captured_dirty_generation
            from library.full_scan_intents as intent
            join library.watcher_repairs as repair
              on repair.id = intent.watcher_repair_id
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            where intent.id = %s and repair_root.root_id = %s
            """,
            (accepted.intent_id, scope.root_database_ids["root-a"]),
        ).fetchone()
    assert linked is not None
    assert linked["state"] == "scanning"
    assert linked["captured_accepted_sequence"] == 1
    assert linked["captured_dirty_generation"] == 1

    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="watcher-auto-repair-worker",
        now=now,
        lease_seconds=300,
        kinds=(JobKind.FULL_SCAN,),
    )
    assert claim is not None
    worker_scans = PostgresScanJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    intent = worker_scans.load_claimed_full_scan(
        job_id=claim.job_id,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
    )
    claimed_scope = worker_scans.load_claimed_full_scan_scope(
        intent_id=intent.intent_id,
        library_id=intent.library_id,
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=now,
    )
    publication = worker_scans.publish_claimed_full_scan(
        claim=claim,
        intent_id=accepted.intent_id,
        expected_inventory_mutation_revision=intent.inventory_mutation_revision,
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        observed_root_ids=[root["id"] for root in claimed_scope.roots],
        now=now,
    )
    assert publication["publication_won"] is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state, repair.inventory_revision,
                   incident.resolved_at
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            where repair.id = %s
            """,
            (linked["watcher_repair_id"],),
        ).fetchone()
    assert completed["state"] == "complete"
    assert completed["inventory_revision"] == publication[
        "inventory_mutation_revision"
    ]
    assert completed["resolved_at"] is not None


def test_mark_dirty_rolls_back_lane_generation_and_incident_together(
    live_watcher_database,
):
    import psycopg

    scope = live_watcher_database
    repository = _repository(scope.app_url)
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            """
            create function library.test_fail_mark_dirty() returns trigger
            language plpgsql as $$
            begin
              raise exception 'forced mark-dirty rollback';
            end;
            $$
            """
        )
        connection.execute(
            """
            create trigger test_fail_mark_dirty
            before insert or update on library.watcher_incidents
            for each row execute function library.test_fail_mark_dirty()
            """
        )
    try:
        with pytest.raises(
            psycopg.errors.RaiseException,
            match="forced mark-dirty rollback",
        ):
            repository.mark_dirty(
                library_id=scope.library_id,
                logical_root_id="root-a",
                reason_code="overflow",
                observed_at=NOW,
            )
        with isolatedPostgres._connect(scope.setup_url) as connection:
            state = connection.execute(
                """
                select
                  (select count(*) from library.watcher_lanes
                   where library_id = %s and root_id = %s) as lane_count,
                  (select count(*) from library.watcher_incidents
                   where library_id = %s and root_id = %s) as incident_count,
                  (select count(*) from library.targeted_reconciliation_intents
                   where library_id = %s) as generation_count
                """,
                (
                    scope.library_id,
                    scope.root_database_ids["root-a"],
                    scope.library_id,
                    scope.root_database_ids["root-a"],
                    scope.library_id,
                ),
            ).fetchone()
        assert state == {
            "lane_count": 0,
            "incident_count": 0,
            "generation_count": 0,
        }
    finally:
        with isolatedPostgres._connect(scope.setup_url) as connection:
            connection.execute(
                "drop trigger if exists test_fail_mark_dirty on library.watcher_incidents"
            )
            connection.execute("drop function if exists library.test_fail_mark_dirty()")


def test_worker_dispatch_promotes_every_cross_root_participant_atomically(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=_moved(scope, "root-c", "root-d", "dispatch.mp3"),
        accepted_at=now,
    )

    assert worker_repository.dispatch_ready(now=now, limit=32) == (
        accepted.generation_id,
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        rows = connection.execute(
            """
            select running_generation_id, successor_generation_id, running_job_id
            from library.watcher_lanes
            where library_id = %s and root_id = any(%s::bigint[])
            order by root_id
            """,
            (
                scope.library_id,
                [
                    scope.root_database_ids["root-c"],
                    scope.root_database_ids["root-d"],
                ],
            ),
        ).fetchall()
    assert len(rows) == 2
    assert {row["running_generation_id"] for row in rows} == {accepted.generation_id}
    assert {row["successor_generation_id"] for row in rows} == {None}
    assert len({row["running_job_id"] for row in rows}) == 1


def test_dispatch_honors_next_eligible_and_preserves_watcher_job_context(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "delayed.mp3"),
        accepted_at=NOW,
    )
    eligible_at = NOW + timedelta(minutes=5)
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            """
            update library.watcher_lanes
            set next_eligible_at = %s
            where library_id = %s and root_id = %s
            """,
            (
                eligible_at,
                scope.library_id,
                scope.root_database_ids["root-a"],
            ),
        )

    assert worker_repository.dispatch_ready(
        now=eligible_at - timedelta(microseconds=1),
        limit=32,
    ) == ()
    assert worker_repository.dispatch_ready(now=eligible_at, limit=32) == (
        accepted.generation_id,
    )

    with isolatedPostgres._connect(scope.setup_url) as connection:
        job = connection.execute(
            """
            select kind, subject_kind, subject_ref, parameters, library_id,
                   deployment_mode, client_surface, scope_version,
                   resource_revision, idempotency_key, max_attempts,
                   recovery_policy, scheduled_at
            from ops.jobs
            where subject_kind = 'targeted_reconciliation_intent'
              and subject_ref = %s
            """,
            (str(accepted.generation_id),),
        ).fetchone()

    assert job == {
        "kind": "targeted_reconciliation",
        "subject_kind": "targeted_reconciliation_intent",
        "subject_ref": str(accepted.generation_id),
        "parameters": {"intent_id": accepted.generation_id},
        "library_id": scope.library_id,
        "deployment_mode": "self_hosted_private_web",
        "client_surface": "library_watcher",
        "scope_version": 1,
        "resource_revision": 1,
        "idempotency_key": f"watcher-generation:{accepted.generation_id}",
        "max_attempts": 3,
        "recovery_policy": "retry_safe",
        "scheduled_at": eligible_at,
    }


def test_dispatch_rolls_back_job_link_and_lane_promotion_on_link_failure(
    live_watcher_database,
):
    import psycopg

    scope = live_watcher_database
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "dispatch-rollback.mp3"),
        accepted_at=NOW,
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            """
            create function library.test_fail_watcher_link() returns trigger
            language plpgsql as $$
            begin
              if new.watcher_job_linked_at is distinct from old.watcher_job_linked_at then
                raise exception 'forced watcher link rollback';
              end if;
              return new;
            end;
            $$
            """
        )
        connection.execute(
            """
            create trigger test_fail_watcher_link
            before update on library.targeted_reconciliation_intents
            for each row execute function library.test_fail_watcher_link()
            """
        )
    try:
        with pytest.raises(
            psycopg.errors.RaiseException,
            match="forced watcher link rollback",
        ):
            worker_repository.dispatch_ready(now=NOW + timedelta(seconds=1), limit=32)
        with isolatedPostgres._connect(scope.setup_url) as connection:
            lane = connection.execute(
                """
                select running_generation_id, running_job_id, successor_generation_id
                from library.watcher_lanes where library_id = %s and root_id = %s
                """,
                (scope.library_id, scope.root_database_ids["root-a"]),
            ).fetchone()
            linked_jobs = connection.execute(
                """
                select count(*) as job_count from ops.jobs
                where subject_kind = 'targeted_reconciliation_intent'
                  and subject_ref = %s
                """,
                (str(accepted.generation_id),),
            ).fetchone()
        assert lane == {
            "running_generation_id": None,
            "running_job_id": None,
            "successor_generation_id": accepted.generation_id,
        }
        assert linked_jobs["job_count"] == 0
    finally:
        with isolatedPostgres._connect(scope.setup_url) as connection:
            connection.execute(
                "drop trigger if exists test_fail_watcher_link on "
                "library.targeted_reconciliation_intents"
            )
            connection.execute("drop function if exists library.test_fail_watcher_link()")


def _seed_claimed_linked_full_scan(
    scope,
    *,
    now: datetime,
    request_origin_ref: str,
    worker_id: str,
) -> SimpleNamespace:
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    app_repository.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now,
    )
    repair_id = _seed_scanning_repair(
        scope,
        now=now,
        logical_root_id="root-a",
    )
    worker_scans, full_scan, claim, intent, claimed_scope = (
        _claim_linked_full_scan(
            scope,
            repair_id=repair_id,
            now=now,
            request_ref=request_origin_ref,
            worker_id=worker_id,
        )
    )
    return SimpleNamespace(
        repair_id=repair_id,
        app_repository=app_repository,
        worker_repository=worker_repository,
        jobs=PostgresJobRepository(
            database_url=scope.worker_url,
            connect_to_database=isolatedPostgres._connect,
        ),
        worker_scans=worker_scans,
        full_scan=full_scan,
        claim=claim,
        intent=intent,
        scope=claimed_scope,
    )


def _wait_for_blocked_backend(
    observer,
    *,
    query_pid: int,
    blocking_pid: int,
    timeout: float = 15,
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        observer.execute("select pg_catalog.pg_stat_clear_snapshot()")
        blocked = observer.execute(
            """
            select 1
            from pg_catalog.pg_stat_activity
            where pid = %s
              and %s = any(pg_catalog.pg_blocking_pids(pid))
            """,
            (query_pid, blocking_pid),
        ).fetchone()
        if blocked is not None:
            return True
        time.sleep(0.02)
    return False


def test_full_scan_publication_completes_linked_watcher_repair(
    live_watcher_database,
):
    scope = live_watcher_database
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=NOW,
        request_origin_ref="watcher:repair-publication",
        worker_id="watcher-repair-worker",
    )
    publication = seeded.worker_scans.publish_claimed_full_scan(
        claim=seeded.claim,
        intent_id=seeded.full_scan.intent_id,
        expected_inventory_mutation_revision=(
            seeded.intent.inventory_mutation_revision
        ),
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        observed_root_ids=[root["id"] for root in seeded.scope.roots],
        now=NOW,
    )
    assert publication["publication_won"] is True, publication

    with isolatedPostgres._connect(scope.setup_url) as connection:
        repair = connection.execute(
            "select state, inventory_revision, completed_at "
            "from library.watcher_repairs where id = %s",
            (seeded.repair_id,),
        ).fetchone()
        incident = connection.execute(
            "select resolved_at from library.watcher_incidents "
            "where library_id = %s and root_id = %s",
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()
    assert repair["state"] == "complete"
    assert repair["inventory_revision"] == publication["inventory_mutation_revision"]
    assert repair["completed_at"] is not None
    assert incident["resolved_at"] is not None


def test_full_scan_publication_routes_late_repair_through_root_catch_up(
    live_watcher_database,
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:late-admission-background",
        worker_id="watcher-late-admission-worker",
    )
    app_scans = PostgresScanJobRepository(
        database_url=scope.app_url,
        connect_to_database=isolatedPostgres._connect,
    )
    publication = seeded.worker_scans.publish_claimed_full_scan(
        claim=seeded.claim,
        intent_id=seeded.full_scan.intent_id,
        expected_inventory_mutation_revision=seeded.intent.inventory_mutation_revision,
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        observed_root_ids=[root["id"] for root in seeded.scope.roots],
        now=now + timedelta(seconds=1),
    )
    assert publication["publication_won"] is True
    seeded.app_repository.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now + timedelta(seconds=2),
    )

    repair_request = app_scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:late-admission-repair",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-a",),
        mode="manual_full_rescan",
        force=True,
        scheduled_at=now + timedelta(seconds=3),
    )
    assert repair_request.intent_id == seeded.full_scan.intent_id
    assert repair_request.job_id == seeded.claim.job_id
    assert repair_request.created is False

    with isolatedPostgres._connect(scope.setup_url) as connection:
        state = connection.execute(
            """
            select intent.watcher_repair_id, original.state as original_repair_state,
                   repair.id as repair_id, job.state as job_state, repair.state,
                   incident.resolved_at,
                   lane.successor_generation_id,
                   generation.watcher_generation_kind,
                   lane.accepted_sequence, lane.applied_sequence,
                   lane.dirty_generation, lane.repaired_dirty_generation,
                   participant.accepted_sequence_lower,
                   participant.accepted_sequence_upper,
                   participant.dirty_generation as participant_dirty_generation
              from library.full_scan_intents as intent
              join ops.jobs as job on job.id = intent.job_id
              join library.watcher_repairs as original
                on original.id = intent.watcher_repair_id
              join library.watcher_repairs as repair
                on repair.library_id = intent.library_id
               and repair.id <> original.id
               and repair.state = 'catch_up'
              join library.watcher_repair_roots as repair_root
                on repair_root.repair_id = repair.id
              join library.watcher_incidents as incident
                on incident.incident_id = repair_root.incident_id
              join library.watcher_lanes as lane
                on lane.library_id = repair_root.library_id
               and lane.root_id = repair_root.root_id
              join library.targeted_reconciliation_intents as generation
                on generation.id = lane.successor_generation_id
              join library.watcher_generation_repairs as generation_repair
                on generation_repair.generation_id = generation.id
               and generation_repair.repair_id = repair.id
              join library.watcher_generation_participants as participant
                on participant.generation_id = generation.id
               and participant.library_id = lane.library_id
               and participant.root_id = lane.root_id
             where intent.id = %s
            """,
            (seeded.full_scan.intent_id,),
        ).fetchone()
    assert state == {
        "watcher_repair_id": seeded.repair_id,
        "original_repair_state": "complete",
        "repair_id": state["repair_id"],
        "job_state": "running",
        "state": "catch_up",
        "resolved_at": None,
        "successor_generation_id": state["successor_generation_id"],
        "watcher_generation_kind": "root_catch_up",
        "accepted_sequence": 2,
        "applied_sequence": 1,
        "dirty_generation": 2,
        "repaired_dirty_generation": 1,
        "accepted_sequence_lower": 2,
        "accepted_sequence_upper": 2,
        "participant_dirty_generation": 2,
    }

    assert seeded.jobs.finish(
        seeded.claim,
        JobTransitionResult(JobState.SUCCEEDED, "scan_completed"),
        now=now + timedelta(seconds=4),
    ) is True
    _publish_watcher_generation(
        scope,
        state["successor_generation_id"],
        now=now + timedelta(seconds=5),
        worker_id="watcher-late-admission-catch-up",
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state, incident.resolved_at,
                   intent.watcher_repair_id,
                   original.state as original_repair_state
              from library.watcher_repairs as repair
              join library.watcher_repair_roots as repair_root
                on repair_root.repair_id = repair.id
              join library.watcher_incidents as incident
                on incident.incident_id = repair_root.incident_id
              join library.full_scan_intents as intent
                on intent.id = %s
              join library.watcher_repairs as original
                on original.id = intent.watcher_repair_id
             where repair.id = %s
            """,
            (seeded.full_scan.intent_id, state["repair_id"]),
        ).fetchone()
    assert completed["state"] == "complete"
    assert completed["resolved_at"] is not None
    assert completed["watcher_repair_id"] == seeded.repair_id
    assert completed["original_repair_state"] == "complete"


def test_repair_admission_and_linked_publication_share_job_before_repair_lock(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:admission-publication-order",
        worker_id="watcher-admission-publication-worker",
    )
    publication = {}
    publication_errors = []
    publisher_ready = Event()
    publisher_pid = []
    inventory = json.dumps(
        {
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        }
    )

    def publish() -> None:
        try:
            with isolatedPostgres._connect(scope.worker_url) as connection:
                connection.execute("set statement_timeout = '15s'")
                publisher_pid.append(
                    connection.execute("select pg_backend_pid() as pid").fetchone()["pid"]
                )
                publisher_ready.set()
                publication.update(
                    connection.execute(
                        """
                        select * from library.publish_claimed_full_scan(
                          %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s
                        )
                        """,
                        (
                            seeded.full_scan.intent_id,
                            seeded.claim.job_id,
                            seeded.claim.attempt,
                            seeded.claim.worker_id,
                            seeded.claim.lease_token,
                            seeded.intent.inventory_mutation_revision,
                            inventory,
                            [root["id"] for root in seeded.scope.roots],
                            now + timedelta(seconds=2),
                        ),
                    ).fetchone()
                )
        except BaseException as exc:
            publication_errors.append(exc)

    with (
        isolatedPostgres._connect(scope.setup_url) as admission,
        isolatedPostgres._connect(scope.setup_url) as observer,
    ):
        admission.execute("set statement_timeout = '15s'")
        admission_pid = admission.execute(
            "select pg_backend_pid() as pid"
        ).fetchone()["pid"]
        admission.execute(
            "select 1 from ops.jobs where id = %s for update",
            (seeded.claim.job_id,),
        )
        publisher = Thread(target=publish, daemon=True)
        publisher.start()
        assert publisher_ready.wait(timeout=5)
        assert _wait_for_blocked_backend(
            observer,
            query_pid=publisher_pid[0],
            blocking_pid=admission_pid,
        )
        retried = admission.execute(
            """
            select * from library.create_full_scan_intent_v2(
              %s, %s, 'library.refresh', %s,
              'self_hosted_private_web', 'private_web',
              'manual_full_rescan', true, %s, %s
            )
            """,
            (
                scope.library_id,
                scope.account_id,
                "watcher:admission-publication-retry",
                [scope.root_database_ids["root-a"]],
                now + timedelta(seconds=1),
            ),
        ).fetchone()
        admission.commit()
        publisher.join(timeout=20)

    assert not publisher.is_alive()
    assert publication_errors == []
    assert retried["intent_id"] == seeded.full_scan.intent_id
    assert retried["job_id"] == seeded.claim.job_id
    assert publication["publication_won"] is True


def test_linked_full_scan_lease_expiry_rolls_back_inventory_and_repair(
    live_watcher_database,
):
    import psycopg

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:repair-lease-expiry",
        worker_id="watcher-expired-publication-worker",
    )

    def load_state():
        with isolatedPostgres._connect(scope.setup_url) as connection:
            return connection.execute(
                """
                select coalesce(
                         nullif(library.metadata ->> 'inventory_mutation_revision', '')::bigint,
                         0
                       ) as inventory_mutation_revision,
                       repair.state as repair_state,
                       repair.inventory_revision as repair_inventory_revision,
                       repair.completed_at as repair_completed_at,
                       intent.committed_inventory_revision,
                       job.lease_expires_at
                from library.libraries as library
                join library.watcher_repairs as repair on repair.id = %s
                join library.full_scan_intents as intent on intent.id = %s
                join ops.jobs as job on job.id = %s
                where library.id = %s
                """,
                (
                    seeded.repair_id,
                    seeded.full_scan.intent_id,
                    seeded.claim.job_id,
                    scope.library_id,
                ),
            ).fetchone()

    before = load_state()
    assert before["repair_state"] == "scanning"
    assert before["repair_inventory_revision"] is None
    assert before["repair_completed_at"] is None
    assert before["committed_inventory_revision"] is None
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            """
            create function library.test_expire_full_scan_lease()
            returns trigger
            language plpgsql
            as $$
            begin
              if new.committed_inventory_revision is distinct from
                 old.committed_inventory_revision then
                update ops.jobs
                set lease_expires_at = pg_catalog.clock_timestamp()
                                     - interval '1 second'
                where id = new.job_id;
              end if;
              return new;
            end;
            $$
            """
        )
        connection.execute(
            """
            create trigger test_expire_full_scan_lease
            after update of committed_inventory_revision
            on library.full_scan_intents
            for each row
            execute function library.test_expire_full_scan_lease()
            """
        )
    try:
        with pytest.raises(psycopg.errors.SerializationFailure):
            seeded.worker_scans.publish_claimed_full_scan(
                claim=seeded.claim,
                intent_id=seeded.full_scan.intent_id,
                expected_inventory_mutation_revision=(
                    seeded.intent.inventory_mutation_revision
                ),
                inventory={
                    "artists": [],
                    "albums": [],
                    "featured_artists": [],
                    "tracks": [],
                    "track_files": [],
                },
                observed_root_ids=[root["id"] for root in seeded.scope.roots],
                now=now,
            )
    finally:
        with isolatedPostgres._connect(scope.setup_url) as connection:
            connection.execute(
                "drop trigger if exists test_expire_full_scan_lease "
                "on library.full_scan_intents"
            )
            connection.execute(
                "drop function if exists library.test_expire_full_scan_lease()"
            )

    assert load_state() == before


def test_linked_full_scan_and_targeted_publication_share_repair_before_inventory_lock(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:publication-lock-order",
        worker_id="watcher-full-publication-worker",
    )

    accepted = seeded.app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "during-repair.mp3"),
        accepted_at=now + timedelta(seconds=1),
    )
    assert seeded.worker_repository.dispatch_ready(
        now=now + timedelta(seconds=1),
        limit=32,
    ) == (accepted.generation_id,)
    targeted_claim = seeded.jobs.claim(
        worker_id="watcher-targeted-publication-worker",
        now=now + timedelta(seconds=1),
        lease_seconds=300,
        kinds=(JobKind.TARGETED_RECONCILIATION,),
    )
    assert targeted_claim is not None
    targeted_intent = seeded.worker_scans.load_claimed_targeted_reconciliation(
        job_id=targeted_claim.job_id,
        worker_id=targeted_claim.worker_id,
        lease_token=targeted_claim.lease_token,
    )
    assert targeted_intent.watcher_generation_kind is not None
    assert seeded.worker_repository.claim_generation(
        claim=targeted_claim,
        now=now + timedelta(seconds=1),
    ) is not None
    targeted_scope = seeded.worker_scans.load_claimed_targeted_reconciliation_scope(
        intent_id=accepted.generation_id,
        library_id=scope.library_id,
        job_id=targeted_claim.job_id,
        attempt=targeted_claim.attempt,
        worker_id=targeted_claim.worker_id,
        lease_token=targeted_claim.lease_token,
        now=now + timedelta(seconds=1),
    )
    assert targeted_scope.scope_complete is True

    inventory = json.dumps(
        {
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        }
    )
    results = {}
    errors = []
    full_connected = Event()
    targeted_connected = Event()

    def publish_full_scan():
        try:
            with isolatedPostgres._connect(scope.worker_url) as connection:
                connection.execute("set local lock_timeout = '10s'")
                connection.execute("set local statement_timeout = '20s'")
                results["full_pid"] = connection.execute(
                    "select pg_backend_pid() as pid"
                ).fetchone()["pid"]
                full_connected.set()
                results["full"] = connection.execute(
                    """
                    select * from library.publish_claimed_full_scan(
                      %s, %s, %s, %s, %s, %s, %s::jsonb, %s::text[], %s
                    )
                    """,
                    (
                        seeded.full_scan.intent_id,
                        seeded.claim.job_id,
                        seeded.claim.attempt,
                        seeded.claim.worker_id,
                        seeded.claim.lease_token,
                        seeded.intent.inventory_mutation_revision,
                        inventory,
                        ["root-a"],
                        now + timedelta(seconds=2),
                    ),
                ).fetchone()
        except BaseException as error:
            errors.append(("full", error))

    def publish_targeted():
        try:
            with isolatedPostgres._connect(scope.worker_url) as connection:
                connection.execute("set local lock_timeout = '10s'")
                connection.execute("set local statement_timeout = '20s'")
                results["targeted_pid"] = connection.execute(
                    "select pg_backend_pid() as pid"
                ).fetchone()["pid"]
                targeted_connected.set()
                results["targeted"] = connection.execute(
                    """
                    select * from library.publish_claimed_targeted_reconciliation(
                      %s, %s, %s, %s, %s, %s::jsonb, '[]'::jsonb, %s
                    )
                    """,
                    (
                        accepted.generation_id,
                        targeted_claim.job_id,
                        targeted_claim.attempt,
                        targeted_claim.worker_id,
                        targeted_claim.lease_token,
                        inventory,
                        now + timedelta(seconds=2),
                    ),
                ).fetchone()
        except BaseException as error:
            errors.append(("targeted", error))

    full_thread = Thread(target=publish_full_scan, daemon=True)
    targeted_thread = Thread(target=publish_targeted, daemon=True)
    with isolatedPostgres._connect(scope.setup_url) as blocker:
        blocker_pid = blocker.execute(
            "select pg_backend_pid() as pid"
        ).fetchone()["pid"]
        blocker.execute(
            "select 1 from library.libraries where id = %s for update",
            (scope.library_id,),
        )
        full_thread.start()
        try:
            with isolatedPostgres._connect(scope.setup_url) as observer:
                assert full_connected.wait(timeout=5), errors
                full_pid = int(results["full_pid"])
                full_blocked = _wait_for_blocked_backend(
                    observer,
                    query_pid=full_pid,
                    blocking_pid=blocker_pid,
                )
                if full_blocked:
                    targeted_thread.start()
                    assert targeted_connected.wait(timeout=5), errors
                    targeted_pid = int(results["targeted_pid"])
                    targeted_blocked = _wait_for_blocked_backend(
                        observer,
                        query_pid=targeted_pid,
                        blocking_pid=full_pid,
                    )
        finally:
            blocker.commit()

    full_thread.join(timeout=25)
    if targeted_thread.ident is not None:
        targeted_thread.join(timeout=25)
    assert full_blocked, (
        "full publication never reached the held inventory row: "
        f"results={results!r}, errors={errors!r}"
    )
    assert targeted_blocked, (
        "targeted publication was not serialized behind full publication: "
        f"results={results!r}, errors={errors!r}"
    )
    assert not full_thread.is_alive()
    assert not targeted_thread.is_alive()
    assert errors == []
    assert results["full"]["publication_won"] is True
    assert results["targeted"]["publication_won"] is True
    assert (
        results["full"]["inventory_mutation_revision"]
        < results["targeted"]["inventory_mutation_revision"]
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        final_state = connection.execute(
            """
            select repair.state, repair.completed_at,
                   intent.watcher_completed_at,
                   lane.running_generation_id, lane.running_job_id,
                   lane.accepted_sequence, lane.applied_sequence
            from library.watcher_repairs repair
            join library.targeted_reconciliation_intents intent on intent.id = %s
            join library.watcher_lanes lane
              on lane.library_id = repair.library_id and lane.root_id = %s
            where repair.id = %s
            """,
            (
                accepted.generation_id,
                scope.root_database_ids["root-a"],
                seeded.repair_id,
            ),
        ).fetchone()
    assert final_state["state"] == "complete"
    assert final_state["completed_at"] is not None
    assert final_state["watcher_completed_at"] is not None
    assert final_state["running_generation_id"] is None
    assert final_state["running_job_id"] is None
    assert final_state["applied_sequence"] == final_state["accepted_sequence"]


def test_targeted_publication_and_failure_share_lane_before_intent_lock_order(
    live_watcher_database,
):
    import psycopg

    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "lock-order.mp3"),
        accepted_at=now,
    )
    assert worker_repository.dispatch_ready(now=now, limit=32) == (
        accepted.generation_id,
    )
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="watcher-lock-order-worker",
        now=now,
        lease_seconds=300,
        kinds=(JobKind.TARGETED_RECONCILIATION,),
    )
    assert claim is not None
    scans = PostgresScanJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    intent = scans.load_claimed_targeted_reconciliation(
        job_id=claim.job_id,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
    )
    assert intent.watcher_generation_kind is not None
    assert worker_repository.claim_generation(claim=claim, now=now) is not None
    scans.load_claimed_targeted_reconciliation_scope(
        intent_id=accepted.generation_id,
        library_id=scope.library_id,
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=now,
    )
    errors = []
    results = []

    def publish():
        try:
            results.append(scans.publish_claimed_targeted_reconciliation(
                claim=claim,
                intent_id=accepted.generation_id,
                inventory={
                    "artists": [],
                    "albums": [],
                    "featured_artists": [],
                    "tracks": [],
                    "track_files": [],
                },
                stale_scopes=(),
                now=now,
            ))
        except BaseException as error:
            errors.append(error)

    with isolatedPostgres._connect(scope.setup_url) as blocker:
        blocker_pid = blocker.execute("select pg_backend_pid() as pid").fetchone()["pid"]
        blocker.execute(
            """
            select 1 from library.watcher_lanes
            where library_id = %s and root_id = %s
            for update
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        )
        thread = Thread(target=publish, daemon=True)
        thread.start()
        deadline = time.monotonic() + 15
        blocked = False
        with isolatedPostgres._connect(scope.setup_url) as observer:
            while time.monotonic() < deadline:
                blocked = bool(
                    observer.execute(
                        """
                        select exists (
                            select 1 from pg_catalog.pg_stat_activity as activity
                            where %s = any(pg_catalog.pg_blocking_pids(activity.pid))
                        ) as blocked
                        """,
                        (blocker_pid,),
                    ).fetchone()["blocked"]
                )
                if blocked:
                    break
                time.sleep(0.02)
        assert blocked, (
            "targeted publication never reached the held watcher lane: "
            f"results={results!r}, errors={errors!r}"
        )
        failure = blocker.execute(
            """
            select * from library.fail_claimed_watcher_generation(
                %s, %s, %s, %s, %s, 'reconciliation_failed', %s
            )
            """,
            (
                accepted.generation_id,
                claim.job_id,
                claim.attempt,
                claim.worker_id,
                claim.lease_token,
                now,
            ),
        ).fetchone()
        assert failure["failed"] is True

    thread.join(timeout=5)
    assert not thread.is_alive()
    assert len(errors) == 1
    assert isinstance(errors[0], psycopg.errors.SerializationFailure)
    assert not isinstance(errors[0], psycopg.errors.DeadlockDetected)


def test_failed_cross_root_generation_marks_every_participant_dirty(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=_moved(scope, "root-a", "root-b", "failure.mp3"),
        accepted_at=now,
    )
    assert worker_repository.dispatch_ready(now=now, limit=32) == (
        accepted.generation_id,
    )
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="worker-failure",
        now=now,
        lease_seconds=30,
    )
    assert claim is not None
    generation = worker_repository.claim_generation(
        claim=claim,
        now=now,
    )
    assert generation is not None
    with isolatedPostgres._connect(scope.setup_url) as connection:
        repair_id = connection.execute(
            """
            insert into library.watcher_repairs (
              library_id, repair_generation, state, started_at
            ) values (%s, 1, 'catch_up', %s)
            returning id
            """,
            (scope.library_id, now),
        ).fetchone()["id"]
        connection.execute(
            """
            insert into library.watcher_generation_repairs (
              generation_id, repair_id, library_id, created_at
            ) values (%s, %s, %s, %s)
            """,
            (generation.generation_id, repair_id, scope.library_id, now),
        )

    assert worker_repository.fail_generation(
        claim=claim,
        generation=generation,
        reason_code="reconciliation_failed",
        now=now,
    ) is True
    with isolatedPostgres._connect(scope.setup_url) as connection:
        lanes = connection.execute(
            """
            select dirty_generation, successor_generation_id,
                   running_generation_id, running_job_id
            from library.watcher_lanes
            where library_id = %s and root_id = any(%s::bigint[])
            order by root_id
            """,
            (
                scope.library_id,
                [
                    scope.root_database_ids["root-a"],
                    scope.root_database_ids["root-b"],
                ],
            ),
        ).fetchall()
        incidents = connection.execute(
            """
            select root_id, reason_code from library.watcher_incidents
            where library_id = %s and resolved_at is null order by root_id
            """,
            (scope.library_id,),
        ).fetchall()
        successor_ids = {row["successor_generation_id"] for row in lanes}
        barrier_generations = connection.execute(
            """
            select distinct generation_id
            from library.watcher_barrier_participants
            where barrier_id = any(%s::bigint[])
            """,
            (list(generation.barrier_ids),),
        ).fetchall()
        repair_generations = connection.execute(
            """
            select generation_id
            from library.watcher_generation_repairs
            where repair_id = %s
            """,
            (repair_id,),
        ).fetchall()
        successor = connection.execute(
            """
            select watcher_generation_kind
            from library.targeted_reconciliation_intents
            where id = %s
            """,
            (next(iter(successor_ids)),),
        ).fetchone()
    assert [row["dirty_generation"] for row in lanes] == [1, 1]
    assert None not in successor_ids
    assert len(successor_ids) == 1
    assert all(row["running_generation_id"] is None for row in lanes)
    assert all(row["running_job_id"] is None for row in lanes)
    assert [row["root_id"] for row in incidents] == sorted(
        (scope.root_database_ids["root-a"], scope.root_database_ids["root-b"])
    )
    assert {row["reason_code"] for row in incidents} == {"reconciliation_failed"}
    successor_id = next(iter(successor_ids))
    assert successor["watcher_generation_kind"] == "root_catch_up"
    assert {row["generation_id"] for row in barrier_generations} == {successor_id}
    assert {row["generation_id"] for row in repair_generations} == {successor_id}


def test_claim_uses_generic_job_lease_and_database_clock(live_watcher_database):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "lease.mp3"),
        accepted_at=now,
    )
    assert worker_repository.dispatch_ready(now=now, limit=32) == (
        accepted.generation_id,
    )
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="worker-a",
        now=now,
        lease_seconds=30,
    )
    assert claim is not None
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            """
            update ops.jobs
            set lease_expires_at = clock_timestamp() - interval '1 second'
            where id = %s
            """,
            (claim.job_id,),
        )

    assert worker_repository.claim_generation(
        claim=claim,
        now=now - timedelta(days=365),
    ) is None
    assert not hasattr(worker_repository, "heartbeat_generation")


def test_terminal_cancellation_releases_lane_through_due_reconciliation(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "shutdown.mp3"),
        accepted_at=now,
    )
    assert worker_repository.dispatch_ready(
        now=now,
        limit=32,
    ) == (accepted.generation_id,)
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="worker-shutdown",
        now=now,
        lease_seconds=30,
    )
    assert claim is not None
    assert worker_repository.claim_generation(
        claim=claim,
        now=now,
    ) is not None
    assert jobs.finish(
        claim,
        JobTransitionResult(JobState.CANCELED, "worker_shutdown"),
        now=now,
    ) is True

    assert worker_repository.reconcile_due(
        now=now,
        limit=32,
    ) == (accepted.generation_id,)
    with isolatedPostgres._connect(scope.setup_url) as connection:
        lane = connection.execute(
            """
            select running_generation_id, running_job_id,
                   successor_generation_id, disposition_code
            from library.watcher_lanes
            where library_id = %s and root_id = %s
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()
        successor = connection.execute(
            """
            select watcher_generation_kind
            from library.targeted_reconciliation_intents
            where id = %s
            """,
            (lane["successor_generation_id"],),
        ).fetchone()

    assert lane["running_generation_id"] is None
    assert lane["running_job_id"] is None
    assert lane["successor_generation_id"] is not None
    assert lane["disposition_code"] == "dirty"
    assert successor["watcher_generation_kind"] == "root_catch_up"


def test_inactive_successor_is_retained_as_dirty_catch_up_until_reactivation(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "retired-before-dispatch.mp3"),
        accepted_at=now,
    )
    participant = accepted.participants[0]

    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            """
            update library.library_roots
            set is_active = false, updated_at = %s
            where library_id = %s and id = %s
            """,
            (
                now + timedelta(seconds=1),
                scope.library_id,
                scope.root_database_ids["root-a"],
            ),
        )

    assert worker_repository.reconcile_due(
        now=now + timedelta(seconds=2),
        limit=32,
    ) == (accepted.generation_id,)

    with isolatedPostgres._connect(scope.setup_url) as connection:
        lane = connection.execute(
            """
            select accepted_sequence, dirty_generation, catch_up_count,
                   running_generation_id, running_job_id,
                   successor_generation_id
            from library.watcher_lanes
            where library_id = %s and root_id = %s
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()
        generation = connection.execute(
            """
            select watcher_generation_kind, watcher_job_linked_at
            from library.targeted_reconciliation_intents
            where id = %s
            """,
            (accepted.generation_id,),
        ).fetchone()
        scope_counts = connection.execute(
            """
            select
              (select count(*)
               from library.targeted_reconciliation_intent_paths
               where intent_id = %s) as path_count,
              (select count(*)
               from library.targeted_reconciliation_intent_moves
               where intent_id = %s) as move_count,
              (select count(*)
               from ops.jobs
               where subject_kind = 'targeted_reconciliation_intent'
                 and subject_ref = %s) as job_count
            """,
            (
                accepted.generation_id,
                accepted.generation_id,
                str(accepted.generation_id),
            ),
        ).fetchone()
        incident = connection.execute(
            """
            select incident_id, warning_token, reason_code, occurrence_count,
                   accepted_sequence, dirty_generation
            from library.watcher_incidents
            where library_id = %s and root_id = %s and resolved_at is null
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()

    assert lane == {
        "accepted_sequence": participant.accepted_sequence_upper,
        "dirty_generation": participant.dirty_generation + 1,
        "catch_up_count": 1,
        "running_generation_id": None,
        "running_job_id": None,
        "successor_generation_id": accepted.generation_id,
    }
    assert generation == {
        "watcher_generation_kind": "root_catch_up",
        "watcher_job_linked_at": None,
    }
    assert scope_counts == {"path_count": 0, "move_count": 0, "job_count": 0}
    assert incident is not None
    assert incident["reason_code"] == "root_unavailable"
    assert incident["occurrence_count"] == 1
    assert incident["accepted_sequence"] == lane["accepted_sequence"]
    assert incident["dirty_generation"] == lane["dirty_generation"]
    incident_identity = (incident["incident_id"], incident["warning_token"])

    assert worker_repository.reconcile_due(
        now=now + timedelta(seconds=3),
        limit=32,
    ) == ()
    with isolatedPostgres._connect(scope.setup_url) as connection:
        repeated = connection.execute(
            """
            select lane.dirty_generation, lane.catch_up_count,
                   incident.incident_id, incident.warning_token,
                   incident.occurrence_count
            from library.watcher_lanes lane
            join library.watcher_incidents incident
              on incident.library_id = lane.library_id
             and incident.root_id = lane.root_id
             and incident.resolved_at is null
            where lane.library_id = %s and lane.root_id = %s
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()
        connection.execute(
            """
            update library.library_roots
            set is_active = true, updated_at = %s
            where library_id = %s and id = %s
            """,
            (
                now + timedelta(seconds=4),
                scope.library_id,
                scope.root_database_ids["root-a"],
            ),
        )

    assert repeated == {
        "dirty_generation": lane["dirty_generation"],
        "catch_up_count": lane["catch_up_count"],
        "incident_id": incident_identity[0],
        "warning_token": incident_identity[1],
        "occurrence_count": 1,
    }
    assert worker_repository.dispatch_ready(
        now=now + timedelta(seconds=5),
        limit=32,
    ) == (accepted.generation_id,)


def test_operator_rollback_preserves_unapplied_work_and_is_runtime_denied(
    live_watcher_database,
):
    import psycopg

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    operator_repository = _repository(scope.setup_url)
    accepted = app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "rollback.mp3"),
        accepted_at=now,
    )

    operator_repository.disable_acceptance(now=now)
    result = operator_repository.prepare_legacy_rollback(now=now)

    assert accepted.generation_id in result.retained_generation_ids
    assert "root-a" in result.affected_root_ids
    with isolatedPostgres._connect(scope.setup_url) as connection:
        lane = connection.execute(
            """
            select accepted_sequence, applied_sequence
            from library.watcher_lanes
            where library_id = %s and root_id = %s
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()
        incident = connection.execute(
            """
            select reason_code
            from library.watcher_incidents
            where library_id = %s and root_id = %s and resolved_at is null
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()
    assert lane["applied_sequence"] < lane["accepted_sequence"]
    assert incident["reason_code"] == "rollback_pending_work"

    for database_url in (scope.app_url, scope.worker_url):
        with isolatedPostgres._connect(database_url) as connection:
            with pytest.raises(psycopg.errors.InsufficientPrivilege) as denied:
                connection.execute(
                    "select * from library.prepare_legacy_watcher_rollback(%s)",
                    (now,),
                ).fetchall()
            assert denied.value.sqlstate == "42501"
