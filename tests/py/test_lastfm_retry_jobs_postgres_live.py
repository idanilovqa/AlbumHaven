from __future__ import annotations

from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from music_app.services.lastfm_retry_jobs_postgres import (
    PostgresLastfmRetryJobRepository,
)
from music_app.services.lastfm_postgres import LastfmPostgresAdapter
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.jobs.models import JobState, JobTransitionResult
from music_app.services.jobs.authorization import (
    AuthorizationDecision,
    JobAuthorizationService,
    PostgresJobAuthorizationContextRepository,
    build_lastfm_retry_resource_validator,
)
from music_app.services.policy_evaluator import PolicyEvaluator
from tests.e2e.support import isolatedPostgres


def _skip_or_fail_ci(message: str) -> None:
    if any(
        str(os.environ.get(name) or "").strip().casefold() in {"1", "true", "yes"}
        for name in ("CI", "GITHUB_ACTIONS")
    ):
        pytest.fail(message, pytrace=False)
    pytest.skip(message)


def _database_urls_or_skip() -> tuple[str, str]:
    try:
        setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    except RuntimeError:
        _skip_or_fail_ci("Dedicated setup and runtime Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    if not Path(str(os.environ.get("PGPASSFILE") or "")).is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")
    identities = {
        (
            (urlparse(url).hostname or "").casefold(),
            urlparse(url).port or 5432,
            urlparse(url).path,
        )
        for url in (setup_url, runtime_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Dedicated Postgres roles do not share one database.")
    return setup_url, runtime_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("drop schema if exists app, integration, library, ops cascade")


@pytest.fixture(scope="module")
def _live_lastfm_schema():
    setup_url, runtime_url = _database_urls_or_skip()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        yield setup_url, runtime_url
    finally:
        _drop_schemas(setup_url)


@pytest.fixture
def live_lastfm_database(_live_lastfm_schema):
    setup_url, runtime_url = _live_lastfm_schema
    isolatedPostgres.reset_application_tables(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    try:
        yield setup_url, runtime_url
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


def _seed_scope(setup_url: str) -> tuple[int, int, int, str]:
    suffix = uuid4().hex[:10]
    origin_key = f"lastfm-origin-{suffix}"
    with isolatedPostgres._connect(setup_url) as connection:
        account_id = int(
            connection.execute(
                """
                insert into app.accounts (
                  display_name, username_display, username_normalized,
                  contact_email, contact_email_normalized, account_kind, is_active
                ) values (%s, %s, %s, %s, %s, 'managed', true)
                returning id
                """,
                (
                    suffix,
                    suffix,
                    suffix,
                    f"{suffix}@example.invalid",
                    f"{suffix}@example.invalid",
                ),
            ).fetchone()["id"]
        )
        library_id = int(
            connection.execute(
                "insert into library.libraries (owner_account_id, name, library_kind) "
                "values (%s, %s, 'local') returning id",
                (account_id, f"Lastfm {suffix}"),
            ).fetchone()["id"]
        )
        connection.execute(
            "insert into library.library_memberships "
            "(library_id, account_id, membership_role) values (%s, %s, 'owner')",
            (library_id, account_id),
        )
        connection.execute(
            "insert into app.capabilities "
            "(account_id, capability_key, scope_kind, scope_id) "
            "values (%s, 'integration.lastfm.scrobble', 'library', %s)",
            (account_id, library_id),
        )
        connection.execute(
            "insert into app.request_origins "
            "(account_id, client_surface_class, origin_type, origin_key) "
            "values (%s, 'private_web', 'browser', %s)",
            (account_id, origin_key),
        )
        session_id = int(
            connection.execute(
                "insert into integration.lastfm_sessions "
                "(account_id, provider_username, session_key_encrypted, is_active) "
                "values (%s, %s, 'encrypted-test-secret', true) returning id",
                (account_id, f"lastfm-{suffix}"),
            ).fetchone()["id"]
        )
    return account_id, library_id, session_id, origin_key


def _checkpoint_reauthentication(setup_url, runtime_url, scope, *, request_ref=None, secret="reconnected-secret", expected_generation=None):
    account_id, library_id, session_id, origin_key = scope
    with isolatedPostgres._connect(setup_url) as connection:
        username = connection.execute(
            "select provider_username from integration.lastfm_sessions where id=%s", (session_id,),
        ).fetchone()["provider_username"]
        if expected_generation is None:
            expected_generation = connection.execute(
                "select coalesce((select generation from integration.lastfm_reauthentication_continuations "
                "where account_id=%s and library_id=%s),0) as generation", (account_id, library_id),
            ).fetchone()["generation"]
    return LastfmPostgresAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}).save_settings(
        {"username": username, "session_key": secret, "user_timezone": "UTC"},
        account_id=account_id,
        reauthentication_context={
            "library_id": library_id, "request_origin_ref": f"browser:{origin_key}",
            "deployment_mode": "self_hosted_private_web", "client_surface": "private_web",
            "request_ref": request_ref or uuid4().hex,
            "expected_generation": expected_generation,
        },
    )


def _seed_held_lastfm_backlog(setup_url, scope, now, count, *, generation=0):
    account_id, library_id, session_id, _origin_key = scope
    prefix = f"held-backlog-{uuid4().hex}-"
    with isolatedPostgres._connect(setup_url) as connection:
        rows = connection.execute(
            "insert into integration.pending_scrobbles "
            "(account_id,library_id,track_key,played_at,attempt_count,status,payload,active_session_id,reauthentication_generation) "
            "select %s,%s,'opaque-track',%s,1,'reauthentication_required', "
            "jsonb_build_object('source_family','runtime_lastfm_sync_state_adapter',"
            "'source_key',%s||n::text,'source_payload',jsonb_build_object("
            "'artist','Artist','title','Song '||n::text,'track_ref','opaque-track','started_at_unix',%s-n)),%s,%s "
            "from generate_series(1,%s) n returning id",
            (account_id, library_id, now - timedelta(minutes=5), prefix,
             int(now.timestamp()) - 300, session_id, generation, count),
        ).fetchall()
        connection.execute(
            "insert into integration.listen_history "
            "(account_id,library_id,played_at,source_family,source_entry_id,metadata) "
            "select account_id,library_id,played_at,payload->>'source_family',payload->>'source_key',"
            "(payload->'source_payload') || '{\"scrobble_durable_job_owned\":true}'::jsonb "
            "from integration.pending_scrobbles where account_id=%s and library_id=%s "
            "and left(payload->>'source_key',length(%s))=%s",
            (account_id, library_id, prefix, prefix),
        )
    return {int(row["id"]) for row in rows}


def _lastfm_worker_components():
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    jobs = PostgresJobRepository(database_url=worker_url, connect_to_database=isolatedPostgres._connect)
    retries = PostgresLastfmRetryJobRepository(
        database_url=worker_url, connect_to_database=isolatedPostgres._connect, job_repository=jobs,
    )
    authorization = JobAuthorizationService(
        context_repository=PostgresJobAuthorizationContextRepository(
            worker_url, connect_to_database=isolatedPostgres._connect,
        ),
        policy_evaluator=PolicyEvaluator(),
        resource_validators={"lastfm_scrobble_retry": build_lastfm_retry_resource_validator(retry_repository=retries)},
    )
    return jobs, retries, authorization


def test_live_retry_acceptance_preserves_identity_and_converges_duplicate_job(
    live_lastfm_database,
):
    setup_url, _runtime_url = live_lastfm_database
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)
    jobs = PostgresJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
    )
    repository = PostgresLastfmRetryJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=jobs,
    )
    now = datetime.now(timezone.utc)
    values = dict(
        account_id=account_id,
        library_id=library_id,
        source_family="runtime_lastfm_sync_state_adapter",
        source_key=f"listen-{uuid4().hex}",
        track_key="opaque-track",
        played_at=now - timedelta(minutes=5),
        previous_attempts=1,
        next_attempt_at=now + timedelta(seconds=60),
        active_session_id=session_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        payload={"source_payload": {"artist": "private", "title": "private"}},
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(repository.accept_retryable_pending, **values) for _ in range(2)]
        accepted, duplicate = [future.result(timeout=10) for future in futures]

    assert duplicate == accepted
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select id, current_job_id, accepted_attempt, row_revision "
            "from integration.pending_scrobbles where id = %s",
            (accepted.pending_scrobble_id,),
        ).fetchone()
        job = connection.execute(
            "select parameters, subject_kind, subject_ref, max_attempts "
            "from ops.jobs where id = %s",
            (accepted.job_id,),
        ).fetchone()
    assert int(pending["id"]) == accepted.pending_scrobble_id
    assert int(pending["current_job_id"]) == accepted.job_id
    assert int(pending["accepted_attempt"]) == 2
    assert job["parameters"] == {"active_session_ref": str(session_id)}
    assert job["subject_kind"] == "pending_scrobble"
    assert job["subject_ref"] == str(accepted.pending_scrobble_id)
    assert int(job["max_attempts"]) == 1


def test_live_sync_state_updates_retain_the_same_pending_scrobble_id(
    live_lastfm_database,
):
    setup_url, _runtime_url = live_lastfm_database
    with isolatedPostgres._connect(setup_url) as connection:
        context = connection.execute(
            """
            select owner.account_id, library.id as library_id
              from app.bootstrap_owners as owner
              join library.libraries as library
                on library.owner_account_id = owner.account_id
               and library.name = 'Local Library'
               and library.library_kind = 'local'
             where owner.owner_key = 'local-bootstrap-owner'
            """
        ).fetchone()
        account_id = int(context["account_id"])
        library_id = int(context["library_id"])
    adapter = LastfmPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=isolatedPostgres._connect,
    )
    source_key = f"stable-{uuid4().hex}"
    first = {
        "pending_scrobbles": {
            source_key: {"retry_count": 1, "last_error": "first", "track_ref": "opaque"}
        },
        "sync_problems": {},
        "last_retry_summary": {},
    }
    adapter.save_sync_state(first)
    with isolatedPostgres._connect(setup_url) as connection:
        first_id = int(
            connection.execute(
                "select id from integration.pending_scrobbles "
                "where account_id = %s and library_id = %s and payload ->> 'source_key' = %s",
                (account_id, library_id, source_key),
            ).fetchone()["id"]
        )
    first["pending_scrobbles"][source_key]["retry_count"] = 2
    first["pending_scrobbles"][source_key]["last_error"] = "second"
    adapter.save_sync_state(first)
    with isolatedPostgres._connect(setup_url) as connection:
        second = connection.execute(
            "select id, attempt_count from integration.pending_scrobbles "
            "where account_id = %s and library_id = %s and payload ->> 'source_key' = %s",
            (account_id, library_id, source_key),
        ).fetchone()
    assert int(second["id"]) == first_id
    assert int(second["attempt_count"]) == 2


def test_live_retry_enqueue_failure_rolls_back_new_pending_identity(
    live_lastfm_database,
):
    setup_url, _runtime_url = live_lastfm_database
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)

    class FailingJobs:
        @staticmethod
        def enqueue_in_transaction(_connection, _command):
            raise RuntimeError("forced generic enqueue failure")

    repository = PostgresLastfmRetryJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=FailingJobs(),
    )
    source_key = f"rollback-{uuid4().hex}"
    now = datetime.now(timezone.utc)

    with pytest.raises(RuntimeError, match="forced generic enqueue failure"):
        repository.accept_retryable_pending(
            account_id=account_id,
            library_id=library_id,
            source_family="runtime_lastfm_sync_state_adapter",
            source_key=source_key,
            track_key="opaque-track",
            played_at=now,
            previous_attempts=1,
            next_attempt_at=now,
            active_session_id=session_id,
            request_origin_ref=f"browser:{origin_key}",
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            payload={},
        )

    with isolatedPostgres._connect(setup_url) as connection:
        count = int(
            connection.execute(
                "select count(*) as count from integration.pending_scrobbles "
                "where account_id = %s and library_id = %s "
                "and payload ->> 'source_key' = %s",
                (account_id, library_id, source_key),
            ).fetchone()["count"]
        )
    assert count == 0


