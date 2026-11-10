"""Independent ordered-cover metadata contract and opt-in real PostgreSQL checks.

The SQL fixture never discovers an app database. Set
ALBUM_HAVEN_ORDERED_COVER_TEST_DATABASE to a JSON object with exactly host, port,
dbname, user and password for an explicitly provisioned EMPTY loopback database.
The database name must be pytest_ordered_cover_<16-32 lowercase hex digits>.
All test DDL and rows are rolled back; provisioning/drop belongs to the caller.
A missing target skips integration only, and is not PostgreSQL qualification.
"""
from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import re

import pytest

from music_app.services.ordered_cover_references import project_selected_cover_metadata


MIGRATION = (Path(__file__).resolve().parents[2] / "migrations" / "postgres"
             / "0104_add_ordered_cover_metadata_constraint.sql")
TARGET_ENV = "ALBUM_HAVEN_ORDERED_COVER_TEST_DATABASE"
UUID_TEXT = "2cfe2385-c225-4501-9a71-3d7fc286b3d1"
RECEIPT = {"mutation_id": UUID_TEXT, "request_hash": "a1" * 32}


def local(key="local", path="/synthetic/offline/Front.jpg"):
    return {"selection_id": key, "kind": "local", "path": path}


def remote(key="remote", url="https://covers.invalid/Front.jpg?Key=A"):
    return {"selection_id": key, "kind": "remote", "url": url}


def selected(*items, revision=0, **extra):
    return {"selected_covers": list(items), "selected_covers_revision": revision, **extra}


UUID_VARIANTS = [
    UUID_TEXT, UUID_TEXT.upper(), UUID_TEXT.replace("-", ""),
    "{" + UUID_TEXT + "}", "urn:uuid:" + UUID_TEXT,
    "{{" + UUID_TEXT + "}}", "2-cfe2385c22545019a713d7fc286b3d1",
    "٠" * 32,
]
LEGACY_CASES = [
    None, False, 0, "selected_covers", [], ["selected_covers"], {},
    {"selected_covers_revision": -4, "selected_covers_last_request": "orphan"},
    {"cover_selection_origin": "user", "selected_cover_path": "/old/front.jpg"},
    {"cover_selection_origin": "inherited", "remote_cover_url": "https://old.invalid/a"},
]
VALID_CASES = [
    selected(local()),
    selected(remote(), local(), local("windows", r"Z:\Offline\Back.jpg"), revision=17),
    selected(local("日本語 😀", "/音楽/前面.jpg"), unrelated={"keep": [1, None]}),
    selected(local(path="/folder//./Front.jpg")),
    selected(local(path=r"\\server\share\Front.jpg")),
    selected(remote(url="HTTPS://Covers.Invalid:00443/Front.JPG?Key=AbC&x=%2F")),
    selected(remote(url="https://[::1]:443/Front.jpg")),
    selected(remote(url="https://straße.invalid/Front.jpg")),
    selected({**remote(), "source_label": " Label with spaces ", "source": "",
              "art_label": "日本語\u0085", "candidate_id": "", "art_kind": "other",
              "thumbnail_url": "", "album_url": "https://albums.invalid/a",
              "width": 0, "height": 2 ** 80, "candidate_generation": 0}),
    selected(local(), revision=2 ** 80, selected_covers_last_request=RECEIPT),
    selected(local("a", "/Front.jpg"), local("b", "/front.jpg")),
    selected(remote("a", "https://covers.invalid/A"), remote("b", "https://covers.invalid/a")),
    selected(remote("a", "https://covers.invalid/a?X=A"), remote("b", "https://covers.invalid/a?X=a")),
] + [selected({**remote(), "candidate_generation": value},
              selected_covers_last_request={**RECEIPT, "mutation_id": value})
     for value in UUID_VARIANTS]

INVALID_CASES = []


def invalid(name, value):
    INVALID_CASES.append(pytest.param(value, id=name))


for index, value in enumerate([None, {}, "a", [], [local()] * 4, [None], ["a"]]):
    invalid(f"set-shape-{index}", {"selected_covers": value, "selected_covers_revision": 0})
invalid("revision-missing", {"selected_covers": [local()]})
for index, value in enumerate([None, True, False, -1, 1.0, "1", [], {}]):
    invalid(f"revision-{index}", selected(local(), revision=value))
for index, value in enumerate([None, "", " ", " x", "x ", "x\n", "x\x7f", "\u00a0x", "x\u2000", 1, True, [], {}]):
    invalid(f"selection-id-{index}", selected(local(value)))
