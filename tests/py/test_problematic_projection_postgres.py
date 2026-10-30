from __future__ import annotations

import base64
import importlib
import json
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest


class _Cursor:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def __iter__(self):
        return iter(self._rows)


class _Connection:
    def __init__(self, scripted_rows, *, exit_error=None):
        self._scripted_rows = scripted_rows
        self._exit_error = exit_error
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        if self._exit_error is not None:
            raise self._exit_error
        return False

    def execute(self, sql, params=None):
        self.calls.append((" ".join(sql.split()), dict(params or {})))
        rows = self._scripted_rows.pop(0) if self._scripted_rows else ()
        return _Cursor(rows)


def _repository(module, *scripted_rows, exit_error=None):
    connections = []
    remaining_rows = list(scripted_rows)

    def connect(database_url):
        assert database_url == "postgresql://projection"
        connection = _Connection(remaining_rows, exit_error=exit_error)
        connections.append(connection)
        return connection

    repository = module.PostgresProblematicProjectionRepository(
        database_url="postgresql://projection",
        connect_to_database=connect,
    )
    return repository, connections


def _claim():
    return SimpleNamespace(
        job_id=73,
        attempt=2,
        worker_id="worker-7",
        lease_token="lease-9",
        library_id=17,
        resource_ref={"library_id": 17},
    )


def _now():
    return datetime(2026, 10, 28, 23, 45, tzinfo=timezone.utc)


def _live_plan_connection():
    database_url = str(os.environ.get("DATABASE_MIGRATOR_URL") or "").strip()
    if not database_url:
        pytest.skip("DATABASE_MIGRATOR_URL is required for live EXPLAIN coverage")
    from tests.e2e.support import isolatedPostgres

    database_name = isolatedPostgres._database_name(database_url)
    if not isolatedPostgres._is_owned_isolated_database_name(database_name):
        raise RuntimeError("live EXPLAIN coverage requires an isolated database")
    return isolatedPostgres._connect(database_url)


def _plan_nodes(plan: object) -> tuple[dict[str, object], ...]:
    if not isinstance(plan, dict):
        return ()
    nodes = [plan]
    for child in plan.get("Plans") or ():
        nodes.extend(_plan_nodes(child))
    return tuple(nodes)


def _explain(connection, sql: str, params: object = None) -> dict[str, object]:
    connection.execute("set local enable_seqscan = off")
    row = connection.execute(
        f"explain (format json) {sql}",
        params,
    ).fetchone()
    return row["QUERY PLAN"][0]["Plan"]


def _assert_plan_uses_index(plan: object, index_name: str) -> None:
    nodes = _plan_nodes(plan)
    assert any(node.get("Index Name") == index_name for node in nodes), [
        {
            "node_type": node.get("Node Type"),
            "relation": node.get("Relation Name"),
            "index": node.get("Index Name"),
        }
        for node in nodes
    ]


def _assert_relations_use_indexes(plan: object, relations: set[str]) -> None:
    nodes = _plan_nodes(plan)
    indexed_relations = {
        str(node.get("Relation Name"))
        for node in nodes
        if node.get("Relation Name")
        and node.get("Node Type")
        in {"Index Scan", "Index Only Scan", "Bitmap Heap Scan"}
    }
    assert relations <= indexed_relations, sorted(relations - indexed_relations)


def _assert_no_sequential_scan(plan: object, relations: set[str]) -> None:
    offenders = [
        node
        for node in _plan_nodes(plan)
        if node.get("Node Type") == "Seq Scan"
        and node.get("Relation Name") in relations
    ]
    assert not offenders, offenders


def _assert_reader_plan_is_projection_only(plan: object) -> None:
    forbidden = {
        "local_albums",
        "local_tracks",
        "local_track_files",
        "problematic_projection_source_staging",
        "problematic_projection_item_staging",
    }
    accessed = {
        str(node.get("Relation Name"))
        for node in _plan_nodes(plan)
        if node.get("Relation Name")
    }
    assert accessed.isdisjoint(forbidden), sorted(accessed & forbidden)


def _reader_plan_params(
    *,
    library_id: int,
    revision: UUID | None,
    query: str = "",
    reasons: tuple[str, ...] = (),
    anchor_item_key: str | None = None,
) -> dict[str, object]:
    return {
        "library_id": library_id,
        "revision": revision,
        "query": query,
        "query_pattern": f"%{query}%",
        "reasons": list(reasons),
        "anchor_item_key": anchor_item_key,
        "has_position": anchor_item_key is not None,
        "include_filtered_total": anchor_item_key is None,
        "carried_total": 0 if anchor_item_key is not None else None,
        "fetch_limit": 26,
    }


def _live_projection_identity(connection) -> tuple[int, UUID | None]:
    library_row = connection.execute(
        "select library_id from ops.resolve_problematic_projection_library()"
    ).fetchone()
    assert library_row is not None
    library_id = int(library_row["library_id"])
    state_row = connection.execute(
        "select committed_revision from ops.problematic_projection_state "
        "where library_id = %s",
        (library_id,),
    ).fetchone()
    revision = state_row["committed_revision"] if state_row else None
    return library_id, revision


def _prepare_live_projection_database(setup_url: str, app_url: str) -> int:
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    isolatedPostgres.prepare_isolated_database(setup_url, app_url)
    with isolatedPostgres._connect(setup_url) as connection:
        rows = connection.execute(
            """
            select library.id as library_id
            from app.bootstrap_owners owner
            join library.libraries library
              on library.owner_account_id = owner.account_id
            where owner.owner_key = 'local-bootstrap-owner'
              and library.library_kind = 'local'
            """
        ).fetchall()
    assert len(rows) == 1
    authoritative_library_id = int(rows[0]["library_id"])
    resolved_library_id = PostgresProblematicProjectionRepository(
        database_url=app_url
    ).resolve_bootstrap_library_id()
    assert resolved_library_id == authoritative_library_id
    return resolved_library_id


@pytest.fixture
def live_projection_database():
    setup_url = str(os.environ.get("DATABASE_MIGRATOR_URL") or "").strip()
    app_url = str(os.environ.get("DATABASE_APP_URL") or "").strip()
    worker_url = str(
        os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or ""
    ).strip()
    if not setup_url or not app_url or not worker_url:
        pytest.skip("isolated setup, app, and worker database URLs are required")

    from tests.e2e.support import isolatedPostgres

    for database_url in (setup_url, app_url, worker_url):
        database_name = isolatedPostgres._database_name(database_url)
        assert isolatedPostgres._is_owned_isolated_database_name(database_name)

    library_id = _prepare_live_projection_database(setup_url, app_url)
    try:
        yield SimpleNamespace(
            setup_url=setup_url,
            app_url=app_url,
            worker_url=worker_url,
            library_id=library_id,
        )
    finally:
        _prepare_live_projection_database(setup_url, app_url)


@pytest.fixture(scope="module")
def live_reader_plan_database():
    connection = _live_plan_connection()
    revision = UUID("00000000-0000-0000-0000-000000000009")
    try:
        library_id, _current_revision = _live_projection_identity(connection)
        connection.execute(
            """
            insert into ops.problematic_projection_headers(
                library_id, revision, source_generation, rebuild_epoch,
                builder_version, total, item_count, reason_facets, verified,
                published_at, reason_fact_count, reason_fingerprint,
                search_fact_count, search_fingerprint
            ) values (%s, %s, 1, 1, 1, 10000, 10000,
                      '{"missing cover":100,"other":9900}'::jsonb, true, now(),
                      10000, 0::bit(256), 10000, 0::bit(256))
            on conflict (library_id, revision) do nothing
            """,
            (library_id, revision),
        )
        connection.execute(
            """
            insert into ops.problematic_projection_items(
                library_id, revision, item_key, sort_title, sort_artist,
                sort_year, sort_album_key, search_text, reasons, summary
            )
            select %s,
                   %s,
                   'plan-item-' || lpad(value::text, 6, '0'),
                   'plan-title-' || lpad(value::text, 6, '0'),
                   'plan-artist-' || lpad((value %% 100)::text, 3, '0'),
                   (2000 + value %% 25)::text,
                   'plan-album-' || lpad(value::text, 6, '0'),
                   case when value %% 100 = 0
                        then 'premiere unique ' || value
                        else 'ordinary row ' || value end,
                   case when value %% 100 = 0
                        then array['missing cover']::text[]
                        else array['other']::text[] end,
                   jsonb_build_object(
                       'key', 'plan-item-' || lpad(value::text, 6, '0')
                   )
            from generate_series(1, 10000) value
            on conflict (library_id, revision, item_key) do nothing
            """,
            (library_id, revision),
        )
        connection.execute(
            """
            insert into ops.problematic_projection_state(
                library_id, committed_revision, committed_total,
                reason_facets, verified
            ) values (%s, %s, 10000,
                      '{"missing cover":100,"other":9900}'::jsonb, true)
            on conflict (library_id) do update set
                committed_revision = excluded.committed_revision,
                committed_total = excluded.committed_total,
                reason_facets = excluded.reason_facets,
                verified = excluded.verified
            """,
            (library_id, revision),
        )
        connection.execute("analyze ops.problematic_projection_items")
        yield connection, library_id, revision
    finally:
        connection.rollback()
        connection.close()


@pytest.fixture
def cursor_api():
    module = importlib.import_module(
        "music_app.services.problematic_projection_postgres"
    )
    required = (
        "ProblematicProjectionCursorError",
        "ProblematicProjectionPageCursor",
        "decode_problematic_projection_page_cursor",
        "encode_problematic_projection_page_cursor",
    )
    missing = [name for name in required if not hasattr(module, name)]
    assert not missing, f"missing durable cursor API: {missing}"
    return module


def _scope() -> dict[str, object]:
    return {
        "library_id": 17,
        "revision": "00000000-0000-0000-0000-000000000009",
        "query": "  АРИЯ   Deluxe  ",
        "reasons": ["Missing Cover", "empty audio", "missing cover"],
        "sort": " TITLE ",
    }


def _position() -> tuple[str, str, str, str, str]:
    return ("премьера", "ария", "1985", "album-key", "item::α")


def test_projection_page_cursor_round_trips_normalized_unicode_scope(cursor_api):
    scope = _scope()
    token = cursor_api.encode_problematic_projection_page_cursor(
        **scope,
        total=41,
        anchor_item_key=_position()[-1],
    )
    repeated = cursor_api.encode_problematic_projection_page_cursor(
        library_id=17,
        revision="00000000-0000-0000-0000-000000000009",
        query="ария deluxe",
        reasons=("empty audio", "MISSING COVER"),
        sort="title",
        total=41,
        anchor_item_key=_position()[-1],
    )

    assert token == repeated
    assert set(token) <= set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    )

    decoded = cursor_api.decode_problematic_projection_page_cursor(
        token,
        **scope,
    )
    assert decoded == cursor_api.ProblematicProjectionPageCursor(
        library_id=17,
        revision="00000000-0000-0000-0000-000000000009",
        query="ария deluxe",
        reasons=("empty audio", "missing cover"),
        sort="title",
        total=41,
        anchor_item_key=_position()[-1],
    )


def test_projection_page_cursor_keeps_exact_query_limit_compact_and_scope_bound(
    cursor_api,
):
    query = "x" * 4096
    scope = {
        "library_id": 17,
        "revision": "00000000-0000-0000-0000-000000000009",
        "query": query,
        "reasons": ["missing cover", "empty audio"],
        "sort": "album",
    }
    token = cursor_api.encode_problematic_projection_page_cursor(
        **scope,
        total=2,
        anchor_item_key=_position()[-1],
    )

    assert len(token) < 4096
    assert cursor_api.decode_problematic_projection_page_cursor(
        token,
        **scope,
    ) == cursor_api.ProblematicProjectionPageCursor(
        library_id=17,
        revision="00000000-0000-0000-0000-000000000009",
        query=query,
        reasons=("empty audio", "missing cover"),
        sort="album",
        total=2,
        anchor_item_key=_position()[-1],
    )
    with pytest.raises(cursor_api.ProblematicProjectionCursorError):
        cursor_api.decode_problematic_projection_page_cursor(
            token,
            **{**scope, "query": "y" * 4096},
        )
    with pytest.raises(cursor_api.ProblematicProjectionCursorError):
        cursor_api.decode_problematic_projection_page_cursor(
            token,
            **{**scope, "reasons": ["missing cover"]},
        )


def test_projection_page_cursor_v3_keeps_only_the_anchor_item_key(cursor_api):
    scope = {
        "library_id": 17,
        "revision": "00000000-0000-0000-0000-000000000009",
        "query": "x" * 4096,
        "reasons": ["missing cover", "empty audio"],
        "sort": "album",
    }
    anchor_item_key = "h1:" + ("a" * 43)
    token = cursor_api.encode_problematic_projection_page_cursor(
        **scope,
        total=2,
        anchor_item_key=anchor_item_key,
    )

    assert len(token) < 512
    assert cursor_api.decode_problematic_projection_page_cursor(
        token,
        **scope,
    ).anchor_item_key == anchor_item_key
    payload = json.loads(
        base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode("utf-8")
    )
    assert payload[0] == 3
    assert payload[-1] == anchor_item_key
    assert _position()[0] not in token


def test_projection_page_cursor_rejects_pre_v3_payload(cursor_api):
    scope = _scope()
    legacy_payload = [
        2,
        17,
        "00000000-0000-0000-0000-000000000009",
        "0" * 64,
        2,
        list(_position()),
    ]
    token = base64.urlsafe_b64encode(
        json.dumps(legacy_payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")

    with pytest.raises(cursor_api.ProblematicProjectionCursorError):
        cursor_api.decode_problematic_projection_page_cursor(token, **scope)


def test_projection_page_cursor_rejects_malformed_revision_before_sql(cursor_api):
    payload = [
        3,
        17,
        "not-a-uuid",
        cursor_api._cursor_filter_digest("", (), "album"),
        2,
        "item-a",
    ]
    token = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    repository, connections = _repository(cursor_api, ())

    with pytest.raises(cursor_api.ProblematicProjectionCursorError):
        repository.read_page(
            library_id=17,
            limit=1,
            sort="album",
            cursor=token,
        )

    assert connections == []


@pytest.mark.parametrize("revision", ["pending", "not-a-uuid"])
def test_projection_page_cursor_rejects_non_uuid_revision(cursor_api, revision):
    with pytest.raises(cursor_api.ProblematicProjectionCursorError):
        cursor_api.encode_problematic_projection_page_cursor(
            library_id=17,
            revision=revision,
            query="",
            reasons=(),
            sort="album",
            total=2,
            anchor_item_key="item-a",
        )


def test_projection_page_cursor_canonicalizes_python_uuid_forms(cursor_api):
    canonical = "00000000-0000-0000-0000-000000000009"
    token = cursor_api.encode_problematic_projection_page_cursor(
        library_id=17,
        revision=f"urn:uuid:{canonical}",
        query="",
        reasons=(),
        sort="album",
        total=2,
        anchor_item_key="item-a",
    )

    decoded = cursor_api.decode_problematic_projection_page_cursor(
        token,
        library_id=17,
        revision=canonical,
        query="",
        reasons=(),
        sort="album",
    )

    assert decoded.revision == canonical


@pytest.mark.parametrize(
    ("changed", "value"),
    [
        ("library_id", 18),
        ("revision", "00000000-0000-0000-0000-000000000010"),
        ("query", "another query"),
        ("reasons", ("missing year",)),
        ("sort", "artist"),
    ],
)
def test_projection_page_cursor_rejects_scope_mismatch(
    cursor_api,
    changed,
    value,
):
    scope = _scope()
    token = cursor_api.encode_problematic_projection_page_cursor(
        **scope,
        total=41,
        anchor_item_key=_position()[-1],
    )
    expected_scope = dict(scope)
    expected_scope[changed] = value

    with pytest.raises(cursor_api.ProblematicProjectionCursorError):
        cursor_api.decode_problematic_projection_page_cursor(
            token,
            **expected_scope,
        )


@pytest.mark.parametrize(
    "token",
    [
        "not-json",
        "A" * 4097,
        base64.urlsafe_b64encode(b"{}").decode("ascii").rstrip("="),
    ],
)
def test_projection_page_cursor_rejects_malformed_or_oversized_tokens(
    cursor_api,
    token,
):
    with pytest.raises(cursor_api.ProblematicProjectionCursorError):
        cursor_api.decode_problematic_projection_page_cursor(token, **_scope())


@pytest.mark.parametrize(
    "overrides",
    [
        {"library_id": True},
        {"library_id": 0},
        {"revision": ""},
        {"total": True},
        {"total": -1},
        {"anchor_item_key": ""},
        {"anchor_item_key": "x" * 257},
    ],
)
def test_projection_page_cursor_rejects_invalid_field_types(
    cursor_api,
    overrides,
):
    values = {
        **_scope(),
        "total": 41,
        "anchor_item_key": _position()[-1],
        **overrides,
    }
    with pytest.raises(cursor_api.ProblematicProjectionCursorError):
        cursor_api.encode_problematic_projection_page_cursor(**values)


def test_repository_resolves_exact_canonical_bootstrap_library(cursor_api):
    repository, connections = _repository(cursor_api, ({"library_id": 17},))

    assert repository.resolve_bootstrap_library_id() == 17
    sql, params = connections[0].calls[0]
    assert "ops.resolve_problematic_projection_library" in sql
    assert params == {}


@pytest.mark.parametrize("rows", [(), ({"library_id": 17}, {"library_id": 18})])
def test_repository_fails_closed_for_missing_or_ambiguous_bootstrap_library(
    cursor_api,
    rows,
):
    repository, _connections = _repository(cursor_api, rows)

    with pytest.raises(cursor_api.ProblematicProjectionIntegrityError):
        repository.resolve_bootstrap_library_id()


def test_repository_guarded_enqueue_returns_existing_or_created_job(cursor_api):
    repository, connections = _repository(
        cursor_api,
        ({"job_id": 91, "rebuild_epoch": 8, "created": False},),
    )

    result = repository.enqueue_rebuild(library_id=17, requested_by="projection-reader")

    assert result == {"job_id": 91, "rebuild_epoch": 8, "created": False}
    sql, params = connections[0].calls[0]
    assert "ops.enqueue_problematic_projection_rebuild" in sql
    assert params == {"library_id": 17, "requested_by": "projection-reader"}


@pytest.mark.parametrize(
    ("function_name", "parameter_types"),
    (
        ("enqueue_problematic_projection_rebuild", ("bigint", "text")),
        ("prepare_claimed_problematic_projection", ("bigint", "integer", "text", "text", "timestamptz")),
        ("validate_claimed_problematic_projection", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "timestamptz")),
        ("load_claimed_problematic_projection_source", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "integer", "integer", "timestamptz")),
        ("stage_claimed_problematic_projection_source", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "text", "text", "text", "text", "text", "text", "jsonb", "boolean", "timestamptz")),
        ("load_claimed_problematic_projection_staged_group", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "text", "text", "bigint", "integer", "timestamptz")),
        ("stage_claimed_problematic_projection_items", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "text", "text", "jsonb", "integer", "timestamptz")),
        ("stage_claimed_problematic_projection_reason_facts", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "text", "text", "jsonb", "timestamptz")),
        (
            "stage_claimed_problematic_projection_search_facts",
            (
                "bigint", "integer", "text", "text", "bigint", "bigint",
                "bigint", "uuid", "text", "text", "text", "text", "text",
                "integer", "timestamptz",
            ),
        ),
        ("complete_claimed_problematic_projection_group", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "text", "text", "text", "text", "text", "text", "timestamptz")),
        ("publish_claimed_problematic_projection", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "timestamptz")),
        ("fail_claimed_problematic_projection", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "text", "timestamptz")),
        ("cleanup_claimed_problematic_projection", ("bigint", "integer", "text", "text", "bigint", "bigint", "bigint", "uuid", "timestamptz")),
        ("reclaim_one_abandoned_problematic_projection", ("timestamptz",)),
        ("load_due_problematic_projection_integrity_audit", ("timestamptz",)),
        (
            "advance_problematic_projection_integrity_audit",
            (
                    "bigint", "uuid", "uuid", "text", "text", "text", "text", "text",
                "integer", "bigint", "bit(256)", "bigint", "bit(256)",
                    "text", "text", "text", "text", "text", "integer", "text",
                "bigint", "bit(256)", "bigint", "bit(256)", "timestamptz",
            ),
        ),
        (
            "load_problematic_projection_integrity_page",
                ("bigint", "uuid", "text", "text", "text", "text", "text", "integer"),
        ),
        (
            "complete_problematic_projection_integrity_audit",
            (
                "bigint", "uuid", "uuid", "integer", "bigint", "bit(256)",
                "bigint", "bit(256)", "timestamptz",
            ),
        ),
    ),
)
def test_projection_function_call_sql_uses_exact_migration_signature(
    cursor_api, function_name, parameter_types
):
    claim = ("job_id", "attempt", "worker_id", "lease_token")
    build = ("library_id", "source_generation", "rebuild_epoch", "revision")
    parameter_names = {
        "enqueue_problematic_projection_rebuild": ("library_id", "requested_by"),
        "prepare_claimed_problematic_projection": (*claim, "observed_at"),
        "validate_claimed_problematic_projection": (*claim, *build, "observed_at"),
        "load_claimed_problematic_projection_source": (
            *claim, *build, "limit", "child_limit", "observed_at",
        ),
        "stage_claimed_problematic_projection_source": (
            *claim, *build, "group_kind", "group_identity", "source_kind",
            "source_identity", "child_kind", "child_identity", "rows", "complete",
            "observed_at",
        ),
        "load_claimed_problematic_projection_staged_group": (
            *claim, *build, "group_kind", "group_identity", "after_stage_id", "limit",
            "observed_at",
        ),
        "stage_claimed_problematic_projection_items": (
            *claim, *build, "group_kind", "group_identity", "items", "batch_index",
            "observed_at",
        ),
        "stage_claimed_problematic_projection_reason_facts": (
            *claim, *build, "group_kind", "group_identity", "facts", "observed_at",
        ),
        "stage_claimed_problematic_projection_search_facts": (
            *claim, *build, "group_kind", "group_identity",
            "after_projection_id", "after_fact_kind",
            "after_semantic_child_identity", "limit", "observed_at",
        ),
        "complete_claimed_problematic_projection_group": (
            *claim, *build, "group_kind", "group_identity", "source_kind",
            "source_identity", "child_kind", "child_identity", "observed_at",
        ),
        "publish_claimed_problematic_projection": (*claim, *build, "observed_at"),
        "fail_claimed_problematic_projection": (
            *claim, *build, "reason_code", "observed_at",
        ),
        "cleanup_claimed_problematic_projection": (*claim, *build, "observed_at"),
        "reclaim_one_abandoned_problematic_projection": ("observed_at",),
        "load_due_problematic_projection_integrity_audit": ("observed_at",),
        "advance_problematic_projection_integrity_audit": (
            "library_id", "revision", "audit_claim_token",
            "expected_after_fact_type", "expected_after_item_key",
            "expected_after_identity_one", "expected_after_identity_two",
                "expected_after_identity_three",
            "expected_item_count", "expected_reason_fact_count",
            "expected_reason_fingerprint", "expected_search_fact_count",
            "expected_search_fingerprint", "after_fact_type", "after_item_key",
                "after_identity_one", "after_identity_two", "after_identity_three", "item_count",
            "last_counted_item_key", "reason_fact_count", "reason_fingerprint",
            "search_fact_count", "search_fingerprint",
            "observed_at",
        ),
        "load_problematic_projection_integrity_page": (
            "library_id", "revision", "after_fact_type", "after_item_key",
                "after_identity_one", "after_identity_two", "after_identity_three", "limit",
        ),
        "complete_problematic_projection_integrity_audit": (
            "library_id", "revision", "audit_claim_token", "item_count",
                "reason_fact_count", "reason_fingerprint", "search_fact_count",
                "search_fingerprint", "observed_at",
        ),
    }[function_name]

    sql = cursor_api._projection_function_call_sql(function_name, parameter_names)

    arguments = ", ".join(
        f"%({parameter_name})s::{parameter_type}"
        for parameter_name, parameter_type in zip(parameter_names, parameter_types)
    )
    assert sql == f"select * from ops.{function_name}({arguments})"