def test_live_worker_authorizes_exact_session_and_cannot_select_secret_table(
    live_lastfm_database,
):
    import psycopg

    setup_url, _runtime_url = live_lastfm_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    accepted = PostgresLastfmRetryJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
    ).accept_retryable_pending(
        account_id=account_id,
        library_id=library_id,
        source_family="runtime_lastfm_sync_state_adapter",
        source_key=f"worker-auth-{uuid4().hex}",
        track_key="opaque-track",
        played_at=now - timedelta(minutes=5),
        previous_attempts=1,
        next_attempt_at=now,
        active_session_id=session_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        payload={"source_payload": {"artist": "private", "title": "private"}},
    )
    jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="lastfm-auth-live",
        now=now + timedelta(seconds=1),
        lease_seconds=60,
        kinds=("lastfm_scrobble_retry",),
    )
    assert claim is not None and claim.job_id == accepted.job_id
    retry_repository = PostgresLastfmRetryJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=jobs,
    )
    authorization = JobAuthorizationService(
        context_repository=PostgresJobAuthorizationContextRepository(
            worker_url, connect_to_database=isolatedPostgres._connect
        ),
        policy_evaluator=PolicyEvaluator(),
        resource_validators={
            "lastfm_scrobble_retry": build_lastfm_retry_resource_validator(
                retry_repository=retry_repository
            )
        },
    )
    observed_at = now + timedelta(seconds=2)

    assert authorization.authorize(claim, observed_at) in {
        AuthorizationDecision(True, "authorized"),
        AuthorizationDecision(True, "bootstrap_owner"),
    }
    assert retry_repository.load_claimed_session_secret(
        pending_scrobble_id=accepted.pending_scrobble_id,
        active_session_id=session_id,
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=observed_at,
    ) == "encrypted-test-secret"

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with isolatedPostgres._connect(worker_url) as connection:
            connection.execute(
                "select session_key_encrypted from integration.lastfm_sessions"
            ).fetchall()

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update integration.lastfm_sessions set is_active = false where id = %s",
            (session_id,),
        )
    assert authorization.authorize(claim, observed_at) == AuthorizationDecision(
        False, "lastfm_retry_scope_stale"
    )
    assert retry_repository.load_claimed_session_secret(
        pending_scrobble_id=accepted.pending_scrobble_id,
        active_session_id=session_id,
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=observed_at,
    ) is None


@pytest.mark.parametrize(
    ("disposition", "expected_status", "expects_next_job"),
    [
        ("accepted", "completed", False),
        ("known_not_sent_retryable", "accepted", True),
        ("possible_send_ambiguous", "ambiguous", False),
    ],
)
def test_live_claimed_attempt_state_machine_is_fenced_and_composes_domain_retry(
    live_lastfm_database, disposition, expected_status, expects_next_job
):
    setup_url, _runtime_url = live_lastfm_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    source_key = f"state-machine-{uuid4().hex}"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into integration.listen_history "
            "(account_id, library_id, played_at, source_family, source_entry_id, metadata) "
            "values (%s, %s, %s, 'runtime_lastfm_sync_state_adapter', %s, '{}'::jsonb)",
            (account_id, library_id, now - timedelta(minutes=5), source_key),
        )
    accepted = PostgresLastfmRetryJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
    ).accept_retryable_pending(
        account_id=account_id,
        library_id=library_id,
        source_family="runtime_lastfm_sync_state_adapter",
        source_key=source_key,
        track_key="opaque-track",
        played_at=now - timedelta(minutes=5),
        previous_attempts=1,
        next_attempt_at=now,
        active_session_id=session_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        payload={
            "source_payload": {
                "artist": "Artist",
                "title": "Song",
                "started_at_unix": 12345,
            }
        },
    )
    jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id=f"lastfm-state-{disposition}",
        now=now + timedelta(seconds=1),
        lease_seconds=60,
        kinds=("lastfm_scrobble_retry",),
    )
    assert claim is not None and claim.job_id == accepted.job_id
    repository = PostgresLastfmRetryJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=jobs,
    )
    claim_values = dict(
        pending_scrobble_id=accepted.pending_scrobble_id,
        active_session_id=session_id,
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=now + timedelta(seconds=2),
    )

    scope = repository.begin_claimed_attempt(**claim_values)
    assert scope.row_revision == accepted.row_revision + 1
    assert scope.payload["artist"] == "Artist"
    result = repository.finalize_claimed_attempt(
        **claim_values,
        expected_row_revision=scope.row_revision,
        disposition=disposition,
        reason_code="bounded_test_outcome",
        history_updates={"durable_test_marker": disposition},
    )

    assert result.domain_status == expected_status
    assert (result.next_job_id is not None) is expects_next_job
    with pytest.raises(ValueError, match="could not be finalized"):
        repository.finalize_claimed_attempt(
            **claim_values,
            expected_row_revision=scope.row_revision,
            disposition=disposition,
            reason_code="bounded_test_outcome",
            history_updates={},
        )
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select status, attempt_count, accepted_attempt, current_job_id, "
            "last_provider_disposition from integration.pending_scrobbles where id = %s",
            (accepted.pending_scrobble_id,),
        ).fetchone()
        history = connection.execute(
            "select scrobble_status, metadata from integration.listen_history "
            "where source_entry_id = %s",
            (source_key,),
        ).fetchone()
    assert pending["status"] == expected_status
    assert int(pending["attempt_count"]) == 2
    assert pending["last_provider_disposition"] == disposition
    assert history["scrobble_status"] == expected_status
    assert history["metadata"]["durable_test_marker"] == disposition
    if expects_next_job:
        assert int(pending["accepted_attempt"]) == 3
        assert int(pending["current_job_id"]) == result.next_job_id


@pytest.mark.parametrize("invalid", [
    "expired-lease", "cancel-requested", "wrong-worker", "wrong-token",
    "wrong-attempt", "wrong-session", "inactive-session", "continuation-session-mismatch",
])
def test_live_claimed_credentials_reject_invalid_claim_or_session(live_lastfm_database, invalid):
    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    _seed_held_lastfm_backlog(setup_url, scope, now, 1)
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    jobs, worker, _authorization = _lastfm_worker_components()
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 1
    claim = jobs.claim(worker_id="typed-credential-fence", now=now + timedelta(seconds=2),
                       lease_seconds=60, kinds=("lastfm_scrobble_retry",))
    assert claim is not None
    pending_id = int(claim.subject_ref)
    values = dict(pending_scrobble_id=pending_id, active_session_id=scope[2], job_id=claim.job_id,
                  attempt=claim.attempt, worker_id=claim.worker_id, lease_token=claim.lease_token,
                  now=now + timedelta(seconds=3))
    credentials = worker.load_claimed_session_credentials(**values)
    credentials_present = credentials is not None
    assert credentials_present
    secret_matches = credentials.session_key == "reconnected-secret"
    assert secret_matches
    assert credentials.active_session_id == scope[2]
    assert credentials.reauthentication_generation == 1

    if invalid == "expired-lease":
        values["now"] = now + timedelta(minutes=2)
    elif invalid == "wrong-worker":
        values["worker_id"] = "another-worker"
    elif invalid == "wrong-token":
        values["lease_token"] = "another-lease"
    elif invalid == "wrong-attempt":
        values["attempt"] = claim.attempt + 1
    elif invalid == "wrong-session":
        values["active_session_id"] = scope[2] + 1
    elif invalid == "cancel-requested":
        cancellation = PostgresJobRepository(
            database_url=runtime_url, connect_to_database=isolatedPostgres._connect,
        ).request_cancel(claim.job_id, actor_account_id=scope[0], now=values["now"])
        assert cancellation.disposition.value == "running_requested"
    else:
        with isolatedPostgres._connect(setup_url) as connection:
            if invalid == "inactive-session":
                connection.execute("update integration.lastfm_sessions set is_active=false where id=%s", (scope[2],))
            else:
                alternate = connection.execute(
                    "insert into integration.lastfm_sessions "
                    "(account_id,provider_username,session_key_encrypted,is_active) "
                    "select account_id,provider_username||'-alternate',session_key_encrypted,false "
                    "from integration.lastfm_sessions where id=%s returning id", (scope[2],),
                ).fetchone()["id"]
                connection.execute(
                    "update integration.lastfm_reauthentication_continuations set active_session_id=%s "
                    "where account_id=%s and library_id=%s", (alternate, *scope[:2]),
                )

    def persisted_state():
        with isolatedPostgres._connect(setup_url) as connection:
            pending = connection.execute(
                "select status,attempt_count,accepted_attempt,row_revision,current_job_id,active_session_id "
                "from integration.pending_scrobbles where id=%s", (pending_id,),
            ).fetchone()
            job = connection.execute(
                "select state,attempt_count,scope_version,resource_revision,cancel_requested_at,lease_expires_at "
                "from ops.jobs where id=%s", (claim.job_id,),
            ).fetchone()
        return pending, job

    before = persisted_state()
    rejected = worker.load_claimed_session_credentials(**values) is None
    assert rejected
    assert persisted_state() == before


def test_live_provider_send_holds_no_worker_transaction_or_domain_lock(live_lastfm_database, monkeypatch):
    from music_app.jobs.lastfm_handlers import build_lastfm_retry_handler
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.lastfm import LastfmSubmissionOutcome

    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    _seed_held_lastfm_backlog(setup_url, scope, now, 1)
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    connect = isolatedPostgres._connect
    worker_connections = []
    worker_pids = set()

    def observed_connect(database_url):
        connection = connect(database_url)
        if database_url == worker_url:
            worker_connections.append(connection)
            worker_pids.add(connection.info.backend_pid)
        return connection

    monkeypatch.setattr(isolatedPostgres, "_connect", observed_connect)
    jobs, worker, authorization = _lastfm_worker_components()
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 1
    claim = jobs.claim(worker_id="provider-transaction-proof", now=now + timedelta(seconds=2),
                       lease_seconds=60, kinds=("lastfm_scrobble_retry",))
    assert claim is not None
    pending_id = int(claim.subject_ref)
    observed_at = now + timedelta(seconds=3)
    provider_calls = []

    def provider(_config, _payload, secret):
        provider_calls.append(True)
        secret_matches = secret == "reconnected-secret"
        assert secret_matches
        assert worker_pids and all(pid > 0 for pid in worker_pids)
        assert worker_connections and all(connection.closed for connection in worker_connections)
        with connect(setup_url) as observer:
            no_worker_transaction = observer.execute(
                "select not exists (select 1 from pg_stat_activity "
                "where pid=any(%s) and xact_start is not null) as clear", (list(worker_pids),),
            ).fetchone()["clear"]
            assert no_worker_transaction
            locks = [
                observer.execute("select id from integration.pending_scrobbles where id=%s for update nowait",
                                 (pending_id,)).fetchone() is not None,
                observer.execute("select id from ops.jobs where id=%s for update nowait",
                                 (claim.job_id,)).fetchone() is not None,
                observer.execute("select account_id from integration.lastfm_reauthentication_continuations "
                                 "where account_id=%s and library_id=%s for update nowait", scope[:2]).fetchone() is not None,
            ]
            assert locks == [True, True, True]
        return LastfmSubmissionOutcome(sent=True, accepted=1)

    outcome = build_lastfm_retry_handler(retry_repository=worker, config={}, scrobble_with_session=provider,
                                         clock=lambda: observed_at)(
        claim, ExecutionContext(claim, authorization_service=authorization, clock=lambda: observed_at),
    )
    assert provider_calls == [True]
    assert outcome.next_state is JobState.SUCCEEDED
    assert jobs.finish(claim, outcome, now=observed_at)
    with connect(setup_url) as connection:
        pending = connection.execute(
            "select status,attempt_count,last_provider_disposition from integration.pending_scrobbles where id=%s",
            (pending_id,),
        ).fetchone()
        job_state = connection.execute("select state from ops.jobs where id=%s", (claim.job_id,)).fetchone()["state"]
    assert pending["status"] == "completed"
    assert int(pending["attempt_count"]) == 2
    assert pending["last_provider_disposition"] == "accepted"
    assert job_state == "succeeded"


