from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from threading import Barrier, Thread
from types import SimpleNamespace
from urllib.parse import urlparse
from uuid import UUID, uuid4

import pytest

from tests.e2e.support import isolatedPostgres


NOW = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)
MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "migrations"
    / "postgres"
    / "0108_create_watcher_runtime_sessions.sql"
)
_UNSET = object()


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
        _skip_or_fail_ci("Dedicated watcher session Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "").strip()
    readonly_url = str(os.environ.get("DATABASE_READONLY_URL") or "").strip()
    if not worker_url or not readonly_url:
        _skip_or_fail_ci("Dedicated watcher session role URLs are unavailable.")
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
        _skip_or_fail_ci("Watcher session roles do not share one isolated database.")
    return setup_url, app_url, worker_url, readonly_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("drop schema if exists app, integration, library, ops cascade")


@pytest.fixture(scope="module")
def watcher_session_database():
    setup_url, app_url, worker_url, readonly_url = _urls_or_skip()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, app_url)
        assert MIGRATION.is_file(), "migration 0108 is required for watcher sessions"
        with isolatedPostgres._connect(setup_url) as connection:
            applied = connection.execute(
                "select checksum from ops.schema_migrations where migration_name = %s",
                (MIGRATION.name,),
            ).fetchone()
            assert applied is not None, "migration 0108 was not applied"
            owner_id = int(
                connection.execute(
                    "select account_id from app.bootstrap_owners "
                    "where owner_key = 'local-bootstrap-owner'"
                ).fetchone()["account_id"]
            )
        yield SimpleNamespace(
            setup_url=setup_url,
            app_url=app_url,
            worker_url=worker_url,
            readonly_url=readonly_url,
            owner_id=owner_id,
        )
    finally:
        _drop_schemas(setup_url)


@pytest.fixture
def session_scope(watcher_session_database, tmp_path):
    scope = watcher_session_database
    name = f"Watcher Session {uuid4()}"
    with isolatedPostgres._connect(scope.setup_url) as connection:
        library_id = int(
            connection.execute(
                "insert into library.libraries (owner_account_id, name, library_kind) "
                "values (%s, %s, 'local') returning id",
                (scope.owner_id, name),
            ).fetchone()["id"]
        )
        root_ids = {}
        for logical_id in ("old-active", "old-inactive", "shared-active", "new-active"):
            root_path = tmp_path / logical_id
            root_path.mkdir()
            root_ids[logical_id] = int(
                connection.execute(
                    "insert into library.library_roots "
                    "(library_id, root_path, root_kind, is_active, metadata) "
                    "values (%s, %s, 'main', true, %s::jsonb) returning id",
                    (library_id, str(root_path), json.dumps({"root_id": logical_id})),
                ).fetchone()["id"]
            )
        other_library_id = int(
            connection.execute(
                "insert into library.libraries (owner_account_id, name, library_kind) "
                "values (%s, %s, 'local') returning id",
                (scope.owner_id, f"Watcher Session Other {uuid4()}"),
            ).fetchone()["id"]
        )
        cross_path = tmp_path / "cross-root"
        cross_path.mkdir()
        connection.execute(
            "insert into library.library_roots "
            "(library_id, root_path, root_kind, is_active, metadata) "
            "values (%s, %s, 'main', true, %s::jsonb)",
            (
                other_library_id,
                str(cross_path),
                json.dumps({"root_id": "cross-root"}),
            ),
        )
    try:
        yield SimpleNamespace(
            **vars(scope),
            library_id=library_id,
            root_ids=root_ids,
            other_library_id=other_library_id,
        )
    finally:
        with isolatedPostgres._connect(scope.setup_url) as connection:
            connection.execute("delete from library.libraries where id = %s", (library_id,))
            connection.execute(
                "delete from library.libraries where id = %s",
                (other_library_id,),
            )


def _begin(connection, scope, token, roots, started_at=NOW):
    return tuple(
        str(row["recovered_logical_root_id"])
        for row in connection.execute(
            "select * from library.begin_watcher_runtime_session(%s, %s, %s, %s)",
            (scope.library_id, token, list(roots), started_at),
        ).fetchall()
    )


