from __future__ import annotations

import hashlib
import os
from uuid import uuid4

import pytest

from music_app.services.cover_lookup_pasted_images_postgres import (
    MAX_PASTED_IMAGE_BYTES,
    MAX_PASTED_IMAGES_PER_ALBUM,
    CoverLookupPastedImageRepository,
)


def _image(seed: str) -> bytes:
    return b"\xff\xd8\xff" + seed.encode("utf-8") * 8


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def pasted_images_database():
    psycopg = pytest.importorskip("psycopg")
    if not os.environ.get("ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL"):
        pytest.skip("A pre-provisioned isolated Postgres database is required.")
    from tests.e2e.support import isolatedPostgres

    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    token = uuid4().hex
    with psycopg.connect(setup_url, row_factory=psycopg.rows.dict_row) as connection:
        library_id = connection.execute("""
            select l.id from library.libraries l
            join app.bootstrap_owners b on b.account_id = l.owner_account_id
            where b.owner_key = 'local-bootstrap-owner' and l.library_kind = 'local'
            order by l.id limit 1
        """).fetchone()["id"]
        album_ids = [
            connection.execute(
                "insert into library.local_albums (library_id, album_key, title) values (%s, %s, %s) returning id",
                (library_id, f"pasted-{token}-{index}", f"Pasted {token} {index}"),
            ).fetchone()["id"]
            for index in range(2)
        ]
        account_ids = [
            connection.execute(
                "insert into app.accounts (display_name, account_kind, username_display, username_normalized,"
                " contact_email, contact_email_normalized) values (%s, 'member', %s, %s, %s, %s) returning id",
                (f"Paster {index}", f"paster-{token}-{index}", f"paster-{token}-{index}",
                 f"paster-{token}-{index}@example.test", f"paster-{token}-{index}@example.test"),
            ).fetchone()["id"]
            for index in range(2)
        ]
        connection.commit()
    yield setup_url, runtime_url, album_ids, account_ids
    with psycopg.connect(setup_url) as connection:
        connection.execute("delete from library.local_albums where id = any(%s)", (album_ids,))
        connection.execute("delete from app.accounts where id = any(%s)", (account_ids,))
        connection.commit()