def test_projection_function_call_sql_rejects_unknown_or_reordered_boundaries(
    cursor_api,
):
    with pytest.raises(cursor_api.ProblematicProjectionIntegrityError):
        cursor_api._projection_function_call_sql("unknown_projection_function", ())
    with pytest.raises(cursor_api.ProblematicProjectionIntegrityError):
        cursor_api._projection_function_call_sql(
            "enqueue_problematic_projection_rebuild",
            ("requested_by", "library_id"),
        )


def test_stage_claimed_reason_facts_preserves_closed_sql_contract(cursor_api):
    function_name = "stage_claimed_problematic_projection_reason_facts"
    expected_parameters = (
        ("job_id", "bigint"),
        ("attempt", "integer"),
        ("worker_id", "text"),
        ("lease_token", "text"),
        ("library_id", "bigint"),
        ("source_generation", "bigint"),
        ("rebuild_epoch", "bigint"),
        ("revision", "uuid"),
        ("group_kind", "text"),
        ("group_identity", "text"),
        ("facts", "jsonb"),
        ("observed_at", "timestamptz"),
    )

    assert cursor_api._PROJECTION_FUNCTION_PARAMETERS[function_name] == expected_parameters
    assert cursor_api._PROJECTION_FUNCTION_RETURN_COLUMNS[function_name] == ()
    sql = cursor_api._projection_function_call_sql(
        function_name,
        tuple(name for name, _parameter_type in expected_parameters),
        success_key="accepted",
    )
    assert sql.startswith(
        "select true as accepted from "
        "ops.stage_claimed_problematic_projection_reason_facts("
    )


@pytest.mark.parametrize(
    ("function_name", "return_columns", "success_key"),
    (
        ("enqueue_problematic_projection_rebuild", ("job_id", "rebuild_epoch", "created"), None),
        ("prepare_claimed_problematic_projection", ("library_id", "source_generation", "rebuild_epoch", "revision", "group_kind", "group_identity", "source_kind", "source_identity", "child_kind", "child_identity", "committed"), None),
        ("validate_claimed_problematic_projection", ("valid",), None),
        ("load_claimed_problematic_projection_source", ("group_kind", "group_identity", "source_kind", "source_identity", "child_kind", "child_identity", "rows", "group_complete", "page_complete"), None),
        ("stage_claimed_problematic_projection_source", (), "accepted"),
        ("load_claimed_problematic_projection_staged_group", ("stage_id", "payload"), None),
        ("load_claimed_problematic_projection_group_accumulator", ("after_stage_id", "next_batch_index", "row_count", "source_complete"), None),
        ("checkpoint_claimed_problematic_projection_group_facts", ("after_stage_id", "next_batch_index", "row_count", "source_complete"), None),
        ("advance_claimed_problematic_projection_group_accumulator", ("advanced",), "advanced"),
        ("stage_claimed_problematic_projection_items", (), "accepted"),
        ("stage_claimed_problematic_projection_reason_facts", (), "accepted"),
        (
            "stage_claimed_problematic_projection_search_facts",
            (
                "after_projection_id", "after_fact_kind",
                "after_semantic_child_identity", "staged_count", "complete",
            ),
            None,
        ),
        ("complete_claimed_problematic_projection_group", (), "accepted"),
        ("publish_claimed_problematic_projection", ("published",), None),
        ("fail_claimed_problematic_projection", (), "recorded"),
        ("cleanup_claimed_problematic_projection", ("deleted_count",), None),
        ("reclaim_one_abandoned_problematic_projection", ("reclaimed",), None),
        (
            "load_due_problematic_projection_integrity_audit",
            (
                "library_id", "revision", "audit_revision", "after_fact_type",
                "after_item_key", "after_identity_one", "after_identity_two",
                    "after_identity_three",
                "item_count",
                "last_counted_item_key", "reason_fact_count",
                "reason_fingerprint", "search_fact_count", "search_fingerprint",
                "audit_claim_token",
            ),
            None,
        ),
        ("advance_problematic_projection_integrity_audit", ("advanced",), None),
        (
            "load_problematic_projection_integrity_page",
        (
            "fact_type", "item_key", "normalized_reason", "display_reason",
                "category_reason", "fact_kind", "semantic_child_identity", "normalized_text",
        ),
            None,
        ),
        ("complete_problematic_projection_integrity_audit", (), None),
    ),
)
def test_projection_function_call_sql_preserves_closed_return_shape(
    cursor_api, function_name, return_columns, success_key
):
    assert cursor_api._PROJECTION_FUNCTION_RETURN_COLUMNS[function_name] == return_columns
    parameter_names = tuple(
        name for name, _ in cursor_api._PROJECTION_FUNCTION_PARAMETERS[function_name]
    )

    sql = cursor_api._projection_function_call_sql(
        function_name, parameter_names, success_key=success_key
    )

    prefix = f"select true as {success_key} from" if success_key else "select * from"
    assert sql.startswith(f"{prefix} ops.{function_name}(")


def test_projection_function_call_sql_rejects_unknown_success_alias(cursor_api):
    parameter_names = tuple(
        name
        for name, _ in cursor_api._PROJECTION_FUNCTION_PARAMETERS[
            "stage_claimed_problematic_projection_source"
        ]
    )
    with pytest.raises(cursor_api.ProblematicProjectionIntegrityError):
        cursor_api._projection_function_call_sql(
            "stage_claimed_problematic_projection_source",
            parameter_names,
            success_key="published",
        )


def test_live_enqueue_claim_and_authorize_use_one_closed_projection_contract(
    live_projection_database,
):
    from music_app.services.jobs.authorization import (
        JobAuthorizationService,
        PostgresJobAuthorizationContextRepository,
        build_problematic_files_projection_resource_validator,
    )
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.jobs.models import JobState, JobTransitionResult
    from music_app.services.policy_evaluator import PolicyEvaluator
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    app_url = live_projection_database.app_url
    worker_url = live_projection_database.worker_url

    projection_repository = PostgresProblematicProjectionRepository(
        database_url=app_url
    )
    library_id = live_projection_database.library_id
    enqueued = projection_repository.enqueue_rebuild(
        library_id=library_id,
        requested_by="task9-contract-test",
    )
    now = datetime.now(timezone.utc)
    job_repository = PostgresJobRepository(database_url=worker_url)
    claim = job_repository.claim(
        worker_id="task9-contract-worker",
        now=now,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )

    assert claim is not None
    assert claim.job_id == enqueued["job_id"]
    assert claim.subject_kind == "problematic_files_projection"
    assert claim.subject_ref == f"library:{library_id}"
    assert set(claim.parameters) == {
        "projection_kind",
        "source_generation",
        "rebuild_epoch",
    }
    assert claim.parameters["projection_kind"] == "problematic_files"
    assert int(claim.parameters["source_generation"]) > 0
    assert int(claim.parameters["rebuild_epoch"]) == enqueued["rebuild_epoch"]
    assert claim.idempotency_key == (
        "problematic-files-projection:"
        f"{library_id}:{claim.parameters['source_generation']}:"
        f"{claim.parameters['rebuild_epoch']}"
    )

    service = JobAuthorizationService(
        context_repository=PostgresJobAuthorizationContextRepository(worker_url),
        policy_evaluator=PolicyEvaluator(),
        resource_validators={
            "problematic_files_projection": (
                build_problematic_files_projection_resource_validator()
            )
        },
    )
    decision = service.authorize(claim, now)

    assert decision.allowed is True
    assert decision.reason_code == "problematic_projection_scope_current"

    worker_projection_repository = PostgresProblematicProjectionRepository(
        database_url=worker_url
    )
    first_build = worker_projection_repository.prepare_claimed_build(
        claim=claim,
        now=now,
    )
    worker_projection_repository.stage_claimed_source_chunk(
        claim=claim,
        build=first_build,
        group_key=("album", 1),
        source_cursor=("album", 1, "file", 1),
        rows=({"album_id": 1, "file_id": 1},),
        complete=False,
        now=now,
    )
    retry_at = now + timedelta(seconds=1)
    assert job_repository.finish(
        claim,
        JobTransitionResult(
            JobState.RETRY_WAIT,
            "projection_storage_retry",
            scheduled_at=retry_at,
        ),
        now=now + timedelta(milliseconds=100),
    )
    retry_claim = job_repository.claim(
        worker_id="task9-contract-worker",
        now=retry_at,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert retry_claim is not None
    assert retry_claim.job_id == claim.job_id
    assert retry_claim.attempt == claim.attempt + 1

    retry_build = worker_projection_repository.prepare_claimed_build(
        claim=retry_claim,
        now=retry_at,
    )
    assert retry_build.revision == first_build.revision
    assert retry_build.source_cursor == ("album", 1, "file", 1)
    assert retry_build.source_group_key == ("album", 1)
    with _live_plan_connection() as connection:
        old_staging_count = connection.execute(
            "select count(*) as count "
            "from ops.problematic_projection_source_staging "
            "where job_id = %s and attempt = %s and revision = %s",
            (claim.job_id, claim.attempt, first_build.revision),
        ).fetchone()["count"]
        rebound_staging_count = connection.execute(
            "select count(*) as count "
            "from ops.problematic_projection_source_staging "
            "where job_id = %s and attempt = %s and revision = %s",
            (retry_claim.job_id, retry_claim.attempt, retry_build.revision),
        ).fetchone()["count"]
    assert old_staging_count == 0
    assert rebound_staging_count == 1

    worker_projection_repository.stage_claimed_source_chunk(
        claim=retry_claim,
        build=retry_build,
        group_key=("album", 2),
        source_cursor=("album", 2, "file", 1),
        rows=({"album_id": 2, "file_id": 1},),
        complete=False,
        now=retry_at,
    )
    with _live_plan_connection() as connection:
        connection.execute(
            """
            insert into ops.problematic_projection_source_staging(
                job_id, attempt, revision, group_kind, group_identity,
                source_kind, source_identity, child_kind, child_identity,
                payload, created_at
            ) values (%s, %s, %s, 'album', 'unrelated', 'album',
                      'unrelated', 'file', 'unrelated', '{}'::jsonb, %s)
            """,
            (
                claim.job_id,
                claim.attempt,
                first_build.revision,
                retry_at,
            ),
        )

    assert worker_projection_repository.reclaim_one_abandoned_build(
        now=retry_at
    ) is False
    assert job_repository.finish(
        retry_claim,
        JobTransitionResult(JobState.CANCELED, "projection_test_canceled"),
        now=retry_at + timedelta(seconds=1),
    )
    assert worker_projection_repository.reclaim_one_abandoned_build(
        now=retry_at + timedelta(seconds=2)
    ) is True

    with _live_plan_connection() as connection:
        state = connection.execute(
            """
            select rebuild_epoch, live_job_id, build_revision,
                   requested_job_id, requested_attempt, requested_revision,
                   recovery_reason_code
            from ops.problematic_projection_state
            where library_id = %s
            """,
            (library_id,),
        ).fetchone()
        exact_count = connection.execute(
            "select count(*) as count "
            "from ops.problematic_projection_source_staging "
            "where job_id = %s and attempt = %s and revision = %s",
            (retry_claim.job_id, retry_claim.attempt, retry_build.revision),
        ).fetchone()["count"]
        unrelated_count = connection.execute(
            "select count(*) as count "
            "from ops.problematic_projection_source_staging "
            "where job_id = %s and attempt = %s and revision = %s",
            (claim.job_id, claim.attempt, first_build.revision),
        ).fetchone()["count"]
        connection.execute(
            "delete from ops.problematic_projection_source_staging "
            "where job_id = %s",
            (claim.job_id,),
        )

    assert state["rebuild_epoch"] == enqueued["rebuild_epoch"] + 1
    assert state["live_job_id"] == state["requested_job_id"]
    assert state["live_job_id"] != retry_claim.job_id
    assert state["build_revision"] is None
    assert state["requested_attempt"] == 1
    assert state["requested_revision"] is None
    assert state["recovery_reason_code"] == "abandoned-terminal-canceled"
    assert exact_count == 0
    assert unrelated_count == 1


def test_live_projection_lifecycle_replays_publish_and_cleans_claimed_state(
    live_projection_database,
):
    from dataclasses import replace

    from music_app.jobs.problematic_projection_handlers import (
        build_problematic_projection_handler,
    )
    from music_app.services.jobs.authorization import AuthorizationDecision
    from music_app.services.jobs.models import JobState, JobTransitionResult
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_files_projection import (
        project_problematic_files,
    )
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    setup_url = live_projection_database.setup_url
    app_url = live_projection_database.app_url
    worker_url = live_projection_database.worker_url
    app_repository = PostgresProblematicProjectionRepository(database_url=app_url)
    library_id = live_projection_database.library_id
    with isolatedPostgres._connect(setup_url) as connection:
        artist_id = connection.execute(
            "insert into library.local_artists(library_id, artist_key, name) "
            "values (%s, 'projection-live-artist', 'Projection Artist') "
            "returning id",
            (library_id,),
        ).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums"
            "(library_id, artist_id, album_key, title, release_year, cover_path) "
            "values (%s, %s, 'projection-live-album', "
            "'Projection Album', 2026, 'C:\\projection-live\\cover.jpg') returning id",
            (library_id, artist_id),
        ).fetchone()["id"]
        track_id = connection.execute(
            "insert into library.local_tracks"
            "(library_id, album_id, artist_id, track_key, title, track_number) "
            "values (%s, %s, %s, 'projection-live-track', 'Healthy Track', 1) returning id",
            (library_id, album_id, artist_id),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.local_track_files"
            "(track_id, private_path, metadata) values (%s, %s, %s::jsonb)",
            (
                track_id,
                r"C:\projection-live\01.flac",
                json.dumps(
                    {
                        "scan_cache": {
                            "file_entry": {
                                "path": r"C:\projection-live\01.flac",
                                "album": "Projection Album",
                                "album_artist": "Projection Artist",
                                "artist": "Projection Artist",
                            "title": "Healthy Track",
                                "year": 2026,
                                "track_number": 1,
                                "disc_number": 1,
                            }
                        }
                    }
                ),
            ),
        )
        connection.execute(
            "insert into library.exception_overrides "
            "(library_id, track_key, track_id, override_payload) "
            "values (%s, %s, %s, %s::jsonb)",
            (
                library_id,
                r"C:\projection-live\01.flac",
                track_id,
                json.dumps({"exception_type": None}),
            ),
        )

    enqueued = app_repository.enqueue_rebuild(
        library_id=library_id,
        requested_by="projection-live-lifecycle",
    )
    job_id = int(enqueued["job_id"])
    assert enqueued["created"] is True
    now = datetime.now(timezone.utc)
    job_repository = PostgresJobRepository(database_url=worker_url)
    claim = job_repository.claim(
        worker_id="projection-live-worker", lease_seconds=60, now=now
    )
    assert claim is not None and claim.job_id == job_id
    repository = PostgresProblematicProjectionRepository(database_url=worker_url)
    build = repository.prepare_claimed_build(claim=claim, now=now)

    mismatched = replace(build, source_generation=build.source_generation + 1)
    rejected_page = repository.load_claimed_source_page(
        claim=claim, build=mismatched, limit=32, child_limit=100, now=now
    )
    assert rejected_page.chunks == () and rejected_page.complete is False

    class Context:
        cancel_requested = False
        lease_active = True

        @staticmethod
        def reauthorize():
            return AuthorizationDecision(
                True, "problematic_projection_scope_current"
            )

    result = build_problematic_projection_handler(
        repository=repository,
        project_group=project_problematic_files,
        clock=lambda: now,
    )(claim, Context())

    assert result.next_state is JobState.SUCCEEDED
    assert result.reason_code == "problematic_projection_completed"
    assert repository.publish_claimed_snapshot(claim=claim, build=build, now=now)
    assert job_repository.finish(
        claim,
        JobTransitionResult(JobState.SUCCEEDED, "projection_live_complete"),
        now=now,
    )

    with isolatedPostgres._connect(setup_url) as connection:
        counts = connection.execute(
            "select "
            "(select count(*) from ops.problematic_projection_source_staging) source_count, "
            "(select count(*) from ops.problematic_projection_group_facts) fact_count, "
            "(select count(*) from ops.problematic_projection_group_accumulators) accumulator_count, "
            "(select count(*) from ops.problematic_projection_item_staging) item_count"
        ).fetchone()
    assert counts == {
        "source_count": 0,
        "fact_count": 0,
        "accumulator_count": 0,
        "item_count": 0,
    }
    with isolatedPostgres._connect(setup_url) as connection:
        publication = connection.execute(
            """
            select header.total, header.reason_fact_count, job.attempt_count
            from ops.problematic_projection_state state
            join ops.problematic_projection_headers header
              on header.library_id = state.library_id
             and header.revision = state.committed_revision
            join ops.jobs job on job.id = state.committed_job_id
            where state.library_id = %s
            """,
            (library_id,),
        ).fetchone()
    assert publication == {
        "total": 0,
        "reason_fact_count": 0,
        "attempt_count": 1,
    }
    with isolatedPostgres._connect(app_url) as connection:
        with pytest.raises(Exception):
            connection.execute(
                "select count(*) from ops.problematic_projection_group_facts"
            ).fetchone()


