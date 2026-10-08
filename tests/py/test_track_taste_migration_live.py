"""Actual pre-0081 upgrade and importer arbiter compatibility, with no backfill."""
from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import _dedicated_database_urls_or_skip, _drop_application_schemas
from tests.py.test_migrate_app_data_to_postgres import _load_script_module


def snapshot(connection):
    return [r["payload"] for r in connection.execute(
        "select to_jsonb(p) as payload from app.track_preferences p order by id"
    ).fetchall()]


def test_0081_preserves_real_legacy_rows_scopes_uniqueness_and_runs_actual_importer(monkeypatch):
    import psycopg
    from psycopg.types.json import Jsonb
    from music_app.services.track_preferences_postgres import PostgresTrackPreferencesStore

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    ownership = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=setup_url)
    ownership.acquire()
    try:
        _drop_application_schemas(setup_url)
        root = Path(__file__).resolve().parents[2] / "migrations" / "postgres"
        before_paths = sorted(path for path in root.glob("*.sql") if int(path.name[:4]) < 81)
        assert before_paths and int(before_paths[-1].name[:4]) == 80
        migration = root / "legacy" / "0081_scope_track_preferences_by_library.sql"
        assert migration.is_file(), "historical library-scope migration 0081 is missing"
        # Apply the genuine prior migrations in order. Never synthesize a
        # weakened schema or reconstruct the old index on an upgraded database.
        with isolatedPostgres._connect(setup_url) as connection:
            for path in before_paths:
                connection.execute(path.read_text(encoding="utf-8"))
                connection.execute("insert into ops.schema_migrations(migration_name, checksum) values (%s,%s)",
                                   (path.name, hashlib.sha256(path.read_bytes()).hexdigest()))
        isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
        isolatedPostgres.grant_runtime_role_privileges(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            authority = connection.execute("""select o.account_id, l.id as library_id
                from app.bootstrap_owners o join library.libraries l on l.owner_account_id=o.account_id
                where o.owner_key='local-bootstrap-owner' and l.name='Local Library'""").fetchone()
            a, l1 = authority["account_id"], authority["library_id"]
            connection.execute("insert into library.library_memberships(account_id,library_id) values (%s,%s)", (a,l1))
            b = connection.execute("""insert into app.accounts(display_name,account_kind,username_display,
                username_normalized,contact_email,contact_email_normalized)
                values ('Legacy Other','managed_user','legacy-other','legacy-other',
                        'legacy-other@example.test','legacy-other@example.test') returning id""").fetchone()["id"]
            l2 = connection.execute("insert into library.libraries(owner_account_id,name) values (%s,'Legacy Second') returning id", (a,)).fetchone()["id"]
            connection.execute("insert into library.library_memberships(account_id,library_id) values (%s,%s)", (a,l2))
            ids = []
            for library_id, path in ((l1,"/fixture/legacy/one.flac"),(l2,"/fixture/legacy/two.flac")):
                track_id = connection.execute("""insert into library.local_tracks(library_id,track_key,title)
                    values (%s,'legacy-K','Legacy') returning id""", (library_id,)).fetchone()["id"]
                ids.append(track_id)
                connection.execute("insert into library.local_track_files(track_id,private_path,metadata) values (%s,%s,%s)",
                    (track_id,path,Jsonb({"scan_cache":{"stale":False}})))
            rows = [(a,l1,ids[0],"legacy-K",4,"loved"), (a,l1,None,"legacy-clear",None,"off"),
                    (a,l1,None,"unresolved-history",2,"obsessed"), (a,None,None,"legacy-null",5,"loved"),
                    (b,l1,None,"legacy-K",1,"off")]
            for i,row in enumerate(rows):
                connection.execute("""insert into app.track_preferences(account_id,library_id,track_id,
                    track_key,rating,love_tier,updated_at,metadata)
                    values (%s,%s,%s,%s,%s,%s,'2001-02-03T04:05:06Z',%s)""",
                    (*row,Jsonb({"source":"legacy-import","cleared":i==1,"nested":{"i":i}})))
            original = snapshot(connection)
        with pytest.raises(psycopg.errors.UniqueViolation):
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute("insert into app.track_preferences(account_id,library_id,track_key) values (%s,%s,'legacy-K')", (a,l2))
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(migration.read_text(encoding="utf-8"))
            assert snapshot(connection) == original
        with isolatedPostgres._connect(runtime_url) as connection:
            isolatedPostgres._assert_connected_role(connection, isolatedPostgres.RUNTIME_ROLE)
            connection.execute("insert into app.track_preferences(account_id,library_id,track_key,rating) values (%s,%s,'legacy-K',3)", (a,l2))
        for library_id,key in ((l1,"legacy-K"),(None,"legacy-null")):
            with pytest.raises(psycopg.errors.UniqueViolation):
                with isolatedPostgres._connect(runtime_url) as connection:
                    connection.execute("insert into app.track_preferences(account_id,library_id,track_key) values (%s,%s,%s)", (a,library_id,key))
        # Execute the real artifact importer statement, not a text assertion of
        # ON CONFLICT. Preserve artifact-key/bootstrap authority and metadata.
        importer = _load_script_module()
        with isolatedPostgres._connect(runtime_url) as connection:
            connection.execute(importer._upsert_track_preference_sql(),
                ("legacy-K",5,"obsessed",Jsonb({"source":"phase_6_json_file_backfill","actor_id":"local"})))
        repository = PostgresTrackPreferencesStore({"ALBUM_HAVEN_APP_DATABASE_URL":runtime_url})
        lookup = repository.load_track_preferences(["/fixture/legacy/one.flac"], account_id=a, library_id=l1)
        assert lookup["/fixture/legacy/one.flac"]["rating"] == 5
        assert lookup["/fixture/legacy/one.flac"]["preference_id"] == original[0]["id"]
        assert repository.load_track_preferences(["/fixture/legacy/two.flac"], account_id=a, library_id=l2)["/fixture/legacy/two.flac"]["rating"] == 3
        with isolatedPostgres._connect(setup_url) as connection:
            after = snapshot(connection)
            by_id = {row["id"]:row for row in after}
            assert all(by_id[row["id"]] == row for row in original[1:])
            assert by_id[original[0]["id"]]["metadata"]["nested"] == {"i":0}
            assert by_id[original[0]["id"]]["track_id"] == ids[0]
    finally:
        # Restore a fully migrated fixture database even after an assertion
        # fails; no test's success/order is a prerequisite for another test.
        try:
            _drop_application_schemas(setup_url)
            isolatedPostgres.prepare_isolated_database(setup_url,runtime_url)
        finally:
            ownership.release()