def _repository(runtime_url: str) -> CoverLookupPastedImageRepository:
    return CoverLookupPastedImageRepository({"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url})


def test_pasted_images_are_kept_per_user_and_album_and_read_back_by_key(pasted_images_database):
    _setup_url, runtime_url, (album, other_album), (paster, other_user) = pasted_images_database
    repository = _repository(runtime_url)
    data = _image("front")

    added = repository.add(
        account_id=paster, album_id=album, image=data, mime_type="image/png",
        filename="front.png", width=1200, height=1200,
    )

    assert added["item"]["id"] == _sha(data)
    assert added["evicted_ids"] == []
    assert [item["id"] for item in repository.list_for_album(account_id=paster, album_id=album)] == [_sha(data)]
    assert repository.list_for_album(account_id=other_user, album_id=album) == []
    assert repository.list_for_album(account_id=paster, album_id=other_album) == []
    assert repository.read_image(account_id=paster, album_id=album, image_id=_sha(data)) == (data, "image/png")
    assert repository.read_image(account_id=other_user, album_id=album, image_id=_sha(data)) is None

    again = repository.add(
        account_id=paster, album_id=album, image=data, mime_type="image/png",
        filename="front again.png", width=1200, height=1200,
    )
    assert again["item"]["id"] == _sha(data)
    assert len(repository.list_for_album(account_id=paster, album_id=album)) == 1


def test_an_eleventh_pasted_image_drops_the_oldest(pasted_images_database):
    setup_url, runtime_url, (album, _other_album), (paster, _other_user) = pasted_images_database
    repository = _repository(runtime_url)
    images = [_image(f"image-{index}") for index in range(MAX_PASTED_IMAGES_PER_ALBUM + 1)]
    import psycopg

    for index, data in enumerate(images[:MAX_PASTED_IMAGES_PER_ALBUM]):
        repository.add(account_id=paster, album_id=album, image=data, mime_type="image/jpeg",
                       filename=f"{index}.jpg", width=10, height=10)
        with psycopg.connect(setup_url) as connection:
            # Distinct, ordered paste times.
            connection.execute(
                "update library.cover_lookup_pasted_images set created_at = now() - make_interval(mins => %s) "
                "where account_id = %s and album_id = %s and content_sha256 = %s",
                (100 - index, paster, album, _sha(data)),
            )
            connection.commit()

    added = repository.add(account_id=paster, album_id=album, image=images[-1], mime_type="image/jpeg",
                           filename="new.jpg", width=10, height=10)

    assert added["evicted_ids"] == [_sha(images[0])]
    listed = [item["id"] for item in repository.list_for_album(account_id=paster, album_id=album)]
    assert len(listed) == MAX_PASTED_IMAGES_PER_ALBUM
    assert _sha(images[0]) not in listed and _sha(images[-1]) in listed


def test_pasted_images_leave_when_deleted_unused_for_seven_days_or_the_album_is_removed(pasted_images_database):
    setup_url, runtime_url, (album, other_album), (paster, _other_user) = pasted_images_database
    repository = _repository(runtime_url)
    kept, stale, deleted, on_removed_album = (_image(name) for name in ("kept", "stale", "deleted", "gone"))
    for data, album_id in ((kept, album), (stale, album), (deleted, album), (on_removed_album, other_album)):
        repository.add(account_id=paster, album_id=album_id, image=data, mime_type="image/jpeg",
                       filename="x.jpg", width=1, height=1)
    import psycopg

    with psycopg.connect(setup_url) as connection:
        connection.execute(
            "update library.cover_lookup_pasted_images set last_used_at = now() - interval '7 days 1 minute' "
            "where content_sha256 = %s", (_sha(stale),),
        )
        connection.commit()

    assert repository.delete(account_id=paster, album_id=album, image_id=_sha(deleted)) is True
    assert repository.delete(account_id=paster, album_id=album, image_id=_sha(deleted)) is False
    assert [item["id"] for item in repository.list_for_album(account_id=paster, album_id=album)] == [_sha(kept)]

    with psycopg.connect(setup_url) as connection:
        connection.execute("delete from library.local_albums where id = %s", (other_album,))
        connection.commit()
        remaining = connection.execute(
            "select count(*) from library.cover_lookup_pasted_images where album_id = %s", (other_album,),
        ).fetchone()[0]
    assert remaining == 0


def test_expired_pasted_images_are_found_through_the_last_used_index(pasted_images_database):
    setup_url, _runtime_url, _albums, _accounts = pasted_images_database
    from music_app.services import cover_lookup_pasted_images_postgres as module
    import psycopg

    with psycopg.connect(setup_url) as connection:
        connection.execute("set enable_seqscan = off")
        plan = "\n".join(row[0] for row in connection.execute(
            "explain " + module._DELETE_EXPIRED_SQL, {"ttl": module.PASTED_IMAGE_TTL},
        ).fetchall())
    assert "cover_lookup_pasted_images_last_used_idx" in plan


def test_pasted_images_refuse_oversized_or_non_image_payloads_before_any_write():
    repository = CoverLookupPastedImageRepository({}, connect=lambda _url: pytest.fail("must not connect"))
    with pytest.raises(ValueError):
        repository.add(account_id=1, album_id=1, image=b"x" * (MAX_PASTED_IMAGE_BYTES + 1),
                       mime_type="image/png", filename="big.png", width=1, height=1)
    with pytest.raises(ValueError):
        repository.add(account_id=1, album_id=1, image=b"text", mime_type="text/plain",
                       filename="a.txt", width=1, height=1)
