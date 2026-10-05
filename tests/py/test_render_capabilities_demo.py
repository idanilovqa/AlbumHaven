"""Deployment safety/unit checks; not a substitute for hosted app verification."""
from contextlib import contextmanager
import importlib.util
from pathlib import Path
from urllib.parse import urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


config = module('capabilities_demo_database')
demo = module('render_capabilities_demo')
HOST = 'ep-capabilities-example.us-east-2.aws.neon.tech'
URL = f'postgresql://neondb_owner:fake-test-password@{HOST}/neondb?sslmode=require'


def test_direct_dedicated_tls_database_is_accepted():
    assert config.validate_database_url(URL, HOST) == URL


@pytest.mark.parametrize('value,host', [
    ('', HOST), (URL, ''), (URL, 'different.neon.tech'),
    (URL.replace('sslmode=require', 'sslmode=disable'), HOST),
    (URL.replace('?sslmode=require', ''), HOST),
    (URL.replace('/neondb', '/albumhaven_mobile_demo_db'), HOST),
    (URL.replace(HOST, 'mobile.internal'), 'mobile.internal'),
    (URL.replace(HOST, HOST + '.example.com'), HOST + '.example.com'),
    (URL.replace('postgresql:', 'https:'), HOST),
    (URL + '&options=-c+role%3Dsuperuser', HOST),
    (URL + '#fragment', HOST),
    (URL.replace('ep-capabilities-example.', 'ep-capabilities-example-pooler.'), HOST.replace('example.', 'example-pooler.')),
    (URL.replace(':fake-test-password@', '@'), HOST),
    (URL.replace('/neondb?', ':6000/neondb?'), HOST),
])
def test_wrong_database_or_connection_is_rejected(value, host):
    with pytest.raises(ValueError):
        config.validate_database_url(value, host)


def test_explicit_database_settings_are_required(monkeypatch):
    monkeypatch.delenv('ALBUM_HAVEN_CAPS_DATABASE_URL', raising=False)
    monkeypatch.delenv('ALBUM_HAVEN_CAPS_DATABASE_HOST', raising=False)
    with pytest.raises(ValueError, match='Set ALBUM_HAVEN_CAPS_DATABASE_URL'):
        config.read_database_configuration()
    monkeypatch.setenv('ALBUM_HAVEN_CAPS_DATABASE_URL', URL)
    monkeypatch.setenv('ALBUM_HAVEN_CAPS_DATABASE_HOST', HOST)
    assert config.read_database_configuration()['connection_string'] == URL


def test_runtime_connection_preserves_tls_and_uses_separate_role():
    actual = urlsplit(demo.application_url(URL, 'complex:p/w@ssword'))
    assert actual.username == 'album_haven_app'
    assert actual.hostname == HOST and actual.path == '/neondb'
    assert actual.query == 'sslmode=require'
    assert actual.password == 'complex%3Ap%2Fw%40ssword'


@pytest.mark.parametrize('origin', [
    'https://albumhaven.onrender.com', 'http://albumhaven-capabilities-demo.onrender.com',
    'https://albumhaven-capabilities-demo.onrender.com.evil.test',
    'https://user:password@albumhaven-capabilities-demo.onrender.com',
    'https://albumhaven-capabilities-demo.onrender.com/wrong',
])
def test_launcher_refuses_mobile_or_wrong_service(origin, monkeypatch, tmp_path):
    monkeypatch.setattr(demo, 'DEMO_ROOT', tmp_path)
    monkeypatch.setenv('RENDER_EXTERNAL_URL', origin)
    monkeypatch.setenv('ALBUM_HAVEN_AUTH_HMAC_SECRET', 'test-key-' * 8)
    with pytest.raises(ValueError, match='separately named'):
        demo.configure(URL)