def _invoke_session_operation(
    connection,
    scope,
    operation,
    *,
    token,
    roots,
    library_id=_UNSET,
    started_at=NOW,
):
    library_id = scope.library_id if library_id is _UNSET else library_id
    parameters = None if roots is None else list(roots)
    if operation == "begin":
        return connection.execute(
            "select * from library.begin_watcher_runtime_session(%s, %s, %s, %s)",
            (library_id, token, parameters, started_at),
        ).fetchall()
    if operation == "finish":
        return connection.execute(
            "select library.finish_watcher_runtime_session(%s, %s)",
            (library_id, token),
        ).fetchall()
    function_name = {
        "expand": "expand_watcher_runtime_session_participants",
        "set": "set_watcher_runtime_session_participants",
    }[operation]
    return connection.execute(
        f"select library.{function_name}(%s, %s, %s)",
        (library_id, token, parameters),
    ).fetchall()


def _participants(connection, library_id: int) -> set[str]:
    return {
        str(row["logical_id"])
        for row in connection.execute(
            "select root.metadata ->> 'root_id' as logical_id "
            "from library.watcher_runtime_session_participants participant "
            "join library.library_roots root on "
            "root.library_id = participant.library_id and root.id = participant.root_id "
            "where participant.library_id = %s",
            (library_id,),
        ).fetchall()
    }


def _occurrences(connection, scope, logical_id: str) -> int:
    row = connection.execute(
        "select coalesce(sum(incident.occurrence_count), 0) as occurrences "
        "from library.watcher_incidents incident "
        "join library.library_roots root on "
        "root.library_id = incident.library_id and root.id = incident.root_id "
        "where incident.library_id = %s and root.metadata ->> 'root_id' = %s "
        "and incident.resolved_at is null",
        (scope.library_id, logical_id),
    ).fetchone()
    return int(row["occurrences"])


def test_clean_begin_empty_roots_and_clean_finish(session_scope):
    token = uuid4()
    with isolatedPostgres._connect(session_scope.app_url) as app:
        assert _begin(app, session_scope, token, ()) == ()
        assert app.execute(
            "select library.finish_watcher_runtime_session(%s, %s) as finished",
            (session_scope.library_id, token),
        ).fetchone()["finished"] is True
        assert app.execute(
            "select library.finish_watcher_runtime_session(%s, %s) as finished",
            (session_scope.library_id, token),
        ).fetchone()["finished"] is False


def test_unclean_takeover_filters_inactive_prior_and_installs_exact_current_set(
    session_scope,
):
    old_token = uuid4()
    new_token = uuid4()
    with isolatedPostgres._connect(session_scope.app_url) as app:
        assert _begin(
            app,
            session_scope,
            old_token,
            ("old-active", "old-inactive", "shared-active"),
        ) == ()
    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        setup.execute(
            "update library.library_roots set is_active = false "
            "where id = %s",
            (session_scope.root_ids["old-inactive"],),
        )
    with isolatedPostgres._connect(session_scope.app_url) as app:
        recovered_logical_ids = _begin(
            app,
            session_scope,
            new_token,
            ("shared-active", "new-active"),
            NOW + timedelta(seconds=1),
        )
    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        assert recovered_logical_ids == ("old-active", "shared-active")
        assert _occurrences(setup, session_scope, "old-active") == 1
        assert _occurrences(setup, session_scope, "shared-active") == 1
        assert _occurrences(setup, session_scope, "old-inactive") == 0


