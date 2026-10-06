"""Ownership contracts against the dedicated isolated Postgres database only."""
from __future__ import annotations

import importlib
import importlib.util
import json
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from threading import Barrier
from uuid import uuid4

import pytest

from music_app.services.cover_lookup_tasks_postgres import CoverLookupTasksPostgresAdapter
from tests.e2e.support import isolatedPostgres


MODULE = "music_app.services.library_operation_postgres"
FAMILY = "library_writer_ownership_v1"
TASK_KEY = "library-writer"
OWNER = {"host": "fixture-host", "pid": 12345, "process_started_at": "2026-10-06T12:00:00Z", "instance_id": "fixture-instance"}


def repository(config, *, connect=isolatedPostgres._connect):
    assert importlib.util.find_spec(MODULE) is not None, "durable library ownership repository is not implemented"
    return importlib.import_module(MODULE).PostgresLibraryOperationRepository(config, connect=connect)


@pytest.fixture(scope="module")
def database_urls():
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or not os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    # The verifier prepares the dedicated migrated database before this file.
    # Never drop schemas or reset unrelated test/application tables here.
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
    isolatedPostgres.assert_runtime_connection(runtime_url)
    isolatedPostgres.assert_runtime_grants(runtime_url)
    return setup_url, runtime_url


@pytest.fixture
def ownership(database_urls):
    setup_url, runtime_url = database_urls
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute("""
            select libraries.id from library.libraries libraries
            join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
            where owners.owner_key = 'local-bootstrap-owner'
              and libraries.name = 'Local Library' and libraries.library_kind = 'local'
        """).fetchone()
        assert row is not None, "prepare the isolated migrated bootstrap library before running ownership tests"
        library_id = row["id"]
        existing = connection.execute("""
            select id from ops.cover_lookup_tasks
            where library_id = %s and metadata->>'source_family' = %s and task_key = %s
        """, (library_id, FAMILY, TASK_KEY)).fetchone()
        assert existing is None, "isolated ownership singleton is occupied; do not erase another run's evidence"
    tokens = [str(uuid4()), str(uuid4())]
    try:
        yield config, tokens, library_id
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("""
                delete from ops.cover_lookup_tasks
                where library_id = %s and metadata->>'source_family' = %s
                  and task_key = %s and metadata->>'owner_token' = any(%s)
            """, (library_id, FAMILY, TASK_KEY, tokens))


def claim(repo, token):
    return repo.claim(owner_token=token, owner_identity=dict(OWNER), operation="cover-refresh")


def test_concurrent_instances_admit_exactly_one_writer(ownership):
    config, tokens, _ = ownership
    start = Barrier(2, timeout=10)

    def attempt(token):
        repo = repository(config)
        start.wait()
        return claim(repo, token)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(attempt, tokens))
    assert sorted(results) == [False, True]
    owner = repository(config).read_owner()
    assert owner["owner_token"] == tokens[results.index(True)]
    assert owner["owner_identity"] == OWNER
    assert owner["operation"] == "cover-refresh"


def test_release_allows_new_owner_but_stale_release_cannot_clear_it(ownership):
    config, (first, second), _ = ownership
    repo = repository(config)
    assert repo.read_owner() is None
    assert claim(repo, first) is True
    assert claim(repository(config), first) is False
    assert repo.release(owner_token=second) is False
    assert repo.read_owner()["owner_token"] == first
    assert repo.release(owner_token=first) is True
    assert repo.read_owner() is None
    assert claim(repository(config), second) is True
    assert repo.release(owner_token=first) is False
    assert repo.read_owner()["owner_token"] == second
    assert repo.release(owner_token=second) is True
    assert repo.release(owner_token=second) is False