def test_live_expired_claim_cannot_cancel_lastfm_before_send(
    live_lastfm_database,
):
    setup_url, _runtime_url = live_lastfm_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    accepted = PostgresLastfmRetryJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
    ).accept_retryable_pending(
        account_id=account_id,
        library_id=library_id,
        source_family="runtime_lastfm_sync_state_adapter",
        source_key=f"expired-cancel-{uuid4().hex}",
        track_key="opaque-track",
        played_at=now - timedelta(minutes=5),
        previous_attempts=1,
        next_attempt_at=now,
        active_session_id=session_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        payload={"source_payload": {"artist": "Artist", "title": "Song"}},
    )
    jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="lastfm-expired-cancel-live",
        now=now + timedelta(seconds=1),
        lease_seconds=1,
        kinds=("lastfm_scrobble_retry",),
    )
    assert claim is not None and claim.job_id == accepted.job_id
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.jobs set lease_expires_at = clock_timestamp() - interval '1 second' "
            "where id = %s",
            (claim.job_id,),
        )
    repository = PostgresLastfmRetryJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )

    assert repository.cancel_claimed_before_send(
        pending_scrobble_id=accepted.pending_scrobble_id,
        active_session_id=session_id,
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=now - timedelta(minutes=5),
        reason_code="expired_claim",
    ) is False
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select status, last_provider_disposition, repair_reason_code "
            "from integration.pending_scrobbles where id = %s",
            (accepted.pending_scrobble_id,),
        ).fetchone()
    assert pending["status"] == "accepted"
    assert pending["last_provider_disposition"] is None
    assert pending["repair_reason_code"] is None


def test_live_playback_failure_composition_converges_duplicate_listen_identity(
    live_lastfm_database,
):
    setup_url, _runtime_url = live_lastfm_database
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)
    repository = PostgresLastfmRetryJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
    )
    now = datetime.now(timezone.utc)
    listen_id = f"playback-{uuid4().hex}"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            """
            insert into integration.listen_history (
              account_id, library_id, played_at, source_family,
              source_entry_id, metadata
            ) values (%s, %s, %s, 'runtime_lastfm_sync_state_adapter', %s, '{}'::jsonb)
            """,
            (account_id, library_id, now, listen_id),
        )
    values = dict(
        account_id=account_id,
        library_id=library_id,
        listen_id=listen_id,
        entry={
            "artist": "Artist",
            "title": "Song",
            "track_ref": "opaque-track",
            "started_at_unix": 12345,
        },
        retry_count=1,
        error="bounded known no-send failure",
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        now=now,
    )

    first = repository.accept_playback_failure(**values)
    duplicate = repository.accept_playback_failure(**values)

    assert duplicate == first
    with isolatedPostgres._connect(setup_url) as connection:
        job_count = int(
            connection.execute(
                "select count(*) as count from ops.jobs where idempotency_key = %s",
                (f"lastfm-scrobble:{first.pending_scrobble_id}:attempt:2",),
            ).fetchone()["count"]
        )
        pending = connection.execute(
            "select active_session_id from integration.pending_scrobbles where id = %s",
            (first.pending_scrobble_id,),
        ).fetchone()
        durable_owned = connection.execute(
            """
            select metadata->>'scrobble_durable_job_owned' as owned
              from integration.listen_history
             where account_id = %s and library_id = %s
               and source_family = 'runtime_lastfm_sync_state_adapter'
               and source_entry_id = %s
            """,
            (account_id, library_id, listen_id),
        ).fetchone()["owned"]
    assert job_count == 1
    assert int(pending["active_session_id"]) == session_id
    assert durable_owned == "true"


def test_live_reauthentication_hold_persists_ownership_and_reconnect_sends_only_durably(
    live_lastfm_database, monkeypatch,
):
    import json
    from music_app.jobs.lastfm_handlers import build_lastfm_retry_handler
    from music_app.jobs.worker import ExecutionContext
    from music_app.services import lastfm_retry
    from music_app.services.lastfm import LastfmSubmissionOutcome

    setup_url, runtime_url = live_lastfm_database
    account_id, library_id, old_session_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    listen_id = f"held-history-{uuid4().hex}"
    entry = {"id": listen_id, "artist": "Artist", "title": "Song", "track_ref": "opaque-track",
             "started_at_unix": int(now.timestamp()) - 300, "scrobbled": False,
             "scrobble_eligible": True, "scrobble_retryable": True,
             "scrobble_reauthentication_required": True}
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into integration.listen_history "
            "(account_id, library_id, played_at, source_family, source_entry_id, metadata) "
            "values (%s, %s, %s, 'runtime_lastfm_sync_state_adapter', %s, %s::jsonb)",
            (account_id, library_id, now - timedelta(minutes=5), listen_id, json.dumps(entry)),
        )
    repository = PostgresLastfmRetryJobRepository(database_url=runtime_url, connect_to_database=isolatedPostgres._connect)
    request = dict(account_id=account_id, library_id=library_id, listen_id=listen_id, entry=entry,
                   retry_count=1, error="session expired", request_origin_ref=f"browser:{origin_key}",
                   deployment_mode="self_hosted_private_web", client_surface="private_web", now=now,
                   reauthentication_required=True)
    held = repository.accept_playback_failure(**request)
    assert held.job_id is None
    assert repository.accept_playback_failure(**request).pending_scrobble_id == held.pending_scrobble_id

    def persisted_entry():
        with isolatedPostgres._connect(setup_url) as connection:
            return connection.execute(
                "select metadata from integration.listen_history where account_id=%s and library_id=%s "
                "and source_family='runtime_lastfm_sync_state_adapter' and source_entry_id=%s",
                (account_id, library_id, listen_id),
            ).fetchone()["metadata"]

    assert persisted_entry()["scrobble_durable_job_owned"] is True
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update integration.lastfm_sessions set is_active=false where id=%s", (old_session_id,))
        session_id = int(connection.execute(
            "insert into integration.lastfm_sessions (account_id,provider_username,session_key_encrypted,is_active) "
            "values (%s,'reconnected-test','reconnected-secret',true) returning id", (account_id,),
        ).fetchone()["id"])
    release_options = dict(account_id=account_id, library_id=library_id,
                           request_origin_ref=f"browser:{origin_key}", deployment_mode="self_hosted_private_web",
                           client_surface="private_web", now=now + timedelta(seconds=1))
    released = repository.release_after_reauthentication(**release_options)
    assert len(released) == 1 and released[0].pending_scrobble_id == held.pending_scrobble_id
    assert repository.release_after_reauthentication(**release_options) == ()
    assert persisted_entry()["scrobble_durable_job_owned"] is True

    def legacy_provider(*_args, **_kwargs):
        pytest.fail("legacy reconnect retry must exclude durably owned history")

    with monkeypatch.context() as patch:
        patch.setattr(lastfm_retry, "scrobble_tracks", legacy_provider)
        result = lastfm_retry.retry_pending_lastfm_scrobbles(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url, "LASTFM_API_ENABLED": True},
            reauthenticated=True, account_id=account_id, library_ids=frozenset({library_id}),
        )
    assert result.summary["pending_before"] == result.summary["attempted"] == 0

    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    jobs = PostgresJobRepository(database_url=worker_url, connect_to_database=isolatedPostgres._connect)
    claim = jobs.claim(worker_id="reauth-owned-test", now=now + timedelta(seconds=2), lease_seconds=60,
                       kinds=("lastfm_scrobble_retry",))
    assert claim is not None and claim.job_id == released[0].job_id
    retries = PostgresLastfmRetryJobRepository(database_url=worker_url,
        connect_to_database=isolatedPostgres._connect, job_repository=jobs)
    authorization = JobAuthorizationService(
        context_repository=PostgresJobAuthorizationContextRepository(worker_url, connect_to_database=isolatedPostgres._connect),
        policy_evaluator=PolicyEvaluator(),
        resource_validators={"lastfm_scrobble_retry": build_lastfm_retry_resource_validator(retry_repository=retries)},
    )
    observed_at = now + timedelta(seconds=3)
    context = ExecutionContext(claim, authorization_service=authorization, clock=lambda: observed_at)
    provider_calls = []

    def provider(_config, payload, secret):
        assert secret == "reconnected-secret"
        provider_calls.append(payload)
        return LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted")

    outcome = build_lastfm_retry_handler(retry_repository=retries, config={}, scrobble_with_session=provider,
                                         clock=lambda: observed_at)(claim, context)
    assert outcome.next_state is JobState.SUCCEEDED and outcome.reason_code == "lastfm_scrobble_accepted"
    assert jobs.finish(claim, outcome, now=observed_at)
    assert len(provider_calls) == 1
    assert jobs.claim(worker_id="reauth-owned-test", now=observed_at, lease_seconds=60,
                      kinds=("lastfm_scrobble_retry",)) is None
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute("select status,active_session_id from integration.pending_scrobbles where id=%s",
                                     (held.pending_scrobble_id,)).fetchone()
        count = connection.execute("select count(*) as count from ops.jobs where kind='lastfm_scrobble_retry' "
                                   "and subject_ref=%s", (str(held.pending_scrobble_id),)).fetchone()["count"]
    assert pending["status"] == "completed" and int(pending["active_session_id"]) == session_id
    assert count == 1
    assert persisted_entry()["scrobbled"] is True
    assert persisted_entry()["scrobble_durable_job_owned"] is True


@pytest.mark.parametrize("fail_checkpoint", [False, True], ids=["commit-together", "rollback-together"])
def test_live_reauthentication_credentials_and_generation_commit_atomically(
    live_lastfm_database, fail_checkpoint,
):
    """New API/schema contract; missing API/table is not behavioral RED evidence."""
    setup_url, runtime_url = live_lastfm_database
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        username = connection.execute(
            "select provider_username from integration.lastfm_sessions where id=%s", (session_id,),
        ).fetchone()["provider_username"]
    adapter = LastfmPostgresAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url})
    context = dict(
        library_id=library_id, request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web", client_surface="private_web",
        request_ref=uuid4().hex,
        expected_generation=0,
    )
    trigger_name = f"reject_lastfm_checkpoint_{uuid4().hex}"
    if fail_checkpoint:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                f"create function integration.{trigger_name}() returns trigger language plpgsql as $$ "
                "begin raise exception 'test checkpoint persistence rejected'; end $$"
            )
            connection.execute(
                f"create trigger {trigger_name} before insert or update "
                "on integration.lastfm_reauthentication_continuations "
                f"for each row execute function integration.{trigger_name}()"
            )
    try:
        settings = {"username": username, "session_key": "atomic-reconnected-secret", "user_timezone": "UTC"}
        if fail_checkpoint:
            with pytest.raises(Exception, match="test checkpoint persistence rejected"):
                adapter.save_settings(settings, account_id=account_id, reauthentication_context=context)
        else:
            adapter.save_settings(settings, account_id=account_id, reauthentication_context=context)
        with isolatedPostgres._connect(setup_url) as connection:
            session = connection.execute(
                "select id, session_key_encrypted, is_active from integration.lastfm_sessions "
                "where account_id=%s and provider_username=%s", (account_id, username),
            ).fetchone()
            checkpoint = connection.execute(
                "select generation, active_session_id, drain_requested "
                "from integration.lastfm_reauthentication_continuations "
                "where account_id=%s and library_id=%s", (account_id, library_id),
            ).fetchone()
        assert int(session["id"]) == session_id and session["is_active"]
        if fail_checkpoint:
            assert session["session_key_encrypted"] == "encrypted-test-secret"
            assert checkpoint is None
        else:
            assert session["session_key_encrypted"] == "atomic-reconnected-secret"
            assert checkpoint is not None
            assert checkpoint["generation"] == 1
            assert int(checkpoint["active_session_id"]) == session_id
            assert checkpoint["drain_requested"] is True
    finally:
        if fail_checkpoint:
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute(
                    f"drop trigger {trigger_name} on integration.lastfm_reauthentication_continuations"
                )
                connection.execute(f"drop function integration.{trigger_name}()")