for index, item in enumerate([
    {"selection_id": "x", "kind": "other", "path": "/a"},
    {"selection_id": "x", "path": "/a"}, {"kind": "local", "path": "/a"},
    {"selection_id": "x", "kind": "local"}, {"selection_id": "x", "kind": "remote"},
    {**local(), "url": "https://covers.invalid/a"}, {**remote(), "path": "/a"},
    {**local(), "width": 1}, {**remote(), "image_bytes": "not-image-storage"},
]):
    invalid(f"reference-fields-{index}", selected(item))
for kind, source_field, factory in [("local", "path", local), ("remote", "url", remote)]:
    for index, value in enumerate([None, 1, True, [], {}, "", " a", "a ", "a\n", "a\x7f"]):
        invalid(f"{kind}-source-text-{index}", selected({**factory(), source_field: value}))
for field in ["thumbnail_url", "album_url"]:
    for index, value in enumerate([None, 1, True, [], {}, "bad\ntext"]):
        invalid(f"{field}-text-{index}", selected({**remote(), field: value}))
for field in ["width", "height", "candidate_generation"]:
    for index, value in enumerate([-1, True, False, 1.0, "100", None, [], {}]):
        invalid(f"{field}-{index}", selected({**remote(), field: value}))
for field in ["source", "source_label", "art_label", "candidate_id"]:
    for index, value in enumerate([None, 1, True, {}, [], "bad\ntext", "bad\x7ftext"]):
        invalid(f"{field}-{index}", selected({**remote(), field: value}))
for index, value in enumerate(["", "front", "OTHER", None, 1]):
    invalid(f"art-kind-{index}", selected({**remote(), "art_kind": value}))
for index, value in enumerate([None, [], {}, {**RECEIPT, "extra": "x"},
        {"mutation_id": UUID_TEXT}, {**RECEIPT, "mutation_id": "bad"},
        {**RECEIPT, "mutation_id": 1}, {**RECEIPT, "request_hash": "A" * 64},
        {**RECEIPT, "request_hash": "a" * 63}, {**RECEIPT, "request_hash": "g" * 64},
        {**RECEIPT, "request_hash": None}]):
    invalid(f"receipt-{index}", selected(local(), selected_covers_last_request=value))
invalid("duplicate-selection-id", selected(local("same"), remote("same")))
invalid("duplicate-literal-path", selected(local("a"), local("b")))
invalid("duplicate-literal-url", selected(remote("a"), remote("b")))


# Deliberately Python-owned semantic checks, not promises of this SQL guard.
SQL_INVALID_CASES = [case for case in INVALID_CASES
                     if case.id not in {"candidate_generation-4", "receipt-5"}]
PYTHON_ONLY_CASES = [
    selected(local(path="relative.jpg")),
    selected(remote(url="not-a-url")),
    selected({**remote(), "candidate_generation": "100"}),
    selected(local(), selected_covers_last_request={**RECEIPT, "mutation_id": "not-a-uuid"}),
    selected(local("a", "/folder/./front.jpg"), local("b", "/folder/front.jpg")),
    selected(local("a", r"C:\Album\Front.jpg"), local("b", "c:/album/front.JPG")),
    selected(remote("a", "HTTPS://Covers.Invalid/a"), remote("b", "https://covers.invalid:443/a")),
    selected(remote("a", "https://straße.invalid/a"), remote("b", "https://strasse.invalid/a")),
]


@pytest.mark.parametrize("value", LEGACY_CASES)
def test_legacy_contract_does_not_infer_selection(value):
    assert project_selected_cover_metadata(value) == {}


@pytest.mark.parametrize("value", VALID_CASES)
def test_independent_accepted_corpus_matches_python_contract(value):
    original = deepcopy(value)
    projected = project_selected_cover_metadata(value)
    assert projected == {key: val for key, val in value.items() if key in {
        "selected_covers", "selected_covers_revision", "selected_covers_last_request"}}
    assert value == original


@pytest.mark.parametrize("value", INVALID_CASES)
def test_independent_rejected_corpus_matches_python_contract(value):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(value)


def _target_config(raw):
    """Fail closed before any connection, never fall back to app/PG settings."""
    try:
        target = json.loads(raw)
    except (TypeError, ValueError):
        raise pytest.UsageError("Ordered-cover test database configuration must be JSON.") from None
    if not isinstance(target, dict) or set(target) != {"host", "port", "dbname", "user", "password"}:
        raise pytest.UsageError("Ordered-cover test target requires exactly host, port, dbname, user, password.")
    if (target["host"] not in ("127.0.0.1", "::1")
            or type(target["port"]) is not int or not 1 <= target["port"] <= 65535
            or not isinstance(target["dbname"], str)
            or not re.fullmatch(r"pytest_ordered_cover_[0-9a-f]{16,32}", target["dbname"])
            or not isinstance(target["user"], str) or not target["user"]
            or not isinstance(target["password"], str)):
        raise pytest.UsageError("Ordered-cover SQL tests require an explicit uniquely named isolated loopback target.")
    return target