def test_live_source_staging_bounds_metadata_and_row_relevant_ignores(
    live_projection_database,
):
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_files_projection import (
        ProblematicGroupAccumulator,
        _problematic_ignored_repair_identity,
    )
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    library_id = live_projection_database.library_id
    path = r"C:\task4-compact-source\01.flac"
    oversized = "not-staged-" + ("x" * 70_000)
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        artist_id = connection.execute(
            "insert into library.local_artists(library_id, artist_key, name) "
            "values (%s, 'task4-compact-artist', 'Task 4 Artist') returning id",
            (library_id,),
        ).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums"
            "(library_id, artist_id, album_key, title, release_year, metadata) "
            "values (%s, %s, 'task4-compact-album', 'Task 4 Album', 2026, %s::jsonb) "
            "returning id",
            (
                library_id,
                artist_id,
                json.dumps(
                    {
                        "album_artist": "Task 4 Artist",
                        "edition": "Expanded",
                        "album_rating": 5,
                        "comment": oversized,
                        "lyrics": oversized,
                        "custom_tag": oversized,
                    }
                ),
            ),
        ).fetchone()["id"]
        track_id = connection.execute(
            "insert into library.local_tracks"
            "(library_id, album_id, artist_id, track_key, title, track_number) "
            "values (%s, %s, %s, 'task4-compact-track', '', 1) returning id",
            (library_id, album_id, artist_id),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.local_track_files"
            "(track_id, private_path, metadata) values (%s, %s, %s::jsonb)",
            (
                track_id,
                path,
                json.dumps(
                    {
                        "scan_cache": {
                            "file_entry": {
                                "path": path,
                                "album": "Task 4 Album",
                                "album_artist": "Task 4 Artist",
                                "artist": "Task 4 Artist",
                                "title": "",
                                "year": 2026,
                                "track_number": 1,
                                "disc_number": 1,
                                "comment": oversized,
                                "lyrics": oversized,
                                "custom_tag": oversized,
                            }
                        }
                    }
                ),
            ),
        )
        relevant_problem_prefix = f"{path}::problem-file::"
        connection.execute(
            "insert into library.ignored_repairs(library_id, repair_key) "
            "select %s, %s || lpad(generate_series(1, 320)::text, 4, '0') "
            "|| '-' || repeat('x', 216)",
            (library_id, relevant_problem_prefix),
        )
        large_relevant_key = f"{relevant_problem_prefix}{'z' * 70_000}"
        connection.execute(
            "insert into library.ignored_repairs(library_id, repair_key) values (%s, %s)",
            (library_id, large_relevant_key),
        )
        near_index_relevant_key = (
            relevant_problem_prefix
            + "".join(chr(33 + ((index * 73) % 90)) for index in range(2_000))
        )
        connection.execute(
            "insert into library.ignored_repairs(library_id, repair_key) values (%s, %s)",
            (library_id, near_index_relevant_key),
        )
        relevant_key = f"{path}::title"
        connection.execute(
            "insert into library.ignored_repairs(library_id, repair_key) values (%s, %s)",
            (library_id, relevant_key),
        )

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    enqueued = app_repository.enqueue_rebuild(
        library_id=library_id,
        requested_by="task4-compact-source",
    )
    now = datetime.now(timezone.utc)
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    claim = job_repository.claim(
        worker_id="task4-compact-source-worker",
        now=now,
        lease_seconds=300,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == enqueued["job_id"]
    repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    build = repository.prepare_claimed_build(claim=claim, now=now)
    staged_rows = []
    row = None
    for _page_number in range(10):
        page = repository.load_claimed_source_page(
            claim=claim,
            build=build,
            limit=100,
            child_limit=100,
            now=now,
        )
        for chunk in page.chunks:
            staged_rows.extend(chunk.rows)
            repository.stage_claimed_source_chunk(
                claim=claim,
                build=build,
                group_key=chunk.group_key,
                source_cursor=chunk.cursor,
                rows=chunk.rows,
                complete=chunk.complete,
                now=now,
            )
            persisted = repository.load_claimed_group_accumulator(
                claim=claim,
                build=build,
                group_key=chunk.group_key,
                now=now,
            )
            facts = tuple(
                ProblematicGroupAccumulator.from_checkpoint(persisted).consume(
                    repository.iter_claimed_source_group_entries(
                        claim=claim,
                        build=build,
                        group_key=chunk.group_key,
                        after_stage_id=persisted.after_stage_id,
                        batch_limit=100,
                        now=now,
                    )
                )
            )
            if facts:
                fact_stage_count = 1 + sum(
                    facts[index - 1][0] != facts[index][0]
                    for index in range(1, len(facts))
                )
                repository.checkpoint_claimed_group_facts(
                    claim=claim,
                    build=build,
                    group_key=chunk.group_key,
                    expected_after_stage_id=persisted.after_stage_id,
                    entries=facts,
                    next_batch_index=persisted.next_batch_index,
                    row_count=persisted.row_count + fact_stage_count,
                    now=now,
                )
        row = next(
            (
                source_row
                for source_row in staged_rows
                if source_row.get("album_id") == album_id
            ),
            None,
        )
        if page.complete:
            break

    assert page.complete is True
    assert row is not None

    encoded_row = json.dumps(row, ensure_ascii=False)
    assert len(encoded_row.encode("utf-8")) <= 65_536
    assert oversized not in encoded_row
    assert "ignored_repair_keys" not in row
    staged_ignored_hashes = {
        source_row.get("ignored_repair_hash")
        for source_row in staged_rows
        if source_row.get("source_child_kind") == "ignored_repair"
    }
    expected_ignored_hashes = {
        _problematic_ignored_repair_identity(repair_key)
        for repair_key in (
            relevant_key,
            large_relevant_key,
            near_index_relevant_key,
        )
    }
    assert len(staged_ignored_hashes) == 323
    assert expected_ignored_hashes <= staged_ignored_hashes
    assert all(
        len(str(source_row.get("source_child_identity") or "")) <= 64
        for source_row in staged_rows
        if source_row.get("source_child_kind") == "ignored_repair"
    )
    assert large_relevant_key not in encoded_row
    assert near_index_relevant_key not in encoded_row


def test_live_ownership_moves_ignore_noncanonical_libraries(
    live_projection_database,
):
    from tests.e2e.support import isolatedPostgres

    setup_url = live_projection_database.setup_url
    canonical_id = live_projection_database.library_id
    with isolatedPostgres._connect(setup_url) as connection:
        owner_account_id = connection.execute(
            "select owner_account_id from library.libraries where id = %s",
            (canonical_id,),
        ).fetchone()["owner_account_id"]
        noncanonical_ids = tuple(
            connection.execute(
                "insert into library.libraries(owner_account_id, name, library_kind) "
                "values (%s, %s, 'task4-noncanonical') returning id",
                (owner_account_id, f"Task 4 noncanonical {index}"),
            ).fetchone()["id"]
            for index in (1, 2)
        )
        root_ids = tuple(
            row["id"]
            for row in connection.execute(
                "insert into library.library_roots(library_id, root_path, root_kind) "
                "select %s, 'C:\\task4-noncanonical-' || value::text, 'main' "
                "from generate_series(1, 5) value returning id",
                (noncanonical_ids[0],),
            ).fetchall()
        )
        ownership_trigger = connection.execute(
            "select (trigger_row.tgtype & 1) = 0 as statement_level, "
            "trigger_row.tgoldtable, trigger_row.tgnewtable "
            "from pg_catalog.pg_trigger trigger_row "
            "where trigger_row.tgrelid = 'library.library_roots'::regclass "
            "and trigger_row.tgname = "
            "'invalidate_problematic_projection_ownership_update'"
        ).fetchone()
        connection.execute(
            "delete from ops.problematic_projection_state where library_id = any(%s)",
            (list(noncanonical_ids),),
        )
        canonical_before = connection.execute(
            "select source_generation from ops.problematic_projection_state where library_id = %s",
            (canonical_id,),
        ).fetchone()["source_generation"]

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.library_roots set library_id = %s where id = any(%s)",
            (noncanonical_ids[1], list(root_ids)),
        )
    with isolatedPostgres._connect(setup_url) as connection:
        noncanonical_states = connection.execute(
            "select library_id from ops.problematic_projection_state "
            "where library_id = any(%s)",
            (list(noncanonical_ids),),
        ).fetchall()
        canonical_after_noncanonical_move = connection.execute(
            "select source_generation from ops.problematic_projection_state where library_id = %s",
            (canonical_id,),
        ).fetchone()["source_generation"]
    assert noncanonical_states == []
    assert canonical_after_noncanonical_move == canonical_before

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.library_roots set library_id = %s where id = any(%s)",
            (canonical_id, list(root_ids)),
        )
    with isolatedPostgres._connect(setup_url) as connection:
        canonical_after_canonical_move = connection.execute(
            "select source_generation from ops.problematic_projection_state where library_id = %s",
            (canonical_id,),
        ).fetchone()["source_generation"]
        noncanonical_states = connection.execute(
            "select library_id from ops.problematic_projection_state "
            "where library_id = any(%s)",
            (list(noncanonical_ids),),
        ).fetchall()
    assert canonical_after_canonical_move == canonical_before + 1
    assert noncanonical_states == []
    assert ownership_trigger == {
        "statement_level": True,
        "tgoldtable": "old_rows",
        "tgnewtable": "new_rows",
    }


def test_live_compact_metadata_invalidation_ignores_unrelated_and_noncanonical_rows(
    live_projection_database,
):
    from tests.e2e.support import isolatedPostgres

    setup_url = live_projection_database.setup_url
    canonical_id = live_projection_database.library_id
    with isolatedPostgres._connect(setup_url) as connection:
        owner_account_id = connection.execute(
            "select owner_account_id from library.libraries where id = %s",
            (canonical_id,),
        ).fetchone()["owner_account_id"]
        noncanonical_id = connection.execute(
            "insert into library.libraries(owner_account_id, name, library_kind) "
            "values (%s, 'Task 9A metadata noncanonical', 'task9a-noncanonical') "
            "returning id",
            (owner_account_id,),
        ).fetchone()["id"]
        canonical_artist_id = connection.execute(
            "insert into library.local_artists(library_id, artist_key, name) "
            "values (%s, 'task9a-metadata-canonical-artist', 'Canonical') returning id",
            (canonical_id,),
        ).fetchone()["id"]
        noncanonical_artist_id = connection.execute(
            "insert into library.local_artists(library_id, artist_key, name) "
            "values (%s, 'task9a-metadata-other-artist', 'Other') returning id",
            (noncanonical_id,),
        ).fetchone()["id"]
        canonical_album_ids = tuple(
            row["id"]
            for row in connection.execute(
                "insert into library.local_albums"
                "(library_id, artist_id, album_key, title, metadata) "
                "select %s, %s, 'task9a-metadata-' || value, "
                "'Metadata ' || value, '{\"edition\":\"Original\"}'::jsonb "
                "from generate_series(1, 3) value returning id",
                (canonical_id, canonical_artist_id),
            ).fetchall()
        )
        noncanonical_album_id = connection.execute(
            "insert into library.local_albums"
            "(library_id, artist_id, album_key, title, metadata) "
            "values (%s, %s, 'task9a-metadata-other', 'Other', "
            "'{\"edition\":\"Original\"}'::jsonb) returning id",
            (noncanonical_id, noncanonical_artist_id),
        ).fetchone()["id"]
        canonical_file_ids = []
        for index, album_id in enumerate(canonical_album_ids, start=1):
            track_id = connection.execute(
                "insert into library.local_tracks"
                "(library_id, album_id, artist_id, track_key, title, track_number) "
                "values (%s, %s, %s, %s, %s, %s) returning id",
                (
                    canonical_id,
                    album_id,
                    canonical_artist_id,
                    f"task9a-metadata-track-{index}",
                    f"Track {index}",
                    index,
                ),
            ).fetchone()["id"]
            canonical_file_ids.append(
                connection.execute(
                    "insert into library.local_track_files"
                    "(track_id, private_path, metadata) values (%s, %s, %s::jsonb) "
                    "returning id",
                    (
                        track_id,
                        rf"C:\task9a-metadata\{index:02d}.flac",
                        json.dumps(
                            {
                                "scan_cache": {
                                    "file_entry": {
                                        "title": f"Track {index}",
                                        "track_number": index,
                                    }
                                }
                            }
                        ),
                    ),
                ).fetchone()["id"]
            )
        noncanonical_track_id = connection.execute(
            "insert into library.local_tracks"
            "(library_id, album_id, artist_id, track_key, title, track_number) "
            "values (%s, %s, %s, 'task9a-metadata-other-track', 'Other', 1) "
            "returning id",
            (noncanonical_id, noncanonical_album_id, noncanonical_artist_id),
        ).fetchone()["id"]
        noncanonical_file_id = connection.execute(
            "insert into library.local_track_files"
            "(track_id, private_path, metadata) values (%s, %s, %s::jsonb) "
            "returning id",
            (
                noncanonical_track_id,
                r"C:\task9a-metadata-other\01.flac",
                json.dumps(
                    {
                        "scan_cache": {
                            "file_entry": {"title": "Other", "track_number": 1}
                        }
                    }
                ),
            ),
        ).fetchone()["id"]
        baseline = connection.execute(
            "select source_generation, rebuild_epoch from ops.problematic_projection_state "
            "where library_id = %s",
            (canonical_id,),
        ).fetchone()

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.local_albums set metadata = metadata || %s::jsonb "
            "where id = any(%s)",
            (
                json.dumps(
                    {
                        "comment": "unrelated",
                        "lyrics": "unrelated",
                        "custom_tag": "unrelated",
                    }
                ),
                list(canonical_album_ids),
            ),
        )
    with isolatedPostgres._connect(setup_url) as connection:
        after_unrelated_album = connection.execute(
            "select source_generation, rebuild_epoch from ops.problematic_projection_state "
            "where library_id = %s",
            (canonical_id,),
        ).fetchone()
    assert after_unrelated_album == baseline

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.local_track_files set metadata = metadata || %s::jsonb "
            "where id = any(%s)",
            (
                json.dumps(
                    {
                        "comment": "unrelated",
                        "lyrics": "unrelated",
                        "custom_tag": "unrelated",
                    }
                ),
                canonical_file_ids,
            ),
        )
    with isolatedPostgres._connect(setup_url) as connection:
        after_unrelated = connection.execute(
            "select source_generation, rebuild_epoch from ops.problematic_projection_state "
            "where library_id = %s",
            (canonical_id,),
        ).fetchone()
    assert after_unrelated == baseline

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.local_albums "
            "set metadata = jsonb_set(metadata, '{edition}', '\"Deluxe\"'::jsonb) "
            "where id = any(%s)",
            (list(canonical_album_ids),),
        )
    with isolatedPostgres._connect(setup_url) as connection:
        after_bulk_consumed = connection.execute(
            "select source_generation, rebuild_epoch from ops.problematic_projection_state "
            "where library_id = %s",
            (canonical_id,),
        ).fetchone()
    assert after_bulk_consumed == {
        "source_generation": baseline["source_generation"] + 1,
        "rebuild_epoch": baseline["rebuild_epoch"],
    }

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.local_track_files "
            "set metadata = jsonb_set(metadata, '{scan_cache,file_entry,title}', "
            "'\"Retitled\"'::jsonb) where id = any(%s)",
            (canonical_file_ids,),
        )
    with isolatedPostgres._connect(setup_url) as connection:
        after_file_consumed = connection.execute(
            "select source_generation, rebuild_epoch from ops.problematic_projection_state "
            "where library_id = %s",
            (canonical_id,),
        ).fetchone()
    assert after_file_consumed == {
        "source_generation": baseline["source_generation"] + 2,
        "rebuild_epoch": baseline["rebuild_epoch"],
    }

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.local_albums "
            "set metadata = jsonb_set(metadata, '{edition}', '\"Deluxe\"'::jsonb) "
            "where id = %s",
            (noncanonical_album_id,),
        )
        connection.execute(
            "update library.local_track_files "
            "set metadata = jsonb_set(metadata, '{scan_cache,file_entry,title}', "
            "'\"Retitled\"'::jsonb) where id = %s",
            (noncanonical_file_id,),
        )
    with isolatedPostgres._connect(setup_url) as connection:
        after_noncanonical = connection.execute(
            "select source_generation, rebuild_epoch from ops.problematic_projection_state "
            "where library_id = %s",
            (canonical_id,),
        ).fetchone()
        noncanonical_state = connection.execute(
            "select 1 from ops.problematic_projection_state where library_id = %s",
            (noncanonical_id,),
        ).fetchone()
    assert after_noncanonical == after_file_consumed
    assert noncanonical_state is None


def test_live_invalidation_fails_closed_for_ambiguous_canonical_library(
    live_projection_database,
):
    from tests.e2e.support import isolatedPostgres

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        owner_account_id = connection.execute(
            "select owner_account_id from library.libraries where id = %s",
            (live_projection_database.library_id,),
        ).fetchone()["owner_account_id"]
        connection.execute(
            "alter table library.libraries disable trigger invalidate_problematic_projection"
        )
        connection.execute(
            "insert into library.libraries(owner_account_id, name, library_kind) "
            "values (%s, 'Task 9A ambiguous canonical', 'local')",
            (owner_account_id,),
        )
        connection.execute(
            "alter table library.libraries enable trigger invalidate_problematic_projection"
        )
        with pytest.raises(Exception) as error:
            connection.execute(
                "update library.local_albums set title = title where library_id = %s",
                (live_projection_database.library_id,),
            )
        assert getattr(error.value, "sqlstate", None) == "55000"


def test_repository_prepares_and_validates_claimed_build(cursor_api):
    revision = UUID("00000000-0000-0000-0000-000000000012")
    build_row = {
        "library_id": 17,
        "source_generation": 12,
        "rebuild_epoch": 8,
        "revision": revision,
        "source_kind": "album",
        "source_identity": "100",
        "child_kind": "file",
        "child_identity": "4",
        "group_kind": "album",
        "group_identity": "100",
    }
    repository, connections = _repository(
        cursor_api,
        (build_row,),
        ({"valid": True},),
    )

    build = repository.prepare_claimed_build(claim=_claim(), now=_now())

    assert build == cursor_api.ProblematicProjectionBuild(
        library_id=17,
        source_generation=12,
        rebuild_epoch=8,
        revision=str(revision),
        source_cursor=("album", 100, "file", 4),
        source_group_key=("album", 100),
    )
    assert repository.validate_claimed_build(
        claim=_claim(), build=build, now=_now()
    ) is True
    assert "ops.prepare_claimed_problematic_projection" in connections[0].calls[0][0]
    assert "ops.validate_claimed_problematic_projection" in connections[1].calls[0][0]
    assert connections[1].calls[0][1]["revision"] == str(revision)


def test_real_repository_and_handler_acknowledge_a_committed_publish_replay(
    cursor_api,
):
    from music_app.jobs.problematic_projection_handlers import (
        build_problematic_projection_handler,
    )
    from music_app.services.jobs.authorization import AuthorizationDecision
    from music_app.services.jobs.models import JobState

    revision = UUID("00000000-0000-0000-0000-000000000020")
    repository, connections = _repository(
        cursor_api,
        (
            {
                "library_id": 17,
                "source_generation": 12,
                "rebuild_epoch": 8,
                "revision": revision,
                "source_kind": "album",
                "source_identity": 100,
                "child_kind": "file",
                "child_identity": 4,
                "group_kind": None,
                "group_identity": None,
            },
        ),
        ({"published": True},),
    )
    claim = SimpleNamespace(**vars(_claim()), max_attempts=3)

    class Context:
        cancel_requested = False
        lease_active = True

        @staticmethod
        def reauthorize():
            return AuthorizationDecision(True, "problematic_projection_scope_current")

    def projector(_rows):
        raise AssertionError("committed replay must not rebuild source rows")

    result = build_problematic_projection_handler(
        repository=repository,
        project_group=projector,
        clock=_now,
    )(claim, Context())

    assert result.next_state is JobState.SUCCEEDED
    assert len(connections) == 2
    assert "ops.prepare_claimed_problematic_projection" in connections[0].calls[0][0]
    assert "ops.publish_claimed_problematic_projection" in connections[1].calls[0][0]


def test_repository_rejects_mismatched_persisted_build_group(cursor_api):
    repository, _connections = _repository(
        cursor_api,
        ({
            "library_id": 17, "source_generation": 12, "rebuild_epoch": 8,
            "revision": UUID("00000000-0000-0000-0000-000000000015"),
            "source_kind": "album", "source_identity": "100",
            "child_kind": "file", "child_identity": "4",
            "group_kind": "album", "group_identity": "101",
        },),
    )

    with pytest.raises(cursor_api.ProblematicProjectionIntegrityError):
        repository.prepare_claimed_build(claim=_claim(), now=_now())


def test_repository_loads_bounded_source_page(cursor_api):
    repository, connections = _repository(
        cursor_api,
        (
            {
                "group_kind": "album",
                "group_identity": "100",
                "source_kind": "album",
                "source_identity": "100",
                "child_kind": "file",
                "child_identity": "4",
                "rows": [{"track_id": 3}, {"track_id": 4}],
                "group_complete": False,
                "page_complete": False,
            },
        ),
    )
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)

    page = repository.load_claimed_source_page(
        claim=_claim(), build=build, limit=32, child_limit=100, now=_now()
    )

    assert page == cursor_api.ProblematicProjectionSourcePage(
        chunks=(
            cursor_api.ProblematicProjectionSourceChunk(
                group_key=("album", 100),
                cursor=("album", 100, "file", 4),
                rows=({"track_id": 3}, {"track_id": 4}),
                complete=False,
            ),
        ),
        complete=False,
    )
    _sql, params = connections[0].calls[0]
    assert params["limit"] == 32
    assert params["child_limit"] == 100


@pytest.mark.parametrize(
    ("kind", "identity"),
    (
        ("featured_artist", "007"),
        ("ignored_repair", "42::year"),
        ("duplicate_lookup", "123|456"),
        ("duplicate_companion", "0009"),
        ("semantic_extension", "17"),
    ),
)
def test_projection_identity_validation_preserves_opaque_strings(
    cursor_api,
    kind,
    identity,
):
    assert cursor_api._validate_group_key((kind, identity)) == (kind, identity)
    assert cursor_api._validate_source_cursor(
        ("album", "12", kind, identity)
    ) == ("album", 12, kind, identity)


