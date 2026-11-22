"""PostgreSQL authority for the owner's manual album identity (MusicBrainz Delivery 2).

"Assign artist" on "MusicBrainz: artist undecided" files one album under one of its split
name's artists; MusicBrainz Info saves through the same service. Only that album's identity is
written: never the artist's match, another album, a tag or a file. Re-checks keep a manual
identity (the matcher's writers skip it) and a vacated album's successor carries it.
"""
from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any

from music_app.services.musicbrainz_enrichment_postgres import (
    _ARTIST_ENRICHMENT_LOCK_SQL,
    MATCHER_VERSION,
    _active_library_cte,
    _aware_utc,
    _positive_id,
    _row_mapping,
    _transaction,
)
from music_app.services.musicbrainz_evidence import name_keys
from music_app.services.postgres_connections import pooled_connection


class MusicBrainzAlbumIdentityPostgresRepository:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
        queue_album_releases: Callable[..., object] | None = None,
    ) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for album identities.")
        self._connect = connect or pooled_connection
        self._queue_album_releases = queue_album_releases or self._enqueue_album_releases

    def assign_suggested_artist(self, *, album_key: str, artist_mbid: str, actor_account_id: int,
                                observed_at: datetime, request_ref: str) -> str:
        """"assigned"; "changed" when the album is decided, no longer split or never proposed
        this artist (nothing is written); "not_found" for no such album or permission."""
        observed = _aware_utc(observed_at)
        params = {
            "album_key": album_key, "artist_mbid": artist_mbid, "observed_at": observed,
            "actor_account_id": _positive_id(actor_account_id), "request_ref": request_ref,
            "matcher_version": MATCHER_VERSION,
        }
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                album = _row_mapping(connection.execute(_ALBUM_ARTIST_SQL, params).fetchone())
                if not album.get("local_artist_id"):
                    return "not_found"
                # The re-check's writers take this lock too, so neither overtakes the other.
                connection.execute(_ARTIST_ENRICHMENT_LOCK_SQL, album)
                target = _row_mapping(connection.execute(_TARGET_SQL, {**params, **album}).fetchone())
                if not target:
                    return "not_found"
                if target["decided"] or target["match_state"] != "per_album" or not target["canonical_name"]:
                    return "changed"
                write = {
                    **params,
                    "library_id": target["library_id"],
                    "local_artist_id": target["local_artist_id"],
                    "tag_differs": not (name_keys(target["local_artist_name"]) & name_keys(target["canonical_name"])),
                }
                if not connection.execute(_INSERT_IDENTITY_SQL, write).fetchone():
                    return "changed"
                connection.execute(_DELETE_OTHER_RELEASE_SQL, write)
                connection.execute(_DELETE_SUGGESTIONS_SQL, write)
                connection.execute(_AUDIT_SQL, write)
        try:
            self._queue_album_releases(local_artist_id=int(target["local_artist_id"]), observed_at=observed)
        except Exception:
            # The choice is committed; the next sync compares the album's releases.
            logging.getLogger(__name__).warning("The assigned album's release lookup could not be queued.")
        return "assigned"

    def _enqueue_album_releases(self, *, local_artist_id: int, observed_at: datetime) -> None:
        from music_app.services.musicbrainz_release_identity_postgres import (
            MusicBrainzReleaseIdentityPostgresRepository,
        )

        MusicBrainzReleaseIdentityPostgresRepository(
            {"ALBUM_HAVEN_APP_DATABASE_URL": self._database_url}, connect=self._connect,
        ).enqueue(reason="album_artist_assigned", local_artist_id=local_artist_id, observed_at=observed_at)


# The album's artist, to lock before anything is decided.
_ALBUM_ARTIST_SQL = _active_library_cte() + """
    select albums.artist_id as local_artist_id
    from active_library
    join library.local_albums albums
      on albums.library_id = active_library.library_id and albums.album_key = %(album_key)s;
"""

_TARGET_SQL = _active_library_cte() + """
    select albums.library_id, albums.album_key, albums.artist_id as local_artist_id,
           artists.name as local_artist_name, matches.state as match_state,
           exists (
             select 1 from library.local_album_artist_identities identities
             where identities.library_id = albums.library_id and identities.album_key = albums.album_key
           ) as decided,
           (select remote.canonical_name
            from library.local_album_artist_suggestions suggestions
            join integration.musicbrainz_artists remote on remote.mbid = suggestions.artist_mbid
            where suggestions.library_id = albums.library_id and suggestions.album_key = albums.album_key
              and suggestions.artist_mbid = %(artist_mbid)s::uuid) as canonical_name
    from active_library
    join library.local_albums albums
      on albums.library_id = active_library.library_id and albums.album_key = %(album_key)s
     and albums.artist_id = %(local_artist_id)s
    left join library.local_artists artists
      on artists.library_id = albums.library_id and artists.id = albums.artist_id
    left join library.local_artist_musicbrainz_matches matches
      on matches.library_id = albums.library_id and matches.local_artist_id = albums.artist_id
    join app.accounts actor
      on actor.id = %(actor_account_id)s and actor.is_active is true and actor.disabled_at is null
    where (
      exists (
        select 1 from app.bootstrap_owners bootstrap
        where bootstrap.account_id = actor.id and bootstrap.owner_key = 'local-bootstrap-owner')
      or exists (
        select 1 from app.capabilities capability
        where capability.account_id = actor.id
          and capability.capability_key = 'library.metadata_matches.review'
          and capability.scope_kind = 'library' and capability.scope_id = albums.library_id)
    )
    for update of albums;
"""

_INSERT_IDENTITY_SQL = """
    insert into library.local_album_artist_identities (
      library_id, album_key, artist_mbid, decision_source, evidence, tag_differs, matcher_version,
      created_at, updated_at
    )
    values (%(library_id)s, %(album_key)s, %(artist_mbid)s::uuid, 'manual',
            jsonb_build_object('method', 'owner'), %(tag_differs)s, %(matcher_version)s,
            %(observed_at)s, %(observed_at)s)
    on conflict (library_id, album_key) do nothing
    returning album_key;
"""

# An automatic release of another artist no longer holds; a manual one is kept.
_DELETE_OTHER_RELEASE_SQL = """
    delete from library.local_album_musicbrainz_releases
    where library_id = %(library_id)s and album_key = %(album_key)s
      and decision_source = 'automatic' and artist_mbid is distinct from %(artist_mbid)s::uuid;
"""

_DELETE_SUGGESTIONS_SQL = """
    delete from library.local_album_artist_suggestions
    where library_id = %(library_id)s and album_key = %(album_key)s;
"""

_AUDIT_SQL = """
    insert into app.security_audit_events (
      actor_account_id, target_account_id, event_category, outcome, reason_code, request_ref,
      occurred_at, metadata
    )
    values (%(actor_account_id)s, %(actor_account_id)s, 'library_metadata_match', 'success',
            'musicbrainz_album_artist_manual_assignment', %(request_ref)s, %(observed_at)s,
            jsonb_build_object('album_key', %(album_key)s::text, 'artist_mbid', %(artist_mbid)s::text));
"""