def test_unclean_takeover_chunks_a_512_root_prior_union_and_installs_new_set(
    session_scope,
):
    old_roots = tuple(f"union-old-{index:03d}" for index in range(256))
    new_roots = tuple(f"union-new-{index:03d}" for index in range(256))
    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        setup.execute(
            "insert into library.library_roots "
            "(library_id, root_path, root_kind, is_active, metadata) "
            "select %s, %s || '/' || family || '-' || item::text, 'main', true, "
            "pg_catalog.jsonb_build_object("
            "'root_id', 'union-' || family || '-' || pg_catalog.lpad(item::text, 3, '0')"
            ") "
            "from (values ('old', 0), ('new', 1)) families(family, family_order) "
            "cross join pg_catalog.generate_series(0, 255) item "
            "order by family_order, item",
            (session_scope.library_id, "C:/watcher-session-union"),
        )

    old_token = uuid4()
    new_token = uuid4()
    with isolatedPostgres._connect(session_scope.app_url) as app:
        assert _begin(app, session_scope, old_token, old_roots) == ()
        app.execute(
            "select library.expand_watcher_runtime_session_participants(%s, %s, %s)",
            (session_scope.library_id, old_token, list(new_roots)),
        )
    with isolatedPostgres._connect(session_scope.app_url) as app:
        recovered = _begin(
            app,
            session_scope,
            new_token,
            new_roots,
            NOW + timedelta(seconds=1),
        )

    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        assert recovered == old_roots + new_roots
        assert _participants(setup, session_scope.library_id) == set(new_roots)
        recovered_occurrences = setup.execute(
            "select count(*) as recovered_count "
            "from library.watcher_incidents incident "
            "join library.library_roots root on "
            "root.library_id = incident.library_id and root.id = incident.root_id "
            "where incident.library_id = %s and incident.resolved_at is null "
            "and root.metadata ->> 'root_id' = any(%s)",
            (session_scope.library_id, list(old_roots + new_roots)),
        ).fetchone()["recovered_count"]
        assert int(recovered_occurrences) == 512


@pytest.mark.parametrize(
    "corrupt_root_id",
    [None, "   "],
    ids=["null", "blank"],
)
def test_begin_rejects_ambiguous_active_prior_metadata_and_preserves_evidence(
    session_scope,
    corrupt_root_id,
):
    import psycopg

    old_token = uuid4()
    new_token = uuid4()
    prior_root_ids = (
        session_scope.root_ids["old-active"],
        session_scope.root_ids["shared-active"],
    )
    with isolatedPostgres._connect(session_scope.app_url) as app:
        assert _begin(
            app,
            session_scope,
            old_token,
            ("old-active", "shared-active"),
        ) == ()
    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        setup.execute(
            "update library.library_roots "
            "set metadata = pg_catalog.jsonb_set("
            "metadata, '{root_id}', %s::jsonb, true"
            ") where id = %s",
            (json.dumps(corrupt_root_id), session_scope.root_ids["shared-active"]),
        )

    with isolatedPostgres._connect(session_scope.app_url) as app:
        app.autocommit = True
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            _begin(
                app,
                session_scope,
                new_token,
                ("new-active",),
                NOW + timedelta(seconds=1),
            )

    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        session = setup.execute(
            "select session_token from library.watcher_runtime_sessions "
            "where library_id = %s",
            (session_scope.library_id,),
        ).fetchone()
        participant_ids = tuple(
            row["root_id"]
            for row in setup.execute(
                "select root_id from library.watcher_runtime_session_participants "
                "where library_id = %s order by root_id",
                (session_scope.library_id,),
            ).fetchall()
        )
        incident_count = setup.execute(
            "select count(*) as incident_count from library.watcher_incidents "
            "where library_id = %s",
            (session_scope.library_id,),
        ).fetchone()["incident_count"]
        assert session["session_token"] == old_token
        assert participant_ids == tuple(sorted(prior_root_ids))
        assert int(incident_count) == 0
        reasons = {
            str(row["logical_id"]): str(row["reason_code"])
            for row in setup.execute(
                "select root.metadata ->> 'root_id' as logical_id, "
                "incident.reason_code from library.watcher_incidents incident "
                "join library.library_roots root on "
                "root.library_id = incident.library_id and root.id = incident.root_id "
                "where incident.library_id = %s and incident.resolved_at is null",
                (session_scope.library_id,),
            ).fetchall()
        }
        assert reasons == {
            "old-active": "overflow",
            "shared-active": "overflow",
        }
        assert _participants(setup, session_scope.library_id) == {
            "shared-active",
            "new-active",
        }