@pytest.mark.parametrize("backlog_size", [101, 1000])
def test_live_one_reconnect_drains_entire_held_backlog_in_bounded_worker_cycles(
    live_lastfm_database, backlog_size,
):
    setup_url, runtime_url = live_lastfm_database
    account_id, library_id, _session_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    repository = PostgresLastfmRetryJobRepository(
        database_url=runtime_url, connect_to_database=isolatedPostgres._connect,
    )
    pending_ids = _seed_held_lastfm_backlog(
        setup_url, (account_id, library_id, _session_id, origin_key), now, backlog_size,
    )
    # One reconnect request only; continuation must survive new repository instances.
    _checkpoint_reauthentication(setup_url, runtime_url, (account_id, library_id, _session_id, origin_key))
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    previous_jobs, previous_held = 0, backlog_size
    for cycle in range((backlog_size + 99) // 100 + 1):
        worker = PostgresLastfmRetryJobRepository(
            database_url=worker_url, connect_to_database=isolatedPostgres._connect,
        )
        composed = worker.reconcile_due_pending(
            now=now + timedelta(seconds=cycle + 2), limit=100,
        )
        assert 0 <= composed <= 100
        with isolatedPostgres._connect(setup_url) as connection:
            counts = connection.execute(
                "select count(*) filter(where status='reauthentication_required') as held,"
                "count(current_job_id) as jobs from integration.pending_scrobbles "
                "where account_id=%s and library_id=%s", (account_id, library_id),
            ).fetchone()
        assert 0 <= counts["jobs"] - previous_jobs <= 100
        assert 0 <= previous_held - counts["held"] <= 100
        previous_jobs, previous_held = counts["jobs"], counts["held"]
    with isolatedPostgres._connect(setup_url) as connection:
        rows = connection.execute(
            "select id, status, current_job_id from integration.pending_scrobbles "
            "where account_id=%s and library_id=%s order by id",
            (account_id, library_id),
        ).fetchall()
        job_rows = connection.execute(
            "select subject_ref, count(*) as count from ops.jobs "
            "where kind='lastfm_scrobble_retry' and account_id=%s and library_id=%s "
            "group by subject_ref",
            (account_id, library_id),
        ).fetchall()
    assert {int(row["id"]) for row in rows} == pending_ids
    assert all(row["status"] == "accepted" and row["current_job_id"] is not None for row in rows), (
        "one successful reconnect must not strand held rows beyond its first 100"
    )
    assert {int(row["subject_ref"]) for row in job_rows} == pending_ids
    assert all(row["count"] == 1 for row in job_rows)
    assert worker.reconcile_due_pending(now=now + timedelta(minutes=1), limit=100) == 0


@pytest.mark.parametrize("reconnect_during_send", [True, False], ids=["old-credentials", "current-credentials"])
def test_live_late_authentication_failure_uses_captured_credentials_generation(
    live_lastfm_database, reconnect_during_send,
):
    from music_app.jobs.lastfm_handlers import build_lastfm_retry_handler
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.lastfm import LastfmError

    setup_url, runtime_url = live_lastfm_database
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    repository = PostgresLastfmRetryJobRepository(
        database_url=runtime_url, connect_to_database=isolatedPostgres._connect,
    )
    def reconnect():
        # Same username/session ID is intentional: ID comparison is insufficient.
        _checkpoint_reauthentication(setup_url, runtime_url, (account_id, library_id, session_id, origin_key))

    if not reconnect_during_send:
        reconnect()
    accepted = repository.accept_retryable_pending(
        account_id=account_id, library_id=library_id,
        source_family="runtime_lastfm_sync_state_adapter", source_key=f"late-{uuid4().hex}",
        track_key="opaque-track", played_at=now - timedelta(minutes=5),
        previous_attempts=1, next_attempt_at=now, active_session_id=session_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web", client_surface="private_web",
        payload={"source_payload": {"artist": "Artist", "title": "Song", "started_at_unix": int(now.timestamp()) - 300}},
    )
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    jobs = PostgresJobRepository(database_url=worker_url, connect_to_database=isolatedPostgres._connect)
    worker = PostgresLastfmRetryJobRepository(
        database_url=worker_url, connect_to_database=isolatedPostgres._connect, job_repository=jobs,
    )
    authorization = JobAuthorizationService(
        context_repository=PostgresJobAuthorizationContextRepository(
            worker_url, connect_to_database=isolatedPostgres._connect,
        ),
        policy_evaluator=PolicyEvaluator(),
        resource_validators={"lastfm_scrobble_retry": build_lastfm_retry_resource_validator(retry_repository=worker)},
    )
    claim = jobs.claim(worker_id="late-auth-response", now=now, lease_seconds=60, kinds=("lastfm_scrobble_retry",))
    assert claim is not None and claim.job_id == accepted.job_id
    observed_at = now + timedelta(seconds=1)
    context = ExecutionContext(claim, authorization_service=authorization, clock=lambda: observed_at)
    provider_secrets = []

    def provider(_config, _payload, secret):
        provider_secrets.append(secret)
        if reconnect_during_send:
            reconnect()
        raise LastfmError("session expired", code=9, reauthentication_required=True)

    outcome = build_lastfm_retry_handler(
        retry_repository=worker, config={}, scrobble_with_session=provider,
        clock=lambda: observed_at,
    )(claim, context)
    assert provider_secrets == ["encrypted-test-secret" if reconnect_during_send else "reconnected-secret"]
    assert outcome.next_state is JobState.SUCCEEDED
    assert jobs.finish(claim, outcome, now=observed_at)
    worker.reconcile_due_pending(now=now + timedelta(seconds=2), limit=100)
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select status, current_job_id, active_session_id from integration.pending_scrobbles where id=%s",
            (accepted.pending_scrobble_id,),
        ).fetchone()
        job_count = connection.execute(
            "select count(*) as count from ops.jobs where kind='lastfm_scrobble_retry' and subject_ref=%s",
            (str(accepted.pending_scrobble_id),),
        ).fetchone()["count"]
    assert int(pending["active_session_id"]) == session_id
    if reconnect_during_send:
        assert pending["status"] == "accepted", "late old-credential failure must use the already successful reconnect"
        assert pending["current_job_id"] != accepted.job_id
        assert job_count == 2
    else:
        assert pending["status"] == "reauthentication_required"
        assert job_count == 1


def test_live_one_reconnect_sends_all_101_held_listens_once(live_lastfm_database):
    from music_app.jobs.lastfm_handlers import build_lastfm_retry_handler
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.lastfm import LastfmSubmissionOutcome

    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    pending_ids = _seed_held_lastfm_backlog(setup_url, scope, now, 101)
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    sent = []

    def provider(_config, payload, secret):
        assert secret == "reconnected-secret"
        sent.append(dict(payload))
        return LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted")

    for cycle in range(3):
        # Recreate worker objects, exactly as after process restart.
        jobs, retries, authorization = _lastfm_worker_components()
        assert 0 <= retries.reconcile_due_pending(now=datetime.now(timezone.utc), limit=100) <= 100
        handler = build_lastfm_retry_handler(
            retry_repository=retries, config={}, scrobble_with_session=provider,
            clock=lambda: datetime.now(timezone.utc),
        )
        for _ in range(101):
            claim = jobs.claim(worker_id="whole-backlog", now=datetime.now(timezone.utc), lease_seconds=60, kinds=("lastfm_scrobble_retry",))
            if claim is None:
                break
            outcome = handler(claim, ExecutionContext(claim, authorization_service=authorization, clock=lambda: datetime.now(timezone.utc)))
            assert outcome.next_state is JobState.SUCCEEDED
            assert outcome.reason_code == "lastfm_scrobble_accepted"
            assert jobs.finish(claim, outcome, now=datetime.now(timezone.utc))
    assert len(sent) == 101
    assert len({(payload["track"], payload["timestamp"]) for payload in sent}) == 101
    assert jobs.claim(worker_id="whole-backlog", now=datetime.now(timezone.utc), lease_seconds=60, kinds=("lastfm_scrobble_retry",)) is None
    with isolatedPostgres._connect(setup_url) as connection:
        rows = connection.execute(
            "select p.id,p.status,count(j.id) as jobs from integration.pending_scrobbles p "
            "left join ops.jobs j on j.subject_kind='pending_scrobble' and j.subject_ref=p.id::text "
            "and j.kind='lastfm_scrobble_retry' where p.account_id=%s and p.library_id=%s "
            "group by p.id,p.status", scope[:2],
        ).fetchall()
        history = connection.execute(
            "select metadata from integration.listen_history where account_id=%s and library_id=%s", scope[:2],
        ).fetchall()
    assert {int(row["id"]) for row in rows} == pending_ids
    assert all(row["status"] == "completed" and row["jobs"] == 1 for row in rows)
    assert len(history) == 101
    assert all(row["metadata"]["scrobbled"] and row["metadata"]["scrobble_durable_job_owned"] for row in history)


def test_live_reauthentication_checkpoint_replay_is_idempotent_but_new_request_advances(live_lastfm_database):
    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    request_ref = uuid4().hex
    _checkpoint_reauthentication(setup_url, runtime_url, scope, request_ref=request_ref, expected_generation=0)
    _checkpoint_reauthentication(setup_url, runtime_url, scope, request_ref=request_ref, expected_generation=0)
    with isolatedPostgres._connect(setup_url) as connection:
        first = connection.execute(
            "select generation,active_session_id from integration.lastfm_reauthentication_continuations "
            "where account_id=%s and library_id=%s", scope[:2],
        ).fetchone()
    assert first["generation"] == 1 and int(first["active_session_id"]) == scope[2]
    with pytest.raises(ValueError):
        _checkpoint_reauthentication(setup_url, runtime_url, scope, request_ref=request_ref, secret="different-secret", expected_generation=0)
    _checkpoint_reauthentication(setup_url, runtime_url, scope, request_ref=uuid4().hex)
    with isolatedPostgres._connect(setup_url) as connection:
        second = connection.execute(
            "select generation,active_session_id from integration.lastfm_reauthentication_continuations "
            "where account_id=%s and library_id=%s", scope[:2],
        ).fetchone()
        secret = connection.execute("select session_key_encrypted from integration.lastfm_sessions where id=%s", (scope[2],)).fetchone()
    assert second["generation"] == 2 and int(second["active_session_id"]) == scope[2]
    assert secret["session_key_encrypted"] == "reconnected-secret"


