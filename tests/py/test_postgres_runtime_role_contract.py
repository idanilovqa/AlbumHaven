"""Pure rejection matrix for the isolated-role assertion adapter, without DB I/O."""
from types import SimpleNamespace

import pytest

from tests.py.postgres_runtime_role_contract import assert_runtime_role


def database(suffix=None):
    name = 'album_haven_ci_' + suffix if suffix else 'album_haven_fake_e2e'
    role_suffix = '_' + suffix if suffix else ''
    return SimpleNamespace(
        setup_url='postgresql://album_haven_migrator' + role_suffix + '@127.0.0.1/' + name,
        app_url='postgresql://album_haven_app' + role_suffix + '@127.0.0.1/' + name,
    )


class Connection:
    def __init__(self, suffix=None, *, role=None, login=None, db_name=None, **attributes):
        expected = 'album_haven_app' + ('_' + suffix if suffix else '')
        self.identity = {'database_name': db_name or ('album_haven_ci_' + suffix if suffix else 'album_haven_fake_e2e'),
                         'role_name': role or expected}
        self.attributes = {'database_name': self.identity['database_name'],
            'name': role or expected, 'login': login or role or expected,
            'rolsuper': False, 'rolcreatedb': False, 'rolcreaterole': False,
            'rolreplication': False, 'rolbypassrls': False, 'runtime_privileges': True, **attributes}
        self.calls = []

    def execute(self, sql, params=None):
        statement = ' '.join(sql.split())
        self.calls.append((statement, params))
        assert params is None
        if statement == 'select current_database() as database_name, current_user as role_name':
            return SimpleNamespace(fetchone=lambda: dict(self.identity))
        if statement == ("select current_database() as database_name,current_user as name,session_user as login, rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls, "
                         "pg_has_role(current_user,'album_haven_app','USAGE') as runtime_privileges from pg_roles where rolname=current_user"):
            return SimpleNamespace(fetchone=lambda: dict(self.attributes))
        raise AssertionError('Unexpected SQL in read-only assertion: ' + statement)


@pytest.mark.parametrize('suffix', [None, 'py_contract_38878263664_1', 'review_7'])
def test_exact_base_or_suffix_bound_inherited_runtime_is_admitted(suffix):
    connection = Connection(suffix)
    expected = 'album_haven_app' + ('_' + suffix if suffix else '')
    assert assert_runtime_role(connection, database(suffix)) == expected
    assert len(connection.calls) == 2
    assert all(sql.startswith('select ') for sql, _ in connection.calls)
    assert "'USAGE'" in connection.calls[-1][0]


@pytest.mark.parametrize('field,value', [
    ('app_url', 'postgresql://album_haven_app@remote.example.test/album_haven_fake_e2e'),
    ('app_url', 'postgresql://album_haven_app@127.0.0.1/album_haven_core'),
    ('app_url', 'postgresql://arbitrary_role@127.0.0.1/album_haven_fake_e2e'),
    ('app_url', 'postgresql://album_haven_app_other@127.0.0.1/album_haven_ci_py_contract_1_1'),
    ('setup_url', 'postgresql://album_haven_app@127.0.0.1/album_haven_fake_e2e'),
    ('setup_url', 'postgresql://album_haven_migrator@127.0.0.1/album_haven_ci_other'),
    ('app_url', 'postgresql://album_haven_app@127.0.0.1/album_haven_fake_e2e?options=role'),
])
def test_existing_url_owner_rejects_unadmitted_or_unpaired_identity_before_sql(field, value):
    configured = database()
    setattr(configured, field, value)
    connection = Connection()
    with pytest.raises(RuntimeError):
        assert_runtime_role(connection, configured)
    assert connection.calls == []


@pytest.mark.parametrize('options', [
    {'role': 'album_haven_app'},
    {'role': 'album_haven_app_py_contract_2_1'},
    {'db_name': 'album_haven_core'},
    {'db_name': 'album_haven_ci_py_contract_2_1'},
])
def test_connected_identity_must_match_actual_database_suffix(options):
    connection = Connection('py_contract_1_1', **options)
    with pytest.raises(RuntimeError):
        assert_runtime_role(connection, database('py_contract_1_1'))
    assert len(connection.calls) == 1


def test_another_valid_database_and_role_pair_cannot_substitute_for_url_pair():
    connection = Connection('py_contract_2_1')
    with pytest.raises(AssertionError):
        assert_runtime_role(connection, database('py_contract_1_1'))
    assert len(connection.calls) == 2


@pytest.mark.parametrize('attribute', ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'])
def test_elevated_runtime_role_is_rejected(attribute):
    with pytest.raises(AssertionError):
        assert_runtime_role(Connection(**{attribute: True}), database())


def test_membership_without_effective_inherited_privileges_is_insufficient():
    with pytest.raises(AssertionError):
        assert_runtime_role(Connection('py_contract_1_1', runtime_privileges=False), database('py_contract_1_1'))


def test_set_role_cannot_hide_a_different_login_identity():
    with pytest.raises(AssertionError):
        assert_runtime_role(Connection(login='album_haven_migrator'), database())


def test_same_base_role_on_scan_database_cannot_substitute_for_fake_url_database():
    # The reused connected-role owner intentionally admits scan_e2e. This
    # caller's already validated fake_e2e URL still requires its exact database.
    connection = Connection(db_name='album_haven_scan_e2e')
    with pytest.raises(AssertionError):
        assert_runtime_role(connection, database())
    assert len(connection.calls) == 2
