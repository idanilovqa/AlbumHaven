"""Second artbox (slot 1) persistence and route boundary."""

import os
from uuid import uuid4

import pytest

from music_app.services.album_additional_artworks_postgres import (
    AlbumAdditionalArtworkRepository,
    artwork_payload,
)
from music_app.services.private_route_boundary import _PRIVATE_ROUTE_ACTIONS


def test_artwork_payload_matches_the_album_cover_source_contract():
    assert artwork_payload({"slot": 1, "source_kind": "local", "cover_path": "D:/A/back.jpg"}) == {
        "slot": 1, "source_kind": "local", "cover_path": "D:/A/back.jpg",
    }
    assert artwork_payload({"slot": 1, "source_kind": "remote", "remote_url": "https://img.example/b.jpg"}) == {
        "slot": 1, "source_kind": "remote", "remote_cover_url": "https://img.example/b.jpg",
    }


@pytest.mark.parametrize(("slot", "source_kind"), [(0, "local"), (2, "local"), (1, "pasted")])
def test_repository_rejects_extra_slots_and_unknown_sources_before_any_write(slot, source_kind):
    repository = AlbumAdditionalArtworkRepository({}, connect=lambda _url: pytest.fail("must not connect"))
    with pytest.raises(ValueError):
        repository.save(album_id=1, slot=slot, source_kind=source_kind, cover_path="x", remote_url=None, account_id=None)


def test_artbox_routes_require_cover_write_permission():
    for path in ("/utilities/cover-lookup/additional-artwork", "/utilities/cover-lookup/additional-artwork/remove"):
        assert _PRIVATE_ROUTE_ACTIONS[("POST", path)] == "library.covers.write"


@pytest.fixture
def isolated_album_id():
    psycopg = pytest.importorskip("psycopg")
    if not os.environ.get("ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL"):
        pytest.skip("A pre-provisioned isolated Postgres database is required.")
    from tests.e2e.support import isolatedPostgres

    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    token = uuid4().hex
    with psycopg.connect(runtime_url, row_factory=psycopg.rows.dict_row) as connection:
        library_id = connection.execute("""
            select l.id from library.libraries l
            join app.bootstrap_owners b on b.account_id = l.owner_account_id
            where b.owner_key = 'local-bootstrap-owner' and l.library_kind = 'local'
            order by l.id limit 1
        """).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums (library_id, album_key, title) values (%s, %s, %s) returning id",
            (library_id, f"artbox-{token}", f"Artbox {token}"),
        ).fetchone()["id"]
        connection.commit()
    yield runtime_url, album_id
    with psycopg.connect(runtime_url) as connection:
        connection.execute("delete from library.local_albums where id = %s", (album_id,))
        connection.commit()


def test_second_artbox_saves_replaces_and_removes_in_postgres(isolated_album_id):
    runtime_url, album_id = isolated_album_id
    repository = AlbumAdditionalArtworkRepository({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url})
    assert repository.list_for_album(album_id=album_id) == []
    saved = repository.save(
        album_id=album_id, slot=1, source_kind="local", cover_path="D:/A/back.jpg", remote_url=None, account_id=None,
    )
    assert saved == [{"slot": 1, "source_kind": "local", "cover_path": "D:/A/back.jpg"}]
    replaced = repository.save(
        album_id=album_id, slot=1, source_kind="remote", cover_path=None,
        remote_url="https://img.example/b.jpg", account_id=None,
    )
    assert replaced == [{"slot": 1, "source_kind": "remote", "remote_cover_url": "https://img.example/b.jpg"}]
    assert repository.remove(album_id=album_id, slot=1) == []


def test_postgres_rejects_a_second_extra_artbox_slot(isolated_album_id):
    psycopg = pytest.importorskip("psycopg")
    runtime_url, album_id = isolated_album_id
    with psycopg.connect(runtime_url) as connection:
        with pytest.raises(psycopg.errors.CheckViolation):
            connection.execute(
                "insert into library.local_album_additional_artworks (album_id, slot, source_kind, cover_path) values (%s, 2, 'local', 'x')",
                (album_id,),
            )