@pytest.mark.parametrize("operation", ["begin", "expand", "set"])
@pytest.mark.parametrize(
    ("case", "roots"),
    [
        ("blank", ("",)),
        ("duplicate", ("old-active", "old-active")),
        ("missing", ("missing",)),
        ("inactive", ("old-inactive",)),
        ("cross_library", ("cross-root",)),
        ("null", None),
    ],
)
def test_session_root_validation_rejects_every_invalid_scope(
    session_scope, operation, case, roots
):
    import psycopg

    token = uuid4()
    if case == "inactive":
        with isolatedPostgres._connect(session_scope.setup_url) as setup:
            setup.execute(
                "update library.library_roots set is_active = false where id = %s",
                (session_scope.root_ids["old-inactive"],),
            )
    with isolatedPostgres._connect(session_scope.app_url) as app:
        app.autocommit = True
        if operation != "begin":
            _begin(app, session_scope, token, ("old-active",))
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            _invoke_session_operation(
                app,
                session_scope,
                operation,
                token=token,
                roots=roots,
            )


@pytest.mark.parametrize("operation", ["begin", "expand", "set", "finish"])
@pytest.mark.parametrize("identity_case", ["null_library", "zero_library", "null_token"])
def test_session_identity_validation_is_uniform(
    session_scope, operation, identity_case
):
    import psycopg

    token = uuid4()
    library_id = session_scope.library_id
    if identity_case == "null_library":
        library_id = None
    elif identity_case == "zero_library":
        library_id = 0
    elif identity_case == "null_token":
        token = None
    with isolatedPostgres._connect(session_scope.app_url) as app:
        app.autocommit = True
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            _invoke_session_operation(
                app,
                session_scope,
                operation,
                token=token,
                roots=("old-active",),
                library_id=library_id,
            )


@pytest.mark.parametrize("started_at", [None, "infinity", "-infinity"])
def test_begin_rejects_null_or_nonfinite_start_time(session_scope, started_at):
    import psycopg

    with isolatedPostgres._connect(session_scope.app_url) as app:
        app.autocommit = True
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            _invoke_session_operation(
                app,
                session_scope,
                "begin",
                token=uuid4(),
                roots=("old-active",),
                started_at=started_at,
            )


def test_session_root_cap_accepts_256_and_rejects_257_for_every_array_function(
    session_scope,
):
    import psycopg

    logical_ids = tuple(f"cap-{index:03d}" for index in range(257))
    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        setup.execute(
            "insert into library.library_roots "
            "(library_id, root_path, root_kind, is_active, metadata) "
            "select %s, %s || '/' || item::text, 'main', true, "
            "pg_catalog.jsonb_build_object('root_id', 'cap-' || "
            "pg_catalog.lpad(item::text, 3, '0')) "
            "from pg_catalog.generate_series(0, 256) item",
            (session_scope.library_id, "C:/watcher-session-cap"),
        )
        count = setup.execute(
            "select count(*) as root_count from library.library_roots "
            "where library_id = %s and metadata ->> 'root_id' like 'cap-%%'",
            (session_scope.library_id,),
        ).fetchone()["root_count"]
        assert int(count) == 257

    with isolatedPostgres._connect(session_scope.app_url) as app:
        app.autocommit = True
        begin_token = uuid4()
        assert len(
            _invoke_session_operation(
                app,
                session_scope,
                "begin",
                token=begin_token,
                roots=logical_ids[:256],
            )
        ) == 0
        assert app.execute(
            "select library.finish_watcher_runtime_session(%s, %s) as finished",
            (session_scope.library_id, begin_token),
        ).fetchone()["finished"] is True
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            _invoke_session_operation(
                app,
                session_scope,
                "begin",
                token=uuid4(),
                roots=logical_ids,
            )

        mutation_token = uuid4()
        _begin(app, session_scope, mutation_token, ())
        for operation in ("expand", "set"):
            _invoke_session_operation(
                app,
                session_scope,
                operation,
                token=mutation_token,
                roots=logical_ids[:256],
            )
            with pytest.raises(psycopg.errors.InvalidParameterValue):
                _invoke_session_operation(
                    app,
                    session_scope,
                    operation,
                    token=mutation_token,
                    roots=logical_ids,
                )


