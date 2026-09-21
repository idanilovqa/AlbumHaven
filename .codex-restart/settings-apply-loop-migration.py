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
url = os.environ['DATABASE_MIGRATOR_URL']
app_url = os.environ['DATABASE_APP_URL']
for candidate in (url, app_url):
    parsed = urlparse(candidate)
    assert parsed.hostname in ('127.0.0.1', 'localhost')
    assert parsed.path == '/album_haven_ci_local_settings_003bf4a0ba'
migration = Path('migrations/postgres/0063_scoped_saved_loop_orders.sql')
checksum = hashlib.sha256(migration.read_bytes()).hexdigest()
identity_sql = 'select id,loop_key,account_id,library_id,source_private_path,loop_private_path,start_seconds,end_seconds from app.saved_loops order by id'
with psycopg.connect(url) as connection:
    before = connection.execute(identity_sql).fetchall()
    file_hashes = {row[5]: hashlib.sha256(Path(row[5]).read_bytes()).hexdigest() for row in before if row[5] and Path(row[5]).is_file()}
    present = connection.execute('select checksum from ops.schema_migrations where migration_name=%s', (migration.name,)).fetchone()
    if present is None:
        connection.execute(migration.read_text(encoding='utf-8'))
        connection.execute('insert into ops.schema_migrations(migration_name,checksum) values(%s,%s)', (migration.name, checksum))
    else:
        assert present[0] == checksum, 'Migration checksum mismatch'
    connection.execute(sql.SQL('grant select,insert,update,delete on app.saved_loop_orders to {}').format(sql.Identifier(urlparse(app_url).username)))
    assert before == connection.execute(identity_sql).fetchall(), 'Loop identity/source coordinates changed'
    assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest for path, digest in file_hashes.items()), 'Saved audio changed'
print(f'Manual database migration verified; {len(before)} saved rows and {len(file_hashes)} media files preserved.')
