"""PostgreSQL authority for MusicBrainz data corrections and the Edits Queue (Delivery 2, S4).

A correction compares an album's tags with the release it certainly is (decision state
``release``): the album title, the album artist, and each track's title and artist against
the release track at its own disc and position. Case, spacing (doubled, leading or trailing
spaces), accents, typos and edition suffixes are corrections (owner 2026-11-16); curly
against straight quotes, apostrophes and dashes are not, for now. Everything is computed from stored data on
read; nothing here asks MusicBrainz or writes media tags. "Add to queue" keeps the owner's
approved snapshot until Bulk Correction (PR 53) writes it through Edit Tags.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any

from music_app.services.musicbrainz_enrichment_postgres import (
    _active_library_cte,
    _aware_utc,
    _connect,
    _positive_id,
    _row_mapping,
    _transaction,
)

# Typographic forms that are the same correction-wise as their plain ASCII ones.
_TYPOGRAPHIC = ("’‘ʼ`´“”„–—‐‑", "'''''\"\"\"----")


def _comparable_sql(expression: str) -> str:
    """``expression`` with typographic punctuation as plain ASCII; case and spacing count."""
    source, target = (part.replace("'", "''") for part in _TYPOGRAPHIC)
    return (f"replace(translate(normalize(coalesce({expression}, ''), NFC), '{source}', '{target}'), "
            f"'…', '...')")


def _credit_sql(expression: str) -> str:
    """An artist credit as MusicBrainz writes it: each name followed by its join phrase."""
    return f"""(select nullif(btrim(string_agg(
                  coalesce(nullif(part ->> 'name', ''), part ->> 'artist_name', '')
                  || coalesce(part ->> 'join_phrase', ''), '' order by credit_order)), '')
                from jsonb_array_elements(coalesce({expression}, '[]'::jsonb))
                  with ordinality as credit(part, credit_order))"""


def _differs_sql(current: str, proposed: str) -> str:
    return f"({proposed}) is not null and {_comparable_sql(current)} <> {_comparable_sql(proposed)}"


# Every difference between an album's tags and its certain release, one row per album field
# or track field, with the album's own facts repeated for grouping.
_DIFFERENCES_SQL = _active_library_cte() + """
    , decided as (
      select albums.id as album_id, albums.library_id, albums.album_key, albums.title, albums.release_year,
             albums.cover_path, artists.name as artist_name, decision.release_mbid,
             coalesce(decision.disc_position, 1) as first_medium, releases.title as release_title,
             """ + _credit_sql("releases.artist_credit") + """ as release_credit, releases.media
      from active_library
      join library.local_album_musicbrainz_releases decision
        on decision.library_id = active_library.library_id and decision.state = 'release'
      join library.local_albums albums
        on albums.library_id = decision.library_id and albums.album_key = decision.album_key
      join integration.musicbrainz_releases releases on releases.mbid = decision.release_mbid
      left join library.local_artists artists
        on artists.library_id = albums.library_id and artists.id = albums.artist_id
      where %(album_key)s::text is null or decision.album_key = %(album_key)s::text
    ), remote_tracks as (
      select decided.album_id, (medium ->> 'position')::integer as medium_position,
             (track ->> 'position')::integer as position, nullif(btrim(track ->> 'title'), '') as title,
             """ + _credit_sql("track -> 'artist_credit'") + """ as artist
      from decided
      cross join jsonb_array_elements(decided.media) medium
      cross join jsonb_array_elements(coalesce(medium -> 'tracks', '[]'::jsonb)) track
    ), track_pairs as (
      select decided.album_id, coalesce(nullif(tracks.disc_number, 0), 1) as disc_number, tracks.track_number,
             tracks.title, track_artists.name as artist, remote.title as remote_title,
             remote.artist as remote_artist
      from decided
      join library.local_tracks tracks
        on tracks.library_id = decided.library_id and tracks.album_id = decided.album_id
      left join library.local_artists track_artists
        on track_artists.library_id = tracks.library_id and track_artists.id = tracks.artist_id
      join remote_tracks remote
        on remote.album_id = decided.album_id and remote.position = tracks.track_number
       and remote.medium_position = decided.first_medium + coalesce(nullif(tracks.disc_number, 0), 1) - 1
    ), differences as (
      select album_id, 'album' as field, null::integer as disc_number, null::integer as track_number,
             title as current_value, release_title as proposed_value
      from decided where """ + _differs_sql("title", "release_title") + """
      union all
      select album_id, 'album_artist', null, null, artist_name, release_credit
      from decided where """ + _differs_sql("artist_name", "release_credit") + """
      union all
      select album_id, 'title', disc_number, track_number, title, remote_title
      from track_pairs where """ + _differs_sql("title", "remote_title") + """
      union all
      select album_id, 'artist', disc_number, track_number, artist, remote_artist
      from track_pairs where """ + _differs_sql("artist", "remote_artist") + """
    ), facts as (
      -- Counted once per corrected album: its tracks and file types (by extension only).
      select corrected.album_id, count(distinct tracks.id)::integer as track_count,
             array_remove(array_agg(distinct upper(substring(files.private_path from '[.]([A-Za-z0-9]{1,8})$'))),
                          null) as file_types
      from (select distinct album_id from differences) corrected
      join library.local_tracks tracks on tracks.album_id = corrected.album_id
      left join library.local_track_files files on files.track_id = tracks.id
      group by corrected.album_id
    )
    select decided.album_key, decided.title as album_title, decided.artist_name, decided.release_year as year,
           decided.cover_path, decided.release_mbid::text as release_mbid, queue.queued_at,
           facts.track_count, facts.file_types, differences.field, differences.disc_number, differences.track_number,
           coalesce(differences.current_value, '') as current_value, differences.proposed_value
    from differences
    join decided on decided.album_id = differences.album_id
    join facts on facts.album_id = differences.album_id
    left join ops.musicbrainz_correction_queue queue
      on queue.library_id = decided.library_id and queue.album_key = decided.album_key
    order by lower(decided.title), decided.album_key, differences.disc_number nulls first,
             differences.track_number nulls first, differences.field;
