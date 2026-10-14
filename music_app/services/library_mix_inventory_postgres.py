"""Complete same-library cached Mix inventory; provider I/O is never a read side effect."""
from datetime import timezone

from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services.library_mix import LibraryMixCandidate
from music_app.services.library_mix_postgres import LibraryMixSnapshot
from music_app.services.musicbrainz_tags import canonical_mbid
from music_app.services.owned_playlists import evidence_digest
from music_app.services.popularity_snapshots import (
    CachedPopularity, LocalTrackEvidence, PopularityObservation, validate_observation,
)


_FACTS = """
 select inventory.*, t.mbid::text as recording_mbid,
   t.mbid_assertion_state as recording_state, t.evidence_source as recording_source,
   ar.mbid::text as artist_mbid, ar.mbid_assertion_state as artist_state,
   ar.evidence_source as artist_source,
   aa.mbid::text as album_artist_mbid, aa.mbid_assertion_state as album_artist_state,
   aa.evidence_source as album_artist_source,
   coalesce(a.metadata->'is_compilation', 'false'::jsonb) as is_compilation,
   coalesce((select jsonb_agg(jsonb_build_object(
     'recording', f.metadata#>'{scan_cache,file_entry,musicbrainz_recording_id}',
     'artists', f.metadata#>'{scan_cache,file_entry,musicbrainz_artist_ids}',
     'album_artists', f.metadata#>'{scan_cache,file_entry,musicbrainz_album_artist_ids}',
     'conflict', f.metadata#>'{scan_cache,file_entry,musicbrainz_identity_conflict}') order by f.id)
     from library.local_track_files f
     join library.library_roots r on r.id=f.library_root_id and r.library_id=t.library_id
     where f.track_id=t.id and f.scan_cache_stale is false and r.is_active is true),
     '[]'::jsonb) as file_tags,
   s.current_revision::text as mapping_revision, s.checked_inventory_revision,
   s.retry_after, s.last_result, s.last_attempt_at,
   m.inventory_revision as mapped_inventory_revision,
   m.recording_mbid::text as mapped_recording_mbid,
   m.artist_mbid::text as mapped_artist_mbid, m.source_entity_id,
   o.source_revision, o.observed_at, o.imported_at, o.count, o.attribution_state
 from inventory
 join library.local_tracks t on t.id=inventory.original_local_track_id
 left join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
 left join library.local_artists ar on ar.id=t.artist_id and ar.library_id=t.library_id
 left join library.local_artists aa on aa.id=a.artist_id and aa.library_id=t.library_id
 left join library.track_popularity_mapping_slots s on s.track_id=t.id
 left join library.track_popularity_mapping_versions m
   on m.track_id=t.id and m.revision=s.current_revision
 left join catalog.popularity_source_slots p on p.provider='lastfm'
   and p.metric='overall_scrobbles' and p.source_entity_id=m.source_entity_id
 left join catalog.popularity_source_observations o on o.provider=p.provider
   and o.metric=p.metric and o.source_entity_id=p.source_entity_id
   and o.source_revision=p.current_revision
 order by t.id
"""


def read_inventory(connection, library_id, *, track_ids=None, lock=False):
    if type(library_id) is not int or library_id < 1 or connection.autocommit:
        raise ValueError("Mix inventory requires a current library transaction")
    if lock:
        if track_ids is None:
            track_ids = [row["id"] for row in connection.execute(
                "select id from library.local_tracks where library_id=%s order by id",
                (library_id,)).fetchall()]
        sources.inventory_rows(connection, library_id, track_ids, lock=True)
        connection.execute("""select id from library.local_artists where library_id=%s
            and id in (select a.artist_id from library.local_albums a
              join library.local_tracks t on t.album_id=a.id and t.library_id=a.library_id
              where t.library_id=%s and t.id=any(%s::bigint[])) order by id for share""",
            (library_id, library_id, track_ids)).fetchall()
    clause = " where t.library_id=%s"
    params = (library_id,)
    if track_ids is not None:
        clause += " and t.id=any(%s::bigint[])"
        params += (track_ids,)
    return connection.execute("with inventory as (" + sources._INVENTORY + clause
                              + ")" + _FACTS, params).fetchall()


def _single(values):
    normalized = {canonical_mbid(value) for value in values if value is not None}
    if None in normalized or len(normalized) > 1:
        return None, True
    return next(iter(normalized), None), False