@pytest.fixture(scope="module")
def ordered_cover_pg():
    raw = os.environ.get(TARGET_ENV)
    if raw is None:
        pytest.skip(f"real PostgreSQL not configured: set {TARGET_ENV} for an empty isolated database")
    target = _target_config(raw)
    # A configured integration run must fail if the driver/server is unavailable.
    import psycopg

    with pytest.MonkeyPatch.context() as patch:
        for name in list(os.environ):
            if name.startswith("PG"):
                patch.delenv(name)
        connection = psycopg.connect(
            **target, passfile=os.devnull, connect_timeout=5, sslmode="disable",
            options="-c statement_timeout=10000 -c lock_timeout=2000",
        )
    try:
        identity = connection.execute("select current_database(), current_user").fetchone()
        assert identity == (target["dbname"], target["user"]), "Unexpected PostgreSQL target identity"
        existing = connection.execute("""
            select exists(select 1 from pg_namespace where nspname = 'library')
                or exists(select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname not in ('pg_catalog', 'information_schema')
                            and n.nspname not like 'pg_toast%%'
                            and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S'))
        """).fetchone()[0]
        assert not existing, "Refusing to modify a nonempty database or existing library schema"
        connection.execute("create schema library")
        connection.execute("create table library.local_albums (id bigint primary key, metadata jsonb)")
        # Legacy rows predate the migration, and must remain byte-for-byte JSON equivalent.
        for index, value in enumerate(LEGACY_CASES):
            connection.execute("insert into library.local_albums values (%s, %s::jsonb)",
                               (index + 1, json.dumps(value)))
        migration = MIGRATION.read_text(encoding="utf-8")
        connection.execute(migration)
        yield connection
    finally:
        connection.rollback()
        connection.close()


@pytest.fixture
def pg_case(ordered_cover_pg):
    # Nested transaction/savepoint gets discarded even when the test succeeds.
    with ordered_cover_pg.transaction(force_rollback=True):
        yield ordered_cover_pg


def _sql_valid(connection, value):
    return connection.execute("select library.valid_selected_cover_metadata(%s::jsonb)",
                              (json.dumps(value),)).fetchone()[0]


@pytest.mark.parametrize("value", LEGACY_CASES + VALID_CASES)
def test_postgres_accepts_legacy_and_python_valid_metadata(pg_case, value):
    assert _sql_valid(pg_case, value) is True
    pg_case.execute("insert into library.local_albums values (1000, %s::jsonb)", (json.dumps(value),))
    assert pg_case.execute("select metadata from library.local_albums where id=1000").fetchone()[0] == value


@pytest.mark.parametrize("value", SQL_INVALID_CASES)
def test_postgres_rejects_malformed_ordered_metadata(pg_case, value):
    import psycopg

    assert _sql_valid(pg_case, value) is False
    with pytest.raises(psycopg.errors.CheckViolation):
        with pg_case.transaction():
            pg_case.execute("insert into library.local_albums values (1000, %s::jsonb)", (json.dumps(value),))
    assert pg_case.execute("select count(*) from library.local_albums where id=1000").fetchone()[0] == 0


def test_postgres_migration_preserves_preexisting_legacy_rows(pg_case):
    values = pg_case.execute("select metadata from library.local_albums order by id").fetchall()
    assert [row[0] for row in values] == LEGACY_CASES


def test_postgres_sql_null_metadata_preserves_legacy_classification(pg_case):
    pg_case.execute("insert into library.local_albums values (1000, NULL)")
    assert pg_case.execute("select metadata from library.local_albums where id=1000").fetchone() == (None,)


def test_postgres_update_rejects_partial_set_and_keeps_original(pg_case):
    import psycopg

    original = selected(local(), revision=3, selected_covers_last_request=RECEIPT)
    pg_case.execute("insert into library.local_albums values (1000, %s::jsonb)", (json.dumps(original),))
    with pytest.raises(psycopg.errors.CheckViolation):
        with pg_case.transaction():
            pg_case.execute("update library.local_albums set metadata = metadata - 'selected_covers_revision' where id=1000")
    assert pg_case.execute("select metadata from library.local_albums where id=1000").fetchone()[0] == original


def test_postgres_migration_is_repeatable_without_rewriting_metadata(pg_case):
    before = pg_case.execute("select id, metadata from library.local_albums order by id").fetchall()
    pg_case.execute(MIGRATION.read_text(encoding="utf-8"))
    assert pg_case.execute("select id, metadata from library.local_albums order by id").fetchall() == before


