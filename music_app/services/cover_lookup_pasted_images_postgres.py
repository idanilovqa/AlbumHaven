"""Postgres authority for the images a user pasted into an album's Cover Look Up (PASTED IMAGES).

Rows are read and written per key (account, album, content hash). Only the pasting account sees them; an album
keeps at most ``MAX_PASTED_IMAGES_PER_ALBUM`` per account (a new one drops the oldest), and a row unused for
``PASTED_IMAGE_TTL`` is removed through the ``last_used_at`` index.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from typing import Any

from music_app.services.postgres_connections import pooled_connection as _pooled_connection


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
MAX_PASTED_IMAGES_PER_ALBUM = 10
MAX_PASTED_IMAGE_BYTES = 32 * 1024 * 1024
PASTED_IMAGE_TTL = "7 days"


class CoverLookupPastedImageRepository:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        # Requests lease the shared pool; ``connect`` is a test's own connection.
        self._connect = connect

    def list_for_album(self, *, account_id: int, album_id: int) -> list[dict[str, object]]:
        """The account's pasted images for the album, oldest first; opening them counts as a use."""
        with self._connect_to_database() as connection:
            with connection.transaction():
                connection.execute(_DELETE_EXPIRED_SQL, {"ttl": PASTED_IMAGE_TTL})
                rows = connection.execute(_TOUCH_ALBUM_SQL, _key(account_id, album_id)).fetchall()
        return [pasted_image_payload(row) for row in sorted(rows, key=_paste_order)]

    def add(
        self,
        *,
        account_id: int,
        album_id: int,
        image: bytes,
        mime_type: str,
        filename: str,
        width: int | None,
        height: int | None,
    ) -> dict[str, object]:
        mime_type = str(mime_type or "").strip().casefold()
        if not mime_type.startswith("image/"):
            raise ValueError("Choose an image file.")
        if not image or len(image) > MAX_PASTED_IMAGE_BYTES:
            raise ValueError("Images must be 32 MB or smaller.")
        params = {
            **_key(account_id, album_id),
            "content_sha256": hashlib.sha256(image).hexdigest(),
            "mime_type": mime_type,
            "filename": str(filename or "").strip()[:255],
            "width": _dimension(width),
            "height": _dimension(height),
            "image": image,
            "limit": MAX_PASTED_IMAGES_PER_ALBUM,
        }
        with self._connect_to_database() as connection:
            with connection.transaction():
                row = connection.execute(_UPSERT_SQL, params).fetchone()
                evicted = connection.execute(_EVICT_OLDEST_SQL, params).fetchall()
        return {
            "item": pasted_image_payload(row),
            "evicted_ids": [str(item["content_sha256"]) for item in sorted(evicted, key=_paste_order)],
        }

    def read_image(self, *, account_id: int, album_id: int, image_id: str) -> tuple[bytes, str] | None:
        with self._connect_to_database() as connection:
            with connection.transaction():
                row = connection.execute(
                    _READ_IMAGE_SQL, {**_key(account_id, album_id), "content_sha256": str(image_id)},
                ).fetchone()
        return (bytes(row["image"]), str(row["mime_type"])) if row else None

    def delete(self, *, account_id: int, album_id: int, image_id: str) -> bool:
        with self._connect_to_database() as connection:
            with connection.transaction():
                row = connection.execute(
                    _DELETE_SQL, {**_key(account_id, album_id), "content_sha256": str(image_id)},
                ).fetchone()
        return row is not None

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for pasted images.")
        if self._connect is None:
            return _pooled_connection(self._database_url, workload="default")
        return self._connect(self._database_url)


def pasted_image_payload(row: Mapping[str, object]) -> dict[str, object]:
    """Client contract: a PASTED IMAGES card, named by its content hash."""
    return {
        "id": str(row["content_sha256"]),
        "filename": str(row.get("filename") or "") or "Pasted image",
        "mime_type": str(row.get("mime_type") or ""),
        "width": int(row.get("width") or 0),
        "height": int(row.get("height") or 0),
        "size_bytes": int(row.get("size_bytes") or 0),
    }


def _key(account_id: int, album_id: int) -> dict[str, int]:
    return {"account_id": int(account_id), "album_id": int(album_id)}


def _dimension(value: object) -> int | None:
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _paste_order(row: Mapping[str, object]) -> tuple[object, str]:
    return row["created_at"], str(row["content_sha256"])


_COLUMNS = "content_sha256, filename, mime_type, width, height, octet_length(image) as size_bytes, created_at"

_DELETE_EXPIRED_SQL = """
delete from library.cover_lookup_pasted_images
where last_used_at < now() - %(ttl)s::interval
"""

_TOUCH_ALBUM_SQL = f"""
update library.cover_lookup_pasted_images
set last_used_at = now()
where account_id = %(account_id)s and album_id = %(album_id)s
returning {_COLUMNS}
"""

_UPSERT_SQL = f"""
insert into library.cover_lookup_pasted_images
  (account_id, album_id, content_sha256, mime_type, filename, width, height, image)
values
  (%(account_id)s, %(album_id)s, %(content_sha256)s, %(mime_type)s, %(filename)s, %(width)s, %(height)s,
   %(image)s)
on conflict (account_id, album_id, content_sha256) do update set last_used_at = now()
returning {_COLUMNS}
"""

_EVICT_OLDEST_SQL = """
delete from library.cover_lookup_pasted_images
where account_id = %(account_id)s and album_id = %(album_id)s
  and content_sha256 in (
    select content_sha256
    from library.cover_lookup_pasted_images
    where account_id = %(account_id)s and album_id = %(album_id)s
    order by created_at desc, content_sha256 desc
    offset %(limit)s
  )
returning content_sha256, created_at
"""

_READ_IMAGE_SQL = """
update library.cover_lookup_pasted_images
set last_used_at = now()
where account_id = %(account_id)s and album_id = %(album_id)s and content_sha256 = %(content_sha256)s
returning image, mime_type
"""

_DELETE_SQL = """
delete from library.cover_lookup_pasted_images
where account_id = %(account_id)s and album_id = %(album_id)s and content_sha256 = %(content_sha256)s
returning content_sha256
"""
