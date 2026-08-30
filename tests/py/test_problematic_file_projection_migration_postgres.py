from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

import pytest

from tests.e2e.support import isolatedPostgres

from music_app.services.utils import MOJIBAKE_CANDIDATE_MARKERS, looks_like_mojibake

try:
    import psycopg
except ImportError:  # pragma: no cover - skipped without the runtime driver.
    psycopg = None


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    REPO_ROOT
    / "migrations"
    / "postgres"
    / "0021_add_problematic_file_generated_projection.sql"
)
SETUP_DATABASE_URL = os.environ.get(
    "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL",
    "",
).strip()
RUNTIME_DATABASE_URL = os.environ.get(
    "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL",
    "",
).strip()
GENERATED_COLUMNS = (
    "scan_cache_stale",
    "scan_file_entry_is_object",
    "scan_file_album",
    "scan_file_album_artist",
    "scan_file_artist",
    "scan_file_title",
    "scan_file_year",
    "scan_file_track_number",
    "scan_file_text_mojibake_candidate",
    "scan_file_metadata_problem_candidate",
)


def _isolated_migrator_url_or_skip() -> str:
    if psycopg is None or not SETUP_DATABASE_URL:
        pytest.skip(
            "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL is required for the isolated migration contract."
        )
    parsed = urlparse(SETUP_DATABASE_URL)
    database_name = Path(parsed.path or "").name.casefold()
    username = (parsed.username or "").casefold()
    legacy_identity = database_name == "album_haven_scan_e2e" and username == "album_haven_migrator"
    suffix = database_name.removeprefix("album_haven_ci_") if database_name.startswith("album_haven_ci_") else ""
    ci_identity = bool(suffix) and username == f"album_haven_migrator_{suffix}"
    if not legacy_identity and not ci_identity:
        pytest.fail(
            "Projection migration contract requires the isolated album_haven_scan_e2e "
            "database and migrator credentials."
        )
    return SETUP_DATABASE_URL


def _isolated_runtime_url_or_skip() -> str:
    if psycopg is None or not RUNTIME_DATABASE_URL:
        pytest.skip(
            "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL is required for the runtime write contract."
        )
    parsed = urlparse(RUNTIME_DATABASE_URL)
    database_name = Path(parsed.path or "").name.casefold()
    username = (parsed.username or "").casefold()
    legacy_identity = database_name == "album_haven_scan_e2e" and username == "album_haven_app"
    suffix = database_name.removeprefix("album_haven_ci_") if database_name.startswith("album_haven_ci_") else ""
    ci_identity = bool(suffix) and username == f"album_haven_app_{suffix}"
    if not legacy_identity and not ci_identity:
        pytest.fail(
            "Projection runtime contract requires album_haven_app on the isolated "
            "album_haven_scan_e2e database."
        )
    return RUNTIME_DATABASE_URL


def _generated_column_catalog(connection) -> list[tuple[str, str, str]]:
    return connection.execute(
        """
        select
          attribute.attname,
          attribute.attgenerated,
          pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
        from pg_attribute as attribute
        join pg_class as relation on relation.oid = attribute.attrelid
        join pg_namespace as namespace on namespace.oid = relation.relnamespace
        left join pg_attrdef as attribute_default
          on attribute_default.adrelid = attribute.attrelid
         and attribute_default.adnum = attribute.attnum
        where namespace.nspname = 'library'
          and relation.relname = 'local_track_files'
          and attribute.attname = any(%s)
          and not attribute.attisdropped
        order by attribute.attname
        """,
        (list(GENERATED_COLUMNS),),
    ).fetchall()


