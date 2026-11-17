"""PostgreSQL authority for MusicBrainz data corrections (Delivery 2, S4; owner 2026-11-16,
"Data Correction flow").

Each certainly matched album is compared with its edition (the release decision) in Python
(musicbrainz_correction_kinds) and every difference is stored as a row with its kind and mode:
trivial kinds apply automatically, the rest wait for the owner. A tag signature makes a refresh
recompare only albums that changed; refreshes run when a release decision is recorded and in
the background after Problematic Files is invalidated (tag edits, rescans, watcher). The
owner's undo, skip and approval decisions are kept by the exact change, so a refresh never
reapplies an undone change. "Applied" is display only until PR 53 writes tags; nothing here
writes media tags.
"""
from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timezone
from typing import Any

from music_app.services.musicbrainz_correction_kinds import ARTIST_KINDS, REVIEW_KINDS, compare_album
from music_app.services.musicbrainz_enrichment_postgres import (
    _active_library_cte,
    _aware_utc,
    _connect,
    _positive_id,
    _row_mapping,
    _transaction,
)
from music_app.services.musicbrainz_release_identity import credit_text
from music_app.services.musicbrainz_release_identity_postgres import parse_track_pairing

# The review group of albums the guard (or an ambiguous pairing) sends to review whole.
WHOLE_ALBUM_GROUP = "whole_album"
DECISIONS = frozenset({"undone", "skipped", "approved"})

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

# Each certainly matched album's signature: everything a comparison reads.
_SIGNATURES_SQL = _active_library_cte() + """
    select albums.id as album_id, albums.library_id, albums.album_key, decision.release_mbid::text,
           md5(concat_ws(E'\\x1f', decision.release_mbid, releases.refreshed_at, decision.disc_position,
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
    where %(album_ids)s::bigint[] is null or albums.id = any(%(album_ids)s::bigint[]);
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

# Stored results whose album is no longer certainly matched (within the refreshed albums).
_PRUNE_SQL = _active_library_cte() + """
    delete from library.local_album_musicbrainz_corrections stored
    using active_library, library.local_albums albums
    where stored.library_id = active_library.library_id
      and albums.library_id = stored.library_id and albums.album_key = stored.album_key
      and (%(album_ids)s::bigint[] is null or albums.id = any(%(album_ids)s::bigint[]))
      and not exists (select 1 from library.local_album_musicbrainz_releases decision
                      where decision.library_id = stored.library_id and decision.album_key = stored.album_key
                        and decision.state = 'release')
    returning stored.album_key;
