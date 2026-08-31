from __future__ import annotations

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

from tests.e2e.support import isolatedPostgres


_NON_ALBUM_ROOT_IO_BLOCK_CEILING = 40_000


def _skip_or_fail_ci(message: str) -> None:
    ci_values = (os.environ.get("CI"), os.environ.get("GITHUB_ACTIONS"))
    if any(
        str(value or "").strip().casefold() in {"1", "true", "yes"}
        for value in ci_values
    ):
        pytest.fail(message, pytrace=False)
    pytest.skip(message)


def _dedicated_database_urls_or_skip(monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    setup_value = str(os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or "").strip()
    runtime_value = str(os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV) or "").strip()
    if not setup_value and not runtime_value:
        _skip_or_fail_ci("Dedicated isolated Postgres URLs are not configured.")

    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    pgpass_value = str(os.environ.get("PGPASSFILE") or "").strip()
    if not pgpass_value:
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is not configured.")
    pgpass_path = Path(pgpass_value)
    if not pgpass_path.is_file():
        _skip_or_fail_ci(
            f"Dedicated isolated Postgres pgpass file is unavailable: {pgpass_path}"
        )
    monkeypatch.setenv("PGPASSFILE", str(pgpass_path))

    try:
        import psycopg
    except ImportError:
        _skip_or_fail_ci("psycopg is required for dedicated isolated Postgres tests.")
        raise AssertionError("unreachable")
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        with isolatedPostgres._connect(runtime_url) as connection:
            isolatedPostgres._assert_connected_role(connection, isolatedPostgres.RUNTIME_ROLE)
    except psycopg.OperationalError as exc:
        _skip_or_fail_ci(f"Dedicated isolated Postgres database is unavailable: {exc}")
    return setup_url, runtime_url


def _drop_application_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("drop schema if exists app, integration, library, ops cascade")


def _lifecycle_counts(setup_url: str) -> tuple[int, int]:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        row = connection.execute(
            """
            select
              (select count(*) from app.e2e_problematic_file_fixture_seeds
               where seed_key = 'problematic-files-small') as seed_count,
              (select count(*) from app.accounts
               where metadata ->> 'source' = 'isolated_e2e_launcher') as launcher_account_count
            """
        ).fetchone()
    return int(row["seed_count"]), int(row["launcher_account_count"])


def _explain_index_names(plan_document: object) -> set[str]:
    if not isinstance(plan_document, list) or not plan_document:
        return set()
    root = plan_document[0]
    if not isinstance(root, dict) or not isinstance(root.get("Plan"), dict):
        return set()
    names: set[str] = set()
    pending = [root["Plan"]]
    while pending:
        node = pending.pop()
        index_name = str(node.get("Index Name") or "").strip()
        if index_name:
            names.add(index_name)
        pending.extend(
            child for child in list(node.get("Plans") or []) if isinstance(child, dict)
        )
    return names


def _explain_nodes(plan_document: object) -> list[dict[str, object]]:
    if not isinstance(plan_document, list) or not plan_document:
        return []
    root = plan_document[0]
    if not isinstance(root, dict) or not isinstance(root.get("Plan"), dict):
        return []
    nodes: list[dict[str, object]] = []
    pending = [root["Plan"]]
    while pending:
        node = pending.pop()
        nodes.append(node)
        pending.extend(
            child for child in list(node.get("Plans") or []) if isinstance(child, dict)
        )
    return nodes


def _phase6_plan_evidence(plan_document: object) -> dict[str, object]:
    root = plan_document[0]
    root_plan = root["Plan"]
    nodes = _explain_nodes(plan_document)
    return {
        "actual_rows": int(root_plan["Actual Rows"]),
        "execution_ms": round(float(root["Execution Time"]), 3),
        "indexes": sorted(_explain_index_names(plan_document)),
        "external_sorts": sum(
            1
            for node in nodes
            if str(node.get("Sort Method") or "").casefold().startswith("external")
        ),
        "shared_read_blocks": int(root_plan.get("Shared Read Blocks") or 0),
        "shared_hit_blocks": int(root_plan.get("Shared Hit Blocks") or 0),
    }


def test_phase6_plan_evidence_uses_cumulative_root_buffer_counters_once():
    plan_document = [
        {
            "Execution Time": 3.25,
            "Plan": {
                "Actual Rows": 2,
                "Shared Hit Blocks": 10,
                "Shared Read Blocks": 2,
                "Plans": [
                    {
                        "Actual Rows": 2,
                        "Index Name": "child_index",
                        "Shared Hit Blocks": 8,
                        "Shared Read Blocks": 1,
                    }
                ],
            },
        }
    ]

    assert _phase6_plan_evidence(plan_document) == {
        "actual_rows": 2,
        "execution_ms": 3.25,
        "indexes": ["child_index"],
        "external_sorts": 0,
        "shared_read_blocks": 2,
        "shared_hit_blocks": 10,
    }


def test_live_auth_preauth_migration_reapply_privileges_and_concurrent_consume(
    monkeypatch,
):
    from music_app.services.auth_preauth_postgres import PostgresPreAuthCsrfService

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    migration_sql = (
        Path(__file__).resolve().parents[2]
        / "migrations"
        / "postgres"
        / "0047_add_auth_preauth_tokens.sql"
    ).read_text(encoding="utf-8")
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(migration_sql)
            connection.execute(migration_sql)
            privileges = connection.execute(
                """
                select
                  has_table_privilege('album_haven_app',
                    'app.auth_preflight_tokens', 'SELECT, INSERT, UPDATE, DELETE')
                    as app_table_access,
                  has_sequence_privilege('album_haven_app',
                    'app.auth_preflight_tokens_id_seq', 'USAGE, SELECT')
                    as app_sequence_access,
                  has_table_privilege('album_haven_readonly',
                    'app.auth_preflight_tokens', 'SELECT') as readonly_select,
                  has_sequence_privilege('album_haven_readonly',
                    'app.auth_preflight_tokens_id_seq', 'USAGE') as readonly_usage
                """
            ).fetchone()

        assert privileges == {
            "app_table_access": True,
            "app_sequence_access": True,
            "readonly_select": False,
            "readonly_usage": False,
        }

        service = PostgresPreAuthCsrfService(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url},
            connect=isolatedPostgres._connect,
        )
        issued = service.issue_login_token()
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(
                executor.map(
                    lambda _attempt: service.consume_login_token(issued.raw_token),
                    range(2),
                )
            )
        assert sorted(results) == [False, True]

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)


