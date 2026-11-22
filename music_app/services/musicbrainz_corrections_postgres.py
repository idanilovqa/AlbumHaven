"""PostgreSQL authority for MusicBrainz data corrections (Delivery 2, S4).

Each certainly matched album is compared with its edition (the release decision) in Python
(musicbrainz_correction_kinds) and every difference is stored as a row with its kind and mode:
trivial kinds apply automatically, the rest wait for the owner. Whatever changes an album's
comparison marks that album (0260), so a refresh reads only those albums, and a tag signature
recompares only those that differ; refreshes run when a release decision is recorded and in the
background after Problematic Files is invalidated (tag edits, rescans, watcher). Each album's
Edits Queue groups and their totals are stored (0260): nothing here reads the whole library. The
owner's undo, skip and approval decisions are kept by the exact change, so a refresh never
reapplies an undone change. "Applied" is display only until Bulk Correction (needs PR 65) writes tags; nothing here
writes media tags.
"""
from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timezone
from typing import Any

from music_app.services.musicbrainz_correction_kinds import (
    ARTIST_KINDS,
    REVIEW_KINDS,
    compare_album,
    credited_album_artist,
)
from music_app.services.musicbrainz_enrichment_postgres import (
    _active_library_cte,
    _aware_utc,
    _connect,
    _positive_id,
    _row_mapping,
    _transaction,
)
from music_app.services.musicbrainz_release_identity_postgres import parse_track_pairing

# The review group of albums the guard (or an ambiguous pairing) sends to review whole.
WHOLE_ALBUM_GROUP = "whole_album"
# The stored group of every album needing a correction, for Problematic Files.
NEEDED_SECTION, NEEDED_GROUP = "needed", "album"
REFRESH_BATCH_MARKS = 200
DECISIONS = frozenset({"undone", "skipped", "approved"})
# Part of every signature, so rows stored under older comparison rules are compared again when their
# album is refreshed. A change here needs a migration that marks every matched album once, as 0260
# does for 2 (credited album artists).
COMPARE_RULES_VERSION = 2

_DECISION_MATCH = """
    decision.library_id = correction.library_id and decision.album_key = correction.album_key
    and decision.field = correction.field and decision.disc_number = correction.disc_number
    and decision.track_number = correction.track_number
    and decision.current_value = correction.current_value and decision.proposed_value = correction.proposed_value
"""
# A row is applied (shown in place of its tag) when automatic and not undone, or approved.
_STATE_SQL = f"""
    case
      when exists (select 1 from library.local_album_musicbrainz_correction_decisions decision
                   where {_DECISION_MATCH} and decision.decision = 'approved') then 'applied'
      when exists (select 1 from library.local_album_musicbrainz_correction_decisions decision
                   where {_DECISION_MATCH} and decision.decision = 'undone') then 'undone'
      when exists (select 1 from library.local_album_musicbrainz_correction_decisions decision
                   where {_DECISION_MATCH} and decision.decision = 'skipped') then 'skipped'
      when correction.mode = 'auto' then 'applied'
      else 'pending'
    end
"""

# The given albums' signatures: everything a comparison reads. A new input needs a mark in 0260's triggers.
_SIGNATURES_SQL = _active_library_cte() + f"""
    select albums.id as album_id, albums.library_id, albums.album_key, decision.release_mbid::text,
           md5(concat_ws(E'\\x1f', 'rules-{COMPARE_RULES_VERSION}', decision.release_mbid,
             releases.refreshed_at, decision.disc_position,
             decision.match_quality, decision.track_pairing::text, albums.title, artists.name,
             (select string_agg(concat_ws(E'\\x1e', tracks.disc_number, tracks.track_number, tracks.title,
                                          track_artists.name), E'\\x1d'
                                order by tracks.disc_number, tracks.track_number, tracks.id)
              from library.local_tracks tracks
              left join library.local_artists track_artists on track_artists.id = tracks.artist_id
              where tracks.album_id = albums.id))) as signature,
           stored.signature as stored_signature
    from active_library
    join library.local_album_musicbrainz_releases decision
      on decision.library_id = active_library.library_id and decision.state = 'release'
    join library.local_albums albums
      on albums.library_id = decision.library_id and albums.album_key = decision.album_key
    join integration.musicbrainz_releases releases on releases.mbid = decision.release_mbid
    left join library.local_artists artists on artists.id = albums.artist_id
    left join library.local_album_musicbrainz_corrections stored
      on stored.library_id = albums.library_id and stored.album_key = albums.album_key
    where albums.id = any(%(album_ids)s::bigint[]);
"""

