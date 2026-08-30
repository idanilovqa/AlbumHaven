from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from threading import Barrier

import pytest

from tests.e2e.support import isolatedPostgres


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    REPO_ROOT
    / "migrations"
    / "postgres"
    / "0034_reconcile_semantic_local_albums.sql"
)
IDENTITY_ENFORCEMENT_MIGRATION_PATH = (
    REPO_ROOT
    / "migrations"
    / "postgres"
    / "0035_enforce_semantic_local_album_identity.sql"
)
def _dedicated_database_urls_or_skip(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[str, str]:
    setup_value = str(
        os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or ""
    ).strip()
    runtime_value = str(
        os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV) or ""
    ).strip()
    if not setup_value and not runtime_value:
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")

    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    pgpass_value = str(os.environ.get("PGPASSFILE") or "").strip()
    if not pgpass_value:
        pytest.skip("Dedicated isolated Postgres PGPASSFILE is not configured.")
    pgpass_path = Path(pgpass_value)
    if not pgpass_path.is_file():
        pytest.skip(
            f"Dedicated isolated Postgres pgpass file is unavailable: {pgpass_path}"
        )
    monkeypatch.setenv("PGPASSFILE", str(pgpass_path))

    psycopg = pytest.importorskip("psycopg")
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection, isolatedPostgres.SETUP_ROLE
            )
        with isolatedPostgres._connect(runtime_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection, isolatedPostgres.RUNTIME_ROLE
            )
    except psycopg.OperationalError as exc:
        pytest.skip(f"Dedicated isolated Postgres database is unavailable: {exc}")
    return setup_url, runtime_url


def _drop_application_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(
            connection, isolatedPostgres.SETUP_ROLE
        )
        connection.execute(
            "drop schema if exists app, integration, library, ops cascade"
        )


def _bootstrap_library_id(connection) -> int:
    return int(
        connection.execute(
            """
            select library.libraries.id
            from app.bootstrap_owners
            join library.libraries
              on library.libraries.owner_account_id =
                 app.bootstrap_owners.account_id
            where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
            limit 1
            """
        ).fetchone()["id"]
    )


def test_live_cleanup_migration_precedes_identity_enforcement(
    monkeypatch: pytest.MonkeyPatch,
):
    psycopg = pytest.importorskip("psycopg")
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        migration_paths = sorted(
            path
            for path in (REPO_ROOT / "migrations" / "postgres").glob("*.sql")
            if path.name <= "0033_repair_section14_album_identity_corruption.sql"
        )
        with isolatedPostgres._connect(setup_url) as connection:
            for migration_path in migration_paths:
                connection.execute(migration_path.read_text(encoding="utf-8"))
        isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)

        with isolatedPostgres._connect(setup_url) as connection:
            library_id = _bootstrap_library_id(connection)
            artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (%s, 'pre-enforcement-artist', 'Pre-enforcement Artist', '{}')
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.local_albums (
                  library_id, artist_id, album_key, title, release_year, metadata
                )
                values
                  (%s, %s, 'pre-enforcement::one', 'Same Album', null, '{"edition":"Original"}'),
                  (%s, %s, 'pre-enforcement::two', ' same album ', null, '{"edition":" original "}')
                """,
                (library_id, artist_id, library_id, artist_id),
            )

        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(MIGRATION_PATH.read_text(encoding="utf-8"))
            remaining_count = int(
                connection.execute(
                    """
                    select count(*)
                    from library.local_albums
                    where library_id = %s
                      and artist_id = %s
                      and lower(btrim(title)) = 'same album'
                    """,
                    (library_id, artist_id),
                ).fetchone()["count"]
            )
            connection.execute(
                IDENTITY_ENFORCEMENT_MIGRATION_PATH.read_text(encoding="utf-8")
            )

        assert remaining_count == 1

        with pytest.raises(psycopg.errors.UniqueViolation) as upgrade_error:
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title, release_year, metadata
                    )
                    values (
                      %s, %s, 'post-enforcement::duplicate',
                      ' SAME ALBUM ', null, '{"edition":" original "}'
                    )
                    """,
                    (library_id, artist_id),
                )
        assert upgrade_error.value.sqlstate == "23505"
        assert (
            upgrade_error.value.diag.constraint_name
            == "local_albums_semantic_identity_key"
        )

        with isolatedPostgres._connect(setup_url) as connection:
            post_rejection_count = int(
                connection.execute(
                    """
                    select count(*)
                    from library.local_albums
                    where library_id = %s
                      and artist_id = %s
                      and lower(btrim(title)) = 'same album'
                    """,
                    (library_id, artist_id),
                ).fetchone()["count"]
            )
        assert post_rejection_count == 1

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)


