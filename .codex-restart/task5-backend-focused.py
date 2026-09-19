import os,json,hashlib,subprocess,sys
from pathlib import Path
from urllib.parse import urlparse
import psycopg
from psycopg import sql
session=json.loads(Path('.codex-restart/task5-database-session.json').read_text(encoding='utf-8-sig'))
for line in Path(session['envPath']).read_text(encoding='utf-8-sig').splitlines():
    if '=' in line:
        key,value=line.split('=',1);os.environ[key]=value
url=os.environ['DATABASE_MIGRATOR_URL']
assert urlparse(url).path.startswith('/album_haven_ci_settings_loops_')
app_url=os.environ.get('DATABASE_APP_URL') or os.environ.get('ALBUM_HAVEN_APP_DATABASE_URL')
assert app_url
os.environ['ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL']=app_url
migration=Path('migrations/postgres/0063_scoped_saved_loop_orders.sql')
checksum=hashlib.sha256(migration.read_bytes()).hexdigest()
with psycopg.connect(url) as connection:
    present=connection.execute('select checksum from ops.schema_migrations where migration_name=%s',(migration.name,)).fetchone()
    if present is None:
        connection.execute(migration.read_text())
        connection.execute('insert into ops.schema_migrations(migration_name,checksum) values(%s,%s)',(migration.name,checksum))
    else:
        assert present[0]==checksum,'Migration already applied with different checksum'
    connection.execute(sql.SQL('grant select,insert,update,delete on app.saved_loop_orders to {}').format(sql.Identifier(urlparse(app_url).username)))
print('Task5 isolated migration applied and ledger verified',flush=True)
result=subprocess.run([sys.executable,'-m','pytest','-q','tests/py/test_loop_reorder.py','tests/py/test_loop_scope_boundaries.py','tests/py/test_loop_source_duration_authority.py','tests/py/test_loop_public_projection.py'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
Path('.codex-restart/task5-backend-focused.log').write_text(result.stdout)
print(result.stdout[-18000:])
sys.exit(result.returncode)