"""
_PRUNE_ROWS_SQL = """
    delete from library.local_album_musicbrainz_correction_rows correction
    where not exists (select 1 from library.local_album_musicbrainz_corrections stored
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

# Problematic Files reads only these: no comparison runs when it opens.
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
      and (%(album_keys)s::text[] is null or stored.album_key = any(%(album_keys)s::text[]))
    order by lower(albums.title), stored.album_key
    offset %(offset)s limit %(limit)s;
"""
_SUMMARY_COUNT_SQL = _active_library_cte() + """
    select count(*)::integer as total
    from library.local_album_musicbrainz_corrections stored
    join active_library on active_library.library_id = stored.library_id
    where stored.correction_count > 0;
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

# The Edits Queue: "applied" (the automatic history) or "review" (waiting), by kind, then a
# page of albums with their rows. Albums sent to review whole form their own group. A page
# reads only its kind's rows (%(kind)s is null for the counts). A row has at most one decision
# (its primary key is _DECISION_MATCH), so one join gives _STATE_SQL's state without three
# probes per row.
_GROUP_SQL = _active_library_cte() + f"""
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
      where %(kind)s::text is null
         or (case when %(section)s = 'review' and stored.review_whole then '{WHOLE_ALBUM_GROUP}'
                  else correction.kind end) = %(kind)s::text
    ), listed as (
      select case when %(section)s = 'review' and review_whole then '{WHOLE_ALBUM_GROUP}' else kind end as grouping,
             rows.*
      from rows
      where (%(section)s = 'applied' and state in ('applied', 'undone') and (mode = 'auto' or state = 'applied'))
         or (%(section)s = 'review' and state = 'pending')
    )
"""
_KIND_COUNTS_SQL = _GROUP_SQL + """
    select grouping as kind, count(distinct album_key)::integer as albums, count(*)::integer as rows
    from listed group by grouping order by grouping;
"""
_KIND_PAGE_SQL = _GROUP_SQL + """
    , albums as (
      select distinct listed.library_id, listed.album_key, lower(local.title) as sort_title
      from listed
      join library.local_albums local on local.library_id = listed.library_id and local.album_key = listed.album_key
      where listed.grouping = %(kind)s
      order by sort_title, listed.album_key offset %(offset)s limit %(limit)s
    )
    select albums.album_key, local.title as album_title, artists.name as artist_name, local.release_year as year,
           local.cover_path,
           json_agg(json_build_object('field', listed.field, 'disc_number', listed.disc_number,
                                      'track_number', listed.track_number, 'current_value', listed.current_value,
                                      'proposed_value', listed.proposed_value, 'kind', listed.kind,
                                      'state', listed.state)
                    order by listed.disc_number, listed.track_number, listed.field) as rows
    from albums
    join listed on listed.library_id = albums.library_id and listed.album_key = albums.album_key
               and listed.grouping = %(kind)s
    join library.local_albums local on local.library_id = albums.library_id and local.album_key = albums.album_key
    left join library.local_artists artists on artists.id = local.artist_id
    group by albums.album_key, albums.sort_title, local.title, artists.name, local.release_year, local.cover_path
    order by albums.sort_title, albums.album_key;
"""

# Record one decision for the chosen rows: an album's applied automatic rows (undone), or its
# waiting rows (approved, skipped), or every waiting row of one kind outside whole-album review.
_DECIDE_SQL = _active_library_cte() + f"""
    , chosen as (
      select correction.library_id, correction.album_key, correction.field, correction.disc_number,
             correction.track_number, correction.current_value, correction.proposed_value
      from library.local_album_musicbrainz_correction_rows correction
      join active_library on active_library.library_id = correction.library_id
      join library.local_album_musicbrainz_corrections stored
        on stored.library_id = correction.library_id and stored.album_key = correction.album_key
      where (%(album_key)s::text is null or correction.album_key = %(album_key)s::text)
        and (%(kind)s::text is null or (correction.kind = %(kind)s::text and not stored.review_whole))
        and ({_STATE_SQL}) = %(from_state)s
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
      returning 1
    )
    select count(*)::integer as decided from decided;
"""

# Write the applied values beside the tag-derived ones (local_albums.corrected_title and
# corrected_album_artist, local_tracks.corrected_title and corrected_artist) for the given
# albums, or all; null where nothing is applied. Returns the albums whose values changed.
_SYNC_SQL = _active_library_cte() + f"""
    , scope as (
      select albums.id, albums.library_id, albums.album_key
      from library.local_albums albums
      join active_library on active_library.library_id = albums.library_id
      where %(album_keys)s::text[] is null or albums.album_key = any(%(album_keys)s::text[])
    ), applied as (
      select correction.album_key, correction.field, correction.disc_number, correction.track_number,
             correction.proposed_value
      from library.local_album_musicbrainz_correction_rows correction
      join scope on scope.library_id = correction.library_id and scope.album_key = correction.album_key
      where ({_STATE_SQL}) = 'applied'
    ), album_values as (
      select scope.id,
             (select proposed_value from applied where applied.album_key = scope.album_key
                and applied.field = 'album') as title,
             (select proposed_value from applied where applied.album_key = scope.album_key
                and applied.field = 'album_artist') as album_artist
      from scope
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
             (select proposed_value from applied where applied.album_key = scope.album_key and applied.field = 'title'
                and applied.disc_number = coalesce(nullif(tracks.disc_number, 0), 1)
                and applied.track_number = tracks.track_number) as title,
             (select proposed_value from applied where applied.album_key = scope.album_key and applied.field = 'artist'
                and applied.disc_number = coalesce(nullif(tracks.disc_number, 0), 1)
                and applied.track_number = tracks.track_number) as artist
      from scope
      join library.local_tracks tracks on tracks.album_id = scope.id
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
        "release_credit": credit_text(_json(row.get("artist_credit")) or []) or None,
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

    def _sync(self, connection: Any, album_keys: Iterable[str] | None) -> tuple[str, ...]:
        params = {"album_keys": None if album_keys is None else sorted({str(key) for key in album_keys})}
        if params["album_keys"] == []:
            return ()
        return tuple(sorted(str(_row_mapping(row)["album_key"]) for row in connection.execute(
            _SYNC_SQL, params).fetchall()))

    def _changed(self, album_keys: tuple[str, ...]) -> None:
        """Search, gallery and Problematic Files caches follow the changed corrected values."""
        on_change = self._on_change or _ON_CHANGE.get(self._database_url)
        if album_keys and on_change is not None:
            try:
                on_change(album_keys)
            except Exception:
                _logger.warning("Caches could not be invalidated after a data correction changed.")

    def list_summaries(self, *, album_keys: Iterable[str] | None = None, offset: int = 0,
                       limit: int | None = None) -> dict[str, object]:
        """The stored albums needing a correction (those of ``album_keys``, or a page in title
        order), with their counts, and how many albums need one in all."""
        params = {"album_keys": None if album_keys is None else sorted({str(key) for key in album_keys}),
                  "offset": max(0, int(offset)), "limit": None if limit is None else max(1, int(limit))}
        with self._connect(self._database_url) as connection:
            rows = [] if params["album_keys"] == [] else [
                _row_mapping(row) for row in connection.execute(_SUMMARIES_SQL, params).fetchall()]
            total = int(_row_mapping(connection.execute(_SUMMARY_COUNT_SQL).fetchone()).get("total") or 0)
        return {"items": rows, "total": total}

    def album_rows(self, *, album_key: str) -> list[dict[str, object]]:
        with self._connect(self._database_url) as connection:
            return [_row_mapping(row) for row in connection.execute(
                _ALBUM_ROWS_SQL, {"album_key": str(album_key)}).fetchall()]

    def kinds(self, *, section: str) -> list[dict[str, object]]:
        with self._connect(self._database_url) as connection:
            return [_row_mapping(row) for row in connection.execute(
                _KIND_COUNTS_SQL, {"section": section, "kind": None}).fetchall()]

    def kind_page(self, *, section: str, kind: str, offset: int, limit: int) -> list[dict[str, object]]:
        params = {"section": section, "kind": kind, "offset": max(0, int(offset)), "limit": max(1, int(limit))}
        with self._connect(self._database_url) as connection:
            rows = [_row_mapping(row) for row in connection.execute(_KIND_PAGE_SQL, params).fetchall()]
        for row in rows:
            row["rows"] = _json(row["rows"])
        return rows

    def decide(self, *, decision: str, from_state: str, album_key: str | None, kind: str | None,
               actor_account_id: int | None, observed_at: datetime) -> int:
        if decision not in DECISIONS or (album_key is None) == (kind is None):
            raise ValueError("Name one album or one kind.")
        if kind is not None and (kind not in REVIEW_KINDS or kind in ARTIST_KINDS):
            raise ValueError("Artist changes are approved per album only.")
        params = {"decision": decision, "from_state": from_state, "album_key": album_key, "kind": kind,
                  "account_id": actor_account_id, "now": _aware_utc(observed_at)}
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                decided = int(_row_mapping(connection.execute(_DECIDE_SQL, params).fetchone()).get("decided") or 0)
                changed = self._sync(connection, [album_key] if album_key is not None else None) if decided else ()
        self._changed(changed)
        return decided

    def refresh(self, *, album_ids: Iterable[int] | None = None, observed_at: datetime | None = None) -> int:
        """Recompare the albums (all, or ``album_ids``) whose signature moved and store their
        classified rows. Returns how many albums were recompared."""
        params = {"album_ids": None if album_ids is None else sorted({_positive_id(value) for value in album_ids})}
        if params["album_ids"] == []:
            return 0
        now = _aware_utc(observed_at or datetime.now(timezone.utc))
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                pruned = [str(_row_mapping(row)["album_key"]) for row in connection.execute(_PRUNE_SQL, params).fetchall()]
                connection.execute(_PRUNE_ROWS_SQL)
                changed = {row["album_id"]: row for row in map(_row_mapping, connection.execute(
                    _SIGNATURES_SQL, params).fetchall()) if row["signature"] != row.get("stored_signature")}
                albums, rows = [], []
                for compared in map(_row_mapping, connection.execute(
                        _COMPARE_SQL, {"album_ids": sorted(changed)}).fetchall()):
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
                synced = self._sync(connection, [*pruned, *(album["album_key"] for album in albums)])
        self._changed(synced)
        return len(changed)

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
        except Exception:
            _logger.warning("MusicBrainz data corrections could not be refreshed.")
        with _REFRESH_LOCK:
            if not _REFRESH_RUNNING.get(url):
                _REFRESH_RUNNING.pop(url, None)
                return
            _REFRESH_RUNNING[url] = False