@pytest.mark.parametrize("ordinary_change", ["timezone", "same-settings"])
def test_live_ordinary_settings_save_does_not_advance_or_release_holds(live_lastfm_database, ordinary_change):
    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    now = datetime.now(timezone.utc)
    held_ids = _seed_held_lastfm_backlog(setup_url, scope, now, 1, generation=1)
    adapter = LastfmPostgresAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url})
    saved = adapter.load_settings(account_id=scope[0])
    if ordinary_change == "timezone":
        saved["user_timezone"] = "America/Denver"
    adapter.save_settings(saved, account_id=scope[0])
    _jobs, retries, _authorization = _lastfm_worker_components()
    assert retries.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 0
    with isolatedPostgres._connect(setup_url) as connection:
        checkpoint = connection.execute(
            "select generation from integration.lastfm_reauthentication_continuations where account_id=%s and library_id=%s", scope[:2],
        ).fetchone()
        pending = connection.execute("select status from integration.pending_scrobbles where id=%s", (next(iter(held_ids)),)).fetchone()
    assert checkpoint["generation"] == 1
    assert pending["status"] == "reauthentication_required"


def test_live_reauthentication_continuation_does_not_cross_account_or_library(live_lastfm_database):
    setup_url, runtime_url = live_lastfm_database
    own, other = _seed_scope(setup_url), _seed_scope(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        other_library = int(connection.execute(
            "insert into library.libraries(owner_account_id,name,library_kind) values(%s,'Other scope','local') returning id", (own[0],),
        ).fetchone()["id"])
        connection.execute("insert into library.library_memberships(library_id,account_id,membership_role) values(%s,%s,'owner')", (other_library, own[0]))
    same_account = (own[0], other_library, own[2], own[3])
    now = datetime.now(timezone.utc)
    own_ids = _seed_held_lastfm_backlog(setup_url, own, now, 1)
    untouched_ids = _seed_held_lastfm_backlog(setup_url, other, now, 1) | _seed_held_lastfm_backlog(setup_url, same_account, now, 1)
    _checkpoint_reauthentication(setup_url, runtime_url, own)
    _jobs, retries, _authorization = _lastfm_worker_components()
    assert retries.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 1
    with isolatedPostgres._connect(setup_url) as connection:
        rows = connection.execute("select id,status,current_job_id from integration.pending_scrobbles where id=any(%s)", (list(own_ids | untouched_ids),)).fetchall()
    assert all(row["status"] == "reauthentication_required" and row["current_job_id"] is None for row in rows if int(row["id"]) in untouched_ids)
    assert all(row["status"] == "accepted" and row["current_job_id"] is not None for row in rows if int(row["id"]) in own_ids)


def test_live_concurrent_reauthentication_drainers_admit_each_hold_once(live_lastfm_database):
    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    pending_ids = _seed_held_lastfm_backlog(setup_url, scope, now, 201)
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    workers = [_lastfm_worker_components()[1] for _ in range(2)]
    for cycle in range(4):
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda worker: worker.reconcile_due_pending(now=now + timedelta(seconds=cycle + 1), limit=100), workers))
        assert all(0 <= count <= 100 for count in results)
    with isolatedPostgres._connect(setup_url) as connection:
        rows = connection.execute(
            "select p.id,p.status,count(j.id) as jobs from integration.pending_scrobbles p "
            "left join ops.jobs j on j.subject_kind='pending_scrobble' and j.subject_ref=p.id::text "
            "and j.kind='lastfm_scrobble_retry' where p.account_id=%s and p.library_id=%s "
            "group by p.id,p.status", scope[:2],
        ).fetchall()
    assert {int(row["id"]) for row in rows} == pending_ids
    assert all(row["status"] == "accepted" and row["jobs"] == 1 for row in rows)


def test_live_late_old_generation_hold_rearms_already_drained_checkpoint(live_lastfm_database):
    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    repository = PostgresLastfmRetryJobRepository(database_url=runtime_url, connect_to_database=isolatedPostgres._connect)
    captured = repository.load_session_credentials(account_id=scope[0], library_id=scope[1])
    assert captured is not None
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    _jobs, worker, _authorization = _lastfm_worker_components()
    assert worker.reconcile_due_pending(now=now, limit=100) == 0
    held = repository.accept_playback_failure(
        account_id=scope[0], library_id=scope[1], listen_id=f"late-held-{uuid4().hex}",
        entry={"artist": "Artist", "title": "Song", "track_ref": "opaque-track"},
        retry_count=1, error="expired", request_origin_ref=f"browser:{scope[3]}",
        deployment_mode="self_hosted_private_web", client_surface="private_web", now=now,
        reauthentication_required=True, active_session_id=captured.active_session_id,
        reauthentication_generation=captured.reauthentication_generation,
    )
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 1
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute("select status,current_job_id from integration.pending_scrobbles where id=%s", (held.pending_scrobble_id,)).fetchone()
    assert row["status"] == "accepted" and row["current_job_id"] is not None


def test_live_failed_provider_authentication_does_not_advance_checkpoint(live_lastfm_database, monkeypatch):
    from music_app.services import lastfm

    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    now = datetime.now(timezone.utc)
    held_ids = _seed_held_lastfm_backlog(setup_url, scope, now, 1, generation=1)

    def reject_authentication(*_args, **_kwargs):
        raise lastfm.LastfmError("Invalid credentials", code=4)

    monkeypatch.setattr(lastfm, "_post_lastfm", reject_authentication)
    with pytest.raises(lastfm.LastfmError, match="Invalid credentials"):
        lastfm.authenticate_lastfm(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, "invalid-user", "invalid-password",
            connected_at=now.isoformat(), account_id=scope[0],
            reauthentication_context={
                "library_id": scope[1], "request_origin_ref": f"browser:{scope[3]}",
                "deployment_mode": "self_hosted_private_web", "client_surface": "private_web", "request_ref": uuid4().hex, "expected_generation": 1,
            },
        )
    _jobs, worker, _authorization = _lastfm_worker_components()
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 0
    with isolatedPostgres._connect(setup_url) as connection:
        checkpoint = connection.execute("select generation from integration.lastfm_reauthentication_continuations where account_id=%s and library_id=%s", scope[:2]).fetchone()
        row = connection.execute("select status from integration.pending_scrobbles where id=%s", (next(iter(held_ids)),)).fetchone()
    assert checkpoint["generation"] == 1 and row["status"] == "reauthentication_required"


def test_live_unknown_reauthentication_commit_replays_same_request_without_advancing(live_lastfm_database):
    from contextlib import contextmanager

    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    request_ref = uuid4().hex
    with isolatedPostgres._connect(setup_url) as connection:
        username = connection.execute("select provider_username from integration.lastfm_sessions where id=%s", (scope[2],)).fetchone()["provider_username"]

    @contextmanager
    def lost_commit_acknowledgment(database_url):
        with isolatedPostgres._connect(database_url) as connection:
            yield connection
        raise RuntimeError("connection lost after commit")

    adapter = LastfmPostgresAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=lost_commit_acknowledgment)
    with pytest.raises(RuntimeError, match="connection lost after commit"):
        adapter.save_settings(
            {"username": username, "session_key": "reconnected-secret", "user_timezone": "UTC"}, account_id=scope[0],
            reauthentication_context={
                "library_id": scope[1], "request_origin_ref": f"browser:{scope[3]}",
                "deployment_mode": "self_hosted_private_web", "client_surface": "private_web", "request_ref": request_ref, "expected_generation": 0,
            },
        )
    _checkpoint_reauthentication(setup_url, runtime_url, scope, request_ref=request_ref, expected_generation=0)
    with isolatedPostgres._connect(setup_url) as connection:
        checkpoint = connection.execute("select generation,active_session_id from integration.lastfm_reauthentication_continuations where account_id=%s and library_id=%s", scope[:2]).fetchone()
        session = connection.execute("select session_key_encrypted from integration.lastfm_sessions where id=%s", (scope[2],)).fetchone()
    assert checkpoint["generation"] == 1 and int(checkpoint["active_session_id"]) == scope[2]
    assert session["session_key_encrypted"] == "reconnected-secret"


@pytest.mark.parametrize("fail_phase", ["after-promotion", "after-composition"])
def test_live_reauthentication_worker_rolls_back_interrupted_cycle_and_restart_recovers(live_lastfm_database, fail_phase):
    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    pending_ids = _seed_held_lastfm_backlog(setup_url, scope, now, 2)
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    trigger = f"reject_lastfm_cycle_{uuid4().hex}"
    table = "ops.jobs" if fail_phase == "after-promotion" else "integration.pending_scrobbles"
    event = "before insert" if fail_phase == "after-promotion" else "before update"
    condition = "" if fail_phase == "after-promotion" else "when (new.current_job_id is not null)"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(f"create function integration.{trigger}() returns trigger language plpgsql as $$ begin raise exception 'test interrupted drain cycle'; end $$")
        connection.execute(f"create trigger {trigger} {event} on {table} for each row {condition} execute function integration.{trigger}()")
    try:
        _jobs, worker, _authorization = _lastfm_worker_components()
        with pytest.raises(Exception, match="test interrupted drain cycle"):
            worker.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100)
        with isolatedPostgres._connect(setup_url) as connection:
            rows = connection.execute("select status,current_job_id from integration.pending_scrobbles where id=any(%s)", (list(pending_ids),)).fetchall()
            count = connection.execute("select count(*) as count from ops.jobs where kind='lastfm_scrobble_retry' and account_id=%s and library_id=%s", scope[:2]).fetchone()["count"]
        assert all(row["status"] == "reauthentication_required" and row["current_job_id"] is None for row in rows)
        assert count == 0
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(f"drop trigger {trigger} on {table}")
            connection.execute(f"drop function integration.{trigger}()")
    _jobs, restarted, _authorization = _lastfm_worker_components()
    assert restarted.reconcile_due_pending(now=now + timedelta(seconds=2), limit=100) == 2
    _jobs, restarted_again, _authorization = _lastfm_worker_components()
    assert restarted_again.reconcile_due_pending(now=now + timedelta(seconds=3), limit=100) == 0


def test_live_locked_eligible_hold_keeps_reauthentication_checkpoint_ready(live_lastfm_database):
    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    pending_ids = _seed_held_lastfm_backlog(setup_url, scope, now, 1)
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    _jobs, worker, _authorization = _lastfm_worker_components()
    with isolatedPostgres._connect(setup_url) as blocker:
        blocker.execute("select id from integration.pending_scrobbles where id=%s for update", (next(iter(pending_ids)),))
        assert worker.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 0
        with isolatedPostgres._connect(setup_url) as observer:
            signal = observer.execute("select drain_requested from integration.lastfm_reauthentication_continuations where account_id=%s and library_id=%s", scope[:2]).fetchone()
        assert signal["drain_requested"] is True
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=2), limit=100) == 1


def test_live_reauthentication_and_normal_due_work_share_one_composition_bound(live_lastfm_database):
    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    held_ids = _seed_held_lastfm_backlog(setup_url, scope, now, 150)
    due_ids = _seed_held_lastfm_backlog(setup_url, scope, now, 150)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update integration.pending_scrobbles set status='pending',next_attempt_at=%s where id=any(%s)", (now, list(due_ids)))
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    _jobs, worker, _authorization = _lastfm_worker_components()
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 100
    with isolatedPostgres._connect(setup_url) as connection:
        jobs = connection.execute("select count(*) as count from ops.jobs where kind='lastfm_scrobble_retry' and account_id=%s and library_id=%s", scope[:2]).fetchone()["count"]
        remaining_held = connection.execute("select count(*) as count from integration.pending_scrobbles where id=any(%s) and status='reauthentication_required'", (list(held_ids),)).fetchone()["count"]
    assert jobs == 100
    assert 50 <= remaining_held <= 150
    for cycle in range(4):
        assert 0 <= worker.reconcile_due_pending(now=now + timedelta(seconds=cycle + 2), limit=100) <= 100
    with isolatedPostgres._connect(setup_url) as connection:
        rows = connection.execute("select id,status,current_job_id from integration.pending_scrobbles where id=any(%s)", (list(held_ids | due_ids),)).fetchall()
    assert len(rows) == 300
    assert all(row["status"] == "accepted" and row["current_job_id"] is not None for row in rows)