@pytest.mark.parametrize("kind", ("album", "missing_album", "loose_source", "file"))
@pytest.mark.parametrize(("identity", "expected"), ((7, 7), ("007", 7)))
def test_projection_identity_validation_normalizes_numeric_domain_values(
    cursor_api,
    kind,
    identity,
    expected,
):
    assert cursor_api._validate_group_key((kind, identity)) == (kind, expected)


@pytest.mark.parametrize("kind", ("album", "missing_album", "loose_source", "file"))
@pytest.mark.parametrize(
    "identity",
    (True, False, 0, -1, "", "0", "-1", "+1", "1.0", " 1 ", "not-a-number"),
)
def test_projection_identity_validation_rejects_malformed_numeric_domain_values(
    cursor_api,
    kind,
    identity,
):
    with pytest.raises(cursor_api.ProblematicProjectionIntegrityError):
        cursor_api._validate_group_key((kind, identity))


def test_repository_loads_empty_terminal_source_page(cursor_api):
    repository, _connections = _repository(
        cursor_api,
        ({"group_kind": None, "page_complete": True},),
    )
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)

    page = repository.load_claimed_source_page(
        claim=_claim(), build=build, limit=32, child_limit=100, now=_now()
    )

    assert page == cursor_api.ProblematicProjectionSourcePage((), True)


def test_repository_rejects_claimed_source_page_over_hard_row_limit(cursor_api):
    rows = tuple(
        {
            "group_kind": "album",
            "group_identity": str(index),
            "source_kind": "album",
            "source_identity": str(index),
            "child_kind": "file",
            "child_identity": str(index),
            "rows": [{"track_id": index}],
            "group_complete": True,
            "page_complete": index == 100,
        }
        for index in range(101)
    )
    repository, _connections = _repository(cursor_api, rows)
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)

    with pytest.raises(
        cursor_api.ProblematicProjectionIntegrityError,
        match="source page.*100",
    ):
        repository.load_claimed_source_page(
            claim=_claim(), build=build, limit=100, child_limit=100, now=_now()
        )


def test_repository_stages_chunks_items_and_completes_group(cursor_api):
    repository, connections = _repository(
        cursor_api,
        ({"accepted": True},),
        ({"accepted": True},),
        ({"accepted": True},),
    )
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)

    repository.stage_claimed_source_chunk(
        claim=_claim(), build=build, group_key=("album", 100),
        source_cursor=("album", 100, "file", 4),
        rows=({"track_id": 3},), complete=True, now=_now(),
    )
    repository.stage_claimed_items(
        claim=_claim(), build=build, group_key=("album", 100),
        items=(
            {
                "item_key": "item-a",
                "sort_title": "alpha",
                "sort_artist": "artist",
                "sort_year": "2026",
                "sort_album_key": "album-a",
                "search_text": "alpha",
                "reasons": [],
                "summary": {"key": "item-a"},
            },
        ),
        batch_index=0,
        now=_now(),
    )
    repository.complete_claimed_source_group(
        claim=_claim(), build=build, group_key=("album", 100),
        source_cursor=("album", 100, "file", 4), now=_now(),
    )

    source_sql = connections[0].calls[0][0]
    item_sql = connections[1].calls[0][0]
    completion_sql = connections[2].calls[0][0]
    assert "ops.stage_claimed_problematic_projection_source" in source_sql
    assert "%(rows)s" in source_sql and "%(complete)s" in source_sql
    assert "ops.stage_claimed_problematic_projection_items" in item_sql
    assert "%(items)s" in item_sql and "%(batch_index)s" in item_sql
    assert "ops.complete_claimed_problematic_projection_group" in completion_sql
    assert "%(child_identity)s" in completion_sql


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("item_key", "x" * 257),
        ("sort_title", "é" * 257),
        ("sort_artist", "é" * 257),
        ("sort_year", "x" * 65),
        ("sort_album_key", "é" * 257),
    ],
)
def test_repository_rejects_persisted_item_fields_above_storage_bounds(
    cursor_api, field, value
):
    repository, connections = _repository(cursor_api)
    item = {
        "item_key": "item-a",
        "sort_title": "alpha",
        "sort_artist": "artist",
        "sort_year": "2026",
        "sort_album_key": "album-a",
        "search_text": "alpha",
        "reasons": [],
        "summary": {"key": "item-a"},
        field: value,
    }

    with pytest.raises(cursor_api.ProblematicProjectionIntegrityError):
        repository.stage_claimed_items(
            claim=_claim(),
            build=cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None),
            group_key=("album", 100),
            items=(item,),
            batch_index=0,
            now=_now(),
        )

    assert connections == []


def test_repository_stage_claimed_reason_facts_with_public_fields_only(cursor_api):
    repository, connections = _repository(cursor_api, ({"accepted": True},))
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)
    facts = (
        SimpleNamespace(
            item_key="album-a",
            normalized_reason="missing title",
            display_reason="Missing title",
            category_reason="Missing title",
            private_detail="must-not-leak",
        ),
        SimpleNamespace(
            item_key="album-a",
            normalized_reason="invalid year",
            display_reason="Invalid year",
            category_reason="Invalid year",
            private_detail="must-not-leak",
        ),
    )

    repository.stage_claimed_reason_facts(
        claim=_claim(),
        build=build,
        group_key=("album", 100),
        facts=facts,
        now=_now(),
    )

    sql, params = connections[0].calls[0]
    assert "ops.stage_claimed_problematic_projection_reason_facts" in sql
    assert json.loads(params["facts"]) == [
        {
            "item_key": "album-a",
            "normalized_reason": "missing title",
            "display_reason": "Missing title",
                "category_reason": "Missing title",
        },
        {
            "item_key": "album-a",
            "normalized_reason": "invalid year",
            "display_reason": "Invalid year",
                "category_reason": "Invalid year",
        },
    ]
    assert params["group_kind"] == "album"


def test_repository_pages_claimed_search_facts_with_closed_cursor_contract(cursor_api):
    repository, connections = _repository(
        cursor_api,
        (
            {
                "after_projection_id": "projection-a",
                "after_fact_kind": "track_title_search",
                "after_semantic_child_identity": "chunk-00000000000000000099",
                "staged_count": 100,
                "complete": False,
            },
        ),
    )
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)

    result = repository.stage_claimed_search_facts(
        claim=_claim(),
        build=build,
        group_key=("album", 100),
        after_projection_id="",
        after_fact_kind="",
        after_semantic_child_identity="",
        limit=100,
        now=_now(),
    )

    assert result == (
        "projection-a",
        "track_title_search",
        "chunk-00000000000000000099",
        100,
        False,
    )
    sql, params = connections[0].calls[0]
    assert "ops.stage_claimed_problematic_projection_search_facts" in sql
    assert params["limit"] == 100
    assert params["after_projection_id"] == ""
    assert params["group_identity"] == "100"


def test_live_reason_fact_staging_rejects_null_and_non_string_public_fields(
    live_projection_database,
):
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    enqueued = app_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="strict-reason-fact-fields",
    )
    now = datetime.now(timezone.utc)
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    claim = job_repository.claim(
        worker_id="strict-reason-fact-worker",
        now=now,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == enqueued["job_id"]
    repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    build = repository.prepare_claimed_build(claim=claim, now=now)
    repository.stage_claimed_items(
        claim=claim,
        build=build,
        group_key=("album", 100),
        items=(
            {
                "item_key": "strict-reason-item",
                "sort_title": "",
                "sort_artist": "",
                "sort_year": "",
                "sort_album_key": "",
                "search_text": "",
                "reasons": [],
                "summary": {},
            },
        ),
        batch_index=0,
        now=now,
    )
    invalid_batches = (
        (None, "invalid projection reason fact batch"),
        (
            [{"item_key": 1, "normalized_reason": "missing", "display_reason": "Missing"}],
            "invalid projection reason fact",
        ),
        (
            [{"item_key": "strict-reason-item", "normalized_reason": True, "display_reason": "Missing"}],
            "invalid projection reason fact",
        ),
        (
            [{"item_key": "strict-reason-item", "normalized_reason": "missing", "display_reason": False}],
            "invalid projection reason fact",
        ),
    )
    sql = """
        select *
        from ops.stage_claimed_problematic_projection_reason_facts(
          %s, %s, %s, %s, %s, %s, %s, %s,
          %s, %s, %s::jsonb, %s
        )
    """
    for batch, expected_message in invalid_batches:
        encoded = None if batch is None else json.dumps(batch)
        with pytest.raises(Exception) as exc_info:
            with isolatedPostgres._connect(
                live_projection_database.worker_url
            ) as connection:
                connection.execute(
                    sql,
                    (
                        claim.job_id,
                        claim.attempt,
                        claim.worker_id,
                        claim.lease_token,
                        build.library_id,
                        build.source_generation,
                        build.rebuild_epoch,
                        build.revision,
                        "album",
                        "100",
                        encoded,
                        now,
                    ),
                ).fetchall()
        assert getattr(exc_info.value, "sqlstate", None) == "22023"
        assert expected_message in str(exc_info.value)
    repository.stage_claimed_reason_facts(
        claim=claim,
        build=build,
        group_key=("album", 100),
        facts=(
            SimpleNamespace(
                item_key="strict-reason-item",
                normalized_reason="missing title",
                display_reason="Missing title",
                category_reason="Missing title",
            ),
        ),
        now=now,
    )
    with isolatedPostgres._connect(
        live_projection_database.setup_url
    ) as connection:
        rows = connection.execute(
            "select item_key, normalized_reason, display_reason "
            "from ops.problematic_projection_reason_fact_staging "
            "where job_id = %s order by item_key, normalized_reason, display_reason",
            (claim.job_id,),
        ).fetchall()
    assert rows == [
        {
            "item_key": "strict-reason-item",
            "normalized_reason": "missing title",
            "display_reason": "Missing title",
        }
    ]


def test_reason_publication_uses_staged_exact_identity_and_facets():
    from pathlib import Path

    migration = " ".join(
        Path("migrations/postgres/0128_create_problematic_files_projection.sql")
        .read_text(encoding="utf-8")
        .lower()
        .split()
    )
    published_table = migration.split(
        "create table if not exists ops.problematic_projection_reason_facts", 1
    )[1].split("create table", 1)[0]
    publish = migration.split(
        "create or replace function ops.publish_claimed_problematic_projection", 1
    )[1].split("create or replace function", 1)[0]

    assert (
        "primary key ( library_id, revision, item_key, normalized_reason, "
        "display_reason, category_reason )"
    ) in published_table
    assert "from ops.problematic_projection_reason_fact_staging" in publish
    assert "unnest(staged.reasons)" not in publish
    assert publish.count("problematic_projection_reason_fact_staging") >= 3
    assert "problematic_projection_item_staging" in publish
    assert "not exists" in publish
    for field in ("item_key", "normalized_reason", "display_reason"):
        assert (
            f"octet_length(pg_catalog.convert_to({field}, 'utf8'))" in publish
        )


def test_live_publication_preserves_all_exact_reasons_and_last_good_revision(
    live_projection_database,
):
    from music_app.services.jobs.models import JobState, JobTransitionResult
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_files_projection import (
        ProblematicProjectionReasonFact,
    )
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    enqueued = app_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="exact-reason-publication",
    )
    now = datetime.now(timezone.utc)
    claim = job_repository.claim(
        worker_id="exact-reason-publication-worker",
        now=now,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == enqueued["job_id"]
    build = worker_repository.prepare_claimed_build(claim=claim, now=now)

    display_reasons = [f"Reason {index:03d}" for index in range(64)]
    exact_facts = [
        ProblematicProjectionReasonFact(
            item_key="exact-reason-item",
            normalized_reason=reason.casefold(),
            display_reason=reason,
            category_reason=reason,
        )
        for reason in display_reasons
    ]
    exact_facts.extend(
        (
            ProblematicProjectionReasonFact(
                item_key="exact-reason-item",
                normalized_reason="tail reason unique",
                display_reason="Tail reason unique",
                category_reason="Tail reason unique",
            ),
            ProblematicProjectionReasonFact(
                item_key="exact-reason-item",
                normalized_reason="reason 000",
                display_reason="REASON 000",
                category_reason="REASON 000",
            ),
            ProblematicProjectionReasonFact(
                item_key="exact-reason-item",
                normalized_reason="café",
                display_reason="Café",
                category_reason="Café",
            ),
        )
    )
    exact_facts.extend(
        ProblematicProjectionReasonFact(
            item_key="exact-reason-item",
            normalized_reason=f"audit reason {index:03d}",
            display_reason=f"Audit reason {index:03d}",
            category_reason=f"Audit reason {index:03d}",
        )
        for index in range(100)
    )
    item = {
        "item_key": "exact-reason-item",
        "sort_title": "Exact reason item",
        "sort_artist": "Artist",
        "sort_year": "2026",
        "sort_album_key": "exact-reason-item",
        "search_text": "exact reason item",
        "reasons": display_reasons,
        "summary": {
            "item_key": "exact-reason-item",
            "issue_count": len(exact_facts),
        },
    }
    worker_repository.stage_claimed_items(
        claim=claim,
        build=build,
        group_key=("album", 100),
        items=(item,),
        batch_index=0,
        now=now,
    )
    for offset in range(0, len(exact_facts), 100):
        worker_repository.stage_claimed_reason_facts(
            claim=claim,
            build=build,
            group_key=("album", 100),
            facts=exact_facts[offset : offset + 100],
            now=now,
        )

    assert worker_repository.publish_claimed_snapshot(
        claim=claim, build=build, now=now
    )
    page = app_repository.read_page(
        library_id=build.library_id,
        limit=10,
        reasons=("tail reason unique",),
    )
    assert [entry["item_key"] for entry in page.items] == ["exact-reason-item"]
    assert page.reason_facets["Tail reason unique"] == 1
    assert page.reason_facets["REASON 000"] == 1
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        stored = connection.execute(
            "select normalized_reason, display_reason "
            "from ops.problematic_projection_reason_facts "
            "where library_id = %s and revision = %s and item_key = %s "
            "order by normalized_reason, display_reason",
            (build.library_id, build.revision, "exact-reason-item"),
        ).fetchall()
    assert len(stored) == len(exact_facts)
    assert {
        row["display_reason"]
        for row in stored
        if row["normalized_reason"] == "reason 000"
    } == {"REASON 000", "Reason 000"}

    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        state_before_audit = connection.execute(
            """
            update ops.problematic_projection_state
            set next_integrity_audit_at = %s - interval '1 second'
            where library_id = %s
            returning rebuild_epoch
            """,
            (now, build.library_id),
        ).fetchone()
    assert ProblematicProjectionIntegrityReconciler(
        repository=worker_repository
    ).reconcile_due(now=now, limit=100) == 1
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        intermediate_state = connection.execute(
            """
            select rebuild_epoch, verified, live_job_id, audit_revision,
                   audit_after_fact_type, audit_after_item_key,
                   audit_after_identity_one, audit_after_identity_two,
                   audit_reason_fact_count, audit_search_fact_count,
                   audit_claim_token
            from ops.problematic_projection_state
            where library_id = %s
            """,
            (build.library_id,),
        ).fetchone()
    assert intermediate_state["rebuild_epoch"] == state_before_audit["rebuild_epoch"]
    assert intermediate_state["live_job_id"] is None
    assert intermediate_state["audit_revision"] == UUID(build.revision)
    assert intermediate_state["audit_after_item_key"] == "exact-reason-item"
    assert intermediate_state["audit_after_fact_type"] == "reason"
    assert intermediate_state["audit_after_identity_one"]
    assert intermediate_state["audit_after_identity_two"]
    assert intermediate_state["audit_reason_fact_count"] == 100
    assert ProblematicProjectionIntegrityReconciler(
        repository=worker_repository
    ).reconcile_due(now=now, limit=100) == 1
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        state_after_audit = connection.execute(
            """
            select rebuild_epoch, verified, audit_claim_token
            from ops.problematic_projection_state
            where library_id = %s
            """,
            (build.library_id,),
        ).fetchone()
    assert state_after_audit == {
        "rebuild_epoch": state_before_audit["rebuild_epoch"],
        "verified": True,
        "audit_claim_token": None,
    }

    assert job_repository.finish(
        claim,
        JobTransitionResult(JobState.SUCCEEDED, "exact_reason_publish_complete"),
        now=now,
    )
    rejected_job = app_repository.enqueue_rebuild(
        library_id=build.library_id,
        requested_by="missing-exact-reason",
    )
    now = datetime.now(timezone.utc)
    rejected_claim = job_repository.claim(
        worker_id="missing-exact-reason-worker",
        now=now,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert rejected_claim is not None and rejected_claim.job_id == rejected_job["job_id"]
    rejected_build = worker_repository.prepare_claimed_build(
        claim=rejected_claim, now=now
    )
    worker_repository.stage_claimed_items(
        claim=rejected_claim,
        build=rejected_build,
        group_key=("album", 101),
        items=({**item, "item_key": "item-without-exact-reason"},),
        batch_index=0,
        now=now,
    )

    assert not worker_repository.publish_claimed_snapshot(
        claim=rejected_claim, build=rejected_build, now=now
    )
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        state = connection.execute(
            "select committed_revision from ops.problematic_projection_state "
            "where library_id = %s",
            (build.library_id,),
        ).fetchone()
    assert state is not None
    assert str(state["committed_revision"]) == build.revision


def test_live_empty_publication_has_zero_fingerprint_and_passes_integrity_audit(
    live_projection_database,
):
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    enqueued = app_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="empty-integrity-publication",
    )
    now = datetime.now(timezone.utc)
    claim = job_repository.claim(
        worker_id="empty-integrity-publication-worker",
        now=now,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == enqueued["job_id"]
    build = worker_repository.prepare_claimed_build(claim=claim, now=now)
    assert worker_repository.publish_claimed_snapshot(
        claim=claim, build=build, now=now
    )

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        header = connection.execute(
            """
            select total, item_count, reason_fact_count,
                   reason_fingerprint::text as reason_fingerprint
            from ops.problematic_projection_headers
            where library_id = %s and revision = %s
            """,
            (build.library_id, build.revision),
        ).fetchone()
        state_before_audit = connection.execute(
            """
            update ops.problematic_projection_state
            set next_integrity_audit_at = %s - interval '1 second'
            where library_id = %s
            returning rebuild_epoch
            """,
            (now, build.library_id),
        ).fetchone()
    assert header == {
        "total": 0,
        "item_count": 0,
        "reason_fact_count": 0,
        "reason_fingerprint": "0" * 256,
    }
    assert ProblematicProjectionIntegrityReconciler(
        repository=worker_repository
    ).reconcile_due(now=now, limit=100) == 1
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        state_after_audit = connection.execute(
            """
            select rebuild_epoch, verified, audit_claim_token
            from ops.problematic_projection_state
            where library_id = %s
            """,
            (build.library_id,),
        ).fetchone()
    assert state_after_audit == {
        "rebuild_epoch": state_before_audit["rebuild_epoch"],
        "verified": True,
        "audit_claim_token": None,
    }


def test_live_category_only_reason_mutation_fails_audit_and_enqueues_one_replacement(
    live_projection_database,
):
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_files_projection import (
        ProblematicProjectionReasonFact,
    )
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    enqueued = app_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="category-integrity",
    )
    observed_at = datetime.now(timezone.utc)
    claim = job_repository.claim(
        worker_id="category-integrity-worker",
        now=observed_at,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == enqueued["job_id"]
    build = worker_repository.prepare_claimed_build(
        claim=claim, now=observed_at
    )
    item = {
        "item_key": "category-item",
        "sort_title": "Category item",
        "sort_artist": "Artist",
        "sort_year": "2026",
        "sort_album_key": "category-item",
        "search_text": "category item artist 2026",
        "reasons": ["Missing cover art"],
        "summary": {"item_key": "category-item", "issue_count": 1},
    }
    worker_repository.stage_claimed_items(
        claim=claim,
        build=build,
        group_key=("album", 1),
        items=(item,),
        batch_index=0,
        now=observed_at,
    )
    worker_repository.stage_claimed_reason_facts(
        claim=claim,
        build=build,
        group_key=("album", 1),
        facts=(
            ProblematicProjectionReasonFact(
                item_key="category-item",
                normalized_reason="missing cover art",
                display_reason="Missing cover art",
                category_reason="Missing cover art",
            ),
        ),
        now=observed_at,
    )
    assert worker_repository.publish_claimed_snapshot(
        claim=claim, build=build, now=observed_at
    )

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        before = connection.execute(
            """
            select header.total, header.reason_fact_count,
                   state.rebuild_epoch
            from ops.problematic_projection_headers header
            join ops.problematic_projection_state state
              on state.library_id = header.library_id
             and state.committed_revision = header.revision
            where header.library_id = %s and header.revision = %s
            """,
            (build.library_id, build.revision),
        ).fetchone()
        connection.execute(
            """
            update ops.problematic_projection_reason_facts
            set category_reason = 'Changed category only'
            where library_id = %s and revision = %s
              and item_key = 'category-item'
            """,
            (build.library_id, build.revision),
        )
        connection.execute(
            """
            update ops.problematic_projection_state
            set next_integrity_audit_at = pg_catalog.clock_timestamp()
                - interval '1 second'
            where library_id = %s
            """,
            (build.library_id,),
        )

    reconciler = ProblematicProjectionIntegrityReconciler(
        repository=worker_repository
    )
    assert reconciler.reconcile_due(now=observed_at, limit=100) == 1
    assert reconciler.reconcile_due(now=observed_at, limit=100) == 0

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        after = connection.execute(
            """
            select state.verified, state.rebuild_epoch, state.live_job_id,
                   header.total, header.reason_fact_count,
                   count(job.id)::integer as replacement_count
            from ops.problematic_projection_state state
            join ops.problematic_projection_headers header
              on header.library_id = state.library_id
             and header.revision = state.committed_revision
            left join ops.jobs job
              on job.library_id = state.library_id
             and job.idempotency_key =
               'problematic-files-projection:' || state.library_id::text || ':' ||
               state.source_generation::text || ':' || state.rebuild_epoch::text
            where state.library_id = %s
            group by state.verified, state.rebuild_epoch, state.live_job_id,
                     header.total, header.reason_fact_count
            """,
            (build.library_id,),
        ).fetchone()
    assert after["live_job_id"] is not None
    assert {key: value for key, value in after.items() if key != "live_job_id"} == {
        "verified": False,
        "rebuild_epoch": before["rebuild_epoch"] + 1,
        "total": before["total"],
        "reason_fact_count": before["reason_fact_count"],
        "replacement_count": 1,
    }


def test_live_audit_claim_uses_database_clock_for_due_lease_and_schedule(
    live_projection_database,
):
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    enqueued = app_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="database-clock-audit",
    )
    observed_at = datetime.now(timezone.utc)
    claim = job_repository.claim(
        worker_id="database-clock-audit-worker",
        now=observed_at,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == enqueued["job_id"]
    build = worker_repository.prepare_claimed_build(
        claim=claim, now=observed_at
    )
    assert worker_repository.publish_claimed_snapshot(
        claim=claim, build=build, now=observed_at
    )
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        database_before = connection.execute(
            "select pg_catalog.clock_timestamp() as value"
        ).fetchone()["value"]
        connection.execute(
            "update ops.problematic_projection_state "
            "set next_integrity_audit_at = pg_catalog.clock_timestamp() "
            "- interval '1 second' where library_id = %s",
            (build.library_id,),
        )

    behind = datetime(2000, 1, 1, tzinfo=timezone.utc)
    ahead = datetime(2100, 1, 1, tzinfo=timezone.utc)
    due = worker_repository.load_due_integrity_audit(now=behind)
    assert due is not None
    assert worker_repository.load_due_integrity_audit(now=ahead) is None
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        claimed = connection.execute(
            """
            select audit_claimed_at, pg_catalog.clock_timestamp() as database_now
            from ops.problematic_projection_state where library_id = %s
            """,
            (build.library_id,),
        ).fetchone()
    assert database_before <= claimed["audit_claimed_at"] <= claimed["database_now"]

    worker_repository.complete_integrity_audit(
        library_id=build.library_id,
        revision=build.revision,
        audit_claim_token=str(due["audit_claim_token"]),
        item_count=0,
        reason_fact_count=0,
        reason_fingerprint="0" * 256,
        search_fact_count=0,
        search_fingerprint="0" * 256,
        now=behind,
    )
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        scheduled = connection.execute(
            """
            select next_integrity_audit_at, pg_catalog.clock_timestamp() as database_now
            from ops.problematic_projection_state where library_id = %s
            """,
            (build.library_id,),
        ).fetchone()
    delay = scheduled["next_integrity_audit_at"] - scheduled["database_now"]
    assert timedelta(minutes=14, seconds=55) <= delay <= timedelta(minutes=15)


def test_live_blocked_audit_completion_cannot_outlive_database_lease(
    live_projection_database,
):
    import threading
    import time

    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    enqueued = app_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="blocked-audit-lease",
    )
    observed_at = datetime.now(timezone.utc)
    claim = job_repository.claim(
        worker_id="blocked-audit-lease-worker",
        now=observed_at,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == enqueued["job_id"]
    build = worker_repository.prepare_claimed_build(
        claim=claim, now=observed_at
    )
    assert worker_repository.publish_claimed_snapshot(
        claim=claim, build=build, now=observed_at
    )
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        connection.execute(
            "update ops.problematic_projection_state "
            "set next_integrity_audit_at = pg_catalog.clock_timestamp() "
            "- interval '1 second' where library_id = %s",
            (build.library_id,),
        )
    due = worker_repository.load_due_integrity_audit(
        now=datetime(2100, 1, 1, tzinfo=timezone.utc)
    )
    assert due is not None

    errors = []
    finished = threading.Event()

    def complete() -> None:
        try:
            worker_repository.complete_integrity_audit(
                library_id=build.library_id,
                revision=build.revision,
                audit_claim_token=str(due["audit_claim_token"]),
                item_count=0,
                reason_fact_count=0,
                reason_fingerprint="0" * 256,
                search_fact_count=0,
                search_fingerprint="0" * 256,
                now=datetime(2000, 1, 1, tzinfo=timezone.utc),
            )
        except BaseException as error:  # pragma: no cover - diagnostic capture
            errors.append(error)
        finally:
            finished.set()

    with isolatedPostgres._connect(live_projection_database.setup_url) as blocker:
        blocker.execute(
            "update ops.problematic_projection_state "
            "set audit_claimed_at = pg_catalog.clock_timestamp() "
            "- interval '4 minutes 59 seconds' where library_id = %s",
            (build.library_id,),
        )
        blocker.execute(
            "select 1 from ops.problematic_projection_state "
            "where library_id = %s for update",
            (build.library_id,),
        )
        thread = threading.Thread(target=complete, daemon=True)
        thread.start()
        time.sleep(1.5)
        assert not finished.is_set()
    thread.join(timeout=5)
    assert finished.is_set()
    assert errors == []

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        unchanged = connection.execute(
            "select audit_claim_token, verified "
            "from ops.problematic_projection_state where library_id = %s",
            (build.library_id,),
        ).fetchone()
    assert str(unchanged["audit_claim_token"]) == str(due["audit_claim_token"])
    assert unchanged["verified"] is True
    reclaimed = worker_repository.load_due_integrity_audit(
        now=datetime(2000, 1, 1, tzinfo=timezone.utc)
    )
    assert reclaimed is not None
    assert str(reclaimed["audit_claim_token"]) != str(due["audit_claim_token"])


@pytest.mark.parametrize("fact_count", (0, 101))
def test_repository_stage_claimed_reason_facts_rejects_invalid_batch_before_connecting(
    cursor_api,
    fact_count,
):
    repository, connections = _repository(cursor_api)
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)
    facts = tuple(
        SimpleNamespace(
            item_key="album-a",
            normalized_reason=f"reason-{index}",
            display_reason=f"Reason {index}",
            category_reason=f"Reason {index}",
        )
        for index in range(fact_count)
    )

    with pytest.raises(ValueError, match="reason fact batch"):
        repository.stage_claimed_reason_facts(
            claim=_claim(),
            build=build,
            group_key=("album", 100),
            facts=facts,
            now=_now(),
        )

    assert connections == []


def test_repository_iterates_staged_group_in_bounded_batches(cursor_api):
    repository, connections = _repository(
        cursor_api,
        ({"stage_id": 1, "payload": {"track": 1}}, {"stage_id": 2, "payload": {"track": 2}}),
        ({"stage_id": 3, "payload": {"track": 3}},),
    )
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)

    rows = list(repository.iter_claimed_source_group_rows(
        claim=_claim(), build=build, group_key=("album", 100),
        batch_limit=2, now=_now(),
    ))

    assert rows == [{"track": 1}, {"track": 2}, {"track": 3}]
    assert [call[1]["after_stage_id"] for call in connections[0].calls] == [0, 2]
    assert all(call[1]["limit"] == 2 for call in connections[0].calls)