# Everything one comparison needs, for the given albums.
_COMPARE_SQL = """
    select albums.id as album_id, albums.library_id, albums.album_key, albums.title, artists.name as artist_name,
           releases.title as release_title, releases.artist_credit, releases.media, decision.disc_position,
           decision.release_mbid::text, decision.match_quality, decision.track_pairing, decision.track_order_differs,
           coalesce((select json_agg(json_build_object(
                       'disc_number', coalesce(nullif(tracks.disc_number, 0), 1), 'track_number', tracks.track_number,
                       'title', tracks.title, 'artist', track_artists.name)
                       order by tracks.disc_number, tracks.track_number, tracks.id)
                     from library.local_tracks tracks
                     left join library.local_artists track_artists on track_artists.id = tracks.artist_id
                     where tracks.album_id = albums.id), '[]'::json) as tracks
    from library.local_albums albums
    join library.local_album_musicbrainz_releases decision
      on decision.library_id = albums.library_id and decision.album_key = albums.album_key and decision.state = 'release'
    join integration.musicbrainz_releases releases on releases.mbid = decision.release_mbid
    left join library.local_artists artists on artists.id = albums.artist_id
    where albums.id = any(%(album_ids)s::bigint[]);
"""

# One writer of stored corrections at a time: two refreshes of one album would both insert its rows.
_LOCK_SQL = """
    select pg_advisory_xact_lock(hashtextextended('album-haven:musicbrainz-corrections', 0));
"""
_MARKS_SQL = """
    select id, album_id from library.musicbrainz_correction_refresh_marks
    where id > %(after)s order by id limit %(limit)s;
"""
# Only the marks read: one added meanwhile waits for the next batch.
_CLEAR_MARKS_SQL = """
    delete from library.musicbrainz_correction_refresh_marks where id = any(%(mark_ids)s::bigint[]);
"""
_ALBUM_KEYS_SQL = _active_library_cte() + """
    select albums.album_key
    from library.local_albums albums
    join active_library on active_library.library_id = albums.library_id
    where albums.id = any(%(album_ids)s::bigint[]);
"""

# Stored results whose album is no longer certainly matched (within the refreshed albums).
_PRUNE_SQL = _active_library_cte() + """
    delete from library.local_album_musicbrainz_corrections stored
    using active_library
    where stored.library_id = active_library.library_id
      and stored.album_key = any(%(album_keys)s::text[])
      and not exists (select 1 from library.local_album_musicbrainz_releases decision
                      where decision.library_id = stored.library_id and decision.album_key = stored.album_key
                        and decision.state = 'release');
"""
_PRUNE_ROWS_SQL = _active_library_cte() + """
    delete from library.local_album_musicbrainz_correction_rows correction
    using active_library
    where correction.library_id = active_library.library_id
      and correction.album_key = any(%(album_keys)s::text[])
      and not exists (select 1 from library.local_album_musicbrainz_corrections stored
                      where stored.library_id = correction.library_id and stored.album_key = correction.album_key);
"""

_STORE_SQL = """
    with incoming as (
      select * from jsonb_to_recordset(%(albums)s::jsonb) as rows(
        library_id bigint, album_key text, signature text, release_mbid uuid, correction_count integer,
        auto_count integer, review_count integer, review_whole boolean)
    ), cleared as (
      delete from library.local_album_musicbrainz_correction_rows correction
      using incoming where correction.library_id = incoming.library_id and correction.album_key = incoming.album_key
    ), summaries as (
      insert into library.local_album_musicbrainz_corrections (
        library_id, album_key, signature, release_mbid, correction_count, auto_count, review_count, review_whole,
        computed_at)
      select library_id, album_key, signature, release_mbid, correction_count, auto_count, review_count,
             review_whole, %(now)s from incoming
      on conflict (library_id, album_key) do update
      set signature = excluded.signature, release_mbid = excluded.release_mbid,
          correction_count = excluded.correction_count, auto_count = excluded.auto_count,
          review_count = excluded.review_count, review_whole = excluded.review_whole,
          computed_at = excluded.computed_at
    )
    select 1;
"""
_STORE_ROWS_SQL = """
    insert into library.local_album_musicbrainz_correction_rows (
      library_id, album_key, field, disc_number, track_number, current_value, proposed_value, kind, mode)
    select library_id, album_key, field, disc_number, track_number, current_value, proposed_value, kind, mode
    from jsonb_to_recordset(%(rows)s::jsonb) as rows(
      library_id bigint, album_key text, field text, disc_number integer, track_number integer,
      current_value text, proposed_value text, kind text, mode text);
"""