def test_old_active_owner_never_expires_or_releases_on_disconnect(ownership):
    config, (first, second), library_id = ownership
    assert claim(repository(config), first) is True
    with isolatedPostgres._connect(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        connection.execute("""
            update ops.cover_lookup_tasks set requested_at = now() - interval '100 years'
            where library_id = %s and metadata->>'source_family' = %s and task_key = %s
        """, (library_id, FAMILY, TASK_KEY))
    # claim() has closed its connection; another instance still cannot take over.
    assert claim(repository(config), second) is False
    assert repository(config).read_owner()["owner_token"] == first


def test_notification_cleanup_cannot_delete_ownership_and_release_preserves_other_families(ownership):
    config, (first, _), library_id = ownership
    repo = repository(config)
    marker = str(uuid4())
    families = ["cover_lookup_notifications", "runtime_cover_lookup_notifications_adapter", "automatic_cover_provider_outcomes_v1"]
    url = config["ALBUM_HAVEN_APP_DATABASE_URL"]
    try:
        with isolatedPostgres._connect(url) as connection:
            for family in families:
                connection.execute("""
                    insert into ops.cover_lookup_tasks (library_id, task_key, status, metadata)
                    values (%s, %s, 'running', jsonb_build_object('source_family', %s::text, 'test_marker', %s::text))
                """, (library_id, TASK_KEY, family, marker))
        assert claim(repo, first) is True
        assert repo.release(owner_token=first) is True
        with isolatedPostgres._connect(url) as connection:
            rows = connection.execute("""
                select status from ops.cover_lookup_tasks where metadata->>'test_marker' = %s
            """, (marker,)).fetchall()
        assert [row["status"] for row in rows] == ["running"] * 3
        assert claim(repo, first) is True
        notifications = CoverLookupTasksPostgresAdapter(config, connect=isolatedPostgres._connect)
        notifications.delete_notifications({TASK_KEY})
        assert repo.read_owner()["owner_token"] == first
        with isolatedPostgres._connect(url) as connection:
            row = connection.execute("""
                select album_key, selected_cover_private_path, provider_payload
                from ops.cover_lookup_tasks where library_id = %s
                  and metadata->>'source_family' = %s and task_key = %s
            """, (library_id, FAMILY, TASK_KEY)).fetchone()
        assert row == {"album_key": None, "selected_cover_private_path": None, "provider_payload": {}}
    finally:
        with isolatedPostgres._connect(url) as connection:
            connection.execute("delete from ops.cover_lookup_tasks where metadata->>'test_marker' = %s", (marker,))


def test_lost_commit_acknowledgement_keeps_claim_and_requires_fresh_read(ownership):
    config, (first, second), _ = ownership

    @contextmanager
    def lose_acknowledgement(url):
        with isolatedPostgres._connect(url) as connection:
            yield connection
        # Simulate transport loss after the real commit, not a failed SQL write.
        raise ConnectionError("commit acknowledgement lost")

    with pytest.raises(ConnectionError, match="commit acknowledgement lost"):
        claim(repository(config, connect=lose_acknowledgement), first)
    observer = repository(config)
    assert observer.read_owner()["owner_token"] == first
    assert claim(observer, second) is False
    assert observer.release(owner_token=first) is True


def test_read_claim_and_release_are_scoped_to_bootstrap_library(ownership, database_urls):
    config, (token, _), library_id = ownership
    setup_url, _ = database_urls
    other_library_id = None
    library_name = f"ownership-sentinel-{uuid4()}"
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            other_library_id = connection.execute("""
                insert into library.libraries (owner_account_id, name, library_kind)
                select owner_account_id, %s, 'local' from library.libraries where id = %s
                returning id
            """, (library_name, library_id)).fetchone()["id"]
            sentinel = connection.execute("""
                insert into ops.cover_lookup_tasks (library_id, task_key, status, metadata)
                values (%s, %s, 'running', jsonb_build_object(
                    'source_family', %s::text, 'owner_token', %s::text,
                    'owner_identity', %s::jsonb,
                    'operation', 'sentinel-operation'))
                returning *
            """, (other_library_id, TASK_KEY, FAMILY, token, json.dumps(OWNER))).fetchone()

        repo = repository(config)
        assert repo.read_owner() is None
        assert repo.release(owner_token=token) is False
        assert claim(repo, token) is True
        assert repo.read_owner()["operation"] == "cover-refresh"
        assert repo.release(owner_token=token) is True
        assert repo.read_owner() is None
        with isolatedPostgres._connect(setup_url) as connection:
            unchanged = connection.execute(
                "select * from ops.cover_lookup_tasks where id = %s", (sentinel["id"],)
            ).fetchone()
        assert unchanged == sentinel
    finally:
        if other_library_id is not None:
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute("""
                    delete from ops.cover_lookup_tasks where library_id = %s
                      and task_key = %s and metadata->>'source_family' = %s
                      and metadata->>'owner_token' = %s
                """, (other_library_id, TASK_KEY, FAMILY, token))
                connection.execute(
                    "delete from library.libraries where id = %s and name = %s",
                    (other_library_id, library_name),
                )


@pytest.mark.parametrize("field", ["owner_token", "owner_identity", "operation"])
def test_invalid_owner_contract_does_not_open_database(field):
    def unexpected_connect(_url):
        pytest.fail("invalid ownership input opened a database connection")

    repo = repository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/unused"}, connect=unexpected_connect)
    values = {"owner_token": str(uuid4()), "owner_identity": dict(OWNER), "operation": "scan"}
    values[field] = {} if field == "owner_identity" else ""
    with pytest.raises(ValueError):
        repo.claim(**values)


@pytest.mark.parametrize("field", ["host", "pid", "process_started_at", "instance_id"])
@pytest.mark.parametrize("invalid", ["missing", "blank"])
def test_partial_owner_identity_does_not_open_database(field, invalid):
    def unexpected_connect(_url):
        pytest.fail("incomplete owner identity opened a database connection")

    repo = repository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/unused"}, connect=unexpected_connect)
    identity = dict(OWNER)
    if invalid == "missing":
        del identity[field]
    else:
        identity[field] = "   "
    assert identity  # A truthiness-only check must not accept a partial identity.
    with pytest.raises(ValueError):
        repo.claim(owner_token=str(uuid4()), owner_identity=identity, operation="scan")


@pytest.mark.parametrize("pid", [0, -1, True, False, 1.5, "12345"])
def test_owner_pid_requires_positive_integer_before_connecting(pid):
    def unexpected_connect(_url):
        pytest.fail("invalid owner PID opened a database connection")

    repo = repository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/unused"}, connect=unexpected_connect)
    with pytest.raises(ValueError):
        repo.claim(owner_token=str(uuid4()), owner_identity={**OWNER, "pid": pid}, operation="scan")


@pytest.mark.parametrize("token", [None, "", "   "])
def test_invalid_release_token_does_not_open_database(token):
    def unexpected_connect(_url):
        pytest.fail("invalid release token opened a database connection")

    repo = repository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/unused"}, connect=unexpected_connect)
    with pytest.raises(ValueError):
        repo.release(owner_token=token)


@pytest.mark.parametrize("operation", ["read_owner", "claim", "release"])
def test_missing_bootstrap_context_fails_closed(operation):
    class EmptyCursor:
        rowcount = 0

        def fetchone(self):
            return None

        def fetchall(self):
            return []

    class MissingBootstrapConnection:
        def execute(self, _sql, _params=None):
            return EmptyCursor()

        def transaction(self):
            return nullcontext()

    repo = repository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/unused"},
        connect=lambda _url: nullcontext(MissingBootstrapConnection()),
    )
    with pytest.raises(RuntimeError, match="(?i)bootstrap"):
        if operation == "claim":
            claim(repo, str(uuid4()))
        elif operation == "release":
            repo.release(owner_token=str(uuid4()))
        else:
            repo.read_owner()