def test_live_identity_enforcement_reconciles_marker_removal_and_artist_rename(
    monkeypatch: pytest.MonkeyPatch,
):
    from music_app.services.rule_state_postgres import RuleStatePostgresAdapter
    from music_app.services.scan_cache_persistence import (
        PostgresScanCacheAdapter,
        ScanCachePublicationSuperseded,
    )

    psycopg = pytest.importorskip("psycopg")
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        with isolatedPostgres._connect(setup_url) as connection:
            library_id = _bootstrap_library_id(connection)
            artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (%s, 'identity-artist', 'Identity Artist', '{}')
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )

        with pytest.raises(psycopg.errors.UniqueViolation) as unmarked_error:
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title, release_year, metadata
                    )
                    values
                      (%s, %s, 'unmarked::one', 'Unmarked Album', null, '{"edition":""}'),
                      (%s, %s, 'unmarked::two', ' unmarked album ', null, '{"edition":" "}')
                    """,
                    (library_id, artist_id, library_id, artist_id),
                )
        assert unmarked_error.value.sqlstate == "23505"
        assert (
            unmarked_error.value.diag.constraint_name
            == "local_albums_semantic_identity_key"
        )

        release_key = "identity artist::marked album::deluxe"
        rename_release_key = "identity artist::rename album::deluxe"
        renamed_release_key = (
            "renamed identity artist::rename album::deluxe"
        )
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                insert into library.local_albums (
                  library_id, artist_id, album_key, title, release_year, metadata
                )
                values (
                  %s, %s, 'unmarked::ordinary', 'Ordinary Album', 2026,
                  '{"edition":""}'
                )
                """,
                (library_id, artist_id),
            )
            connection.execute(
                """
                insert into library.separate_releases (library_id, release_key)
                values (%s, %s)
                """,
                (library_id, rename_release_key),
            )
            connection.execute(
                """
                insert into library.local_albums (
                  library_id, artist_id, album_key, title, release_year, metadata
                )
                values
                  (
                    %s, %s, 'rename::one', 'Rename Album', 2026,
                    '{"album_artist":" ","edition":"Deluxe"}'
                  ),
                  (
                    %s, %s, 'rename::two', ' rename album ', 2026,
                    '{"album_artist":"   ","edition":" deluxe "}'
                  ),
                  (
                    %s, %s, 'rename::three', 'RENAME ALBUM', 2026,
                    '{"album_artist":"Identity Artist","edition":"DELUXE"}'
                  ),
                  (
                    %s, %s, 'rename::four', 'Rename Album', 2026,
                    '{"album_artist":" Identity Artist ","edition":" Deluxe "}'
                  )
                """,
                (
                    library_id,
                    artist_id,
                    library_id,
                    artist_id,
                    library_id,
                    artist_id,
                    library_id,
                    artist_id,
                ),
            )
            connection.execute(
                """
                insert into library.local_albums (
                  library_id, artist_id, album_key, title, release_year, metadata
                )
                values (
                  %s, %s, 'marked::one', 'Marked Album', 2026,
                  '{"album_artist":"   ","edition":"Deluxe"}'
                )
                """,
                (library_id, artist_id),
            )
            rename_album_ids = connection.execute(
                """
                select id, album_key
                from library.local_albums
                where library_id = %s
                  and lower(btrim(title)) = 'rename album'
                order by id
                """,
                (library_id,),
            ).fetchall()
            for fixture_name, album_rows in (("rename", rename_album_ids),):
                for position, album_row in enumerate(album_rows, start=1):
                    connection.execute(
                        """
                        insert into library.local_tracks (
                          library_id, album_id, artist_id, track_key, title,
                          metadata
                        )
                        values (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            library_id,
                            int(album_row["id"]),
                            artist_id,
                            f"{fixture_name}-track-{position}",
                            f"{fixture_name.title()} Track {position}",
                            json.dumps(
                                {"source_album_key": album_row["album_key"]}
                            ),
                        ),
                    )
            connection.execute(
                """
                insert into library.separate_releases (library_id, release_key)
                values (%s, %s)
                """,
                (library_id, release_key),
            )
            connection.execute(
                """
                insert into library.local_albums (
                  library_id, artist_id, album_key, title, release_year, metadata
                )
                values
                  (
                    %s, %s, 'marked::two', ' marked album ', 2026,
                    '{"album_artist":" ","edition":" deluxe "}'
                  ),
                  (
                    %s, %s, 'marked::three', 'MARKED ALBUM', 2026,
                    '{"album_artist":"  ","edition":"DELUXE"}'
                  )
                """,
                (library_id, artist_id, library_id, artist_id),
            )
            marked_album_ids = connection.execute(
                """
                select id, album_key
                from library.local_albums
                where library_id = %s
                  and lower(btrim(title)) = 'marked album'
                order by id
                """,
                (library_id,),
            ).fetchall()
            redundant_marked_album_id = int(marked_album_ids[1]["id"])
            account_id = int(
                connection.execute(
                    """
                    select account_id
                    from app.bootstrap_owners
                    where owner_key = 'local-bootstrap-owner'
                    """
                ).fetchone()["account_id"]
            )
            connection.execute(
                """
                update library.local_albums
                set
                  cover_path = '/covers/marked-two.jpg',
                  metadata = metadata || '{"redundant":"preserved"}'::jsonb
                where id = %s
                """,
                (redundant_marked_album_id,),
            )
            connection.execute(
                """
                insert into app.album_ratings (
                  account_id, library_id, album_key, rating, provenance,
                  created_at, updated_at
                )
                values
                  (
                    %s, %s, 'marked::two', 4, 'fixture-old',
                    '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
                  ),
                  (
                    %s, %s, 'marked::three', 9, 'fixture',
                    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                  )
                """,
                (account_id, library_id, account_id, library_id),
            )
            connection.execute(
                """
                insert into library.ignored_versions (
                  library_id, version_key, metadata
                )
                values (%s, 'marked::two', '{"ignored":"preserved"}')
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into library.manual_versions (
                  library_id, child_key, parent_key,
                  created_at, updated_at, metadata
                )
                values
                  (
                    %s, 'marked::one', 'fixture::canonical-parent',
                    '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
                    '{"manual":"canonical-preserved"}'
                  ),
                  (
                    %s, 'marked::two', 'fixture::newest-parent',
                    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
                    '{"manual":"newest-redundant"}'
                  ),
                  (
                    %s, 'marked::three', 'fixture::older-parent',
                    '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z',
                    '{"manual":"older-redundant"}'
                  )
                """,
                (library_id, library_id, library_id),
            )
            connection.execute(
                """
                insert into ops.cover_lookup_tasks (
                  library_id, task_key, status, album_key, metadata
                )
                values (
                  %s, 'marker-removal-cover', 'completed', 'marked::two',
                  '{"cover":"preserved"}'
                )
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind, metadata
                )
                values (
                  %s, %s, %s, 'owner', '{"featured":"preserved"}'
                )
                """,
                (library_id, redundant_marked_album_id, artist_id),
            )
            connection.execute(
                """
                insert into library.local_mbid_assertions (
                  library_id, album_id, target_kind, target_key,
                  evidence_source, mbid_assertion_state, source_payload
                )
                values (
                  %s, %s, 'album', 'marked::two',
                  'fixture', 'unreviewed', '{"assertion":"preserved"}'
                )
                """,
                (library_id, redundant_marked_album_id),
            )
            for position, album_row in enumerate(marked_album_ids, start=1):
                connection.execute(
                    """
                    insert into library.local_tracks (
                      library_id, album_id, artist_id, track_key, title,
                      metadata
                    )
                    values (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        library_id,
                        int(album_row["id"]),
                        artist_id,
                        f"marked-track-{position}",
                        f"Marked Track {position}",
                        json.dumps(
                            {"source_album_key": album_row["album_key"]}
                        ),
                    ),
                )

            connection.execute(
                """
                update library.local_albums
                set semantic_identity_discriminator = 'forged'
                where library_id = %s and album_key = 'unmarked::ordinary'
                """,
                (library_id,),
            )

        marker_adapter = RuleStatePostgresAdapter(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
        )
        marker_adapter.save_separate_release_keys(
            {release_key, rename_release_key}
        )
        with isolatedPostgres._connect(setup_url) as connection:
            prepared_snapshot_revision = int(
                connection.execute(
                    """
                    select coalesce(
                      nullif(metadata ->> 'inventory_mutation_revision', '')::bigint,
                      0
                    ) as revision
                    from library.libraries
                    where id = %s
                    """,
                    (library_id,),
                ).fetchone()["revision"]
            )
        marker_adapter.save_separate_release_keys({rename_release_key})
        snapshot_adapter = PostgresScanCacheAdapter(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
        )
        with pytest.raises(ScanCachePublicationSuperseded):
            snapshot_adapter.save_snapshot(
                Path("unused.json"),
                {},
                "prepared-before-marker-removal",
                1.0,
                separate_release_keys={release_key, rename_release_key},
                expected_cover_mutation_revision=(
                    snapshot_adapter.load_cover_mutation_revision()
                ),
                expected_inventory_mutation_revision=(
                    prepared_snapshot_revision
                ),
            )
        with isolatedPostgres._connect(setup_url) as connection:
            assert int(
                connection.execute(
                    """
                    select count(*)
                    from library.local_albums
                    where library_id = %s
                      and lower(btrim(title)) = 'marked album'
                    """,
                    (library_id,),
                ).fetchone()["count"]
            ) == 1

        with isolatedPostgres._connect(setup_url) as connection:
            destination_library_id = int(
                connection.execute(
                    """
                    insert into library.libraries (
                      owner_account_id, name, library_kind, metadata
                    )
                    select
                      owner_account_id,
                      'Artist Move Rejection Destination',
                      library_kind,
                      '{"fixture":"artist-library-move"}'::jsonb
                    from library.libraries
                    where id = %s
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )

        with pytest.raises(psycopg.errors.CheckViolation) as artist_move_error:
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute(
                    """
                    update library.local_artists
                    set library_id = %s
                    where id = %s
                    """,
                    (destination_library_id, artist_id),
                )
        assert artist_move_error.value.sqlstate == "23514"
        assert (
            artist_move_error.value.diag.constraint_name
            == "local_artists_library_id_immutable"
        )

        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                update library.local_artists
                set name = 'Renamed Identity Artist'
                where id = %s
                """,
                (artist_id,),
            )

        with isolatedPostgres._connect(setup_url) as connection:
            persisted = connection.execute(
                """
                select
                  (select count(*) from library.local_albums
                   where library_id = %s
                     and lower(btrim(title)) = 'marked album') as album_count,
                  (select count(*) from library.separate_releases
                   where library_id = %s and release_key = %s) as marker_count,
                  (select count(*) from library.local_albums
                   where library_id = %s
                     and lower(btrim(title)) = 'rename album') as rename_album_count,
                  (select count(*) from library.local_tracks
                   where library_id = %s
                     and album_id in (
                       select id from library.local_albums
                       where library_id = %s
                         and lower(btrim(title)) = 'marked album'
                     )) as marked_track_count,
                  (select count(*) from library.local_tracks
                   where library_id = %s
                     and album_id in (
                       select id from library.local_albums
                       where library_id = %s
                         and lower(btrim(title)) = 'rename album'
                     )) as rename_track_count,
                  (select name from library.local_artists
                   where id = %s) as artist_name,
                  (select library_id from library.local_artists
                   where id = %s) as artist_library_id,
                  (select semantic_identity_discriminator
                   from library.local_albums
                   where library_id = %s
                     and album_key = 'unmarked::ordinary') as ordinary_discriminator,
                  (select array_agg(
                     semantic_identity_discriminator
                     order by semantic_identity_discriminator
                   )
                   from library.local_albums
                   where library_id = %s
                     and lower(btrim(title)) = 'marked album') as marked_discriminators,
                  (select array_agg(
                     semantic_identity_discriminator
                     order by semantic_identity_discriminator
                   )
                   from library.local_albums
                   where library_id = %s
                     and lower(btrim(title)) = 'rename album') as rename_discriminators,
                  (select array_agg(distinct library_id order by library_id)
                   from library.local_albums
                   where artist_id = %s) as album_library_ids,
                  (select array_agg(distinct library_id order by library_id)
                   from library.separate_releases
                   where release_key = %s) as marker_library_ids,
                  (select array_agg(release_key order by release_key)
                   from library.separate_releases
                   where library_id = %s) as retained_markers,
                  (select coalesce(
                     nullif(metadata ->> 'inventory_mutation_revision', '')::bigint,
                     0
                   )
                   from library.libraries
                   where id = %s) as inventory_mutation_revision
                """,
                (
                    library_id,
                    library_id,
                    release_key,
                    library_id,
                    library_id,
                    library_id,
                    library_id,
                    library_id,
                    library_id,
                    artist_id,
                    artist_id,
                    library_id,
                    library_id,
                    artist_id,
                    release_key,
                    library_id,
                    library_id,
                ),
            ).fetchone()
            preserved = connection.execute(
                """
                select
                  (select album_key
                   from library.local_albums
                   where library_id = %s
                     and lower(btrim(title)) = 'marked album') as album_key,
                  (select cover_path
                   from library.local_albums
                   where library_id = %s
                     and lower(btrim(title)) = 'marked album') as cover_path,
                  (select metadata ->> 'redundant'
                   from library.local_albums
                   where library_id = %s
                     and lower(btrim(title)) = 'marked album') as metadata_value,
                  (select rating from app.album_ratings
                   where library_id = %s
                     and album_key = 'marked::one') as rating,
                  (select count(*) from library.ignored_versions
                   where library_id = %s
                     and version_key = 'marked::one') as ignored_count,
                       (select count(*) from library.manual_versions
                        where library_id = %s
                          and child_key = 'marked::one'
                          and parent_key = 'fixture::newest-parent'
                          and metadata ->> 'manual' =
                              'canonical-preserved') as manual_count,
                  (select count(*) from ops.cover_lookup_tasks
                   where library_id = %s
                     and task_key = 'marker-removal-cover'
                     and album_key = 'marked::one') as cover_task_count,
                  (select count(*)
                   from library.local_album_featured_artists
                   where library_id = %s
                     and album_id = (
                       select id from library.local_albums
                       where library_id = %s
                         and album_key = 'marked::one'
                     )) as featured_count,
                  (select count(*)
                   from library.local_mbid_assertions
                   where library_id = %s
                     and album_id = (
                       select id from library.local_albums
                       where library_id = %s
                         and album_key = 'marked::one'
                     )
                     and target_key = 'marked::one') as mbid_assertion_count
                """,
                (library_id,) * 11,
            ).fetchone()

        assert int(persisted["album_count"]) == 1
        assert int(persisted["marker_count"]) == 0
        assert int(persisted["rename_album_count"]) == 4
        assert int(persisted["marked_track_count"]) == 3
        assert int(persisted["rename_track_count"]) == 4
        assert persisted["artist_name"] == "Renamed Identity Artist"
        assert int(persisted["artist_library_id"]) == library_id
        assert persisted["ordinary_discriminator"] == ""
        assert persisted["marked_discriminators"] == [""]
        assert persisted["rename_discriminators"] == [
            "rename::four",
            "rename::one",
            "rename::three",
            "rename::two",
        ]
        assert persisted["album_library_ids"] == [library_id]
        assert persisted["marker_library_ids"] is None
        assert persisted["retained_markers"] == [
            rename_release_key,
            renamed_release_key,
        ]
        assert (
            int(persisted["inventory_mutation_revision"])
            > prepared_snapshot_revision
        )
        assert preserved["album_key"] == "marked::one"
        assert preserved["cover_path"] == "/covers/marked-two.jpg"
        assert preserved["metadata_value"] == "preserved"
        assert {
            "rating": int(preserved["rating"]),
            "manual_count": int(preserved["manual_count"]),
        } == {
            "rating": 9,
            "manual_count": 1,
        }
        assert int(preserved["ignored_count"]) == 1
        assert int(preserved["cover_task_count"]) == 1
        assert int(preserved["featured_count"]) == 1
        assert int(preserved["mbid_assertion_count"]) == 1

        with isolatedPostgres._connect(setup_url) as connection:
            revision_before_noop = int(
                connection.execute(
                    """
                    select coalesce(
                      nullif(metadata ->> 'inventory_mutation_revision', '')::bigint,
                      0
                    ) as revision
                    from library.libraries
                    where id = %s
                    """,
                    (library_id,),
                ).fetchone()["revision"]
            )
            connection.execute(
                """
                update library.local_artists
                set name = name
                where id = %s
                """,
                (artist_id,),
            )
            revision_after_noop = int(
                connection.execute(
                    """
                    select coalesce(
                      nullif(metadata ->> 'inventory_mutation_revision', '')::bigint,
                      0
                    ) as revision
                    from library.libraries
                    where id = %s
                    """,
                    (library_id,),
                ).fetchone()["revision"]
            )
        assert revision_after_noop == revision_before_noop

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)