def test_problematic_file_projection_migration_upgrades_and_reruns_idempotently():
    database_url = _isolated_migrator_url_or_skip()
    migration_sql = MIGRATION_PATH.read_text(encoding="utf-8")
    drop_columns_sql = ", ".join(
        f"drop column if exists {column}" for column in GENERATED_COLUMNS
    )

    with psycopg.connect(database_url) as connection:
        try:
            connection.execute(
                "alter table library.local_tracks drop column if exists scan_title_problem_candidate"
            )
            connection.execute(
                "alter table library.local_artists drop column if exists scan_name_problem_candidate"
            )
            connection.execute(f"alter table library.local_track_files {drop_columns_sql}")
            connection.execute(
                """
                create index local_track_files_active_track_projection_idx
                on library.local_track_files (track_id)
                """
            )

            connection.execute(migration_sql)
            first_catalog = _generated_column_catalog(connection)
            assert connection.execute(
                "select to_regclass('library.local_track_files_active_track_projection_idx')"
            ).fetchone() == (None,)
            assert [row[0] for row in first_catalog] == sorted(GENERATED_COLUMNS)
            assert all(row[1] == "s" for row in first_catalog)
            assert all(row[2] for row in first_catalog)
            cross_table_catalog = connection.execute(
                """
                select relation.relname, attribute.attname, attribute.attgenerated
                from pg_attribute as attribute
                join pg_class as relation on relation.oid = attribute.attrelid
                join pg_namespace as namespace on namespace.oid = relation.relnamespace
                where namespace.nspname = 'library'
                  and (relation.relname, attribute.attname) in (
                    ('local_tracks', 'scan_title_problem_candidate'),
                    ('local_artists', 'scan_name_problem_candidate')
                  )
                  and not attribute.attisdropped
                order by relation.relname
                """
            ).fetchall()
            assert cross_table_catalog == [
                ("local_artists", "scan_name_problem_candidate", "s"),
                ("local_tracks", "scan_title_problem_candidate", "s"),
            ]
            stale_expression = next(
                expression
                for column, _generated, expression in first_catalog
                if column == "scan_cache_stale"
            )
            assert "::boolean" not in stale_expression
            assert "scan_cache" in stale_expression

            function_catalog = connection.execute(
                """
                select procedure.provolatile, procedure.proparallel, procedure.prosrc
                from pg_proc as procedure
                join pg_namespace as namespace on namespace.oid = procedure.pronamespace
                where namespace.nspname = 'library'
                  and procedure.proname = 'problematic_text_candidate'
                  and pg_get_function_identity_arguments(procedure.oid) = 'candidate_text text'
                """
            ).fetchone()
            assert function_catalog is not None
            volatility, parallel_safety, function_source = function_catalog
            assert volatility == "i"
            assert parallel_safety == "s"
            assert "regexp_split_to_table" in function_source
            assert "45 * char_length" in function_source
            assert connection.execute(
                "select has_function_privilege('album_haven_app', 'library.problematic_text_candidate(text)', 'EXECUTE')"
            ).fetchone() == (True,)
            assert connection.execute(
                """
                select not exists (
                  select 1
                  from pg_proc as procedure
                  cross join lateral aclexplode(procedure.proacl) as privilege
                  join pg_namespace as namespace on namespace.oid = procedure.pronamespace
                  where namespace.nspname = 'library'
                    and procedure.proname = 'problematic_text_candidate'
                    and privilege.grantee = 0
                    and privilege.privilege_type = 'EXECUTE'
                )
                """
            ).fetchone() == (True,)

            connection.execute(migration_sql)
            assert _generated_column_catalog(connection) == first_catalog
            assert connection.execute(
                "select to_regclass('library.local_track_files_active_track_projection_idx')"
            ).fetchone() == (None,)
        finally:
            connection.rollback()


def test_problematic_text_candidate_function_matches_python_strong_signal_contract():
    database_url = _isolated_migrator_url_or_skip()
    samples = tuple(MOJIBAKE_CANDIDATE_MARKERS) + (
        "Healthy Album",
        "François déjà vu à São Paulo",
        "Музыкальный альбом",
        "Broken??Text",
        "Broken�Text",
        "¨¨¨abc",
        "Ð",
        "Insound Tour Support".encode("utf-16le").decode("utf-16be"),
    )
    expected = [
        looks_like_mojibake(sample, require_repair_improvement=False)
        for sample in samples
    ]

    with psycopg.connect(database_url) as connection:
        actual = [
            connection.execute(
                "select library.problematic_text_candidate(%s)",
                (sample,),
            ).fetchone()[0]
            for sample in samples
        ]

    assert actual == expected


