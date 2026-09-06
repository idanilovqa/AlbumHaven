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
def live_lastfm_database():
    setup_url, runtime_url = _database_urls_or_skip()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        yield setup_url, runtime_url
    finally:
        _drop_schemas(setup_url)


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
    values = dict(
        account_id=account_id,
        library_id=library_id,
        listen_id=f"playback-{uuid4().hex}",
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
    assert job_count == 1
    assert int(pending["active_session_id"]) == session_id


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
    while claim is not None and claim.job_id != accepted.job_id:
        assert jobs.finish(
            claim,
            JobTransitionResult(JobState.CANCELED, "test_scope_cleanup"),
            now=now + timedelta(seconds=2),
        )
        claim = jobs.claim(
            worker_id="lastfm-terminal-live",
            now=now + timedelta(seconds=3),
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