def test_takeover_rolls_back_prior_session_after_injected_dirty_failure(session_scope):
    import psycopg

    old_token = uuid4()
    with isolatedPostgres._connect(session_scope.app_url) as app:
        _begin(app, session_scope, old_token, ("old-active",))
    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        setup.execute(
            "create function library.fail_watcher_session_dirty() returns trigger "
            "language plpgsql as $$ begin raise exception 'injected dirty failure'; end $$"
        )
        setup.execute(
            "create trigger watcher_session_dirty_failure before insert or update "
            "on library.watcher_incidents for each row execute function "
            "library.fail_watcher_session_dirty()"
        )
    try:
        with isolatedPostgres._connect(session_scope.app_url) as app:
            with pytest.raises(psycopg.errors.RaiseException, match="injected dirty failure"):
                _begin(
                    app,
                    session_scope,
                    uuid4(),
                    ("new-active",),
                    NOW + timedelta(seconds=1),
                )
        with isolatedPostgres._connect(session_scope.setup_url) as setup:
            row = setup.execute(
                "select session_token from library.watcher_runtime_sessions "
                "where library_id = %s",
                (session_scope.library_id,),
            ).fetchone()
            assert row["session_token"] == old_token
            assert _participants(setup, session_scope.library_id) == {"old-active"}
            assert _occurrences(setup, session_scope, "old-active") == 0
    finally:
        with isolatedPostgres._connect(session_scope.setup_url) as setup:
            setup.execute(
                "drop trigger if exists watcher_session_dirty_failure "
                "on library.watcher_incidents"
            )
            setup.execute("drop function if exists library.fail_watcher_session_dirty()")


def test_concurrent_begin_is_serialized_without_deadlock(session_scope):
    gate = Barrier(2)
    tokens = (uuid4(), uuid4())
    results = []
    errors = []

    def begin(token):
        try:
            with isolatedPostgres._connect(session_scope.app_url) as app:
                app.execute("set statement_timeout = '10s'")
                gate.wait(timeout=2.0)
                results.append(
                    _begin(app, session_scope, token, ("shared-active",))
                )
        except BaseException as exc:
            errors.append(exc)

    threads = [Thread(target=begin, args=(token,), daemon=True) for token in tokens]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(12.0)

    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    assert sorted(results, key=len) == [(), ("shared-active",)]
    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        assert _occurrences(setup, session_scope, "shared-active") == 1


def test_expand_set_and_finish_are_token_fenced_and_exact(session_scope):
    import psycopg

    token = uuid4()
    stale = UUID("00000000-0000-0000-0000-000000000099")
    with isolatedPostgres._connect(session_scope.app_url) as app:
        app.autocommit = True
        _begin(app, session_scope, token, ("old-active",))
        app.execute(
            "select library.expand_watcher_runtime_session_participants(%s, %s, %s)",
            (session_scope.library_id, token, ["shared-active", "new-active"]),
        )
        for statement, parameters in (
            (
                "select library.expand_watcher_runtime_session_participants(%s, %s, %s)",
                (session_scope.library_id, stale, ["shared-active"]),
            ),
            (
                "select library.set_watcher_runtime_session_participants(%s, %s, %s)",
                (session_scope.library_id, stale, ["shared-active"]),
            ),
            (
                "select library.finish_watcher_runtime_session(%s, %s)",
                (session_scope.library_id, stale),
            ),
        ):
            with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
                app.execute(statement, parameters)
        app.execute(
            "select library.set_watcher_runtime_session_participants(%s, %s, %s)",
            (session_scope.library_id, token, ["new-active"]),
        )
    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        assert _participants(setup, session_scope.library_id) == {"new-active"}