def test_repository_writes_reads_and_retires_normalized_group_facts(cursor_api):
    repository, connections = _repository(
        cursor_api,
        ({"after_stage_id": 2, "next_batch_index": 0, "row_count": 2},),
        (
            {
                "stage_id": 1,
                "projection_id": "projection-a",
                "fact_kind": "track",
                "semantic_child_identity": "a.flac",
                "fact_value": {"path": "a.flac"},
            },
            {
                "stage_id": 2,
                "projection_id": "projection-a",
                "fact_kind": "track",
                "semantic_child_identity": "b.flac",
                "fact_value": {"path": "b.flac"},
            },
        ),
        (),
        ({"accepted": True},),
    )
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)

    checkpoint = repository.checkpoint_claimed_group_facts(
        claim=_claim(),
        build=build,
        group_key=("album", 100),
        expected_after_stage_id=0,
        entries=(
            (
                1,
                "track",
                {
                    "projection_id": "projection-a",
                    "semantic_child_identity": "a.flac",
                    "path": "a.flac",
                },
            ),
            (
                2,
                "track",
                {
                    "projection_id": "projection-a",
                    "semantic_child_identity": "b.flac",
                    "path": "b.flac",
                },
            ),
        ),
        next_batch_index=0,
        row_count=2,
        now=_now(),
    )
    facts = tuple(
        repository.iter_claimed_group_facts(
            claim=_claim(), build=build, group_key=("album", 100),
            after_stage_id=0, batch_limit=2, now=_now(),
        )
    )
    repository.complete_claimed_source_group(
        claim=_claim(), build=build, group_key=("album", 100),
        source_cursor=("album", 100, "file", 2), now=_now(),
    )

    assert checkpoint.after_stage_id == 2
    assert [fact[0] for fact in facts] == [1, 2]
    fact_read_params = connections[1].calls[0][1]
    assert fact_read_params["after_projection_id"] == ""
    assert fact_read_params["after_fact_kind"] == ""
    assert fact_read_params["after_semantic_child_identity"] == ""
    checkpoint_entries = json.loads(connections[0].calls[0][1]["entries"])
    assert checkpoint_entries[0]["projection_id"] == "projection-a"
    assert checkpoint_entries[0]["semantic_child_identity"] == "a.flac"
    sql = " ".join(call[0] for connection in connections for call in connection.calls)
    assert "ops.checkpoint_claimed_problematic_projection_group_facts" in sql
    assert "ops.load_claimed_problematic_projection_group_facts" in sql
    assert "ops.complete_claimed_problematic_projection_group" in sql


def test_repository_fact_checkpoint_preserves_incomplete_source_state(cursor_api):
    repository, _connections = _repository(
        cursor_api,
        (
            {
                "after_stage_id": 1,
                "next_batch_index": 0,
                "row_count": 1,
                "source_complete": False,
            },
        ),
    )
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)

    checkpoint = repository.checkpoint_claimed_group_facts(
        claim=_claim(),
        build=build,
        group_key=("album", 100),
        expected_after_stage_id=0,
        entries=(
            (
                1,
                "row",
                {
                    "projection_id": "projection-a",
                    "semantic_child_identity": "a.flac",
                },
            ),
        ),
        next_batch_index=0,
        row_count=1,
        now=_now(),
    )

    assert checkpoint.source_complete is False


def test_repository_publish_failure_and_cleanup_are_claim_scoped(cursor_api):
    repository, connections = _repository(
        cursor_api,
        ({"published": True},),
        ({"recorded": True},),
        ({"deleted_count": 9},),
    )
    build = cursor_api.ProblematicProjectionBuild(17, 12, 8, "rev", None)

    assert repository.publish_claimed_snapshot(claim=_claim(), build=build, now=_now())
    repository.record_claimed_terminal_failure(
        claim=_claim(), build=build, reason_code="projection_integrity", now=_now()
    )
    assert repository.cleanup_claimed_build(claim=_claim(), build=build, now=_now()) == 9

    assert "ops.publish_claimed_problematic_projection" in connections[0].calls[0][0]
    assert "ops.fail_claimed_problematic_projection" in connections[1].calls[0][0]
    cleanup_sql, cleanup_params = connections[2].calls[0]
    assert "ops.cleanup_claimed_problematic_projection" in cleanup_sql
    assert cleanup_params["job_id"] == 73
    assert cleanup_params["attempt"] == 2
    assert cleanup_params["revision"] == "rev"


def test_repository_integrity_page_and_completion_are_bounded(cursor_api):
    repository, connections = _repository(
        cursor_api,
        (
            {
                "fact_type": "reason",
                "item_key": "a",
                "normalized_reason": "missing cover",
                "display_reason": "Missing cover",
                "category_reason": "Missing cover",
                "fact_kind": None,
                "semantic_child_identity": None,
                "normalized_text": None,
            },
            {
                "fact_type": "search",
                "item_key": "b",
                "normalized_reason": None,
                "display_reason": None,
                "category_reason": None,
                "fact_kind": "track_title_search",
                "semantic_child_identity": "chunk-1",
                "normalized_text": "tail marker",
            },
        ),
        ({"matched": True, "replacement_enqueued": False},),
    )

    page = repository.read_integrity_page(
        library_id=17, revision="rev", after_fact_type="", after_item_key="",
        after_identity_one="", after_identity_two="", after_identity_three="",
        limit=100
    )
    result = repository.complete_integrity_audit(
        library_id=17, revision="rev", audit_claim_token="claim-1", item_count=2,
        reason_fact_count=2, reason_fingerprint="1" * 256,
        search_fact_count=1, search_fingerprint="0" * 256, now=_now(),
    )

    assert page == (
        {
            "fact_type": "reason",
            "item_key": "a",
            "normalized_reason": "missing cover",
            "display_reason": "Missing cover",
            "category_reason": "Missing cover",
            "fact_kind": None,
            "semantic_child_identity": None,
            "normalized_text": None,
        },
        {
            "fact_type": "search",
            "item_key": "b",
            "normalized_reason": None,
            "display_reason": None,
            "category_reason": None,
            "fact_kind": "track_title_search",
            "semantic_child_identity": "chunk-1",
            "normalized_text": "tail marker",
        },
    )
    assert result == {"matched": True, "replacement_enqueued": False}
    assert connections[0].calls[0][1]["limit"] == 100


def test_repository_loads_one_due_integrity_audit(cursor_api):
    due = {
        "library_id": 17,
        "revision": "rev-1",
        "audit_revision": None,
        "after_fact_type": None,
        "after_item_key": None,
        "after_identity_one": None,
        "after_identity_two": None,
        "item_count": 0,
        "last_counted_item_key": None,
        "reason_fact_count": 0,
        "reason_fingerprint": "0" * 256,
        "search_fact_count": 0,
        "search_fingerprint": "0" * 256,
        "audit_claim_token": "claim-1",
    }
    repository, connections = _repository(cursor_api, (due,))

    assert repository.load_due_integrity_audit(now=_now()) == due

    sql, params = connections[0].calls[0]
    assert "ops.load_due_problematic_projection_integrity_audit" in sql
    assert params == {"observed_at": _now()}


def test_repository_persists_bounded_integrity_progress(cursor_api):
    repository, connections = _repository(cursor_api, ({"advanced": True},))

    repository.persist_integrity_audit_progress(
        library_id=17,
        revision="rev-1",
        audit_claim_token="claim-1",
        expected_after_fact_type="",
        expected_after_item_key="",
        expected_after_identity_one="",
        expected_after_identity_two="",
        expected_after_identity_three="",
        expected_item_count=0,
        expected_reason_fact_count=0,
        expected_reason_fingerprint="0" * 256,
        expected_search_fact_count=0,
        expected_search_fingerprint="0" * 256,
        after_fact_type="reason",
        after_item_key="item-100",
        after_identity_one="missing_cover",
        after_identity_two="Missing cover",
        after_identity_three="Missing cover",
        item_count=100,
        last_counted_item_key="item-100",
        reason_fact_count=100,
        reason_fingerprint="1" * 256,
        search_fact_count=0,
        search_fingerprint="0" * 256,
        now=_now(),
    )

    sql, params = connections[0].calls[0]
    assert "ops.advance_problematic_projection_integrity_audit" in sql
    assert params["after_item_key"] == "item-100"
    assert params["audit_claim_token"] == "claim-1"
    assert params["expected_after_fact_type"] is None
    assert params["expected_after_item_key"] is None
    assert params["expected_item_count"] == 0
    assert params["expected_reason_fact_count"] == 0
    assert params["expected_reason_fingerprint"] == "0" * 256
    assert params["expected_search_fact_count"] == 0
    assert params["expected_search_fingerprint"] == "0" * 256
    assert params["after_fact_type"] == "reason"
    assert params["item_count"] == 100
    assert params["reason_fact_count"] == 100
    assert params["reason_fingerprint"] == "1" * 256
    assert params["search_fact_count"] == 0
    assert params["search_fingerprint"] == "0" * 256


def test_read_page_filters_before_limit_and_reports_exact_filtered_total(cursor_api):
    rows = (
        {
            "revision": UUID("00000000-0000-0000-0000-000000000016"),
            "committed_total": 9,
            "reason_facets": {"missing cover": 5, "empty audio": 4},
            "filtered_total": 2, "item_key": "item-a", "sort_title": "alpha",
            "sort_artist": "artist", "sort_year": "2001",
            "sort_album_key": "album-a", "summary": {"key": "item-a"},
        },
        {
            "revision": UUID("00000000-0000-0000-0000-000000000016"),
            "committed_total": 9,
            "reason_facets": {"missing cover": 5, "empty audio": 4},
            "filtered_total": 2, "item_key": "item-b", "sort_title": "beta",
            "sort_artist": "artist", "sort_year": "2002",
            "sort_album_key": "album-b", "summary": {"key": "item-b"},
        },
    )
    repository, connections = _repository(cursor_api, rows)

    page = repository.read_page(
        library_id=17, limit=1, query=" Alpha ",
        reasons=("Missing Cover",), sort="album",
    )

    assert page.revision == "00000000-0000-0000-0000-000000000016"
    assert page.total == 2
    assert page.reason_facets == {"missing cover": 5, "empty audio": 4}
    assert page.items == ({"key": "item-a"},)
    assert page.next_cursor
    sql, params = connections[0].calls[0]
    assert sql.index("filtered as") < sql.index("limit %(fetch_limit)s")
    assert "filtered as not materialized" in sql
    assert params["query"] == "alpha"
    assert params["reasons"] == ["missing cover"]
    assert params["fetch_limit"] == 2
    assert params["include_filtered_total"] is True
    normalized_sql = " ".join(sql.split())
    filtered_sql = normalized_sql.split(
        "filtered as not materialized (", 1
    )[1].split("), page as (", 1)[0]
    for fragment in (
        "from ops.problematic_projection_reason_facts reason_fact",
        "reason_fact.library_id = item.library_id",
        "reason_fact.revision = item.revision",
        "reason_fact.item_key = item.item_key",
        "reason_fact.normalized_reason = any (%(reasons)s::text[])",
    ):
        assert fragment in filtered_sql


@pytest.mark.parametrize("limit", [100, 101, 200])
def test_read_page_accepts_the_complete_route_limit_contract(cursor_api, limit):
    revision = UUID("00000000-0000-0000-0000-000000000013")
    repository, connections = _repository(cursor_api, ({
        "revision": revision,
        "committed_total": 0,
        "reason_facets": {},
        "filtered_total": 0,
        "item_key": None,
    },))

    page = repository.read_page(library_id=17, limit=limit)

    assert page.items == ()
    assert page.revision == str(revision)
    assert connections[0].calls[0][1]["fetch_limit"] == limit + 1


def test_read_page_continuation_carries_total_and_returns_typed_expiry(cursor_api):
    token = cursor_api.encode_problematic_projection_page_cursor(
        library_id=17, revision="00000000-0000-0000-0000-000000000111", query="alpha",
        reasons=("missing cover",), sort="album", total=2,
        anchor_item_key="item-a",
    )
    current_revision = UUID("00000000-0000-0000-0000-000000000014")
    repository, connections = _repository(
        cursor_api,
        ({"current_revision": current_revision, "cursor_expired": True},),
    )

    result = repository.read_page(
        library_id=17, limit=1, query="alpha", reasons=("missing cover",),
        sort="album", cursor=token,
    )

    assert result == cursor_api.ProblematicProjectionCursorExpired(
        requested_revision="00000000-0000-0000-0000-000000000111",
        current_revision=str(current_revision),
    )
    _sql, params = connections[0].calls[0]
    assert params["revision"] == "00000000-0000-0000-0000-000000000111"
    assert params["carried_total"] == 2
    assert params["include_filtered_total"] is False


def test_read_page_last_continuation_does_not_emit_another_cursor(cursor_api):
    revision = "00000000-0000-0000-0000-000000000017"
    token = cursor_api.encode_problematic_projection_page_cursor(
        library_id=17, revision=revision, query="", reasons=(), sort="album",
        total=2, anchor_item_key="item-a",
    )
    repository, _connections = _repository(
        cursor_api,
        ({
            "revision": UUID(revision), "committed_total": 2, "reason_facets": {},
            "filtered_total": 2, "item_key": "item-b", "sort_title": "beta",
            "sort_artist": "artist", "sort_year": "2002",
            "sort_album_key": "album-b", "summary": {"key": "item-b"},
        },),
    )

    page = repository.read_page(
        library_id=17, limit=1, sort="album", cursor=token
    )

    assert page.items == ({"key": "item-b"},)
    assert page.next_cursor is None