def test_live_identity_enforcement_serializes_concurrent_unmarked_inserts(
    monkeypatch: pytest.MonkeyPatch,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        with isolatedPostgres._connect(setup_url) as connection:
            library_id = _bootstrap_library_id(connection)
            artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (
                      %s, 'concurrent-identity-artist',
                      'Concurrent Identity Artist', '{}'
                    )
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )

        start_barrier = Barrier(2)

        def insert_competing_album(album_key: str) -> str:
            try:
                with isolatedPostgres._connect(setup_url) as connection:
                    connection.execute("set local lock_timeout = '10s'")
                    start_barrier.wait(timeout=10)
                    connection.execute(
                        """
                        insert into library.local_albums (
                          library_id, artist_id, album_key, title,
                          release_year, metadata
                        )
                        values (
                          %s, %s, %s, 'Concurrent Album', null,
                          '{"edition":""}'
                        )
                        """,
                        (library_id, artist_id, album_key),
                    )
                return "committed"
            except Exception as exc:
                return str(getattr(exc, "sqlstate", "") or "")

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(insert_competing_album, album_key)
                for album_key in ("concurrent::one", "concurrent::two")
            ]
            outcomes = sorted(future.result(timeout=20) for future in futures)

        assert outcomes == ["23505", "committed"]
        with isolatedPostgres._connect(setup_url) as connection:
            persisted_count = int(
                connection.execute(
                    """
                    select count(*)
                    from library.local_albums
                    where library_id = %s
                      and artist_id = %s
                      and lower(btrim(title)) = 'concurrent album'
                    """,
                    (library_id, artist_id),
                ).fetchone()["count"]
            )
        assert persisted_count == 1

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)


