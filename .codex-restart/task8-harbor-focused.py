import os
import json
import subprocess
import sys
import hashlib
from pathlib import Path
from urllib.parse import urlparse

session = json.loads(Path('.codex-restart/task5-database-session.json').read_text(encoding='utf-8-sig'))
for line in Path(session['envPath']).read_text(encoding='utf-8-sig').splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        os.environ[key] = value
runtime = os.environ['DATABASE_APP_URL']
setup = os.environ['DATABASE_MIGRATOR_URL']
assert urlparse(runtime).hostname in {'localhost', '127.0.0.1', '::1'}
assert urlparse(runtime).path.startswith('/album_haven_ci_settings_loops_')
assert urlparse(runtime).path == urlparse(setup).path
os.environ['ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL'] = runtime
if '--apply-style-migration' in sys.argv:
    import psycopg
    migration = Path('migrations/postgres/0066_allow_harbor_mint_appearance_palette.sql')
    checksum = hashlib.sha256(migration.read_bytes()).hexdigest()
    with psycopg.connect(setup) as connection:
        row = connection.execute('select checksum from ops.schema_migrations where migration_name=%s', (migration.name,)).fetchone()
        if row is None:
            connection.execute(migration.read_text(encoding='utf-8'))
            connection.execute('insert into ops.schema_migrations(migration_name,checksum) values(%s,%s)', (migration.name, checksum))
        else:
            assert row[0] == checksum
    print('Appearance style migration applied to isolated contract database.', flush=True)
latest = Path('.codex-restart/task8-python-latest.log')
red = Path('.codex-restart/task8-python-red.log')
if latest.exists() and not red.exists():
    red.write_text(latest.read_text(encoding='utf-8'), encoding='utf-8')
result = subprocess.run([
    sys.executable, '-m', 'pytest', '-q',
        'tests/py/test_settings_loop_style_postgres.py',
], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
Path('.codex-restart/task8-python-latest.log').write_text(result.stdout, encoding='utf-8')
print(result.stdout[-18000:])
sys.exit(result.returncode)
