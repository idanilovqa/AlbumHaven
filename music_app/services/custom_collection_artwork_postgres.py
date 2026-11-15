"""Library-scoped artwork for derived Custom Collections."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from music_app.services.postgres_connections import pooled_connection


_METADATA_COLUMNS = """
collection_name, revision, content_sha256, width, height, filename, updated_at
"""


def _positive_id(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer.")
    return value


def _collection_name(value: object) -> str:
    name = str(value or "").strip()
    if not name or len(name) > 255:
        raise ValueError("Custom Collection name is required.")
    return name


class CustomCollectionArtworkRepository:
    def __init__(
        self,
        config: Mapping[str, Any],
        *,
        connect: Callable[..., Any] = pooled_connection,
    ) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._database_url:
            raise RuntimeError("Postgres configuration is required.")
        self._connect = connect

    def load(self, *, library_id: int, collection_name: str) -> dict[str, Any] | None:
        library_id = _positive_id(library_id, "Library ID")
        collection_name = _collection_name(collection_name)
        with self._connect(self._database_url, workload="browse") as connection:
            row = connection.execute(
                f"""
                select {_METADATA_COLUMNS}
                from library.custom_collection_artwork
                where library_id = %s and collection_name = %s
                """,
                (library_id, collection_name),
            ).fetchone()
        return dict(row) if row else None

    def load_image(self, *, library_id: int, collection_name: str) -> dict[str, Any] | None:
        library_id = _positive_id(library_id, "Library ID")
        collection_name = _collection_name(collection_name)
        with self._connect(self._database_url, workload="browse") as connection:
            row = connection.execute(
                """
                select image_bytes, content_type, content_sha256, revision
                from library.custom_collection_artwork
                where library_id = %s and collection_name = %s
                """,
                (library_id, collection_name),
            ).fetchone()
        return dict(row) if row else None

    def save(
        self,
        *,
        library_id: int,
        collection_name: str,
        account_id: int,
        image_bytes: bytes,
        content_sha256: str,
        width: int,
        height: int,
        filename: str,
    ) -> dict[str, Any]:
        library_id = _positive_id(library_id, "Library ID")
        account_id = _positive_id(account_id, "Account ID")
        collection_name = _collection_name(collection_name)
        if not isinstance(image_bytes, bytes) or not image_bytes:
            raise ValueError("Collection artwork bytes are required.")
        if len(image_bytes) > 16 * 1024 * 1024:
            raise ValueError("Collection artwork must be 16 MB or smaller.")
        if len(str(content_sha256 or "")) != 64:
            raise ValueError("Collection artwork checksum is invalid.")
        width = _positive_id(width, "Artwork width")
        height = _positive_id(height, "Artwork height")
        filename = str(filename or "collection-cover.jpg").strip() or "collection-cover.jpg"

        with self._connect(self._database_url, workload="default") as connection:
            exists = connection.execute(
                """
                select exists (
                    select 1
                    from library.exception_overrides
                    where library_id = %s
                      and override_payload ->> 'exception_type' = 'Custom Collection'
                      and override_payload ->> 'custom_collection_name' = %s
                ) as exists
                """,
                (library_id, collection_name),
            ).fetchone()
            if not exists or not bool(exists["exists"]):
                raise ValueError("Custom Collection does not exist.")
            row = connection.execute(
                f"""
                insert into library.custom_collection_artwork (
                    library_id, collection_name, updated_by_account_id,
                    image_bytes, content_type, content_sha256,
                    width, height, filename
                ) values (%s, %s, %s, %s, 'image/jpeg', %s, %s, %s, %s)
                on conflict (library_id, collection_name) do update set
                    updated_by_account_id = excluded.updated_by_account_id,
                    image_bytes = excluded.image_bytes,
                    content_type = excluded.content_type,
                    content_sha256 = excluded.content_sha256,
                    width = excluded.width,
                    height = excluded.height,
                    filename = excluded.filename,
                    revision = library.custom_collection_artwork.revision + 1,
                    updated_at = now()
                returning {_METADATA_COLUMNS}
                """,
                (
                    library_id, collection_name, account_id, image_bytes,
                    str(content_sha256), width, height, filename,
                ),
            ).fetchone()
        return dict(row)

    def delete(self, *, library_id: int, collection_name: str) -> bool:
        library_id = _positive_id(library_id, "Library ID")
        collection_name = _collection_name(collection_name)
        with self._connect(self._database_url, workload="default") as connection:
            row = connection.execute(
                """
                delete from library.custom_collection_artwork
                where library_id = %s and collection_name = %s
                returning library_id
                """,
                (library_id, collection_name),
            ).fetchone()
        return bool(row)