def test_demo_settings_are_isolated_and_mail_is_disabled(monkeypatch, tmp_path):
    monkeypatch.setattr(demo, 'DEMO_ROOT', tmp_path)
    monkeypatch.setenv('RENDER_EXTERNAL_URL', 'https://albumhaven-capabilities-demo.onrender.com')
    monkeypatch.setenv('ALBUM_HAVEN_AUTH_HMAC_SECRET', 'test-key-' * 8)
    # Use an isolated mapping so no test changes ambient process configuration.
    monkeypatch.setattr(demo.os, 'environ', dict(demo.os.environ))
    demo.os.environ['ALBUM_HAVEN_SMTP_PASSWORD'] = 'test-only'
    demo.configure(URL)
    assert demo.os.environ['MUSIC_DIR'] == str(tmp_path / 'main')
    assert demo.os.environ['ALBUM_HAVEN_INVITATION_EMAIL_ENABLED'] == 'false'
    assert 'ALBUM_HAVEN_SMTP_PASSWORD' not in demo.os.environ
    assert demo.os.environ['ALBUM_HAVEN_APP_DATABASE_URL'] == URL
    assert demo.os.environ['LASTFM_API_KEY'] == ''


class Result:
    def __init__(self, rows): self.rows = rows
    def fetchone(self): return self.rows[0]
    def fetchall(self): return self.rows


class Connection:
    def __init__(self, answers): self.answers = iter(answers)
    def execute(self, _sql): return Result(next(self.answers))


class MigrationConnection:
    def __init__(
        self,
        *,
        index_state="ready",
        fail_first_concurrent=False,
        preserve_mismatch_after_create=False,
    ):
        self.index_state = index_state
        self.fail_first_concurrent = fail_first_concurrent
        self.preserve_mismatch_after_create = preserve_mismatch_after_create
        self.transaction_depth = 0
        self.events = []
        self.ledger = []
        self.applied = {}

    @contextmanager
    def transaction(self):
        self.events.append("transaction:begin")
        self.transaction_depth += 1
        try:
            yield
        finally:
            self.transaction_depth -= 1
            self.events.append("transaction:end")

    def execute(self, sql, parameters=None):
        query = " ".join(str(sql).split()).casefold()
        if "to_regclass('ops.schema_migrations')" in query:
            return Result([("ops.schema_migrations",)])
        if query.startswith("select migration_name, checksum"):
            return Result(list(self.applied.items()))
        if "ordinary migration" in query:
            assert self.transaction_depth == 1
            self.events.append("ordinary")
            return Result([])
        if "create index concurrently" in query:
            assert self.transaction_depth == 0
            self.events.append("concurrent")
            if self.fail_first_concurrent:
                self.fail_first_concurrent = False
                self.index_state = "mismatched"
                raise RuntimeError("concurrent index build failed")
            if self.index_state == "missing":
                self.index_state = (
                    "mismatched" if self.preserve_mismatch_after_create else "ready"
                )
            return Result([])
        if "album_haven_0083_index_contract_v1" in query:
            assert parameters is None
            self.events.append("validate:" + self.index_state)
            return Result([(self.index_state,)])
        if query == (
            "drop index concurrently if exists "
            "library.local_albums_normalized_raw_artists_trgm_idx"
        ):
            assert self.transaction_depth == 0
            self.events.append("drop-mismatched")
            self.index_state = "missing"
            return Result([])
        if query.startswith("insert into ops.schema_migrations"):
            self.events.append("ledger:" + parameters[0])
            self.ledger.append(parameters[0])
            self.applied[parameters[0]] = parameters[1]
            return Result([])
        raise AssertionError(f"Unexpected SQL: {sql}")


def _write_migration_runner_fixture(tmp_path):
    migration_root = tmp_path / "migrations" / "postgres"
    migration_root.mkdir(parents=True)
    (migration_root / "0082_preserve_relations_for_missing_album_removal.sql").write_text(
        "select 'ordinary migration';",
        encoding="utf-8",
    )
    (migration_root / "0083_add_album_raw_artist_search_index.sql").write_text(
        "create index concurrently if not exists "
        "local_albums_normalized_raw_artists_trgm_idx "
        "on library.local_albums using gin ((lower(metadata::text)) library.gin_trgm_ops);",
        encoding="utf-8",
    )
    verifier = (
        tmp_path
        / "scripts"
        / "postgres"
        / "verify_0083_album_raw_artist_index.sql"
    )
    verifier.parent.mkdir(parents=True)
    verifier.write_text(
        "-- album_haven_0083_index_contract_v1\nselect 'ready';\n",
        encoding="utf-8",
    )