def test_session_privilege_matrix_covers_direct_inherited_and_public_access(
    session_scope,
):
    import psycopg
    from psycopg import sql

    signatures = (
        "library.begin_watcher_runtime_session(bigint,uuid,text[],timestamptz)",
        "library.expand_watcher_runtime_session_participants(bigint,uuid,text[])",
        "library.set_watcher_runtime_session_participants(bigint,uuid,text[])",
        "library.finish_watcher_runtime_session(bigint,uuid)",
    )
    tables = (
        "library.watcher_runtime_sessions",
        "library.watcher_runtime_session_participants",
    )
    table_privileges = (
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
    )
    cases = (
        ("album_haven_app", session_scope.app_url, True),
        ("album_haven_worker", session_scope.worker_url, False),
        ("album_haven_readonly", session_scope.readonly_url, False),
    )

    for role, url, function_allowed in cases:
        for set_inherited_role in (False, True):
            with isolatedPostgres._connect(url) as connection:
                connection.autocommit = True
                isolatedPostgres._assert_connected_role(connection, role)
                if set_inherited_role:
                    connection.execute(
                        sql.SQL("set role {}").format(sql.Identifier(role))
                    )
                assert connection.execute(
                    "select current_user as current_user"
                ).fetchone()["current_user"].casefold() == (
                    role
                    if set_inherited_role
                    else urlparse(url).username.casefold()
                )

                for table in tables:
                    for privilege in table_privileges:
                        assert connection.execute(
                            "select has_table_privilege(current_user, %s, %s) "
                            "as allowed",
                            (table, privilege),
                        ).fetchone()["allowed"] is False
                    with pytest.raises(psycopg.errors.InsufficientPrivilege):
                        connection.execute(f"select * from {table} where false")

                for signature in signatures:
                    allowed = connection.execute(
                        "select has_function_privilege(current_user, %s, 'EXECUTE') "
                        "as allowed",
                        (signature,),
                    ).fetchone()["allowed"]
                    assert allowed is function_allowed
                finish_call = (
                    "select library.finish_watcher_runtime_session(%s, %s) "
                    "as finished"
                )
                if function_allowed:
                    assert connection.execute(
                        finish_call,
                        (9223372036854775807, uuid4()),
                    ).fetchone()["finished"] is False
                else:
                    with pytest.raises(psycopg.errors.InsufficientPrivilege):
                        connection.execute(
                            finish_call,
                            (9223372036854775807, uuid4()),
                        )

    with isolatedPostgres._connect(session_scope.setup_url) as setup:
        for signature in signatures:
            assert setup.execute(
                "select has_function_privilege('album_haven_app', %s, 'EXECUTE') "
                "as allowed",
                (signature,),
            ).fetchone()["allowed"] is True
            assert setup.execute(
                "select not exists (select 1 from pg_catalog.aclexplode("
                "coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) acl "
                "where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') "
                "as public_denied from pg_catalog.pg_proc proc "
                "where proc.oid = %s::regprocedure",
                (signature,),
            ).fetchone()["public_denied"] is True
        for table in tables:
            for role in ("album_haven_app", "album_haven_worker", "album_haven_readonly"):
                for privilege in table_privileges:
                    assert setup.execute(
                        "select has_table_privilege(%s, %s, %s) as allowed",
                        (role, table, privilege),
                    ).fetchone()["allowed"] is False
            public_privileges = {
                str(row["privilege_type"])
                for row in setup.execute(
                    "select acl.privilege_type from pg_catalog.pg_class rel "
                    "cross join lateral pg_catalog.aclexplode(coalesce("
                    "rel.relacl, pg_catalog.acldefault('r', rel.relowner))) acl "
                    "where rel.oid = %s::regclass and acl.grantee = 0",
                    (table,),
                ).fetchall()
            }
            assert public_privileges.isdisjoint(table_privileges)
