from __future__ import annotations

import os
from datetime import timezone
from pathlib import Path

import pytest

from tests.e2e.support import isolatedPostgres


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    REPO_ROOT
    / "migrations"
    / "postgres"
    / "0033_repair_section14_album_identity_corruption.sql"
)
def _dedicated_database_urls_or_skip(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[str, str]:
    setup_value = str(os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or "").strip()
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
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute(
            "drop schema if exists app, integration, library, ops cascade"
        )


def test_live_section14_album_identity_repair_merges_both_corruptions(
    monkeypatch,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        migration_paths = sorted(
            path
            for path in (REPO_ROOT / "migrations" / "postgres").glob("*.sql")
            if path.is_file()
        )
        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection, isolatedPostgres.SETUP_ROLE
            )
            for migration_path in migration_paths:
                if migration_path.name >= MIGRATION_PATH.name:
                    break
                connection.execute(migration_path.read_text(encoding="utf-8"))
        isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)

        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection, isolatedPostgres.SETUP_ROLE
            )
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

            legacy_artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (%s, 'section14 legacy artist', 'Section 14 Legacy Artist',
                      '{"fixture":"legacy"}'::jsonb)
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            canonical_legacy_album_id = int(
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title, release_year,
                      cover_path, metadata
                    )
                    values (
                      %s, %s, 'section14 legacy artist::twin album',
                      'Twin Album', 1999, null, '{"canonical":true}'::jsonb
                    )
                    returning id
                    """,
                    (library_id, legacy_artist_id),
                ).fetchone()["id"]
            )
            redundant_legacy_album_id = int(
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title, release_year,
                      mbid, evidence_source, evidence_confidence, cover_path, metadata
                    )
                    values (
                      %s, %s, 'section14 legacy artist::twin album::year::1999',
                      'Twin Album', 1999,
                      '00000000-0000-0000-0000-000000000033'::uuid,
                      'section14_live_fixture', 0.9000, '/covers/twin.jpg',
                      '{"redundant":true}'::jsonb
                    )
                    returning id
                    """,
                    (library_id, legacy_artist_id),
                ).fetchone()["id"]
            )
            legacy_track_id = int(
                connection.execute(
                    """
                    insert into library.local_tracks (
                      library_id, album_id, artist_id, track_key, title
                    )
                    values (
                      %s, %s, %s, 'section14-legacy-track', 'Legacy Track'
                    )
                    returning id
                    """,
                    (library_id, redundant_legacy_album_id, legacy_artist_id),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into app.album_ratings (
                  account_id, library_id, album_key, rating, provenance, metadata
                )
                values
                  (
                    %s, %s, 'section14 legacy artist::twin album',
                    8, 'fixture-canonical', '{"canonical_rating":true}'::jsonb
                  ),
                  (
                    %s, %s,
                    'section14 legacy artist::twin album::year::1999',
                    9, 'fixture-redundant', '{"redundant_rating":true}'::jsonb
                  )
                """,
                (account_id, library_id, account_id, library_id),
            )
            connection.execute(
                """
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind, metadata
                )
                values
                  (%s, %s, %s, 'owner', '{"canonical":true}'::jsonb),
                  (%s, %s, %s, 'owner', '{"redundant":true}'::jsonb)
                """,
                (
                    library_id,
                    canonical_legacy_album_id,
                    legacy_artist_id,
                    library_id,
                    redundant_legacy_album_id,
                    legacy_artist_id,
                ),
            )
            connection.execute(
                """
                insert into library.local_mbid_assertions (
                  library_id, album_id, target_kind, target_key,
                  evidence_source, mbid_assertion_state
                )
                values (
                  %s, %s, 'album',
                  'section14 legacy artist::twin album::year::1999',
                  'section14_live_fixture', 'unreviewed'
                )
                """,
                (library_id, redundant_legacy_album_id),
            )

            canonical_artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (%s, 'ayreon', 'Ayreon', '{"canonical":true}'::jsonb)
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            malformed_artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (%s, '['''']', '['''']', '{"malformed":true}'::jsonb)
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            family_artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (
                      library_id, artist_key, name, metadata
                    )
                    values (
                      %s, 'section14 ayreon family', 'Section 14 Ayreon Family',
                      '{"fixture":"family"}'::jsonb
                    )
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.local_artist_family_links (
                  library_id,
                  artist_id,
                  related_artist_id,
                  relationship_weight,
                  source_family,
                  metadata
                )
                values
                  (
                    %s, %s, %s, 1, 'folder_derived_runtime',
                    '{"canonical_outbound":true}'::jsonb
                  ),
                  (
                    %s, %s, %s, 1, 'folder_derived_runtime',
                    '{"malformed_outbound":true}'::jsonb
                  ),
                  (
                    %s, %s, %s, 1, 'folder_derived_runtime',
                    '{"canonical_inbound":true}'::jsonb
                  ),
                  (
                    %s, %s, %s, 1, 'folder_derived_runtime',
                    '{"malformed_inbound":true}'::jsonb
                  ),
                  (
                    %s, %s, %s, 1, 'folder_derived_runtime',
                    '{"canonical_to_malformed":true}'::jsonb
                  ),
                  (
                    %s, %s, %s, 1, 'folder_derived_runtime',
                    '{"malformed_to_canonical":true}'::jsonb
                  )
                """,
                (
                    library_id,
                    canonical_artist_id,
                    family_artist_id,
                    library_id,
                    malformed_artist_id,
                    family_artist_id,
                    library_id,
                    family_artist_id,
                    canonical_artist_id,
                    library_id,
                    family_artist_id,
                    malformed_artist_id,
                    library_id,
                    canonical_artist_id,
                    malformed_artist_id,
                    library_id,
                    malformed_artist_id,
                    canonical_artist_id,
                ),
            )
            canonical_album_id = int(
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title, release_year, metadata
                    )
                    values (
                      %s, %s, 'ayreon::the theory of everything',
                      'The Theory of Everything', 2013, '{"canonical":true}'::jsonb
                    )
                    returning id
                    """,
                    (library_id, canonical_artist_id),
                ).fetchone()["id"]
            )
            malformed_album_id = int(
                connection.execute(
                    """
                    insert into library.local_albums (
                      library_id, artist_id, album_key, title, release_year,
                      cover_path, metadata
                    )
                    values (
                      %s, %s, '['''']::the theory of everything',
                      'The Theory of Everything', 2013, '/covers/ayreon.jpg',
                      '{"malformed":true}'::jsonb
                    )
                    returning id
                    """,
                    (library_id, malformed_artist_id),
                ).fetchone()["id"]
            )
            malformed_track_ids = []
            for number in (1, 2):
                malformed_track_ids.append(
                    int(
                        connection.execute(
                            """
                            insert into library.local_tracks (
                              library_id, album_id, artist_id, track_key, title,
                              track_number
                            )
                            values (%s, %s, %s, %s, %s, %s)
                            returning id
                            """,
                            (
                                library_id,
                                malformed_album_id,
                                canonical_artist_id,
                                f"section14-ayreon-track-{number}",
                                f"Ayreon Track {number}",
                                number,
                            ),
                        ).fetchone()["id"]
                    )
                )
            for number, track_id in enumerate(malformed_track_ids, start=1):
                connection.execute(
                    """
                    insert into library.local_track_files (
                      track_id, private_path, metadata
                    )
                    values (
                      %s,
                      %s,
                      jsonb_build_object(
                        'scan_cache',
                        jsonb_build_object(
                          'stale', false,
                          'file_entry',
                          jsonb_build_object(
                            'album', 'The Theory of Everything',
                            'album_artist', '['''']',
                            'artist', 'Ayreon',
                            'title', %s::text
                          )
                        )
                      )
                    )
                    """,
                    (
                        track_id,
                        f"C:/section14/ayreon-{number}.flac",
                        f"Ayreon Track {number}",
                    ),
                )
            connection.execute(
                """
                insert into app.album_ratings (
                  account_id, library_id, album_key, rating, provenance
                )
                values (
                  %s, %s, '['''']::the theory of everything',
                  10, 'section14_live_fixture'
                )
                """,
                (account_id, library_id),
            )
            connection.execute(
                """
                insert into library.local_album_featured_artists (
                  library_id, album_id, artist_id, featured_kind, metadata
                )
                values
                  (%s, %s, %s, 'owner', '{"malformed_owner":true}'::jsonb),
                  (%s, %s, %s, 'owner', '{"canonical_owner":true}'::jsonb)
                """,
                (
                    library_id,
                    malformed_album_id,
                    malformed_artist_id,
                    library_id,
                    malformed_album_id,
                    canonical_artist_id,
                ),
            )
            connection.execute(
                """
                insert into library.local_artist_mbid_assertions (
                  artist_id, evidence_source, mbid_assertion_state,
                  confidence, explanation, observed_at,
                  mbid_assertion_scan_run_ref, source_payload
                )
                values
                  (
                    %s, 'section14_live_fixture', 'unreviewed',
                    0.8000, 'canonical artist evidence',
                    '2026-01-01 00:00:00+00'::timestamptz,
                    'canonical-artist-scan',
                    '{"canonical_artist":true}'::jsonb
                  ),
                  (
                    %s, 'section14_live_fixture', 'unreviewed',
                    0.9000, 'malformed artist evidence',
                    '2026-01-02 00:00:00+00'::timestamptz,
                    'malformed-artist-scan',
                    '{"malformed_artist":true}'::jsonb
                  )
                """,
                (canonical_artist_id, malformed_artist_id),
            )
            connection.execute(
                """
                insert into library.local_mbid_assertions (
                  library_id, album_id, target_kind, target_key,
                  evidence_source, mbid_assertion_state,
                  confidence, explanation, observed_at, source_payload
                )
                values
                  (
                    %s, %s, 'album',
                    'ayreon::the theory of everything',
                    'section14_live_fixture', 'unreviewed',
                    0.8000, 'canonical album evidence',
                    '2026-01-01 00:00:00+00'::timestamptz,
                    '{"canonical_album":true}'::jsonb
                  ),
                  (
                    %s, %s, 'album',
                    '['''']::the theory of everything',
                    'section14_live_fixture', 'unreviewed',
                    0.9000, 'malformed album evidence',
                    '2026-01-02 00:00:00+00'::timestamptz,
                    '{"malformed_album":true}'::jsonb
                  )
                """,
                (
                    library_id,
                    canonical_album_id,
                    library_id,
                    malformed_album_id,
                ),
            )

            migration_sql = MIGRATION_PATH.read_text(encoding="utf-8")
            connection.execute(migration_sql)
            connection.execute(migration_sql)

            albums = connection.execute(
                """
                select id, album_key, artist_id, mbid, cover_path, metadata
                from library.local_albums
                where id in (%s, %s, %s, %s)
                order by id
                """,
                (
                    canonical_legacy_album_id,
                    redundant_legacy_album_id,
                    canonical_album_id,
                    malformed_album_id,
                ),
            ).fetchall()
            tracks = connection.execute(
                """
                select id, album_id, artist_id
                from library.local_tracks
                where id = %s or id = any(%s)
                order by id
                """,
                (legacy_track_id, malformed_track_ids),
            ).fetchall()
            ratings = connection.execute(
                """
                select album_key, rating, metadata
                from app.album_ratings
                where account_id = %s
                  and album_key in (
                    'section14 legacy artist::twin album',
                    'section14 legacy artist::twin album::year::1999',
                    'ayreon::the theory of everything',
                    '['''']::the theory of everything'
                  )
                order by album_key
                """,
                (account_id,),
            ).fetchall()
            files = connection.execute(
                """
                select scan_file_album_artist, scan_file_artist
                from library.local_track_files
                where track_id = any(%s)
                order by track_id
                """,
                (malformed_track_ids,),
            ).fetchall()
            family_links = connection.execute(
                """
                select artist_id, related_artist_id
                from library.local_artist_family_links
                where artist_id in (%s, %s, %s)
                   or related_artist_id in (%s, %s, %s)
                order by artist_id, related_artist_id
                """,
                (
                    canonical_artist_id,
                    malformed_artist_id,
                    family_artist_id,
                    canonical_artist_id,
                    malformed_artist_id,
                    family_artist_id,
                ),
            ).fetchall()
            malformed_artist_count = int(
                connection.execute(
                    """
                    select count(*) as count
                    from library.local_artists
                    where id = %s
                    """,
                    (malformed_artist_id,),
                ).fetchone()["count"]
            )
            album_assertions = connection.execute(
                """
                select
                  album_id, target_key, confidence, explanation,
                  observed_at, source_payload
                from library.local_mbid_assertions
                where album_id = %s
                  and evidence_source = 'section14_live_fixture'
                  and explanation is not null
                order by confidence
                """,
                (canonical_album_id,),
            ).fetchall()
            artist_assertions = connection.execute(
                """
                select
                  artist_id, confidence, explanation, observed_at,
                  mbid_assertion_scan_run_ref, source_payload
                from library.local_artist_mbid_assertions
                where artist_id = %s
                  and evidence_source = 'section14_live_fixture'
                order by confidence
                """,
                (canonical_artist_id,),
            ).fetchall()

        albums_by_id = {int(album["id"]): album for album in albums}
        assert set(albums_by_id) == {canonical_legacy_album_id, canonical_album_id}
        legacy_album = albums_by_id[canonical_legacy_album_id]
        assert legacy_album["mbid"] is not None
        assert legacy_album["cover_path"] == "/covers/twin.jpg"
        assert legacy_album["metadata"] == {"canonical": True, "redundant": True}
        ayreon_album = albums_by_id[canonical_album_id]
        assert int(ayreon_album["artist_id"]) == canonical_artist_id
        assert ayreon_album["cover_path"] == "/covers/ayreon.jpg"
        assert ayreon_album["metadata"] == {"canonical": True, "malformed": True}

        tracks_by_id = {int(track["id"]): track for track in tracks}
        assert (
            int(tracks_by_id[legacy_track_id]["album_id"])
            == canonical_legacy_album_id
        )
        for track_id in malformed_track_ids:
            assert int(tracks_by_id[track_id]["album_id"]) == canonical_album_id
            assert int(tracks_by_id[track_id]["artist_id"]) == canonical_artist_id

        ratings_by_key = {rating["album_key"]: rating for rating in ratings}
        assert set(ratings_by_key) == {
            "section14 legacy artist::twin album",
            "ayreon::the theory of everything",
        }
        legacy_rating = ratings_by_key["section14 legacy artist::twin album"]
        assert int(legacy_rating["rating"]) == 8
        assert legacy_rating["metadata"]["section_14_repair"] == {
            "canonical_rating": 8,
            "preserved_merged_rating": 9,
        }
        assert int(ratings_by_key["ayreon::the theory of everything"]["rating"]) == 10
        assert files == [
            {"scan_file_album_artist": "Ayreon", "scan_file_artist": "Ayreon"},
            {"scan_file_album_artist": "Ayreon", "scan_file_artist": "Ayreon"},
        ]
        assert family_links == [
            {
                "artist_id": canonical_artist_id,
                "related_artist_id": family_artist_id,
            },
            {
                "artist_id": family_artist_id,
                "related_artist_id": canonical_artist_id,
            },
        ]
        assert malformed_artist_count == 0
        assert [
            (
                int(assertion["album_id"]),
                assertion["target_key"],
                str(assertion["confidence"]),
                assertion["explanation"],
                assertion["observed_at"].astimezone(timezone.utc).isoformat(),
                assertion["source_payload"],
            )
            for assertion in album_assertions
        ] == [
            (
                canonical_album_id,
                "ayreon::the theory of everything",
                "0.8000",
                "canonical album evidence",
                "2026-01-01T00:00:00+00:00",
                {"canonical_album": True},
            ),
            (
                canonical_album_id,
                "ayreon::the theory of everything",
                "0.9000",
                "malformed album evidence",
                "2026-01-02T00:00:00+00:00",
                {
                    "malformed_album": True,
                    "section_14_repair": "literal_empty_id3_album_artist",
                },
            ),
        ]
        assert [
            (
                int(assertion["artist_id"]),
                str(assertion["confidence"]),
                assertion["explanation"],
                assertion["observed_at"].astimezone(timezone.utc).isoformat(),
                assertion["mbid_assertion_scan_run_ref"],
                assertion["source_payload"],
            )
            for assertion in artist_assertions
        ] == [
            (
                canonical_artist_id,
                "0.8000",
                "canonical artist evidence",
                "2026-01-01T00:00:00+00:00",
                "canonical-artist-scan",
                {"canonical_artist": True},
            ),
            (
                canonical_artist_id,
                "0.9000",
                "malformed artist evidence",
                "2026-01-02T00:00:00+00:00",
                "malformed-artist-scan",
                {
                    "malformed_artist": True,
                    "section_14_repair": "literal_empty_id3_album_artist",
                },
            ),
        ]

        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(
                connection, isolatedPostgres.SETUP_ROLE
            )
            for migration_path in migration_paths:
                if migration_path.name > MIGRATION_PATH.name:
                    connection.execute(migration_path.read_text(encoding="utf-8"))
            semantic_identity_index = connection.execute(
                """
                select indexes.indisunique as is_unique
                from pg_catalog.pg_class as index_relations
                join pg_catalog.pg_namespace as namespaces
                  on namespaces.oid = index_relations.relnamespace
                join pg_catalog.pg_index as indexes
                  on indexes.indexrelid = index_relations.oid
                where namespaces.nspname = 'library'
                  and index_relations.relname =
                    'local_albums_semantic_identity_key'
                """
            ).fetchone()
        assert semantic_identity_index == {"is_unique": True}

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)
