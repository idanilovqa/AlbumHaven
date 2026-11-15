from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

import pytest

from music_app.services.cover_lookup_tasks_postgres import _load_reusable_notification_sql
from tests.e2e.support import isolatedPostgres


MIGRATION = Path(__file__).resolve().parents[2] / "migrations/postgres/0123_index_cover_notification_track_sets.sql"


def test_track_set_index_migration_keeps_hash_as_prefilter_only():
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    assert "select distinct" in sql
    assert 'order by path collate "c"' in sql
    assert "immutable" in sql
    assert "security invoker" in sql
    assert "set search_path = pg_catalog" in sql
    assert "grant execute on function ops.cover_lookup_track_path_set(jsonb, boolean) to album_haven_app" in sql
    assert "cover_lookup_tasks_windows_track_set_idx" in sql
    assert "cover_lookup_tasks_posix_track_set_idx" in sql
    assert "update ops.cover_lookup_tasks" not in sql


def test_live_track_set_lookup_uses_index_and_preserves_exact_ownership():
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    psycopg = pytest.importorskip("psycopg")
    from psycopg.types.json import Jsonb

    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    prefix = f"track-set-{uuid4()}"
    source = "runtime_cover_lookup_notifications_adapter"
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
            library_id = connection.execute(
                "select libraries.id from app.bootstrap_owners owners join library.libraries libraries "
                "on libraries.owner_account_id=owners.account_id and libraries.name='Local Library' "
                "and libraries.library_kind='local' where owners.owner_key='local-bootstrap-owner'",
            ).fetchone()["id"]
            connection.execute(
                "insert into ops.cover_lookup_tasks (library_id,task_key,status,metadata) "
                "select %s,%s || number::text,'completed',jsonb_build_object('source_family',%s::text, "
                "'track_paths',jsonb_build_array('/unrelated/' || number::text || '/track.flac')) "
                "from generate_series(1,4000) number",
                (library_id, prefix, source),
            )
            for label, paths in (
                ("windows", [r"C:\Music\Old Name\B.flac", r"C:\Music\Old Name\A.flac", r"C:\Music\Old Name\A.flac"]),
                ("posix", ["/Music/Old Name/B.flac", "/Music/Old Name/A.flac"]),
            ):
                connection.execute(
                    "insert into ops.cover_lookup_tasks (library_id,task_key,status,album_key,metadata) "
                    "values (%s,%s,'completed','historical-album-key',%s)",
                    (library_id, prefix + label, Jsonb({"source_family": source, "track_paths": paths})),
                )
            connection.execute("analyze ops.cover_lookup_tasks")
        with isolatedPostgres._connect(runtime_url) as connection:
            for windows_paths, label, paths in (
                (True, "windows", ["c:/music/old name/a.flac", "C:/MUSIC/OLD NAME/B.FLAC"]),
                (False, "posix", ["/Music/Old Name/A.flac", "/Music/Old Name/B.flac"]),
            ):
                sql = _load_reusable_notification_sql(windows_paths=windows_paths)
                params = ([source], [], paths, paths, Jsonb([]), Jsonb([]))
                row = connection.execute(sql, params).fetchone()
                assert row["task_key"] == prefix + label
                plan = connection.execute("explain (analyze, format json) " + sql, params).fetchone()["QUERY PLAN"][0]["Plan"]
                nodes = [plan]
                for node in nodes:
                    nodes.extend(node.get("Plans", []))
                expected_index = f"cover_lookup_tasks_{label}_track_set_idx"
                assert any(node.get("Index Name") == expected_index for node in nodes), plan
                assert not any(node.get("Node Type") == "Seq Scan" and node.get("Relation Name") == "cover_lookup_tasks" for node in nodes), plan
                wrong_paths = [paths[0], paths[1] + ".different"]
                assert connection.execute(sql, ([source], [], wrong_paths, wrong_paths, Jsonb([]), Jsonb([]))).fetchone() is None
            posix_sql = _load_reusable_notification_sql(windows_paths=False)
            lowercase_paths = ["/music/old name/a.flac", "/music/old name/b.flac"]
            assert connection.execute(posix_sql, ([source], [], lowercase_paths, lowercase_paths, Jsonb([]), Jsonb([]))).fetchone() is None
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from ops.cover_lookup_tasks where starts_with(task_key, %s)", (prefix,))


@pytest.mark.parametrize("windows_paths", [True, False])
def test_live_unicode_path_reuse_after_memory_loss_preserves_filesystem_identity(monkeypatch, tmp_path, windows_paths):
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")
    from types import SimpleNamespace
    from psycopg.types.json import Jsonb
    from music_app.services import cover_lookup_tasks_postgres as module

    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    prefix = f"unicode-track-set-{uuid4()}"
    source = "runtime_cover_lookup_notifications_adapter"
    original = str((tmp_path / "МУЗЫКА" / "ПЕСНЯ.flac").resolve())
    variant = str((tmp_path / "музыка" / "песня.flac").resolve())
    sharp_s = str((tmp_path / "Straße.flac").resolve())
    double_s = str((tmp_path / "Strasse.flac").resolve())
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            library_id = connection.execute(
                "select libraries.id from app.bootstrap_owners owners join library.libraries libraries "
                "on libraries.owner_account_id=owners.account_id and libraries.name='Local Library' "
                "and libraries.library_kind='local' where owners.owner_key='local-bootstrap-owner'",
            ).fetchone()["id"]
            for label, path in (("cyrillic", original), ("sharp-s", sharp_s)):
                connection.execute(
                    "insert into ops.cover_lookup_tasks (library_id,task_key,status,metadata) values (%s,%s,'completed',%s)",
                    (library_id, prefix + label, Jsonb({"source_family": source, "track_paths": [path]})),
                )
        # A new adapter sees only durable rows: no process-local lookup task is seeded.
        monkeypatch.setattr(module, "os", SimpleNamespace(name="nt" if windows_paths else "posix"))
        adapter = module.CoverLookupTasksPostgresAdapter(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=isolatedPostgres._connect,
        )
        load = lambda path: adapter.load_reusable_notification({path}, manual_urls=[], excluded_task_ids=set())
        assert load(original)["id"] == prefix + "cyrillic"
        result = load(variant)
        assert (result["id"] if result else None) == (prefix + "cyrillic" if windows_paths else None)
        assert load(sharp_s)["id"] == prefix + "sharp-s"
        assert load(double_s) is None
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from ops.cover_lookup_tasks where task_key = any(%s::text[])", ([prefix + "cyrillic", prefix + "sharp-s"],))