# Problematic Files reads only these, for the albums it lists or one page of them, and the stored
# total: no comparison runs when it opens, and the library is never counted or sorted.
_SUMMARIES_SQL = _active_library_cte() + """
    select stored.album_key, albums.title as album_title, artists.name as artist_name,
           albums.release_year as year, albums.cover_path, stored.release_mbid::text as release_mbid,
           stored.correction_count, stored.auto_count, stored.review_count, stored.review_whole
    from library.local_album_musicbrainz_corrections stored
    join active_library on active_library.library_id = stored.library_id
    join library.local_albums albums
      on albums.library_id = stored.library_id and albums.album_key = stored.album_key
    left join library.local_artists artists on artists.id = albums.artist_id
    where stored.correction_count > 0
      and stored.album_key = any(%(album_keys)s::text[]);
"""
# A page walks the page index to its offset: no summary read, no sort. (Offset, not a cursor: the
# approved E2E asserts the request's offset.)
_SUMMARY_PAGE_SQL = _active_library_cte() + f"""
    select groups.album_key
    from library.local_album_musicbrainz_correction_groups groups
    where groups.library_id = (select library_id from active_library)
      and groups.section = '{NEEDED_SECTION}' and groups.grouping = '{NEEDED_GROUP}'
    order by groups.sort_title, groups.album_key
    offset %(offset)s limit %(limit)s;
"""
_SUMMARY_COUNT_SQL = _active_library_cte() + f"""
    select coalesce(sum(counts.album_count), 0)::integer as total
    from library.musicbrainz_correction_group_counts counts
    join active_library on active_library.library_id = counts.library_id
    where counts.section = '{NEEDED_SECTION}';
"""

# One album's rows with their state, in album then track order.
_ALBUM_ROWS_SQL = _active_library_cte() + f"""
    select correction.field, correction.disc_number, correction.track_number, correction.current_value,
           correction.proposed_value, correction.kind, correction.mode, {_STATE_SQL} as state
    from library.local_album_musicbrainz_correction_rows correction
    join active_library on active_library.library_id = correction.library_id
    where correction.album_key = %(album_key)s
    order by correction.disc_number, correction.track_number, correction.field;
"""