@pytest.mark.parametrize("terminal_status", ["ambiguous", "permanent", "completed", "canceled", "exhausted", "attempts-exhausted"])
def test_live_reauthentication_never_revives_terminal_or_exhausted_pending(live_lastfm_database, terminal_status):
    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    pending_id = next(iter(_seed_held_lastfm_backlog(setup_url, scope, now, 1)))
    with isolatedPostgres._connect(setup_url) as connection:
        if terminal_status == "attempts-exhausted":
            connection.execute("update integration.pending_scrobbles set attempt_count=5 where id=%s", (pending_id,))
        else:
            connection.execute("update integration.pending_scrobbles set status=%s where id=%s", (terminal_status, pending_id))
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    _jobs, worker, _authorization = _lastfm_worker_components()
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 0
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute("select status,current_job_id from integration.pending_scrobbles where id=%s", (pending_id,)).fetchone()
    assert row["status"] == ("reauthentication_required" if terminal_status == "attempts-exhausted" else terminal_status)
    assert row["current_job_id"] is None


def test_live_reauthentication_1000_hold_candidate_lookup_is_index_bounded(live_lastfm_database):
    setup_url, _runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    _seed_held_lastfm_backlog(setup_url, scope, datetime.now(timezone.utc), 1000)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("analyze integration.pending_scrobbles")
        result = connection.execute(
            "explain (analyze,format json) select id from integration.pending_scrobbles "
            "where account_id=%s and library_id=%s and status='reauthentication_required' "
            "and reauthentication_generation<1 and attempt_count<5 order by reauthentication_generation,id limit 100", scope[:2],
        ).fetchone()
        indexes = connection.execute(
            "select indexname,indexdef from pg_indexes where schemaname='integration' "
            "and indexname in ('lastfm_reauthentication_ready_idx','pending_scrobbles_reauthentication_generation_idx')"
        ).fetchall()
    plan = next(iter(result.values()))[0]["Plan"]
    nodes, pending = [], [plan]
    while pending:
        node = pending.pop()
        nodes.append(node)
        pending.extend(node.get("Plans", []))
    indexed = [node for node in nodes if node.get("Index Name") == "pending_scrobbles_reauthentication_generation_idx"]
    assert len(indexed) == 1
    assert plan["Actual Rows"] == 100
    assert indexed[0]["Actual Rows"] <= 100
    assert indexed[0].get("Rows Removed by Filter", 0) == 0
    assert {row["indexname"] for row in indexes} == {"lastfm_reauthentication_ready_idx", "pending_scrobbles_reauthentication_generation_idx"}


@pytest.mark.parametrize("revoked", ["capability", "membership", "account", "session"])
def test_live_reauthentication_drain_reauthorizes_before_provider_send(live_lastfm_database, revoked):
    from music_app.jobs.lastfm_handlers import build_lastfm_retry_handler
    from music_app.jobs.worker import ExecutionContext

    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    _seed_held_lastfm_backlog(setup_url, scope, now, 1)
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    jobs, retries, authorization = _lastfm_worker_components()
    assert retries.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 1
    claim = jobs.claim(worker_id="reauth-revoked", now=now + timedelta(seconds=2), lease_seconds=60, kinds=("lastfm_scrobble_retry",))
    assert claim is not None
    with isolatedPostgres._connect(setup_url) as connection:
        if revoked == "capability":
            connection.execute("delete from app.capabilities where account_id=%s and capability_key='integration.lastfm.scrobble'", (scope[0],))
        elif revoked == "membership":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", scope[:2])
        elif revoked == "account":
            connection.execute("update app.accounts set is_active=false where id=%s", (scope[0],))
        else:
            connection.execute("update integration.lastfm_sessions set is_active=false where id=%s", (scope[2],))
    observed_at = now + timedelta(seconds=3)
    provider_calls = []
    outcome = build_lastfm_retry_handler(
        retry_repository=retries, config={}, scrobble_with_session=lambda *_args: provider_calls.append(True),
        clock=lambda: observed_at,
    )(claim, ExecutionContext(claim, authorization_service=authorization, clock=lambda: observed_at))
    assert provider_calls == []
    assert outcome.next_state is JobState.CANCELED


@pytest.mark.parametrize("missing_signature", [
    None,
    "ops.prepare_claimed_problematic_projection(bigint,integer,text,text,timestamptz)",
    "ops.load_claimed_cover_finalization(bigint,integer,text,text,timestamptz)",
], ids=["current-worker", "problematic-typed-check", "cover-typed-check"])
def test_live_lastfm_continuation_preserves_current_worker_startup_contract(live_lastfm_database, missing_signature):
    from config import build_worker_config
    from scripts.run_jobs_worker import _build_worker

    setup_url, _runtime_url = live_lastfm_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    worker = _build_worker(build_worker_config({"ALBUM_HAVEN_WORKER_DATABASE_URL": worker_url}), mail_config={})
    try:
        registered = worker._handlers.registered_kinds
        assert "problematic_files_projection" in registered
        worker._worker_instances.validate_startup(registered_kinds=registered)
    finally:
        worker.close()
    if missing_signature is not None:
        with isolatedPostgres._connect(setup_url) as connection:
            assert connection.execute(
                "select ops.validate_durable_worker_startup(%s::text[]) as ready", (list(registered),),
            ).fetchone()["ready"] is True
            # Transactional DDL faults the real typed dependency; rollback restores it.
            with connection.transaction(force_rollback=True):
                connection.execute(f"alter function {missing_signature} rename to missing_lastfm_startup_{uuid4().hex}")
                assert connection.execute(
                    "select ops.validate_durable_worker_startup(%s::text[]) as ready", (list(registered),),
                ).fetchone()["ready"] is False


def test_live_replayed_lost_ack_reconnect_cannot_overwrite_later_credentials(live_lastfm_database):
    from contextlib import contextmanager

    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    request_a, request_b = uuid4().hex, uuid4().hex
    with isolatedPostgres._connect(setup_url) as connection:
        username = connection.execute("select provider_username from integration.lastfm_sessions where id=%s", (scope[2],)).fetchone()["provider_username"]

    @contextmanager
    def lose_ack(database_url):
        with isolatedPostgres._connect(database_url) as connection:
            yield connection
        raise RuntimeError("reconnect A committed but acknowledgment was lost")

    adapter = LastfmPostgresAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=lose_ack)
    with pytest.raises(RuntimeError, match="acknowledgment was lost"):
        adapter.save_settings(
            {"username": username, "session_key": "credential-A", "user_timezone": "UTC"}, account_id=scope[0],
            reauthentication_context={
                "library_id": scope[1], "request_origin_ref": f"browser:{scope[3]}",
                "deployment_mode": "self_hosted_private_web", "client_surface": "private_web", "request_ref": request_a, "expected_generation": 0,
            },
        )
    _checkpoint_reauthentication(setup_url, runtime_url, scope, request_ref=request_b, secret="credential-B")

    def persisted_state():
        with isolatedPostgres._connect(setup_url) as connection:
            return connection.execute(
                "select continuation.*,session.session_key_encrypted,session.is_active "
                "from integration.lastfm_reauthentication_continuations continuation "
                "join integration.lastfm_sessions session on session.id=continuation.active_session_id "
                "where continuation.account_id=%s and continuation.library_id=%s", scope[:2],
            ).fetchone()

    before_replay = persisted_state()
    assert before_replay["generation"] == 2
    assert before_replay["session_key_encrypted"] == "credential-B"
    try:
        _checkpoint_reauthentication(setup_url, runtime_url, scope, request_ref=request_a, secret="credential-A", expected_generation=0)
    except ValueError as error:
        import re
        assert re.search(r"stale|superseded|conflict", str(error), re.I), "only a deliberate readable stale/conflict rejection is safe"
    assert persisted_state() == before_replay, "an older committed reconnect replay must not overwrite a newer reconnect or rearm its signal"


def test_live_exhausted_hold_prefix_cannot_expand_actual_drain_query_work(live_lastfm_database):
    import re

    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    exhausted_ids = _seed_held_lastfm_backlog(setup_url, scope, now, 5000)
    _seed_held_lastfm_backlog(setup_url, scope, now, 3)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update integration.pending_scrobbles set attempt_count=5 where id=any(%s)", (list(exhausted_ids),))
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    with isolatedPostgres._connect(setup_url) as connection:
        definition = connection.execute(
            "select pg_get_functiondef('ops.reconcile_due_lastfm_jobs(timestamptz,integer)'::regprocedure) as definition"
        ).fetchone()["definition"]
        ready = connection.execute(
            "select * from integration.lastfm_reauthentication_continuations where account_id=%s and library_id=%s", scope[:2],
        ).fetchone()
        promotion = re.search(r"with candidates as\s*\((.*?)\)\s*update integration\.pending_scrobbles", definition, re.S | re.I)
        readiness = re.search(r"set drain_requested\s*=\s*exists\s*\((.*?)\),\s*updated_at", definition, re.S | re.I)
        assert promotion is not None and readiness is not None, "measure the actual privileged promotion and readiness statements"
        connection.execute("analyze integration.pending_scrobbles")
        observed_plans = {}
        for label, query in (("promotion", promotion.group(1)), ("readiness", "select exists(" + readiness.group(1) + ")")):
            query = re.sub(r"ready_scope\.([a-z_]+)", lambda match: "%({})s".format(match.group(1)), query)
            query = re.sub(r"\bp_limit\b", "%(limit)s", query)
            result = connection.execute("explain (analyze,format json) " + query, {**ready, "limit": 100}).fetchone()
            observed_plans[label] = next(iter(result.values()))[0]["Plan"]
    for label, plan in observed_plans.items():
        nodes, pending = [], [plan]
        while pending:
            node = pending.pop()
            nodes.append(node)
            pending.extend(node.get("Plans", []))
        scans = [node for node in nodes if node.get("Relation Name") == "pending_scrobbles"]
        scanned_rows = sum(
            (node["Actual Rows"] + node.get("Rows Removed by Filter", 0) + node.get("Rows Removed by Index Recheck", 0)) * node["Actual Loops"]
            for node in scans
        )
        assert scans
        assert scanned_rows <= 100, f"{label} scanned/filtered {scanned_rows} rows for only three eligible holds behind 5,000 exhausted holds"