def test_live_cover_upgrade_compare_and_swap_rejects_stale_automatic_state(
    monkeypatch,
    tmp_path,
):
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    track_path = (tmp_path / "Artist" / "Album" / "song.flac").resolve()
    old_cover = track_path.parent / "cover-old.jpg"
    manual_cover = track_path.parent / "cover-manual.jpg"
    automatic_cover = track_path.parent / "cover-automatic.jpg"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    old_cover.write_bytes(b"old-cover")
    manual_cover.write_bytes(b"manual-cover")
    automatic_cover.write_bytes(b"automatic-cover")

    try:
        isolatedPostgres.reset_application_tables(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            library_id = int(connection.execute(
                """
                select library.libraries.id
                from app.bootstrap_owners
                join library.libraries
                  on library.libraries.owner_account_id = app.bootstrap_owners.account_id
                where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                  and library.libraries.library_kind = 'local'
                limit 1
                """
            ).fetchone()["id"])
            artist_id = int(connection.execute(
                """
                insert into library.local_artists (library_id, artist_key, name, sort_name)
                values (%s, 'cover-cas-artist', 'Cover CAS Artist', 'Cover CAS Artist')
                returning id
                """,
                (library_id,),
            ).fetchone()["id"])
            album_id = int(connection.execute(
                """
                insert into library.local_albums (
                  library_id, artist_id, album_key, title, cover_path, metadata
                ) values (
                  %s, %s, 'cover-cas-album', 'Cover CAS Album', %s,
                  jsonb_build_object(
                    'cover_selection_origin', 'user',
                    'cover_revision', 'old-revision'
                  )
                )
                returning id
                """,
                (library_id, artist_id, str(old_cover)),
            ).fetchone()["id"])
            track_id = int(connection.execute(
                """
                insert into library.local_tracks (
                  library_id, album_id, artist_id, track_key, title
                ) values (%s, %s, %s, 'cover-cas-track', 'Cover CAS Track')
                returning id
                """,
                (library_id, album_id, artist_id),
            ).fetchone()["id"])
            connection.execute(
                """
                insert into library.local_track_files (track_id, private_path, metadata)
                values (%s, %s, '{}'::jsonb)
                """,
                (track_id, str(track_path)),
            )

        adapter = PostgresScanCacheAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url})
        manual_result = adapter.persist_cover_selection(
            track_paths={str(track_path)},
            selected_cover_path=manual_cover,
            cover_revision="manual-revision",
            cover_selection_origin="user",
        )
        stale_automatic_result = adapter.persist_cover_selection(
            track_paths={str(track_path)},
            selected_cover_path=automatic_cover,
            cover_revision="automatic-revision",
            cover_selection_origin="user",
            expected_cover_selection_origin="user",
            expected_cover_revision="old-revision",
        )

        assert manual_result["album_rows_updated"] == 1
        assert stale_automatic_result == {
            "album_rows_updated": 0,
            "track_file_rows_updated": 0,
            "blocked_by_expected_cover_state": True,
        }
        with isolatedPostgres._connect(runtime_url) as connection:
            persisted = connection.execute(
                """
                select cover_path, metadata
                from library.local_albums
                where id = %s
                """,
                (album_id,),
            ).fetchone()
        assert persisted["cover_path"] == str(manual_cover)
        assert persisted["metadata"]["cover_selection_origin"] == "user"
        assert persisted["metadata"]["cover_revision"] == "manual-revision"

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_waveform_peak_cache_roundtrip_invalidation_upsert_grants_and_cascade(
    monkeypatch,
    tmp_path,
):
    from music_app.services.waveform_peak_cache_postgres import (
        PostgresWaveformPeakCacheRepository,
    )
    from music_app.services.waveform_peaks import WaveformPeaks

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    private_path = str((tmp_path / "private" / "fixture-track.flac").resolve())
    sample_count = 4
    initial_validators = {
        "private_path": private_path,
        "file_size_bytes": 4096,
        "modified_at_ns": 1_786_473_012_345_678_900,
        "content_signature": "sha256:fixture-track-v1",
        "sample_count": sample_count,
        "analyzer_version": "waveform-peaks-v2",
    }
    initial_peaks = WaveformPeaks(
        left=(0.0, 0.25, 0.5, 1.0),
        right=(1.0, 0.5, 0.25, 0.0),
        sample_count=sample_count,
    )
    replacement_peaks = WaveformPeaks(
        left=(0.125, 0.375, 0.625, 0.875),
        right=(0.875, 0.625, 0.375, 0.125),
        sample_count=sample_count,
    )
    cleanup_complete = False

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            library_id = int(
                connection.execute(
                    "select id from library.libraries where name = 'Local Library'"
                ).fetchone()["id"]
            )
            track_id = int(
                connection.execute(
                    """
                    insert into library.local_tracks (library_id, track_key, title)
                    values (%s, 'waveform-cache-live-track', 'Waveform Cache Live Track')
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            track_file_id = int(
                connection.execute(
                    """
                    insert into library.local_track_files (
                      track_id, private_path, file_size_bytes, content_signature, metadata
                    ) values (%s, %s, %s, %s, '{}'::jsonb)
                    returning id
                    """,
                    (
                        track_id,
                        private_path,
                        initial_validators["file_size_bytes"],
                        initial_validators["content_signature"],
                    ),
                ).fetchone()["id"]
            )
            privilege_row = connection.execute(
                """
                select
                  exists (select 1 from pg_roles where rolname = 'album_haven_app')
                    as app_role_exists,
                  exists (select 1 from pg_roles where rolname = 'album_haven_readonly')
                    as readonly_role_exists,
                  has_table_privilege('album_haven_app',
                    'library.local_track_waveform_peaks', 'SELECT') as app_select,
                  has_table_privilege('album_haven_app',
                    'library.local_track_waveform_peaks', 'INSERT') as app_insert,
                  has_table_privilege('album_haven_app',
                    'library.local_track_waveform_peaks', 'UPDATE') as app_update,
                  has_table_privilege('album_haven_app',
                    'library.local_track_waveform_peaks', 'DELETE') as app_delete,
                  has_table_privilege('album_haven_readonly',
                    'library.local_track_waveform_peaks', 'SELECT') as readonly_select,
                  has_table_privilege('album_haven_readonly',
                    'library.local_track_waveform_peaks', 'INSERT') as readonly_insert,
                  has_table_privilege('album_haven_readonly',
                    'library.local_track_waveform_peaks', 'UPDATE') as readonly_update,
                  has_table_privilege('album_haven_readonly',
                    'library.local_track_waveform_peaks', 'DELETE') as readonly_delete
                """
            ).fetchone()

        assert privilege_row == {
            "app_role_exists": True,
            "readonly_role_exists": True,
            "app_select": True,
            "app_insert": True,
            "app_update": True,
            "app_delete": False,
            "readonly_select": True,
            "readonly_insert": False,
            "readonly_update": False,
            "readonly_delete": False,
        }

        repository = PostgresWaveformPeakCacheRepository(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url},
            connect=isolatedPostgres._connect,
        )
        assert repository.put_for_path(**initial_validators, peaks=initial_peaks) is True

        initial_hit = repository.get_for_path(**initial_validators)
        assert initial_hit is not None
        assert initial_hit.sample_count == sample_count
        assert initial_hit.left == pytest.approx(initial_peaks.left, abs=1e-6)
        assert initial_hit.right == pytest.approx(initial_peaks.right, abs=1e-6)

        for changed_validator in (
            {"file_size_bytes": initial_validators["file_size_bytes"] + 1},
            {"modified_at_ns": initial_validators["modified_at_ns"] + 1},
            {"analyzer_version": "waveform-peaks-v3"},
            {"content_signature": "sha256:fixture-track-v2"},
        ):
            assert repository.get_for_path(
                **{**initial_validators, **changed_validator}
            ) is None

        assert repository.put_for_path(
            **{
                **initial_validators,
                "content_signature": "sha256:stale-caller",
                "analyzer_version": "waveform-peaks-v3",
            },
            peaks=replacement_peaks,
        ) is False
        assert repository.get_for_path(**initial_validators) is not None

        replacement_validators = {
            **initial_validators,
            "modified_at_ns": initial_validators["modified_at_ns"] + 1,
            "analyzer_version": "waveform-peaks-v3",
        }
        assert repository.put_for_path(
            **replacement_validators,
            peaks=replacement_peaks,
        ) is True
        assert repository.get_for_path(**initial_validators) is None
        replacement_hit = repository.get_for_path(**replacement_validators)
        assert replacement_hit is not None
        assert replacement_hit.left == pytest.approx(replacement_peaks.left, abs=1e-6)
        assert replacement_hit.right == pytest.approx(replacement_peaks.right, abs=1e-6)

        with isolatedPostgres._connect(setup_url) as connection:
            persisted_row = connection.execute(
                """
                select count(*) as row_count,
                       min(pg_typeof(left_peaks)::text) as left_type,
                       min(pg_typeof(right_peaks)::text) as right_type
                from library.local_track_waveform_peaks
                where track_file_id = %s
                """,
                (track_file_id,),
            ).fetchone()
            assert persisted_row == {
                "row_count": 1,
                "left_type": "real[]",
                "right_type": "real[]",
            }

            connection.execute(
                "delete from library.local_track_files where id = %s",
                (track_file_id,),
            )
            cascade_count = int(
                connection.execute(
                    """
                    select count(*) as row_count
                    from library.local_track_waveform_peaks
                    where track_file_id = %s
                    """,
                    (track_file_id,),
                ).fetchone()["row_count"]
            )
        assert cascade_count == 0

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_isolated_postgres_pristine_bootstrap_cleanup_and_second_run(monkeypatch):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)

        # A pristine dedicated database is a valid pre-migration reset state.
        isolatedPostgres.reset_application_tables(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        assert _lifecycle_counts(setup_url) == (1, 1)

        isolatedPostgres.reset_application_tables(setup_url)
        assert _lifecycle_counts(setup_url) == (1, 0)

        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        assert _lifecycle_counts(setup_url) == (1, 1)

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
        assert _lifecycle_counts(setup_url) == (1, 0)
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_semantic_album_delete_grant_repair_closes_historical_gap(monkeypatch):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "migrations"
        / "postgres"
        / "0039_repair_semantic_album_reconciliation_delete_grants.sql"
    )
    target_tables = (
        "library.ignored_versions",
        "library.manual_versions",
    )
    cleanup_complete = False

    def runtime_delete_privileges() -> tuple[bool, bool]:
        with isolatedPostgres._connect(runtime_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection,
                isolatedPostgres.RUNTIME_ROLE,
            )
            row = connection.execute(
                """
                select
                  has_table_privilege(current_user, 'library.ignored_versions', 'DELETE')
                    as ignored_versions_delete,
                  has_table_privilege(current_user, 'library.manual_versions', 'DELETE')
                    as manual_versions_delete
                """
            ).fetchone()
        return (
            bool(row["ignored_versions_delete"]),
            bool(row["manual_versions_delete"]),
        )

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection,
                isolatedPostgres.SETUP_ROLE,
            )
            runtime_role = str(urlparse(runtime_url).username or "")
            from psycopg import sql as psycopg_sql
            connection.execute(
                psycopg_sql.SQL("""
                revoke delete on table
                  library.ignored_versions,
                  library.manual_versions
                from album_haven_app, {}
                """).format(psycopg_sql.Identifier(runtime_role))
            )

        assert runtime_delete_privileges() == (False, False)

        migration_sql = migration_path.read_text(encoding="utf-8")
        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection,
                isolatedPostgres.SETUP_ROLE,
            )
            connection.execute(migration_sql)

        assert runtime_delete_privileges() == (True, True)

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection,
                isolatedPostgres.SETUP_ROLE,
            )
            for table_name in target_tables:
                connection.execute(
                    f"grant delete on table {table_name} to album_haven_app"
                )
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_targeted_album_rename_commits_without_rebuilding_unrelated_inventory(
    monkeypatch,
    tmp_path,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
        "APP_NAME": "Album Haven",
    }

    def file_entry(path: Path, *, album: str, title: str) -> dict[str, object]:
        return {
            "path": str(path),
            "mtime": 1.0,
            "size": 100,
            "album": album,
            "album_artist": "Structural Artist",
            "artist": "Structural Artist",
            "title": title,
            "track_number": 1,
            "disc_number": 1,
            "duration_seconds": 60,
            "cover_path": str(music_dir / "Structural Artist" / "Old Album" / "cover.jpg"),
            "cover_revision": "structural-cover-sha",
            "year": 2026,
            "edition": "",
            "album_rating": 0,
            "library_root_id": "structural-root",
            "library_root_category": "main_library",
            "exception_type": None,
        }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
        from music_app.services.scan_cache_persistence import (
            PostgresScanCacheAdapter,
            ScanCachePublicationSuperseded,
        )

        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {
                        "id": "structural-root",
                        "path": str(music_dir),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        first_path = music_dir / "Structural Artist" / "Old Album" / "01 First.flac"
        second_path = music_dir / "Structural Artist" / "Old Album" / "02 Second.flac"
        stale_path = music_dir / "Structural Artist" / "Old Album" / "03 Removed.flac"
        unrelated_path = music_dir / "Other Artist" / "Untouched Album" / "01 Untouched.flac"
        conflict_path = music_dir / "Structural Artist" / "Existing Album" / "01 Existing.flac"
        previous = {
            str(first_path): file_entry(first_path, album="Old Album", title="First"),
            str(second_path): {
                **file_entry(second_path, album="Old Album", title="Second"),
                "track_number": 2,
            },
            str(unrelated_path): {
                **file_entry(unrelated_path, album="Untouched Album", title="Untouched"),
                "album_artist": "Other Artist",
                "artist": "Other Artist",
            },
            str(conflict_path): file_entry(
                conflict_path,
                album="Existing Album",
                title="Existing",
            ),
        }
        adapter = PostgresScanCacheAdapter(config, connect=isolatedPostgres._connect)
        adapter.save_snapshot(
            Path("unused-structural-rename.json"),
            {
                **previous,
                str(stale_path): {
                    **file_entry(stale_path, album="Old Album", title="Removed"),
                    "track_number": 3,
                },
            },
            "structural-root-identity",
            1.0,
        )
        adapter.save_snapshot(
            Path("unused-structural-rename.json"),
            previous,
            "structural-root-identity",
            1.1,
        )
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                update library.local_albums
                   set metadata = metadata || '{"owner_note":"keep album metadata"}'::jsonb
                 where title = 'Old Album'
                """
            )
            connection.execute(
                """
                update library.local_track_files
                   set metadata = jsonb_set(
                     metadata,
                     '{scan_cache,file_entry}',
                     %(file_entry)s::jsonb,
                     true
                   )
                 where private_path = %(private_path)s
                """,
                {
                    "file_entry": json.dumps(
                        {
                            **file_entry(
                                stale_path,
                                album="Old Album",
                                title="Removed",
                            ),
                            "track_number": 3,
                        }
                    ),
                    "private_path": str(stale_path),
                },
            )
            before_rows = connection.execute(
                """
                select
                  library.local_track_files.private_path,
                  library.local_tracks.id as track_id,
                  library.local_track_files.id as track_file_id,
                  library.local_tracks.album_id
                from library.local_track_files
                join library.local_tracks on library.local_tracks.id = library.local_track_files.track_id
                order by library.local_track_files.private_path
                """
            ).fetchall()
            old_album = connection.execute(
                """
                select id, library_id, album_key
                from library.local_albums
                where title = 'Old Album'
                """
            ).fetchone()
            connection.execute(
                """
                insert into app.album_ratings (
                  account_id, library_id, album_key, rating, provenance
                )
                select
                  app.bootstrap_owners.account_id,
                  %(library_id)s,
                  %(album_key)s,
                  9,
                  'user'
                from app.bootstrap_owners
                where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                """,
                {
                    "library_id": old_album["library_id"],
                    "album_key": old_album["album_key"],
                },
            )
        before_by_path = {str(row["private_path"]): dict(row) for row in before_rows}
        prepared_inventory_revision = adapter.load_inventory_mutation_revision()
        updated = {
            path: {**entry, "album": "New Album"}
            for path, entry in previous.items()
            if path not in {str(unrelated_path), str(conflict_path)}
        }

        result = adapter.persist_structural_tag_edit(
            changed_paths=set(updated),
            previous_file_entries=previous,
            updated_file_entries={**previous, **updated},
            changed_field_names={"album"},
        )

        assert result["track_rows_updated"] == 2
        assert result["track_file_rows_updated"] == 2
        assert result["inventory_mutation_revision"] == prepared_inventory_revision + 1
        with isolatedPostgres._connect(setup_url) as connection:
            after_rows = connection.execute(
                """
                select
                  library.local_track_files.private_path,
                  library.local_tracks.id as track_id,
                  library.local_track_files.id as track_file_id,
                  library.local_tracks.album_id,
                  library.local_track_files.metadata as file_metadata,
                  library.local_albums.title as album_title,
                  library.local_albums.cover_path,
                  library.local_albums.metadata as album_metadata
                from library.local_track_files
                join library.local_tracks on library.local_tracks.id = library.local_track_files.track_id
                left join library.local_albums on library.local_albums.id = library.local_tracks.album_id
                order by library.local_track_files.private_path
                """
            ).fetchall()
        after_by_path = {str(row["private_path"]): dict(row) for row in after_rows}
        for path in updated:
            assert after_by_path[path]["track_id"] == before_by_path[path]["track_id"]
            assert after_by_path[path]["track_file_id"] == before_by_path[path]["track_file_id"]
            assert after_by_path[path]["album_id"] == before_by_path[path]["album_id"]
            assert after_by_path[path]["album_title"] == "New Album"
            assert after_by_path[path]["cover_path"].endswith("cover.jpg")
            assert after_by_path[path]["album_metadata"]["owner_note"] == "keep album metadata"
            assert after_by_path[path]["file_metadata"]["scan_cache"]["file_entry"]["album"] == "New Album"
        unrelated_key = str(unrelated_path)
        assert after_by_path[unrelated_key]["track_id"] == before_by_path[unrelated_key]["track_id"]
        assert after_by_path[unrelated_key]["track_file_id"] == before_by_path[unrelated_key]["track_file_id"]
        assert after_by_path[unrelated_key]["album_title"] == "Untouched Album"
        with isolatedPostgres._connect(setup_url) as connection:
            stale_row = connection.execute(
                """
                select
                  metadata #>> '{scan_cache,stale}' as stale,
                  metadata #>> '{scan_cache,file_entry,album}' as file_album
                from library.local_track_files
                where private_path = %(private_path)s
                """,
                {"private_path": str(stale_path)},
            ).fetchone()
        assert stale_row["stale"] == "true"
        assert stale_row["file_album"] == "Old Album"
        with isolatedPostgres._connect(setup_url) as connection:
            album_transition = connection.execute(
                """
                select
                  count(*) filter (where id = %(old_album_id)s and title = 'New Album') as retained_id_count,
                  count(*) filter (where album_key = %(old_album_key)s or title = 'Old Album') as old_album_count,
                  count(*) filter (where title = 'New Album') as new_album_count
                from library.local_albums
                """,
                {
                    "old_album_id": old_album["id"],
                    "old_album_key": old_album["album_key"],
                },
            ).fetchone()
            rating = connection.execute(
                """
                select app.album_ratings.rating, app.album_ratings.album_key
                from app.album_ratings
                join library.local_albums
                  on library.local_albums.library_id = app.album_ratings.library_id
                 and library.local_albums.album_key = app.album_ratings.album_key
                where library.local_albums.title = 'New Album'
                """
            ).fetchone()
        assert int(album_transition["retained_id_count"]) == 1
        assert int(album_transition["old_album_count"]) == 0
        assert int(album_transition["new_album_count"]) == 1
        assert int(rating["rating"]) == 9

        revision_before_merge = adapter.load_inventory_mutation_revision()
        with isolatedPostgres._connect(setup_url) as connection:
            existing_destination_before = connection.execute(
                """
                select id, album_key, cover_path, metadata
                from library.local_albums
                where title = 'Existing Album'
                """
            ).fetchone()
        merge_update = {
            path: {**entry, "album": "Existing Album"}
            for path, entry in updated.items()
        }
        merge_result = adapter.persist_structural_tag_edit(
            changed_paths=set(merge_update),
            previous_file_entries={**previous, **updated},
            updated_file_entries={**previous, **merge_update},
            changed_field_names={"album"},
        )
        assert merge_result["track_rows_updated"] == 2
        assert merge_result["track_file_rows_updated"] == 2
        assert adapter.load_inventory_mutation_revision() == revision_before_merge + 1
        with isolatedPostgres._connect(setup_url) as connection:
            after_merge = connection.execute(
                """
                select
                  count(*) filter (where title = 'New Album') as new_album_count,
                  count(*) filter (where title = 'Existing Album') as existing_album_count,
                  count(*) filter (where title = 'Old Album') as old_album_count,
                  max(id) filter (where title = 'Existing Album') as existing_album_id,
                  max(cover_path) filter (where title = 'Existing Album') as existing_cover_path
                from library.local_albums
                """
            ).fetchone()
            merged_track_count = connection.execute(
                """
                select count(*) as track_count
                from library.local_tracks
                join library.local_albums
                  on library.local_albums.id = library.local_tracks.album_id
                where library.local_albums.title = 'Existing Album'
                """
            ).fetchone()["track_count"]
        assert int(after_merge["new_album_count"]) == 1
        assert int(after_merge["existing_album_count"]) == 1
        assert int(after_merge["old_album_count"]) == 0
        assert after_merge["existing_album_id"] == existing_destination_before["id"]
        assert after_merge["existing_cover_path"] == existing_destination_before["cover_path"]
        assert int(merged_track_count) == 3

        current_cover_revision = adapter.load_cover_mutation_revision()
        with pytest.raises(ScanCachePublicationSuperseded, match="Inventory changed"):
            adapter.save_snapshot(
                Path("unused-structural-rename.json"),
                previous,
                "structural-root-identity",
                2.0,
                expected_cover_mutation_revision=current_cover_revision,
                expected_inventory_mutation_revision=prepared_inventory_revision,
            )

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_partial_year_split_preserves_source_album_and_selected_file_year(
    monkeypatch,
    tmp_path,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
        "APP_NAME": "Album Haven",
    }

    def file_entry(path: Path, *, title: str, track_number: int) -> dict[str, object]:
        return {
            "path": str(path),
            "mtime": 1.0,
            "size": 100,
            "album": "Year Split Album",
            "album_artist": "Year Split Artist",
            "artist": "Year Split Artist",
            "title": title,
            "track_number": track_number,
            "disc_number": 1,
            "duration_seconds": 60,
            "year": 2004,
            "release_date": "2004-07-16",
            "edition": "",
            "album_rating": 0,
            "library_root_id": "year-split-root",
            "library_root_category": "main_library",
            "exception_type": None,
        }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        from music_app.services.library_roots_postgres import (
            PostgresLibraryRootSettingsStore,
        )
        from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {
                        "id": "year-split-root",
                        "path": str(music_dir),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        selected_path = (
            music_dir
            / "Year Split Artist"
            / "Year Split Album"
            / "01 Selected.flac"
        )
        sibling_path = (
            music_dir
            / "Year Split Artist"
            / "Year Split Album"
            / "02 Sibling.flac"
        )
        previous = {
            str(selected_path): file_entry(
                selected_path,
                title="Selected",
                track_number=1,
            ),
            str(sibling_path): file_entry(
                sibling_path,
                title="Sibling",
                track_number=2,
            ),
        }
        adapter = PostgresScanCacheAdapter(
            config,
            connect=isolatedPostgres._connect,
        )
        adapter.save_snapshot(
            Path("unused-partial-year-split.json"),
            previous,
            "partial-year-split-root",
            1.0,
        )
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                update library.local_albums
                   set metadata = coalesce(metadata, '{}'::jsonb)
                     || jsonb_build_object(
                          'release_date',
                          %(release_date)s::text
                        )
                 where title = 'Year Split Album'
                """,
                {"release_date": "2004-07-16"},
            )
        updated = {
            **previous,
            str(selected_path): {
                **previous[str(selected_path)],
                "year": 2014,
                "release_date": "2014",
            },
        }

        adapter.validate_structural_tag_edit(
            changed_paths={str(selected_path)},
            previous_file_entries=previous,
            updated_file_entries=updated,
            changed_field_names={"year"},
        )
        result = adapter.persist_structural_tag_edit(
            changed_paths={str(selected_path)},
            previous_file_entries=previous,
            updated_file_entries=updated,
            changed_field_names={"year"},
        )

        assert result["track_rows_updated"] == 1
        assert result["track_file_rows_updated"] == 1
        with isolatedPostgres._connect(setup_url) as connection:
            albums = connection.execute(
                """
                select
                  id,
                  album_key,
                  title,
                  release_year,
                  metadata ->> 'release_date' as release_date
                from library.local_albums
                where title = 'Year Split Album'
                order by release_year
                """
            ).fetchall()
            tracks = connection.execute(
                """
                select
                  library.local_track_files.private_path,
                  library.local_albums.release_year,
                  library.local_track_files.metadata
                    #>> '{scan_cache,file_entry,year}' as file_year,
                  library.local_track_files.metadata
                    #>> '{scan_cache,file_entry,release_date}' as file_release_date
                from library.local_track_files
                join library.local_tracks
                  on library.local_tracks.id = library.local_track_files.track_id
                join library.local_albums
                  on library.local_albums.id = library.local_tracks.album_id
                where library.local_track_files.private_path = any(%(paths)s::text[])
                order by library.local_track_files.private_path
                """,
                {"paths": list(previous)},
            ).fetchall()

        assert [
            (str(row["title"]), int(row["release_year"]))
            for row in albums
        ] == [
            ("Year Split Album", 2004),
            ("Year Split Album", 2014),
        ]
        assert len({str(row["album_key"]) for row in albums}) == 2
        assert [
            (int(row["release_year"]), str(row["release_date"]))
            for row in albums
        ] == [
            (2004, "2004-07-16"),
            (2014, "2014"),
        ]
        tracks_by_path = {
            str(row["private_path"]): dict(row)
            for row in tracks
        }
        assert int(tracks_by_path[str(selected_path)]["release_year"]) == 2014
        assert tracks_by_path[str(selected_path)]["file_year"] == "2014"
        assert tracks_by_path[str(selected_path)]["file_release_date"] == "2014"
        assert int(tracks_by_path[str(sibling_path)]["release_year"]) == 2004
        assert tracks_by_path[str(sibling_path)]["file_year"] == "2004"
        assert (
            tracks_by_path[str(sibling_path)]["file_release_date"]
            == "2004-07-16"
        )

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_year_edit_preserves_owner_explicit_separate_release_memberships(
    monkeypatch,
    tmp_path,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
        "APP_NAME": "Album Haven",
    }

    def file_entry(
        path: Path,
        *,
        title: str,
        track_number: int,
        year: int,
    ) -> dict[str, object]:
        return {
            "path": str(path),
            "mtime": 1.0,
            "size": 100,
            "album": "Explicit Separate Album",
            "album_artist": "Explicit Separate Artist",
            "artist": "Explicit Separate Artist",
            "title": title,
            "track_number": track_number,
            "disc_number": 1,
            "duration_seconds": 60,
            "year": year,
            "release_date": str(year),
            "edition": "",
            "album_rating": 0,
            "library_root_id": "explicit-separate-root",
            "library_root_category": "main_library",
            "exception_type": None,
        }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        from music_app.services.library_roots_postgres import (
            PostgresLibraryRootSettingsStore,
        )
        from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {
                        "id": "explicit-separate-root",
                        "path": str(music_dir),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        first_path = (
            music_dir
            / "Explicit Separate Artist"
            / "Explicit Separate Album"
            / "01 First.flac"
        )
        second_path = (
            music_dir
            / "Explicit Separate Artist"
            / "Explicit Separate Album"
            / "02 Second.flac"
        )
        previous = {
            str(first_path): file_entry(
                first_path,
                title="First",
                track_number=1,
                year=2004,
            ),
            str(second_path): file_entry(
                second_path,
                title="Second",
                track_number=2,
                year=2014,
            ),
        }
        adapter = PostgresScanCacheAdapter(
            config,
            connect=isolatedPostgres._connect,
        )
        separate_release_key = (
            "explicit separate artist::explicit separate album"
        )
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                insert into library.separate_releases (
                  library_id, release_key, metadata
                )
                select
                  library.libraries.id,
                  %(release_key)s,
                  '{"source":"owner"}'::jsonb
                from app.bootstrap_owners
                join library.libraries
                  on library.libraries.owner_account_id =
                     app.bootstrap_owners.account_id
                 and library.libraries.name = 'Local Library'
                 and library.libraries.library_kind = 'local'
                where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                on conflict (library_id, release_key) do nothing
                """,
                {"release_key": separate_release_key},
            )
        adapter.save_snapshot(
            Path("unused-explicit-separate.json"),
            previous,
            "explicit-separate-root",
            1.0,
            separate_release_keys={separate_release_key},
        )

        with isolatedPostgres._connect(setup_url) as connection:
            before_albums = connection.execute(
                """
                select id, album_key, release_year,
                       semantic_identity_discriminator
                from library.local_albums
                where title = 'Explicit Separate Album'
                order by release_year
                """
            ).fetchall()
        assert len(before_albums) == 2
        assert all(
            str(row["semantic_identity_discriminator"] or "")
            == str(row["album_key"])
            for row in before_albums
        )

        updated = {
            **previous,
            str(first_path): {
                **previous[str(first_path)],
                "year": 2014,
                "release_date": "2014",
            },
        }
        adapter.persist_structural_tag_edit(
            changed_paths={str(first_path)},
            previous_file_entries=previous,
            updated_file_entries=updated,
            changed_field_names={"year"},
        )

        with isolatedPostgres._connect(setup_url) as connection:
            marker_count = connection.execute(
                """
                select count(*) as count
                from library.separate_releases
                where release_key = %(release_key)s
                """,
                {"release_key": separate_release_key},
            ).fetchone()["count"]
            albums = connection.execute(
                """
                select id, album_key, release_year,
                       semantic_identity_discriminator
                from library.local_albums
                where title = 'Explicit Separate Album'
                order by id
                """
            ).fetchall()
            memberships = connection.execute(
                """
                select
                  library.local_track_files.private_path,
                  library.local_albums.id as album_id
                from library.local_track_files
                join library.local_tracks
                  on library.local_tracks.id = library.local_track_files.track_id
                join library.local_albums
                  on library.local_albums.id = library.local_tracks.album_id
                where library.local_track_files.private_path = any(%(paths)s::text[])
                order by library.local_track_files.private_path
                """,
                {"paths": list(previous)},
            ).fetchall()

        assert int(marker_count) == 1
        assert len(albums) == 2
        assert {int(row["release_year"]) for row in albums} == {2014}
        edited_album = next(
            row
            for row in albums
            if int(row["id"]) == int(before_albums[0]["id"])
        )
        assert str(edited_album["album_key"]) == str(
            before_albums[0]["album_key"]
        )
        assert all(
            str(row["semantic_identity_discriminator"] or "")
            == str(row["album_key"])
            for row in albums
        )
        assert len({int(row["album_id"]) for row in memberships}) == 2
        assert {
            str(row["private_path"]): int(row["album_id"])
            for row in memberships
        } == {
            str(first_path): int(before_albums[0]["id"]),
            str(second_path): int(before_albums[1]["id"]),
        }

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_year_split_survives_rebuild_from_stored_postgres_file_entries(
    monkeypatch,
    tmp_path,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
        "APP_NAME": "Album Haven",
    }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        from music_app.services.library import (
            album_separate_release_key,
            build_albums_from_file_cache,
        )
        from music_app.services.library_roots_postgres import (
            PostgresLibraryRootSettingsStore,
        )
        from music_app.services.rule_state_postgres import RuleStatePostgresAdapter
        from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {
                        "id": "year-rebuild-root",
                        "path": str(music_dir),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        selected_path = (
            music_dir
            / "Year Rebuild Artist"
            / "Year Rebuild Album"
            / "01 Selected.flac"
        )
        sibling_path = (
            music_dir
            / "Year Rebuild Artist"
            / "Year Rebuild Album"
            / "02 Sibling.flac"
        )

        def file_entry(
            path: Path,
            *,
            title: str,
            track_number: int,
        ) -> dict[str, object]:
            return {
                "path": str(path),
                "mtime": 1.0,
                "size": 100,
                "album": "Year Rebuild Album",
                "album_artist": "Year Rebuild Artist",
                "artist": "Year Rebuild Artist",
                "title": title,
                "track_number": track_number,
                "disc_number": 1,
                "duration_seconds": 60,
                "year": 2004,
                "release_date": "2004-07-16",
                "edition": "",
                "album_rating": 0,
                "library_root_id": "year-rebuild-root",
                "library_root_category": "main_library",
                "exception_type": None,
            }

        previous = {
            str(selected_path): file_entry(
                selected_path,
                title="Selected",
                track_number=1,
            ),
            str(sibling_path): file_entry(
                sibling_path,
                title="Sibling",
                track_number=2,
            ),
        }
        root_identity = "year-rebuild-root-identity"
        adapter = PostgresScanCacheAdapter(
            config,
            connect=isolatedPostgres._connect,
        )
        adapter.save_snapshot(
            Path("unused-year-rebuild.json"),
            previous,
            root_identity,
            1.0,
        )
        updated = {
            **previous,
            str(selected_path): {
                **previous[str(selected_path)],
                "year": 2014,
                "release_date": "2014",
            },
        }
        adapter.persist_structural_tag_edit(
            changed_paths={str(selected_path)},
            previous_file_entries=previous,
            updated_file_entries=updated,
            changed_field_names={"year"},
        )

        stored_file_entries, *_snapshot_metadata = adapter.load_snapshot_strict(
            Path("unused-year-rebuild.json"),
            root_identity,
        )
        stored_separate_release_keys = RuleStatePostgresAdapter(
            config,
            connect=isolatedPostgres._connect,
        ).load_separate_release_keys()
        rebuilt_albums = build_albums_from_file_cache(
            stored_file_entries,
            stored_separate_release_keys,
        )
        rebuilt_year_groups = sorted(
            (
                int(album.year),
                [track.title for track in album.tracks],
            )
            for album in rebuilt_albums
            if album.name == "Year Rebuild Album"
        )

        assert rebuilt_year_groups == [
            (2004, ["Sibling"]),
            (2014, ["Selected"]),
        ]
        assert (
            album_separate_release_key(
                "Year Rebuild Artist",
                "Year Rebuild Album",
                None,
            )
            in stored_separate_release_keys
        )

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_partial_album_split_clones_album_state_and_moves_only_selected_track(
    monkeypatch,
    tmp_path,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
        "APP_NAME": "Album Haven",
    }
    cover_path = music_dir / "Split Artist" / "Source Album" / "cover.jpg"

    def file_entry(path: Path, *, title: str, track_number: int) -> dict[str, object]:
        return {
            "path": str(path),
            "mtime": 1.0,
            "size": 100,
            "album": "Source Album",
            "album_artist": "Split Artist",
            "artist": "Split Artist",
            "title": title,
            "track_number": track_number,
            "disc_number": 1,
            "duration_seconds": 60,
            "cover_path": str(cover_path),
            "cover_revision": "split-cover-sha",
            "year": 2026,
            "edition": "Owner Edition",
            "album_rating": 0,
            "library_root_id": "split-root",
            "library_root_category": "main_library",
            "exception_type": None,
        }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
        from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {
                        "id": "split-root",
                        "path": str(music_dir),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        selected_path = music_dir / "Split Artist" / "Source Album" / "01 Selected.flac"
        second_selected_path = music_dir / "Split Artist" / "Source Album" / "02 Second Selected.flac"
        sibling_path = music_dir / "Split Artist" / "Source Album" / "03 Sibling.flac"
        previous = {
            str(selected_path): file_entry(
                selected_path,
                title="Selected",
                track_number=1,
            ),
            str(second_selected_path): file_entry(
                second_selected_path,
                title="Second Selected",
                track_number=2,
            ),
            str(sibling_path): file_entry(
                sibling_path,
                title="Sibling",
                track_number=3,
            ),
        }
        adapter = PostgresScanCacheAdapter(config, connect=isolatedPostgres._connect)
        adapter.save_snapshot(
            Path("unused-partial-album-split.json"),
            previous,
            "partial-album-split-root",
            1.0,
        )

        with isolatedPostgres._connect(setup_url) as connection:
            source_album = connection.execute(
                """
                update library.local_albums
                   set metadata = metadata || '{"owner_note":"clone this"}'::jsonb
                 where title = 'Source Album'
                returning id, library_id, album_key, cover_path, metadata
                """
            ).fetchone()
            guest_artist_id = connection.execute(
                """
                insert into library.local_artists (
                  library_id, artist_key, name, sort_name
                ) values (
                  %(library_id)s, 'split guest', 'Split Guest', 'Split Guest'
                )
                returning id
                """,
                {"library_id": source_album["library_id"]},
            ).fetchone()["id"]
            connection.execute(
                """
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind, metadata
                ) values (
                  %(library_id)s, %(album_id)s, %(artist_id)s,
                  'featured_member', '{"source":"owner"}'::jsonb
                )
                """,
                {
                    "library_id": source_album["library_id"],
                    "album_id": source_album["id"],
                    "artist_id": guest_artist_id,
                },
            )
            connection.execute(
                """
                insert into app.album_ratings (
                  account_id, library_id, album_key, rating, provenance, metadata
                )
                select
                  app.bootstrap_owners.account_id,
                  %(library_id)s,
                  %(album_key)s,
                  8,
                  'user',
                  '{"source":"owner"}'::jsonb
                from app.bootstrap_owners
                where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                """,
                {
                    "library_id": source_album["library_id"],
                    "album_key": source_album["album_key"],
                },
            )
            before_tracks = connection.execute(
                """
                select
                  library.local_track_files.private_path,
                  library.local_tracks.id as track_id,
                  library.local_track_files.id as track_file_id
                from library.local_track_files
                join library.local_tracks
                  on library.local_tracks.id = library.local_track_files.track_id
                where library.local_track_files.private_path = any(%(paths)s::text[])
                """,
                {"paths": list(previous)},
            ).fetchall()
        before_by_path = {
            str(row["private_path"]): dict(row)
            for row in before_tracks
        }
        updated_selected = {
            **previous[str(selected_path)],
            "album": "Destination Album",
        }

        result = adapter.persist_structural_tag_edit(
            changed_paths={str(selected_path)},
            previous_file_entries=previous,
            updated_file_entries={
                **previous,
                str(selected_path): updated_selected,
            },
            changed_field_names={"album"},
        )

        assert result["track_rows_updated"] == 1
        assert result["track_file_rows_updated"] == 1
        with isolatedPostgres._connect(setup_url) as connection:
            albums = connection.execute(
                """
                select
                  id, album_key, title, cover_path, metadata
                from library.local_albums
                where title in ('Source Album', 'Destination Album')
                order by title
                """
            ).fetchall()
            tracks = connection.execute(
                """
                select
                  library.local_track_files.private_path,
                  library.local_tracks.id as track_id,
                  library.local_track_files.id as track_file_id,
                  library.local_albums.title as album_title
                from library.local_track_files
                join library.local_tracks
                  on library.local_tracks.id = library.local_track_files.track_id
                join library.local_albums
                  on library.local_albums.id = library.local_tracks.album_id
                where library.local_track_files.private_path = any(%(paths)s::text[])
                order by library.local_track_files.private_path
                """,
                {"paths": list(previous)},
            ).fetchall()
            ratings = connection.execute(
                """
                select library.local_albums.title, app.album_ratings.rating,
                       app.album_ratings.metadata
                from library.local_albums
                join app.album_ratings
                  on app.album_ratings.library_id = library.local_albums.library_id
                 and app.album_ratings.album_key = library.local_albums.album_key
                where library.local_albums.title in ('Source Album', 'Destination Album')
                order by library.local_albums.title
                """
            ).fetchall()
            featured = connection.execute(
                """
                select library.local_albums.title, library.local_artists.name,
                       library.local_album_featured_artists.featured_kind,
                       library.local_album_featured_artists.metadata
                from library.local_album_featured_artists
                join library.local_albums
                  on library.local_albums.id = library.local_album_featured_artists.album_id
                join library.local_artists
                  on library.local_artists.id = library.local_album_featured_artists.artist_id
                where library.local_albums.title in ('Source Album', 'Destination Album')
                  and library.local_artists.name = 'Split Guest'
                order by library.local_albums.title
                """
            ).fetchall()

        assert len(albums) == 2
        albums_by_title = {str(row["title"]): dict(row) for row in albums}
        source = albums_by_title["Source Album"]
        destination = albums_by_title["Destination Album"]
        assert source["id"] != destination["id"]
        assert source["cover_path"] == str(cover_path)
        assert destination["cover_path"] == str(cover_path)
        assert source["metadata"]["cover_revision"] == "split-cover-sha"
        assert destination["metadata"]["cover_revision"] == "split-cover-sha"
        assert destination["metadata"] == source["metadata"]

        tracks_by_path = {str(row["private_path"]): dict(row) for row in tracks}
        assert tracks_by_path[str(selected_path)]["album_title"] == "Destination Album"
        assert tracks_by_path[str(second_selected_path)]["album_title"] == "Source Album"
        assert tracks_by_path[str(sibling_path)]["album_title"] == "Source Album"
        for path in previous:
            assert tracks_by_path[path]["track_id"] == before_by_path[path]["track_id"]
            assert tracks_by_path[path]["track_file_id"] == before_by_path[path]["track_file_id"]

        assert [(row["title"], int(row["rating"])) for row in ratings] == [
            ("Destination Album", 8),
            ("Source Album", 8),
        ]
        assert all(row["metadata"]["source"] == "owner" for row in ratings)
        assert [
            (row["title"], row["name"], row["featured_kind"])
            for row in featured
        ] == [
            ("Destination Album", "Split Guest", "featured_member"),
            ("Source Album", "Split Guest", "featured_member"),
        ]
        assert all(row["metadata"]["source"] == "owner" for row in featured)

        destination_cover_path = (
            music_dir / "Split Artist" / "Destination Album" / "destination-cover.jpg"
        )
        with isolatedPostgres._connect(setup_url) as connection:
            destination_authority = connection.execute(
                """
                update library.local_albums
                   set cover_path = %(cover_path)s,
                       metadata = metadata || jsonb_build_object(
                         'cover_revision', 'destination-cover-sha',
                         'owner_note', 'destination authority'
                       )
                 where title = 'Destination Album'
                returning id, album_key, cover_path, metadata
                """,
                {"cover_path": str(destination_cover_path)},
            ).fetchone()
            connection.execute(
                """
                update app.album_ratings
                   set rating = 10,
                       metadata = '{"source":"destination"}'::jsonb
                 where library_id = %(library_id)s
                   and album_key = %(album_key)s
                """,
                {
                    "library_id": source_album["library_id"],
                    "album_key": destination_authority["album_key"],
                },
            )
            connection.execute(
                """
                update library.local_album_featured_artists
                   set metadata = '{"source":"destination"}'::jsonb
                  from library.local_albums
                 where library.local_albums.id =
                       library.local_album_featured_artists.album_id
                   and library.local_albums.title = 'Destination Album'
                """
            )

        revision_before_merge = adapter.load_inventory_mutation_revision()
        updated_second_selected = {
            **previous[str(second_selected_path)],
            "album": "Destination Album",
        }
        entries_after_first_split = {
            **previous,
            str(selected_path): updated_selected,
        }
        entries_after_second_move = {
            **entries_after_first_split,
            str(second_selected_path): updated_second_selected,
        }
        adapter.validate_structural_tag_edit(
            changed_paths={str(second_selected_path)},
            previous_file_entries=entries_after_first_split,
            updated_file_entries=entries_after_second_move,
            changed_field_names={"album"},
        )
        merge_result = adapter.persist_structural_tag_edit(
            changed_paths={str(second_selected_path)},
            previous_file_entries=entries_after_first_split,
            updated_file_entries=entries_after_second_move,
            changed_field_names={"album"},
        )
        assert merge_result["track_rows_updated"] == 1
        assert merge_result["track_file_rows_updated"] == 1
        assert adapter.load_inventory_mutation_revision() == revision_before_merge + 1

        with isolatedPostgres._connect(setup_url) as connection:
            final_albums = connection.execute(
                """
                select id, album_key, title, cover_path, metadata
                from library.local_albums
                where title in ('Source Album', 'Destination Album')
                order by title
                """
            ).fetchall()
            final_tracks = connection.execute(
                """
                select
                  library.local_track_files.private_path,
                  library.local_tracks.id as track_id,
                  library.local_track_files.id as track_file_id,
                  library.local_albums.title as album_title
                from library.local_track_files
                join library.local_tracks
                  on library.local_tracks.id = library.local_track_files.track_id
                join library.local_albums
                  on library.local_albums.id = library.local_tracks.album_id
                where library.local_track_files.private_path = any(%(paths)s::text[])
                order by library.local_track_files.private_path
                """,
                {"paths": list(previous)},
            ).fetchall()
            final_ratings = connection.execute(
                """
                select library.local_albums.title, app.album_ratings.rating,
                       app.album_ratings.metadata
                from library.local_albums
                join app.album_ratings
                  on app.album_ratings.library_id = library.local_albums.library_id
                 and app.album_ratings.album_key = library.local_albums.album_key
                where library.local_albums.title in ('Source Album', 'Destination Album')
                order by library.local_albums.title
                """
            ).fetchall()
            final_featured = connection.execute(
                """
                select library.local_albums.title,
                       library.local_album_featured_artists.metadata
                from library.local_album_featured_artists
                join library.local_albums
                  on library.local_albums.id = library.local_album_featured_artists.album_id
                join library.local_artists
                  on library.local_artists.id = library.local_album_featured_artists.artist_id
                where library.local_albums.title in ('Source Album', 'Destination Album')
                  and library.local_artists.name = 'Split Guest'
                order by library.local_albums.title
                """
            ).fetchall()

        final_albums_by_title = {
            str(row["title"]): dict(row)
            for row in final_albums
        }
        final_destination = final_albums_by_title["Destination Album"]
        assert final_destination["id"] == destination_authority["id"]
        assert final_destination["album_key"] == destination_authority["album_key"]
        assert final_destination["cover_path"] == str(destination_cover_path)
        assert final_destination["metadata"]["cover_revision"] == "destination-cover-sha"
        assert final_destination["metadata"]["owner_note"] == "destination authority"

        final_tracks_by_path = {
            str(row["private_path"]): dict(row)
            for row in final_tracks
        }
        assert final_tracks_by_path[str(selected_path)]["album_title"] == "Destination Album"
        assert final_tracks_by_path[str(second_selected_path)]["album_title"] == "Destination Album"
        assert final_tracks_by_path[str(sibling_path)]["album_title"] == "Source Album"
        for path in previous:
            assert final_tracks_by_path[path]["track_id"] == before_by_path[path]["track_id"]
            assert final_tracks_by_path[path]["track_file_id"] == before_by_path[path]["track_file_id"]

        assert [(row["title"], int(row["rating"])) for row in final_ratings] == [
            ("Destination Album", 10),
            ("Source Album", 8),
        ]
        assert [row["metadata"]["source"] for row in final_ratings] == [
            "destination",
            "owner",
        ]
        assert [row["metadata"]["source"] for row in final_featured] == [
            "destination",
            "owner",
        ]

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_album_splits_with_newer_file_years_restore_into_existing_semantic_album(
    monkeypatch,
    tmp_path,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
        "APP_NAME": "Album Haven",
    }
    source_album = "Студийные записи"
    touched_track_numbers = frozenset({1, 2, 3, 4})
    yearless_track_numbers = frozenset({9, 10, 11, 16})

    def file_entry(track_number: int) -> dict[str, object]:
        path = (
            music_dir
            / "ДДТ"
            / source_album
            / f"{track_number:02d} Studio Track {track_number}.flac"
        )
        year = (
            1990
            if track_number in touched_track_numbers
            else None
            if track_number in yearless_track_numbers
            else 1988
        )
        return {
            "path": str(path),
            "mtime": 1.0,
            "size": 100,
            "album": source_album,
            "album_artist": "ДДТ",
            "artist": "ДДТ",
            "title": f"Studio Track {track_number}",
            "track_number": track_number,
            "disc_number": 1,
            "duration_seconds": 60,
            "year": year,
            "edition": "",
            "album_rating": 0,
            "library_root_id": "mixed-year-restore-root",
            "library_root_category": "main_library",
            "exception_type": None,
        }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        from music_app.services.library import album_separate_release_key
        from music_app.services.library_roots_postgres import (
            PostgresLibraryRootSettingsStore,
        )
        from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {
                        "id": "mixed-year-restore-root",
                        "path": str(music_dir),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        current_entries = {
            str(entry["path"]): entry
            for entry in (file_entry(track_number) for track_number in range(1, 17))
        }
        original_entries = {
            path: dict(entry)
            for path, entry in current_entries.items()
        }
        touched_paths = {
            track_number: next(
                path
                for path, entry in current_entries.items()
                if entry["track_number"] == track_number
            )
            for track_number in touched_track_numbers
        }
        adapter = PostgresScanCacheAdapter(
            config,
            connect=isolatedPostgres._connect,
        )
        adapter.save_snapshot(
            Path("unused-mixed-year-restore.json"),
            current_entries,
            "mixed-year-restore-root-identity",
            1.0,
        )

        derived_destination_key = album_separate_release_key(
            "ДДТ",
            source_album,
            None,
        )
        stored_original_key = f"{derived_destination_key}::canonical-artist"
        with isolatedPostgres._connect(setup_url) as connection:
            original_before = connection.execute(
                """
                update library.local_albums
                   set album_key = %(stored_album_key)s,
                       release_year = %(persisted_release_year)s
                 where title = %(source_album)s
                returning id, album_key, release_year
                """,
                {
                    "persisted_release_year": 1988,
                    "source_album": source_album,
                    "stored_album_key": stored_original_key,
                },
            ).fetchone()

        assert int(original_before["release_year"]) == 1988
        assert str(original_before["album_key"]) == stored_original_key
        assert stored_original_key != derived_destination_key

        for suffix, track_number in zip(range(2, 6), range(1, 5), strict=True):
            selected_path = touched_paths[track_number]
            previous_entries = {
                path: dict(entry)
                for path, entry in current_entries.items()
            }
            current_entries[selected_path] = {
                **current_entries[selected_path],
                "album": f"Ремиксы{suffix}",
            }
            split_result = adapter.persist_structural_tag_edit(
                changed_paths={selected_path},
                previous_file_entries=previous_entries,
                updated_file_entries=current_entries,
                changed_field_names={"album"},
            )
            assert split_result["track_rows_updated"] == 1
            assert split_result["track_file_rows_updated"] == 1

        with isolatedPostgres._connect(setup_url) as connection:
            split_rows = connection.execute(
                """
                select
                  library.local_albums.id,
                  library.local_albums.album_key,
                  library.local_albums.title,
                  library.local_albums.release_year,
                  count(library.local_tracks.id) as track_count
                from library.local_albums
                left join library.local_tracks
                  on library.local_tracks.album_id = library.local_albums.id
                where library.local_albums.title = %(source_album)s
                   or library.local_albums.title like 'Ремиксы%%'
                group by library.local_albums.id
                order by library.local_albums.title
                """,
                {"source_album": source_album},
            ).fetchall()
            touched_file_rows = connection.execute(
                """
                select
                  library.local_track_files.private_path,
                  library.local_tracks.id as track_id,
                  library.local_track_files.id as track_file_id,
                  library.local_tracks.album_id,
                  library.local_track_files.metadata #>>
                    '{scan_cache,file_entry,year}' as file_year
                from library.local_track_files
                join library.local_tracks
                  on library.local_tracks.id = library.local_track_files.track_id
                where library.local_track_files.private_path = any(%(paths)s)
                order by library.local_track_files.private_path
                """,
                {"paths": list(touched_paths.values())},
            ).fetchall()

        split_by_title = {
            str(row["title"]): dict(row)
            for row in split_rows
        }
        assert int(split_by_title[source_album]["id"]) == int(original_before["id"])
        assert str(split_by_title[source_album]["album_key"]) == stored_original_key
        assert int(split_by_title[source_album]["release_year"]) == 1988
        assert int(split_by_title[source_album]["track_count"]) == 12
        for suffix in range(2, 6):
            split_album = split_by_title[f"Ремиксы{suffix}"]
            assert int(split_album["release_year"]) == 1988
            assert int(split_album["track_count"]) == 1
        touched_before_restore = {
            str(row["private_path"]): dict(row)
            for row in touched_file_rows
        }
        assert {
            row["file_year"]
            for row in touched_before_restore.values()
        } == {"1990"}

        for suffix, track_number in zip(range(2, 6), range(1, 5), strict=True):
            selected_path = touched_paths[track_number]
            previous_entries = {
                path: dict(entry)
                for path, entry in current_entries.items()
            }
            current_entries[selected_path] = {
                **current_entries[selected_path],
                "album": source_album,
            }
            adapter.validate_structural_tag_edit(
                changed_paths={selected_path},
                previous_file_entries=previous_entries,
                updated_file_entries=current_entries,
                changed_field_names={"album"},
            )
            restore_result = adapter.persist_structural_tag_edit(
                changed_paths={selected_path},
                previous_file_entries=previous_entries,
                updated_file_entries=current_entries,
                changed_field_names={"album"},
            )
            assert restore_result["track_rows_updated"] == 1
            assert restore_result["track_file_rows_updated"] == 1

        with isolatedPostgres._connect(setup_url) as connection:
            original_after = connection.execute(
                """
                select
                  library.local_albums.id,
                  library.local_albums.album_key,
                  library.local_albums.release_year,
                  count(library.local_tracks.id) as track_count
                from library.local_albums
                left join library.local_tracks
                  on library.local_tracks.album_id = library.local_albums.id
                where library.local_albums.artist_id = (
                    select artist_id
                    from library.local_albums
                    where id = %(original_album_id)s
                )
                  and lower(btrim(library.local_albums.title)) =
                    lower(btrim(%(source_album)s))
                  and library.local_albums.release_year = 1988
                group by library.local_albums.id
                order by library.local_albums.id
                """,
                {
                    "original_album_id": original_before["id"],
                    "source_album": source_album,
                },
            ).fetchall()
            touched_after = connection.execute(
                """
                select
                  library.local_track_files.private_path,
                  library.local_tracks.id as track_id,
                  library.local_track_files.id as track_file_id,
                  library.local_tracks.album_id,
                  library.local_track_files.metadata #>>
                    '{scan_cache,file_entry,year}' as file_year
                from library.local_track_files
                join library.local_tracks
                  on library.local_tracks.id = library.local_track_files.track_id
                where library.local_track_files.private_path = any(%(paths)s)
                order by library.local_track_files.private_path
                """,
                {"paths": list(touched_paths.values())},
            ).fetchall()

        assert len(original_after) == 1
        assert int(original_after[0]["id"]) == int(original_before["id"])
        assert str(original_after[0]["album_key"]) == stored_original_key
        assert int(original_after[0]["track_count"]) == 16
        for row in touched_after:
            selected_path = str(row["private_path"])
            before_row = touched_before_restore[selected_path]
            assert int(row["album_id"]) == int(original_before["id"])
            assert int(row["track_id"]) == int(before_row["track_id"])
            assert int(row["track_file_id"]) == int(before_row["track_file_id"])
            assert row["file_year"] == "1990"
            assert current_entries[selected_path] == original_entries[selected_path]

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_album_exclusion_persistence_preserves_durable_album_key_across_replacement(
    monkeypatch,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    durable_album_key = "split artist::split release"
    projected_album_key = f"{durable_album_key}::year::1988"
    album_rule_key = (
        f"{projected_album_key}::problem-album::missing-cover-art"
    )
    later_file_rule_key = (
        "C:/Music/Split Artist/Split Release/01.flac"
        "::problem-file::missing-year"
    )

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        from music_app.services.rule_state_postgres import RuleStatePostgresAdapter

        adapter = RuleStatePostgresAdapter(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url},
            connect=isolatedPostgres._connect,
        )
        adapter.save_ignored_repair_keys(
            {album_rule_key},
            album_keys_by_repair_key={album_rule_key: durable_album_key},
        )
        adapter.save_ignored_repair_keys(
            {album_rule_key, later_file_rule_key},
        )

        with isolatedPostgres._connect(runtime_url) as connection:
            stored_row = connection.execute(
                """
                select repair_key, metadata ->> 'album_key' as album_key
                from library.ignored_repairs
                where repair_key = %(repair_key)s
                """,
                {"repair_key": album_rule_key},
            ).fetchone()

        assert stored_row is not None
        assert str(stored_row["repair_key"]) == album_rule_key
        assert str(stored_row["album_key"]) == durable_album_key

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_utility_rules_sql_joins_the_separately_stored_durable_album_key(
    monkeypatch,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    literal_durable_key = "delimiter artist::literal release::year::2026"
    literal_prefix_decoy_key = "delimiter artist::literal release"
    split_durable_key = "split artist::split release"
    split_projected_key = f"{split_durable_key}::year::1988"
    literal_rule_key = (
        f"{literal_durable_key}::problem-album::missing-cover-art"
    )
    split_rule_key = (
        f"{split_projected_key}::problem-album::missing-cover-art"
    )

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                with bootstrap_context as (
                  select library.libraries.id as library_id
                  from app.bootstrap_owners
                  join library.libraries
                    on library.libraries.owner_account_id =
                       app.bootstrap_owners.account_id
                  where app.bootstrap_owners.owner_key =
                        'local-bootstrap-owner'
                ),
                inserted_artist as (
                  insert into library.local_artists (
                    library_id, artist_key, name, sort_name
                  )
                  select
                    bootstrap_context.library_id,
                    'album exclusion identity artist',
                    'Album Exclusion Identity Artist',
                    'Album Exclusion Identity Artist'
                  from bootstrap_context
                  returning library_id, id
                )
                insert into library.local_albums (
                  library_id, artist_id, album_key, title,
                  release_year, metadata
                )
                select
                  inserted_artist.library_id,
                  inserted_artist.id,
                  album_seed.album_key,
                  album_seed.title,
                  album_seed.release_year,
                  jsonb_build_object(
                    'album_artist', 'Album Exclusion Identity Artist'
                  )
                from inserted_artist
                cross join (
                  values
                    (%(literal_durable_key)s, 'Literal Year-Key Album', 2026),
                    (%(literal_prefix_decoy_key)s, 'Wrong Prefix Album', 2026),
                    (%(split_durable_key)s, 'Split Durable Album', 1988),
                    (%(split_projected_key)s, 'Projected Identity Decoy', 1988)
                ) as album_seed(album_key, title, release_year)
                """,
                {
                    "literal_durable_key": literal_durable_key,
                    "literal_prefix_decoy_key": literal_prefix_decoy_key,
                    "split_durable_key": split_durable_key,
                    "split_projected_key": split_projected_key,
                },
            )
            connection.execute(
                """
                with bootstrap_context as (
                  select library.libraries.id as library_id
                  from app.bootstrap_owners
                  join library.libraries
                    on library.libraries.owner_account_id =
                       app.bootstrap_owners.account_id
                  where app.bootstrap_owners.owner_key =
                        'local-bootstrap-owner'
                )
                insert into library.ignored_repairs (
                  library_id, repair_key, metadata
                )
                select
                  bootstrap_context.library_id,
                  repair_seed.repair_key,
                  jsonb_build_object(
                    'source', 'isolated_postgres_regression',
                    'album_key', repair_seed.durable_album_key
                  )
                from bootstrap_context
                cross join (
                  values
                    (%(literal_rule_key)s, %(literal_durable_key)s),
                    (%(split_rule_key)s, %(split_durable_key)s)
                ) as repair_seed(repair_key, durable_album_key)
                """,
                {
                    "literal_rule_key": literal_rule_key,
                    "literal_durable_key": literal_durable_key,
                    "split_rule_key": split_rule_key,
                    "split_durable_key": split_durable_key,
                },
            )
            stored_transports = connection.execute(
                """
                select repair_key, metadata ->> 'album_key' as album_key
                from library.ignored_repairs
                where repair_key = any(%(repair_keys)s::text[])
                order by repair_key
                """,
                {"repair_keys": [literal_rule_key, split_rule_key]},
            ).fetchall()

        assert {
            str(row["repair_key"]): str(row["album_key"])
            for row in stored_transports
        } == {
            literal_rule_key: literal_durable_key,
            split_rule_key: split_durable_key,
        }

        from music_app.services.library_browse_postgres import (
            _utility_rules_projection_payload,
            _utility_rules_sql,
        )

        with isolatedPostgres._connect(runtime_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection,
                isolatedPostgres.RUNTIME_ROLE,
            )
            rows = list(connection.execute(_utility_rules_sql()).fetchall())

        repair_rows = [
            row for row in rows if str(row["row_kind"]) == "problem_ignore"
        ]
        assert len(repair_rows) == 2
        assert {
            str(row["ignored_repair_key"]): str(row["album_key"])
            for row in repair_rows
        } == {
            literal_rule_key: literal_durable_key,
            split_rule_key: split_durable_key,
        }

        payload = _utility_rules_projection_payload(rows)
        problem_rule = next(
            rule for rule in payload["rules"] if rule["key"] == "problem-ignores"
        )
        album_items = list(problem_rule["album_items"])

        assert len(album_items) == 2
        assert {
            str(item["row_key"]): str(item["album"])
            for item in album_items
        } == {
            literal_rule_key: "Literal Year-Key Album",
            split_rule_key: "Split Durable Album",
        }
        assert {str(item["row_key"]) for item in album_items} == {
            literal_rule_key,
            split_rule_key,
        }

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_phase6_browse_queries_use_bounded_production_plans_and_search_indexes(
    monkeypatch,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)

    migration_sql = (
        Path(__file__).resolve().parents[2]
        / "migrations"
        / "postgres"
        / "0024_add_library_search_trigram_indexes.sql"
    ).read_text(encoding="utf-8")
    index_names = {
        "local_albums_normalized_title_trgm_idx",
        "local_artists_normalized_name_trgm_idx",
        "local_albums_normalized_credited_artist_trgm_idx",
        "local_tracks_normalized_title_trgm_idx",
        "local_track_files_normalized_basename_trgm_idx",
        "local_track_files_normalized_stem_trgm_idx",
    }
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            for index_name in sorted(index_names):
                connection.execute(f"drop index if exists library.{index_name}")

            library_id = int(
                connection.execute(
                    "select id from library.libraries where name = 'Local Library'"
                ).fetchone()["id"]
            )
            artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (library_id, artist_key, name, sort_name)
                    values (%s, 'joseph search probe', 'Joseph Search Probe', 'Joseph Search Probe')
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            album_id = int(
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title, metadata
                    ) values (
                      %s, %s, 'joseph-search-probe', 'Joseph Search Album',
                      '{"album_artist":"Joseph Search Credit"}'::jsonb
                    )
                    returning id
                    """,
                    (library_id, artist_id),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind
                ) values (%s, %s, %s, 'owner')
                """,
                (library_id, album_id, artist_id),
            )
            track_id = int(
                connection.execute(
                    """
                insert into library.local_tracks (
                  library_id, album_id, artist_id, track_key, title, track_number,
                  duration_seconds
                ) values (
                  %s, %s, %s, 'joseph-search-track', 'Joseph Search Track', null, 245
                )
                returning id
                """,
                    (library_id, album_id, artist_id),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.local_track_files (track_id, private_path, metadata)
                values (%s, 'C:\\Music\\Joseph Search File.mp3', '{}'::jsonb)
                """,
                (track_id,),
            )
            connection.execute(
                """
                insert into library.local_track_files (track_id, private_path, metadata)
                values (%s, 'C:\\Music\\Joseph Search File Duplicate.mp3', '{}'::jsonb)
                """,
                (track_id,),
            )
            featured_artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (library_id, artist_key, name, sort_name)
                    values (%s, 'plain featured artist', 'Plain Featured Artist', 'Plain Featured Artist')
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind
                ) values (%s, %s, %s, 'featured_member')
                """,
                (library_id, album_id, featured_artist_id),
            )
            connection.execute(
                """
                insert into library.local_artists (
                  library_id, artist_key, name, sort_name
                )
                select
                  %s,
                  format('scale artist %%s', artist_index),
                  format('Scale Artist %%s', artist_index),
                  format('Scale Artist %%s', artist_index)
                from generate_series(0, 39) as artist_index
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into library.local_albums (
                  library_id, artist_id, album_key, title, release_year, metadata
                )
                select
                  %s,
                  artists.id,
                  format('scale-album-%%s-%%s', artist_index, album_index),
                  format('Scale Album %%s-%%s', artist_index, album_index),
                  2000 + album_index,
                  jsonb_build_object('album_artist', artists.name)
                from generate_series(0, 39) as artist_index
                cross join generate_series(0, 9) as album_index
                join library.local_artists as artists
                  on artists.library_id = %s
                 and artists.artist_key = format('scale artist %%s', artist_index)
                """,
                (library_id, library_id),
            )
            connection.execute(
                """
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind
                )
                select
                  albums.library_id,
                  albums.id,
                  albums.artist_id,
                  'owner'
                from library.local_albums as albums
                where albums.library_id = %s
                  and albums.album_key like 'scale-album-%%'
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into library.local_tracks (
                  library_id, album_id, artist_id, track_key, title, track_number,
                  duration_seconds
                )
                select
                  albums.library_id,
                  albums.id,
                  albums.artist_id,
                  format('%%s-track-%%s', albums.album_key, track_index),
                  format('Scale Track %%s', track_index),
                  track_index,
                  180 + track_index
                from library.local_albums as albums
                cross join generate_series(1, 18) as track_index
                where albums.library_id = %s
                  and albums.album_key like 'scale-album-%%'
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into library.local_track_files (track_id, private_path, metadata)
                select
                  tracks.id,
                  format('C:\\Music\\Scale\\%%s.mp3', tracks.track_key),
                  '{}'::jsonb
                from library.local_tracks as tracks
                where tracks.library_id = %s
                  and tracks.track_key like 'scale-album-%%'
                """,
                (library_id,),
            )
            root_id = int(
                connection.execute(
                    """
                    insert into library.library_roots (
                      library_id, root_path, root_kind, is_active, metadata
                    ) values (
                      %s, 'C:\\Music', 'main_library', true,
                      '{"root_id":"phase6-query-plan-root"}'::jsonb
                    )
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.local_tracks (
                  library_id, artist_id, track_key, title, track_number, duration_seconds,
                  metadata
                )
                select
                  %s,
                  %s,
                  format('non-album-track-%%s', track_index),
                  format('Non Album Track %%s', track_index),
                  track_index,
                  180 + (track_index %% 60),
                  jsonb_build_object(
                    'album', '',
                    'album_artist', 'Joseph Search Probe'
                  )
                from generate_series(1, 1200) as track_index
                """,
                (library_id, artist_id),
            )
            connection.execute(
                """
                insert into library.local_track_files (
                  track_id, library_root_id, private_path, metadata
                )
                select
                  tracks.id,
                  %s,
                  format('C:\\Music\\Singles\\%%s.mp3', tracks.track_key),
                  jsonb_build_object(
                    'library_root_category', 'main_library',
                    'scan_cache', jsonb_build_object(
                      'stale', false,
                      'file_entry', jsonb_build_object(
                        'album', '',
                        'album_artist', 'Joseph Search Probe',
                        'artist', 'Joseph Search Probe',
                        'title', tracks.title,
                        'track_number', tracks.track_number::text,
                        'library_root_category', 'main_library'
                      )
                    )
                  )
                from library.local_tracks as tracks
                where tracks.library_id = %s
                  and tracks.track_key like 'non-album-track-%%'
                """,
                (root_id, library_id),
            )
            precedence_rows = connection.execute(
                """
                select
                  tracks.id as track_id,
                  tracks.track_key,
                  track_files.private_path
                from library.local_tracks as tracks
                join library.local_track_files as track_files
                  on track_files.track_id = tracks.id
                where tracks.library_id = %s
                  and tracks.track_key in ('non-album-track-1199', 'non-album-track-1200')
                order by tracks.track_key
                """,
                (library_id,),
            ).fetchall()
            assert [row["track_key"] for row in precedence_rows] == [
                "non-album-track-1199",
                "non-album-track-1200",
            ]
            tie_track_id = int(precedence_rows[0]["track_id"])
            tie_private_path = str(precedence_rows[0]["private_path"])
            path_track_id = int(precedence_rows[1]["track_id"])
            path_private_path = str(precedence_rows[1]["private_path"])

            connection.execute(
                """
                insert into library.exception_overrides (
                  library_id, track_id, track_key, override_payload, updated_at
                ) values (
                  %s, %s, 'track-id-older-1199',
                  '{"exception_type":"Track ID older","winner":"no"}'::jsonb,
                  '2026-07-15 10:00:00+00'
                )
                """,
                (library_id, tie_track_id),
            )
            connection.execute(
                """
                insert into library.exception_overrides (
                  library_id, track_id, track_key, override_payload, updated_at
                ) values (
                  %s, %s, 'track-id-newer-first-1199',
                  '{"exception_type":"Track ID newer first","winner":"no"}'::jsonb,
                  '2026-07-15 11:00:00+00'
                )
                """,
                (library_id, tie_track_id),
            )
            tie_winner_id = int(
                connection.execute(
                    """
                    insert into library.exception_overrides (
                      library_id, track_id, track_key, override_payload, updated_at
                    ) values (
                      %s, %s, 'track-id-newer-id-winner-1199',
                      '{"exception_type":"Track ID newest ID winner","winner":"tie_id"}'::jsonb,
                      '2026-07-15 11:00:00+00'
                    )
                    returning id
                    """,
                    (library_id, tie_track_id),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.exception_overrides (
                  library_id, track_id, track_key, override_payload, updated_at
                ) values (
                  %s, %s, 'track-id-newest-1200',
                  '{"exception_type":"Track ID newest","winner":"no"}'::jsonb,
                  '2026-07-15 12:00:00+00'
                )
                """,
                (library_id, path_track_id),
            )
            path_winner_id = int(
                connection.execute(
                    """
                    insert into library.exception_overrides (
                      library_id, track_id, track_key, override_payload, updated_at
                    ) values (
                      %s, %s, %s,
                      '{"exception_type":"Path priority winner","winner":"path"}'::jsonb,
                      '2026-07-15 09:00:00+00'
                    )
                    returning id
                    """,
                    (library_id, path_track_id, path_private_path),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                update library.local_albums
                   set cover_path = format('C:\\Covers\\%%s.jpg', album_key)
                 where library_id = %s
                """,
                (library_id,),
            )
            connection.execute(
                """
                update library.local_track_files as track_files
                   set library_root_id = %s,
                       metadata = track_files.metadata || jsonb_build_object(
                         'library_root_category', 'main_library',
                         'scan_cache', jsonb_build_object(
                           'stale', false,
                           'file_entry', jsonb_build_object(
                             'album', albums.title,
                             'album_artist', artists.name,
                             'artist', artists.name,
                             'title', tracks.title,
                             'year', albums.release_year::text,
                             'track_number', tracks.track_number::text,
                             'cover_path', albums.cover_path,
                             'library_root_category', 'main_library'
                           )
                         )
                       )
                  from library.local_tracks as tracks
                  join library.local_albums as albums
                    on albums.id = tracks.album_id
                   and albums.library_id = tracks.library_id
                  join library.local_artists as artists
                    on artists.id = albums.artist_id
                 where track_files.track_id = tracks.id
                   and tracks.library_id = %s
                """,
                (root_id, library_id),
            )
            connection.execute(
                """
                insert into library.ignored_versions (library_id, version_key)
                values (%s, 'scale-album-0-0')
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into library.ignored_repairs (library_id, repair_key)
                values (%s, 'C:\\Music\\Joseph Search File.mp3::metadata')
                """,
                (library_id,),
            )
            connection.execute("analyze library.local_artists")
            connection.execute("analyze library.local_albums")
            connection.execute("analyze library.local_tracks")
            connection.execute("analyze library.local_track_files")
            connection.execute("analyze library.local_album_featured_artists")
            connection.execute("analyze library.exception_overrides")
            connection.execute("analyze library.ignored_versions")
            connection.execute("analyze library.ignored_repairs")

            from music_app.services.library_browse_postgres import (
                MOJIBAKE_CANDIDATE_PATTERN,
                MOJIBAKE_ENCODING_CANDIDATE_CHARS,
                _album_detail_sql,
                _problematic_album_projection_payloads,
                _problematic_album_summary_payload,
                _problematic_files_sql,
                _root_album_browse_sql,
                _root_sidebar_params,
                _root_sidebar_sql,
                _search_preview_sql,
                _selected_artist_sql,
                _utility_rules_sql,
            )
            from music_app.services.library_inventory_postgres import (
                _non_album_candidates_sql,
            )

            precedence_params = {
                "track_ids": [tie_track_id, path_track_id],
                "track_id_count": 2,
                "private_paths": [tie_private_path, path_private_path],
                "private_path_count": 2,
                "limit": 10,
            }
            precedence_candidates = connection.execute(
                _non_album_candidates_sql(),
                precedence_params,
            ).fetchall()
            assert [row["track_key"] for row in precedence_candidates] == [
                "non-album-track-1199",
                "non-album-track-1200",
            ]
            assert [row["track_file_id"] for row in precedence_candidates] == list(
                dict.fromkeys(row["track_file_id"] for row in precedence_candidates)
            )
            assert len(precedence_candidates) == 2
            tie_winner, path_winner = precedence_candidates
            assert tie_winner["exception_override_id"] == tie_winner_id
            assert tie_winner["exception_override_track_key"] == "track-id-newer-id-winner-1199"
            assert tie_winner["exception_override_payload"] == {
                "exception_type": "Track ID newest ID winner",
                "winner": "tie_id",
            }
            assert tie_winner["exception_type"] == "Track ID newest ID winner"
            assert path_winner["exception_override_id"] == path_winner_id
            assert path_winner["exception_override_track_key"] == path_private_path
            assert path_winner["exception_override_payload"] == {
                "exception_type": "Path priority winner",
                "winner": "path",
            }
            assert path_winner["exception_type"] == "Path priority winner"
            assert connection.execute(
                _non_album_candidates_sql(),
                {**precedence_params, "limit": 1},
            ).fetchall() == [tie_winner]

            production_params = {
                "query_like": "%joseph%",
                "category_count": 0,
                "visible_categories": [],
            }
            search_before_plan = connection.execute(
                "explain (analyze, buffers, format json) " + _search_preview_sql(),
                production_params,
            ).fetchone()["QUERY PLAN"]
            assert int(search_before_plan[0]["Plan"]["Actual Rows"]) == 2

            connection.execute(migration_sql)
            connection.execute(migration_sql)
            connection.execute("analyze library.local_artists")
            connection.execute("analyze library.local_albums")
            connection.execute("analyze library.local_tracks")
            connection.execute("analyze library.local_track_files")

            browse_params = _root_sidebar_params(
                {"visible_library_categories": ["main_library", "hoard", "new_arrivals"]}
            )
            plan_specs = {
                "root_browse": (
                    _root_album_browse_sql(),
                    browse_params,
                    402,
                    1500.0,
                ),
                "root_sidebar": (_root_sidebar_sql(), browse_params, 42, 750.0),
                "selected_artist": (
                    _selected_artist_sql(),
                    {"artist_keys": ["scale artist 0"], **browse_params},
                    180,
                    750.0,
                ),
                "normalized_search": (_search_preview_sql(), production_params, 2, 250.0),
                "problematic_files": (
                    _problematic_files_sql(candidate_summary=True),
                    {
                        "mojibake_candidate_pattern": MOJIBAKE_CANDIDATE_PATTERN,
                        "encoding_candidate_chars": MOJIBAKE_ENCODING_CANDIDATE_CHARS,
                    },
                    2,
                    1500.0,
                ),
                "utility_rules": (_utility_rules_sql(), {}, 2, 250.0),
                "non_album_reads": (
                    _non_album_candidates_sql(),
                    {
                        "track_ids": [],
                        "track_id_count": 0,
                        "private_paths": [],
                        "private_path_count": 0,
                        "limit": 1000,
                    },
                    1000,
                    750.0,
                ),
                "cover_path_lookup": (
                    _album_detail_sql(),
                    {"album_key": "joseph-search-probe"},
                    2,
                    250.0,
                ),
            }
            plan_evidence: dict[str, dict[str, object]] = {
                "normalized_search_before_0024": _phase6_plan_evidence(search_before_plan),
            }
            for surface, (sql, params, expected_rows, execution_ceiling_ms) in plan_specs.items():
                plan = connection.execute(
                    "explain (analyze, buffers, format json) " + sql,
                    params,
                ).fetchone()["QUERY PLAN"]
                evidence = _phase6_plan_evidence(plan)
                assert evidence["actual_rows"] == expected_rows
                assert evidence["execution_ms"] < execution_ceiling_ms
                assert evidence["external_sorts"] == 0
                plan_evidence[surface] = evidence

            candidate_params = {
                "mojibake_candidate_pattern": MOJIBAKE_CANDIDATE_PATTERN,
                "encoding_candidate_chars": MOJIBAKE_ENCODING_CANDIDATE_CHARS,
            }
            candidate_rows = connection.execute(
                _problematic_files_sql(candidate_summary=True),
                candidate_params,
            ).fetchall()
            full_rows = connection.execute(
                _problematic_files_sql(candidate_summary=False),
                {"album_key": None},
            ).fetchall()

            def projected_summaries(rows):
                return {
                    summary["key"]: {
                        "problem_reasons": summary["problem_reasons"],
                        "track_count": summary["track_count"],
                    }
                    for album in _problematic_album_projection_payloads(list(rows))
                    if (summary := _problematic_album_summary_payload(album)) is not None
                }

            candidate_summaries = projected_summaries(candidate_rows)
            full_summaries = projected_summaries(full_rows)
            assert candidate_summaries == full_summaries
            assert set(candidate_summaries) == {"joseph-search-probe"}
            assert "Duplicate files" in candidate_summaries["joseph-search-probe"]["problem_reasons"]

            assert "local_albums_library_album_key_idx" in plan_evidence["cover_path_lookup"]["indexes"]
            assert {
                "local_tracks_album_id_idx",
                "local_track_files_track_id_idx",
            } <= set(plan_evidence["selected_artist"]["indexes"])
            non_album_root_io_blocks = (
                int(plan_evidence["non_album_reads"]["shared_hit_blocks"])
                + int(plan_evidence["non_album_reads"]["shared_read_blocks"])
            )
            assert non_album_root_io_blocks < _NON_ALBUM_ROOT_IO_BLOCK_CEILING

            connection.execute("set local enable_seqscan = off")

            probes = [
                (
                    "local_albums_normalized_title_trgm_idx",
                    "select id from library.local_albums where lower(btrim(coalesce(title, ''))) like '%joseph%'",
                ),
                (
                    "local_artists_normalized_name_trgm_idx",
                    "select id from library.local_artists where lower(btrim(coalesce(name, ''))) like '%joseph%'",
                ),
                (
                    "local_albums_normalized_credited_artist_trgm_idx",
                    "select id from library.local_albums where lower(btrim(coalesce(metadata ->> 'album_artist', ''))) like '%joseph%'",
                ),
                (
                    "local_tracks_normalized_title_trgm_idx",
                    "select id from library.local_tracks where lower(btrim(coalesce(title, ''))) like '%joseph%'",
                ),
                (
                    "local_track_files_normalized_basename_trgm_idx",
                    r"select id from library.local_track_files where lower(btrim(regexp_replace(coalesce(private_path, ''), '^.*[\\/]', ''))) like '%joseph%'",
                ),
                (
                    "local_track_files_normalized_stem_trgm_idx",
                    r"select id from library.local_track_files where lower(btrim(regexp_replace(regexp_replace(coalesce(private_path, ''), '^.*[\\/]', ''), '\.[^.]*$', ''))) like '%joseph%'",
                ),
            ]
            for expected_index, probe_sql in probes:
                plan = connection.execute(
                    "explain (analyze, buffers, format json) " + probe_sql
                ).fetchone()["QUERY PLAN"]
                assert expected_index in _explain_index_names(plan)

            production_plan = connection.execute(
                "explain (analyze, buffers, format json) " + _search_preview_sql(),
                production_params,
            ).fetchone()["QUERY PLAN"]
            assert float(production_plan[0]["Execution Time"]) < 100.0
            assert index_names <= _explain_index_names(production_plan)
            plan_evidence["normalized_search_forced_index_proof"] = _phase6_plan_evidence(
                production_plan
            )
            print("PHASE6_QUERY_PLAN_EVIDENCE=" + json.dumps(plan_evidence, sort_keys=True))

        from music_app.services.library_browse_postgres import (
            PostgresLibraryBrowseRepository,
        )

        repository = PostgresLibraryBrowseRepository(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
        )
        view_state = {
            "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
        }

        def load_rows() -> list[dict[str, object]]:
            return [dict(row) for row in repository._load_search_rows("joseph", view_state)]

        expected_rows = load_rows()
        assert [row["artist_name"] for row in expected_rows] == [
            "Joseph Search Probe",
            "Plain Featured Artist",
        ]
        assert {row["album_title"] for row in expected_rows} == {"Joseph Search Album"}
        assert {row["track_count"] for row in expected_rows} == {1}
        assert {row["total_duration_seconds"] for row in expected_rows} == {245}

        with ThreadPoolExecutor(max_workers=4) as executor:
            concurrent_results = list(executor.map(lambda _index: load_rows(), range(8)))
        assert concurrent_results == [expected_rows] * 8

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)


def test_live_root_linkage_resolution_and_production_scan_writer(monkeypatch, tmp_path):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    psycopg = pytest.importorskip("psycopg")
    migration_sql = (
        Path(__file__).resolve().parents[2]
        / "migrations"
        / "postgres"
        / "0023_link_local_track_files_to_library_roots.sql"
    ).read_text(encoding="utf-8")
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        main_root = (tmp_path / "Music").resolve()
        nested_root = (main_root / "Nested").resolve()
        from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore

        root_store = PostgresLibraryRootSettingsStore(
            {
                "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
                "MUSIC_DIR": str(main_root),
            }
        )
        root_store.save_settings(
            {
                "main_library_roots": [
                    {"id": "main-logical", "path": str(main_root), "layout_mode": "artist"}
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )

        with isolatedPostgres._connect(setup_url) as connection:
            library_id = int(
                connection.execute(
                    "select id from library.libraries where name = 'Local Library'"
                ).fetchone()["id"]
            )
            main_root_id = int(
                connection.execute(
                    "select id from library.library_roots where library_id = %s and metadata ->> 'root_id' = 'main-logical'",
                    (library_id,),
                ).fetchone()["id"]
            )
            inserted = connection.execute(
                """
                insert into library.library_roots (library_id, root_path, root_kind, is_active, metadata)
                values
                  (%s, %s, 'main_library', true, '{"root_id":"nested-logical"}'::jsonb),
                  (%s, %s, 'main_library', true, '{"root_id":"ambiguous-logical"}'::jsonb),
                  (%s, %s, 'main_library', true, '{"root_id":"ambiguous-logical"}'::jsonb),
                  (%s, %s, 'main_library', false, '{"root_id":"inactive-logical"}'::jsonb),
                  (%s, %s, 'main_library', true, '{"root_id":"windows-case-logical"}'::jsonb),
                  (%s, %s, 'main_library', true, '{"root_id":"posix-upper-logical"}'::jsonb),
                  (%s, %s, 'main_library', true, '{"root_id":"posix-lower-logical"}'::jsonb)
                returning id, metadata ->> 'root_id' as logical_id
                """,
                (
                    library_id,
                    str(nested_root),
                    library_id,
                    str(main_root / "AmbiguousA"),
                    library_id,
                    str(main_root / "AmbiguousB"),
                    library_id,
                    str(tmp_path / "InactiveMusic"),
                    library_id,
                    r"C:\Music",
                    library_id,
                    "/Music",
                    library_id,
                    "/music",
                ),
            ).fetchall()
            root_ids = {str(row["logical_id"]): int(row["id"]) for row in inserted}
            nested_root_id = root_ids["nested-logical"]

            second_account_id = int(
                connection.execute(
                    "insert into app.accounts (display_name, account_kind) values ('Other Owner', 'local') returning id"
                ).fetchone()["id"]
            )
            second_library_id = int(
                connection.execute(
                    "insert into library.libraries (owner_account_id, name, library_kind) values (%s, 'Other Library', 'local') returning id",
                    (second_account_id,),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.library_roots (library_id, root_path, metadata)
                values (%s, %s, '{"root_id":"cross-library"}'::jsonb)
                """,
                (second_library_id, str(tmp_path / "OtherMusic")),
            )

            def resolve(private_path: str, metadata: dict[str, object]):
                return connection.execute(
                    "select * from library.local_track_file_root_resolution(%s, %s, %s::jsonb)",
                    (library_id, private_path, psycopg.types.json.Jsonb(metadata)),
                ).fetchone()

            logical = resolve(
                str(nested_root / "Artist" / "logical.flac"),
                {"library_root_id": "main-logical", "library_root_path": str(nested_root)},
            )
            assert (logical["resolution_status"], logical["library_root_id"], logical["resolution_method"]) == (
                "resolved",
                main_root_id,
                "logical-root-id",
            )

            explicit = resolve(
                str(nested_root / "Artist" / "explicit.flac"),
                {"library_root_path": str(main_root)},
            )
            assert (explicit["library_root_id"], explicit["resolution_method"]) == (
                main_root_id,
                "explicit-root-path",
            )

            contained_path = str(nested_root / "Artist" / "contained.flac").replace("\\", "/")
            contained = resolve(contained_path, {})
            assert (contained["library_root_id"], contained["resolution_method"]) == (
                nested_root_id,
                "longest-path-containment",
            )
            assert resolve(f"{main_root}ology\\outside.flac", {})["resolution_status"] == "unresolved"

            windows_case = resolve(r"c:/MUSIC/Artist/Album/track.flac", {})
            assert (
                windows_case["library_root_id"],
                windows_case["resolution_method"],
            ) == (
                root_ids["windows-case-logical"],
                "longest-path-containment",
            )

            posix_upper = resolve("/Music/Artist/Album/track.flac", {})
            assert (
                posix_upper["library_root_id"],
                posix_upper["resolution_method"],
            ) == (
                root_ids["posix-upper-logical"],
                "longest-path-containment",
            )
            posix_lower = resolve("/music/Artist/Album/track.flac", {})
            assert (
                posix_lower["library_root_id"],
                posix_lower["resolution_method"],
            ) == (
                root_ids["posix-lower-logical"],
                "longest-path-containment",
            )
            assert resolve("/MUSIC/Artist/Album/track.flac", {})["resolution_status"] == "unresolved"
            assert resolve(r"C:\Musicology\Artist\track.flac", {})["resolution_status"] == "unresolved"
            assert resolve(r"D:\Music\Artist\Album\track.flac", {})["resolution_status"] == "unresolved"

            path_keys = connection.execute(
                """
                select
                  library.local_path_key('C:\\Music\\Artist') = library.local_path_key('c:/MUSIC/Artist') as windows_equal,
                  library.local_path_key('/Music/Artist') <> library.local_path_key('/music/Artist') as posix_distinct,
                  library.local_path_style('C:\\Music') <> library.local_path_style('/Music') as styles_distinct
                """
            ).fetchone()
            assert all(bool(value) for value in path_keys.values())

            ambiguous = resolve(
                str(main_root / "Unknown" / "ambiguous.flac"),
                {"library_root_id": "ambiguous-logical"},
            )
            assert (ambiguous["resolution_status"], ambiguous["candidate_count"]) == ("ambiguous", 2)
            assert resolve(str(tmp_path / "Nowhere" / "unresolved.flac"), {})["resolution_status"] == "unresolved"
            assert resolve(
                str(tmp_path / "InactiveMusic" / "ignored.flac"),
                {"library_root_id": "inactive-logical"},
            )["resolution_status"] == "unresolved"
            assert resolve(
                str(tmp_path / "OtherMusic" / "rejected.flac"),
                {"library_root_id": "cross-library"},
            )["resolution_status"] == "unresolved"

            connection.execute(migration_sql)
            connection.execute(migration_sql)
            privileges = connection.execute(
                """
                select
                  has_function_privilege('album_haven_app', 'library.local_track_file_root_resolution(bigint,text,jsonb)', 'execute') as app_resolve,
                  has_function_privilege('album_haven_app', 'library.require_local_track_file_root_id(bigint,text,jsonb)', 'execute') as app_require,
                  has_function_privilege('album_haven_migrator', 'library.local_track_file_root_resolution(bigint,text,jsonb)', 'execute') as migrator_resolve,
                  has_function_privilege('album_haven_migrator', 'library.require_local_track_file_root_id(bigint,text,jsonb)', 'execute') as migrator_require
                """
            ).fetchone()
            assert all(bool(value) for value in privileges.values())

        from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

        track_path = str(main_root / "Artist" / "Album" / "01 Track.flac")
        file_entry = {
            "path": track_path,
            "mtime": 1710000000.0,
            "size": 12345,
            "album": "Album",
            "album_artist": "Artist",
            "title": "Track",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "artist": "Artist",
            "duration_seconds": 180,
            "cover_path": None,
            "year": 2026,
            "edition": "",
            "album_rating": 0,
            "library_root_id": "main-logical",
            "library_root_category": "main_library",
            "exception_type": None,
        }
        adapter = PostgresScanCacheAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url})
        adapter.save_snapshot(Path("unused.json"), {track_path: file_entry}, "root-linkage-live", 1710000001.0)

        with isolatedPostgres._connect(setup_url) as connection:
            persisted = connection.execute(
                "select library_root_id from library.local_track_files where private_path = %s",
                (track_path,),
            ).fetchone()
            assert int(persisted["library_root_id"]) == main_root_id
            connection.execute(
                "update library.library_roots set is_active = false where id = %s",
                (main_root_id,),
            )

        loaded, _last_scan, _relations, _built_at, error = adapter.load_snapshot(
            Path("unused.json"), "root-linkage-live"
        )
        assert error is None
        assert loaded == {}

        unresolved_path = r"Z:\Outside\Artist\Album\01 Track.flac"
        unresolved_entry = {**file_entry, "path": unresolved_path, "library_root_id": None}
        with pytest.raises(psycopg.errors.CheckViolation) as exc_info:
            adapter.save_snapshot(
                Path("unused.json"),
                {unresolved_path: unresolved_entry},
                "root-linkage-unresolved",
                1710000002.0,
            )
        assert exc_info.value.sqlstate == "23514"

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_root_linkage_migration_fails_atomically_then_succeeds_after_remediation(
    monkeypatch,
):
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    psycopg = pytest.importorskip("psycopg")
    migrations_root = Path(__file__).resolve().parents[2] / "migrations" / "postgres"
    migration_path = migrations_root / "0023_link_local_track_files_to_library_roots.sql"
    migration_sql = migration_path.read_text(encoding="utf-8")
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
            for path in sorted(migrations_root.glob("*.sql")):
                if path.name >= migration_path.name:
                    break
                connection.execute(path.read_text(encoding="utf-8"))

            account_id = int(
                connection.execute(
                    "insert into app.accounts (display_name, account_kind) values ('Root Migration Owner', 'local') returning id"
                ).fetchone()["id"]
            )
            library_id = int(
                connection.execute(
                    "insert into library.libraries (owner_account_id, name, library_kind) values (%s, 'Root Migration Library', 'local') returning id",
                    (account_id,),
                ).fetchone()["id"]
            )
            root_id = int(
                connection.execute(
                    "insert into library.library_roots (library_id, root_path, root_kind, is_active, metadata) values (%s, 'C:\\Music', 'main_library', true, '{\"root_id\":\"main-root\"}'::jsonb) returning id",
                    (library_id,),
                ).fetchone()["id"]
            )
            artist_id = int(
                connection.execute(
                    "insert into library.local_artists (library_id, artist_key, name, sort_name) values (%s, 'migration-artist', 'Migration Artist', 'Migration Artist') returning id",
                    (library_id,),
                ).fetchone()["id"]
            )
            album_id = int(
                connection.execute(
                    "insert into library.local_albums (library_id, artist_id, album_key, title) values (%s, %s, 'migration-album', 'Migration Album') returning id",
                    (library_id, artist_id),
                ).fetchone()["id"]
            )
            track_ids = connection.execute(
                """
                insert into library.local_tracks (
                  library_id, album_id, artist_id, track_key, title
                ) values
                  (%s, %s, %s, 'resolved-track', 'Resolved Track'),
                  (%s, %s, %s, 'unresolved-track', 'Unresolved Track')
                returning id, track_key
                """,
                (library_id, album_id, artist_id, library_id, album_id, artist_id),
            ).fetchall()
            track_id_by_key = {str(row["track_key"]): int(row["id"]) for row in track_ids}
            connection.execute(
                """
                insert into library.local_track_files (track_id, private_path, metadata)
                values
                  (%s, 'C:\\Music\\Artist\\resolved.flac', '{"sentinel":"resolved"}'::jsonb),
                  (%s, 'Z:\\Outside\\Artist\\unresolved.flac', '{"sentinel":"unresolved"}'::jsonb)
                """,
                (track_id_by_key["resolved-track"], track_id_by_key["unresolved-track"]),
            )

        with pytest.raises(psycopg.errors.CheckViolation) as exc_info:
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute(migration_sql)
        assert exc_info.value.sqlstate == "23514"
        assert exc_info.value.diag.message_detail == "unresolved_local_track_file_count=1"
        assert "repair active library-root" in str(exc_info.value.diag.message_hint)

        with isolatedPostgres._connect(setup_url) as connection:
            rolled_back_files = connection.execute(
                "select private_path, library_root_id, metadata from library.local_track_files order by private_path"
            ).fetchall()
            assert [row["library_root_id"] for row in rolled_back_files] == [None, None]
            assert [row["metadata"] for row in rolled_back_files] == [
                {"sentinel": "resolved"},
                {"sentinel": "unresolved"},
            ]
            functions = connection.execute(
                """
                select
                  to_regprocedure('library.local_path_style(text)') as path_style,
                  to_regprocedure('library.local_path_key(text)') as path_key,
                  to_regprocedure('library.local_track_file_root_resolution(bigint,text,jsonb)') as resolution,
                  to_regprocedure('library.require_local_track_file_root_id(bigint,text,jsonb)') as requirement
                """
            ).fetchone()
            assert all(value is None for value in functions.values())

            outside_root_id = int(
                connection.execute(
                    "insert into library.library_roots (library_id, root_path, root_kind, is_active, metadata) values (%s, 'Z:\\Outside', 'main_library', true, '{\"root_id\":\"outside-root\"}'::jsonb) returning id",
                    (library_id,),
                ).fetchone()["id"]
            )
            connection.execute(migration_sql)

        with isolatedPostgres._connect(setup_url) as connection:
            remediated_files = connection.execute(
                "select private_path, library_root_id, metadata from library.local_track_files order by private_path"
            ).fetchall()
            assert [int(row["library_root_id"]) for row in remediated_files] == [
                root_id,
                outside_root_id,
            ]
            assert [row["metadata"]["sentinel"] for row in remediated_files] == [
                "resolved",
                "unresolved",
            ]
            assert all(
                row["metadata"]["root_linkage"] == {
                    "status": "resolved",
                    "method": "longest-path-containment",
                    "migration": "0023_link_local_track_files_to_library_roots",
                }
                for row in remediated_files
            )
            function_count = int(
                connection.execute(
                    """
                    select count(*)
                    from unnest(array[
                      to_regprocedure('library.local_path_style(text)'),
                      to_regprocedure('library.local_path_key(text)'),
                      to_regprocedure('library.local_track_file_root_resolution(bigint,text,jsonb)'),
                      to_regprocedure('library.require_local_track_file_root_id(bigint,text,jsonb)')
                    ]) as installed(function_oid)
                    where function_oid is not null
                    """
                ).fetchone()["count"]
            )
            assert function_count == 4
            connection.execute(migration_sql)
            rerun_files = connection.execute(
                "select private_path, library_root_id, metadata from library.local_track_files order by private_path"
            ).fetchall()
            assert rerun_files == remediated_files

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)