# The Edits Queue: "applied" (the automatic history, and what was approved) or "review" (waiting),
# by kind; albums sent to review whole form their own review group. These are the given albums'
# rows with section and group. A row has at most one decision (its primary key is _DECISION_MATCH),
# so one join gives _STATE_SQL's state.
_LISTED_SQL = _active_library_cte() + f"""
    , rows as (
      select correction.*, stored.review_whole,
             case decision.decision when 'approved' then 'applied' when 'undone' then 'undone'
                                    when 'skipped' then 'skipped'
                                    else case when correction.mode = 'auto' then 'applied' else 'pending' end
             end as state
      from library.local_album_musicbrainz_correction_rows correction
      join active_library on active_library.library_id = correction.library_id
      join library.local_album_musicbrainz_corrections stored
        on stored.library_id = correction.library_id and stored.album_key = correction.album_key
      left join library.local_album_musicbrainz_correction_decisions decision on {_DECISION_MATCH}
      where correction.album_key = any(%(album_keys)s::text[])
    ), listed as (
      select case when state = 'pending' then 'review' else 'applied' end as section,
             case when state = 'pending' and review_whole then '{WHOLE_ALBUM_GROUP}' else kind end as grouping,
             rows.*
      from rows
      where state in ('pending', 'applied') or (state = 'undone' and mode = 'auto')
    )
"""
# The given albums' stored groups follow their rows and decisions. Only a changed group is
# written, so only a change adds to the totals.
_STORE_GROUPS_SQL = _LISTED_SQL + f"""
    , desired as (
      select listed.library_id, listed.album_key, listed.section, listed.grouping,
             left(lower(coalesce(local.title, '')), 256) as sort_title, count(*)::integer as row_count
      from listed
      join library.local_albums local on local.library_id = listed.library_id and local.album_key = listed.album_key
      group by listed.library_id, listed.album_key, listed.section, listed.grouping, local.title
      union all
      select stored.library_id, stored.album_key, '{NEEDED_SECTION}', '{NEEDED_GROUP}',
             left(lower(coalesce(local.title, '')), 256), stored.correction_count
      from library.local_album_musicbrainz_corrections stored
      join active_library on active_library.library_id = stored.library_id
      join library.local_albums local on local.library_id = stored.library_id and local.album_key = stored.album_key
      where stored.album_key = any(%(album_keys)s::text[]) and stored.correction_count > 0
    ), removed as (
      delete from library.local_album_musicbrainz_correction_groups groups
      using active_library
      where groups.library_id = active_library.library_id
        and groups.album_key = any(%(album_keys)s::text[])
        and not exists (select 1 from desired
                        where desired.album_key = groups.album_key and desired.section = groups.section
                          and desired.grouping = groups.grouping)
    )
    insert into library.local_album_musicbrainz_correction_groups as groups
      (library_id, album_key, section, grouping, sort_title, row_count)
    select library_id, album_key, section, grouping, sort_title, row_count from desired
    on conflict (library_id, album_key, section, grouping) do update
    set sort_title = excluded.sort_title, row_count = excluded.row_count
    where (groups.sort_title, groups.row_count) is distinct from (excluded.sort_title, excluded.row_count);
"""
# The totals' deltas fold into one row per section and group.
_COMPACT_COUNTS_SQL = """
    with removed as (
      delete from library.musicbrainz_correction_group_counts returning *
    )
    insert into library.musicbrainz_correction_group_counts (library_id, section, grouping, album_count, row_count)
    select library_id, section, grouping, sum(album_count), sum(row_count)
    from removed
    group by library_id, section, grouping
    having sum(album_count) <> 0 or sum(row_count) <> 0;
"""
_KIND_COUNTS_SQL = _active_library_cte() + """
    select counts.grouping as kind, sum(counts.album_count)::integer as albums, sum(counts.row_count)::integer as rows
    from library.musicbrainz_correction_group_counts counts
    join active_library on active_library.library_id = counts.library_id
    where counts.section = %(section)s
    group by counts.grouping
    having sum(counts.album_count) > 0
    order by counts.grouping;
"""
# A page is two reads: its albums from the page index, after the previous page's last, then only
# those albums' rows (by the album index).
_KIND_PAGE_ALBUMS_SQL = _active_library_cte() + """
    select groups.album_key, groups.sort_title
    from library.local_album_musicbrainz_correction_groups groups
    where groups.library_id = (select library_id from active_library)
      and groups.section = %(section)s and groups.grouping = %(kind)s
      and (groups.sort_title, groups.album_key) > (%(after_title)s, %(after_key)s)
    order by groups.sort_title, groups.album_key
    limit %(limit)s;
"""
_KIND_PAGE_SQL = _LISTED_SQL + """
    select listed.album_key, local.title as album_title, artists.name as artist_name, local.release_year as year,
           local.cover_path,
           json_agg(json_build_object('field', listed.field, 'disc_number', listed.disc_number,
                                      'track_number', listed.track_number, 'current_value', listed.current_value,
                                      'proposed_value', listed.proposed_value, 'kind', listed.kind,
                                      'state', listed.state)
                    order by listed.disc_number, listed.track_number, listed.field) as rows
    from listed
    join library.local_albums local on local.library_id = listed.library_id and local.album_key = listed.album_key
    left join library.local_artists artists on artists.id = local.artist_id
    where listed.section = %(section)s and listed.grouping = %(kind)s
    group by listed.album_key, local.title, artists.name, local.release_year, local.cover_path;
"""

