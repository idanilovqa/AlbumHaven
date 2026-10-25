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


def _urls_or_skip() -> tuple[str, str, str, str]:
    try:
        setup_url, app_url = isolatedPostgres.resolve_isolated_database_urls()
    except RuntimeError:
        _skip_or_fail_ci("Dedicated watcher recovery Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "").strip()
    if not worker_url:
        _skip_or_fail_ci("Dedicated watcher worker Postgres URL is unavailable.")
    readonly_url = str(os.environ.get("DATABASE_READONLY_URL") or "").strip()
    if not readonly_url:
        _skip_or_fail_ci("Dedicated watcher read-only Postgres URL is unavailable.")
    if not Path(str(os.environ.get("PGPASSFILE") or "")).is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")
    identities = {
        (
            (urlparse(value).hostname or "").casefold(),
            urlparse(value).port or 5432,
            urlparse(value).path.lstrip("/"),
        )
        for value in (setup_url, app_url, worker_url, readonly_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Watcher role URLs do not share one isolated database.")
    return setup_url, app_url, worker_url, readonly_url


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
    setup_url, app_url, worker_url, readonly_url = _urls_or_skip()
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
            readonly_url=readonly_url,
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


@pytest.mark.parametrize(
    "mutate_runtime_state",
    (
        "update library.watcher_runtime_state "
        "set acceptance_enabled = false, disabled_at = pg_catalog.now()",
        "delete from library.watcher_runtime_state",
    ),
    ids=("disabled", "deleted"),
)
def test_prepare_isolated_database_restores_enabled_watcher_runtime_singleton(
    live_watcher_database,
    mutate_runtime_state,
):
    scope = live_watcher_database
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(mutate_runtime_state)

    isolatedPostgres.prepare_isolated_database(scope.setup_url, scope.app_url)

    with isolatedPostgres._connect(scope.setup_url) as connection:
        rows = connection.execute(
            """
            select acceptance_enabled, disabled_at
            from library.watcher_runtime_state
            order by singleton
            """
        ).fetchall()

    assert rows == [{"acceptance_enabled": True, "disabled_at": None}]


def test_prepare_isolated_database_allows_dirty_admission_for_registered_missing_root(
    live_watcher_database,
):
    scope = live_watcher_database
    logical_root_id = "missing-after-reset"
    missing_root = scope.root_paths["root-a"] / logical_root_id
    assert not missing_root.exists()

    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute("delete from library.watcher_runtime_state")

    isolatedPostgres.prepare_isolated_database(scope.setup_url, scope.app_url)

    with isolatedPostgres._connect(scope.setup_url) as connection:
        library_id = int(
            connection.execute(
                """
                select library.id
                from library.libraries as library
                join app.bootstrap_owners as owner
                  on owner.account_id = library.owner_account_id
                where owner.owner_key = 'local-bootstrap-owner'
                  and library.name = 'Local Library'
                  and library.library_kind = 'local'
                """
            ).fetchone()["id"]
        )
        connection.execute(
            """
            insert into library.library_roots (
              library_id, root_path, root_kind, is_active, metadata
            )
            values (%s, %s, 'main', true, %s::jsonb)
            """,
            (library_id, str(missing_root), json.dumps({"root_id": logical_root_id})),
        )

    with isolatedPostgres._connect(scope.app_url) as connection:
        admitted = connection.execute(
            """
            select logical_root_id
            from library.mark_watcher_roots_dirty(%s, %s, 'root_unavailable', %s)
            """,
            (library_id, [logical_root_id], NOW),
        ).fetchall()

    assert admitted == [{"logical_root_id": logical_root_id}]


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
        "watcher_runtime_state",
    )
    sequences = ("watcher_barriers_id_seq", "watcher_repairs_id_seq")
    role_urls = (
        ("album_haven_app", scope.app_url),
        ("album_haven_worker", scope.worker_url),
        ("album_haven_readonly", scope.readonly_url),
    )

    from psycopg import sql

    for role, database_url in role_urls:
        for set_inherited_role in (False, True):
            with isolatedPostgres._connect(database_url) as connection:
                connection.autocommit = True
                isolatedPostgres._assert_connected_role(connection, role)
                identity = connection.execute(
                    """
                    select current_user as current_user,
                           session_user as session_user,
                           pg_has_role(current_user, %s, 'MEMBER') as inherited
                    """,
                    (role,),
                ).fetchone()
                assert identity["current_user"] == identity["session_user"]
                assert identity["inherited"] is True
                if set_inherited_role:
                    connection.execute(
                        sql.SQL("set role {}").format(sql.Identifier(role))
                    )
                    assert connection.execute(
                        "select current_user as current_user"
                    ).fetchone()["current_user"] == role

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
                            "select has_table_privilege(current_user, %s, %s) "
                            "as allowed",
                            (f"library.{table}", privilege),
                        ).fetchone()
                        assert privileges["allowed"] is False
                for sequence in sequences:
                    for privilege in ("USAGE", "SELECT", "UPDATE"):
                        privileges = connection.execute(
                            "select has_sequence_privilege(current_user, %s, %s) "
                            "as allowed",
                            (f"library.{sequence}", privilege),
                        ).fetchone()
                        assert privileges["allowed"] is False


def test_actual_runtime_logins_keep_watcher_definer_allow_deny_matrix(
    live_watcher_database,
):
    import psycopg
    from psycopg import sql

    scope = live_watcher_database
    cases = (
        (
            "album_haven_app",
            scope.app_url,
            "select * from library.load_watcher_status(%s)",
            (scope.library_id,),
            "select * from library.dispatch_ready_watcher_generations(%s, %s)",
            (NOW, 1),
        ),
        (
            "album_haven_worker",
            scope.worker_url,
            "select * from library.load_watcher_metrics(%s, %s)",
            (scope.library_id, NOW),
            "select * from library.load_watcher_status(%s)",
            (scope.library_id,),
        ),
        (
            "album_haven_readonly",
            scope.readonly_url,
            "select * from library.load_watcher_status(%s)",
            (scope.library_id,),
            "select * from library.load_watcher_metrics(%s, %s)",
            (scope.library_id, NOW),
        ),
    )
    for (
        role,
        database_url,
        allowed_sql,
        allowed_params,
        denied_sql,
        denied_params,
    ) in cases:
        for set_inherited_role in (False, True):
            with isolatedPostgres._connect(database_url) as connection:
                connection.autocommit = True
                isolatedPostgres._assert_connected_role(connection, role)
                if set_inherited_role:
                    connection.execute(
                        sql.SQL("set role {}").format(sql.Identifier(role))
                    )
                connection.execute(allowed_sql, allowed_params).fetchall()
                with pytest.raises(psycopg.errors.InsufficientPrivilege) as denied:
                    connection.execute(denied_sql, denied_params).fetchall()
                assert denied.value.sqlstate == "42501"


def test_readonly_login_cannot_select_raw_watcher_scope(live_watcher_database):
    import psycopg
    from psycopg import sql

    scope = live_watcher_database
    for set_inherited_role in (False, True):
        with isolatedPostgres._connect(scope.readonly_url) as connection:
            connection.autocommit = True
            isolatedPostgres._assert_connected_role(
                connection,
                "album_haven_readonly",
            )
            if set_inherited_role:
                connection.execute(
                    sql.SQL("set role {}").format(
                        sql.Identifier("album_haven_readonly")
                    )
                )
            with pytest.raises(psycopg.errors.InsufficientPrivilege) as denied:
                connection.execute(
                    "select * from library.targeted_reconciliation_intent_paths"
                ).fetchall()
            assert denied.value.sqlstate == "42501"


def test_watcher_function_privilege_matrix(live_watcher_database):
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


def _explain_analyze_text(connection, query: str, params: tuple[object, ...]) -> str:
    rows = connection.execute(
        "explain (analyze, buffers, format text) " + query,
        params,
    ).fetchall()
    return "\n".join(str(row["QUERY PLAN"]) for row in rows)


def _seed_watcher_query_plan_rows(connection, scope, *, row_count: int) -> int:
    connection.execute(
        """
        insert into library.libraries (name, library_kind)
        select 'Watcher plan noise ' || ordinal::text, 'local'
        from pg_catalog.generate_series(1, %s) as ordinal
        """,
        (row_count,),
    )
    connection.execute(
        """
        insert into library.library_roots (
          library_id, root_path, root_kind, is_active, metadata
        )
        select target.id, 'watcher-plan-noise/' || target.id::text,
               'main', true,
               pg_catalog.jsonb_build_object(
                 'root_id', 'watcher-plan-noise-' || target.id::text
               )
        from library.libraries as target
        where target.name like 'Watcher plan noise %'
        """
    )
    connection.execute(
        """
        insert into library.watcher_lanes (
          library_id, root_id, accepted_sequence, applied_sequence,
          next_eligible_at, disposition_code
        )
        select root.library_id, root.id, 1, 0, %s, 'coalesced'
        from library.library_roots as root
        join library.libraries as target on target.id = root.library_id
        where target.name like 'Watcher plan noise %%'
        """,
        (NOW,),
    )
    connection.execute(
        """
        -- Accumulated job-linked history must stay outside the ready partial index.
        insert into library.targeted_reconciliation_intents (
          library_id, primary_root_id, producer_request_key, request_digest,
          deployment_mode, client_surface, state, accepted_at, updated_at,
          watcher_job_linked_at, watcher_generation_kind, accepted_sequence_lower,
          accepted_sequence_upper, dirty_generation
        )
        select root.library_id, root.id,
               'watcher-plan-noise:' || root.id::text,
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                 'watcher-plan-noise:' || root.id::text, 'UTF8'
               )), 'hex'),
               'self_hosted_private_web', 'library_watcher', 'accepted',
               %s, %s, %s, 'root_catch_up', 1, 1, 0
        from library.library_roots as root
        join library.libraries as target on target.id = root.library_id
        where target.name like 'Watcher plan noise %%'
        """,
        (NOW, NOW, NOW),
    )
    target_root_id = scope.root_database_ids["root-a"]
    connection.execute(
        """
        insert into library.watcher_lanes (
          library_id, root_id, accepted_sequence, applied_sequence,
          next_eligible_at, disposition_code
        ) values (%s, %s, 1, 0, %s, 'coalesced')
        """,
        (scope.library_id, target_root_id, NOW),
    )
    target_generation_id = int(
        connection.execute(
            """
            insert into library.targeted_reconciliation_intents (
              library_id, primary_root_id, producer_request_key, request_digest,
              deployment_mode, client_surface, state, accepted_at, updated_at,
              watcher_generation_kind, accepted_sequence_lower,
              accepted_sequence_upper, dirty_generation
            ) values (
              %s, %s, 'watcher-plan-target', %s,
              'self_hosted_private_web', 'library_watcher', 'accepted',
              %s, %s, 'root_catch_up', 1, 1, 0
            ) returning id
            """,
            (scope.library_id, target_root_id, "a" * 64, NOW, NOW),
        ).fetchone()["id"]
    )
    connection.execute(
        """
        update library.watcher_lanes as lane
        set successor_generation_id = intent.id
        from library.targeted_reconciliation_intents as intent
        where intent.library_id = lane.library_id
          and intent.primary_root_id = lane.root_id
          and intent.producer_request_key like 'watcher-plan-%'
        """
    )
    connection.execute(
        """
        insert into library.watcher_generation_participants (
          generation_id, library_id, root_id, accepted_sequence_lower,
          accepted_sequence_upper, dirty_generation, created_at, updated_at
        )
        select intent.id, intent.library_id, intent.primary_root_id,
               1, 1, 0, %s, %s
        from library.targeted_reconciliation_intents as intent
        where intent.producer_request_key like 'watcher-plan-%%'
        """,
        (NOW, NOW),
    )
    connection.execute(
        """
        insert into library.watcher_incidents (
          library_id, root_id, incident_family, reason_code,
          accepted_sequence, dirty_generation, first_seen_at, last_seen_at
        )
        select participant.library_id, participant.root_id,
               'watcher_recovery', 'overflow', 1, 0, %s, %s
        from library.watcher_generation_participants as participant
        join library.targeted_reconciliation_intents as intent
          on intent.id = participant.generation_id
        where intent.producer_request_key like 'watcher-plan-%%'
        """,
        (NOW, NOW),
    )
    connection.execute(
        """
        insert into library.watcher_incidents (
          library_id, root_id, incident_family, reason_code,
          accepted_sequence, dirty_generation,
          first_seen_at, last_seen_at, resolved_at
        )
        select participant.library_id, participant.root_id,
               'watcher_recovery', 'root_unavailable', 1, 0,
               %s - interval '2 seconds', %s - interval '1 second', %s
        from library.watcher_generation_participants as participant
        join library.targeted_reconciliation_intents as intent
          on intent.id = participant.generation_id
        where intent.producer_request_key like 'watcher-plan-noise:%%'
        """,
        (NOW, NOW, NOW),
    )
    connection.execute(
        """
        insert into library.watcher_barriers (library_id, created_at)
        select intent.library_id, %s
        from library.targeted_reconciliation_intents as intent
        where intent.producer_request_key like 'watcher-plan-%%'
        """,
        (NOW,),
    )
    connection.execute(
        """
        insert into library.watcher_barrier_participants (
          barrier_id, generation_id, library_id, root_id, accepted_sequence
        )
        select barrier.id, participant.generation_id,
               participant.library_id, participant.root_id, 1
        from library.watcher_barriers as barrier
        join library.watcher_generation_participants as participant
          on participant.library_id = barrier.library_id
        join library.targeted_reconciliation_intents as intent
          on intent.id = participant.generation_id
        where intent.producer_request_key like 'watcher-plan-%'
        """
    )
    noise_account_id = int(
        connection.execute(
            """
            insert into app.accounts (
              display_name, username_display, username_normalized,
              contact_email, contact_email_normalized, account_kind, is_active
            ) values (
              'Watcher Plan Noise', 'watcher-plan-noise', 'watcher-plan-noise',
              'watcher-plan-noise@example.invalid',
              'watcher-plan-noise@example.invalid', 'managed', true
            ) returning id
            """
        ).fetchone()["id"]
    )
    connection.execute(
        """
        insert into library.library_memberships (
          library_id, account_id, membership_role
        )
        select target.id, %s, 'viewer'
        from library.libraries as target
        where target.name like 'Watcher plan noise %%'
        """,
        (noise_account_id,),
    )
    connection.execute(
        """
        insert into library.watcher_incident_acknowledgements (
          incident_id, library_id, account_id, acknowledged_at
        )
        select incident.incident_id, incident.library_id, %s, %s
        from library.watcher_incidents as incident
        join library.libraries as target on target.id = incident.library_id
        where target.name like 'Watcher plan noise %%'
          and incident.resolved_at is null
        """,
        (noise_account_id, NOW),
    )
    connection.execute(
        """
        insert into library.watcher_incident_acknowledgements (
          incident_id, library_id, account_id, acknowledged_at
        )
        select incident.incident_id, incident.library_id, %s, %s
        from library.watcher_incidents as incident
        where incident.library_id = %s
          and incident.root_id = %s
          and incident.resolved_at is null
        """,
        (scope.account_id, NOW, scope.library_id, target_root_id),
    )
    for table in (
        "targeted_reconciliation_intents",
        "watcher_generation_participants",
        "watcher_lanes",
        "watcher_barriers",
        "watcher_barrier_participants",
        "watcher_incidents",
        "watcher_incident_acknowledgements",
    ):
        connection.execute(f"analyze library.{table}")
    return target_generation_id


def test_watcher_hot_path_query_plans_use_existing_indexes(live_watcher_database):
    scope = live_watcher_database
    with isolatedPostgres._connect(scope.setup_url) as connection:
        generation_id = _seed_watcher_query_plan_rows(
            connection,
            scope,
            row_count=2_000,
        )
        ready_plan = _explain_analyze_text(
            connection,
            """
            select candidate.id
            from library.targeted_reconciliation_intents as candidate
            where candidate.watcher_generation_kind in ('exact', 'root_catch_up')
              and candidate.watcher_job_linked_at is null
              and candidate.state = 'accepted'
              and exists (
                select 1
                from library.watcher_generation_participants as participant
                join library.watcher_lanes as lane
                  on lane.library_id = participant.library_id
                 and lane.root_id = participant.root_id
                where participant.generation_id = candidate.id
                  and lane.next_eligible_at <= %s
              )
              and not exists (
                select 1
                from library.watcher_generation_participants as participant
                join library.watcher_lanes as lane
                  on lane.library_id = participant.library_id
                 and lane.root_id = participant.root_id
                left join library.library_roots as root
                  on root.library_id = participant.library_id
                 and root.id = participant.root_id
                 and root.is_active is true
                where participant.generation_id = candidate.id
                  and (lane.successor_generation_id is distinct from candidate.id
                       or lane.running_generation_id is not null
                       or lane.running_job_id is not null
                       or lane.next_eligible_at > %s
                       or participant.accepted_sequence_lower
                            <> lane.applied_sequence + 1
                       or participant.accepted_sequence_upper
                            <> lane.accepted_sequence
                       or root.id is null)
              )
              and not (
                candidate.watcher_generation_kind = 'exact'
                and exists (
                  select 1
                  from library.watcher_generation_participants as participant
                  join library.watcher_incidents as incident
                    on incident.library_id = participant.library_id
                   and incident.root_id = participant.root_id
                   and incident.resolved_at is null
                  where participant.generation_id = candidate.id
                )
              )
              and not exists (
                select 1
                from library.watcher_barrier_participants as candidate_barrier
                join library.watcher_barrier_participants as peer
                  on peer.barrier_id = candidate_barrier.barrier_id
                join library.watcher_lanes as peer_lane
                  on peer_lane.library_id = peer.library_id
                 and peer_lane.root_id = peer.root_id
                where candidate_barrier.generation_id = candidate.id
                  and peer_lane.applied_sequence < peer.accepted_sequence - 1
              )
            order by candidate.accepted_at, candidate.id
            limit 32
            """,
            (NOW + timedelta(hours=1), NOW + timedelta(hours=1)),
        )
        unresolved_plan = _explain_analyze_text(
            connection,
            """
            select incident.incident_id
            from library.watcher_incidents as incident
            where incident.library_id = %s
              and incident.root_id = %s
              and incident.incident_family = 'watcher_recovery'
              and incident.resolved_at is null
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        )
        acknowledgement_plan = _explain_analyze_text(
            connection,
            """
            select incident.warning_token
            from library.watcher_incidents as incident
            join library.watcher_incident_acknowledgements as acknowledgement
              on acknowledgement.incident_id = incident.incident_id
             and acknowledgement.library_id = incident.library_id
             and acknowledgement.account_id = %s
            join library.library_memberships as membership
              on membership.library_id = incident.library_id
             and membership.account_id = %s
            where incident.library_id = %s
              and incident.resolved_at is null
            order by incident.warning_token
            """,
            (scope.account_id, scope.account_id, scope.library_id),
        )
        barrier_plan = _explain_analyze_text(
            connection,
            """
            select 1
            from library.watcher_barrier_participants as candidate_barrier
            join library.watcher_barrier_participants as peer
              on peer.barrier_id = candidate_barrier.barrier_id
            join library.watcher_lanes as peer_lane
              on peer_lane.library_id = peer.library_id
             and peer_lane.root_id = peer.root_id
            where candidate_barrier.generation_id = %s
              and peer_lane.applied_sequence < peer.accepted_sequence - 1
            """,
            (generation_id,),
        )
        generation_plan = _explain_analyze_text(
            connection,
            """
            select pg_catalog.count(*)
            from library.watcher_generation_participants as participant
            where participant.generation_id = %s
            """,
            (generation_id,),
        )

    expectations = (
        (
            ready_plan,
            "targeted_reconciliation_watcher_ready_idx",
            "Seq Scan on targeted_reconciliation_intents",
        ),
        (
            unresolved_plan,
            "watcher_incidents_unresolved_root_family_idx",
            "Seq Scan on watcher_incidents",
        ),
        (
            acknowledgement_plan,
            "watcher_incident_acknowledgements_account_id_idx",
            "Seq Scan on watcher_incident_acknowledgements",
        ),
        (
            barrier_plan,
            "watcher_barrier_participants_generation_id_idx",
            "Seq Scan on watcher_barrier_participants",
        ),
        (
            generation_plan,
            # PostgreSQL truncates this generated unique-index name to 63 bytes.
            "watcher_generation_participan_generation_id_library_id_root_key",
            "Seq Scan on watcher_generation_participants",
        ),
    )
    for plan, expected_index, forbidden_scan in expectations:
        assert expected_index in plan, plan
        assert forbidden_scan not in plan, plan


def _claim_watcher_generation(scope, generation_id: int, *, now: datetime, worker_id: str):
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
    return claim


def _publish_claimed_watcher_generation(scope, claim, generation_id: int, *, now: datetime):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

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


def _publish_watcher_generation(scope, generation_id: int, *, now: datetime, worker_id: str):
    claim = _claim_watcher_generation(
        scope, generation_id, now=now, worker_id=worker_id
    )
    return _publish_claimed_watcher_generation(scope, claim, generation_id, now=now)


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
    scope,
    *,
    repair_id: int,
    now: datetime,
    request_ref: str,
    root_ids: tuple[str, ...] = ("root-a",),
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
        root_ids=root_ids,
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
    root_ids: tuple[str, ...] = ("root-a",),
):
    _, accepted = _enqueue_linked_full_scan(
        scope,
        repair_id=repair_id,
        now=now,
        request_ref=request_ref,
        root_ids=root_ids,
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


def test_repair_replays_deferred_generation_after_prior_completion_before_full_publication(
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
    assert app_recovery.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "completed-before-full.flac"),
        accepted_at=now + timedelta(seconds=1),
    ).generation_id == initial.generation_id
    targeted_claim = _claim_watcher_generation(
        scope,
        initial.generation_id,
        now=now + timedelta(seconds=2),
        worker_id="repair-pre-full-targeted",
    )
    _, accepted = _enqueue_linked_full_scan(
        scope,
        repair_id=repair_id,
        now=now + timedelta(seconds=2),
        request_ref="watcher:repair-completed-before-full",
    )
    deferred = app_recovery.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "accepted-after-full-snapshot.flac"),
        accepted_at=now + timedelta(seconds=2, microseconds=1),
    )
    assert deferred.generation_id != initial.generation_id
    with isolatedPostgres._connect(scope.setup_url) as connection:
        watermark = connection.execute(
            """
            select repair_root.captured_accepted_sequence, lane.accepted_sequence
            from library.watcher_repair_roots as repair_root
            join library.watcher_lanes as lane
              on lane.library_id = repair_root.library_id
             and lane.root_id = repair_root.root_id
            where repair_root.repair_id = %s
            """,
            (repair_id,),
        ).fetchone()
    assert watermark["captured_accepted_sequence"] < watermark["accepted_sequence"]
    _publish_claimed_watcher_generation(
        scope,
        targeted_claim,
        initial.generation_id,
        now=now + timedelta(seconds=2, microseconds=2),
    )
    worker_scans, claim, intent, scope_result = _claim_enqueued_full_scan(
        scope,
        now=now + timedelta(seconds=2, microseconds=3),
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
    assert successor_id == deferred.generation_id
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


def test_watcher_successor_capture_preserves_completed_cover_revision(live_watcher_database):
    scope = live_watcher_database
    repository = _repository(scope.app_url)
    now = datetime.now(timezone.utc)
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            "insert into library.cover_mutation_state (library_id, cover_mutation_revision) "
            "values (%s, 13) on conflict (library_id) do update "
            "set cover_mutation_revision = excluded.cover_mutation_revision",
            (scope.library_id,),
        )
    first = repository.accept_event(
        library_id=scope.library_id, event=_created(scope, "root-a", "capture-first.flac"),
        accepted_at=now,
    )
    _publish_watcher_generation(
        scope, first.generation_id, now=now, worker_id="cover-capture-worker",
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            "select captured_cover_mutation_revision, watcher_completed_at "
            "from library.targeted_reconciliation_intents where id = %s",
            (first.generation_id,),
        ).fetchone()
        assert completed["captured_cover_mutation_revision"] == 13
        assert completed["watcher_completed_at"] is not None
        connection.execute(
            "update library.cover_mutation_state set cover_mutation_revision = 29 where library_id = %s",
            (scope.library_id,),
        )
    second = repository.accept_event(
        library_id=scope.library_id, event=_created(scope, "root-a", "capture-second.flac"),
        accepted_at=now + timedelta(seconds=1),
    )
    assert second.generation_id != first.generation_id
    with isolatedPostgres._connect(scope.setup_url) as connection:
        assert connection.execute(
            "select captured_cover_mutation_revision from library.targeted_reconciliation_intents where id = %s",
            (second.generation_id,),
        ).fetchone()["captured_cover_mutation_revision"] == 29
        assert connection.execute(
            "select captured_cover_mutation_revision, watcher_completed_at "
            "from library.targeted_reconciliation_intents where id = %s",
            (first.generation_id,),
        ).fetchone() == completed


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


def test_unresolved_watcher_incident_is_projected_through_durable_status(
    live_watcher_database,
):
    scope = live_watcher_database
    repository = _repository(scope.app_url)
    accepted = repository.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=NOW,
    )
    problems = repository.load_status(library_id=scope.library_id)

    assert [
        (
            problem.root_id,
            problem.state,
            problem.incident_id,
            problem.warning_token,
        )
        for problem in problems
    ] == [
        (
            "root-a",
            "overflow",
            accepted.incident_id,
            accepted.warning_token,
        )
    ]
    assert problems[0].event_id == accepted.incident_id


def test_app_acknowledges_durable_incidents_without_table_access(
    live_watcher_database,
):
    from music_app.services.library_warning_dismissals import (
        PostgresLibraryWarningDismissals,
    )

    scope = live_watcher_database
    repository = _repository(scope.app_url)
    accepted = repository.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=NOW,
    )
    [problem] = repository.load_status(library_id=scope.library_id)
    acknowledgements = PostgresLibraryWarningDismissals(
        {"ALBUM_HAVEN_APP_DATABASE_URL": scope.app_url},
        connect=isolatedPostgres._connect,
    )
    acknowledgements.library_id = scope.library_id

    assert acknowledgements.load(scope.account_id) == ""
    acknowledgements.save(scope.account_id, problem.warning_token)
    assert acknowledgements.load(scope.account_id) == problem.warning_token

    with isolatedPostgres._connect(scope.setup_url) as connection:
        row = connection.execute(
            """
            select incident_id::text as incident_id, library_id, account_id
            from library.watcher_incident_acknowledgements
            where library_id = %s and account_id = %s
            """,
            (scope.library_id, scope.account_id),
        ).fetchone()
    assert row == {
        "incident_id": accepted.incident_id,
        "library_id": scope.library_id,
        "account_id": scope.account_id,
    }


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


def test_imported_legacy_health_is_cleared_only_after_its_captured_repair(
    live_watcher_database,
):
    from music_app.services.library_watch_health import (
        PostgresLibraryWatchHealthStore,
    )
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    legacy_health = {
        "root-a": {
            "state": "overflow",
            "detected_at": now.isoformat(),
            "event_id": "legacy-root-a",
        },
        "root-b": {
            "state": "root_unavailable",
            "detected_at": (now - timedelta(seconds=1)).isoformat(),
            "event_id": "legacy-root-b",
        },
    }
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            """
            update library.libraries
            set metadata = pg_catalog.jsonb_set(
                coalesce(metadata, '{}'::jsonb),
                '{library_watch_health}',
                %s::jsonb,
                true
            )
            where id = %s
            """,
            (json.dumps(legacy_health), scope.library_id),
        )

    recovery = _repository(scope.app_url)
    incident = recovery.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now,
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        connection.execute(
            """
            insert into library.watcher_legacy_health_imports (
                library_id, root_id, source_key, imported_at
            ) values (%s, %s, 'legacy_library_watch_health_v1', %s)
            """,
            (
                scope.library_id,
                scope.root_database_ids["root-a"],
                now,
            ),
        )

    legacy_store = PostgresLibraryWatchHealthStore(
        {"ALBUM_HAVEN_APP_DATABASE_URL": scope.app_url},
        connect=isolatedPostgres._connect,
    )
    assert {problem.root_id for problem in legacy_store.load()} == {
        "root-a",
        "root-b",
    }

    scans = PostgresScanJobRepository(
        database_url=scope.app_url,
        connect_to_database=isolatedPostgres._connect,
    )
    accepted = scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:legacy-health-cleanup",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-a",),
        mode="manual_full_rescan",
        force=True,
        scheduled_at=now - timedelta(seconds=1),
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        pending_health = connection.execute(
            """
            select metadata -> 'library_watch_health' as health
            from library.libraries
            where id = %s
            """,
            (scope.library_id,),
        ).fetchone()["health"]
    assert set(pending_health) == {"root-a", "root-b"}

    worker_scans, claim, intent, claimed_scope = _claim_enqueued_full_scan(
        scope,
        now=now,
        request_ref="watcher:legacy-health-cleanup",
        worker_id="watcher-legacy-health-cleanup-worker",
    )
    publication = _publish_linked_full_scan(
        worker_scans,
        accepted,
        claim,
        intent,
        claimed_scope,
        now=now + timedelta(seconds=1),
    )
    assert publication["publication_won"] is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select library_record.metadata -> 'library_watch_health' as health,
                   incident.resolved_at
            from library.libraries as library_record
            join library.watcher_incidents as incident
              on incident.library_id = library_record.id
             and incident.incident_id = %s
            where library_record.id = %s
            """,
            (incident.incident_id, scope.library_id),
        ).fetchone()
    assert completed["resolved_at"] is not None
    assert set(completed["health"]) == {"root-b"}
    assert {problem.root_id for problem in legacy_store.load()} == {"root-b"}


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
    root_ids: tuple[str, ...] = ("root-a",),
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
            root_ids=root_ids,
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


def test_repair_full_scan_rebases_dirty_only_retained_successor(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:dirty-only-successor",
        worker_id="watcher-dirty-only-full-scan",
        root_ids=("root-a", "root-b"),
    )
    repaired_root_id = scope.root_database_ids["root-a"]
    healthy_root_id = scope.root_database_ids["root-b"]

    with isolatedPostgres._connect(scope.setup_url) as connection:
        successor_id = int(
            connection.execute(
                """
                select successor_generation_id
                from library.watcher_lanes
                where library_id = %s and root_id = %s
                """,
                (scope.library_id, repaired_root_id),
            ).fetchone()["successor_generation_id"]
        )
        connection.execute(
            """
            update library.watcher_repair_roots
            set captured_accepted_sequence = 1,
                captured_dirty_generation = 300
            where repair_id = %s and root_id = %s
            """,
            (seeded.repair_id, repaired_root_id),
        )
        connection.execute(
            """
            update library.watcher_lanes
            set accepted_sequence = 1,
                applied_sequence = 0,
                dirty_generation = 457,
                repaired_dirty_generation = 0
            where library_id = %s and root_id = %s
            """,
            (scope.library_id, repaired_root_id),
        )
        connection.execute(
            """
            update library.watcher_generation_participants
            set accepted_sequence_lower = 1,
                accepted_sequence_upper = 1,
                dirty_generation = 457
            where generation_id = %s and root_id = %s
            """,
            (successor_id, repaired_root_id),
        )
        connection.execute(
            """
            update library.targeted_reconciliation_intents
            set accepted_sequence_lower = 1,
                accepted_sequence_upper = 1,
                dirty_generation = 457
            where id = %s
            """,
            (successor_id,),
        )
        connection.execute(
            """
            insert into library.watcher_lanes (
              library_id, root_id, accepted_sequence, applied_sequence,
              dirty_generation, repaired_dirty_generation,
              next_eligible_at, disposition_code
            ) values (%s, %s, 4, 4, 0, 0, %s, 'idle')
            """,
            (scope.library_id, healthy_root_id, now),
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
        now=now + timedelta(seconds=1),
    )
    assert publication["publication_won"] is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        catch_up = connection.execute(
            """
            select repair.state,
                   repaired_lane.accepted_sequence,
                   repaired_lane.applied_sequence,
                   repaired_lane.dirty_generation,
                   repaired_lane.repaired_dirty_generation,
                   healthy_lane.accepted_sequence as healthy_accepted_sequence,
                   healthy_lane.applied_sequence as healthy_applied_sequence,
                   participant.accepted_sequence_lower,
                   participant.accepted_sequence_upper,
                   participant.dirty_generation as participant_dirty_generation
            from library.watcher_repairs as repair
            join library.watcher_lanes as repaired_lane
              on repaired_lane.library_id = repair.library_id
             and repaired_lane.root_id = %s
            join library.watcher_lanes as healthy_lane
              on healthy_lane.library_id = repair.library_id
             and healthy_lane.root_id = %s
            join library.watcher_generation_participants as participant
              on participant.generation_id = repaired_lane.successor_generation_id
             and participant.library_id = repaired_lane.library_id
             and participant.root_id = repaired_lane.root_id
            where repair.id = %s
            """,
            (repaired_root_id, healthy_root_id, seeded.repair_id),
        ).fetchone()
    assert catch_up == {
        "state": "catch_up",
        "accepted_sequence": 2,
        "applied_sequence": 1,
        "dirty_generation": 457,
        "repaired_dirty_generation": 300,
        "healthy_accepted_sequence": 4,
        "healthy_applied_sequence": 4,
        "accepted_sequence_lower": 2,
        "accepted_sequence_upper": 2,
        "participant_dirty_generation": 457,
    }

    _publish_watcher_generation(
        scope,
        successor_id,
        now=now + timedelta(seconds=2),
        worker_id="watcher-dirty-only-catch-up",
    )
    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state, repair.completed_at,
                   lane.accepted_sequence, lane.applied_sequence,
                   lane.dirty_generation, lane.repaired_dirty_generation,
                   incident.resolved_at
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_lanes as lane
              on lane.library_id = repair_root.library_id
             and lane.root_id = repair_root.root_id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            where repair.id = %s and repair_root.root_id = %s
            """,
            (seeded.repair_id, repaired_root_id),
        ).fetchone()
    assert completed["state"] == "complete"
    assert completed["completed_at"] is not None
    assert completed["accepted_sequence"] == 2
    assert completed["applied_sequence"] == 2
    assert completed["dirty_generation"] == 457
    assert completed["repaired_dirty_generation"] == 457
    assert completed["resolved_at"] is not None


def test_repair_full_scan_claim_waits_without_consuming_attempts_for_running_lane(
    live_watcher_database,
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )

    catch_up = app_repository.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=now,
    )
    assert worker_repository.dispatch_ready(now=now, limit=32) == (
        catch_up.generation_id,
    )
    repair_id = _seed_scanning_repair(
        scope,
        now=now + timedelta(seconds=1),
        logical_root_id="root-a",
    )
    _, full_scan = _enqueue_linked_full_scan(
        scope,
        repair_id=repair_id,
        now=now + timedelta(seconds=1),
        request_ref="watcher:capture-running-generation",
        root_ids=("root-a", "root-b"),
    )

    for worker_id in (
        "watcher-deferred-full-scan-1",
        "watcher-deferred-full-scan-2",
    ):
        assert jobs.claim(
            worker_id=worker_id,
            now=now + timedelta(seconds=1),
            lease_seconds=300,
            kinds=(JobKind.FULL_SCAN,),
        ) is None

    with isolatedPostgres._connect(scope.setup_url) as connection:
        deferred_job = connection.execute(
            """
            select job.state, job.attempt_count, job.lease_owner,
                   count(transition.id) filter (
                     where transition.reason_code = 'claimed'
                   ) as claim_transition_count
            from ops.jobs as job
            left join ops.job_transitions as transition on transition.job_id = job.id
            where job.id = %s
            group by job.id
            """,
            (full_scan.job_id,),
        ).fetchone()
    assert deferred_job == {
        "state": "queued",
        "attempt_count": 0,
        "lease_owner": None,
        "claim_transition_count": 0,
    }

    catch_up_claim = jobs.claim(
        worker_id="watcher-capture-running-generation",
        now=now + timedelta(seconds=1),
        lease_seconds=300,
        kinds=(JobKind.TARGETED_RECONCILIATION,),
    )
    assert catch_up_claim is not None
    generation = worker_repository.claim_generation(
        claim=catch_up_claim,
        now=now + timedelta(seconds=1),
    )
    assert generation is not None
    assert generation.generation_id == catch_up.generation_id

    scans = PostgresScanJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    publication = scans.publish_claimed_targeted_reconciliation(
        claim=catch_up_claim,
        intent_id=catch_up.generation_id,
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        stale_scopes=(),
        now=now + timedelta(seconds=2),
    )
    assert publication["publication_won"] is True
    assert jobs.finish(
        catch_up_claim,
        JobTransitionResult(JobState.SUCCEEDED, "scan_completed"),
        now=now + timedelta(seconds=2),
    ) is True

    full_scan_claim = jobs.claim(
        worker_id="watcher-capture-full-scan",
        now=now + timedelta(seconds=3),
        lease_seconds=300,
        kinds=(JobKind.FULL_SCAN,),
    )
    assert full_scan_claim is not None
    assert full_scan_claim.job_id == full_scan.job_id
    assert full_scan_claim.attempt == 1
    captured = scans.load_claimed_full_scan(
        job_id=full_scan_claim.job_id,
        worker_id=full_scan_claim.worker_id,
        lease_token=full_scan_claim.lease_token,
    )
    assert captured is not None
    assert captured.intent_id == full_scan.intent_id
    assert captured.inventory_mutation_revision == publication[
        "inventory_mutation_revision"
    ]


def test_repair_full_scan_fences_nonoverlapping_root_until_global_publication(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:library-global-dispatch-fence",
        worker_id="watcher-library-global-full-scan",
        root_ids=("root-a",),
    )
    accepted = seeded.app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-b", "during-root-a-full-scan.mp3"),
        accepted_at=now + timedelta(seconds=1),
    )

    assert seeded.worker_repository.dispatch_ready(
        now=now + timedelta(seconds=1),
        limit=32,
    ) == ()

    full_publication = _publish_linked_full_scan(
        seeded.worker_scans,
        seeded.full_scan,
        seeded.claim,
        seeded.intent,
        seeded.scope,
        now=now + timedelta(seconds=2),
    )
    assert seeded.jobs.finish(
        seeded.claim,
        JobTransitionResult(JobState.SUCCEEDED, "scan_completed"),
        now=now + timedelta(seconds=2),
    ) is True

    targeted_publication = _publish_watcher_generation(
        scope,
        accepted.generation_id,
        now=now + timedelta(seconds=3),
        worker_id="watcher-library-global-root-b",
    )
    assert targeted_publication["inventory_mutation_revision"] > full_publication[
        "inventory_mutation_revision"
    ]


def test_repair_full_scan_claim_waits_for_running_nonoverlapping_root(
    live_watcher_database,
):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )

    initial = app_repository.mark_dirty(
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
    _publish_watcher_generation(
        scope,
        initial.generation_id,
        now=now,
        worker_id="watcher-library-global-root-a-setup",
    )

    root_b = app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-b", "already-running.mp3"),
        accepted_at=now + timedelta(seconds=1),
    )
    assert worker_repository.dispatch_ready(
        now=now + timedelta(seconds=1),
        limit=32,
    ) == (root_b.generation_id,)
    root_b_claim = jobs.claim(
        worker_id="watcher-library-global-running-root-b",
        now=now + timedelta(seconds=1),
        lease_seconds=300,
        kinds=(JobKind.TARGETED_RECONCILIATION,),
    )
    assert root_b_claim is not None
    running = worker_repository.claim_generation(
        claim=root_b_claim,
        now=now + timedelta(seconds=1),
    )
    assert running is not None
    assert running.generation_id == root_b.generation_id

    _, full_scan = _enqueue_linked_full_scan(
        scope,
        repair_id=repair_id,
        now=now + timedelta(seconds=2),
        request_ref="watcher:library-global-claim-fence",
        root_ids=("root-a",),
    )
    for worker_id in (
        "watcher-library-global-deferred-full-scan-1",
        "watcher-library-global-deferred-full-scan-2",
    ):
        assert jobs.claim(
            worker_id=worker_id,
            now=now + timedelta(seconds=2),
            lease_seconds=300,
            kinds=(JobKind.FULL_SCAN,),
        ) is None

    with isolatedPostgres._connect(scope.setup_url) as connection:
        deferred_job = connection.execute(
            """
            select state, attempt_count, lease_owner
            from ops.jobs
            where id = %s
            """,
            (full_scan.job_id,),
        ).fetchone()
    assert deferred_job == {
        "state": "queued",
        "attempt_count": 0,
        "lease_owner": None,
    }

    scans = PostgresScanJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    root_b_publication = scans.publish_claimed_targeted_reconciliation(
        claim=root_b_claim,
        intent_id=root_b.generation_id,
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        stale_scopes=(),
        now=now + timedelta(seconds=3),
    )
    assert root_b_publication["publication_won"] is True
    assert jobs.finish(
        root_b_claim,
        JobTransitionResult(JobState.SUCCEEDED, "scan_completed"),
        now=now + timedelta(seconds=3),
    ) is True

    full_scan_claim = jobs.claim(
        worker_id="watcher-library-global-full-scan",
        now=now + timedelta(seconds=4),
        lease_seconds=300,
        kinds=(JobKind.FULL_SCAN,),
    )
    assert full_scan_claim is not None
    assert full_scan_claim.job_id == full_scan.job_id
    assert full_scan_claim.attempt == 1
    captured = scans.load_claimed_full_scan(
        job_id=full_scan_claim.job_id,
        worker_id=full_scan_claim.worker_id,
        lease_token=full_scan_claim.lease_token,
    )
    assert captured.intent_id == full_scan.intent_id
    assert captured.inventory_mutation_revision == root_b_publication[
        "inventory_mutation_revision"
    ]


def test_retry_wait_repair_fences_overlapping_generation_dispatch(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:retry-wait-dispatch-fence",
        worker_id="watcher-retry-wait-full-scan",
    )
    accepted = seeded.app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "during-retry-wait.mp3"),
        accepted_at=now + timedelta(milliseconds=1),
    )

    assert seeded.jobs.finish(
        seeded.claim,
        JobTransitionResult(
            JobState.RETRY_WAIT,
            "full_scan_revision_conflict",
            scheduled_at=now + timedelta(seconds=5),
        ),
        now=now,
    ) is True
    assert seeded.worker_repository.dispatch_ready(
        now=now + timedelta(seconds=1),
        limit=32,
    ) == ()

    with isolatedPostgres._connect(scope.setup_url) as connection:
        lane = connection.execute(
            """
            select running_generation_id, running_job_id,
                   successor_generation_id
            from library.watcher_lanes
            where library_id = %s and root_id = %s
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()
    assert lane == {
        "running_generation_id": None,
        "running_job_id": None,
        "successor_generation_id": accepted.generation_id,
    }


def test_graceful_restart_reclaims_linked_full_scan_and_finalizes_watcher_repair(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:graceful-restart-repair",
        worker_id="watcher-before-graceful-restart",
    )
    accepted = seeded.app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "accepted-during-restart.mp3"),
        accepted_at=now + timedelta(seconds=1),
    )
    assert seeded.worker_scans.checkpoint_claimed_full_scan(
        intent_id=seeded.intent.intent_id,
        job_id=seeded.claim.job_id,
        attempt=seeded.claim.attempt,
        worker_id=seeded.claim.worker_id,
        lease_token=seeded.claim.lease_token,
        current=3,
        total=4,
        current_path="accepted-before-graceful-restart.mp3",
        phase="indexing",
        now=now + timedelta(seconds=1),
    ) is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        before_restart = connection.execute(
            "select state, completed_at from library.watcher_repairs where id = %s",
            (seeded.repair_id,),
        ).fetchone()
    assert before_restart == {"state": "scanning", "completed_at": None}

    assert seeded.jobs.finish(
        seeded.claim,
        JobTransitionResult(
            JobState.RETRY_WAIT,
            "full_scan_worker_shutdown",
            scheduled_at=now + timedelta(seconds=5),
            preserve_attempt=True,
        ),
        now=now + timedelta(seconds=2),
    ) is True
    with isolatedPostgres._connect(scope.setup_url) as connection:
        retry_wait_intent = connection.execute(
            """
            select state, progress_current, progress_total, progress_phase,
                   current_path, execution_attempt
            from library.full_scan_intents
            where id = %s
            """,
            (seeded.intent.intent_id,),
        ).fetchone()
    assert retry_wait_intent == {
        "state": "retry_wait",
        "progress_current": 3,
        "progress_total": 4,
        "progress_phase": "indexing",
        "current_path": "accepted-before-graceful-restart.mp3",
        "execution_attempt": None,
    }

    replacement = seeded.jobs.claim(
        worker_id="watcher-after-graceful-restart",
        now=now + timedelta(seconds=6),
        lease_seconds=300,
        kinds=(JobKind.FULL_SCAN,),
    )
    assert replacement is not None
    assert replacement.job_id == seeded.claim.job_id
    assert replacement.attempt == seeded.claim.attempt

    replacement_intent = seeded.worker_scans.load_claimed_full_scan(
        job_id=replacement.job_id,
        worker_id=replacement.worker_id,
        lease_token=replacement.lease_token,
    )
    replacement_scope = seeded.worker_scans.load_claimed_full_scan_scope(
        intent_id=replacement_intent.intent_id,
        library_id=scope.library_id,
        job_id=replacement.job_id,
        attempt=replacement.attempt,
        worker_id=replacement.worker_id,
        lease_token=replacement.lease_token,
        now=now + timedelta(seconds=6),
    )
    assert seeded.worker_scans.checkpoint_claimed_full_scan(
        intent_id=replacement_intent.intent_id,
        job_id=replacement.job_id,
        attempt=replacement.attempt,
        worker_id=replacement.worker_id,
        lease_token=replacement.lease_token,
        current=0,
        total=1,
        current_path="",
        phase="indexing",
        now=now + timedelta(seconds=6),
    ) is True
    publication = seeded.worker_scans.publish_claimed_full_scan(
        claim=replacement,
        intent_id=replacement_intent.intent_id,
        expected_inventory_mutation_revision=(
            replacement_intent.inventory_mutation_revision
        ),
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        observed_root_ids=[root["id"] for root in replacement_scope.roots],
        now=now + timedelta(seconds=7),
    )
    assert publication["publication_won"] is True
    assert seeded.jobs.finish(
        replacement,
        JobTransitionResult(JobState.SUCCEEDED, "full_scan_completed"),
        now=now + timedelta(seconds=8),
    ) is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        after_publication = connection.execute(
            """
            select repair.state, repair.completed_at,
                   lane.successor_generation_id
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_lanes as lane
              on lane.library_id = repair_root.library_id
             and lane.root_id = repair_root.root_id
            where repair.id = %s
            """,
            (seeded.repair_id,),
        ).fetchone()
    assert after_publication == {
        "state": "catch_up",
        "completed_at": None,
        "successor_generation_id": accepted.generation_id,
    }

    assert seeded.worker_repository.reconcile_due(
        now=now + timedelta(seconds=9),
        limit=32,
    ) == (accepted.generation_id,)
    catch_up_claim = seeded.jobs.claim(
        worker_id="watcher-after-restart-catch-up",
        now=now + timedelta(seconds=10),
        lease_seconds=300,
        kinds=(JobKind.TARGETED_RECONCILIATION,),
    )
    assert catch_up_claim is not None
    generation = seeded.worker_repository.claim_generation(
        claim=catch_up_claim,
        now=now + timedelta(seconds=10),
    )
    assert generation is not None
    assert generation.generation_id == accepted.generation_id
    _publish_claimed_watcher_generation(
        scope,
        catch_up_claim,
        accepted.generation_id,
        now=now + timedelta(seconds=11),
    )
    assert seeded.jobs.finish(
        catch_up_claim,
        JobTransitionResult(JobState.SUCCEEDED, "scan_completed"),
        now=now + timedelta(seconds=12),
    ) is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.id as repair_id, repair.state, repair.completed_at,
                   repair.inventory_revision, incident.resolved_at,
                   lane.accepted_sequence, lane.applied_sequence,
                   lane.dirty_generation, lane.repaired_dirty_generation,
                   lane.running_generation_id, lane.running_job_id,
                   lane.successor_generation_id,
                   intent.watcher_repair_id,
                   intent.committed_inventory_revision
            from library.watcher_repairs as repair
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents as incident
              on incident.incident_id = repair_root.incident_id
            join library.watcher_lanes as lane
              on lane.library_id = repair_root.library_id
             and lane.root_id = repair_root.root_id
            join library.full_scan_intents as intent
              on intent.id = %s
            where repair.id = %s
            """,
            (replacement_intent.intent_id, seeded.repair_id),
        ).fetchone()
    assert completed["repair_id"] == seeded.repair_id
    assert completed["watcher_repair_id"] == seeded.repair_id
    assert completed["state"] == "complete"
    assert completed["completed_at"] is not None
    assert completed["resolved_at"] is not None
    assert completed["accepted_sequence"] == accepted.participants[0].accepted_sequence_upper
    assert completed["applied_sequence"] == completed["accepted_sequence"]
    assert completed["dirty_generation"] == accepted.participants[0].dirty_generation
    assert completed["repaired_dirty_generation"] == completed["dirty_generation"]
    assert completed["inventory_revision"] == publication["inventory_mutation_revision"]
    assert completed["committed_inventory_revision"] == publication[
        "inventory_mutation_revision"
    ]
    assert completed["running_generation_id"] is None
    assert completed["running_job_id"] is None
    assert completed["successor_generation_id"] is None


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


def test_complete_repair_is_idempotent_after_atomic_full_scan_publication(
    live_watcher_database,
):
    scope = live_watcher_database
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=NOW,
        request_origin_ref="watcher:repair-idempotent-completion",
        worker_id="watcher-repair-idempotent-worker",
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
    assert publication["publication_won"] is True

    def load_repair_completion():
        with isolatedPostgres._connect(scope.setup_url) as connection:
            return connection.execute(
                """
                select repair.state, repair.completed_at,
                       repair.inventory_revision, incident.resolved_at,
                       lane.successor_generation_id,
                       (
                         select count(*)
                         from library.watcher_generation_repairs as link
                         where link.repair_id = repair.id
                       ) as repair_link_count
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
                (seeded.repair_id,),
            ).fetchone()

    completed = load_repair_completion()
    assert completed == {
        "state": "complete",
        "completed_at": completed["completed_at"],
        "inventory_revision": publication["inventory_mutation_revision"],
        "resolved_at": completed["resolved_at"],
        "successor_generation_id": None,
        "repair_link_count": 0,
    }
    assert completed["completed_at"] is not None
    assert completed["resolved_at"] is not None

    assert seeded.worker_repository.complete_repair(
        claim=seeded.claim,
        repair_id=seeded.repair_id,
        inventory_revision=publication["inventory_mutation_revision"],
        now=NOW + timedelta(seconds=1),
    ) is True
    assert load_repair_completion() == completed