def test_read_page_long_sort_values_emit_compact_anchor_cursor(cursor_api):
    revision = UUID("00000000-0000-0000-0000-000000000117")
    long_title = "é" * 256
    repository, connections = _repository(
        cursor_api,
        (
            {
                "revision": revision,
                "committed_total": 2,
                "reason_facets": {},
                "filtered_total": 2,
                "item_key": "item-a",
                "sort_title": long_title,
                "sort_artist": long_title,
                "sort_year": "2026",
                "sort_album_key": long_title,
                "summary": {"key": "item-a", "name": "raw-" + ("x" * 5_000)},
            },
            {
                "revision": revision,
                "committed_total": 2,
                "reason_facets": {},
                "filtered_total": 2,
                "item_key": "item-b",
                "sort_title": long_title,
                "sort_artist": long_title,
                "sort_year": "2026",
                "sort_album_key": long_title,
                "summary": {"key": "item-b"},
            },
        ),
    )

    page = repository.read_page(library_id=17, limit=1)

    assert page.next_cursor is not None
    assert len(page.next_cursor) < 512
    decoded = cursor_api.decode_problematic_projection_page_cursor(
        page.next_cursor,
        library_id=17,
        revision=str(revision),
        query="",
        reasons=(),
        sort="album",
    )
    assert decoded.anchor_item_key == "item-a"
    sql, _params = connections[0].calls[0]
    assert "anchor as materialized" in sql
    assert "item.item_key = %(anchor_item_key)s" in sql


def test_read_page_missing_cursor_anchor_is_invalid_cursor(cursor_api):
    revision = "00000000-0000-0000-0000-000000000118"
    token = cursor_api.encode_problematic_projection_page_cursor(
        library_id=17,
        revision=revision,
        query="",
        reasons=(),
        sort="album",
        total=2,
        anchor_item_key="missing-anchor",
    )
    repository, _connections = _repository(
        cursor_api,
        (
            {
                "revision": UUID(revision),
                "committed_total": 2,
                "reason_facets": {},
                "filtered_total": 2,
                "anchor_missing": True,
            },
        ),
    )

    with pytest.raises(
        cursor_api.ProblematicProjectionCursorError,
        match="cursor anchor is missing",
    ):
        repository.read_page(
            library_id=17,
            limit=1,
            sort="album",
            cursor=token,
        )


def test_read_page_allows_a_cursor_to_finish_its_retained_predecessor_snapshot(
    cursor_api,
):
    retained_revision = "00000000-0000-0000-0000-000000000018"
    token = cursor_api.encode_problematic_projection_page_cursor(
        library_id=17,
        revision=retained_revision,
        query="",
        reasons=(),
        sort="album",
        total=2,
        anchor_item_key="item-a",
    )
    repository, connections = _repository(
        cursor_api,
        ({
            "revision": UUID(retained_revision),
            "committed_total": 2,
            "reason_facets": {"missing cover": 2},
            "cursor_expired": False,
            "current_revision": UUID("00000000-0000-0000-0000-000000000019"),
            "filtered_total": 2,
            "item_key": "item-b",
            "sort_title": "beta",
            "sort_artist": "artist",
            "sort_year": "2002",
            "sort_album_key": "album-b",
            "summary": {"key": "item-b"},
        },),
    )

    page = repository.read_page(
        library_id=17,
        limit=25,
        sort="album",
        cursor=token,
    )

    assert page.revision == retained_revision
    assert page.items == ({"key": "item-b"},)
    sql, params = connections[0].calls[0]
    assert params["revision"] == retained_revision
    assert "coalesce(%(revision)s, state.committed_revision)" in sql
    assert "projection_header.revision = coalesce(%(revision)s, state.committed_revision)" in sql
    assert "state.committed_revision <> coalesce" not in sql


def test_read_page_combines_query_and_any_reason_filters(cursor_api):
    repository, connections = _repository(
        cursor_api,
        ({
            "revision": UUID("00000000-0000-0000-0000-000000000020"),
            "committed_total": 0,
            "reason_facets": {},
            "filtered_total": 0,
        },),
    )

    repository.read_page(
        library_id=17, limit=25, query="neál morse",
        reasons=("missing cover", "empty audio"), sort="album",
    )

    sql, params = connections[0].calls[0]
    assert "search_text like" in sql
    normalized_sql = " ".join(sql.split())
    page_sql = normalized_sql.split("), page as (", 1)[1].split(
        ") select header.revision", 1
    )[0]
    for fragment in (
        "from ops.problematic_projection_reason_facts reason_fact",
        "reason_fact.library_id = candidate.library_id",
        "reason_fact.revision = candidate.revision",
        "reason_fact.item_key = candidate.item_key",
        "reason_fact.normalized_reason = any (%(reasons)s::text[])",
    ):
        assert fragment in page_sql
    assert params["query_pattern"] == "%neál morse%"
    assert params["reasons"] == ["empty audio", "missing cover"]


def test_read_page_search_materializes_trigram_candidates_before_keyset(
    cursor_api,
):
    sql = " ".join(cursor_api._read_page_sql().split())

    candidate_start = sql.index("search_candidates as materialized")
    candidate_end = sql.index("), filtered as", candidate_start)
    candidate_sql = sql[candidate_start:candidate_end]

    assert "search_text like %(query_pattern)s" in candidate_sql
    assert "sort_title" not in candidate_sql
    assert candidate_end < sql.index("order by candidate.sort_title")


def test_read_page_requires_verified_committed_header_integrity(cursor_api):
    sql = " ".join(cursor_api._read_page_sql().split())

    assert "join ops.problematic_projection_headers committed_header" in sql
    assert "committed_header.library_id = state.library_id" in sql
    assert "committed_header.revision = state.committed_revision" in sql
    assert "committed_header.verified" in sql
    assert "committed_header.total = state.committed_total" in sql
    assert "committed_header.item_count = committed_header.total" in sql
    assert "committed_header.reason_facets = state.reason_facets" in sql
    assert "committed_header.source_generation = state.source_generation" in sql
    assert "left join ops.problematic_projection_headers projection_header" in sql
    assert "projection_header.library_id = state.library_id" in sql
    assert (
        "projection_header.revision = "
        "coalesce(%(revision)s, state.committed_revision)"
    ) in sql
    assert "projection_header.verified" in sql
    assert "projection_header.item_count = projection_header.total" in sql


def test_claim_validity_uses_database_clock_after_lock_acquisition():
    from pathlib import Path

    sql = Path(
        "migrations/postgres/0128_create_problematic_files_projection.sql"
    ).read_text(encoding="utf-8")
    claim_function = sql.split(
        "create or replace function ops.problematic_projection_claim_valid", 1
    )[1].split("$$;", 1)[0]

    assert "job.lease_expires_at >= pg_catalog.clock_timestamp()" in claim_function
    assert "job.lease_expires_at >= p_observed_at" not in claim_function