_CHOSEN_COLUMNS_SQL = """
      select correction.library_id, correction.album_key, correction.field, correction.disc_number,
             correction.track_number, correction.current_value, correction.proposed_value
"""
_RECORD_DECISION_SQL = """
    ), decided as (
      insert into library.local_album_musicbrainz_correction_decisions (
        library_id, album_key, field, disc_number, track_number, current_value, proposed_value, decision,
        decided_by_account_id, decided_at)
      select library_id, album_key, field, disc_number, track_number, current_value, proposed_value,
             %(decision)s, %(account_id)s, %(now)s
      from chosen
      on conflict (library_id, album_key, field, disc_number, track_number, current_value, proposed_value)
      do update set decision = excluded.decision, decided_by_account_id = excluded.decided_by_account_id,
                    decided_at = excluded.decided_at
      returning album_key
    )
    select count(*)::integer as decided, coalesce(array_agg(distinct album_key), '{}'::text[]) as album_keys
    from decided;
"""
# Record one decision for an album's applied automatic rows (undone) or its waiting rows
# (approved, skipped).
_DECIDE_ALBUM_SQL = _active_library_cte() + f"""
    , chosen as ({_CHOSEN_COLUMNS_SQL}
      from library.local_album_musicbrainz_correction_rows correction
      join active_library on active_library.library_id = correction.library_id
      where correction.album_key = %(album_key)s::text
        and ({_STATE_SQL}) = %(from_state)s
""" + _RECORD_DECISION_SQL
# Every waiting row of one kind outside whole-album review (those are their own group): the
# albums come from the page index.
_DECIDE_KIND_SQL = _active_library_cte() + f"""
    , chosen as ({_CHOSEN_COLUMNS_SQL}
      from library.local_album_musicbrainz_correction_groups groups
      join active_library on active_library.library_id = groups.library_id
      join library.local_album_musicbrainz_correction_rows correction
        on correction.library_id = groups.library_id and correction.album_key = groups.album_key
       and correction.kind = groups.grouping
      where groups.section = 'review' and groups.grouping = %(kind)s
        and ({_STATE_SQL}) = %(from_state)s
""" + _RECORD_DECISION_SQL

# Write the applied values beside the tag-derived ones (local_albums.corrected_title and
# corrected_album_artist, local_tracks.corrected_title and corrected_artist) for the given
# albums; null where nothing is applied. Returns the albums whose values changed.
_SYNC_SQL = _active_library_cte() + f"""
    , scope as (
      select albums.id, albums.library_id, albums.album_key
      from library.local_albums albums
      join active_library on active_library.library_id = albums.library_id
      where albums.album_key = any(%(album_keys)s::text[])
    ), applied as materialized (
      select correction.album_key, correction.field, correction.disc_number, correction.track_number,
             correction.proposed_value
      from library.local_album_musicbrainz_correction_rows correction
      join scope on scope.library_id = correction.library_id and scope.album_key = correction.album_key
      where ({_STATE_SQL}) = 'applied'
    ), album_values as (
      select scope.id,
             max(applied.proposed_value) filter (where applied.field = 'album') as title,
             max(applied.proposed_value) filter (where applied.field = 'album_artist') as album_artist
      from scope
      left join applied on applied.album_key = scope.album_key and applied.field in ('album', 'album_artist')
      group by scope.id
    ), albums_changed as (
      update library.local_albums albums
      set corrected_title = album_values.title, corrected_album_artist = album_values.album_artist
      from album_values
      where albums.id = album_values.id
        and (albums.corrected_title is distinct from album_values.title
             or albums.corrected_album_artist is distinct from album_values.album_artist)
      returning albums.album_key
    ), track_values as (
      select tracks.id, scope.album_key,
             max(applied.proposed_value) filter (where applied.field = 'title') as title,
             max(applied.proposed_value) filter (where applied.field = 'artist') as artist
      from scope
      join library.local_tracks tracks on tracks.album_id = scope.id
      left join applied
        on applied.album_key = scope.album_key and applied.field in ('title', 'artist')
       and applied.disc_number = coalesce(nullif(tracks.disc_number, 0), 1)
       and applied.track_number = tracks.track_number
      group by tracks.id, scope.album_key
    ), tracks_changed as (
      update library.local_tracks tracks
      set corrected_title = track_values.title, corrected_artist = track_values.artist
      from track_values
      where tracks.id = track_values.id
        and (tracks.corrected_title is distinct from track_values.title
             or tracks.corrected_artist is distinct from track_values.artist)
      returning track_values.album_key
    )
    select album_key from albums_changed union select album_key from tracks_changed;
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


def _json(value: object) -> object:
    return json.loads(value) if isinstance(value, str) else value


def compare_stored_album(row: Mapping[str, object]) -> dict[str, object]:
    """Compare one album as the compare query returns it."""
    return compare_album({
        "title": row.get("title"), "artist_name": row.get("artist_name"),
        "release_title": row.get("release_title"),
        "release_credit": credited_album_artist(_json(row.get("artist_credit")) or []) or None,
        "media": _json(row.get("media")) or [], "tracks": _json(row.get("tracks")) or [],
        "disc_position": row.get("disc_position"), "pairing": parse_track_pairing(row),
    })


# The applied rows of one album by its row id, for album details.
_DISPLAY_ROWS_SQL = f"""
    select correction.field, correction.disc_number, correction.track_number, correction.proposed_value
    from library.local_albums album
    join library.local_album_musicbrainz_correction_rows correction
      on correction.library_id = album.library_id and correction.album_key = album.album_key
    where album.id = %(album_id)s and ({_STATE_SQL}) = 'applied';