def test_scanning_repair_fences_new_generation_until_full_scan_publication(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:scanning-dispatch-fence",
        worker_id="watcher-scanning-dispatch-fence-worker",
    )

    first = seeded.app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "accepted-during-scan-1.mp3"),
        accepted_at=now + timedelta(seconds=1),
    )
    second = seeded.app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "accepted-during-scan-2.mp3"),
        accepted_at=now + timedelta(seconds=2),
    )
    assert second.generation_id == first.generation_id
    assert second.participants[0].accepted_sequence_upper == (
        first.participants[0].accepted_sequence_upper + 1
    )

    assert seeded.worker_repository.dispatch_ready(
        now=now + timedelta(seconds=3),
        limit=32,
    ) == ()
    with isolatedPostgres._connect(scope.setup_url) as connection:
        during_scan = connection.execute(
            """
            select repair.state as repair_state,
                   generation.watcher_job_linked_at,
                   generation.watcher_completed_at,
                   lane.accepted_sequence,
                   lane.applied_sequence,
                   participant.accepted_sequence_lower,
                   participant.accepted_sequence_upper,
                   exists (
                     select 1
                     from library.watcher_generation_repairs as repair_link
                     where repair_link.generation_id = generation.id
                   ) as repair_linked
              from library.watcher_repairs as repair
              join library.watcher_repair_roots as repair_root
                on repair_root.repair_id = repair.id
              join library.watcher_lanes as lane
                on lane.library_id = repair_root.library_id
               and lane.root_id = repair_root.root_id
              join library.targeted_reconciliation_intents as generation
                on generation.id = lane.successor_generation_id
              join library.watcher_generation_participants as participant
                on participant.generation_id = generation.id
               and participant.library_id = lane.library_id
               and participant.root_id = lane.root_id
             where repair.id = %s
               and generation.id = %s
            """,
            (seeded.repair_id, first.generation_id),
        ).fetchone()
    assert during_scan == {
        "repair_state": "scanning",
        "watcher_job_linked_at": None,
        "watcher_completed_at": None,
        "accepted_sequence": second.participants[0].accepted_sequence_upper,
        "applied_sequence": 0,
        "accepted_sequence_lower": 1,
        "accepted_sequence_upper": second.participants[0].accepted_sequence_upper,
        "repair_linked": False,
    }

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
        now=now + timedelta(seconds=4),
    )
    assert publication["publication_won"] is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        catch_up = connection.execute(
            """
            select repair.state as repair_state,
                   generation.watcher_generation_kind,
                   generation.watcher_job_linked_at,
                   generation.watcher_completed_at,
                   lane.accepted_sequence,
                   lane.applied_sequence,
                   participant.accepted_sequence_lower,
                   participant.accepted_sequence_upper,
                   exists (
                     select 1
                     from library.watcher_generation_repairs as repair_link
                     where repair_link.generation_id = generation.id
                       and repair_link.repair_id = repair.id
                   ) as repair_linked
              from library.watcher_repairs as repair
              join library.watcher_repair_roots as repair_root
                on repair_root.repair_id = repair.id
              join library.watcher_lanes as lane
                on lane.library_id = repair_root.library_id
               and lane.root_id = repair_root.root_id
              join library.targeted_reconciliation_intents as generation
                on generation.id = lane.successor_generation_id
              join library.watcher_generation_participants as participant
                on participant.generation_id = generation.id
               and participant.library_id = lane.library_id
               and participant.root_id = lane.root_id
             where repair.id = %s
               and generation.id = %s
            """,
            (seeded.repair_id, first.generation_id),
        ).fetchone()
    assert catch_up == {
        "repair_state": "catch_up",
        "watcher_generation_kind": "root_catch_up",
        "watcher_job_linked_at": None,
        "watcher_completed_at": None,
        "accepted_sequence": second.participants[0].accepted_sequence_upper,
        "applied_sequence": 1,
        "accepted_sequence_lower": 2,
        "accepted_sequence_upper": second.participants[0].accepted_sequence_upper,
        "repair_linked": True,
    }

    assert seeded.jobs.finish(
        seeded.claim,
        JobTransitionResult(JobState.SUCCEEDED, "scan_completed"),
        now=now + timedelta(seconds=5),
    ) is True
    _publish_watcher_generation(
        scope,
        first.generation_id,
        now=now + timedelta(seconds=6),
        worker_id="watcher-scanning-dispatch-catch-up",
    )

    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state as repair_state,
                   repair.completed_at,
                   incident.resolved_at,
                   lane.accepted_sequence,
                   lane.applied_sequence,
                   participant.accepted_sequence_upper,
                   generation.watcher_completed_at
              from library.watcher_repairs as repair
              join library.watcher_repair_roots as repair_root
                on repair_root.repair_id = repair.id
              join library.watcher_incidents as incident
                on incident.incident_id = repair_root.incident_id
              join library.watcher_lanes as lane
                on lane.library_id = repair_root.library_id
               and lane.root_id = repair_root.root_id
              join library.targeted_reconciliation_intents as generation
                on generation.id = %s
              join library.watcher_generation_participants as participant
                on participant.generation_id = generation.id
               and participant.library_id = lane.library_id
               and participant.root_id = lane.root_id
             where repair.id = %s
            """,
            (first.generation_id, seeded.repair_id),
        ).fetchone()
    assert completed["repair_state"] == "complete"
    assert completed["completed_at"] is not None
    assert completed["resolved_at"] is not None
    assert completed["watcher_completed_at"] is not None
    assert completed["accepted_sequence"] == second.participants[0].accepted_sequence_upper
    assert completed["applied_sequence"] == completed["accepted_sequence"]
    assert completed["accepted_sequence_upper"] == completed["accepted_sequence"]


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


def test_root_catch_up_handler_publishes_empty_participant_root_for_late_repair(
    live_watcher_database,
):
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_handler
    from music_app.services.scan_cache_persistence import (
        DurableTargetedReconciliationPreparationAdapter,
    )
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:handler-late-repair-background",
        worker_id="watcher-handler-late-repair-full-scan",
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
    app_scans = PostgresScanJobRepository(
        database_url=scope.app_url,
        connect_to_database=isolatedPostgres._connect,
    )
    repair_request = app_scans.enqueue_full_scan(
        library_id=scope.library_id,
        account_id=scope.account_id,
        capability_key="library.refresh",
        request_origin_ref="watcher:handler-late-repair",
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
    assert seeded.jobs.finish(
        seeded.claim,
        JobTransitionResult(JobState.SUCCEEDED, "scan_completed"),
        now=now + timedelta(seconds=4),
    ) is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        catch_up = connection.execute(
            """
            select repair.id as repair_id, lane.successor_generation_id
            from library.full_scan_intents as intent
            join library.watcher_repairs as original
              on original.id = intent.watcher_repair_id
            join library.watcher_repairs as repair
              on repair.library_id = intent.library_id
             and repair.id <> original.id
             and repair.state = 'catch_up'
            join library.watcher_repair_roots as repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_lanes as lane
              on lane.library_id = repair_root.library_id
             and lane.root_id = repair_root.root_id
            where intent.id = %s
            """,
            (seeded.full_scan.intent_id,),
        ).fetchone()
    assert catch_up["successor_generation_id"] is not None

    recovery = _repository(scope.worker_url)
    assert recovery.dispatch_ready(
        now=now + timedelta(seconds=5),
        limit=32,
    ) == (catch_up["successor_generation_id"],)
    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="watcher-handler-late-repair-catch-up",
        now=now + timedelta(seconds=5),
        lease_seconds=300,
        kinds=(JobKind.TARGETED_RECONCILIATION,),
    )
    assert claim is not None
    assert claim.parameters["intent_id"] == catch_up["successor_generation_id"]

    class RecordingScanRepository(PostgresScanJobRepository):
        def __init__(self):
            super().__init__(
                database_url=scope.worker_url,
                connect_to_database=isolatedPostgres._connect,
            )
            self.publication_errors = []

        def publish_claimed_targeted_reconciliation(self, **kwargs):
            try:
                return super().publish_claimed_targeted_reconciliation(**kwargs)
            except Exception as exc:
                self.publication_errors.append(
                    (getattr(exc, "sqlstate", None), str(exc))
                )
                raise

    class RecordingRecovery:
        def __init__(self):
            self.failure_calls = []

        def claim_generation(self, **kwargs):
            return recovery.claim_generation(**kwargs)

        def fail_generation(self, **kwargs):
            self.failure_calls.append(kwargs)
            return recovery.fail_generation(**kwargs)

    class Context:
        cancel_requested = False
        lease_active = True

        @staticmethod
        def reauthorize():
            return SimpleNamespace(allowed=True, reason_code="authorized")

    scan_repository = RecordingScanRepository()
    recording_recovery = RecordingRecovery()
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=DurableTargetedReconciliationPreparationAdapter(
            build_albums=lambda _cache, _separate_release_keys: [],
        ),
        root_definitions=(),
    )
    handler = build_targeted_reconciliation_handler(
        scan_repository=scan_repository,
        reconciler=reconciler,
        watcher_recovery=recording_recovery,
        clock=lambda: now + timedelta(seconds=6),
    )

    result = handler(claim, Context())

    assert scan_repository.publication_errors == []
    assert result == JobTransitionResult(
        JobState.SUCCEEDED,
        "targeted_reconciliation_completed",
    )
    assert recording_recovery.failure_calls == []
    with isolatedPostgres._connect(scope.setup_url) as connection:
        published = connection.execute(
            """
            select watcher_completed_at
            from library.targeted_reconciliation_intents
            where id = %s
            """,
            (catch_up["successor_generation_id"],),
        ).fetchone()
    assert published["watcher_completed_at"] is not None
    assert jobs.finish(
        claim,
        result,
        now=now + timedelta(seconds=7),
    ) is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state, repair.completed_at, incident.resolved_at,
                   lane.accepted_sequence, lane.applied_sequence,
                   lane.dirty_generation, lane.repaired_dirty_generation,
                   lane.running_generation_id, lane.running_job_id,
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
            (catch_up["repair_id"],),
        ).fetchone()
    assert completed == {
        "state": "complete",
        "completed_at": completed["completed_at"],
        "resolved_at": completed["resolved_at"],
        "accepted_sequence": 2,
        "applied_sequence": 2,
        "dirty_generation": 2,
        "repaired_dirty_generation": 2,
        "running_generation_id": None,
        "running_job_id": None,
        "successor_generation_id": None,
    }
    assert completed["completed_at"] is not None
    assert completed["resolved_at"] is not None


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


def test_linked_multiroot_full_scan_fences_dispatch_until_lease_expires(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    seeded = _seed_claimed_linked_full_scan(
        scope,
        now=now,
        request_origin_ref="watcher:multiroot-dispatch-fence",
        worker_id="watcher-multiroot-dispatch-fence-worker",
        root_ids=("root-a", "root-b"),
    )
    accepted = seeded.app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-b", "during-linked-full-scan.mp3"),
        accepted_at=now + timedelta(seconds=1),
    )

    assert seeded.worker_repository.dispatch_ready(
        now=now + timedelta(seconds=1),
        limit=32,
    ) == ()

    with isolatedPostgres._connect(scope.setup_url) as connection:
        expired = connection.execute(
            """
            update ops.jobs
            set lease_expires_at = %s
            where id = %s
            returning id
            """,
            (now + timedelta(seconds=2), seeded.claim.job_id),
        ).fetchone()
    assert expired == {"id": seeded.claim.job_id}
    assert accepted.generation_id in seeded.worker_repository.dispatch_ready(
        now=now + timedelta(seconds=3),
        limit=32,
    )


def test_linked_full_scan_locks_repair_before_inventory_then_replays_deferred_generation(
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

    first = seeded.app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "during-repair-1.mp3"),
        accepted_at=now + timedelta(seconds=1),
    )
    newest = seeded.app_repository.accept_event(
        library_id=scope.library_id,
        event=_created(scope, "root-a", "during-repair-2.mp3"),
        accepted_at=now + timedelta(seconds=2),
    )
    assert newest.generation_id == first.generation_id
    assert newest.participants[0].accepted_sequence_upper == (
        first.participants[0].accepted_sequence_upper + 1
    )
    assert seeded.worker_repository.dispatch_ready(
        now=now + timedelta(seconds=3),
        limit=32,
    ) == ()

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
    repair_lock_connected = Event()

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

    def lock_repair():
        try:
            with isolatedPostgres._connect(scope.setup_url) as connection:
                connection.execute("set local lock_timeout = '10s'")
                connection.execute("set local statement_timeout = '20s'")
                results["repair_lock_pid"] = connection.execute(
                    "select pg_backend_pid() as pid"
                ).fetchone()["pid"]
                repair_lock_connected.set()
                results["repair_lock"] = connection.execute(
                    "select state from library.watcher_repairs where id = %s for update",
                    (seeded.repair_id,),
                ).fetchone()
        except BaseException as error:
            errors.append(("repair_lock", error))

    full_thread = Thread(target=publish_full_scan, daemon=True)
    repair_lock_thread = Thread(target=lock_repair, daemon=True)
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
                    repair_lock_thread.start()
                    assert repair_lock_connected.wait(timeout=5), errors
                    repair_lock_pid = int(results["repair_lock_pid"])
                    repair_lock_blocked = _wait_for_blocked_backend(
                        observer,
                        query_pid=repair_lock_pid,
                        blocking_pid=full_pid,
                    )
        finally:
            blocker.commit()

    full_thread.join(timeout=25)
    if repair_lock_thread.ident is not None:
        repair_lock_thread.join(timeout=25)
    assert full_blocked, (
        "full publication never reached the held inventory row: "
        f"results={results!r}, errors={errors!r}"
    )
    assert repair_lock_blocked, (
        "repair row was not locked before full publication reached inventory: "
        f"results={results!r}, errors={errors!r}"
    )
    assert not full_thread.is_alive()
    assert not repair_lock_thread.is_alive()
    assert errors == []
    assert results["full"]["publication_won"] is True
    assert results["repair_lock"] == {"state": "catch_up"}
    with isolatedPostgres._connect(scope.setup_url) as connection:
        catch_up = connection.execute(
            """
            select repair.state, repair.inventory_revision,
                   intent.watcher_generation_kind,
                   intent.watcher_job_linked_at,
                   intent.watcher_completed_at,
                   lane.running_generation_id, lane.running_job_id,
                   lane.successor_generation_id,
                   lane.accepted_sequence, lane.applied_sequence,
                   participant.accepted_sequence_lower,
                   participant.accepted_sequence_upper,
                   (select count(*) from ops.jobs as job
                     where job.subject_kind = 'targeted_reconciliation_intent'
                       and job.subject_ref = intent.id::text) as targeted_job_count
            from library.watcher_repairs repair
            join library.targeted_reconciliation_intents intent on intent.id = %s
            join library.watcher_lanes lane
              on lane.library_id = repair.library_id and lane.root_id = %s
            join library.watcher_generation_participants participant
              on participant.generation_id = intent.id
             and participant.library_id = lane.library_id
             and participant.root_id = lane.root_id
            where repair.id = %s
            """,
            (
                newest.generation_id,
                scope.root_database_ids["root-a"],
                seeded.repair_id,
            ),
        ).fetchone()
    assert catch_up == {
        "state": "catch_up",
        "inventory_revision": results["full"]["inventory_mutation_revision"],
        "watcher_generation_kind": "root_catch_up",
        "watcher_job_linked_at": None,
        "watcher_completed_at": None,
        "running_generation_id": None,
        "running_job_id": None,
        "successor_generation_id": newest.generation_id,
        "accepted_sequence": newest.participants[0].accepted_sequence_upper,
        "applied_sequence": 1,
        "accepted_sequence_lower": 2,
        "accepted_sequence_upper": newest.participants[0].accepted_sequence_upper,
        "targeted_job_count": 0,
    }

    assert seeded.jobs.finish(
        seeded.claim,
        JobTransitionResult(JobState.SUCCEEDED, "scan_completed"),
        now=now + timedelta(seconds=4),
    ) is True
    targeted = _publish_watcher_generation(
        scope,
        newest.generation_id,
        now=now + timedelta(seconds=5),
        worker_id="watcher-publication-lock-order-catch-up",
    )
    assert (
        targeted["inventory_mutation_revision"]
        > results["full"]["inventory_mutation_revision"]
    )

    with isolatedPostgres._connect(scope.setup_url) as connection:
        completed = connection.execute(
            """
            select repair.state, repair.completed_at, incident.resolved_at,
                   intent.watcher_completed_at,
                   lane.accepted_sequence, lane.applied_sequence,
                   participant.accepted_sequence_upper
            from library.watcher_repairs repair
            join library.watcher_repair_roots repair_root
              on repair_root.repair_id = repair.id
            join library.watcher_incidents incident
              on incident.incident_id = repair_root.incident_id
            join library.targeted_reconciliation_intents intent on intent.id = %s
            join library.watcher_lanes lane
              on lane.library_id = repair.library_id and lane.root_id = %s
            join library.watcher_generation_participants participant
              on participant.generation_id = intent.id
             and participant.library_id = lane.library_id
             and participant.root_id = lane.root_id
            where repair.id = %s
            """,
            (
                newest.generation_id,
                scope.root_database_ids["root-a"],
                seeded.repair_id,
            ),
        ).fetchone()
    assert completed["state"] == "complete"
    assert completed["completed_at"] is not None
    assert completed["resolved_at"] is not None
    assert completed["watcher_completed_at"] is not None
    assert completed["accepted_sequence"] == newest.participants[0].accepted_sequence_upper
    assert completed["applied_sequence"] == completed["accepted_sequence"]
    assert completed["accepted_sequence_upper"] == completed["accepted_sequence"]


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
    publisher_connected = Event()
    publisher_pids = []

    def connect_publisher(database_url):
        connection = isolatedPostgres._connect(database_url)
        publisher_pids.append(connection.info.backend_pid)
        publisher_connected.set()
        return connection

    publisher_scans = PostgresScanJobRepository(
        database_url=scope.worker_url,
        connect_to_database=connect_publisher,
    )
    errors = []
    results = []

    def publish():
        try:
            results.append(publisher_scans.publish_claimed_targeted_reconciliation(
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
        blocker.execute(
            """
            select 1 from library.watcher_lanes
            where library_id = %s and root_id = %s
            for update
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        )
        thread = Thread(target=publish, daemon=True)
        try:
            thread.start()
            assert publisher_connected.wait(timeout=5), (
                "targeted publisher did not connect: "
                f"results={results!r}, errors={errors!r}"
            )
            with isolatedPostgres._connect(scope.setup_url) as observer:
                blocked = _wait_for_blocked_backend(
                    observer,
                    query_pid=publisher_pids[0],
                    blocking_pid=blocker.info.backend_pid,
                )
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
        finally:
            blocker.commit()
            if thread.ident is not None:
                thread.join(timeout=5)

    assert not thread.is_alive()
    assert len(errors) == 1
    assert isinstance(errors[0], psycopg.errors.SerializationFailure)
    assert not isinstance(errors[0], psycopg.errors.DeadlockDetected)


