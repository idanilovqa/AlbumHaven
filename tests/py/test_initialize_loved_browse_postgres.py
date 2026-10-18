"""Non-database contracts for the fresh Loved seed-only CI initializer."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


@pytest.fixture
def owner():
    path = Path(__file__).resolve().parents[2] / "scripts/ci/initialize-loved-browse-postgres.py"
    name = "_loved_seed_contract"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get(name)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        if previous is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous


def environment(tmp_path, platform="Linux"):
    suffix = "tops_123_1" if platform == "Linux" else "py_contract_123_1"
    database = "album_haven_ci_" + suffix
    roles = {"migrator": "album_haven_migrator_" + suffix,
             "app": "album_haven_app_" + suffix, "readonly": "album_haven_readonly_" + suffix}
    authority = "127.0.0.1:5432" if platform == "Linux" else "127.0.0.1"
    setup = f"postgresql://{roles['migrator']}@{authority}/{database}"
    runtime = f"postgresql://{roles['app']}@{authority}/{database}"
    pgpass = tmp_path / (database + ".pgpass" if platform == "Linux" else f"album-haven-postgres-{suffix}.pgpass")
    pgpass.touch()  # Empty placeholder; no credentials are read or generated.
    pgpass.chmod(0o600)
    env = dict(GITHUB_ACTIONS="true", GITHUB_RUN_ID="123", GITHUB_RUN_ATTEMPT="1",
               RUNNER_OS=platform, GITHUB_JOB="test_feature_batches_linux" if platform == "Linux" else "test_python",
               FEATURE_BATCH="loved_backend", RUNNER_TEMP=str(tmp_path), PGPASSFILE=str(pgpass),
               DATABASE_MIGRATOR_URL=setup, DATABASE_APP_URL=runtime,
               ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL=runtime, ALBUM_HAVEN_CI_DATABASE=database)
    state = dict(schemaVersion=1, suffix=suffix, database=database, roles=roles,
                 pgpass=str(pgpass), host="127.0.0.1", port=5432)
    (tmp_path / "album-haven-python-contract-postgres.state.json").write_text(json.dumps(state), encoding="utf-8")
    return env


@pytest.mark.parametrize("platform,batch", [("Linux", "loved_backend"), ("Linux", "favorites_backend"), ("Windows", "loved_backend")])
def test_exact_job_identity_preserves_routing_and_never_reads_password_file(owner, tmp_path, monkeypatch, platform, batch):
    env = environment(tmp_path, platform)
    env["FEATURE_BATCH"] = batch
    before = dict(env)
    real = Path.read_text
    def guarded(path, *args, **kwargs):
        assert str(path) != env["PGPASSFILE"], "Credential contents must never be read"
        return real(path, *args, **kwargs)
    monkeypatch.setattr(Path, "read_text", guarded)
    monkeypatch.setattr(owner.os, "getuid", lambda: Path(env["PGPASSFILE"]).stat().st_uid, raising=False)
    # Linux file-mode checks are real on Linux; Windows uses its provisioner state.
    if platform == "Linux" and os.name == "nt":
        real_plain = owner.plain_file
        def linux_metadata(path):
            info = real_plain(path)
            return SimpleNamespace(st_mode=0o100600, st_uid=info.st_uid)
        monkeypatch.setattr(owner, "plain_file", linux_metadata)
    identity = owner.job_identity(env)
    assert identity.runtime_url == env["DATABASE_APP_URL"] and env == before
    assert identity.setup_role != identity.runtime_role


@pytest.mark.parametrize("key,value", [
    ("GITHUB_ACTIONS", "false"), ("GITHUB_RUN_ID", "../1"), ("GITHUB_RUN_ATTEMPT", "0"),
    ("RUNNER_OS", "macOS"), ("GITHUB_JOB", "other"), ("FEATURE_BATCH", "listener_postgres"), ("FEATURE_BATCH", "favorites_backend_extra"),
    ("DATABASE_APP_URL", "postgresql://wrong@127.0.0.1:5432/wrong"),
    ("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "different"),
    ("PGPASSFILE", "other"), ("PGPASSWORD", "forbidden"), ("RUNNER_TEMP", "relative"),
])
def test_wrong_job_or_connection_contract_rejects_before_connection(owner, tmp_path, key, value):
    env = environment(tmp_path)
    env[key] = value
    with pytest.raises(RuntimeError):
        owner.job_identity(env)


@pytest.mark.parametrize("change", ["database", "roles", "pgpass", "host", "port", "missing", "extra"])
def test_windows_state_must_be_exact_persistent_provisioner_contract(owner, tmp_path, change):
    env = environment(tmp_path, "Windows")
    path = tmp_path / "album-haven-python-contract-postgres.state.json"
    state = json.loads(path.read_text())
    if change == "missing":
        path.unlink()
    else:
        state[change] = "wrong"
        path.write_text(json.dumps(state))
    with pytest.raises((RuntimeError, FileNotFoundError)):
        owner.job_identity(env)


class Reply:
    def __init__(self, value): self.value = value
    def fetchall(self): return self.value
    def fetchone(self): return self.value


class Queries:
    def __init__(self, replies): self.replies = list(replies)
    def execute(self, query, params=None):
        assert self.replies, "Unexpected query"
        return Reply(self.replies.pop(0))


@pytest.mark.parametrize("changed", [None, "missing", "checksum", "duplicate", "extra"])
def test_ledger_covers_all_checked_out_migrations_without_fixed_last_number(owner, tmp_path, changed):
    folder = tmp_path / "migrations/postgres"
    folder.mkdir(parents=True)
    rows = []
    for name in ("0001_base.sql", "0140_create_relation_alias_endpoints.sql", "0141_future_owned_schema.sql"):
        data = ("-- " + name + "\n").encode()
        (folder / name).write_bytes(data)
        rows.append(dict(migration_name=name, checksum=hashlib.sha256(data).hexdigest()))
    if changed == "missing": rows.pop()
    elif changed == "checksum": rows[0]["checksum"] = "wrong"
    elif changed == "duplicate": rows.append(dict(rows[0]))
    elif changed == "extra": rows.append(dict(migration_name="9999_not_checked_out.sql", checksum="wrong"))
    con = Queries([rows])
    if changed is None:
        owner.assert_migration_ledger(con, tmp_path)
    else:
        with pytest.raises(RuntimeError): owner.assert_migration_ledger(con, tmp_path)
    assert con.replies == []


@pytest.mark.parametrize("dirty", [False, True])
def test_count_guard_includes_new_relations_and_rejects_unowned_rows(owner, dirty):
    tables = sorted(owner.MIGRATION_OWNED | set(owner.SEEDED_COUNTS) | {("library", "future_relation")})
    replies = [[dict(schema_name=s, table_name=t) for s, t in tables]]
    for key in sorted(set(tables) - owner.MIGRATION_OWNED):
        count = owner.FRESH_COUNTS.get(key, 0)
        if dirty and key == ("library", "future_relation"): count = 1
        replies.append(dict(count=count))
    con = Queries(replies)
    if dirty:
        with pytest.raises(RuntimeError, match="Unexpected application baseline"):
            owner.assert_counts(con, owner.FRESH_COUNTS)
    else:
        owner.assert_counts(con, owner.FRESH_COUNTS)
        assert con.replies == []


@pytest.mark.parametrize("setup", [False, True])
@pytest.mark.parametrize("wrong", [None, "role", "superuser", "inherited", "migrator"])
def test_database_role_checks_reject_elevation_and_wrong_identity(owner, tmp_path, setup, wrong):
    ident = owner.Identity("db", "setup", "runtime", "setup-url", "runtime-url", tmp_path / "marker")
    row = dict(database="db", role="setup" if setup else "runtime", major=17,
               rolsuper=False, rolcreatedb=False, rolcreaterole=False,
               rolreplication=False, rolbypassrls=False, inherited=True)
    grants = dict(safe=True, migrator=setup)
    if wrong == "role": row["role"] = "other"
    elif wrong == "superuser": row["rolsuper"] = True
    elif wrong == "inherited": row["inherited"] = False
    elif wrong == "migrator": grants["migrator"] = not setup
    con = Queries([row, grants])
    if wrong is None: owner.assert_identity(con, ident, setup=setup)
    else:
        with pytest.raises(RuntimeError): owner.assert_identity(con, ident, setup=setup)


def test_connection_bounds_cover_seed_and_restore_only_timeout_environment(owner, monkeypatch):
    monkeypatch.setenv("PGOPTIONS", "previous")
    monkeypatch.delenv("PGCONNECT_TIMEOUT", raising=False)
    monkeypatch.setenv("DATABASE_APP_URL", "preserved")
    with pytest.raises(ValueError):
        with owner.bounded_connections():
            assert os.environ["PGCONNECT_TIMEOUT"] == "10"
            assert "statement_timeout=30000" in os.environ["PGOPTIONS"]
            assert "lock_timeout=10000" in os.environ["PGOPTIONS"]
            assert "idle_in_transaction_session_timeout=30000" in os.environ["PGOPTIONS"]
            raise ValueError("synthetic")
    assert os.environ["PGOPTIONS"] == "previous" and "PGCONNECT_TIMEOUT" not in os.environ
    assert os.environ["DATABASE_APP_URL"] == "preserved"


@pytest.mark.parametrize("failure", [None, "dirty", "seed", "post_seed", "runtime_readback", "social_readback"])
def test_initializer_order_no_repair_and_failure_quarantine(owner, tmp_path, monkeypatch, failure):
    ident = owner.Identity("db", "setup", "runtime", "setup-url", "runtime-url", tmp_path / "attempt")
    events = []
    class Lease:
        def __init__(self, **kwargs):
            assert kwargs == dict(database_url=ident.runtime_url, wait_seconds=10)
        def acquire(self): events.append("acquire")
        def release(self): events.append("release")
    @contextmanager
    def connect(url):
        assert os.environ["PGCONNECT_TIMEOUT"] == "10"
        events.append("connect:" + url)
        yield url
        events.append("close:" + url)
    def seed(url):
        assert url == ident.setup_url and os.environ["PGCONNECT_TIMEOUT"] == "10"
        events.append("seed")
        if failure == "seed": raise RuntimeError("synthetic seed failure")
    def counts(con, expected):
        seeded = expected == owner.SEEDED_COUNTS
        events.append("seeded-counts" if seeded else "fresh-counts")
        if failure == ("post_seed" if seeded else "dirty"): raise RuntimeError("synthetic baseline failure")
    def check_seed(con):
        if failure == "runtime_readback" and con == ident.runtime_url: raise RuntimeError("synthetic changed seed")
        return 17
    fake = SimpleNamespace(IsolatedDatabaseOwnershipLock=Lease,
        SETUP_DATABASE_ENV="setup-env", RUNTIME_DATABASE_ENV="runtime-env",
        resolve_isolated_database_urls=lambda supplied: events.append("urls"),
        _connect=connect, assert_runtime_grants=lambda url: events.append("grants-read"),
        seed_bootstrap_owner_and_library=seed)
    monkeypatch.setattr(owner, "assert_identity", lambda *a, **k: None)
    monkeypatch.setattr(owner, "assert_migration_ledger", lambda *a: None)
    monkeypatch.setattr(owner, "assert_counts", counts)
    monkeypatch.setattr(owner, "refresh_state", lambda con: {"stable": True})
    monkeypatch.setattr(owner, "assert_seed", check_seed)
    monkeypatch.setattr(owner, "bootstrap_clocks", lambda *a: {"clock": 1})
    def check_social(con, library, baseline=None):
        if failure == "social_readback" and con == ident.runtime_url:
            raise RuntimeError("synthetic social drift")
        return {"social": "stable"}
    monkeypatch.setattr(owner, "bootstrap_social_baseline", check_social)
    if failure is None:
        owner.initialize(ident, fake, root=tmp_path)
        assert events[-1] == "release"
    else:
        with pytest.raises(RuntimeError): owner.initialize(ident, fake, root=tmp_path)
        assert "release" not in events
    assert events.count("seed") == (0 if failure == "dirty" else 1)
    assert ident.marker.is_file()
    before = list(events)
    with pytest.raises(FileExistsError): owner.initialize(ident, fake, root=tmp_path)
    assert events == before  # Neither stale lease recovery nor a second seed.
    assert "fresh-counts" in events
    if "seed" in events:
        assert events.index("fresh-counts") < events.index("seed")
        assert events.index("grants-read") < events.index("seed")


@pytest.mark.parametrize("change", [None, "duplicate", "wrong_key", "wrong_library", "foreign_metadata", "invalid_id"])
def test_supported_seed_is_unique_exact_and_unmodified(owner, change):
    source = {"source": "isolated_e2e_launcher"}
    row = dict(account_kind="bootstrap_owner", account_metadata=source, owner_key="local-bootstrap-owner",
               owner_metadata=source, id=23, name="Local Library", library_kind="local", metadata=source)
    if change == "wrong_key": row["owner_key"] = "other"
    elif change == "wrong_library": row["name"] = "arbitrary Mix"
    elif change == "foreign_metadata": row["metadata"] = {"unowned": True}
    elif change == "invalid_id": row["id"] = True
    con = Queries([[row, row] if change == "duplicate" else [row]])
    if change is None: assert owner.assert_seed(con) == 23
    else:
        with pytest.raises(RuntimeError): owner.assert_seed(con)


@pytest.mark.parametrize("change", [None, "missing", "wrong_library", "zero_generation", "invalid_xid"])
def test_both_supported_bootstrap_clocks_must_be_valid(owner, change):
    row = dict(library_id=23, generation=1, xid="42")
    if change == "wrong_library": row["library_id"] = 24
    elif change == "zero_generation": row["generation"] = 0
    elif change == "invalid_xid": row["xid"] = "unknown"
    con = Queries([[] if change == "missing" else [row], [dict(row)]])
    if change is None:
        assert owner.bootstrap_clocks(con, 23) == {table: row for table in owner.CLOCK_TABLES}
    else:
        with pytest.raises(RuntimeError): owner.bootstrap_clocks(con, 23)


@pytest.mark.parametrize("change", [None, "duplicate", "lease", "provider", "infinite"])
def test_migration_owned_refresh_state_is_only_an_idle_singleton(owner, change):
    row = dict(provider="lastfm", lease_token=None, lease_until=None, next_attempt_at="synthetic-time", finite=True)
    if change == "lease": row["lease_token"] = "unexpected"
    elif change == "provider": row["provider"] = "other"
    elif change == "infinite": row["finite"] = False
    con = Queries([[row, row] if change == "duplicate" else [row]])
    if change is None: assert owner.refresh_state(con) == row
    else:
        with pytest.raises(RuntimeError): owner.refresh_state(con)


@pytest.mark.parametrize("platform", ["Linux", "Windows"])
def test_job_identity_rejects_other_platform_default_port_spelling(owner, tmp_path, platform):
    env = environment(tmp_path, platform)
    for key in ("DATABASE_MIGRATOR_URL", "DATABASE_APP_URL", "ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL"):
        env[key] = env[key].replace("@127.0.0.1:5432/", "@127.0.0.1/") if platform == "Linux" else env[key].replace("@127.0.0.1/", "@127.0.0.1:5432/")
    with pytest.raises(RuntimeError, match="Database URLs do not match"):
        owner.job_identity(env)


@pytest.fixture(params=[
    "scripts/ci/initialize-loved-browse-postgres.py",
    "scripts/ci/initialize-popularity-search-postgres.py",
    "tests/py/popularity_search_bootstrap_support.py",
])
def social_owner(request):
    # Extract ONLY this closed read-only validator. No product/support module
    # imports or top-level execution; its sole external name is stdlib UUID.
    import ast
    from uuid import UUID
    root = Path(__file__).resolve().parents[2]
    paths = ["scripts/ci/initialize-loved-browse-postgres.py",
             "scripts/ci/initialize-popularity-search-postgres.py",
             "tests/py/popularity_search_bootstrap_support.py"]
    definitions = []
    for path in paths:
        tree = ast.parse((root / path).read_text(encoding="utf-8"))
        matches = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                   and node.name == "bootstrap_social_baseline"]
        assert len(matches) == 1
        definitions.append(matches[0])
    assert len({ast.dump(node, include_attributes=False) for node in definitions}) == 1
    node = definitions[paths.index(request.param)]
    namespace = {"UUID": UUID}
    exec(compile(ast.Module(body=[node], type_ignores=[]), request.param, "exec"), namespace)
    return namespace["bootstrap_social_baseline"]


def social_rows():
    source = {"source": "isolated_e2e_launcher"}
    owner = dict(account_id=11, account_kind="bootstrap_owner",
                 account_metadata=source, owner_metadata=source)
    profile = dict(account_id=11, account_ref="6ca88738-fd8e-4f0c-9380-899250ccecca")
    policy = dict(library_id=23, auto_friend=False, updated_by_account_id=None,
                  updated_at="2026-10-18T00:00:00+00:00")
    return [[owner], [{"data": profile}], [{"data": policy, "finite": True}]]


@pytest.mark.parametrize("change", [None, "owner_missing", "owner_duplicate", "owner_id",
    "owner_kind", "owner_metadata", "profile_missing", "profile_duplicate", "profile_account",
    "profile_uuid", "profile_extra", "policy_missing", "policy_duplicate", "policy_library",
    "policy_auto", "policy_updater", "policy_time_null", "policy_time_infinite", "policy_extra"])
def test_trigger_created_social_rows_have_exact_canonical_shape_and_defaults(social_owner, change):
    rows = social_rows()
    if change == "owner_missing": rows[0] = []
    elif change == "owner_duplicate": rows[0] *= 2
    elif change == "owner_id": rows[0][0]["account_id"] = True
    elif change == "owner_kind": rows[0][0]["account_kind"] = "managed_user"
    elif change == "owner_metadata": rows[0][0]["owner_metadata"] = {}
    elif change == "profile_missing": rows[1] = []
    elif change == "profile_duplicate": rows[1] *= 2
    elif change == "profile_account": rows[1][0]["data"]["account_id"] = 12
    elif change == "profile_uuid": rows[1][0]["data"]["account_ref"] = "invalid"
    elif change == "profile_extra": rows[1][0]["data"]["extra"] = None
    elif change == "policy_missing": rows[2] = []
    elif change == "policy_duplicate": rows[2] *= 2
    elif change == "policy_library": rows[2][0]["data"]["library_id"] = 24
    elif change == "policy_auto": rows[2][0]["data"]["auto_friend"] = True
    elif change == "policy_updater": rows[2][0]["data"]["updated_by_account_id"] = 11
    elif change == "policy_time_null": rows[2][0]["data"]["updated_at"] = None
    elif change == "policy_time_infinite": rows[2][0]["finite"] = False
    elif change == "policy_extra": rows[2][0]["data"]["extra"] = None
    con = Queries(rows)
    if change is None:
        expected = {"profile": dict(rows[1][0]["data"]), "policy": dict(rows[2][0]["data"])}
        assert social_owner(con, 23) == expected
        assert con.replies == []
    else:
        with pytest.raises(RuntimeError): social_owner(con, 23)


@pytest.mark.parametrize("change", [None, "profile_uuid", "policy_timestamp"])
def test_valid_social_rows_cannot_replace_captured_baseline(social_owner, change):
    baseline = social_owner(Queries(social_rows()), 23)
    rows = social_rows()
    if change == "profile_uuid":
        rows[1][0]["data"]["account_ref"] = "6ca88738-fd8e-4f0c-9380-899250cceccb"
    elif change == "policy_timestamp":
        rows[2][0]["data"]["updated_at"] = "2026-10-19T00:00:00+00:00"
    if change is None:
        assert social_owner(Queries(rows), 23, baseline) == baseline
    else:
        with pytest.raises(RuntimeError, match="changed"):
            social_owner(Queries(rows), 23, baseline)


def test_trigger_rows_are_seeded_counts_only_and_never_migration_ignored(owner):
    for key in (("app", "social_profiles"), ("app", "friend_policies")):
        assert owner.FRESH_COUNTS.get(key, 0) == 0
        assert owner.SEEDED_COUNTS[key] == 1
        assert key not in owner.MIGRATION_OWNED