@pytest.mark.parametrize("reconnect_during_send", [True, False], ids=["old-credentials", "current-credentials"])
def test_live_measured_playback_auth_failure_preserves_route_credential_snapshot(live_lastfm_database, tmp_path, monkeypatch, reconnect_during_send):
    from functools import partial
    import hashlib
    import logging
    from types import SimpleNamespace

    from starlette.requests import Request
    from music_app.routes.api_wave_b_asgi_routes import _measured_lastfm_credentials, _log_lastfm_scrobble_event
    from music_app.services.lastfm import LastfmError, LastfmSubmissionOutcome
    from music_app.services import lastfm_retry
    from music_app.jobs.lastfm_handlers import build_lastfm_retry_handler
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.measured_listen_history import load_measured
    from music_app.services.lastfm_sync_bridge import record_playback_session_complete
    from music_app.services.listen_history import append_listen_history_entry, update_listen_history_entry, is_meaningful_listen_session
    from music_app.services.log_history import HistoryScope
    from music_app.services.playback_session_payloads import normalize_playback_track_payload
    from tests.py.test_settings_measured_listen_ledger import measured

    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
    media_path = (tmp_path / "measured-lastfm-track.flac").resolve()
    media_path.write_bytes(b"track-identity-fixture")
    with isolatedPostgres._connect(setup_url) as connection:
        track = connection.execute(
            "insert into library.local_tracks(library_id,track_key,title,duration_seconds) "
            "values(%s,%s,'Song',240) returning id,track_key", (scope[1], f"measured-lastfm-{uuid4().hex}"),
        ).fetchone()
        connection.execute(
            "insert into library.local_track_files(track_id,private_path) values(%s,%s)", (track["id"], str(media_path)),
        )
    repository = PostgresLastfmRetryJobRepository(database_url=runtime_url, connect_to_database=isolatedPostgres._connect)
    request = Request({"type": "http", "app": SimpleNamespace(state=SimpleNamespace(lastfm_retry_job_repository=repository))})
    if not reconnect_during_send:
        _checkpoint_reauthentication(setup_url, runtime_url, scope)
    credentials, session = _measured_lastfm_credentials(request, scope[0], scope[1])
    assert credentials is not None and session is not None
    now = datetime.now(timezone.utc)
    payload = {
        **measured({"path": str(media_path), "track_id": track["id"]}),
        "path": str(media_path), "track_ref": track["track_key"], "library_track_id": str(track["id"]),
        "title": "Song", "artist": "Artist", "album": "Album",
        "started_at": (now - timedelta(minutes=5)).isoformat(), "ended_at": (now - timedelta(minutes=1)).isoformat(),
        "started_at_unix": int(now.timestamp()) - 300, "duration_seconds": 240,
        "total_listened_seconds": 180, "max_contiguous_seconds": 180,
        "finished_fully": False, "skipped": True, "completion_reason": "track-change",
        "measurement_version": "rendered-pcm-v1", "device_id": str(uuid4()), "session_id": str(uuid4()),
        "sequence": 1, "finalized": True, "measured_listened_seconds": 180, "max_measured_contiguous_seconds": 180,
    }
    secrets = []

    def provider(_config, _payload, *, session):
        secrets.append(session.session_key)
        if reconnect_during_send:
            _checkpoint_reauthentication(setup_url, runtime_url, scope)
        raise LastfmError("session expired", code=9, reauthentication_required=True, request_sent=False)

    def record_retryable(_config, **values):
        return repository.accept_playback_failure(
            **values, account_id=scope[0], library_id=scope[1], request_origin_ref=f"browser:{scope[3]}",
            deployment_mode="self_hosted_private_web", client_surface="private_web", now=datetime.now(timezone.utc),
        )

    response, status = record_playback_session_complete(
        config, payload, user_timezone="UTC", account_id=scope[0], library_id=scope[1],
        lastfm_credentials=credentials, lastfm_session=session,
        normalize_playback_track_payload=normalize_playback_track_payload,
        is_meaningful_listen_session=is_meaningful_listen_session,
        append_listen_history_entry=append_listen_history_entry, update_listen_history_entry=update_listen_history_entry,
        scrobble_track=provider,
        log_lastfm_scrobble_event=partial(
            _log_lastfm_scrobble_event, config, logging.getLogger(__name__),
            history_scope=HistoryScope(account_id=scope[0], library_id=scope[1], origin_kind="request"),
        ),
        record_retryable_scrobble=record_retryable,
    )
    assert status == 200 and response["scrobble_attempted"] and not response["scrobbled"]
    assert secrets == ["encrypted-test-secret" if reconnect_during_send else "reconnected-secret"]
    assert response["entry"]["scrobble_durable_job_owned"] is True
    identity = f"{scope[0]}:{scope[1]}:{payload['device_id']}:{payload['session_id']}"
    assert response["entry"]["id"] == hashlib.sha256(identity.encode()).hexdigest()
    jobs, worker, authorization = _lastfm_worker_components()
    assert worker.reconcile_due_pending(now=datetime.now(timezone.utc), limit=100) == int(reconnect_during_send)
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select id,status,reauthentication_generation from integration.pending_scrobbles "
            "where account_id=%s and library_id=%s "
            "and payload->>'source_family'='rendered_local_listen_session' and payload->>'source_key'=%s",
            (*scope[:2], identity),
        ).fetchone()
        history = connection.execute(
            "select track_id,source_family,source_entry_id,metadata from integration.listen_history "
            "where account_id=%s and library_id=%s and device_id=%s and session_id=%s",
            (*scope[:2], payload["device_id"], payload["session_id"]),
        ).fetchone()
        reloaded = load_measured(connection, account_id=scope[0], library_id=scope[1], device_id=payload["device_id"], session_id=payload["session_id"])
    assert pending is not None
    assert history is not None and int(history["track_id"]) == int(track["id"])
    assert history["metadata"]["source_payload"]["id"] == response["entry"]["id"]
    assert history["source_family"] == "rendered_local_listen_session"
    assert history["source_entry_id"] == identity
    assert reloaded.get("scrobble_durable_job_owned") is True, "durable admission must persist ownership in the measured source payload"
    assert history["metadata"]["source_payload"].get("scrobble_durable_job_owned") is True
    assert pending["reauthentication_generation"] == credentials.reauthentication_generation
    assert pending["status"] == ("accepted" if reconnect_during_send else "reauthentication_required")
    legacy_calls = []

    def forbidden_legacy_send(*_args, **_kwargs):
        legacy_calls.append(True)
        pytest.fail("legacy worker attempted a durably owned measured listen")

    with monkeypatch.context() as patch:
        patch.setattr(lastfm_retry, "scrobble_tracks", forbidden_legacy_send)
        legacy = lastfm_retry.retry_pending_lastfm_scrobbles(
            {**config, "LASTFM_API_ENABLED": True}, reauthenticated=True,
            account_id=scope[0], library_ids=frozenset({scope[1]}),
        )
    assert legacy_calls == []
    assert legacy.summary["pending_before"] == legacy.summary["attempted"] == 0
    if not reconnect_during_send:
        _checkpoint_reauthentication(setup_url, runtime_url, scope)
        assert worker.reconcile_due_pending(now=datetime.now(timezone.utc), limit=100) == 1
    retry_calls = []

    def accept_retry(_config, provider_payload, secret):
        assert secret == "reconnected-secret"
        retry_calls.append(dict(provider_payload))
        return LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted")

    claim = jobs.claim(worker_id="measured-auth-retry", now=datetime.now(timezone.utc), lease_seconds=60, kinds=("lastfm_scrobble_retry",))
    assert claim is not None and int(claim.subject_ref) == int(pending["id"])
    outcome = build_lastfm_retry_handler(
        retry_repository=worker, config=config, scrobble_with_session=accept_retry,
        clock=lambda: datetime.now(timezone.utc),
    )(claim, ExecutionContext(claim, authorization_service=authorization, clock=lambda: datetime.now(timezone.utc)))
    assert outcome.next_state is JobState.SUCCEEDED and outcome.reason_code == "lastfm_scrobble_accepted"
    assert jobs.finish(claim, outcome, now=datetime.now(timezone.utc))
    assert len(retry_calls) == 1
    assert jobs.claim(worker_id="measured-auth-retry", now=datetime.now(timezone.utc), lease_seconds=60, kinds=("lastfm_scrobble_retry",)) is None
    with isolatedPostgres._connect(setup_url) as connection:
        completed = load_measured(connection, account_id=scope[0], library_id=scope[1], device_id=payload["device_id"], session_id=payload["session_id"])
        count = connection.execute("select count(*) as count from ops.jobs where kind='lastfm_scrobble_retry' and subject_ref=%s", (str(pending["id"]),)).fetchone()["count"]
    assert completed["id"] == response["entry"]["id"]
    assert completed["scrobbled"] is True and completed["scrobble_durable_job_owned"] is True
    assert count == 1


def _assert_lastfm_finalizer_drainer_order(live_lastfm_database, *, drainer_first):
    import psycopg
    import time

    setup_url, runtime_url = live_lastfm_database
    scope = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    repository = PostgresLastfmRetryJobRepository(database_url=runtime_url, connect_to_database=isolatedPostgres._connect)
    accepted = repository.accept_retryable_pending(
        account_id=scope[0], library_id=scope[1], source_family="runtime_lastfm_sync_state_adapter",
        source_key=f"finalizer-race-{uuid4().hex}", track_key="opaque-track", played_at=now,
        previous_attempts=1, next_attempt_at=now, active_session_id=scope[2],
        request_origin_ref=f"browser:{scope[3]}", deployment_mode="self_hosted_private_web", client_surface="private_web",
        payload={"source_payload": {"artist": "Artist", "title": "Song"}},
    )
    jobs, worker, _authorization = _lastfm_worker_components()
    claim = jobs.claim(worker_id="ordered-finalizer", now=now, lease_seconds=60, kinds=("lastfm_scrobble_retry",))
    assert claim is not None and claim.job_id == accepted.job_id
    claim_values = dict(
        pending_scrobble_id=accepted.pending_scrobble_id, active_session_id=scope[2], job_id=claim.job_id,
        attempt=claim.attempt, worker_id=claim.worker_id, lease_token=claim.lease_token, now=now + timedelta(seconds=1),
    )
    credentials = worker.load_claimed_session_credentials(**claim_values)
    sending = worker.begin_claimed_attempt(**claim_values)
    assert credentials is not None
    _checkpoint_reauthentication(setup_url, runtime_url, scope)
    suffix = uuid4().hex
    finalizer_name, drainer_name = f"lastfm-finalizer-{suffix}", f"lastfm-drainer-{suffix}"
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")

    def named_repository(name):
        def connect(database_url):
            connection = isolatedPostgres._connect(database_url)
            connection.execute("select set_config('application_name',%s,false)", (name,))
            return connection
        return PostgresLastfmRetryJobRepository(database_url=worker_url, connect_to_database=connect)

    def wait_for_database_lock(name):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with isolatedPostgres._connect(setup_url) as observer:
                waiting = observer.execute(
                    "select exists(select 1 from pg_locks locks where locks.pid=activity.pid and not locks.granted) as waiting,"
                    "pg_blocking_pids(activity.pid) as blockers from pg_stat_activity activity where application_name=%s", (name,),
                ).fetchone()
            if waiting and waiting["waiting"] and waiting["blockers"]:
                return
            time.sleep(0.01)
        pytest.fail(f"{name} never reached the deliberately held continuation-row lock")

    with ThreadPoolExecutor(max_workers=2) as executor:
        with isolatedPostgres._connect(setup_url) as blocker:
            blocker.execute(
                "select account_id from integration.lastfm_reauthentication_continuations where account_id=%s and library_id=%s for update", scope[:2],
            )
            def start_finalizer():
                return executor.submit(
                    named_repository(finalizer_name).finalize_claimed_attempt, **claim_values,
                    expected_row_revision=sending.row_revision, disposition="reauthentication_required",
                    reason_code="provider_error", history_updates={},
                    reauthentication_generation=credentials.reauthentication_generation,
                )

            if drainer_first:
                drain = executor.submit(named_repository(drainer_name).reconcile_due_pending,
                                        now=now + timedelta(seconds=2), limit=100)
                wait_for_database_lock(drainer_name)
                finalization = start_finalizer()
                wait_for_database_lock(finalizer_name)
                for table, row_id in (("ops.jobs", claim.job_id),
                                      ("integration.pending_scrobbles", accepted.pending_scrobble_id)):
                    with isolatedPostgres._connect(setup_url) as observer:
                        with pytest.raises(psycopg.errors.LockNotAvailable):
                            with observer.transaction():
                                observer.execute(f"select id from {table} where id=%s for update nowait", (row_id,))
            else:
                finalization = start_finalizer()
                wait_for_database_lock(finalizer_name)
                drain = executor.submit(named_repository(drainer_name).reconcile_due_pending,
                                        now=now + timedelta(seconds=2), limit=100)
                wait_for_database_lock(drainer_name)
        assert finalization.result(timeout=10).domain_status == "reauthentication_required"
        assert drain.result(timeout=10) == 0
    with isolatedPostgres._connect(setup_url) as connection:
        signal = connection.execute("select drain_requested from integration.lastfm_reauthentication_continuations where account_id=%s and library_id=%s", scope[:2]).fetchone()
    assert signal["drain_requested"] is True
    assert jobs.finish(claim, JobTransitionResult(JobState.SUCCEEDED, "lastfm_reauthentication_required"), now=now + timedelta(seconds=3))
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=4), limit=100) == 1
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=5), limit=100) == 0
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select status,current_job_id from integration.pending_scrobbles where id=%s",
            (accepted.pending_scrobble_id,),
        ).fetchone()
        job_count = connection.execute(
            "select count(*) as count from ops.jobs where kind='lastfm_scrobble_retry' and subject_ref=%s",
            (str(accepted.pending_scrobble_id),),
        ).fetchone()["count"]
    assert pending["status"] == "accepted"
    assert pending["current_job_id"] is not None and pending["current_job_id"] != claim.job_id
    assert int(job_count) == 2


