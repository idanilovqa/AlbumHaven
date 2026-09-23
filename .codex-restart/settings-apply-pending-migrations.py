import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import psycopg
from psycopg import sql

session = json.loads(Path('.codex-restart/settings-validation-session.json').read_text(encoding='utf-8-sig'))
for line in Path(session['envPath']).read_text(encoding='utf-8-sig').splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        os.environ[key] = value
setup, runtime = os.environ['DATABASE_MIGRATOR_URL'], os.environ['DATABASE_APP_URL']
for value in (setup, runtime):
    target = urlparse(value)
    assert target.hostname in {'127.0.0.1', 'localhost'}
    assert target.path == '/album_haven_ci_local_settings_003bf4a0ba'
with psycopg.connect(setup) as connection:
    loops_sql = 'select id,loop_key,account_id,library_id,loop_private_path,start_seconds,end_seconds from app.saved_loops order by id'
    loops = connection.execute(loops_sql).fetchall()
    media = {row[4]: hashlib.sha256(Path(row[4]).read_bytes()).hexdigest()
             for row in loops if row[4] and Path(row[4]).is_file()}
    appearance_sql = "select to_jsonb(p)-'loop_control_style' from app.user_appearance_preferences p order by account_id,client_profile"
    appearance = connection.execute(appearance_sql).fetchall()
    for name in ('0064_scoped_operational_log_versions.sql', '0065_appearance_loop_control_style.sql', '0066_allow_harbor_mint_appearance_palette.sql', '0067_measured_local_listen_sessions.sql'):
        migration = Path('migrations/postgres') / name
        checksum = hashlib.sha256(migration.read_bytes()).hexdigest()
        row = connection.execute('select checksum from ops.schema_migrations where migration_name=%s', (name,)).fetchone()
        if row is None:
            connection.execute(migration.read_text(encoding='utf-8'))
            connection.execute('insert into ops.schema_migrations(migration_name,checksum) values(%s,%s)', (name, checksum))
        else:
            assert row[0] == checksum, 'Migration checksum mismatch'
    role = sql.Identifier(urlparse(runtime).username)
    connection.execute(sql.SQL('grant select,insert,update on ops.log_history_heads to {}').format(role))
    connection.execute(sql.SQL('grant select,insert,delete on ops.log_history_events to {}').format(role))
    assert loops == connection.execute(loops_sql).fetchall()
    assert appearance == connection.execute(appearance_sql).fetchall()
    assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest for path, digest in media.items())
print(f'Manual migrations 0064/0065/0066/0067 verified; {len(loops)} loop rows, {len(media)} media files and existing Appearance values preserved.')