"""


def album_display_rows(connection: Any, *, album_id: object) -> list[dict[str, object]]:
    """The album's applied rows (automatic and not undone, or approved), for display."""
    return [_row_mapping(row) for row in connection.execute(_DISPLAY_ROWS_SQL, {"album_id": album_id}).fetchall()]


class MusicBrainzCorrectionsPostgresRepository:
    def __init__(self, config: Mapping[str, object], *, connect: Callable[[str], Any] | None = None,
                 on_change: Callable[[tuple[str, ...]], None] | None = None) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for MusicBrainz corrections.")
        self._connect = connect or _connect
        self._on_change = on_change

    def _store_derived(self, connection: Any, album_keys: list[str]) -> tuple[str, ...]:
        """Store the given albums' groups, totals and corrected values. Returns the albums whose
        corrected values changed."""
        params = {"album_keys": album_keys}
        connection.execute(_STORE_GROUPS_SQL, params)
        connection.execute(_COMPACT_COUNTS_SQL)
        return tuple(sorted(str(_row_mapping(row)["album_key"]) for row in connection.execute(
            _SYNC_SQL, params).fetchall()))

    def _changed(self, album_keys: tuple[str, ...]) -> None:
        """Search, gallery and Problematic Files caches follow the changed corrected values."""
        notify_searchable_values_changed(self._database_url, album_keys, on_change=self._on_change)

    def list_summaries(self, *, album_keys: Iterable[str] | None = None, offset: int = 0,
                       limit: int | None = None) -> dict[str, object]:
        """The stored albums needing a correction (those of ``album_keys``, or a page in title
        order), with their counts, and how many albums need one in all."""
        with self._connect(self._database_url) as connection:
            if album_keys is None:
                keys = [str(_row_mapping(row)["album_key"]) for row in connection.execute(_SUMMARY_PAGE_SQL, {
                    "offset": max(0, int(offset)), "limit": None if limit is None else max(1, int(limit))}).fetchall()]
            else:
                keys = sorted({str(key) for key in album_keys})
            found = {row["album_key"]: row for row in map(_row_mapping, connection.execute(
                _SUMMARIES_SQL, {"album_keys": keys}).fetchall())} if keys else {}
            total = int(_row_mapping(connection.execute(_SUMMARY_COUNT_SQL).fetchone()).get("total") or 0)
        return {"items": [found[key] for key in keys if key in found], "total": total}

    def album_rows(self, *, album_key: str) -> list[dict[str, object]]:
        with self._connect(self._database_url) as connection:
            return [_row_mapping(row) for row in connection.execute(
                _ALBUM_ROWS_SQL, {"album_key": str(album_key)}).fetchall()]

    def kinds(self, *, section: str) -> list[dict[str, object]]:
        with self._connect(self._database_url) as connection:
            return [_row_mapping(row) for row in connection.execute(
                _KIND_COUNTS_SQL, {"section": section}).fetchall()]

    def kind_page(self, *, section: str, kind: str, after: tuple[str, str] | None,
                  limit: int) -> list[dict[str, object]]:
        """The next albums of one group in title order, after the (sort_title, album_key) of the
        previous page's last album."""
        after_title, after_key = after or ("", "")
        params = {"section": section, "kind": kind, "after_title": after_title, "after_key": after_key,
                  "limit": max(1, int(limit))}
        with self._connect(self._database_url) as connection:
            page = [_row_mapping(row) for row in connection.execute(_KIND_PAGE_ALBUMS_SQL, params).fetchall()]
            albums = {row["album_key"]: row for row in map(_row_mapping, connection.execute(_KIND_PAGE_SQL, {
                "section": section, "kind": kind, "album_keys": [entry["album_key"] for entry in page],
            }).fetchall())} if page else {}
        return [{**albums[key], "rows": _json(albums[key]["rows"]), "sort_title": entry["sort_title"]}
                for entry in page if (key := entry["album_key"]) in albums]

    def decide(self, *, decision: str, from_state: str, album_key: str | None, kind: str | None,
               actor_account_id: int | None, observed_at: datetime) -> int:
        if decision not in DECISIONS or (album_key is None) == (kind is None):
            raise ValueError("Name one album or one kind.")
        if kind is not None and (kind not in REVIEW_KINDS or kind in ARTIST_KINDS):
            raise ValueError("Artist changes are approved per album only.")
        params = {"decision": decision, "from_state": from_state, "account_id": actor_account_id,
                  "now": _aware_utc(observed_at),
                  **({"album_key": album_key} if album_key is not None else {"kind": kind})}
        statement = _DECIDE_ALBUM_SQL if album_key is not None else _DECIDE_KIND_SQL
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                connection.execute(_LOCK_SQL)
                result = _row_mapping(connection.execute(statement, params).fetchone())
                decided = int(result.get("decided") or 0)
                changed = self._store_derived(
                    connection, sorted(str(key) for key in result["album_keys"])) if decided else ()
        self._changed(changed)
        return decided

    def refresh(self, *, album_ids: Iterable[int] | None = None, observed_at: datetime | None = None) -> int:
        """Recompare ``album_ids``, or else every album marked as changed (a batch per
        transaction), where the signature moved. Returns how many albums were recompared."""
        now = _aware_utc(observed_at or datetime.now(timezone.utc))
        if album_ids is not None:
            ids = sorted({_positive_id(value) for value in album_ids})
            if not ids:
                return 0
            with self._connect(self._database_url) as connection:
                with _transaction(connection):
                    connection.execute(_LOCK_SQL)
                    compared, synced = self._refresh_albums(connection, ids, now)
            self._changed(synced)
            return compared
        total = after = 0
        synced: list[str] = []
        try:
            with self._connect(self._database_url) as connection:
                while True:
                    # Read in a transaction of its own, so each batch below commits by itself.
                    with _transaction(connection):
                        marks = [_row_mapping(row) for row in connection.execute(
                            _MARKS_SQL, {"after": after, "limit": REFRESH_BATCH_MARKS}).fetchall()]
                    if marks:
                        compared, changed = self._refresh_marked(connection, marks, now)
                        total += compared
                        synced.extend(changed)
                    if len(marks) < REFRESH_BATCH_MARKS:
                        return total
                    # Past this batch even where an album failed: it never holds back the albums after it.
                    after = marks[-1]["id"]
        finally:
            # Batches committed before a failure changed values too.
            self._changed(tuple(synced))

    def _refresh_marked(self, connection: Any, marks: list[dict[str, object]],
                        now: datetime) -> tuple[int, tuple[str, ...]]:
        """Refresh and clear one batch. When an album's data fails it, the batch runs album by
        album; the failing album keeps its marks for the next refresh."""
        album_ids = sorted({int(mark["album_id"]) for mark in marks})
        try:
            with _transaction(connection):
                connection.execute(_LOCK_SQL)
                compared, synced = self._refresh_albums(connection, album_ids, now)
                connection.execute(_CLEAR_MARKS_SQL, {"mark_ids": [mark["id"] for mark in marks]})
            return compared, synced
        except Exception as exc:
            if not _album_data_error(exc):
                raise
            if len(album_ids) == 1:
                _logger.warning("MusicBrainz data corrections of album %s could not be refreshed: %s.",
                                album_ids[0], _cause(exc))
                return 0, ()
        compared, synced = 0, ()
        for album_id in album_ids:
            own_compared, own_synced = self._refresh_marked(
                connection, [mark for mark in marks if int(mark["album_id"]) == album_id], now)
            compared += own_compared
            synced += own_synced
        return compared, synced

    def _refresh_albums(self, connection: Any, album_ids: list[int], now: datetime) -> tuple[int, tuple[str, ...]]:
        scope = {"album_ids": album_ids}
        keys = sorted(str(_row_mapping(row)["album_key"])
                      for row in connection.execute(_ALBUM_KEYS_SQL, scope).fetchall())
        if not keys:
            return 0, ()  # marked, then deleted: its stored results went with it
        connection.execute(_PRUNE_SQL, {"album_keys": keys})
        connection.execute(_PRUNE_ROWS_SQL, {"album_keys": keys})
        changed = {row["album_id"]: row for row in map(_row_mapping, connection.execute(
            _SIGNATURES_SQL, scope).fetchall()) if row["signature"] != row.get("stored_signature")}
        compared_albums = connection.execute(
            _COMPARE_SQL, {"album_ids": sorted(changed)}).fetchall() if changed else ()
        albums, rows = [], []
        for compared in map(_row_mapping, compared_albums):
            signed = changed[compared["album_id"]]
            result = compare_stored_album(compared)
            auto = sum(1 for row in result["rows"] if row["mode"] == "auto")
            albums.append({"library_id": signed["library_id"], "album_key": signed["album_key"],
                           "signature": signed["signature"], "release_mbid": signed["release_mbid"],
                           "correction_count": len(result["rows"]), "auto_count": auto,
                           "review_count": len(result["rows"]) - auto, "review_whole": result["review_whole"]})
            rows.extend({**row, "library_id": signed["library_id"], "album_key": signed["album_key"]}
                        for row in result["rows"])
        if albums:
            connection.execute(_STORE_SQL, {"albums": json.dumps(albums), "now": now})
        if rows:
            connection.execute(_STORE_ROWS_SQL, {"rows": json.dumps(rows)})
        # Every given album, also one whose signature held: it may have lost its match or been renamed.
        return len(changed), self._store_derived(connection, keys)

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


