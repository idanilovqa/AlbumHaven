"""Remove missing albums the user never touched, when every file was truly deleted.

Owner decision 2026-11-08, the one exception to "nothing is removed without confirmation": files
added by mistake and deleted again leave no trace. Both conditions must hold:

1. Every file of the album is missing with reason "deleted". An "unreachable"
   file, or any file still present, keeps it. A dropped drive or share can never remove anything.
2. Nothing user-owned refers to it: no user rating, play, play preference, loop, scrobble or love,
   in-app cover choice, extra artwork, MusicBrainz/Discogs link, tag edit or text correction,
   version/split/merge marking, Problematic Files ignore, or "Keep as missing". A cover whose
   origin is unknown counts as chosen (AGENTS.md: ambiguous provenance is never "untouched").

Albums are removed through library.confirm_missing_album_removal, as a confirmed removal is.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def remove_untouched_deleted(connection: Any, file_ids: Iterable[int]) -> list[str]:
    """Remove the albums of these missing files that qualify; returns the removed album keys.

    Loose tracks are not removed yet: the app role may delete tracks only through a
    security-definer function, which needs a migration of its own.
    """
    ids = sorted({int(file_id) for file_id in file_ids})
    if not ids:
        return []
    album_keys = [
        str(_value(row, "album_key"))
        for row in connection.execute(_UNTOUCHED_DELETED_ALBUMS_SQL, {"file_ids": ids}).fetchall()
    ]
    removed = []
    for album_key in album_keys:
        row = connection.execute(
            "select * from library.confirm_missing_album_removal(%(album_key)s)", {"album_key": album_key},
        ).fetchone()
        if int(_value(row, "removed_album_count") or 0) == 1:
            removed.append(album_key)
    return removed


def _value(row: object, key: str) -> object:
    if row is None:
        return None
    return row[key] if isinstance(row, dict) or hasattr(row, "keys") else row[0]


# Per track: every file deleted (never unreachable) and no user data on the track or its files.
_TRACK_TOUCH_CONDITION = """
    exists (
      select 1 from library.local_track_files files
      where files.track_id = candidate.track_id
        and (files.scan_cache_stale is false
             or files.metadata #>> '{scan_cache,missing_reason}' is distinct from 'deleted'
             -- A correction "Write in tags" wrote; the detected-corrections table is derived from tags.
             or exists (select 1 from library.local_track_file_text_correction_writes w where w.track_file_id = files.id)
             or exists (select 1 from library.tag_edit_intents intent
                        where strpos(intent.changes::text, to_jsonb(files.private_path)::text) > 0)
             or exists (select 1 from app.track_preferences p where p.track_key = files.private_path)
             or exists (select 1 from integration.listen_history h where h.track_key = files.private_path)
             or exists (select 1 from integration.pending_scrobbles s where s.track_key = files.private_path)
             or exists (select 1 from integration.lastfm_loved_tracks l where l.track_key = files.private_path)
             or exists (select 1 from library.exception_overrides o where o.track_key = files.private_path))
    )
    or exists (select 1 from app.track_preferences p where p.track_id = candidate.track_id)
    or exists (select 1 from app.saved_loops l where l.track_id = candidate.track_id)
    or exists (select 1 from app.saved_loop_orders l where l.track_id = candidate.track_id)
    or exists (select 1 from integration.listen_history h where h.track_id = candidate.track_id)
    or exists (select 1 from integration.pending_scrobbles s where s.track_id = candidate.track_id)
    or exists (select 1 from integration.lastfm_loved_tracks l where l.track_id = candidate.track_id)
    or exists (select 1 from library.exception_overrides o where o.track_id = candidate.track_id)
    or exists (select 1 from library.local_mbid_assertions m where m.track_id = candidate.track_id)
"""

# An album-key mark relates to the album when the keys are equal or one extends the other
# (year-split and separate-release keys append "::..." to the album key).
_KEY_RELATED = "({key} = albums.album_key or starts_with({key}, albums.album_key || '::') " \
               "or starts_with(albums.album_key, {key} || '::'))"

_UNTOUCHED_DELETED_ALBUMS_SQL = f"""
    with candidate_albums as (
      select distinct tracks.album_id
      from library.local_track_files files
      join library.local_tracks tracks on tracks.id = files.track_id
      where files.id = any(%(file_ids)s::bigint[]) and tracks.album_id is not null
    )
    select albums.album_key
    from library.local_albums albums
    join candidate_albums on candidate_albums.album_id = albums.id
    where not exists (
        select 1 from (select tracks.id as track_id from library.local_tracks tracks
                       where tracks.album_id = albums.id) candidate
        where {_TRACK_TOUCH_CONDITION}
      )
      and not exists (select 1 from app.album_ratings r
                      where r.library_id = albums.library_id and r.album_key = albums.album_key
                        and r.provenance is distinct from 'file_tag_scan')
      and not exists (select 1 from library.local_album_additional_artworks a where a.album_id = albums.id)
      and not exists (select 1 from library.local_mbid_assertions m where m.album_id = albums.id)
      and not exists (select 1 from library.separate_releases s
                      where s.library_id = albums.library_id and {_KEY_RELATED.format(key='s.release_key')})
      and not exists (select 1 from library.ignored_versions v
                      where v.library_id = albums.library_id and {_KEY_RELATED.format(key='v.version_key')})
      and not exists (select 1 from library.manual_versions m
                      where m.library_id = albums.library_id
                        and ({_KEY_RELATED.format(key='m.child_key')} or {_KEY_RELATED.format(key='m.parent_key')}))
      and not exists (select 1 from library.ignored_repairs i
                      where i.library_id = albums.library_id
                        and ({_KEY_RELATED.format(key='i.repair_key')} or i.metadata ->> 'album_key' = albums.album_key))
      and not (albums.metadata ? 'missing_kept_at')
      -- An in-app cover choice, or any cover whose origin is unknown, is the user's.
      and coalesce(albums.metadata ->> 'cover_selection_origin', '') <> 'user'
      and not (albums.metadata ? 'cover_selection_repair_previous')
      and (albums.metadata ->> 'cover_selection_origin' = 'automatic'
           or (nullif(albums.cover_path, '') is null
               and nullif(albums.metadata ->> 'remote_cover_url', '') is null
               and nullif(albums.metadata ->> 'cover_selection_provenance', '') is null))
    order by albums.album_key
"""