def test_live_expired_claim_rejects_caller_clock_skew(live_projection_database):
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
        ProblematicProjectionIntegrityError,
    )
    from tests.e2e.support import isolatedPostgres

    repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    queued = repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="clock-skew-lease-test",
    )
    now = datetime.now(timezone.utc)
    claim = job_repository.claim(
        worker_id="clock-skew-worker",
        now=now,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == queued["job_id"]
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        connection.execute(
            "update ops.jobs set lease_expires_at = clock_timestamp() - interval '1 second' "
            "where id = %s",
            (claim.job_id,),
        )

    with pytest.raises(
        ProblematicProjectionIntegrityError,
        match="claimed projection build unavailable",
    ):
        worker_repository.prepare_claimed_build(
            claim=claim,
            now=now - timedelta(days=1),
        )


def test_live_invalidation_fences_committed_snapshot_and_deduplicates_rebuild(
    live_projection_database,
):
    from music_app.services.jobs.models import JobState, JobTransitionResult
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
        ProblematicProjectionIntegrityError,
    )
    from tests.e2e.support import isolatedPostgres

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    queued = app_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="generation-fence-publish",
    )
    now = datetime.now(timezone.utc)
    claim = job_repository.claim(
        worker_id="generation-fence-worker",
        now=now,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == queued["job_id"]
    build = worker_repository.prepare_claimed_build(claim=claim, now=now)
    assert worker_repository.publish_claimed_snapshot(
        claim=claim, build=build, now=now
    )
    assert job_repository.finish(
        claim,
        JobTransitionResult(JobState.SUCCEEDED, "generation_fence_published"),
        now=now,
    )
    assert app_repository.read_page(
        library_id=build.library_id, limit=1
    ).revision == build.revision

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        connection.execute(
            "select ops.invalidate_problematic_projection_library(%s)",
            (build.library_id,),
        )

    with pytest.raises(
        ProblematicProjectionIntegrityError,
        match="projection snapshot unavailable",
    ):
        app_repository.read_page(library_id=build.library_id, limit=1)
    first = app_repository.enqueue_rebuild(
        library_id=build.library_id,
        requested_by="projection-reader",
    )
    second = app_repository.enqueue_rebuild(
        library_id=build.library_id,
        requested_by="projection-reader",
    )
    assert first["created"] is True
    assert second == {**first, "created": False}


def test_live_claim_expiring_behind_state_lock_is_rejected(
    live_projection_database,
):
    import threading
    import time

    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    queued = repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="blocked-lock-lease-test",
    )
    now = datetime.now(timezone.utc)
    claim = job_repository.claim(
        worker_id="blocked-lock-worker",
        now=now,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None and claim.job_id == queued["job_id"]
    started = threading.Event()
    result: list[object] = []
    failures: list[BaseException] = []
    worker_pid: list[int] = []

    def prepare() -> None:
        try:
            with isolatedPostgres._connect(
                live_projection_database.worker_url
            ) as connection:
                worker_pid.append(
                    connection.execute("select pg_backend_pid() pid").fetchone()["pid"]
                )
                started.set()
                result.extend(
                    connection.execute(
                        "select * from ops.prepare_claimed_problematic_projection("
                        "%s, %s, %s, %s, %s)",
                        (
                            claim.job_id,
                            claim.attempt,
                            claim.worker_id,
                            claim.lease_token,
                            now - timedelta(days=1),
                        ),
                    ).fetchall()
                )
        except BaseException as error:
            failures.append(error)

    with isolatedPostgres._connect(live_projection_database.setup_url) as lock:
        lock.execute(
            "select 1 from ops.problematic_projection_state "
            "where library_id = %s for update",
            (live_projection_database.library_id,),
        )
        thread = threading.Thread(target=prepare, daemon=True)
        thread.start()
        assert started.wait(timeout=5)
        blocked = False
        with isolatedPostgres._connect(live_projection_database.setup_url) as inspect:
            for _ in range(100):
                blocked = inspect.execute(
                    "select %s = any(pg_blocking_pids(%s)) blocked",
                    (lock.execute("select pg_backend_pid() pid").fetchone()["pid"], worker_pid[0]),
                ).fetchone()["blocked"]
                if blocked:
                    break
                time.sleep(0.02)
            assert blocked, f"projection prepare never reached state lock: {failures!r}"
            inspect.execute(
                "update ops.jobs set lease_expires_at = clock_timestamp() - interval '1 second' "
                "where id = %s",
                (claim.job_id,),
            )
    thread.join(timeout=5)

    assert not thread.is_alive()
    assert failures == []
    assert result == []


def test_read_page_scopes_materialized_search_candidates_to_committed_snapshot(
    cursor_api,
):
    sql = " ".join(cursor_api._read_page_sql().split())
    candidate_start = sql.index("search_candidates as materialized")
    candidate_end = sql.index("), filtered as", candidate_start)
    candidate_sql = sql[candidate_start:candidate_end]

    assert "join header" in candidate_sql
    assert "item.library_id = %(library_id)s" in candidate_sql
    assert "item.revision = header.revision" in candidate_sql


def test_source_page_bounds_each_diagnostic_phase_before_hydration():
    from pathlib import Path

    migration = Path("migrations/postgres/0128_create_problematic_files_projection.sql")
    sql = " ".join(migration.read_text(encoding="utf-8").lower().split())
    source = sql.split(
        "create or replace function ops.load_claimed_problematic_projection_source",
        1,
    )[1].split("create or replace function", 1)[0]

    ordinary = source.index("ordinary_keys as materialized")
    row_projections = source.index("row_projections as materialized")
    ignored = source.index("ignored_repair_candidates as materialized")
    keys = source.index("source_keys as materialized")
    hydration = source.index("source_rows as materialized")
    assert ordinary < row_projections < ignored < keys < hydration

    row_projection_phase = source[
        row_projections : source.index("featured_artist_candidates as materialized")
    ]
    assert "from ops.problematic_projection_group_facts fact" in row_projection_phase
    assert "fact.fact_kind = 'row'" in row_projection_phase

    ignored_phase = source[
        ignored : source.index("duplicate_lookups as materialized", ignored)
    ]
    assert "join row_projections row_projection on true" in ignored_phase
    assert "join library.ignored_repairs ignored_repair" in ignored_phase
    assert "not exists (select 1 from ordinary_keys)" in ignored_phase
    assert "not exists (select 1 from featured_artist_candidates)" in ignored_phase
    assert (
        "state.child_kind is null or "
        "state.child_kind in ('file', 'featured_artist') or "
        "( state.child_kind = 'ignored_repair' and "
        "row_projection.projection_id || ':' || "
        "pg_catalog.lpad(ignored_repair.id::text, 20, '0') > "
        "state.child_identity )"
    ) in ignored_phase
    assert "order by child_identity" in ignored_phase
    assert "limit least(p_limit, p_child_limit, 100)" in ignored_phase

    pre_hydration = source[:hydration]
    source_keys = source[keys:hydration]
    source_rows = source[hydration:]
    classification_start = source.index("active_group as materialized")
    classification_end = source.index(
        "ordinary_candidates as materialized", classification_start
    )
    classification_phase = source[classification_start:classification_end]
    active_group_phase, selected_album_state = classification_phase.split(
        "selected_album_state as materialized", 1
    )
    assert selected_album_state.count("left join lateral") == 1
    missing_since_lateral = selected_album_state.split("left join lateral", 1)[
        1
    ].split(") missing_probe on true", 1)[0]
    assert "limit 1" in active_group_phase
    assert "min(stale_file.metadata #>> '{scan_cache,stale_marked_at}')" in (
        missing_since_lateral
    )
    assert "stale_track.album_id = album.id" in missing_since_lateral
    assert "stale_file.scan_cache_stale is true" in missing_since_lateral
    assert "limit least(p_limit, p_child_limit, 100)" in source_keys
    assert "from ignored_repair_candidates ignored" in source_rows
    assert "library.separate_releases" not in pre_hydration
    assert "library.exception_overrides" not in pre_hydration
    assert "ops.cover_lookup_tasks" not in pre_hydration
    pre_hydration_without_classification = (
        pre_hydration[:classification_start] + pre_hydration[classification_end:]
    )
    assert "left join lateral" not in pre_hydration_without_classification

    separate_release = source.index("library.separate_releases", hydration)
    assert separate_release > hydration
    separate_release_lateral = source[
        source.rindex("left join lateral", hydration, separate_release)
        : source.index(") separate_release_input on true", separate_release)
    ]
    assert "select exists" in separate_release_lateral
    assert "limit least(p_limit, p_child_limit, 100)" in separate_release_lateral


def test_source_model_matches_legacy_cross_album_duplicate_provenance():
    from pathlib import Path

    sql = " ".join(
        Path("migrations/postgres/0128_create_problematic_files_projection.sql")
        .read_text(encoding="utf-8")
        .lower()
        .split()
    )
    source = sql.split(
        "create or replace function ops.load_claimed_problematic_projection_source",
        1,
    )[1].split("create or replace function", 1)[0]

    assert "projection_owner_album_id" in source
    assert "physical_album_container" in source
    assert "companion_album" in source
    assert "duplicate_candidate" in source


def test_source_model_matches_canonical_missing_album_projection():
    from pathlib import Path

    sql = " ".join(
        Path("migrations/postgres/0128_create_problematic_files_projection.sql")
        .read_text(encoding="utf-8")
        .lower()
        .split()
    )
    source = sql.split(
        "create or replace function ops.load_claimed_problematic_projection_source",
        1,
    )[1].split("create or replace function", 1)[0]

    assert (
        "'inventory_status', case when source_keys.source_kind = 'missing_album' "
        "then 'missing' else null end"
    ) in source
    assert "'missing_since'" in source
    album_state = source.split(
        "selected_album_state as materialized (", 1
    )[1].split("), ordinary_candidates as materialized (", 1)[0]
    assert "select exists (" in album_state
    assert "active_file.scan_cache_stale is false" in album_state
    assert "not active_probe.has_active_file as all_files_stale" in album_state
    missing_probe = album_state.split("left join lateral (", 1)[1].split(
        ") missing_probe on true", 1
    )[0]
    assert (
        "min(stale_file.metadata #>> '{scan_cache,stale_marked_at}') "
        "as missing_since"
    ) in missing_probe
    assert "stale_file.scan_cache_stale is true" in missing_probe
    assert "order by stale_file.id" not in missing_probe
    assert "limit 1" not in missing_probe
    ordinary_candidates = source.split(
        "ordinary_candidates as materialized (", 1
    )[1].split("), ordinary_keys as materialized (", 1)[0]
    assert (
        "status.has_active_file and file.scan_cache_stale is false"
        in ordinary_candidates
    )
    assert (
        "status.all_files_stale and file.scan_cache_stale is true"
        in ordinary_candidates
    )
    assert "exception_type" in source


def test_source_model_preserves_cover_quota_and_duplicate_candidate_provenance():
    from pathlib import Path

    sql = " ".join(
        Path("migrations/postgres/0128_create_problematic_files_projection.sql")
        .read_text(encoding="utf-8")
        .lower()
        .split()
    )
    source = sql.split(
        "create or replace function ops.load_claimed_problematic_projection_source",
        1,
    )[1].split("create or replace function", 1)[0]

    for fragment in (
        "spotify_cover_quota_exceeded",
        "automatic_cover_provider_outcomes_v1",
        "search_spotify",
        "rate_limit_quota",
        "duplicate_candidate",
    ):
        assert fragment in source


def test_read_page_escapes_literal_like_wildcards(cursor_api):
    repository, connections = _repository(
        cursor_api,
        ({
            "revision": UUID("00000000-0000-0000-0000-000000000021"),
            "committed_total": 0,
            "reason_facets": {},
            "filtered_total": 0,
            "item_key": None,
        },),
    )

    repository.read_page(library_id=17, limit=25, query=r"50%_off\mix")

    sql, params = connections[0].calls[0]
    assert params["query_pattern"] == r"%50\%\_off\\mix%"
    assert "like %(query_pattern)s escape '\\'" in sql


def test_repository_wraps_connection_commit_failure(cursor_api):
    repository, _connections = _repository(
        cursor_api,
        ({"job_id": 91, "rebuild_epoch": 8, "created": True},),
        exit_error=RuntimeError("commit failed"),
    )

    with pytest.raises(cursor_api.ProblematicProjectionStorageError):
        repository.enqueue_rebuild(library_id=17, requested_by="test")


def test_repository_reclaims_at_most_one_abandoned_build(cursor_api):
    repository, connections = _repository(cursor_api, ({"reclaimed": True},))

    assert repository.reclaim_one_abandoned_build(now=_now()) is True

    sql, params = connections[0].calls[0]
    assert "ops.reclaim_one_abandoned_problematic_projection" in sql
    assert params == {"observed_at": _now()}


def test_source_completion_uses_uncapped_exists_for_later_companion_work():
    from pathlib import Path

    sql = " ".join(
        Path("migrations/postgres/0128_create_problematic_files_projection.sql")
        .read_text(encoding="utf-8")
        .lower()
        .split()
    )
    source = sql.split(
        "create or replace function ops.load_claimed_problematic_projection_source",
        1,
    )[1].split("create or replace function", 1)[0]
    completion = source.split("select result.group_kind", 1)[1]

    assert "from duplicate_lookups later" not in completion
    assert "from companion_candidates later" not in completion
    assert completion.count(
        "from ops.problematic_projection_group_facts later_lookup"
    ) >= 2
    assert "later_lookup.fact_kind = 'duplicate_lookup'" in completion
    assert "from library.local_track_files later_companion_file" in completion


def test_abandoned_terminal_build_atomically_coalesces_one_replacement():
    from pathlib import Path

    sql = " ".join(
        Path("migrations/postgres/0128_create_problematic_files_projection.sql")
        .read_text(encoding="utf-8")
        .lower()
        .split()
    )
    reclaim = sql.split(
        "create or replace function ops.reclaim_one_abandoned_problematic_projection",
        1,
    )[1].split("create or replace function", 1)[0]

    assert "for update of state skip locked" in reclaim
    assert "selected_job.state in ('succeeded', 'failed', 'canceled', 'ambiguous')" in reclaim
    assert "rebuild_epoch = projection_state.rebuild_epoch + 1" in reclaim
    assert reclaim.count("insert into ops.jobs(") == 1
    assert "recovery_reason_code = case" in reclaim
    parameters = reclaim.split("jsonb_build_object(", 1)[1].split(")", 1)[0]
    assert "reason" not in parameters
    assert "live_job_id = replacement_job_id" in reclaim


def test_source_page_plan_contract_uses_loader_owned_relation_and_cursor(cursor_api):
    from pathlib import Path

    migration = " ".join(
        Path("migrations/postgres/0128_create_problematic_files_projection.sql")
        .read_text(encoding="utf-8")
        .lower()
        .split()
    )
    loader = migration.split(
        "create or replace function ops.load_claimed_problematic_projection_source",
        1,
    )[1].split("create or replace function", 1)[0]
    assert hasattr(cursor_api, "_PROBLEMATIC_PROJECTION_SOURCE_RELATION")
    assert hasattr(cursor_api, "_source_page_plan_sql")
    relation = cursor_api._PROBLEMATIC_PROJECTION_SOURCE_RELATION
    plan_sql = " ".join(cursor_api._source_page_plan_sql().lower().split())

    assert relation == "ops.problematic_projection_source_rows"
    assert f"create or replace view {relation} as" in migration
    assert f"from {relation}" in loader
    assert f"from {relation}" in plan_sql
    assert "load_claimed_problematic_projection_source" not in plan_sql
    assert "function scan" not in plan_sql
    for cursor_name in (
        "group_kind",
        "group_identity",
        "source_kind",
        "source_identity",
        "child_kind",
        "child_identity",
    ):
        assert f"%({cursor_name})s" in plan_sql
    assert "%(library_id)s" in plan_sql
    assert "limit least(%(limit)s, 100)" in plan_sql


def test_explain_source_page_plans_shared_production_relation(cursor_api):
    with _live_plan_connection() as connection:
        library_id, _revision = _live_projection_identity(connection)
        fixture_counts = connection.execute(
            """
            select
              (select count(*) from library.local_albums
               where library_id = %(library_id)s) as albums,
              (select count(*) from library.local_tracks
               where library_id = %(library_id)s) as tracks,
              (select count(*)
               from library.local_track_files file
               join library.local_tracks track on track.id = file.track_id
               where track.library_id = %(library_id)s) as track_files
            """,
            {"library_id": library_id},
        ).fetchone()
        assert fixture_counts == {
            "albums": 706,
            "tracks": 7200,
            "track_files": 7200,
        }
        row = connection.execute(
            "explain (analyze, buffers, format json) "
            + cursor_api._source_page_plan_sql(),
            {
                "library_id": library_id,
                "group_kind": "",
                "group_identity": "",
                "source_kind": "",
                "source_identity": "",
                "child_kind": "",
                "child_identity": "",
                "limit": 100,
            },
        ).fetchone()
        plan = row["QUERY PLAN"][0]["Plan"]

    nodes = _plan_nodes(plan)
    assert not any(node.get("Node Type") == "Function Scan" for node in nodes), nodes
    assert int(plan["Actual Rows"]) <= 100
    assert any(
        node.get("Relation Name")
        in {
            "local_albums",
            "local_tracks",
            "local_track_files",
            "problematic_projection_state",
        }
        for node in nodes
    ), nodes


def test_projection_search_facts_are_relational_bounded_and_publication_owned(
    cursor_api,
):
    from pathlib import Path

    migration = " ".join(
        Path("migrations/postgres/0128_create_problematic_files_projection.sql")
        .read_text(encoding="utf-8")
        .lower()
        .split()
    )
    assert (
        "create table if not exists ops.problematic_projection_search_facts"
        in migration
    )
    assert (
        "create table if not exists "
        "ops.problematic_projection_search_fact_staging"
    ) in migration
    table = migration.split(
        "create table if not exists ops.problematic_projection_search_facts",
        1,
    )[1].split("create table", 1)[0]
    staging = migration.split(
        "create table if not exists ops.problematic_projection_search_fact_staging",
        1,
    )[1].split("create table", 1)[0]
    publish = migration.split(
        "create or replace function ops.publish_claimed_problematic_projection",
        1,
    )[1].split("create or replace function", 1)[0]
    read_sql = " ".join(cursor_api._read_page_sql().lower().split())

    assert "fact_kind text not null" in table
    assert "semantic_child_identity text not null" in table
    assert "normalized_text text not null" in table
    assert "octet_length(normalized_text) <= 32768" in table
    assert (
        "primary key (library_id, revision, item_key, fact_kind, "
        "semantic_child_identity)"
    ) in table
    assert "references ops.problematic_projection_items" in table
    assert "normalized_text" in staging
    assert "semantic_child_identity" in staging
    assert (
        "problematic_projection_search_facts_text_idx "
        "on ops.problematic_projection_search_facts using gin "
        "(normalized_text library.gin_trgm_ops)"
    ) in migration
    assert "insert into ops.problematic_projection_search_facts" in publish
    assert "from ops.problematic_projection_search_fact_staging" in publish
    assert "ops.problematic_projection_search_facts" in read_sql
    assert "search_fact.normalized_text like %(query_pattern)s" in read_sql


def test_read_page_search_matches_relational_tail_fact_omitted_from_summary(
    cursor_api,
    live_projection_database,
):
    from music_app.services.problematic_projection_integrity import (
        _fingerprint_text,
        _reason_fact_fingerprint,
        _search_fact_fingerprint,
    )
    from tests.e2e.support import isolatedPostgres

    library_id = live_projection_database.library_id
    revision = UUID("00000000-0000-0000-0000-000000000019")
    item_key = "relational-tail-item"
    needle = "relational-tail-title-needle"
    reason = "missing title"
    reason_fingerprint = _fingerprint_text(
        _reason_fact_fingerprint(item_key, reason, reason, reason)
    )
    search_fingerprint = _fingerprint_text(
        _search_fact_fingerprint(
            item_key,
            "track_title",
            "tail-title-identity",
            needle,
        )
    )
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        connection.execute(
            """
            insert into ops.problematic_projection_headers(
                library_id, revision, source_generation, rebuild_epoch,
                builder_version, total, item_count, reason_facets, verified,
                reason_fact_count, reason_fingerprint,
                search_fact_count, search_fingerprint, published_at
            ) values (
                %s, %s, 1, 1, 1, 1, 1,
                '{"missing title":1}'::jsonb, true, 1, %s::bit(256),
                1, %s::bit(256), now()
            )
            """,
            (library_id, revision, reason_fingerprint, search_fingerprint),
        )
        connection.execute(
            """
            insert into ops.problematic_projection_items(
                library_id, revision, item_key, sort_title, sort_artist,
                sort_year, sort_album_key, search_text, reasons, summary
            ) values (%s, %s, %s, 'relational tail', 'projection artist',
                      '2026', 'relational-tail-album', 'summary only',
                      array['missing title']::text[], %s::jsonb)
            """,
            (library_id, revision, item_key, json.dumps({"key": item_key})),
        )
        connection.execute(
            """
            insert into ops.problematic_projection_reason_facts(
                library_id, revision, item_key,
                normalized_reason, display_reason, category_reason
            ) values (%s, %s, %s, %s, %s, %s)
            """,
            (library_id, revision, item_key, reason, reason, reason),
        )
        updated_state = connection.execute(
            """
            update ops.problematic_projection_state
            set committed_revision = %s,
                committed_total = 1,
                reason_facets = '{"missing title":1}'::jsonb,
                verified = true
            where library_id = %s
            returning library_id
            """,
            (revision, library_id),
        ).fetchone()
        assert updated_state == {"library_id": library_id}
        summary_search_text = connection.execute(
            """
            select search_text
            from ops.problematic_projection_items
            where library_id = %s and revision = %s and item_key = %s
            """,
            (library_id, revision, item_key),
        ).fetchone()["search_text"]
        assert needle not in summary_search_text
        connection.execute(
            """
            insert into ops.problematic_projection_search_facts(
                library_id, revision, item_key, fact_kind,
                semantic_child_identity, normalized_text
            ) values (%s, %s, %s, 'track_title', %s, %s)
            """,
            (library_id, revision, item_key, "tail-title-identity", needle),
        )
        rows = connection.execute(
            cursor_api._read_page_sql(),
            _reader_plan_params(
                library_id=library_id,
                revision=revision,
                query=needle,
            ),
        ).fetchall()

    assert rows[0]["filtered_total"] == 1
    assert [row["item_key"] for row in rows if row["item_key"]] == [item_key]


def test_live_read_page_searches_nfkc_chunks_at_start_boundary_and_tail(
    live_projection_database,
):
    from music_app.services.problematic_files_projection import (
        _normalized_problematic_search_chunks,
        normalize_problematic_text,
    )
    from music_app.services.problematic_projection_integrity import (
        _fingerprint_text,
        _reason_fact_fingerprint,
        _search_fact_fingerprint,
    )
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    library_id = live_projection_database.library_id
    repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    revision = UUID("00000000-0000-0000-0000-000000000029")
    item_key = "nfkc-search-chunk-item"
    raw_title = "START-" + ("\ufdfa" * 2000) + "-TAIL"
    normalized_title = normalize_problematic_text(raw_title)
    chunks = _normalized_problematic_search_chunks(raw_title)
    boundary = len(chunks[0].encode("utf-8"))
    crossing_query = normalized_title.encode("utf-8")[
        boundary - 2048 : boundary + 2048
    ].decode("utf-8", errors="ignore")
    queries = (normalized_title[:6], crossing_query, normalized_title[-5:])
    reason = "missing title"
    reason_fingerprint = _fingerprint_text(
        _reason_fact_fingerprint(item_key, reason, reason, reason)
    )
    search_fingerprint = 0
    for chunk_index, chunk in enumerate(chunks):
        search_fingerprint ^= _search_fact_fingerprint(
            item_key,
            "track_title_search",
            f"nfkc-title-chunk-{chunk_index:04d}",
            chunk,
        )
    search_fingerprint_text = _fingerprint_text(search_fingerprint)

    assert len(chunks) > 1
    assert all(len(chunk.encode("utf-8")) <= 32_768 for chunk in chunks)
    assert all(len(query.encode("utf-8")) <= 4096 for query in queries)

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        connection.execute(
            """
            insert into ops.problematic_projection_headers(
              library_id, revision, source_generation, rebuild_epoch,
              builder_version, total, item_count, reason_facets, verified,
              reason_fact_count, reason_fingerprint,
              search_fact_count, search_fingerprint, published_at
            ) values (
              %s, %s, 1, 1, 1, 1, 1,
              '{"missing title":1}'::jsonb, true, 1, %s::bit(256),
              %s, %s::bit(256), now()
            )
            """,
            (
                library_id,
                revision,
                reason_fingerprint,
                len(chunks),
                search_fingerprint_text,
            ),
        )
        connection.execute(
            """
            insert into ops.problematic_projection_items(
              library_id, revision, item_key, sort_title, sort_artist,
              sort_year, sort_album_key, search_text, reasons, summary
            ) values (
              %s, %s, %s, 'nfkc chunks', 'projection artist',
              '2026', 'nfkc-chunk-album', 'summary only',
              array['missing title']::text[], %s::jsonb
            )
            """,
            (library_id, revision, item_key, json.dumps({"key": item_key})),
        )
        connection.execute(
            """
            insert into ops.problematic_projection_reason_facts(
              library_id, revision, item_key,
              normalized_reason, display_reason, category_reason
            ) values (%s, %s, %s, %s, %s, %s)
            """,
            (library_id, revision, item_key, reason, reason, reason),
        )
        for chunk_index, chunk in enumerate(chunks):
            connection.execute(
                """
                insert into ops.problematic_projection_search_facts(
                  library_id, revision, item_key, fact_kind,
                  semantic_child_identity, normalized_text
                ) values (%s, %s, %s, 'track_title_search', %s, %s)
                """,
                (
                    library_id,
                    revision,
                    item_key,
                    f"nfkc-title-chunk-{chunk_index:04d}",
                    chunk,
                ),
            )
        updated_state = connection.execute(
            """
            update ops.problematic_projection_state
            set committed_revision = %s,
                committed_total = 1,
                reason_facets = '{"missing title":1}'::jsonb,
                verified = true
            where library_id = %s
            returning library_id
            """,
            (revision, library_id),
        ).fetchone()
        assert updated_state == {"library_id": library_id}

    for query in queries:
        page = repository.read_page(
            library_id=library_id,
            limit=10,
            query=query,
            reasons=(),
            sort="album",
        )
        assert page.items == ({"key": item_key},)


def test_live_claimed_search_fact_pipeline_pages_replays_publishes_audits_and_indexes(
    live_projection_database,
):
    from types import SimpleNamespace

    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_files_projection import (
        ProblematicProjectionReasonFact,
        _normalized_problematic_search_chunks,
        normalize_problematic_text,
    )
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
    )
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    queued = app_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="search-fact-pipeline-test",
    )
    now = datetime.now(timezone.utc)
    claimed = job_repository.claim(
        worker_id="search-fact-pipeline-worker",
        now=now,
        lease_seconds=120,
    )
    assert claimed is not None and claimed.job_id == queued["job_id"]
    build = worker_repository.prepare_claimed_build(claim=claimed, now=now)
    group_key = ("album", 77001)
    source_cursor = ("album", 77001, "file", 1)
    worker_repository.stage_claimed_source_chunk(
        claim=claimed,
        build=build,
        group_key=group_key,
        source_cursor=source_cursor,
        rows=({"projection_id": "search-pipeline-item"},),
        complete=True,
        now=now,
    )
    item_key = "search-pipeline-item"
    worker_repository.stage_claimed_items(
        claim=claimed,
        build=build,
        group_key=group_key,
        items=(
            {
                "item_key": item_key,
                "sort_title": "search pipeline",
                "sort_artist": "owner",
                "sort_year": "2026",
                "sort_album_key": "search-pipeline",
                "search_text": "bounded summary",
                "reasons": ["Missing title"],
                "summary": {"key": item_key},
            },
        ),
        batch_index=0,
        now=now,
    )
    worker_repository.stage_claimed_reason_facts(
        claim=claimed,
        build=build,
        group_key=group_key,
        facts=(
            ProblematicProjectionReasonFact(
                item_key=item_key,
                normalized_reason="missing title",
                display_reason="Missing title",
                category_reason="Missing title",
            ),
        ),
        now=now,
    )

    raw_title = "START-" + ("\ufdfa" * 2000) + "-TAIL"
    normalized_title = normalize_problematic_text(raw_title)
    chunks = _normalized_problematic_search_chunks(raw_title)
    boundary = len(chunks[0].encode("utf-8"))
    crossing_query = normalized_title.encode("utf-8")[
        boundary - 2048 : boundary + 2048
    ].decode("utf-8", errors="ignore")
    search_facts = [
        (
            "track_title_search",
            f"actual-{index:020d}",
            chunk,
        )
        for index, chunk in enumerate(chunks)
    ]
    album_search_values = {
        "album_title_search": "album-start-" + ("\ufdfa" * 2_000) + "-album-tail",
        "album_artist_search": "artist-start-" + ("\ufdfa" * 2_000) + "-artist-tail",
        "album_key_search": "key-start-" + ("\ufdfa" * 2_000) + "-key-tail",
    }
    for fact_kind, raw_value in album_search_values.items():
        search_facts.extend(
            (
                fact_kind,
                f"{fact_kind}-{index:020d}",
                chunk,
            )
            for index, chunk in enumerate(
                _normalized_problematic_search_chunks(raw_value)
            )
        )
    search_facts.extend(
        (
            "private_path_search",
            f"filler-{index:020d}",
            f"filler normalized path {index:03d}",
        )
        for index in range(101)
    )
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        stage_row = connection.execute(
            """
            select stage_id
              from ops.problematic_projection_source_staging
             where job_id = %s and attempt = %s and revision = %s
               and group_kind = %s and group_identity = %s
             order by stage_id
             limit 1
            """,
            (
                claimed.job_id,
                claimed.attempt,
                build.revision,
                group_key[0],
                str(group_key[1]),
            ),
        ).fetchone()
        assert stage_row is not None
        for fact_kind, identity, normalized_text in search_facts:
            connection.execute(
                """
                insert into ops.problematic_projection_group_facts(
                    job_id, attempt, revision, group_kind, group_identity,
                    stage_id, projection_id, fact_kind,
                    semantic_child_identity, fact_value, created_at
                ) values (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    jsonb_build_object('normalized_text', %s::text), %s
                )
                """,
                (
                    claimed.job_id,
                    claimed.attempt,
                    build.revision,
                    group_key[0],
                    str(group_key[1]),
                    stage_row["stage_id"],
                    item_key,
                    fact_kind,
                    identity,
                    normalized_text,
                    now,
                ),
            )

    def stage_all():
        cursor = ("", "", "")
        counts = []
        while True:
            result = worker_repository.stage_claimed_search_facts(
                claim=claimed,
                build=build,
                group_key=group_key,
                after_projection_id=cursor[0],
                after_fact_kind=cursor[1],
                after_semantic_child_identity=cursor[2],
                limit=100,
                now=now,
            )
            cursor = result[:3]
            counts.append(result[3])
            if result[4]:
                return counts

    first_counts = stage_all()
    replay_counts = stage_all()
    assert len(first_counts) >= 2
    assert first_counts == replay_counts
    assert all(0 <= count <= 100 for count in first_counts)

    worker_repository.complete_claimed_source_group(
        claim=claimed,
        build=build,
        group_key=group_key,
        source_cursor=source_cursor,
        now=now,
    )
    assert worker_repository.publish_claimed_snapshot(
        claim=claimed,
        build=build,
        now=now,
    )
    album_tail_queries = tuple(
        normalize_problematic_text(value)[-12:]
        for value in album_search_values.values()
    )
    for query in (
        normalized_title[:6],
        crossing_query,
        normalized_title[-5:],
        *album_tail_queries,
    ):
        page = app_repository.read_page(
            library_id=build.library_id,
            limit=10,
            query=query,
            reasons=(),
            sort="album",
        )
        assert page.items == ({"key": item_key},)

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        assert connection.execute(
            """
            select count(*) as count
              from ops.problematic_projection_search_fact_staging
             where job_id = %s and attempt = %s and revision = %s
            """,
            (claimed.job_id, claimed.attempt, build.revision),
        ).fetchone()["count"] == 0
        assert connection.execute(
            """
            select count(*) as count
              from ops.problematic_projection_group_facts
             where job_id = %s and attempt = %s and revision = %s
            """,
            (claimed.job_id, claimed.attempt, build.revision),
        ).fetchone()["count"] == 0
        plan = _explain(
            connection,
            """
            select item_key
              from ops.problematic_projection_search_facts
            where normalized_text like %(pattern)s
            """,
            {"pattern": "%tail%"},
        )
        _assert_plan_uses_index(
            plan,
            "problematic_projection_search_facts_text_idx",
        )
        epoch_before = connection.execute(
            """
            update ops.problematic_projection_state
               set next_integrity_audit_at = %s - interval '1 second'
             where library_id = %s
            returning rebuild_epoch
            """,
            (now, build.library_id),
        ).fetchone()["rebuild_epoch"]
        connection.execute(
            """
            delete from ops.problematic_projection_search_facts
             where library_id = %s and revision = %s
               and fact_kind = 'track_title_search'
                  and normalized_text like '%%tail%%'
            """,
            (build.library_id, build.revision),
        )

    reconciler = ProblematicProjectionIntegrityReconciler(
        repository=worker_repository
    )
    for _ in range(10):
        assert reconciler.reconcile_due(now=now, limit=100) == 1
        with isolatedPostgres._connect(
            live_projection_database.setup_url
        ) as connection:
            state = connection.execute(
                """
                select rebuild_epoch, audit_claim_token
                  from ops.problematic_projection_state
                 where library_id = %s
                """,
                (build.library_id,),
            ).fetchone()
        if state["rebuild_epoch"] > epoch_before:
            break
    assert state["rebuild_epoch"] > epoch_before