def test_failed_root_catch_up_preserves_specific_incident_reason_and_identity(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    root_id = scope.root_database_ids["root-a"]

    dirty = app_repository.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="root_unavailable",
        observed_at=now,
    )
    assert worker_repository.dispatch_ready(
        now=now + timedelta(seconds=1),
        limit=32,
    ) == (dirty.generation_id,)

    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="worker-specific-incident",
        now=now + timedelta(seconds=1),
        lease_seconds=30,
    )
    assert claim is not None
    generation = worker_repository.claim_generation(
        claim=claim,
        now=now + timedelta(seconds=1),
    )
    assert generation is not None
    assert generation.generation_kind == "root_catch_up"

    with isolatedPostgres._connect(scope.setup_url) as connection:
        before = connection.execute(
            """
            select incident.incident_id,
                   incident.warning_token,
                   incident.reason_code,
                   incident.occurrence_count,
                   lane.accepted_sequence,
                   lane.applied_sequence,
                   lane.dirty_generation,
                   lane.repaired_dirty_generation
            from library.watcher_incidents as incident
            join library.watcher_lanes as lane
              on lane.library_id = incident.library_id
             and lane.root_id = incident.root_id
            where incident.library_id = %s
              and incident.root_id = %s
              and incident.resolved_at is null
            """,
            (scope.library_id, root_id),
        ).fetchone()
    assert before is not None
    assert str(before["incident_id"]) == dirty.incident_id
    assert str(before["warning_token"]) == dirty.warning_token
    assert before["reason_code"] == "root_unavailable"
    assert before["occurrence_count"] == 1

    assert worker_repository.fail_generation(
        claim=claim,
        generation=generation,
        reason_code="reconciliation_failed",
        now=now + timedelta(seconds=2),
    ) is True

    with isolatedPostgres._connect(scope.setup_url) as connection:
        after = connection.execute(
            """
            select incident.incident_id,
                   incident.warning_token,
                   incident.reason_code,
                   incident.occurrence_count,
                   lane.accepted_sequence,
                   lane.applied_sequence,
                   lane.dirty_generation,
                   lane.repaired_dirty_generation,
                   lane.running_generation_id,
                   lane.running_job_id,
                   lane.successor_generation_id,
                   successor.watcher_generation_kind,
                   participant.accepted_sequence_lower,
                   participant.accepted_sequence_upper,
                   participant.dirty_generation as participant_dirty_generation
            from library.watcher_incidents as incident
            join library.watcher_lanes as lane
              on lane.library_id = incident.library_id
             and lane.root_id = incident.root_id
            join library.targeted_reconciliation_intents as successor
              on successor.id = lane.successor_generation_id
            join library.watcher_generation_participants as participant
              on participant.generation_id = successor.id
             and participant.library_id = lane.library_id
             and participant.root_id = lane.root_id
            where incident.library_id = %s
              and incident.root_id = %s
              and incident.resolved_at is null
            """,
            (scope.library_id, root_id),
        ).fetchone()

    assert after is not None
    assert after["incident_id"] == before["incident_id"]
    assert after["warning_token"] == before["warning_token"]
    assert after["reason_code"] == "root_unavailable"
    assert after["occurrence_count"] == before["occurrence_count"] + 1
    assert after["accepted_sequence"] == before["accepted_sequence"]
    assert after["applied_sequence"] == before["applied_sequence"]
    assert after["dirty_generation"] == before["dirty_generation"] + 1
    assert after["repaired_dirty_generation"] == before["repaired_dirty_generation"]
    assert after["running_generation_id"] is None
    assert after["running_job_id"] is None
    assert after["successor_generation_id"] != generation.generation_id
    assert after["watcher_generation_kind"] == "root_catch_up"
    assert after["accepted_sequence_lower"] == after["accepted_sequence"]
    assert after["accepted_sequence_upper"] == after["accepted_sequence"]
    assert after["participant_dirty_generation"] == after["dirty_generation"]


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
        incident = connection.execute(
            """
            select reason_code, occurrence_count
            from library.watcher_incidents
            where library_id = %s and root_id = %s
              and resolved_at is null
            """,
            (scope.library_id, scope.root_database_ids["root-a"]),
        ).fetchone()

    assert lane["running_generation_id"] is None
    assert lane["running_job_id"] is None
    assert lane["successor_generation_id"] is not None
    assert lane["disposition_code"] == "dirty"
    assert successor["watcher_generation_kind"] == "root_catch_up"
    assert incident == {
        "reason_code": "reconciliation_failed",
        "occurrence_count": 1,
    }