def _artist(row, prefix, tag_field):
    values = [row[prefix + "mbid"]] if (row[prefix + "state"] == "asserted"
        and row[prefix + "source"]) else []
    for tags in row["file_tags"]:
        identities = tags.get(tag_field)
        if identities:
            if not isinstance(identities, list) or len(identities) != 1:
                return None
            values.extend(identities)
    value, conflict = _single(values)
    return None if conflict else value


def local_identity(row):
    """A recording tag is only a lookup key until the provider echoes it exactly."""
    if row["recording_state"] in ("conflicting", "ambiguous") or any(
            tags.get("conflict") is True for tags in row["file_tags"]):
        return None, None, "ambiguous_attribution"
    values = [row["recording_mbid"]] if (row["recording_state"] == "asserted"
        and row["recording_source"]) else []
    values.extend(tags.get("recording") for tags in row["file_tags"])
    recording, conflict = _single(values)
    if conflict:
        return None, None, "ambiguous_attribution"
    if recording is None:
        return None, None, "missing_recording_identity"
    return recording, _artist(row, "artist_", "artists"), None


def inventory_revision(row):
    return evidence_digest({key: row[key] for key in (
        "original_local_track_id", "inventory_evidence", "title", "artist",
        "original_album_id", "recording_mbid", "recording_state", "recording_source",
        "artist_mbid", "artist_state", "artist_source", "album_artist_mbid",
        "album_artist_state", "album_artist_source",
        "is_compilation", "file_tags")})


def read_snapshot(connection, live_context, *, is_readable):
    """Admit real IDs before metadata, cache validation or group composition."""
    library_id = live_context.library_id
    if type(library_id) is not int or library_id < 1 or connection.autocommit or not callable(is_readable):
        raise ValueError("Mix inventory requires current-library admission")
    identities = connection.execute(
        "select id from library.local_tracks where library_id=%s order by id",
        (library_id,)).fetchall()
    admitted = [row["id"] for row in identities if is_readable(row["id"]) is True]
    rows = read_inventory(connection, library_id, track_ids=admitted, lock=True) if admitted else []
    candidates, snapshots, diagnostics = [], {}, []
    album_artists = {}
    for row in rows:
        if row["availability"] == "local" and row["original_album_id"] is not None:
            value = _artist(row, "album_artist_", "album_artists")
            album_artists.setdefault(row["original_album_id"], set()).add(value)
    for row in rows:
        if row["availability"] != "local":
            continue
        track_id = row["original_local_track_id"]
        recording, artist, reason = local_identity(row)
        if reason is None and (not row["mapping_revision"]
                or row["mapped_inventory_revision"] != inventory_revision(row)
                or row["mapped_recording_mbid"] != recording):
            reason = (row["last_result"] if row["checked_inventory_revision"] == inventory_revision(row)
                      and row["last_result"] in ("ambiguous_attribution", "provider_unavailable")
                      else "missing_provider_mapping")
        if reason:
            diagnostics.append((track_id, reason))
            continue
        album_id = row["original_album_id"]
        credits = album_artists.get(album_id, set())
        primary = row["mapped_artist_mbid"] if row["is_compilation"] is True or album_id is None else (
            next(iter(credits)) if len(credits) == 1 else None)
        track = LocalTrackEvidence(track_id, row["mapping_revision"], "lastfm",
            row["source_entity_id"], recording, "lastfm.track.getInfo.mbid",
            row["mapped_artist_mbid"], "lastfm.track.getInfo.artist.mbid"
            if row["mapped_artist_mbid"] else None)
        candidates.append(LibraryMixCandidate(track,
            f"inventory-album:{library_id}:{album_id}" if album_id is not None else None,
            f"musicbrainz-artist:{primary}" if primary else None,
            album_id if album_id is not None else 2**63 - 1,
            row["disc_number"], row["track_number"]))
        if row["source_revision"] is not None:
            if any(value.utcoffset() is None for value in (row["observed_at"], row["imported_at"])):
                raise ValueError("Popularity timestamps must be timezone-aware")
            observation = PopularityObservation("lastfm", "overall_scrobbles",
                row["source_entity_id"], row["source_revision"],
                row["observed_at"].astimezone(timezone.utc),
                row["imported_at"].astimezone(timezone.utc), row["count"], row["attribution_state"])
            validate_observation(observation)
            snapshots[track_id] = CachedPopularity(track_id, row["mapping_revision"], observation)
    from music_app.services.library_popularity_jobs import read_job
    job = read_job(connection, library_id)
    return LibraryMixSnapshot(library_id, tuple(candidates), snapshots, tuple(diagnostics),
                              refresh_status=job["status"] if job else "idle")
