"""Seed a dedicated generated-media demo, then run the unchanged ASGI application.

Never point this launcher at a real library. Database identity and an existing
ownership marker are checked before any schema or data write. No test server,
reset route, published test credential, or application mock is started.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
MARKER = "albumhaven-generated-render-demo-v1"
DEMO_ROOT = Path("/tmp/albumhaven-mobile-demo")
DATABASE_NAMES = frozenset({"albumhaven_mobile_demo_db", "album_haven_ci_render_demo"})
LOCK_ID = 748241095817


class DemoConfigurationError(ValueError):
    """A safe-to-display deployment configuration error."""


def validate_database_url(value: str, expected_host: str) -> str:
    """Fail closed on a missing secret or a different database/host."""
    if not value:
        raise DemoConfigurationError("Set ALBUM_HAVEN_DEMO_DATABASE_URL to the demo database's Internal Database URL in Render Environment.")
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme in {"postgres", "postgresql"}
                 and unquote(parsed.path.removeprefix("/")) in DATABASE_NAMES
                 and bool(expected_host) and parsed.hostname == expected_host
                 and parsed.port in {None, 5432}
                 and bool(parsed.username) and bool(parsed.password)
                 and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise DemoConfigurationError("Demo database identity is invalid; refusing to connect. Use the dedicated demo database's internal URL.")
    return value


def runtime_database_url(admin_url: str, password: str) -> str:
    from urllib.parse import quote
    parsed = urlsplit(admin_url)
    host = f"[{parsed.hostname}]" if ":" in str(parsed.hostname) else parsed.hostname
    authority = f"album_haven_app:{quote(password, safe='')}@{host}:5432"
    return urlunsplit(("postgresql", authority, parsed.path, "", ""))


def configure_environment(runtime_url: str) -> None:
    origin = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("ALBUM_HAVEN_PUBLIC_BASE_URL", "")
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise DemoConfigurationError("The demo requires its credential-free public HTTPS origin.")
    if len(os.environ.get("ALBUM_HAVEN_AUTH_HMAC_SECRET", "").encode()) < 32:
        raise DemoConfigurationError("ALBUM_HAVEN_AUTH_HMAC_SECRET must contain at least 32 bytes.")
    for path in (DEMO_ROOT / "media", DEMO_ROOT / "app-data"):
        path.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "ALBUM_HAVEN_PUBLIC_BASE_URL": origin.rstrip("/"),
        "ALBUM_HAVEN_TRUSTED_ORIGINS": origin.rstrip("/"),
        "ALBUM_HAVEN_BOOTSTRAP_USERNAME": "Rendref",
        "ALBUM_HAVEN_BOOTSTRAP_EMAIL": "demo@example.test",
        "ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted",
        "ALBUM_HAVEN_LIBRARY_BROWSE_BASES": "[]",
        "ALBUM_HAVEN_PERSISTENCE_DEFAULT": "postgres",
        "ALBUM_HAVEN_COVER_PROVIDER_GROUPS": "offline",
        "MUSICBRAINZ_ENABLED": "0",
        "ALBUM_HAVEN_WELCOME_EMAIL_ENABLED": "false",
        "ALBUM_HAVEN_PASSWORD_RESET_EMAIL_ENABLED": "false",
        "ALBUM_HAVEN_INVITATION_EMAIL_ENABLED": "false",
        "ALBUM_HAVEN_AUTH_VERIFICATION_SEMAPHORE": "1",
        "ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED": "0",
        "MUSIC_DIR": str(DEMO_ROOT / "media"),
        "MUSIC_APP_DATA_DIR": str(DEMO_ROOT / "app-data"),
    })
    # No real integration accounts or mail delivery belong in a generated demo.
    for key in ("LASTFM_API_KEY", "LASTFM_API_SECRET", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET",
                "DISCOGS_CONSUMER_KEY", "DISCOGS_CONSUMER_SECRET", "ALBUM_HAVEN_SMTP_USERNAME", "ALBUM_HAVEN_SMTP_PASSWORD"):
        os.environ[key] = ""


def assert_demo_ownership(connection) -> bool:
    """Return whether this is the first seed, rejecting unrelated existing data."""
    exists = connection.execute("select to_regclass('app.bootstrap_owners')").fetchone()[0]
    if exists is None:
        occupied = connection.execute("select count(*) from information_schema.tables where table_schema in ('app','library','integration','ops')").fetchone()[0]
        if occupied:
            raise RuntimeError("Refusing to seed an existing non-demo schema.")
        return True
    rows = connection.execute("select metadata->>'deployment' from app.bootstrap_owners").fetchall()
    if rows != [(MARKER,)]:
        raise RuntimeError("Refusing to seed a database without the generated-demo ownership marker.")
    return False


def apply_migrations(connection) -> None:
    paths = sorted((ROOT / "migrations" / "postgres").glob("[0-9]*.sql"))
    if not paths:
        raise RuntimeError("No repository migrations found.")
    ledger = connection.execute("select to_regclass('ops.schema_migrations')").fetchone()[0]
    applied = dict(connection.execute("select migration_name, checksum from ops.schema_migrations").fetchall()) if ledger else {}
    for path in paths:
        checksum = hashlib.sha256(path.read_bytes()).hexdigest()
        if path.name in applied:
            if applied[path.name] != checksum:
                raise RuntimeError(f"Migration checksum mismatch: {path.name}")
            continue
        connection.execute(path.read_text(encoding="utf-8"))
        connection.execute("insert into ops.schema_migrations (migration_name, checksum) values (%s,%s)", (path.name, checksum))


def provision(admin_url: str, runtime_url: str, app_password: str, password_hash: str) -> None:
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb

    with psycopg.connect(admin_url, autocommit=True, connect_timeout=15) as lock:
        lock.execute("set lock_timeout = '60s'")
        lock.execute("set statement_timeout = '120s'")
        lock.execute("select pg_advisory_lock(%s)", (LOCK_ID,))
        try:
            with lock.transaction():
                first_seed = assert_demo_ownership(lock)
                for role in ("album_haven_migrator", "album_haven_readonly", "album_haven_app"):
                    found = lock.execute("select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname=%s", (role,)).fetchone()
                    if found is None:
                        lock.execute(sql.SQL("create role {} nologin").format(sql.Identifier(role)))
                    elif any(found):
                        raise RuntimeError("Refusing an overprivileged existing demo role.")
                lock.execute(sql.SQL("alter role album_haven_app login password {}").format(sql.Literal(app_password)))
                apply_migrations(lock)
                print("Demo migrations applied.", flush=True)
                if first_seed:
                    metadata = Jsonb({"deployment": MARKER})
                    account_id = lock.execute("""insert into app.accounts
                        (display_name, account_kind, username_display, username_normalized, contact_email, contact_email_normalized, metadata)
                        values ('Rendref','bootstrap_owner','Rendref','rendref','demo@example.test','demo@example.test',%s) returning id""", (metadata,)).fetchone()[0]
                    lock.execute("insert into app.bootstrap_owners (account_id,owner_key,metadata) values (%s,'local-bootstrap-owner',%s)", (account_id, metadata))
                    lock.execute("insert into library.libraries (owner_account_id,name,library_kind,metadata) values (%s,'Local Library','local',%s)", (account_id, metadata))

            from config import build_auth_config
            from music_app.services.auth_bootstrap_postgres import PostgresAuthBootstrapService
            credential_exists = lock.execute("select exists(select 1 from app.account_credentials c join app.bootstrap_owners o on c.account_id=o.account_id where o.owner_key='local-bootstrap-owner')").fetchone()[0]
            if not credential_exists:
                auth = build_auth_config()
                auth["ALBUM_HAVEN_APP_DATABASE_URL"] = runtime_url
                PostgresAuthBootstrapService(auth).reconcile_owner(encoded_hash=password_hash, hash_policy_version=auth["argon2_policy_version"])

            # Reuse only the media generator before starting the real application.
            # Never import or start phase7AuthApp's control/reset/SMTP servers.
            support = ROOT / "tests" / "e2e" / "support"
            sys.path.insert(0, str(support))
            from mobileLayoutFixture import prepare_mobile_layout_media
            from phase7PlaybackFixture import persist_settings_playback_inventory
            inventory = prepare_mobile_layout_media(DEMO_ROOT / "media")
            persist_settings_playback_inventory(admin_url, DEMO_ROOT / "media", inventory)
            sys.path.remove(str(support))
            with lock.transaction():
                account_id = lock.execute("select account_id from app.bootstrap_owners where owner_key='local-bootstrap-owner'").fetchone()[0]
                already_seeded = lock.execute("select exists(select 1 from integration.listen_history where account_id=%s and source_family=%s)", (account_id, MARKER)).fetchone()[0]
                if not already_seeded:
                    albums = lock.execute("select min(t.id),t.library_id,a.album_key from library.local_tracks t join library.local_albums a on a.id=t.album_id group by t.library_id,a.album_key order by a.album_key limit 8").fetchall()
                    for index, (track_id, library_id, album_key) in enumerate(albums):
                        lock.execute("""insert into integration.listen_history
                            (account_id,library_id,track_id,played_at,listen_source,source_family,source_entry_id)
                            values (%s,%s,%s,%s,'local',%s,%s)""", (account_id,library_id,track_id,datetime.now(timezone.utc)-timedelta(minutes=index*13),MARKER,album_key))
            with psycopg.connect(runtime_url, connect_timeout=15) as runtime:
                if runtime.execute("select current_user").fetchone()[0] != "album_haven_app":
                    raise RuntimeError("Runtime did not assume the restricted application role.")
                if runtime.execute("select has_schema_privilege(current_user,'app','CREATE')").fetchone()[0]:
                    raise RuntimeError("Runtime role unexpectedly has schema creation privileges.")
            print(f"Generated demo ready: {len(inventory)} tracks; existing credentials and preferences retained.", flush=True)
        finally:
            lock.execute("select pg_advisory_unlock(%s)", (LOCK_ID,))


def prepare() -> None:
    admin_url = validate_database_url(os.environ.get("ALBUM_HAVEN_DEMO_DATABASE_URL", ""), os.environ.get("ALBUM_HAVEN_DEMO_DATABASE_HOST", ""))
    app_password = os.environ.get("ALBUM_HAVEN_DEMO_APP_DB_PASSWORD", "")
    password_hash = os.environ.get("ALBUM_HAVEN_DEMO_PASSWORD_HASH", "")
    if len(app_password) < 32 or not password_hash.startswith("$argon2id$"):
        raise DemoConfigurationError("A random application DB password and an Argon2id demo login hash are required.")
    runtime_url = runtime_database_url(admin_url, app_password)
    configure_environment(runtime_url)
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    provision(admin_url, runtime_url, app_password, password_hash)
    # The serving process does not need the database-owner connection or seed hash.
    for key in ("ALBUM_HAVEN_DEMO_DATABASE_URL", "ALBUM_HAVEN_DEMO_PASSWORD_HASH", "ALBUM_HAVEN_DEMO_APP_DB_PASSWORD"):
        os.environ.pop(key, None)


def main() -> None:
    prepare()
    from music_app import create_asgi_app
    import uvicorn
    uvicorn.run(create_asgi_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "10000")),
                proxy_headers=True, forwarded_allow_ips=os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1"),
                log_level="info", access_log=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Never print database URLs, credentials, query parameters, or raw SQL errors.
        detail = str(exc) if isinstance(exc, DemoConfigurationError) else "See the deployment guide and verify database privileges/configuration."
        print(f"Demo startup stopped ({type(exc).__name__}): {detail}", file=sys.stderr, flush=True)
        raise SystemExit(1)