def test_live_semantic_album_migration_rekeys_all_dependents_without_metadata_loss(
    monkeypatch: pytest.MonkeyPatch,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        migration_paths = sorted(
            path
            for path in (REPO_ROOT / "migrations" / "postgres").glob("*.sql")
            if path.name
            <= "0033_repair_section14_album_identity_corruption.sql"
        )
        with isolatedPostgres._connect(setup_url) as connection:
            for migration_path in migration_paths:
                connection.execute(
                    migration_path.read_text(encoding="utf-8")
                )
        isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)

        with isolatedPostgres._connect(setup_url) as connection:
            owner = connection.execute(
                """
                select
                  app.bootstrap_owners.account_id,
                  library.libraries.id as library_id
                from app.bootstrap_owners
                join library.libraries
                  on library.libraries.owner_account_id =
                     app.bootstrap_owners.account_id
                where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                limit 1
                """
            ).fetchone()
            account_id = int(owner["account_id"])
            library_id = int(owner["library_id"])
            artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (%s, 'ддт', 'ДДТ', '{"fixture":"semantic-merge"}')
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            canonical_album_id = int(
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title, release_year,
                      metadata
                    )
                    values (
                      %s, %s, 'ддт::студийные записи',
                      'Студийные записи', 1988,
                      '{
                        "album_artist":"ДДТ",
                        "edition":"",
                        "notes":null,
                        "empty":[],
                        "canonical":true
                      }'::jsonb
                    )
                    returning id
                    """,
                    (library_id, artist_id),
                ).fetchone()["id"]
            )
            redundant_album_id = int(
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title, release_year,
                      cover_path, metadata
                    )
                    values (
                      %s, %s, 'ддт::студийные записи::split',
                      'Студийные записи', 1988, '/covers/studio.jpg',
                      '{
                        "album_artist":"ДДТ",
                        "edition":"",
                        "notes":"richer evidence",
                        "empty":["kept"],
                        "redundant":true
                      }'::jsonb
                    )
                    returning id
                    """,
                    (library_id, artist_id),
                ).fetchone()["id"]
            )

            connection.execute(
                """
                insert into app.album_ratings (
                  account_id, library_id, album_key, rating, provenance, metadata
                )
                values (
                  %s, %s, 'ддт::студийные записи::split',
                  9, 'fixture', '{"rating":"preserved"}'
                )
                """,
                (account_id, library_id),
            )
            connection.execute(
                """
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind, metadata
                )
                values (
                  %s, %s, %s, 'owner', '{"featured":"preserved"}'
                )
                """,
                (library_id, redundant_album_id, artist_id),
            )
            connection.execute(
                """
                insert into library.local_mbid_assertions (
                  library_id, album_id, target_kind, target_key,
                  evidence_source, mbid_assertion_state, source_payload
                )
                values (
                  %s, %s, 'album', 'ддт::студийные записи::split',
                  'fixture', 'unreviewed', '{"assertion":"preserved"}'
                )
                """,
                (library_id, redundant_album_id),
            )
            connection.execute(
                """
                insert into library.ignored_versions (
                  library_id, version_key, metadata
                )
                values (
                  %s, 'ддт::студийные записи::split',
                  '{"ignored":"preserved"}'
                )
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into library.manual_versions (
                  library_id, child_key, parent_key, metadata
                )
                values (
                  %s, 'ддт::студийные записи::split', 'fixture::parent',
                  '{"manual":"preserved"}'
                )
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into ops.cover_lookup_tasks (
                  library_id, task_key, status, album_key, metadata
                )
                values (
                  %s, 'semantic-migration-cover', 'completed',
                  'ддт::студийные записи::split',
                  '{"cover":"preserved"}'
                )
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into library.local_tracks (
                  library_id, album_id, artist_id, track_key, title, metadata
                )
                values (
                  %s, %s, %s, 'semantic-migration-track', 'Track 01',
                  '{"track":"preserved"}'
                )
                """,
                (library_id, redundant_album_id, artist_id),
            )

            connection.execute(
                """
                insert into library.separate_releases (
                  library_id, release_key, metadata
                )
                values (
                  %s, 'ддт::explicit twin::deluxe',
                  '{"reason":"owner-marked-separate"}'
                )
                """,
                (library_id,),
            )
            connection.execute(
                """
                insert into library.local_albums (
                  library_id, artist_id, album_key, title, release_year, metadata
                )
                values
                  (
                    %s, %s, 'ддт::explicit twin::one',
                    'Explicit Twin', 2000,
                    '{"album_artist":"ДДТ","edition":"Deluxe"}'
                  ),
                  (
                    %s, %s, 'ддт::explicit twin::two',
                    'Explicit Twin', 2000,
                    '{"album_artist":"ДДТ","edition":"Deluxe"}'
                  )
                """,
                (library_id, artist_id, library_id, artist_id),
            )

            migration_sql = MIGRATION_PATH.read_text(encoding="utf-8")
            connection.execute(migration_sql)
            connection.execute(migration_sql)

            merged_album = connection.execute(
                """
                select id, album_key, cover_path, metadata
                from library.local_albums
                where artist_id = %s
                  and lower(btrim(title)) = lower('Студийные записи')
                  and release_year = 1988
                """,
                (artist_id,),
            ).fetchall()
            explicit_count = int(
                connection.execute(
                    """
                    select count(*) as count
                    from library.local_albums
                    where artist_id = %s
                      and title = 'Explicit Twin'
                      and release_year = 2000
                    """,
                    (artist_id,),
                ).fetchone()["count"]
            )
            dependency_projection = connection.execute(
                """
                select
                  (
                    select array_agg(album_key order by album_key)
                    from app.album_ratings
                    where library_id = %s
                      and provenance = 'fixture'
                  ) as rating_keys,
                  (
                    select array_agg(album_id order by album_id)
                    from library.local_album_featured_artists
                    where library_id = %s
                      and metadata ? 'featured'
                  ) as featured_album_ids,
                  (
                    select jsonb_agg(
                      jsonb_build_object(
                        'album_id', album_id,
                        'target_key', target_key
                      )
                    )
                    from library.local_mbid_assertions
                    where library_id = %s
                      and evidence_source = 'fixture'
                  ) as assertions,
                  (
                    select array_agg(version_key order by version_key)
                    from library.ignored_versions
                    where library_id = %s
                      and metadata ? 'ignored'
                  ) as ignored_keys,
                  (
                    select jsonb_agg(
                      jsonb_build_object(
                        'child_key', child_key,
                        'parent_key', parent_key
                      )
                    )
                    from library.manual_versions
                    where library_id = %s
                      and metadata ? 'manual'
                  ) as manual_versions,
                  (
                    select array_agg(album_key order by album_key)
                    from ops.cover_lookup_tasks
                    where library_id = %s
                      and task_key = 'semantic-migration-cover'
                  ) as cover_keys,
                  (
                    select array_agg(album_id order by album_id)
                    from library.local_tracks
                    where library_id = %s
                      and track_key = 'semantic-migration-track'
                  ) as track_album_ids
                """,
                (library_id,) * 7,
            ).fetchone()

        assert len(merged_album) == 1
        assert int(merged_album[0]["id"]) == canonical_album_id
        assert merged_album[0]["album_key"] == "ддт::студийные записи"
        assert merged_album[0]["cover_path"] == "/covers/studio.jpg"
        assert merged_album[0]["metadata"] == {
            "album_artist": "ДДТ",
            "edition": "",
            "notes": "richer evidence",
            "empty": ["kept"],
            "canonical": True,
            "redundant": True,
        }
        assert explicit_count == 2
        assert dependency_projection["rating_keys"] == [
            "ддт::студийные записи"
        ]
        assert dependency_projection["featured_album_ids"] == [
            canonical_album_id
        ]
        assert dependency_projection["assertions"] == [
            {
                "album_id": canonical_album_id,
                "target_key": "ддт::студийные записи",
            }
        ]
        assert dependency_projection["ignored_keys"] == [
            "ддт::студийные записи"
        ]
        assert dependency_projection["manual_versions"] == [
            {
                "child_key": "ддт::студийные записи",
                "parent_key": "fixture::parent",
            }
        ]
        assert dependency_projection["cover_keys"] == [
            "ддт::студийные записи"
        ]
        assert dependency_projection["track_album_ids"] == [
            canonical_album_id
        ]
        assert redundant_album_id != canonical_album_id

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)


