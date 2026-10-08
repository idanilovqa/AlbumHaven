"""Small account/library-scoped Home projection from persisted listening history."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from music_app.services.client_layout_preferences import _connect, _owner

_RECENT_ALBUMS_SQL = """
with recent as (
    select t.album_id, max(h.played_at) as last_played_at
    from integration.listen_history h
    join library.local_tracks t on t.id = h.track_id and t.library_id = h.library_id
    where h.account_id = %s and h.library_id = %s and t.album_id is not null
      and (h.measured_listened_seconds is null or h.measured_listened_seconds > 0)
    group by t.album_id
    order by last_played_at desc, t.album_id
    limit %s
)
select a.album_key, a.title, a.release_year, a.cover_path, a.metadata,
       ar.name as artist_name, r.last_played_at,
       totals.track_count, totals.total_duration_seconds
from recent r
join library.local_albums a on a.id = r.album_id and a.library_id = %s
left join library.local_artists ar on ar.id = a.artist_id and ar.library_id = a.library_id
cross join lateral (
    select count(*) as track_count, coalesce(sum(t.duration_seconds), 0) as total_duration_seconds
    from library.local_tracks t where t.album_id = a.id and t.library_id = a.library_id
) totals
order by r.last_played_at desc, a.album_key
"""


class PostgresRecentAlbums:
    def __init__(self, config: Mapping[str, object], *, connect: Callable[[str], Any] | None = None):
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        self._connect = connect or _connect

    def load(self, *, account_id: int, library_id: int, limit: int = 24) -> list[dict[str, object]]:
        account_id, library_id = _owner(account_id), _owner(library_id)
        if type(limit) is not int or not 1 <= limit <= 48:
            raise ValueError("Invalid recent album limit.")
        if not self._database_url:
            raise RuntimeError("An application database is required.")
        with self._connect(self._database_url) as connection:
            rows = connection.execute(_RECENT_ALBUMS_SQL, (account_id, library_id, limit, library_id)).fetchall()
        result = []
        for row in rows:
            metadata = row["metadata"] if isinstance(row["metadata"], Mapping) else {}
            seconds = float(row["total_duration_seconds"] or 0)
            minutes, remaining = divmod(round(seconds), 60)
            result.append({
                "key": str(row["album_key"]), "name": str(row["title"]),
                "album_artist": str(metadata.get("album_artist") or row["artist_name"] or "Unknown artist"),
                "year": row["release_year"], "cover_path": str(row["cover_path"] or ""),
                "cover_revision": str(metadata.get("cover_revision") or ""),
                "edition": str(metadata.get("edition") or ""),
                "preview_only": True, "track_count_preview": int(row["track_count"]),
                "total_duration_seconds": seconds, "total_duration_display": f"{minutes}:{remaining:02d}",
                "last_played_at": row["last_played_at"].isoformat(),
                "library_root_category": str(metadata.get("library_root_category") or "main_library"),
                "release_type": str(metadata.get("release_type") or "studio"),
            })
        return result
