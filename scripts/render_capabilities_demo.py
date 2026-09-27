"""Seed synthetic capabilities-demo accounts/media, then serve the real app.

No test control server, auth bypass, JSON persistence, or mobile-demo database.
Only this deployment's marked Neon database can be initialized. Existing
account credentials, role choices and individual grants survive restarts.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import quote, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
DEMO_ROOT = Path('/tmp/albumhaven-capabilities-demo')
MARKER = 'albumhaven-capabilities-demo-v1'
LOCK_ID = 748241095829
ACCOUNTS = (
    ('demo.admin', ('admin',), (), True),
    ('demo.owner', ('owner',), (), True),
    ('demo.adminowner', ('admin', 'owner'), (), True),
    ('demo.viewer', ('viewer',), (), True),
    ('demo.listener', ('listener',), (), True),
    ('demo.musician', ('musician',), (), True),
    ('demo.practice', ('viewer',), ('capability.practice',), True),
    ('demo.custom', (), ('library.browse.read',), True),
    ('demo.disabled', ('listener',), (), False),
    ('demo.nocapabilities', (), (), True),
)


def configure(runtime_url: str) -> None:
    origin = os.environ.get('RENDER_EXTERNAL_URL') or os.environ.get('ALBUM_HAVEN_PUBLIC_BASE_URL', '')
    url = urlsplit(origin)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.path not in {'', '/'} or url.query or url.fragment
            or not url.hostname.startswith('albumhaven-capabilities-')
            or not url.hostname.endswith('.onrender.com')):
        raise ValueError('This launcher is restricted to its separately named capabilities Render service.')
    if len(os.environ.get('ALBUM_HAVEN_AUTH_HMAC_SECRET', '').encode()) < 32:
        raise ValueError('A random deployment HMAC secret is required.')
    for path in (DEMO_ROOT / 'main', DEMO_ROOT / 'hoard', DEMO_ROOT / 'new', DEMO_ROOT / 'app-data'):
        path.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        'ALBUM_HAVEN_APP_DATABASE_URL': runtime_url,
        'ALBUM_HAVEN_PUBLIC_BASE_URL': origin.rstrip('/'),
        'ALBUM_HAVEN_TRUSTED_ORIGINS': origin.rstrip('/'),
        'ALBUM_HAVEN_BOOTSTRAP_USERNAME': 'Rendref',
        'ALBUM_HAVEN_BOOTSTRAP_EMAIL': 'capabilities-recovery@example.test',
        'ALBUM_HAVEN_DEPLOYMENT_MODE': 'self_hosted',
        'ALBUM_HAVEN_LIBRARY_BROWSE_BASES': '[]',
        'ALBUM_HAVEN_PERSISTENCE_DEFAULT': 'postgres',
        'ALBUM_HAVEN_COVER_PROVIDER_GROUPS': 'offline',
        'MUSICBRAINZ_ENABLED': '0',
        'ALBUM_HAVEN_WELCOME_EMAIL_ENABLED': 'false',
        'ALBUM_HAVEN_PASSWORD_RESET_EMAIL_ENABLED': 'false',
        'ALBUM_HAVEN_INVITATION_EMAIL_ENABLED': 'false',
        'ALBUM_HAVEN_AUTH_VERIFICATION_SEMAPHORE': '1',
        'ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED': '0',
        'MUSIC_DIR': str(DEMO_ROOT / 'main'),
        'MUSIC_APP_DATA_DIR': str(DEMO_ROOT / 'app-data'),
    })
    for key in ('LASTFM_API_KEY', 'LASTFM_API_SECRET', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET',
                'DISCOGS_CONSUMER_KEY', 'DISCOGS_CONSUMER_SECRET'):
        os.environ[key] = ''
    for key in tuple(os.environ):
        if key.startswith('ALBUM_HAVEN_SMTP_'):
            os.environ.pop(key, None)


def application_url(admin_url: str, password: str) -> str:
    url = urlsplit(admin_url)
    return urlunsplit(('postgresql', f'album_haven_app:{quote(password, safe="")}@{url.hostname}:5432', url.path, url.query, ''))


def assert_ownership(connection) -> bool:
    exists = connection.execute("select to_regclass('app.bootstrap_owners')").fetchone()[0]
    if exists is None:
        occupied = connection.execute("select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema') and table_type='BASE TABLE'").fetchone()[0]
        if occupied:
            raise ValueError('Refusing to initialize unrelated application schemas.')
        return True
    rows = connection.execute("select metadata->>'deployment' from app.bootstrap_owners").fetchall()
    if rows != [(MARKER,)]:
        raise ValueError('Database is not owned by the capabilities demo; refusing writes.')
    return False


def migrate(connection) -> None:
    files = sorted((ROOT / 'migrations' / 'postgres').glob('[0-9]*.sql'))
    if not files:
        raise RuntimeError('Migrations are missing.')
    ledger = connection.execute("select to_regclass('ops.schema_migrations')").fetchone()[0]
    applied = dict(connection.execute('select migration_name, checksum from ops.schema_migrations').fetchall()) if ledger else {}
    for path in files:
        checksum = hashlib.sha256(path.read_bytes()).hexdigest()
        if path.name in applied:
            if applied[path.name] != checksum:
                raise ValueError('Migration checksum changed: ' + path.name)
            continue
        print('Capabilities demo migration: ' + path.name, flush=True)
        connection.execute(path.read_text(encoding='utf-8'))
        connection.execute('insert into ops.schema_migrations (migration_name,checksum) values (%s,%s)', (path.name, checksum))


def generate_media() -> dict[str, dict]:
    from PIL import Image, ImageDraw
    import imageio_ffmpeg
    from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    inventory = {}
    artists = ('Copper Satellites', 'Velvet Geometry', 'Northbound Lanterns', 'Paper Observatory')
    albums = ('Quiet Circuits', 'Glass Horizons', 'Autumn Signals', 'Practice Sketches', 'Night Atlas', 'Open Windows', 'Tidal Rooms', 'Small Constellations')
    for album_index, album in enumerate(albums):
        artist = artists[album_index // 2]
        category, directory = ('main_library', 'main') if album_index < 6 else (('hoard', 'hoard') if album_index == 6 else ('new_arrivals', 'new'))
        folder = DEMO_ROOT / directory / artist / album
        folder.mkdir(parents=True, exist_ok=True)
        cover = folder / 'cover.png'
        if not cover.exists():
            image = Image.new('RGB', (480, 480), (20 + album_index * 14, 42, 85 + album_index * 12))
            draw = ImageDraw.Draw(image)
            for ring in range(6):
                offset = 40 + ring * 22
                draw.ellipse((offset, offset, 480-offset, 480-offset), outline=(160, 210-ring*10, 190), width=4)
            draw.text((28, 405), artist, fill='white')
            draw.text((28, 435), album, fill='white')
            image.save(cover)
        for number in (1, 2):
            title = ('First Light', 'Second Passage')[number-1]
            track = folder / f'{number:02d} - {title}.mp3'
            duration = 45
            if not track.exists():
                subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
                    '-i', f'sine=frequency={220+album_index*24+number*12}:duration={duration}',
                    '-af', 'volume=0.15,afade=t=in:d=1,afade=t=out:st=43:d=2',
                    '-c:a', 'libmp3lame', '-b:a', '64k', '-metadata', f'artist={artist}',
                    '-metadata', f'album_artist={artist}', '-metadata', f'album={album}',
                    '-metadata', f'title={title}', '-metadata', f'track={number}',
                    '-metadata', 'date=2026', '-metadata', 'genre=Demo Instrumental', str(track)],
                    check=True, timeout=45, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            stat = track.stat()
            inventory[str(track)] = dict(path=str(track), mtime=stat.st_mtime, size=stat.st_size,
                artist=artist, album_artist=artist, album=album, title=title, genre='Demo Instrumental',
                year=2026, track_number=number, disc_number=1, disc_number_raw='1',
                duration_seconds=duration, duration_display='0:45', cover_path=str(cover),
                library_root_id='capabilities-'+directory, library_root_category=category,
                metadata_schema_version=FILE_METADATA_SCHEMA_VERSION)
    return inventory


def seed_inventory(admin_url: str, inventory: dict) -> None:
    from music_app.services.library_roots import library_root_cache_identity, save_library_root_settings
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    config = dict(ALBUM_HAVEN_APP_DATABASE_URL=admin_url, MUSIC_DIR=DEMO_ROOT/'main',
        CACHE_PATH=DEMO_ROOT/'app-data'/'inert-cache.json',
        LIBRARY_ROOTS_PATH=DEMO_ROOT/'app-data'/'inert-roots.json',
        PERSISTENCE_BACKENDS={'library_roots':'postgres', 'scan_cache':'postgres'})
    settings = {key: [dict(id='capabilities-'+directory, path=str(DEMO_ROOT/directory), layout_mode='artist')]
        for key,directory in [('main_library_roots','main'),('hoarding_library_roots','hoard'),('new_arrivals_roots','new')]}
    save_library_root_settings(config, settings)
    PostgresScanCacheAdapter(config).save_snapshot(config['CACHE_PATH'], inventory, library_root_cache_identity(config), time.time())


def prepare() -> None:
    from capabilities_demo_database import read_database_configuration
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb
    metadata = read_database_configuration()
    admin_url = metadata['connection_string']
    app_password = os.environ.get('ALBUM_HAVEN_CAPS_APP_DB_PASSWORD', '')
    hashes = json.loads(os.environ.get('ALBUM_HAVEN_CAPS_PASSWORD_HASHES', '{}'))
    if len(app_password) < 32 or set(hashes) != {'Rendref', *(row[0] for row in ACCOUNTS)} or any(not value.startswith('$argon2id$') for value in hashes.values()):
        raise ValueError('Separate strong database password and demo password hashes are required.')
    runtime_url = application_url(admin_url, app_password)
    configure(runtime_url)
    from music_app.services.capability_assignments import build_assignment, store_assignment
    with psycopg.connect(admin_url, autocommit=True, connect_timeout=30) as connection:
        connection.execute("set lock_timeout='60s'")
        connection.execute("set statement_timeout='120s'")
        connection.execute('select pg_advisory_lock(%s)', (LOCK_ID,))
        try:
            with connection.transaction():
                first = assert_ownership(connection)
                for role in ('album_haven_migrator','album_haven_readonly','album_haven_app'):
                    existing = connection.execute('select rolsuper,rolcreaterole,rolcreatedb,rolbypassrls from pg_roles where rolname=%s',(role,)).fetchone()
                    if existing is None:
                        connection.execute(sql.SQL('create role {} nologin').format(sql.Identifier(role)))
                    elif first:
                        raise ValueError('Reserved application roles already exist outside this demo; refusing to reuse them.')
                    elif any(existing):
                        raise ValueError('Refusing an overprivileged existing application role.')
                connection.execute(sql.SQL('alter role album_haven_app login password {}').format(sql.Literal(app_password)))
                migrate(connection)
                if first:
                    marker = Jsonb({'deployment':MARKER})
                    owner = connection.execute("insert into app.accounts (display_name,account_kind,username_display,username_normalized,contact_email,contact_email_normalized,metadata) values ('Rendref','bootstrap_owner','Rendref','rendref','capabilities-recovery@example.test','capabilities-recovery@example.test',%s) returning id", (marker,)).fetchone()[0]
                    connection.execute("insert into app.bootstrap_owners(account_id,owner_key,metadata) values (%s,'local-bootstrap-owner',%s)",(owner,marker))
                    library = connection.execute("insert into library.libraries(owner_account_id,name,library_kind,metadata) values (%s,'Local Library','local',%s) returning id",(owner,marker)).fetchone()[0]
                    connection.execute("insert into library.library_memberships(library_id,account_id,membership_role) values (%s,%s,'owner')",(library,owner))
                    connection.execute("insert into app.account_credentials(account_id,encoded_hash,hash_algorithm,hash_policy_version,credential_version,administrator_set) values (%s,%s,'argon2id',1,1,false)",(owner,hashes['Rendref']))
                library = connection.execute("select l.id from library.libraries l join app.bootstrap_owners b on l.owner_account_id=b.account_id where b.owner_key='local-bootstrap-owner' and l.library_kind='local'").fetchone()[0]
                complete = connection.execute("select metadata->>'capabilities_seed_complete' from library.libraries where id=%s",(library,)).fetchone()[0] == 'true'
            inventory = generate_media()
            if not complete:
                seed_inventory(admin_url, inventory)
                with connection.transaction():
                    for name, roles, additions, active in ACCOUNTS:
                        assignment = build_assignment(list(roles), list(additions), allow_empty=True)
                        existing = connection.execute('select id,metadata from app.accounts where username_normalized=%s',(name,)).fetchone()
                        if existing:
                            if existing[1].get('deployment') != MARKER:
                                raise ValueError('An unrelated account conflicts with demo seeding.')
                            continue
                        account = connection.execute("insert into app.accounts(display_name,account_kind,username_display,username_normalized,contact_email,contact_email_normalized,is_active,disabled_at,metadata) values (%s,'managed_user',%s,%s,%s,%s,%s,case when %s then null else now() end,%s) returning id",(name,name,name,name+'@example.test',name+'@example.test',active,active,Jsonb({'deployment':MARKER}))).fetchone()[0]
                        connection.execute("insert into library.library_memberships(library_id,account_id,membership_role) values (%s,%s,'member')",(library,account))
                        for key in assignment.effective_keys:
                            connection.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values (%s,%s,'library',%s)",(account,key,library))
                        store_assignment(connection, account_id=account, library_id=library, assignment=assignment)
                        connection.execute("insert into app.account_credentials(account_id,encoded_hash,hash_algorithm,hash_policy_version,credential_version,administrator_set) values (%s,%s,'argon2id',1,1,false)",(account,hashes[name]))
                    connection.execute("update library.libraries set metadata=metadata || '{\"capabilities_seed_complete\":true}'::jsonb where id=%s",(library,))
            with psycopg.connect(runtime_url, connect_timeout=30) as runtime:
                if runtime.execute('select current_user').fetchone()[0] != 'album_haven_app' or runtime.execute("select has_schema_privilege(current_user,'app','CREATE')").fetchone()[0]:
                    raise RuntimeError('Application database privilege isolation failed.')
            print(f'CAPS_DEMO_READY users=11 albums=8 tracks={len(inventory)} existing_assignments_preserved={complete}',flush=True)
        finally:
            connection.execute('select pg_advisory_unlock(%s)',(LOCK_ID,))
    # The serving app receives only its restricted database identity.
    for key in tuple(os.environ):
        if key.startswith('ALBUM_HAVEN_CAPS_'):
            os.environ.pop(key, None)


def main() -> None:
    if str(ROOT) not in sys.path:
        sys.path.insert(0,str(ROOT))
    prepare()
    from music_app import create_asgi_app
    import uvicorn
    uvicorn.run(create_asgi_app(),host='0.0.0.0',port=int(os.environ.get('PORT','10000')),
        proxy_headers=True,forwarded_allow_ips='*',log_level='info',access_log=False)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Preserve useful stage/type evidence, never credentials or SQL parameters.
        print(f'Capabilities demo stopped: {type(exc).__name__}; SQLSTATE={getattr(exc,"sqlstate","n/a")}',file=sys.stderr,flush=True)
        raise SystemExit(1)