"""

_QUEUE_SQL = _active_library_cte() + """
    , queued as (
      insert into ops.musicbrainz_correction_queue (
        library_id, album_key, release_mbid, corrections, queued_by_account_id, queued_at)
      select active_library.library_id, albums.album_key, %(release_mbid)s::uuid, %(corrections)s::jsonb,
             %(account_id)s, %(observed_at)s
      from active_library
      join library.local_albums albums
        on albums.library_id = active_library.library_id and albums.album_key = %(album_key)s
      on conflict (library_id, album_key) do update
      set release_mbid = excluded.release_mbid, corrections = excluded.corrections,
          queued_by_account_id = excluded.queued_by_account_id, queued_at = excluded.queued_at
      returning id, queued_at
    )
    select id, queued_at from queued;
"""

_LIST_QUEUE_SQL = _active_library_cte() + """
    select queue.id as entry_id, queue.album_key, albums.title as album_title, artists.name as artist_name,
           albums.release_year as year, albums.cover_path, queue.release_mbid::text as release_mbid,
           queue.corrections, queue.queued_at
    from ops.musicbrainz_correction_queue queue
    join active_library on active_library.library_id = queue.library_id
    join library.local_albums albums
      on albums.library_id = queue.library_id and albums.album_key = queue.album_key
    left join library.local_artists artists
      on artists.library_id = albums.library_id and artists.id = albums.artist_id
    order by queue.queued_at, queue.id;
"""

_REMOVE_SQL = _active_library_cte() + """
    , removed as (
      delete from ops.musicbrainz_correction_queue queue
      using active_library
      where queue.library_id = active_library.library_id and queue.id = %(entry_id)s
      returning 1
    )
    select exists (select 1 from removed) as removed;
"""

_SETTINGS_SQL = _active_library_cte() + """
    select coalesce(settings.auto_submit_bulks, false) as auto_submit_bulks, settings.changed_at
    from active_library
    left join ops.musicbrainz_correction_settings settings on settings.library_id = active_library.library_id;
"""

# A repeated save of the same value keeps the hour it counts from.
_SAVE_SETTINGS_SQL = _active_library_cte() + """
    , saved as (
      insert into ops.musicbrainz_correction_settings (library_id, auto_submit_bulks, changed_at,
                                                       changed_by_account_id)
      select library_id, %(auto_submit_bulks)s, %(observed_at)s, %(account_id)s from active_library
      on conflict (library_id) do update
      set auto_submit_bulks = excluded.auto_submit_bulks, changed_at = excluded.changed_at,
          changed_by_account_id = excluded.changed_by_account_id
      where ops.musicbrainz_correction_settings.auto_submit_bulks <> excluded.auto_submit_bulks
      returning auto_submit_bulks, changed_at
    )
    select auto_submit_bulks, changed_at from saved;
"""


class MusicBrainzCorrectionsPostgresRepository:
    def __init__(self, config: Mapping[str, object], *, connect: Callable[[str], Any] | None = None) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for MusicBrainz corrections.")
        self._connect = connect or _connect

    def list_differences(self, *, album_key: str | None = None) -> list[dict[str, object]]:
        """Each tag that differs from the album's certain release, in album then track order;
        one album when ``album_key`` names it."""
        with self._connect(self._database_url) as connection:
            return [_row_mapping(row) for row in connection.execute(
                _DIFFERENCES_SQL, {"album_key": None if album_key is None else str(album_key)}).fetchall()]

    def queue(self, *, album_key: str, release_mbid: str, corrections: list[dict[str, object]],
              actor_account_id: int | None, observed_at: datetime) -> dict[str, object] | None:
        """Keep (or replace) the album's approved correction. None: no such album."""
        params = {"album_key": str(album_key), "release_mbid": str(release_mbid),
                  "corrections": json.dumps(corrections), "account_id": actor_account_id,
                  "observed_at": _aware_utc(observed_at)}
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                return _row_mapping(connection.execute(_QUEUE_SQL, params).fetchone()) or None

    def list_queue(self) -> list[dict[str, object]]:
        with self._connect(self._database_url) as connection:
            rows = [_row_mapping(row) for row in connection.execute(_LIST_QUEUE_SQL).fetchall()]
        for row in rows:
            if isinstance(row.get("corrections"), str):
                row["corrections"] = json.loads(row["corrections"])
        return rows

    def remove(self, *, entry_id: int) -> bool:
        with self._connect(self._database_url) as connection:
            return bool(_row_mapping(connection.execute(
                _REMOVE_SQL, {"entry_id": _positive_id(entry_id)}).fetchone()).get("removed"))

    def settings(self) -> dict[str, object]:
        with self._connect(self._database_url) as connection:
            return _row_mapping(connection.execute(_SETTINGS_SQL).fetchone()) or {
                "auto_submit_bulks": False, "changed_at": None}

    def save_settings(self, *, auto_submit_bulks: bool, actor_account_id: int | None,
                      observed_at: datetime) -> dict[str, object]:
        params = {"auto_submit_bulks": bool(auto_submit_bulks), "account_id": actor_account_id,
                  "observed_at": _aware_utc(observed_at)}
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                connection.execute(_SAVE_SETTINGS_SQL, params)
                return _row_mapping(connection.execute(_SETTINGS_SQL).fetchone())