_logger = logging.getLogger(__name__)
_REFRESH_LOCK = threading.Lock()
# Databases whose corrections refresh in the background, and whether a refresh is due again.
_REFRESH_ENABLED: set[str] = set()
_REFRESH_RUNNING: dict[str, bool] = {}
# What invalidates search, gallery and Problematic Files caches when corrected values change.
_ON_CHANGE: dict[str, Callable[[tuple[str, ...]], None]] = {}


def _album_data_error(exc: BaseException) -> bool:
    """One album's data, not the database: a cardinality, value or constraint error (SQLSTATE
    classes 21, 22, 23), or a comparison that could not read its values."""
    state = str(getattr(exc, "sqlstate", None) or "")
    return state[:2] in {"21", "22", "23"} or isinstance(exc, (ValueError, TypeError))


def _cause(exc: BaseException) -> str:
    """The error's type and SQLSTATE; never its message, which can quote tags."""
    state = getattr(exc, "sqlstate", None)
    return f"{type(exc).__name__} ({state})" if state else type(exc).__name__


def notify_searchable_values_changed(database_url: object, album_keys: Iterable[str], *,
                                     on_change: Callable[[tuple[str, ...]], None] | None = None) -> None:
    """Drop the search, gallery and Problematic Files caches of albums whose searchable values
    changed (corrected values, S4; Latin titles, S7, 0255), with the invalidation the
    application registered for this database at startup."""
    album_keys = tuple(sorted({str(key) for key in album_keys}))
    on_change = on_change or _ON_CHANGE.get(str(database_url or "").strip())
    if album_keys and on_change is not None:
        try:
            on_change(album_keys)
        except Exception:
            _logger.warning("Caches could not be invalidated after searchable values changed.")