@pytest.mark.parametrize("value", PYTHON_ONLY_CASES)
def test_postgres_guard_does_not_claim_python_source_or_uuid_semantics(pg_case, value):
    with pytest.raises(ValueError):
        project_selected_cover_metadata(value)
    assert _sql_valid(pg_case, value) is True


@pytest.mark.parametrize("overrides", [
    {"host": "production.invalid"}, {"host": "localhost"}, {"port": 5432.0},
    {"port": True}, {"port": 0}, {"dbname": "album_haven"},
    {"dbname": "pytest_ordered_cover_short"}, {"user": ""},
    {"password": None}, {"service": "ambient"},
])
def test_isolated_target_rejects_unsafe_or_implicit_connection_settings(overrides):
    target = {"host": "127.0.0.1", "port": 54321,
              "dbname": "pytest_ordered_cover_0123456789abcdef",
              "user": "synthetic_owner", "password": ""}
    with pytest.raises(pytest.UsageError):
        _target_config(json.dumps({**target, **overrides}))


@pytest.mark.parametrize("raw", ["", "not-json", "null", "[]", "{}"])
def test_isolated_target_requires_complete_explicit_object(raw):
    with pytest.raises(pytest.UsageError):
        _target_config(raw)


def test_isolated_target_preserves_only_explicit_connection_fields():
    target = {"host": "127.0.0.1", "port": 54321,
              "dbname": "pytest_ordered_cover_0123456789abcdef",
              "user": "synthetic_owner", "password": ""}
    assert _target_config(json.dumps(target)) == target


@pytest.mark.parametrize("integer_text, expected", [("0", True), ("123", True), ("1.0", False), ("-1", False)])
def test_postgres_revision_numeric_representation(pg_case, integer_text, expected):
    raw = '{"selected_covers":' + json.dumps([local()]) + ',"selected_covers_revision":' + integer_text + '}'
    assert pg_case.execute("select library.valid_selected_cover_metadata(%s::jsonb)", (raw,)).fetchone()[0] is expected


def test_jsonb_erases_exponent_syntax_before_guard(pg_case):
    raw = '{"selected_covers":' + json.dumps([local()]) + ',"selected_covers_revision":1e0}'
    with pytest.raises(ValueError):
        project_selected_cover_metadata(json.loads(raw))
    # JSONB stores this as 1, so the SQL guard cannot reconstruct float intent.
    assert pg_case.execute("select (%s::jsonb)->>'selected_covers_revision'", (raw,)).fetchone()[0] == "1"
    assert pg_case.execute("select library.valid_selected_cover_metadata(%s::jsonb)", (raw,)).fetchone()[0] is True



def test_postgres_migration_refuses_invalid_preexisting_list_without_repair(pg_case):
    import psycopg
    pg_case.execute("alter table library.local_albums drop constraint local_albums_selected_cover_metadata_shape")
    malformed = {"selected_covers": [], "selected_covers_revision": 0, "cover_selection_origin": "inherited"}
    pg_case.execute("insert into library.local_albums values (1000, %s::jsonb)", (json.dumps(malformed),))
    before = pg_case.execute("select id,metadata from library.local_albums order by id").fetchall()
    with pytest.raises(psycopg.errors.CheckViolation):
        with pg_case.transaction():
            pg_case.execute(MIGRATION.read_text(encoding="utf-8"))
    assert pg_case.execute("select id,metadata from library.local_albums order by id").fetchall() == before


def test_postgres_function_acl_is_private_and_grants_only_existing_roles(pg_case):
    public_execute = pg_case.execute("""select exists(
        select 1 from pg_proc p cross join lateral aclexplode(p.proacl) acl
        where p.oid='library.valid_selected_cover_metadata(jsonb)'::regprocedure
          and acl.grantee=0 and acl.privilege_type='EXECUTE')""").fetchone()[0]
    assert public_execute is False
    roles = pg_case.execute("select rolname from pg_roles where rolname in ('album_haven_app','album_haven_migrator')").fetchall()
    for (role,) in roles:
        assert pg_case.execute("select has_function_privilege(%s,'library.valid_selected_cover_metadata(jsonb)','EXECUTE')", (role,)).fetchone()[0] is True
    assert pg_case.execute("select has_function_privilege(current_user,'library.valid_selected_cover_metadata(jsonb)','EXECUTE')").fetchone()[0] is True


def test_migration_checks_optional_deployment_roles_before_granting():
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    for role in ("album_haven_app", "album_haven_migrator"):
        assert re.search(r"if\s+exists\s*\(\s*select\s+1\s+from\s+pg_roles\s+where\s+rolname\s*=\s*'" + role +
                         r"'\s*\)\s+then\s+grant\s+execute\s+on\s+function\s+library\.valid_selected_cover_metadata\(jsonb\)\s+to\s+" + role + r"\s*;\s*end\s+if", sql)