def test_capabilities_demo_runs_only_0083_outside_transaction_and_ledgers_after_validation(
    tmp_path,
    monkeypatch,
):
    _write_migration_runner_fixture(tmp_path)
    connection = MigrationConnection()
    monkeypatch.setattr(demo, "ROOT", tmp_path)

    demo.migrate(connection)

    assert connection.ledger == [
        "0082_preserve_relations_for_missing_album_removal.sql",
        "0083_add_album_raw_artist_search_index.sql",
    ]
    assert connection.events.index("ordinary") < connection.events.index(
        "ledger:0082_preserve_relations_for_missing_album_removal.sql"
    )
    concurrent = connection.events.index("concurrent")
    postvalidation = connection.events.index("validate:ready", concurrent)
    assert concurrent < postvalidation
    assert postvalidation < connection.events.index(
        "ledger:0083_add_album_raw_artist_search_index.sql"
    )


def test_capabilities_demo_refuses_to_ledger_invalid_0083_index(tmp_path, monkeypatch):
    _write_migration_runner_fixture(tmp_path)
    connection = MigrationConnection(
        index_state="mismatched",
        preserve_mismatch_after_create=True,
    )
    monkeypatch.setattr(demo, "ROOT", tmp_path)

    with pytest.raises(RuntimeError, match="0083.*nonconforming"):
        demo.migrate(connection)

    assert "0083_add_album_raw_artist_search_index.sql" not in connection.ledger


def test_capabilities_demo_drops_only_failed_0083_index_before_retry(
    tmp_path,
    monkeypatch,
):
    _write_migration_runner_fixture(tmp_path)
    connection = MigrationConnection(fail_first_concurrent=True)
    monkeypatch.setattr(demo, "ROOT", tmp_path)

    with pytest.raises(RuntimeError, match="concurrent index build failed"):
        demo.migrate(connection)

    assert connection.events.count("drop-mismatched") == 1
    assert "0083_add_album_raw_artist_search_index.sql" not in connection.ledger

    demo.migrate(connection)

    concurrent_positions = [
        index for index, event in enumerate(connection.events) if event == "concurrent"
    ]
    assert len(concurrent_positions) == 2
    assert connection.events.index("drop-mismatched") < concurrent_positions[1]
    assert connection.ledger == [
        "0082_preserve_relations_for_missing_album_removal.sql",
        "0083_add_album_raw_artist_search_index.sql",
    ]


@pytest.mark.parametrize(
    "wrong_dimension",
    ["table", "expression", "access-method", "opclass", "uniqueness", "predicate"],
)
def test_capabilities_demo_rebuilds_same_name_wrong_0083_index_before_ledger(
    tmp_path,
    monkeypatch,
    wrong_dimension,
):
    _write_migration_runner_fixture(tmp_path)
    connection = MigrationConnection(index_state="mismatched")
    monkeypatch.setattr(demo, "ROOT", tmp_path)

    demo.migrate(connection)

    assert wrong_dimension
    prevalidation = connection.events.index("validate:mismatched")
    assert connection.events[prevalidation : prevalidation + 4] == [
        "validate:mismatched",
        "drop-mismatched",
        "concurrent",
        "validate:ready",
    ]
    assert connection.ledger[-1] == "0083_add_album_raw_artist_search_index.sql"


def test_empty_database_is_eligible_for_initial_seed():
    assert demo.assert_ownership(Connection([[(None,)], [(0,)]])) is True


def test_existing_capabilities_database_keeps_current_accounts():
    assert demo.assert_ownership(Connection([[('app.bootstrap_owners',)], [(demo.MARKER,)]])) is False


@pytest.mark.parametrize('answers', [
    [[(None,)], [(1,)]],
    [[('app.bootstrap_owners',)], [('albumhaven-generated-render-demo-v1',)]],
    [[('app.bootstrap_owners',)], []],
])
def test_mobile_or_unrelated_database_is_never_seeded(answers):
    with pytest.raises(ValueError):
        demo.assert_ownership(Connection(answers))


def test_seed_manifest_has_separate_admin_owner_and_microcapability_user():
    users = {name: (roles, keys, active) for name, roles, keys, active in demo.ACCOUNTS}
    assert len(users) == 10
    assert users['demo.admin'] == (('admin',), (), True)
    assert users['demo.owner'] == (('owner',), (), True)
    assert users['demo.adminowner'][0] == ('admin', 'owner')
    assert users['demo.custom'] == ((), ('library.browse.read',), True)
    assert users['demo.disabled'][2] is False
    assert users['demo.nocapabilities'][1] == ()