def enable_background_correction_refresh(database_url: object,
                                         on_change: Callable[[tuple[str, ...]], None] | None = None) -> None:
    """Let Problematic Files invalidations refresh this database's stored corrections (the
    application does this at startup while MusicBrainz enrichment runs), and refresh now.
    ``on_change`` receives the album keys whose corrected values changed."""
    url = str(database_url or "").strip()
    if url:
        with _REFRESH_LOCK:
            _REFRESH_ENABLED.add(url)
            if on_change is not None:
                _ON_CHANGE[url] = on_change
        schedule_correction_refresh(url)


def schedule_correction_refresh(database_url: object) -> None:
    """Refresh stored corrections once, in the background; requests during a refresh fold
    into one more run. Never raises."""
    url = str(database_url or "").strip()
    with _REFRESH_LOCK:
        if url not in _REFRESH_ENABLED:
            return
        if url in _REFRESH_RUNNING:
            _REFRESH_RUNNING[url] = True
            return
        _REFRESH_RUNNING[url] = False
    threading.Thread(target=_refresh_until_settled, args=(url,), daemon=True,
                     name="albumhaven-musicbrainz-corrections").start()


def _refresh_until_settled(url: str) -> None:
    while True:
        try:
            MusicBrainzCorrectionsPostgresRepository({"ALBUM_HAVEN_APP_DATABASE_URL": url}).refresh()
        except Exception as exc:
            _logger.warning("MusicBrainz data corrections could not be refreshed: %s.", _cause(exc))
        with _REFRESH_LOCK:
            if not _REFRESH_RUNNING.get(url):
                _REFRESH_RUNNING.pop(url, None)
                return
            _REFRESH_RUNNING[url] = False
