"""Deployment safety/unit checks; not a substitute for hosted app verification."""
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