def test_album_haven_app_upsert_executes_generated_candidate_function():
    database_url = _isolated_runtime_url_or_skip()
    setup_url = _isolated_migrator_url_or_skip()
    isolatedPostgres.prepare_isolated_database(setup_url, database_url)
    with psycopg.connect(database_url) as connection:
        try:
            library_id = connection.execute(
                "select id from library.libraries order by id limit 1"
            ).fetchone()[0]
            artist_row = connection.execute(
                """
                insert into library.local_artists(library_id, artist_key, name)
                values (%s, 'projection-runtime-contract-artist', 'Contract Artist')
                returning id, scan_name_problem_candidate
                """,
                (library_id,),
            ).fetchone()
            artist_id, artist_candidate = artist_row
            assert artist_candidate is False
            album_id = connection.execute(
                """
                insert into library.local_albums(library_id, artist_id, album_key, title, release_year)
                values (%s, %s, 'projection-runtime-contract-album', 'Contract Album', 2026)
                returning id
                """,
                (library_id, artist_id),
            ).fetchone()[0]
            track_row = connection.execute(
                """
                insert into library.local_tracks(
                  library_id, album_id, artist_id, track_key, title, track_number
                )
                values (%s, %s, %s, 'projection-runtime-contract-track', 'Contract Track', 1)
                returning id, scan_title_problem_candidate
                """,
                (library_id, album_id, artist_id),
            ).fetchone()
            track_id, track_candidate = track_row
            assert track_candidate is False
            suspicious_metadata = (
                '{"scan_cache":{"stale":false,"file_entry":{'
                '"album":"Healthy Album Name That Must Not Dilute Another Field",'
                '"album_artist":"Healthy Album Artist",'
                '"artist":"Healthy Track Artist",'
                '"title":"¨¨¨abc",'
                '"year":"2026",'
                '"track_number":"1"}}}'
            )
            healthy_metadata = (
                '{"scan_cache":{"stale":false,"file_entry":{"album":"Contract Album"}}}'
            )
            candidate = connection.execute(
                """
                insert into library.local_track_files(track_id, private_path, metadata)
                values (%s, 'C:\\projection-runtime-contract.flac', %s::jsonb)
                on conflict (private_path) do update set metadata = excluded.metadata
                returning scan_file_text_mojibake_candidate
                """,
                (track_id, suspicious_metadata),
            ).fetchone()[0]
            assert candidate is True
            candidate = connection.execute(
                """
                insert into library.local_track_files(track_id, private_path, metadata)
                values (%s, 'C:\\projection-runtime-contract.flac', %s::jsonb)
                on conflict (private_path) do update set metadata = excluded.metadata
                returning scan_file_text_mojibake_candidate
                """,
                (track_id, healthy_metadata),
            ).fetchone()[0]
            assert candidate is False
            invalid_numeric_metadata = (
                '{"scan_cache":{"stale":false,"file_entry":{'
                '"album":"Contract Album","title":"Contract Track",'
                '"year":"not-a-year","track_number":"1"}}}'
            )
            text_candidate, metadata_candidate = connection.execute(
                """
                insert into library.local_track_files(track_id, private_path, metadata)
                values (%s, 'C:\\projection-runtime-contract.flac', %s::jsonb)
                on conflict (private_path) do update set metadata = excluded.metadata
                returning
                  scan_file_text_mojibake_candidate,
                  scan_file_metadata_problem_candidate
                """,
                (track_id, invalid_numeric_metadata),
            ).fetchone()
            assert text_candidate is False
            assert metadata_candidate is True
        finally:
            connection.rollback()
            isolatedPostgres.reset_application_tables(setup_url)
