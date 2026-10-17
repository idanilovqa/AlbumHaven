"""Upgrade the repository-owned destructive fixture with the genuine runner.

The existing CI fake-E2E database is locked, reset and restored here. The
persistent contract database is never reset. Missing prerequisites are errors.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

from tests.e2e.support import isolatedPostgres


def _drop_mix_migration_schemas(setup_url):
    with isolatedPostgres._connect(setup_url) as con:
        isolatedPostgres._assert_connected_role(con, isolatedPostgres.SETUP_ROLE)
        # The older four-schema reset omits catalog, whose 0101/0113 CREATE
        # TABLE statements must also start clean on this exclusively owned DB.
        con.execute("drop schema if exists app, integration, library, ops, catalog cascade")


@pytest.fixture
def mix_migration_database():
    setup, runtime = isolatedPostgres.resolve_isolated_database_urls()
    contract_setup, _ = isolatedPostgres.resolve_isolated_database_urls({
        isolatedPostgres.SETUP_DATABASE_ENV: os.environ.get("DATABASE_MIGRATOR_URL", ""),
        isolatedPostgres.RUNTIME_DATABASE_ENV:
            os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", ""),
    })
    # The existing lock identity normalizes loopback aliases and default ports.
    assert isolatedPostgres._database_ownership_lock_identity(setup)[0] != \
        isolatedPostgres._database_ownership_lock_identity(contract_setup)[0], \
        "Migration lifecycle must not reset the persistent contract database"
    pgpass = os.environ.get("PGPASSFILE", "")
    assert pgpass and Path(pgpass).is_file(), "The standard fixture PGPASSFILE is required"
    for url, role in ((setup, isolatedPostgres.SETUP_ROLE), (runtime, isolatedPostgres.RUNTIME_ROLE)):
        with isolatedPostgres._connect(url) as con:
            isolatedPostgres._assert_connected_role(con, role)
    root = Path(__file__).resolve().parents[2] / "migrations" / "postgres"
    baseline = sorted(path for path in root.glob("[0-9][0-9][0-9][0-9]_*.sql")
                      if int(path.name[:4]) <= 114)
    assert baseline and baseline[0].name == "0001_create_current_stack_schemas.sql"
    assert baseline[-1].name == "0114_intrinsic_personal_feature_access.sql"
    assert (root / "0115_playlist_library_mixes.sql").is_file()
    assert (root / "0116_local_track_popularity_mappings.sql").is_file()
    ownership = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=setup)
    ownership.acquire()
    try:
        _drop_mix_migration_schemas(setup)
        with isolatedPostgres._connect(setup) as con:
            assert con.execute("select to_regnamespace('app') as name").fetchone()["name"] is None, \
                "Migration lifecycle requires an empty exclusively owned disposable database"
        # Includes the real checksum ledger and 0083 concurrent-index/autocommit
        # verifier. Never run the whole SQL chain inside one default transaction.
        isolatedPostgres.apply_migrations(setup, baseline)
        yield setup, root
    finally:
        try:
            _drop_mix_migration_schemas(setup)
            isolatedPostgres.prepare_isolated_database(setup, runtime)
        finally:
            ownership.release()


def test_0115_upgrade_preserves_manual_data_enforces_recipe_identity_and_private_grants(mix_migration_database):
    url, root = mix_migration_database
    upgrade = root / "0115_playlist_library_mixes.sql"
    now = datetime.now(timezone.utc)
    token = uuid4().hex
    old_playlist, mix_playlist, source_ref = (str(uuid4()) for _ in range(3))
    with psycopg.connect(url, row_factory=dict_row) as con:
        for role in ("album_haven_app", "album_haven_readonly", "album_haven_migrator"):
            assert con.execute("select 1 from pg_roles where rolname=%s", (role,)).fetchone(), role
        account = con.execute("""insert into app.accounts(display_name,account_kind,
            username_display,username_normalized,contact_email,contact_email_normalized)
            values(%s,'managed_user',%s,%s,%s,%s) returning id""",
            (token, token, token, token + "@example.test", token + "@example.test")).fetchone()["id"]
        library = con.execute("insert into library.libraries(owner_account_id,name) values(%s,%s) returning id",
                              (account, token)).fetchone()["id"]
        con.execute("insert into library.library_memberships(account_id,library_id,membership_role) values(%s,%s,'member')",
                    (account, library))
        session = con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""", (account, hashlib.sha256(uuid4().bytes).digest(),
                now, now, now, now + timedelta(hours=1), now + timedelta(days=1))).fetchone()["id"]
        con.execute("insert into app.playlists(ref,owner_account_id,library_id,title) values(%s,%s,%s,'Before upgrade')",
                    (old_playlist, account, library))
        old = dict(con.execute("select * from app.playlists where ref=%s", (old_playlist,)).fetchone())
        con.commit()
        isolatedPostgres.apply_migrations(url, [upgrade])
        assert dict(con.execute("select * from app.playlists where ref=%s", (old_playlist,)).fetchone()) == old
        assert con.execute("select count(*) as n from app.playlist_library_mixes").fetchone()["n"] == 0
        con.execute("insert into app.playlists(ref,owner_account_id,library_id,title) values(%s,%s,%s,'New mix')",
                    (mix_playlist, account, library))
        con.execute("""insert into app.playlist_creation_sources
            (ref,revision,actor_account_id,session_id,library_id,protocol,source_kind,expires_at,inventory_upper_id)
            values(%s,%s,%s,%s,%s,'library_mix_selection_v1','library',%s,0)""",
            (source_ref, str(uuid4()), account, session, library, now + timedelta(minutes=30)))
        con.execute("""insert into app.playlist_library_mixes
            (playlist_ref,library_id,recipe_version,source,provider,metric,selection_basis,
             songs_per_group,auto_update,last_evaluated_at,coverage)
            values(%s,%s,1,'whole_library','lastfm','overall_scrobbles','per_album',2,true,%s,'{}')""",
            (mix_playlist, library, now))
        con.execute("""insert into app.playlist_items
            (ref,playlist_ref,library_id,position,title,source_kind,source_protocol)
            values(%s,%s,%s,1,'Preserved track','library','library_mix_selection_v1')""",
            (str(uuid4()), mix_playlist, library))
        con.commit()
        assert con.execute("select playback_order from app.playlist_library_mixes where playlist_ref=%s",
                           (mix_playlist,)).fetchone()["playback_order"] == "regular"
        for column, value in (("recipe_version", 2), ("source", "selection"), ("provider", "personal"),
                              ("metric", "listeners"), ("selection_basis", "unknown"),
                              ("songs_per_group", 0), ("songs_per_group", 5001),
                              ("playback_order", "descending")):
            # Identifiers are fixed literals from this test, never external input.
            with pytest.raises(psycopg.errors.CheckViolation):
                with con.transaction():
                    con.execute(f"update app.playlist_library_mixes set {column}=%s where playlist_ref=%s",
                                (value, mix_playlist))
        with pytest.raises(psycopg.errors.CheckViolation):
            with con.transaction():
                con.execute("update app.playlist_library_mixes set coverage='[]' where playlist_ref=%s", (mix_playlist,))
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            with con.transaction():
                con.execute("update app.playlist_library_mixes set library_id=%s where playlist_ref=%s",
                            (library + 1000000000, mix_playlist))
        with pytest.raises(psycopg.errors.UniqueViolation):
            with con.transaction():
                con.execute("insert into app.playlist_library_mixes select * from app.playlist_library_mixes where playlist_ref=%s",
                            (mix_playlist,))
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
            actual = con.execute("""select
                has_table_privilege('album_haven_app','app.playlist_library_mixes',%s) as app,
                has_table_privilege('album_haven_readonly','app.playlist_library_mixes',%s) as readonly""",
                (privilege, privilege)).fetchone()
            assert actual == {"app": privilege in {"SELECT", "INSERT", "UPDATE"}, "readonly": False}
        public = con.execute("""select count(*) as n from pg_class c
            cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) p
            where c.oid='app.playlist_library_mixes'::regclass and p.grantee=0""").fetchone()["n"]
        assert public == 0
        con.execute("delete from app.playlist_creation_sources where ref=%s", (source_ref,))
        assert con.execute("select count(*) as n from app.playlist_library_mixes where playlist_ref=%s",
                           (mix_playlist,)).fetchone()["n"] == 1
        con.execute("delete from app.playlists where ref=%s", (mix_playlist,))
        assert con.execute("select count(*) as n from app.playlist_library_mixes where playlist_ref=%s",
                           (mix_playlist,)).fetchone()["n"] == 0
        assert con.execute("select count(*) as n from app.playlist_items where playlist_ref=%s",
                           (mix_playlist,)).fetchone()["n"] == 0
        assert dict(con.execute("select * from app.playlists where ref=%s", (old_playlist,)).fetchone()) == old