def test_runtime_semantic_album_reconciliation_scopes_to_target_identity(
    monkeypatch: pytest.MonkeyPatch,
):
    from music_app.services.scan_cache_persistence import (
        _execute_semantic_local_album_reconciliation,
    )

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)

        with isolatedPostgres._connect(setup_url) as connection:
            library_id = int(
                connection.execute(
                    """
                    select library.libraries.id
                    from app.bootstrap_owners
                    join library.libraries
                      on library.libraries.owner_account_id =
                         app.bootstrap_owners.account_id
                    where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                    limit 1
                    """
                ).fetchone()["id"]
            )
            artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (%s, 'scope-artist', 'Scope Artist', '{}')
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            # This test exercises repair of deliberately preexisting corruption.
            # Production writers must never drop the identity index.
            connection.execute(
                """
                drop index library.local_albums_semantic_identity_key
                """
            )
            album_rows = connection.execute(
                """
                insert into library.local_albums (
                  library_id, artist_id, album_key, title, release_year, metadata
                )
                values
                  (%s, %s, 'scope::target', 'Target Album', 2026, '{"edition":""}'),
                  (%s, %s, 'scope::target::split', ' target album ', 2026, '{"edition":""}'),
                  (%s, %s, 'scope::unrelated', 'Unrelated Album', 2025, '{"edition":"Deluxe"}'),
                  (%s, %s, 'scope::unrelated::split', ' unrelated album ', 2025, '{"edition":" deluxe "}')
                returning id, album_key
                """,
                (
                    library_id,
                    artist_id,
                    library_id,
                    artist_id,
                    library_id,
                    artist_id,
                    library_id,
                    artist_id,
                ),
            ).fetchall()
            album_ids = {
                str(row["album_key"]): int(row["id"])
                for row in album_rows
            }
            connection.execute(
                """
                insert into library.local_tracks (
                  library_id, album_id, artist_id, track_key, title, metadata
                )
                values (
                  %s, %s, %s, 'scope-target-track', 'Target Track',
                  '{"scope":"runtime"}'
                )
                """,
                (
                    library_id,
                    album_ids["scope::target::split"],
                    artist_id,
                ),
            )
            connection.execute(
                """
                insert into library.separate_releases (library_id, release_key)
                values (%s, 'scope artist::unrelated album::deluxe')
                """,
                (library_id,),
            )

        with isolatedPostgres._connect(runtime_url) as connection:
            _execute_semantic_local_album_reconciliation(
                connection,
                target_album_ids=(album_ids["scope::target::split"],),
            )

        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                IDENTITY_ENFORCEMENT_MIGRATION_PATH.read_text(encoding="utf-8")
            )
            target_rows = connection.execute(
                """
                select id
                from library.local_albums
                where library_id = %s
                  and lower(btrim(title)) = 'target album'
                  and release_year = 2026
                order by id
                """,
                (library_id,),
            ).fetchall()
            unrelated_rows = connection.execute(
                """
                select id
                from library.local_albums
                where library_id = %s
                  and lower(btrim(title)) = 'unrelated album'
                  and release_year = 2025
                order by id
                """,
                (library_id,),
            ).fetchall()
            track_album_id = int(
                connection.execute(
                    """
                    select album_id
                    from library.local_tracks
                    where track_key = 'scope-target-track'
                    """
                ).fetchone()["album_id"]
            )

        assert [int(row["id"]) for row in target_rows] == [
            album_ids["scope::target"]
        ]
        assert track_album_id == album_ids["scope::target"]
        assert [int(row["id"]) for row in unrelated_rows] == [
            album_ids["scope::unrelated"],
            album_ids["scope::unrelated::split"],
        ]

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)


