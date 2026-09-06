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