def test_due_reconciliation_preserves_specific_incident_reason_and_identity(
    live_watcher_database,
):
    scope = live_watcher_database
    now = datetime.now(timezone.utc)
    app_repository = _repository(scope.app_url)
    worker_repository = _repository(scope.worker_url)
    root_id = scope.root_database_ids["root-a"]

    dirty = app_repository.mark_dirty(
        library_id=scope.library_id,
        logical_root_id="root-a",
        reason_code="root_unavailable",
        observed_at=now,
    )
    assert worker_repository.dispatch_ready(
        now=now + timedelta(seconds=1),
        limit=32,
    ) == (dirty.generation_id,)

    jobs = PostgresJobRepository(
        database_url=scope.worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="worker-due-specific-incident",
        now=now + timedelta(seconds=1),
        lease_seconds=30,
    )
    assert claim is not None
    generation = worker_repository.claim_generation(
        claim=claim,
        now=now + timedelta(seconds=1),
    )
    assert generation is not None
    assert generation.generation_kind == "root_catch_up"

    with isolatedPostgres._connect(scope.setup_url) as connection:
        before = connection.execute(
            """
            select incident.incident_id,
                   incident.warning_token,
                   incident.reason_code,
                   incident.occurrence_count,
                   lane.accepted_sequence,
                   lane.applied_sequence,
                   lane.dirty_generation,
                   lane.repaired_dirty_generation
            from library.watcher_incidents as incident
            join library.watcher_lanes as lane
              on lane.library_id = incident.library_id
             and lane.root_id = incident.root_id
            where incident.library_id = %s
              and incident.root_id = %s
              and incident.resolved_at is null
            """,
            (scope.library_id, root_id),
        ).fetchone()
    assert before is not None
    assert str(before["incident_id"]) == dirty.incident_id
    assert str(before["warning_token"]) == dirty.warning_token
    assert before["reason_code"] == "root_unavailable"
    assert before["occurrence_count"] == 1

    assert jobs.finish(
        claim,
        JobTransitionResult(JobState.CANCELED, "worker_shutdown"),
        now=now + timedelta(seconds=2),
    ) is True
    assert worker_repository.reconcile_due(
        now=now + timedelta(seconds=2),
        limit=32,
    ) == (generation.generation_id,)

    with isolatedPostgres._connect(scope.setup_url) as connection:
        after = connection.execute(
            """
            select incident.incident_id,
                   incident.warning_token,
                   incident.reason_code,
                   incident.occurrence_count,
                   lane.accepted_sequence,
                   lane.applied_sequence,
                   lane.dirty_generation,
                   lane.repaired_dirty_generation,
                   lane.running_generation_id,
                   lane.running_job_id,
                   lane.successor_generation_id,
                   successor.watcher_generation_kind,
                   participant.accepted_sequence_lower,
                   participant.accepted_sequence_upper,
                   participant.dirty_generation as participant_dirty_generation
            from library.watcher_incidents as incident
            join library.watcher_lanes as lane
              on lane.library_id = incident.library_id
             and lane.root_id = incident.root_id
            join library.targeted_reconciliation_intents as successor
              on successor.id = lane.successor_generation_id
            join library.watcher_generation_participants as participant
              on participant.generation_id = successor.id
             and participant.library_id = lane.library_id
             and participant.root_id = lane.root_id
            where incident.library_id = %s
              and incident.root_id = %s
              and incident.resolved_at is null
            """,
            (scope.library_id, root_id),
        ).fetchone()

    assert after is not None
    assert after["incident_id"] == before["incident_id"]
    assert after["warning_token"] == before["warning_token"]
    assert after["reason_code"] == "root_unavailable"
    assert after["occurrence_count"] == before["occurrence_count"] + 1
    assert after["accepted_sequence"] == before["accepted_sequence"]
    assert after["applied_sequence"] == before["applied_sequence"]
    assert after["dirty_generation"] == before["dirty_generation"] + 1
    assert after["repaired_dirty_generation"] == before["repaired_dirty_generation"]
    assert after["running_generation_id"] is None
    assert after["running_job_id"] is None
    assert after["successor_generation_id"] != generation.generation_id
    assert after["watcher_generation_kind"] == "root_catch_up"
    assert after["accepted_sequence_lower"] == after["accepted_sequence"]
    assert after["accepted_sequence_upper"] == after["accepted_sequence"]
    assert after["participant_dirty_generation"] == after["dirty_generation"]


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