def test_full_snapshot_adopts_existing_unseparated_semantic_album_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from music_app.services.library_roots_postgres import (
        PostgresLibraryRootSettingsStore,
    )
    from music_app.services.scan_cache_persistence import (
        PostgresScanCacheAdapter,
        _inventory_rows_from_albums,
    )

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    track_path = str(
        music_dir
        / "Selected Track Artist"
        / "Selected Track Split Fixture"
        / "01 Selected Track.flac"
    )
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
        "APP_NAME": "Album Haven",
    }
    file_cache = {
        track_path: {
            "path": track_path,
            "artist": "Selected Track Artist",
            "album_artist": "Selected Track Artist",
            "album": "Selected Track Split Fixture",
            "title": "Selected Track",
            "year": 2026,
            "edition": "",
            "disc_number": 1,
            "track_number": 1,
            "duration_seconds": 60,
            "album_rating": None,
            "library_root_id": "semantic-adoption-root",
            "library_root_category": "main_library",
            "size": 1024,
            "mtime": 1.0,
        }
    }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {
                        "id": "semantic-adoption-root",
                        "path": str(music_dir),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        adapter = PostgresScanCacheAdapter(config)
        albums = adapter._build_albums(file_cache, set())
        artist_rows, album_rows, featured_rows, track_rows, _file_rows = (
            _inventory_rows_from_albums(file_cache, albums)
        )
        incoming_album_key = str(album_rows[0]["album_key"])
        legacy_album_key = f"{incoming_album_key}::legacy-split"

        with isolatedPostgres._connect(setup_url) as connection:
            library_id = _bootstrap_library_id(connection)
            account_id = int(
                connection.execute(
                    """
                    select account_id
                    from app.bootstrap_owners
                    where owner_key = 'local-bootstrap-owner'
                    """
                ).fetchone()["account_id"]
            )
            artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (%s, %s, %s, '{}')
                    returning id
                    """,
                    (
                        library_id,
                        artist_rows[0]["artist_key"],
                        artist_rows[0]["name"],
                    ),
                ).fetchone()["id"]
            )
            legacy_album_id = int(
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title,
                      release_year, metadata
                    )
                    values (%s, %s, %s, %s, %s, %s::jsonb)
                    returning id
                    """,
                    (
                        library_id,
                        artist_id,
                        legacy_album_key,
                        album_rows[0]["title"],
                        album_rows[0]["release_year"],
                        json.dumps(
                            getattr(
                                album_rows[0]["metadata"],
                                "obj",
                                album_rows[0]["metadata"],
                            )
                        ),
                    ),
                ).fetchone()["id"]
            )
            legacy_track_id = int(
                connection.execute(
                    """
                    insert into library.local_tracks (
                      library_id, album_id, artist_id, track_key, title,
                      metadata
                    )
                    values (
                      %s, %s, %s, %s, %s,
                      '{"fixture":"track-preserved"}'
                    )
                    returning id
                    """,
                    (
                        library_id,
                        legacy_album_id,
                        artist_id,
                        track_rows[0]["track_key"],
                        track_rows[0]["title"],
                    ),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind, metadata
                )
                values (
                  %s, %s, %s, %s,
                  '{"fixture":"featured-preserved"}'
                )
                """,
                (
                    library_id,
                    legacy_album_id,
                    artist_id,
                    featured_rows[0]["featured_kind"],
                ),
            )
            connection.execute(
                """
                insert into app.album_ratings (
                  account_id, library_id, album_key, rating,
                  provenance, metadata
                )
                values (%s, %s, %s, 8, 'fixture', '{"rating":"preserved"}')
                """,
                (account_id, library_id, legacy_album_key),
            )
            connection.execute(
                """
                insert into library.ignored_versions (
                  library_id, version_key, metadata
                )
                values (%s, %s, '{"ignored":"preserved"}')
                """,
                (library_id, legacy_album_key),
            )
            connection.execute(
                """
                insert into library.manual_versions (
                  library_id, child_key, parent_key, metadata
                )
                values
                  (
                    %s, %s, 'fixture::parent',
                    '{"manual":"child-preserved"}'
                  ),
                  (
                    %s, 'fixture::child', %s,
                    '{"manual":"parent-preserved"}'
                  )
                """,
                (
                    library_id,
                    legacy_album_key,
                    library_id,
                    legacy_album_key,
                ),
            )
            connection.execute(
                """
                insert into library.local_mbid_assertions (
                  library_id, album_id, target_kind, target_key,
                  evidence_source, mbid_assertion_state, source_payload
                )
                values (
                  %s, %s, 'album', %s, 'fixture', 'unreviewed',
                  '{"assertion":"preserved"}'
                )
                """,
                (library_id, legacy_album_id, legacy_album_key),
            )
            connection.execute(
                """
                insert into ops.cover_lookup_tasks (
                  library_id, task_key, status, album_key, metadata
                )
                values (
                  %s, 'semantic-adoption-cover', 'completed', %s,
                  '{"cover":"preserved"}'
                )
                """,
                (library_id, legacy_album_key),
            )

        adapter.save_snapshot(
            Path("unused-library-cache.json"),
            file_cache,
            "semantic-adoption-root",
            1.0,
        )

        with isolatedPostgres._connect(setup_url) as connection:
            adopted = connection.execute(
                """
                select
                  (select jsonb_agg(
                     jsonb_build_object(
                       'id', id,
                       'album_key', album_key
                     )
                     order by id
                   )
                   from library.local_albums
                   where library_id = %s
                     and artist_id = %s
                     and lower(btrim(title)) =
                         lower('Selected Track Split Fixture')) as albums,
                  (select jsonb_agg(jsonb_build_object(
                     'album_key', album_key,
                     'rating', rating,
                     'provenance', provenance,
                     'metadata', metadata
                   ))
                   from app.album_ratings
                   where library_id = %s
                     and provenance = 'fixture') as rating_rows,
                  (select jsonb_agg(jsonb_build_object(
                     'version_key', version_key,
                     'metadata', metadata
                   ))
                   from library.ignored_versions
                   where library_id = %s
                     and metadata ? 'ignored') as ignored_rows,
                  (select jsonb_agg(
                     jsonb_build_object(
                       'child_key', child_key,
                       'parent_key', parent_key,
                       'metadata', metadata
                     )
                     order by child_key
                   )
                   from library.manual_versions
                   where library_id = %s
                     and metadata ? 'manual') as manual_keys,
                  (select jsonb_agg(jsonb_build_object(
                     'album_id', album_id,
                     'target_key', target_key,
                     'source_payload', source_payload
                   ))
                   from library.local_mbid_assertions
                   where library_id = %s
                     and evidence_source = 'fixture') as assertions,
                  (select jsonb_agg(jsonb_build_object(
                     'album_key', album_key,
                     'metadata', metadata
                   ))
                   from ops.cover_lookup_tasks
                   where library_id = %s
                     and task_key = 'semantic-adoption-cover') as cover_rows,
                  (select jsonb_agg(jsonb_build_object(
                     'id', id,
                     'album_id', album_id,
                     'metadata', metadata
                   ))
                   from library.local_tracks
                   where library_id = %s
                     and track_key = %s) as track_rows,
                  (select jsonb_agg(jsonb_build_object(
                     'album_id', album_id,
                     'artist_id', artist_id,
                     'featured_kind', featured_kind,
                     'metadata', metadata
                   ))
                   from library.local_album_featured_artists
                   where library_id = %s
                     and album_id = %s
                     and metadata ? 'fixture') as featured_rows
                """,
                (
                    library_id,
                    artist_id,
                    library_id,
                    library_id,
                    library_id,
                    library_id,
                    library_id,
                    library_id,
                    track_rows[0]["track_key"],
                    library_id,
                    legacy_album_id,
                ),
            ).fetchone()

        assert adopted["albums"] == [
            {"id": legacy_album_id, "album_key": incoming_album_key}
        ]
        assert adopted["rating_rows"] == [
            {
                "album_key": incoming_album_key,
                "rating": 8,
                "provenance": "fixture",
                "metadata": {"rating": "preserved"},
            }
        ]
        assert adopted["ignored_rows"] == [
            {
                "version_key": incoming_album_key,
                "metadata": {"ignored": "preserved"},
            }
        ]
        assert adopted["manual_keys"] == [
            {
                "child_key": "fixture::child",
                "parent_key": incoming_album_key,
                "metadata": {"manual": "parent-preserved"},
            },
            {
                "child_key": incoming_album_key,
                "parent_key": "fixture::parent",
                "metadata": {"manual": "child-preserved"},
            },
        ]
        assert adopted["assertions"] == [
            {
                "album_id": legacy_album_id,
                "target_key": incoming_album_key,
                "source_payload": {"assertion": "preserved"},
            }
        ]
        assert adopted["cover_rows"] == [
            {
                "album_key": incoming_album_key,
                "metadata": {"cover": "preserved"},
            }
        ]
        assert adopted["track_rows"] == [
            {
                "id": legacy_track_id,
                "album_id": legacy_album_id,
                "metadata": {
                    "fixture": "track-preserved",
                    "source": "runtime_scan_cache",
                    "album": "Selected Track Split Fixture",
                    "album_artist": "Selected Track Artist",
                    "root_provenance": {
                        "root_id": "semantic-adoption-root",
                        "category": "main_library",
                        "badge_label": None,
                        "category_label": "Main Library",
                    },
                },
            }
        ]
        assert adopted["featured_rows"] == [
            {
                "album_id": legacy_album_id,
                "artist_id": artist_id,
                "featured_kind": featured_rows[0]["featured_kind"],
                "metadata": {
                    "fixture": "featured-preserved",
                },
            }
        ]

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)


def test_full_snapshot_track_number_edit_preserves_unrelated_raw_rating_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    from music_app.services.library_roots_postgres import (
        PostgresLibraryRootSettingsStore,
    )
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    music_dir = (tmp_path / "Music").resolve()
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "MUSIC_DIR": str(music_dir),
        "APP_NAME": "Album Haven",
    }
    rating_values = {
        "Raw Rating Malformed": "not-a-rating",
        "Raw Rating Zero": 0,
        "Raw Rating Out Of Range": 11,
    }
    control_path = str(
        music_dir
        / "Raw Rating Artist"
        / "Track Number Control"
        / "01 Control.flac"
    )
    file_cache = {
        **{
            str(
                music_dir
                / "Raw Rating Artist"
                / album
                / "01 Rating.flac"
            ): {
                "path": str(
                    music_dir
                    / "Raw Rating Artist"
                    / album
                    / "01 Rating.flac"
                ),
                "artist": "Raw Rating Artist",
                "album_artist": "Raw Rating Artist",
                "album": album,
                "title": "Rating Track",
                "year": 2026,
                "edition": "Fixture Edition",
                "disc_number": 1,
                "track_number": 1,
                "duration_seconds": 60,
                "album_rating": rating,
                "library_root_id": "raw-rating-root",
                "library_root_category": "main_library",
                "size": 1024,
                "mtime": 1.0,
            }
            for album, rating in rating_values.items()
        },
        control_path: {
            "path": control_path,
            "artist": "Raw Rating Artist",
            "album_artist": "Raw Rating Artist",
            "album": "Track Number Control",
            "title": "Control Track",
            "year": 2026,
            "edition": "Fixture Edition",
            "disc_number": 1,
            "track_number": 1,
            "duration_seconds": 60,
            "album_rating": None,
            "library_root_id": "raw-rating-root",
            "library_root_category": "main_library",
            "size": 1024,
            "mtime": 1.0,
        },
    }

    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        PostgresLibraryRootSettingsStore(config).save_settings(
            {
                "main_library_roots": [
                    {
                        "id": "raw-rating-root",
                        "path": str(music_dir),
                        "layout_mode": "artist",
                    }
                ],
                "hoarding_library_roots": [],
                "new_arrivals_roots": [],
            }
        )
        adapter = PostgresScanCacheAdapter(config)
        adapter.save_snapshot(
            Path("unused-library-cache.json"),
            file_cache,
            "raw-rating-preservation-root",
            1.0,
        )

        changed_file_cache = {
            path: dict(entry)
            for path, entry in file_cache.items()
        }
        changed_file_cache[control_path]["track_number"] = 2
        adapter.save_snapshot(
            Path("unused-library-cache.json"),
            changed_file_cache,
            "raw-rating-preservation-root",
            2.0,
        )

        with isolatedPostgres._connect(setup_url) as connection:
            persisted_ratings = {
                str(row["title"]): row["tag_album_rating"]
                for row in connection.execute(
                    """
                    select title, metadata -> 'tag_album_rating' as tag_album_rating
                    from library.local_albums
                    where title = any(%s::text[])
                    order by title
                    """,
                    (list(rating_values),),
                ).fetchall()
            }
            persisted_control_number = int(
                connection.execute(
                    """
                    select library.local_tracks.track_number
                    from library.local_tracks
                    join library.local_albums
                      on library.local_albums.id = library.local_tracks.album_id
                    where library.local_albums.title = 'Track Number Control'
                    """
                ).fetchone()["track_number"]
            )

        assert persisted_control_number == 2
        assert persisted_ratings == rating_values

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)