def test_live_cursor_v3_publishes_long_metadata_and_pages_by_anchor(
    live_projection_database,
):
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_files_projection import (
        ProblematicProjectionReasonFact,
        _persisted_problematic_item,
    )
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
        ProblematicProjectionCursorError,
    )
    from tests.e2e.support import isolatedPostgres

    app_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    queued = app_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="cursor-v3-long-metadata-test",
    )
    now = datetime.now(timezone.utc)
    claimed = job_repository.claim(
        worker_id="cursor-v3-long-metadata-worker",
        now=now,
        lease_seconds=120,
    )
    assert claimed is not None and claimed.job_id == queued["job_id"]
    build = worker_repository.prepare_claimed_build(claim=claimed, now=now)
    assert build is not None
    group_key = ("album", 88001)
    source_cursor = ("album", 88001, "file", 1)
    long_title = "é" * 3_000
    long_artist = "Ж" * 5_000
    long_album_key = "key-" + ("한" * 4_500)
    first = _persisted_problematic_item(
        {
            "projection_id": "long-item-a",
            "name": long_title,
            "album_artist": long_artist,
            "year": "2026",
            "key": long_album_key,
            "problem_reasons": ["Missing cover art"],
        }
    )
    second = _persisted_problematic_item(
        {
            "projection_id": "long-item-b",
            "name": long_title + "z",
            "album_artist": long_artist,
            "year": "2026",
            "key": long_album_key + "z",
            "problem_reasons": ["Missing cover art"],
        }
    )
    worker_repository.stage_claimed_source_chunk(
        claim=claimed,
        build=build,
        group_key=group_key,
        source_cursor=source_cursor,
        rows=({"projection_id": first["item_key"]},),
        complete=True,
        now=now,
    )
    worker_repository.stage_claimed_items(
        claim=claimed,
        build=build,
        group_key=group_key,
        items=(first, second),
        batch_index=0,
        now=now,
    )
    worker_repository.stage_claimed_reason_facts(
        claim=claimed,
        build=build,
        group_key=group_key,
        facts=tuple(
            ProblematicProjectionReasonFact(
                item_key=item["item_key"],
                normalized_reason="missing cover art",
                display_reason="Missing cover art",
                category_reason="Missing cover art",
            )
            for item in (first, second)
        ),
        now=now,
    )
    worker_repository.complete_claimed_source_group(
        claim=claimed,
        build=build,
        group_key=group_key,
        source_cursor=source_cursor,
        now=now,
    )
    worker_repository.publish_claimed_snapshot(claim=claimed, build=build, now=now)

    first_page = app_repository.read_page(
        library_id=build.library_id,
        limit=1,
    )
    assert first_page.next_cursor is not None
    assert len(first_page.next_cursor) < 512
    assert first_page.items[0]["name"] == long_title
    assert first_page.items[0]["album_artist"] == long_artist
    assert first_page.items[0]["key"] == long_album_key
    second_page = app_repository.read_page(
        library_id=build.library_id,
        limit=1,
        cursor=first_page.next_cursor,
    )
    assert second_page.items == (second["summary"],)

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        connection.execute(
            "delete from ops.problematic_projection_items "
            "where library_id = %s and revision = %s and item_key = %s",
            (build.library_id, build.revision, first["item_key"]),
        )
    with pytest.raises(ProblematicProjectionCursorError):
        app_repository.read_page(
            library_id=build.library_id,
            limit=1,
            cursor=first_page.next_cursor,
        )


def test_explain_stage_publication_uses_claim_scoped_staging_index():
    revision = UUID("00000000-0000-0000-0000-000000000001")
    publication_queries = (
        """
        select count(*)
        from ops.problematic_projection_item_staging
        where job_id = %s and attempt = %s and revision = %s
        """,
        """
        select reason, count(*)
        from ops.problematic_projection_item_staging staged,
             unnest(staged.reasons) reason
        where staged.job_id = %s and staged.attempt = %s
          and staged.revision = %s
        group by reason
        """,
        """
        select item_key, sort_title, sort_artist, sort_year, sort_album_key,
               search_text, reasons, summary
        from ops.problematic_projection_item_staging
        where job_id = %s and attempt = %s and revision = %s
        order by item_key
        """,
    )
    with _live_plan_connection() as connection:
        plans = tuple(
            _explain(connection, query, (73, 2, revision))
            for query in publication_queries
        )

    for plan in plans:
        _assert_plan_uses_index(
            plan,
            "problematic_projection_item_staging_pkey",
        )
        _assert_no_sequential_scan(
            plan,
            {"problematic_projection_item_staging"},
        )


def test_explain_unfiltered_keyset_uses_album_sort_projection_index(
    cursor_api,
    live_reader_plan_database,
):
    connection, library_id, revision = live_reader_plan_database
    plan = _explain(
        connection,
        cursor_api._read_page_sql(),
        _reader_plan_params(library_id=library_id, revision=revision),
    )

    _assert_plan_uses_index(plan, "problematic_projection_items_album_sort_idx")
    _assert_reader_plan_is_projection_only(plan)


def test_explain_integrity_keyset_uses_c_collated_fact_indexes(
    live_reader_plan_database,
):
    connection, library_id, revision = live_reader_plan_database
    connection.execute(
        """
        insert into ops.problematic_projection_reason_facts(
            library_id, revision, item_key,
            normalized_reason, display_reason, category_reason
        )
        select %s, %s, item.item_key, 'other', 'Other', 'Other'
        from ops.problematic_projection_items item
        where item.library_id = %s and item.revision = %s
        on conflict do nothing
        """,
        (library_id, revision, library_id, revision),
    )
    connection.execute(
        """
        insert into ops.problematic_projection_search_facts(
            library_id, revision, item_key,
            fact_kind, semantic_child_identity, normalized_text
        )
        select %s, %s, item.item_key, 'track_title_search', item.item_key,
               item.search_text
        from ops.problematic_projection_items item
        where item.library_id = %s and item.revision = %s
        on conflict do nothing
        """,
        (library_id, revision, library_id, revision),
    )
    connection.execute("analyze ops.problematic_projection_reason_facts")
    connection.execute("analyze ops.problematic_projection_search_facts")
    plan = _explain(
        connection,
        """
        with reason_facts as (
          select 'reason'::text as fact_type, reason_fact.item_key,
            reason_fact.normalized_reason as identity_one,
            reason_fact.display_reason as identity_two,
            reason_fact.category_reason as identity_three
          from ops.problematic_projection_reason_facts reason_fact
          where reason_fact.library_id = %s and reason_fact.revision = %s
            and (
              'reason'::text collate "C" > %s collate "C"
              or (
                'reason'::text collate "C" = %s collate "C"
                and (
                  reason_fact.item_key collate "C",
                  reason_fact.normalized_reason collate "C",
                  reason_fact.display_reason collate "C",
                  reason_fact.category_reason collate "C"
                ) > (
                  %s collate "C", %s collate "C", %s collate "C", %s collate "C"
                )
              )
            )
          order by reason_fact.item_key collate "C",
            reason_fact.normalized_reason collate "C",
            reason_fact.display_reason collate "C",
            reason_fact.category_reason collate "C"
          limit 100
        ), search_facts as (
          select 'search'::text as fact_type, search_fact.item_key,
            search_fact.fact_kind as identity_one,
            search_fact.semantic_child_identity as identity_two,
            ''::text as identity_three
          from ops.problematic_projection_search_facts search_fact
          where search_fact.library_id = %s and search_fact.revision = %s
            and (
              'search'::text collate "C" > %s collate "C"
              or (
                'search'::text collate "C" = %s collate "C"
                and (
                  search_fact.item_key collate "C",
                  search_fact.fact_kind collate "C",
                  search_fact.semantic_child_identity collate "C",
                  ''::text collate "C"
                ) > (
                  %s collate "C", %s collate "C", %s collate "C", %s collate "C"
                )
              )
            )
          order by search_fact.item_key collate "C",
            search_fact.fact_kind collate "C",
            search_fact.semantic_child_identity collate "C"
          limit 100
        ), integrity_facts as (
          select * from reason_facts
          union all
          select * from search_facts
        )
        select fact_type, item_key, identity_one, identity_two, identity_three
        from integrity_facts
        order by fact_type collate "C", item_key collate "C",
          identity_one collate "C", identity_two collate "C",
          identity_three collate "C"
        limit 100
        """,
        (
            library_id,
            revision,
            "reason",
            "reason",
            "",
            "",
            "",
            "",
            library_id,
            revision,
            "reason",
            "reason",
            "",
            "",
            "",
            "",
        ),
    )

    _assert_plan_uses_index(
        plan, "problematic_projection_reason_facts_integrity_idx"
    )
    _assert_plan_uses_index(
        plan, "problematic_projection_search_facts_integrity_idx"
    )


def test_repository_integrity_page_uses_the_generic_fact_cursor(cursor_api):
    expected_rows = (
        {
            "fact_type": "reason",
            "item_key": "item-a",
            "normalized_reason": "empty audio",
            "display_reason": "Empty audio",
            "category_reason": "Empty audio",
            "fact_kind": None,
            "semantic_child_identity": None,
            "normalized_text": None,
        },
    )
    repository, connections = _repository(cursor_api, expected_rows)

    rows = repository.read_integrity_page(
        library_id=17,
        revision="rev",
        after_fact_type="reason",
        after_item_key="item-a",
        after_identity_one="before-normalized",
        after_identity_two="Before display",
        after_identity_three="Before category",
        limit=100,
    )

    assert rows == expected_rows
    sql, params = connections[0].calls[0]
    assert "ops.load_problematic_projection_integrity_page" in sql
    assert params == {
        "library_id": 17,
        "revision": "rev",
        "after_fact_type": "reason",
        "after_item_key": "item-a",
        "after_identity_one": "before-normalized",
        "after_identity_two": "Before display",
            "after_identity_three": "Before category",
        "limit": 100,
    }


def test_repository_persists_the_whole_integrity_fact_cursor(cursor_api):
    repository, connections = _repository(cursor_api, ({"advanced": True},))

    repository.persist_integrity_audit_progress(
        library_id=17,
        revision="rev",
        audit_claim_token="claim",
        expected_after_fact_type="reason",
        expected_after_item_key="item-a",
        expected_after_identity_one="before-normalized",
        expected_after_identity_two="Before display",
        expected_after_identity_three="Before category",
        expected_item_count=4,
        expected_reason_fact_count=7,
        expected_reason_fingerprint="0" * 256,
        expected_search_fact_count=0,
        expected_search_fingerprint="0" * 256,
        after_fact_type="reason",
        after_item_key="item-b",
        after_identity_one="missing cover",
        after_identity_two="Missing cover",
        after_identity_three="Missing cover",
        item_count=5,
        last_counted_item_key="item-b",
        reason_fact_count=8,
        reason_fingerprint="1" * 256,
        search_fact_count=0,
        search_fingerprint="0" * 256,
        now=_now(),
    )

    sql, params = connections[0].calls[0]
    assert "ops.advance_problematic_projection_integrity_audit" in sql
    assert params["expected_after_fact_type"] == "reason"
    assert params["expected_after_identity_one"] == "before-normalized"
    assert params["expected_after_identity_two"] == "Before display"
    assert params["expected_after_identity_three"] == "Before category"
    assert params["expected_reason_fact_count"] == 7
    assert params["expected_reason_fingerprint"] == "0" * 256
    assert params["after_fact_type"] == "reason"
    assert params["after_identity_one"] == "missing cover"
    assert params["after_identity_two"] == "Missing cover"
    assert params["after_identity_three"] == "Missing cover"
    assert params["last_counted_item_key"] == "item-b"
    assert params["reason_fact_count"] == 8
    assert params["reason_fingerprint"] == "1" * 256


@pytest.mark.parametrize(
    ("corruption", "replacement_expected"),
    (
        ("delete", True),
        ("insert", True),
        ("change", True),
        ("normalized_only", True),
        ("ownership_change", True),
        ("unchanged", False),
    ),
)
def test_live_integrity_audit_uses_exact_reason_facts_and_enqueues_once(
    live_projection_database,
    corruption,
    replacement_expected,
):
    from music_app.services.problematic_projection_integrity import (
        ProblematicProjectionIntegrityReconciler,
        _fingerprint_text,
        _reason_fact_fingerprint,
    )
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    revision = UUID(
        {
            "delete": "00000000-0000-0000-0000-000000000051",
            "insert": "00000000-0000-0000-0000-000000000052",
            "change": "00000000-0000-0000-0000-000000000053",
            "normalized_only": "00000000-0000-0000-0000-000000000054",
            "ownership_change": "00000000-0000-0000-0000-000000000055",
            "unchanged": "00000000-0000-0000-0000-000000000056",
        }[corruption]
    )
    item_key = f"integrity-{corruption}-item"
    ownership_item_key = f"{item_key}-new-owner"
    reason_fingerprint = _fingerprint_text(
        _reason_fact_fingerprint(
            item_key, "missing cover", "Missing cover", "Missing cover"
        )
    )
    observed_at = datetime.now(timezone.utc)
    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        connection.execute(
            """
            insert into ops.problematic_projection_headers(
                library_id, revision, source_generation, rebuild_epoch,
                builder_version, total, item_count, reason_facets,
                reason_fact_count, reason_fingerprint,
                search_fact_count, search_fingerprint, verified, published_at
            ) values (%s, %s, 1, 1, 1, 1, 1,
                '{"Missing cover":1}'::jsonb, 1, %s::bit(256),
                0, 0::bit(256), true, %s)
            """,
            (
                live_projection_database.library_id,
                revision,
                reason_fingerprint,
                observed_at,
            ),
        )
        connection.execute(
            """
            insert into ops.problematic_projection_items(
                library_id, revision, item_key, sort_title, sort_artist,
                sort_year, sort_album_key, search_text, reasons, summary
            ) values (%s, %s, %s, 'integrity', 'artist', '2026',
                      'integrity-album', 'integrity',
                      array['Missing cover']::text[], '{"issue_count":1}'::jsonb)
            """,
            (live_projection_database.library_id, revision, item_key),
        )
        connection.execute(
            """
            insert into ops.problematic_projection_reason_facts(
                library_id, revision, item_key,
                normalized_reason, display_reason, category_reason
            ) values (
                %s, %s, %s, 'missing cover', 'Missing cover', 'Missing cover'
            )
            """,
            (live_projection_database.library_id, revision, item_key),
        )
        if corruption == "ownership_change":
            connection.execute(
                """
                insert into ops.problematic_projection_items(
                    library_id, revision, item_key, sort_title, sort_artist,
                    sort_year, sort_album_key, search_text, reasons, summary
                ) values (%s, %s, %s, 'integrity owner', 'artist', '2026',
                    'integrity-album-owner', 'integrity owner',
                    array[]::text[], '{"issue_count":0}'::jsonb)
                """,
                (
                    live_projection_database.library_id,
                    revision,
                    ownership_item_key,
                ),
            )
        state = connection.execute(
            """
            update ops.problematic_projection_state
            set committed_revision = %s,
                committed_total = 1,
                reason_facets = '{"Missing cover":1}'::jsonb,
                verified = true,
                live_job_id = null,
                build_revision = null,
                requested_job_id = null,
                requested_attempt = null,
                requested_revision = null,
                audit_revision = null,
                audit_after_item_key = null,
                audit_item_count = 0,
                audit_reason_fact_count = 0,
                    audit_reason_fingerprint = 0::bit(256),
                audit_claim_token = null,
                audit_claimed_at = null,
                next_integrity_audit_at = %s - interval '1 second'
            where library_id = %s
            returning rebuild_epoch
            """,
            (revision, observed_at, live_projection_database.library_id),
        ).fetchone()
        assert state is not None
        starting_epoch = state["rebuild_epoch"]
        if corruption == "delete":
            connection.execute(
                """
                delete from ops.problematic_projection_reason_facts
                where library_id = %s and revision = %s and item_key = %s
                """,
                (live_projection_database.library_id, revision, item_key),
            )
        elif corruption == "insert":
            connection.execute(
                """
                insert into ops.problematic_projection_reason_facts(
                    library_id, revision, item_key,
                    normalized_reason, display_reason, category_reason
                ) values (
                    %s, %s, %s, 'unexpected', 'Unexpected', 'Unexpected'
                )
                """,
                (live_projection_database.library_id, revision, item_key),
            )
        elif corruption == "change":
            connection.execute(
                """
                update ops.problematic_projection_reason_facts
                set normalized_reason = 'wrong', display_reason = 'Wrong'
                where library_id = %s and revision = %s and item_key = %s
                """,
                (live_projection_database.library_id, revision, item_key),
            )
        elif corruption == "normalized_only":
            connection.execute(
                """
                update ops.problematic_projection_reason_facts
                set normalized_reason = 'wrong'
                where library_id = %s and revision = %s and item_key = %s
                """,
                (live_projection_database.library_id, revision, item_key),
            )
        elif corruption == "ownership_change":
            connection.execute(
                """
                update ops.problematic_projection_reason_facts
                set item_key = %s
                where library_id = %s and revision = %s and item_key = %s
                """,
                (
                    ownership_item_key,
                    live_projection_database.library_id,
                    revision,
                    item_key,
                ),
            )
    reconciler = ProblematicProjectionIntegrityReconciler(
        repository=PostgresProblematicProjectionRepository(
            database_url=live_projection_database.worker_url
        )
    )
    assert reconciler.reconcile_due(now=observed_at, limit=100) == 1

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        result = connection.execute(
            """
            select rebuild_epoch, live_job_id, audit_claim_token,
                   next_integrity_audit_at
            from ops.problematic_projection_state
            where library_id = %s
            """,
            (live_projection_database.library_id,),
        ).fetchone()
        jobs = connection.execute(
            """
            select count(*)::integer as count
            from ops.jobs
            where kind = 'problematic_files_projection'
              and library_id = %s
              and parameters ->> 'rebuild_epoch' = %s
            """,
            (
                live_projection_database.library_id,
                str(starting_epoch + 1),
            ),
        ).fetchone()["count"]

    assert result is not None
    assert result["audit_claim_token"] is None
    if replacement_expected:
        assert result["rebuild_epoch"] == starting_epoch + 1
        assert result["live_job_id"] is not None
        assert jobs == 1
    else:
        assert result["rebuild_epoch"] == starting_epoch
        assert result["live_job_id"] is None
        assert result["next_integrity_audit_at"] > observed_at
        assert jobs == 0


def test_live_terminal_failure_before_prepare_enqueues_replacement(
    live_projection_database,
):
    from music_app.services.jobs.models import JobState, JobTransitionResult
    from music_app.services.jobs.repository_postgres import PostgresJobRepository
    from music_app.services.problematic_projection_postgres import (
        PostgresProblematicProjectionRepository,
    )
    from tests.e2e.support import isolatedPostgres

    projection_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.app_url
    )
    enqueued = projection_repository.enqueue_rebuild(
        library_id=live_projection_database.library_id,
        requested_by="prepare-failure-test",
    )
    now = datetime.now(timezone.utc)
    job_repository = PostgresJobRepository(
        database_url=live_projection_database.worker_url
    )
    claim = job_repository.claim(
        worker_id="prepare-failure-worker",
        now=now,
        lease_seconds=60,
        kinds=("problematic_files_projection",),
    )
    assert claim is not None
    for attempt in (1, 2):
        assert claim.attempt == attempt
        retry_at = now + timedelta(seconds=attempt)
        assert job_repository.finish(
            claim,
            JobTransitionResult(
                JobState.RETRY_WAIT,
                "prepare_failed",
                scheduled_at=retry_at,
            ),
            now=retry_at - timedelta(milliseconds=100),
        )
        claim = job_repository.claim(
            worker_id="prepare-failure-worker",
            now=retry_at,
            lease_seconds=60,
            kinds=("problematic_files_projection",),
        )
        assert claim is not None
    assert claim.attempt == 3

    worker_repository = PostgresProblematicProjectionRepository(
        database_url=live_projection_database.worker_url
    )
    worker_repository.record_claimed_terminal_failure(
        claim=claim,
        build=None,
        reason_code="problematic_projection_integrity_failed",
        now=now + timedelta(seconds=3),
    )

    with isolatedPostgres._connect(live_projection_database.setup_url) as connection:
        state = connection.execute(
            """
            select rebuild_epoch, live_job_id, requested_job_id,
                   requested_attempt, build_revision, requested_revision
            from ops.problematic_projection_state
            where library_id = %s
            """,
            (live_projection_database.library_id,),
        ).fetchone()
    assert state is not None
    assert state["rebuild_epoch"] == enqueued["rebuild_epoch"] + 1
    assert state["live_job_id"] == state["requested_job_id"]
    assert state["live_job_id"] != claim.job_id
    assert state["requested_attempt"] is None
    assert state["build_revision"] is None
    assert state["requested_revision"] is None


def test_explain_reason_filter_uses_reason_projection_index(
    cursor_api,
    live_reader_plan_database,
):
    connection, library_id, revision = live_reader_plan_database
    plan = _explain(
        connection,
        cursor_api._read_page_sql(),
        _reader_plan_params(
            library_id=library_id,
            revision=revision,
            reasons=("missing cover",),
        ),
    )

    _assert_plan_uses_index(plan, "problematic_projection_items_reasons_idx")
    _assert_reader_plan_is_projection_only(plan)


def test_explain_search_filter_uses_search_projection_index(
    cursor_api,
    live_reader_plan_database,
):
    connection, library_id, revision = live_reader_plan_database
    plan = _explain(
        connection,
        cursor_api._read_page_sql(),
        _reader_plan_params(
            library_id=library_id,
            revision=revision,
            query="premiere",
        ),
    )

    _assert_plan_uses_index(plan, "problematic_projection_items_search_idx")
    _assert_reader_plan_is_projection_only(plan)


def test_explain_continuation_uses_album_sort_projection_index(
    cursor_api,
    live_reader_plan_database,
):
    connection, library_id, revision = live_reader_plan_database
    plan = _explain(
        connection,
        cursor_api._read_page_sql(),
        _reader_plan_params(
            library_id=library_id,
            revision=revision,
        anchor_item_key="plan-item-005000",
        ),
    )

    _assert_plan_uses_index(plan, "problematic_projection_items_album_sort_idx")
    _assert_reader_plan_is_projection_only(plan)
