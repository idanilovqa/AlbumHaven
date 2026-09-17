import os
from urllib.parse import urlparse
import psycopg
url=os.environ['DATABASE_MIGRATOR_URL']
assert urlparse(url).path.startswith('/album_haven_ci_settings_loops_')
with psycopg.connect(url) as connection:
    ids=[row[0] for row in connection.execute("select id from app.accounts where display_name ~ '^loop-order-[a-f0-9]{32}-[01]$'").fetchall()]
    for account in ids:
        connection.execute('delete from library.libraries where owner_account_id=%s',(account,))
        connection.execute('delete from app.accounts where id=%s',(account,))
    print(f'Removed {len(ids)} accounts from failed owned fixture cleanup; no application schemas removed.')