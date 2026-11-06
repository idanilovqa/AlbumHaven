from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
from urllib.parse import urlparse

import pytest
from psycopg.types.json import Jsonb

from music_app.services.jobs.authorization import (
    AuthorizationDecision,
    JobAuthorizationService,
    PostgresJobAuthorizationContextRepository,
)
from music_app.services.jobs.models import ClaimedJob
from music_app.services.policy_evaluator import PolicyEvaluator
from tests.e2e.support import isolatedPostgres


def _skip_or_fail_ci(message: str) -> None:
    is_ci = any(
        str(os.environ.get(name) or "").strip().casefold()
        in {"1", "true", "yes"}
        for name in ("CI", "GITHUB_ACTIONS")
    )
    if is_ci:
        pytest.fail(message, pytrace=False)
    pytest.skip(message)


def _database_urls_or_skip() -> tuple[str, str, str]:
    try:
        setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    except RuntimeError:
        _skip_or_fail_ci("Dedicated setup and runtime Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    worker_url = str(
        os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or ""
    ).strip()
    if not worker_url:
        _skip_or_fail_ci("Dedicated worker Postgres URL is not configured.")
    pgpass_path = Path(str(os.environ.get("PGPASSFILE") or ""))
    if not pgpass_path.is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")

    identities = {
        (
            (urlparse(value).hostname or "").casefold(),
            urlparse(value).port or 5432,
            urlparse(value).path.lstrip("/"),
        )
        for value in (setup_url, runtime_url, worker_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Dedicated Postgres role URLs do not share one database.")
    try:
        with isolatedPostgres._connect(worker_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection, "album_haven_worker"
            )
    except Exception:
        _skip_or_fail_ci("Dedicated worker Postgres role is unavailable.")
    return setup_url, runtime_url, worker_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(
            connection, isolatedPostgres.SETUP_ROLE
        )
        connection.execute(
            "drop schema if exists app, integration, library, ops cascade"
        )


def _seed_authorization_scope(setup_url: str) -> tuple[int, int, int]:
    with isolatedPostgres._connect(setup_url) as connection:
        account_id = int(
            connection.execute(
                """
                insert into app.accounts (
                  display_name, username_display, username_normalized,
                  contact_email, contact_email_normalized, account_kind,
                  is_active
                ) values (
                  'Task Four Actor', 'task-four-actor', 'task-four-actor',
                  'task-four-actor@example.invalid',
                  'task-four-actor@example.invalid', 'managed', true
                ) returning id
                """
            ).fetchone()["id"]
        )
        connection.execute(
            """
            insert into app.bootstrap_owners (account_id, owner_key)
            values (%s, 'local-bootstrap-owner')
            on conflict (owner_key) do update
              set account_id = excluded.account_id
            """,
            (account_id,),
        )
        library_id = int(
            connection.execute(
                """
                insert into library.libraries (
                  owner_account_id, name, library_kind
                ) values (%s, 'Phase 8 Task 4 Library', 'local')
                returning id
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
        origin_id = int(
            connection.execute(
                """
                insert into app.request_origins (
                  account_id, client_surface_class, origin_type, origin_key
                ) values (%s, 'private_web', 'browser', 'phase8-task4-origin')
                returning id
                """,
                (account_id,),
            ).fetchone()["id"]
        )
        connection.execute(
            """
            insert into library.library_roots (
              library_id, root_path, root_kind, is_active
            ) values (%s, 'C:\\private\\phase8-task4', 'main', true)
            """,
            (library_id,),
        )
    return account_id, library_id, origin_id


def _claim(account_id: int, library_id: int, origin_id: int) -> ClaimedJob:
    now = datetime.now(timezone.utc)
    return ClaimedJob(
        job_id=41,
        kind="full_scan",
        subject_kind="library",
        subject_ref=str(library_id),
        parameters={},
        account_id=account_id,
        library_id=library_id,
        capability_key="library.refresh",
        request_origin_id=origin_id,
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        idempotency_key="phase8:task4:live",
        attempt=1,
        max_attempts=2,
        worker_id="phase8-task4-worker",
        lease_token="phase8-task4-lease",
        lease_expires_at=now + timedelta(minutes=5),
        scheduled_at=now,
    )


def _persist_claim(setup_url: str, claim: ClaimedJob) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            """
            insert into ops.jobs (
              id, kind, state, subject_kind, subject_ref, parameters,
              account_id, library_id, capability_key, request_origin_id,
              deployment_mode, client_surface, idempotency_key,
              scheduled_at, attempt_count, max_attempts, recovery_policy,
              lease_owner, lease_token, lease_expires_at, heartbeat_at,
              started_at, updated_at
            ) overriding system value values (
              %s, %s, 'running', %s, %s, %s, %s, %s, %s, %s,
              %s, %s, %s, %s, %s, %s, 'retry_safe', %s, %s, %s, %s, %s, %s
            )
            """,
            (
                claim.job_id, str(claim.kind), claim.subject_kind, claim.subject_ref,
                Jsonb(claim.parameters), claim.account_id, claim.library_id,
                claim.capability_key, claim.request_origin_id, claim.deployment_mode,
                claim.client_surface, claim.idempotency_key, claim.scheduled_at,
                claim.attempt, claim.max_attempts, claim.worker_id, claim.lease_token,
                claim.lease_expires_at, claim.scheduled_at, claim.scheduled_at,
                claim.scheduled_at,
            ),
        )


def _assert_worker_select_denied(worker_url: str, statement: str) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with isolatedPostgres._connect(worker_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection, "album_haven_worker"
            )
            connection.execute(statement).fetchall()


def _mutate_authorization_scope(setup_url: str, statement: str, parameters=()) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(
            connection, isolatedPostgres.SETUP_ROLE
        )
        connection.execute(statement, parameters)


def _assert_worker_has_no_direct_authorization_reads(
    worker_url: str, account_id: int, library_id: int, origin_id: int
) -> None:
    permitted_queries = (
        (
            "select id, is_active, disabled_at from app.accounts where id = %s",
            (account_id,),
        ),
        (
            "select account_id, owner_key from app.bootstrap_owners "
            "where account_id = %s",
            (account_id,),
        ),
        (
            "select id, owner_account_id from library.libraries where id = %s",
            (library_id,),
        ),
        (
            "select library_id, account_id, membership_role "
            "from library.library_memberships "
            "where library_id = %s and account_id = %s",
            (library_id, account_id),
        ),
        (
            "select account_id, capability_key, scope_kind, scope_id, revoked_at "
            "from app.capabilities where account_id = %s",
            (account_id,),
        ),
        (
            "select id, account_id, client_surface_class, origin_type "
            "from app.request_origins where id = %s",
            (origin_id,),
        ),
    )
    table_names = (
        "app.accounts",
        "app.bootstrap_owners",
        "library.libraries",
        "library.library_memberships",
        "app.capabilities",
        "app.request_origins",
    )
    with isolatedPostgres._connect(worker_url) as connection:
        isolatedPostgres._assert_connected_role(
            connection, "album_haven_worker"
        )
        for table_name in table_names:
            permitted = connection.execute(
                "select has_table_privilege(current_user, %s, 'select') as permitted",
                (table_name,),
            ).fetchone()["permitted"]
            assert permitted is False
    for statement, parameters in permitted_queries:
        import psycopg

        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with isolatedPostgres._connect(worker_url) as connection:
                connection.execute(statement, parameters).fetchall()


def test_live_worker_authorization_snapshot_is_usable_and_private():
    setup_url, runtime_url, worker_url = _database_urls_or_skip()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        account_id, library_id, origin_id = _seed_authorization_scope(setup_url)
        claim = _claim(account_id, library_id, origin_id)
        _persist_claim(setup_url, claim)
        repository = PostgresJobAuthorizationContextRepository(
            worker_url, connect_to_database=isolatedPostgres._connect
        )
        context = repository.load_authorization_context(
            claim, datetime.now(timezone.utc)
        )

        assert context.actor is not None
        assert context.actor.account_id == account_id
        assert context.actor.session_id is None
        assert context.membership_current is True
        assert context.library_current is True
        assert context.request_origin_id == origin_id
        assert context.deployment_allowed is True
        assert context.client_surface_allowed is True

        service = JobAuthorizationService(
            context_repository=repository,
            policy_evaluator=PolicyEvaluator(),
            resource_validators={
                "full_scan": lambda claimed, loaded, now: AuthorizationDecision(
                    True, "resource_scope_current"
                )
            },
        )
        assert service.authorize(
            claim, datetime.now(timezone.utc)
        ) == AuthorizationDecision(True, "bootstrap_owner")

        _assert_worker_has_no_direct_authorization_reads(
            worker_url, account_id, library_id, origin_id
        )

        for statement in (
            "select encoded_hash from app.account_credentials",
            "select contact_email from app.accounts",
            "select origin_key from app.request_origins",
            "select root_path from library.library_roots",
        ):
            _assert_worker_select_denied(worker_url, statement)

        _mutate_authorization_scope(
            setup_url,
            "update app.accounts set disabled_at = now() where id = %s",
            (account_id,),
        )
        assert service.authorize(
            claim, datetime.now(timezone.utc)
        ) == AuthorizationDecision(False, "actor_inactive")
        _mutate_authorization_scope(
            setup_url,
            "update app.accounts set disabled_at = null where id = %s",
            (account_id,),
        )

        _mutate_authorization_scope(
            setup_url,
            "delete from library.library_memberships "
            "where library_id = %s and account_id = %s",
            (library_id, account_id),
        )
        assert service.authorize(
            claim, datetime.now(timezone.utc)
        ) == AuthorizationDecision(False, "membership_revoked")
        _mutate_authorization_scope(
            setup_url,
            "insert into library.library_memberships "
            "(library_id, account_id, membership_role) values (%s, %s, 'owner')",
            (library_id, account_id),
        )

        _mutate_authorization_scope(
            setup_url,
            "delete from app.bootstrap_owners where account_id = %s",
            (account_id,),
        )
        _mutate_authorization_scope(
            setup_url,
            "update app.capabilities set revoked_at = now() "
            "where account_id = %s and capability_key = 'library.refresh' "
            "and scope_kind = 'library' and scope_id = %s",
            (account_id, library_id),
        )
        assert service.authorize(
            claim, datetime.now(timezone.utc)
        ) == AuthorizationDecision(False, "capability_revoked")
        _mutate_authorization_scope(
            setup_url,
            "update app.capabilities set revoked_at = null "
            "where account_id = %s and capability_key = 'library.refresh' "
            "and scope_kind = 'library' and scope_id = %s",
            (account_id, library_id),
        )
        _mutate_authorization_scope(
            setup_url,
            "insert into app.bootstrap_owners (account_id, owner_key) "
            "values (%s, 'local-bootstrap-owner')",
            (account_id,),
        )

        _mutate_authorization_scope(
            setup_url,
            "delete from app.request_origins where id = %s",
            (origin_id,),
        )
        assert service.authorize(
            claim, datetime.now(timezone.utc)
        ) == AuthorizationDecision(False, "request_origin_revoked")
    finally:
        _drop_schemas(setup_url)
