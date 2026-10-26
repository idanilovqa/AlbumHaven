"""Explicit disposable local17 admission; no provisioning or database mutation."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

APPROVED_BINARY_HASHES = {'postgres': '6468a969338215cb3912cf9c0b894bdbbd37b9a709926db078e9a5bf8bdc3e16', 'pg_controldata': 'b54c1bdeeab0953598b8447127b2230b1748ea1989dd972e6ee02455f256f180'}

OWNED_TEMP_PARENT = Path('/tmp').resolve()

FIELDS = {'schema_version', 'token', 'creator_uid', 'host', 'port', 'database',
          'setup_role', 'app_role', 'readonly_role', 'data_directory', 'pgpass',
          'postgres', 'postgres_sha256', 'pg_controldata', 'pg_controldata_sha256',
          'system_identifier', 'postmaster_pid', 'server_start_epoch'}


def private_file(path):
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and not path.is_symlink()
    assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600
    assert info.st_nlink == 1
    return path


def owned_local_context(environ):
    assert os.name == 'posix', 'Owned local PostgreSQL admission requires POSIX ownership semantics'
    assert not any(key.startswith('GITHUB_') for key in environ), 'Local mode cannot impersonate CI'
    assert not any(key.startswith('PG') and key != 'PGPASSFILE' for key in environ), 'No libpq overrides in owned mode'
    path = Path(environ.get('ALBUM_HAVEN_OWNED_POSTGRES_MANIFEST', ''))
    assert path.is_absolute() and path == path.resolve(strict=True)
    # Establish the owned temporary namespace before reading any file content.
    match = re.fullmatch(r'albumhaven-pg17-([a-f0-9]{32})', path.parent.name)
    assert match is not None
    token = match[1]
    root = OWNED_TEMP_PARENT / ('albumhaven-pg17-' + token)
    assert path == root / 'ownership.json' and root == root.resolve(strict=True)
    info = root.stat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
    assert stat.S_IMODE(info.st_mode) == 0o700
    private_file(path)
    assert path.stat().st_size <= 16384
    manifest = json.loads(path.read_text())
    assert type(manifest) is dict and set(manifest) == FIELDS
    assert type(manifest['schema_version']) is int and manifest['schema_version'] == 1
    assert manifest['token'] == token
    assert type(manifest['creator_uid']) is int and manifest['creator_uid'] == os.getuid()
    assert manifest['host'] == '127.0.0.1'
    port = manifest['port']
    assert type(port) is int and 1024 <= port <= 65535
    suffix = 'local_' + token
    database = 'album_haven_ci_' + suffix
    roles = {kind: 'album_haven_' + base + '_' + suffix
             for kind, base in [('setup', 'migrator'), ('app', 'app'), ('readonly', 'readonly')]}
    assert manifest['database'] == database
    assert all(manifest[kind + '_role'] == value for kind, value in roles.items())
    assert max(map(len, [database, *roles.values()])) <= 63
    data = root / 'data'
    assert manifest['data_directory'] == str(data) and data == data.resolve(strict=True)
    assert data.stat().st_uid == os.getuid() and stat.S_IMODE(data.stat().st_mode) == 0o700
    for name in ('PG_VERSION', 'postmaster.pid'):
        file = data / name
        info = file.lstat()
        assert stat.S_ISREG(info.st_mode) and not file.is_symlink()
        assert info.st_uid == os.getuid() and info.st_nlink == 1
    assert (data / 'PG_VERSION').read_text().strip() == '17'
    # Server PID/start/port are from the freshly provisioned owned cluster, not a DSN guess.
    lines = (data / 'postmaster.pid').read_text().splitlines()
    assert len(lines) >= 8 and lines[7].strip() == 'ready'
    assert type(manifest['postmaster_pid']) is int and manifest['postmaster_pid'] > 1
    assert type(manifest['server_start_epoch']) is int and manifest['server_start_epoch'] > 0
    assert int(lines[0]) == manifest['postmaster_pid'] and lines[1] == str(data)
    assert int(lines[2]) == manifest['server_start_epoch'] and int(lines[3]) == port
    assert lines[4] == '' and lines[5] == '127.0.0.1'
    os.kill(manifest['postmaster_pid'], 0)
    for name in ('postgres', 'pg_controldata'):
        binary = Path(manifest[name])
        assert binary.is_absolute() and binary == binary.resolve(strict=True)
        assert binary.is_file() and not binary.is_symlink()
        assert hashlib.sha256(binary.read_bytes()).hexdigest() == manifest[name + '_sha256'] == APPROVED_BINARY_HASHES[name]
    assert Path(manifest['postgres']).parent == Path(manifest['pg_controldata']).parent
    # Pure control-file inspection using the reviewed official tool, never a SQL grant.
    control = subprocess.run([manifest['pg_controldata'], str(data)], check=True,
        capture_output=True, text=True, timeout=5,
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}).stdout
    match = re.search(r'^Database system identifier:\s+(\d+)$', control, re.MULTILINE)
    assert match and match[1] == manifest['system_identifier']
    pgpass = root / 'synthetic.pgpass'
    assert manifest['pgpass'] == str(pgpass) and environ.get('PGPASSFILE') == str(pgpass)
    private_file(pgpass)
    setup = f"postgresql://{roles['setup']}@127.0.0.1:{port}/{database}"
    app = f"postgresql://{roles['app']}@127.0.0.1:{port}/{database}"
    assert environ.get('DATABASE_MIGRATOR_URL') == setup
    assert environ.get('DATABASE_APP_URL') == app
    assert environ.get('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL') == app
    return dict(mode='favorites_owned_local17', major=17, database=database,
        setup_role=roles['setup'], app_role=roles['app'], readonly_role=roles['readonly'],
        setup=setup, app=app, pgpass=pgpass, root=root, suffix=suffix,
        port=port, server_start_epoch=manifest['server_start_epoch'])


def assert_owned_local_server(connection, context):
    if context['mode'] != 'favorites_owned_local17':
        return
    row = connection.execute("select host(inet_server_addr()) as host,inet_server_port() as port,"
        "floor(extract(epoch from pg_postmaster_start_time()))::bigint as started").fetchone()
    assert row == dict(host='127.0.0.1', port=context['port'], started=context['server_start_epoch'])
