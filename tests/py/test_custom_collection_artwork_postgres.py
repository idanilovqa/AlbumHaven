import pytest


class Connection:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=()):
        self.operations.append((" ".join(sql.lower().split()), tuple(params)))
        self.row = self.rows.pop(0) if self.rows else None
        return self

    def fetchone(self):
        return self.row


def repository(connection):
    from music_app.services.custom_collection_artwork_postgres import (
        CustomCollectionArtworkRepository,
    )

    return CustomCollectionArtworkRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url, **_kwargs: connection,
    )


def test_collection_artwork_reads_one_library_scoped_row_without_image_bytes():
    connection = Connection([{
        "collection_name": "Женя музыка",
        "revision": 4,
        "content_sha256": "a" * 64,
        "width": 900,
        "height": 900,
        "filename": "cover.jpg",
        "updated_at": "now",
    }])

    result = repository(connection).load(library_id=7, collection_name=" Женя музыка ")

    assert result["revision"] == 4
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert "image_bytes" not in sql
    assert "where library_id = %s and collection_name = %s" in sql
    assert params == (7, "Женя музыка")


def test_collection_artwork_save_uses_one_indexed_existence_check_and_one_upsert():
    connection = Connection([
        {"exists": True},
        {
            "collection_name": "Night",
            "revision": 2,
            "content_sha256": "b" * 64,
            "width": 512,
            "height": 512,
            "filename": "night.jpg",
            "updated_at": "now",
        },
    ])

    result = repository(connection).save(
        library_id=7,
        collection_name="Night",
        account_id=12,
        image_bytes=b"jpeg",
        content_sha256="b" * 64,
        width=512,
        height=512,
        filename="night.jpg",
    )

    assert result["revision"] == 2
    assert len(connection.operations) == 2
    existence_sql, existence_params = connection.operations[0]
    assert "library.exception_overrides" in existence_sql
    assert "custom_collection_name" in existence_sql
    assert existence_params == (7, "Night")
    upsert_sql, upsert_params = connection.operations[1]
    assert "insert into library.custom_collection_artwork" in upsert_sql
    assert "on conflict (library_id, collection_name) do update" in upsert_sql
    assert upsert_params[:3] == (7, "Night", 12)


def test_collection_artwork_rejects_invalid_input_before_database_access():
    connections = []
    from music_app.services.custom_collection_artwork_postgres import (
        CustomCollectionArtworkRepository,
    )

    repo = CustomCollectionArtworkRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda *_args, **_kwargs: connections.append(True),
    )

    with pytest.raises(ValueError):
        repo.load(library_id=0, collection_name="Night")
    with pytest.raises(ValueError):
        repo.save(
            library_id=7,
            collection_name="",
            account_id=12,
            image_bytes=b"jpeg",
            content_sha256="c" * 64,
            width=512,
            height=512,
            filename="night.jpg",
        )

    assert connections == []