def test_live_startup_relation_projection_collapses_inventory_whitespace_and_stays_atomic(
    monkeypatch,
    tmp_path,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    from music_app.services import relation_projection_postgres as projection

    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        config = {
            "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
            "MUSIC_DIR": str(music_dir),
        }
        from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
        from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {"id": "startup-music", "path": str(music_dir), "layout_mode": "artist"}
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )

        morse_path = str(
            music_dir / "Families" / "Progressive" / "Morse" / "Album" / "01.mp3"
        )
        paul_path = str(
            music_dir / "Families" / "Progressive" / "Paul" / "Album" / "01.mp3"
        )
        file_cache = {
            morse_path: {
                "path": morse_path,
                "mtime": 1.0,
                "size": 100,
                "album": "Morse Album",
                "album_artist": "Morse  Portnoy George",
                "artist": "Morse  Portnoy George",
                "title": "Morse Track",
                "track_number": 1,
                "disc_number": 1,
                "duration_seconds": 60,
                "year": 2026,
                "edition": "",
                "album_rating": 0,
            },
            paul_path: {
                "path": paul_path,
                "mtime": 1.0,
                "size": 100,
                "album": "Paul Album",
                "album_artist": "Paul  Gilbert",
                "artist": "Paul  Gilbert",
                "title": "Paul Track",
                "track_number": 1,
                "disc_number": 1,
                "duration_seconds": 60,
                "year": 2026,
                "edition": "",
                "album_rating": 0,
            },
        }
        PostgresScanCacheAdapter(
            config,
            connect=isolatedPostgres._connect,
        ).save_snapshot(
            Path("unused-live-scan-cache.json"),
            file_cache,
            "startup-relation-normalization",
            1.0,
        )
        with isolatedPostgres._connect(setup_url) as connection:
            library_id = int(
                connection.execute(
                    "select id from library.libraries where name = 'Local Library'"
                ).fetchone()["id"]
            )
            published_artists = connection.execute(
                """
                select artist_key, name
                from library.local_artists
                where library_id = %s
                order by artist_key
                """,
                (library_id,),
            ).fetchall()
        assert [(row["artist_key"], row["name"]) for row in published_artists] == [
            ("morse portnoy george", "Morse  Portnoy George"),
            ("paul gilbert", "Paul  Gilbert"),
        ]
        result = projection.ensure_relation_projection_ready(
            config,
            connect=isolatedPostgres._connect,
        )

        assert result["ready"] is True
        with isolatedPostgres._connect(setup_url) as connection:
            original_links = connection.execute(
                """
                select selected.artist_key, related.artist_key as family_artist_key
                from library.local_artist_family_links as links
                join library.local_artists as selected on selected.id = links.artist_id
                join library.local_artists as related on related.id = links.related_artist_id
                where links.source_family = 'folder_derived_runtime'
                order by selected.artist_key, related.artist_key
                """
            ).fetchall()
            status = connection.execute(
                """
                select metadata #>> '{scan_cache,relation_projection,status}' as status
                from library.libraries where id = %s
                """,
                (library_id,),
            ).fetchone()["status"]
        assert [
            (row["artist_key"], row["family_artist_key"])
            for row in original_links
        ] == [
            ("morse portnoy george", "paul gilbert"),
            ("paul gilbert", "morse portnoy george"),
        ]
        assert status == "ready"

        monkeypatch.setattr(
            projection,
            "build_relation_views_from_postgres_rows",
            lambda *_args: {
                "artists": ["Morse  Portnoy George", "Missing Artist"],
                "artists_sidebar": [],
                "family_to_artists": {},
                "folder_related": {"Morse  Portnoy George": {"Missing Artist"}},
                "sidebar_families": [],
                "alias_to_canonical": {},
                "canonical_to_aliases": {},
            },
        )
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                update library.libraries
                   set metadata = jsonb_set(
                     metadata,
                     '{scan_cache,relation_projection,status}',
                     '"failed"'::jsonb,
                     true
                   )
                 where id = %s
                """,
                (library_id,),
            )

        with pytest.raises(RuntimeError, match="unresolved_family_count=1"):
            projection.ensure_relation_projection_ready(
                config,
                connect=isolatedPostgres._connect,
            )

        with isolatedPostgres._connect(setup_url) as connection:
            retained_links = connection.execute(
                """
                select selected.artist_key, related.artist_key as family_artist_key
                from library.local_artist_family_links as links
                join library.local_artists as selected on selected.id = links.artist_id
                join library.local_artists as related on related.id = links.related_artist_id
                where links.source_family = 'folder_derived_runtime'
                order by selected.artist_key, related.artist_key
                """
            ).fetchall()
            failed_status = connection.execute(
                """
                select metadata #>> '{scan_cache,relation_projection,status}' as status
                from library.libraries where id = %s
                """,
                (library_id,),
            ).fetchone()["status"]
        assert retained_links == original_links
        assert failed_status == "failed"

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_startup_relation_projection_accepts_malformed_legacy_stale_metadata(
    monkeypatch,
    tmp_path,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    from music_app.services import state as state_service
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    malformed_path = str(music_dir / "Malformed Artist" / "Album" / "01 Track.mp3")
    active_false_path = str(music_dir / "Active False Artist" / "Album" / "01 Track.mp3")
    stale_true_path = str(music_dir / "Stale True Artist" / "Album" / "01 Track.mp3")
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
    }

    def file_entry(path: str, artist: str) -> dict[str, object]:
        return {
            "path": path,
            "mtime": 1.0,
            "size": 100,
            "album": f"{artist} Album",
            "album_artist": artist,
            "artist": artist,
            "title": "Track",
            "track_number": 1,
            "disc_number": 1,
            "duration_seconds": 60,
            "year": 2026,
            "edition": "",
            "album_rating": 0,
        }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {"id": "malformed-stale", "path": str(music_dir), "layout_mode": "artist"}
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        PostgresScanCacheAdapter(
            config,
            connect=isolatedPostgres._connect,
        ).save_snapshot(
            Path("unused-malformed-stale-scan-cache.json"),
            {
                malformed_path: file_entry(malformed_path, "Malformed Stale Artist"),
                active_false_path: file_entry(active_false_path, "Active False Artist"),
                stale_true_path: file_entry(stale_true_path, "Stale True Artist"),
            },
            "malformed-stale-live",
            1.0,
        )

        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                update library.local_track_files
                   set metadata = jsonb_set(
                     metadata,
                     '{scan_cache,stale}',
                     '"definitely-not-a-boolean"'::jsonb,
                     true
                   )
                 where private_path = %s
                returning private_path, scan_cache_stale
                """,
                (malformed_path,),
            )
            connection.execute(
                """
                update library.local_track_files
                   set metadata = jsonb_set(
                     metadata,
                     '{scan_cache,stale}',
                     'true'::jsonb,
                     true
                   )
                 where private_path = %s
                """,
                (stale_true_path,),
            )
            connection.execute(
                """
                update library.libraries
                   set metadata = jsonb_set(
                     metadata,
                     '{scan_cache,relation_projection,status}',
                     '"failed"'::jsonb,
                     true
                   )
                 where name = 'Local Library'
                   and library_kind = 'local'
                """
            )
            stale_rows = connection.execute(
                """
                select private_path, scan_cache_stale
                from library.local_track_files
                order by private_path
                """
            ).fetchall()
        assert {row["private_path"]: row["scan_cache_stale"] for row in stale_rows} == {
            active_false_path: False,
            malformed_path: False,
            stale_true_path: True,
        }

        runtime = SimpleNamespace(
            config=config,
            library_state={},
            logger=logging.getLogger("test.malformed_stale_relation_projection"),
        )
        result = state_service.ensure_runtime_relation_projection_ready(runtime)

        assert result["ready"] is True
        assert result["startup_rebuilt"] is True
        projected_artists = set(result["relation_views"]["artists"])
        assert "Malformed Stale Artist" in projected_artists
        assert "Active False Artist" in projected_artists
        assert "Stale True Artist" not in projected_artists
        assert runtime.library_state["relation_projection_ready"] is True
        assert runtime.library_state["relation_projection_rebuild_reason"] == "missing_projection"
        with isolatedPostgres._connect(setup_url) as connection:
            relation_status = connection.execute(
                """
                select metadata #>> '{scan_cache,relation_projection,status}' as status
                from library.libraries
                where name = 'Local Library'
                  and library_kind = 'local'
                """
            ).fetchone()["status"]
        assert relation_status == "ready"

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)