def test_live_finalizer_waiting_before_drainer_cannot_lose_ready_signal(live_lastfm_database):
    _assert_lastfm_finalizer_drainer_order(live_lastfm_database, drainer_first=False)


def test_live_drainer_waiting_before_finalizer_rearms_late_hold(live_lastfm_database):
    _assert_lastfm_finalizer_drainer_order(live_lastfm_database, drainer_first=True)


def test_live_reauthentication_scopes_rotate_without_starving_small_backlog(live_lastfm_database):
    setup_url, runtime_url = live_lastfm_database
    large, small = _seed_scope(setup_url), _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    _seed_held_lastfm_backlog(setup_url, large, now, 1000)
    small_id = next(iter(_seed_held_lastfm_backlog(setup_url, small, now, 1)))
    _checkpoint_reauthentication(setup_url, runtime_url, large)
    _checkpoint_reauthentication(setup_url, runtime_url, small)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update integration.lastfm_reauthentication_continuations set updated_at=%s where account_id=%s and library_id=%s", (now - timedelta(seconds=2), *large[:2]),
        )
        connection.execute(
            "update integration.lastfm_reauthentication_continuations set updated_at=%s where account_id=%s and library_id=%s", (now - timedelta(seconds=1), *small[:2]),
        )
    _jobs, worker, _authorization = _lastfm_worker_components()
    assert worker.reconcile_due_pending(now=now, limit=100) == 100
    assert worker.reconcile_due_pending(now=now + timedelta(seconds=1), limit=100) == 1
    with isolatedPostgres._connect(setup_url) as connection:
        small_row = connection.execute("select status,current_job_id from integration.pending_scrobbles where id=%s", (small_id,)).fetchone()
        large_held = connection.execute("select count(*) as count from integration.pending_scrobbles where account_id=%s and library_id=%s and status='reauthentication_required'", large[:2]).fetchone()["count"]
    assert small_row["status"] == "accepted" and small_row["current_job_id"] is not None
    assert large_held == 900


def test_live_reauthentication_failure_creates_a_hold_without_a_generic_job(
    live_lastfm_database,
):
    setup_url, _runtime_url = live_lastfm_database
    account_id, library_id, _session_id, origin_key = _seed_scope(setup_url)
    repository = PostgresLastfmRetryJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
    )
    held = repository.accept_playback_failure(
        account_id=account_id,
        library_id=library_id,
        listen_id=f"held-{uuid4().hex}",
        entry={"artist": "Artist", "title": "Song", "track_ref": "opaque"},
        retry_count=1,
        error="session expired",
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        now=datetime.now(timezone.utc),
        reauthentication_required=True,
    )

    assert held.job_id is None
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select status, current_job_id, accepted_attempt "
            "from integration.pending_scrobbles where id = %s",
            (held.pending_scrobble_id,),
        ).fetchone()
    assert pending["status"] == "reauthentication_required"
    assert pending["current_job_id"] is None
    assert pending["accepted_attempt"] is None


def test_live_reauthentication_releases_only_scoped_held_rows_to_new_session(
    live_lastfm_database,
):
    setup_url, _runtime_url = live_lastfm_database
    account_id, library_id, old_session_id, origin_key = _seed_scope(setup_url)
    repository = PostgresLastfmRetryJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
    )
    now = datetime.now(timezone.utc)
    accepted = repository.accept_retryable_pending(
        account_id=account_id,
        library_id=library_id,
        source_family="runtime_lastfm_sync_state_adapter",
        source_key=f"reauth-{uuid4().hex}",
        track_key="opaque-track",
        played_at=now - timedelta(minutes=5),
        previous_attempts=2,
        next_attempt_at=now,
        active_session_id=old_session_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        payload={"source_payload": {"artist": "Artist", "title": "Song"}},
    )
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update integration.pending_scrobbles "
            "set status = 'reauthentication_required', attempt_count = 3 "
            "where id = %s",
            (accepted.pending_scrobble_id,),
        )
        connection.execute(
            "update integration.lastfm_sessions set is_active = false where id = %s",
            (old_session_id,),
        )
        new_session_id = int(
            connection.execute(
                "insert into integration.lastfm_sessions "
                "(account_id, provider_username, session_key_encrypted, is_active) "
                "values (%s, 'new-session', 'new-secret', true) returning id",
                (account_id,),
            ).fetchone()["id"]
        )

    released = repository.release_after_reauthentication(
        account_id=account_id,
        library_id=library_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        now=now + timedelta(seconds=1),
    )

    assert len(released) == 1
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select active_session_id, accepted_attempt, current_job_id "
            "from integration.pending_scrobbles where id = %s",
            (accepted.pending_scrobble_id,),
        ).fetchone()
        job = connection.execute(
            "select parameters from ops.jobs where id = %s",
            (released[0].job_id,),
        ).fetchone()
    assert int(pending["active_session_id"]) == new_session_id
    assert int(pending["accepted_attempt"]) == 4
    assert int(pending["current_job_id"]) == released[0].job_id
    assert job["parameters"] == {"active_session_ref": str(new_session_id)}


def test_live_worker_reconciliation_adopts_legacy_due_once_across_workers(
    live_lastfm_database,
):
    setup_url, _runtime_url = live_lastfm_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    account_id, library_id, session_id, _origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    with isolatedPostgres._connect(setup_url) as connection:
        pending_id = int(
            connection.execute(
                "insert into integration.pending_scrobbles "
                "(account_id, library_id, track_key, played_at, attempt_count, "
                "next_attempt_at, status, payload) values "
                "(%s, %s, 'legacy-opaque', %s, 1, %s, 'pending', "
                "jsonb_build_object('source_family', 'phase_6_json_file_backfill', "
                "'source_key', %s::text, 'source_payload', jsonb_build_object("
                "'artist', 'Artist', 'title', 'Song', 'started_at_unix', 12345))) "
                "returning id",
                (
                    account_id,
                    library_id,
                    now - timedelta(minutes=5),
                    now,
                    f"legacy-{uuid4().hex}",
                ),
            ).fetchone()["id"]
        )
    repositories = [
        PostgresLastfmRetryJobRepository(
            database_url=worker_url,
            connect_to_database=isolatedPostgres._connect,
        )
        for _ in range(2)
    ]
    with ThreadPoolExecutor(max_workers=2) as executor:
        counts = list(
            executor.map(
                lambda repository: repository.reconcile_due_pending(now=now, limit=100),
                repositories,
            )
        )

    assert sum(counts) == 1
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select current_job_id, active_session_id, accepted_attempt "
            "from integration.pending_scrobbles where id = %s",
            (pending_id,),
        ).fetchone()
    assert pending["current_job_id"] is not None
    assert int(pending["active_session_id"]) == session_id
    assert int(pending["accepted_attempt"]) == 2


@pytest.mark.parametrize("previous_attempts", (1, 4))
def test_live_failed_presend_reconciliation_advances_or_exhausts_attempt(
    live_lastfm_database, previous_attempts,
):
    setup_url, runtime_url = live_lastfm_database
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "delete from app.request_origins where account_id = %s", (account_id,),
        )
    now = datetime.now(timezone.utc)
    accepted = PostgresLastfmRetryJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
    ).accept_retryable_pending(
        account_id=account_id, library_id=library_id,
        source_family="runtime_lastfm_sync_state_adapter",
        source_key=f"presend-{uuid4().hex}", track_key="opaque", played_at=now,
        previous_attempts=previous_attempts, next_attempt_at=now,
        active_session_id=session_id, request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web", client_surface="private_web",
        payload={"source_payload": {"artist": "Artist", "title": "Song"}},
    )
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.jobs set state = 'failed', started_at = %s, "
            "completed_at = %s, outcome_code = 'presend_failure', attempt_count = 1 "
            "where id = %s", (now, now, accepted.job_id),
        )
    repository = PostgresLastfmRetryJobRepository(
        database_url=os.environ["ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL"],
        connect_to_database=isolatedPostgres._connect,
    )
    repository.reconcile_due_pending(now=now + timedelta(seconds=1))
    repository.reconcile_due_pending(now=now + timedelta(seconds=2))
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select pending.status, pending.attempt_count, pending.accepted_attempt, "
            "pending.current_job_id, job.state from integration.pending_scrobbles pending "
            "join ops.jobs job on job.id = pending.current_job_id where pending.id = %s",
            (accepted.pending_scrobble_id,),
        ).fetchone()
    assert pending["attempt_count"] == previous_attempts + 1
    if previous_attempts == 4:
        assert pending["status"] == "exhausted"
        assert pending["current_job_id"] == accepted.job_id
    else:
        assert pending["status"] == "accepted"
        assert pending["accepted_attempt"] == previous_attempts + 2
        assert pending["current_job_id"] != accepted.job_id
        assert pending["state"] == "queued"


def test_live_worker_reconciliation_converges_ambiguous_generic_terminal_state(
    live_lastfm_database,
):
    setup_url, _runtime_url = live_lastfm_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    account_id, library_id, session_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    accepted = PostgresLastfmRetryJobRepository(
        database_url=setup_url,
        connect_to_database=isolatedPostgres._connect,
    ).accept_retryable_pending(
        account_id=account_id,
        library_id=library_id,
        source_family="runtime_lastfm_sync_state_adapter",
        source_key=f"terminal-{uuid4().hex}",
        track_key="opaque",
        played_at=now,
        previous_attempts=1,
        next_attempt_at=now,
        active_session_id=session_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        payload={"source_payload": {"artist": "Artist", "title": "Song"}},
    )
    jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="lastfm-terminal-live",
        now=now + timedelta(seconds=1),
        lease_seconds=60,
        kinds=("lastfm_scrobble_retry",),
    )
    assert claim is not None and claim.job_id == accepted.job_id
    assert jobs.finish(
        claim,
        JobTransitionResult(JobState.AMBIGUOUS, "stale_lease_ambiguous"),
        now=now + timedelta(seconds=2),
    )
    repository = PostgresLastfmRetryJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )

    assert repository.reconcile_due_pending(now=now + timedelta(seconds=3)) == 0
    with isolatedPostgres._connect(setup_url) as connection:
        pending = connection.execute(
            "select status, attempt_count, last_provider_disposition "
            "from integration.pending_scrobbles where id = %s",
            (accepted.pending_scrobble_id,),
        ).fetchone()
        job_state = connection.execute(
            "select state from ops.jobs where id = %s", (accepted.job_id,)
        ).fetchone()["state"]
    assert pending["status"] == "ambiguous", (pending, job_state)
    assert int(pending["attempt_count"]) == 2
    assert pending["last_provider_disposition"] == "possible_send_ambiguous"