def test_live_scan_snapshot_replaces_only_scan_owned_featured_artist_memberships(
    monkeypatch,
    tmp_path,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
        "APP_NAME": "Album Haven",
    }

    def file_entry(
        path: Path,
        *,
        album: str,
        album_artist: str,
        artist: str,
    ) -> dict[str, object]:
        return {
            "path": str(path),
            "mtime": 1.0,
            "size": 100,
            "album": album,
            "album_artist": album_artist,
            "artist": artist,
            "title": "Track",
            "track_number": 1,
            "disc_number": 1,
            "duration_seconds": 60,
            "year": 2026,
            "edition": "",
            "album_rating": 0,
            "library_root_id": "scan-membership-root",
            "library_root_category": "main_library",
            "exception_type": None,
        }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
        from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {
                        "id": "scan-membership-root",
                        "path": str(music_dir),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        retained_path = music_dir / "Owner" / "Retained Album" / "01.flac"
        removed_path = music_dir / "Archived Owner" / "Removed Album" / "01.flac"
        first_snapshot = {
            str(retained_path): file_entry(
                retained_path,
                album="Retained Album",
                album_artist="Owner",
                artist="Owner feat. Old Guest",
            ),
            str(removed_path): file_entry(
                removed_path,
                album="Removed Album",
                album_artist="Archived Owner",
                artist="Archived Owner",
            ),
        }
        adapter = PostgresScanCacheAdapter(config, connect=isolatedPostgres._connect)
        adapter.save_snapshot(
            Path("unused-scan-membership.json"),
            first_snapshot,
            "scan-membership-root-identity",
            1.0,
        )

        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                with bootstrap_context as (
                  select library.libraries.id as library_id
                  from app.bootstrap_owners
                  join library.libraries
                    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
                  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                ),
                curated_artist as (
                  insert into library.local_artists (
                    library_id, artist_key, name, sort_name, metadata
                  )
                  select
                    bootstrap_context.library_id,
                    'curated guest',
                    'Curated Guest',
                    'curated guest',
                    '{"source":"manual_curator"}'::jsonb
                  from bootstrap_context
                  returning library_id, id
                )
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind, metadata
                )
                select
                  curated_artist.library_id,
                  library.local_albums.id,
                  curated_artist.id,
                  'featured_member',
                  '{"source":"manual_curator"}'::jsonb
                from curated_artist
                join library.local_albums
                  on library.local_albums.library_id = curated_artist.library_id
                 and library.local_albums.title = 'Retained Album'
                """
            )
            connection.execute(
                """
                update library.local_album_featured_artists
                   set metadata = '{"source":"manual_curator"}'::jsonb
                from library.local_albums, library.local_artists
                where library.local_album_featured_artists.album_id = library.local_albums.id
                  and library.local_album_featured_artists.artist_id = library.local_artists.id
                  and library.local_albums.title = 'Retained Album'
                  and library.local_artists.name = 'Owner'
                  and library.local_album_featured_artists.featured_kind = 'owner'
                """
            )

        second_snapshot = {
            str(retained_path): file_entry(
                retained_path,
                album="Retained Album",
                album_artist="Owner",
                artist="Owner feat. New Guest",
            )
        }
        adapter.save_snapshot(
            Path("unused-scan-membership.json"),
            second_snapshot,
            "scan-membership-root-identity",
            2.0,
        )

        with isolatedPostgres._connect(setup_url) as connection:
            memberships = connection.execute(
                """
                select
                  library.local_albums.title as album_title,
                  library.local_artists.name as artist_name,
                  library.local_album_featured_artists.featured_kind,
                  library.local_album_featured_artists.metadata ->> 'source' as source
                from library.local_album_featured_artists
                join library.local_albums
                  on library.local_albums.id = library.local_album_featured_artists.album_id
                join library.local_artists
                  on library.local_artists.id = library.local_album_featured_artists.artist_id
                order by album_title, artist_name, featured_kind
                """
            ).fetchall()
            from music_app.services.relation_projection_postgres import (
                build_relation_views_from_postgres_rows,
                load_relation_source_rows_sql,
            )

            relation_rows = list(connection.execute(load_relation_source_rows_sql()).fetchall())

        assert relation_rows
        assert all(
            row["library_root_id"]
            and str(row["root_path"] or "").strip()
            and str(row["private_path"] or "").strip()
            and "relative_path" in row
            for row in relation_rows
        )
        assert all(
            not Path(str(row["private_path"])).exists()
            for row in relation_rows
        )
        membership_facts = {
            (
                row["album_title"],
                row["artist_name"],
                row["featured_kind"],
                row["source"],
            )
            for row in memberships
        }
        assert (
            "Retained Album",
            "Curated Guest",
            "featured_member",
            "manual_curator",
        ) in membership_facts
        assert (
            "Retained Album",
            "Owner",
            "owner",
            "manual_curator",
        ) in membership_facts
        assert not any(
            source == "runtime_scan_cache"
            for album_title, _artist, _kind, source in membership_facts
            if album_title == "Removed Album"
        )
        assert not any(artist == "Old Guest" for _album, artist, _kind, _source in membership_facts)
        assert any(artist == "New Guest" for _album, artist, _kind, _source in membership_facts)

        from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

        browse_payload = PostgresLibraryBrowseRepository(
            config,
            connect=isolatedPostgres._connect,
        ).build_root_sidebar_payload()
        browse_artists = {row["artist"] for row in browse_payload["artists_sidebar"]}
        assert "New Guest" in browse_artists
        assert "Old Guest" not in browse_artists
        assert "Archived Owner" not in browse_artists
        assert "Curated Guest" in browse_artists

        relation_views = build_relation_views_from_postgres_rows(config, relation_rows)
        relation_artists = set(relation_views["artists"])
        assert "New Guest" in relation_artists
        assert "Old Guest" not in relation_artists
        assert "Archived Owner" not in relation_artists
        assert "Curated Guest" in relation_artists

        isolatedPostgres.reset_application_tables(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            isolatedPostgres.reset_application_tables(setup_url)
