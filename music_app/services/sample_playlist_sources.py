"""Transaction-bound Playlist membership for future Sample evaluation.

This internal foundation is not a preview receipt, browser DTO or authority
token. It performs no persistence, provider I/O, recipe choice or selection.
Consumers must finish evaluation/persistence inside the context and may not
reuse the returned facts as authorization on a later request.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal
from math import isfinite

from music_app.services import library_mix_inventory_postgres as inventory
from music_app.services import playlist_creation_sources_postgres as sources
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.musicbrainz_tags import canonical_mbid
from music_app.services.owned_playlists import (
    BROWSE, CREATE, MAX_PLAYLIST_ITEMS_PER_COMMAND, PlaylistError,
    evidence_digest, playlist_revision, uuid_ref,
)
from music_app.services.policy import ResourceScope
from music_app.services.sample_playlist import SampleCandidate


@dataclass(frozen=True, slots=True)
class PlaylistSampleSnapshot:
    playlist_ref: str
    revision: str
    library_id: int
    account_id: int
    session_id: int
    membership_digest: str
    candidates: tuple[SampleCandidate, ...]
    diagnostics: tuple[tuple[int, str], ...]
    inventory_digests: tuple[tuple[int, str], ...]


@dataclass(frozen=True, slots=True)
class _OriginSampleSnapshot(PlaylistSampleSnapshot):
    origin_proof: dict


def _asserted_identity(row, prefix, reconciled):
    source = row[prefix + "source"]
    return (reconciled is not None and row[prefix + "state"] == "asserted"
            and isinstance(source, str) and bool(source.strip())
            and canonical_mbid(row[prefix + "mbid"]) == reconciled)


def _resolved_identity(row, track, *, random):
    recording = track.canonical_recording_id if track is not None else None
    evidence = track.recording_evidence if track is not None else None
    artist = track.canonical_artist_id if track is not None else None
    if track is None or random and artist is None:
        local_recording, local_artist, reason = inventory.local_identity(row)
        if reason is None:
            if recording is None and _asserted_identity(row, "recording_", local_recording):
                recording, evidence = local_recording, row["recording_source"]
            if random and artist is None and _asserted_identity(row, "artist_", local_artist):
                artist = local_artist
    return recording, evidence, artist


def _duration(value):
    if type(value) is Decimal:
        finite = value.is_finite()
    elif type(value) in (int, float):
        finite = type(value) is int or isfinite(value)
    else:
        return None
    return value if finite and value >= 0 else None


def _members(connection, playlist_ref):
    # This is the existing complete-command resource bound, not a Sample quota
    # default/range. Refuse truncation rather than sample a silent prefix.
    rows = connection.execute("""select ref,position,local_track_id,original_local_track_id
        from app.playlist_items where playlist_ref=%s order by position,ref
        limit %s""", (playlist_ref, MAX_PLAYLIST_ITEMS_PER_COMMAND + 1)).fetchall()
    if not rows:
        raise PlaylistError("playlist_empty", 409)
    if len(rows) > MAX_PLAYLIST_ITEMS_PER_COMMAND:
        raise PlaylistError("source_too_large", 413)
    return tuple((str(row["ref"]), row["position"], row["local_track_id"],
                  row["original_local_track_id"]) for row in rows)


@dataclass(frozen=True, slots=True)
class _SampleIdentityEvidence:
    track_id: int
    mapping: object
    asserted_recording: tuple[str, str] | None
    asserted_track_artist: tuple[str, str] | None


@contextmanager
def playlist_sample_snapshot(owner, context, *, playlist_ref, revision,
                             selection_method="most_listened", constraints=None):
    """Public source API: unchanged transaction-bound snapshot and final fences."""
    if selection_method not in ("most_listened", "random"):
        raise ValueError("Invalid Sample selection method")
    playlist_ref, revision = uuid_ref(playlist_ref), playlist_revision(revision)
    with owner._authorized(context, constraints) as (connection, live, _now):
        with _playlist_sample_snapshot(owner, connection, live,
                playlist_ref=playlist_ref, revision=revision,
                selection_method=selection_method, constraints=constraints) as captured:
            yield captured[0]


def _candidate_facts(rows, positions, readable, library_id, *, most_listened, include_observations):
    """The shared inventory-to-evaluator preparation, independent of origin."""
    candidates, diagnostics, admitted_resources = [], [], []
    local_rows, facts, track_artists, digests = [], {}, {}, {}
    identity_evidence = {}
    for row in rows:
        track_id, album_id = row["original_local_track_id"], row["original_album_id"]
        if not readable("track", track_id) or (album_id is not None and not readable("album", album_id)):
            continue
        admitted_resources.append((track_id, album_id))
        if row["availability"] != "local":
            continue
        local_rows.append(row)
        if most_listened and include_observations:
            track, popularity, reason = inventory.normalize_cached_inventory_row(row)
        else:
            track, reason = inventory.normalize_cached_track_identity(row)
            popularity = None
        recording, evidence, artist = _resolved_identity(row, track, random=not most_listened)
        identity_evidence[track_id] = _SampleIdentityEvidence(
            track_id, track,
            (recording, row["recording_source"]) if recording is not None and
                (track is None or track.canonical_recording_id is None) else None,
            (artist, row["artist_source"]) if not most_listened and artist is not None and
                (track is None or track.canonical_artist_id is None) else None)
        if most_listened and reason is not None:
            diagnostics.append((track_id, reason))
        elif not most_listened and recording is None:
            diagnostics.append((track_id, "missing_canonical_recording"))
        facts[track_id] = (recording, evidence, track if most_listened else None, popularity)
        track_artists[track_id] = artist
        digests[track_id] = sources.entry_evidence(sources._plain(row))
    groups = inventory.primary_artist_refs(local_rows, track_artist_ids=track_artists)
    for row in local_rows:
        track_id, album_id = row["original_local_track_id"], row["original_album_id"]
        recording, evidence, track, popularity = facts[track_id]
        candidates.append(SampleCandidate(track_id, recording, evidence,
            f"inventory-album:{library_id}:{album_id}" if album_id is not None else None,
            groups[track_id], positions[track_id], row["disc_number"], row["track_number"],
            _duration(row["duration_seconds"]), None, None, track, popularity))
    candidates.sort(key=lambda item: (item.source_position, item.track_id))
    return candidates, diagnostics, admitted_resources, digests, identity_evidence


def _finish_facets(owner, live, state, constraints):
    if state.get("artists"):
        from music_app.services.sample_playlist_facets import _artist_fences
        _artist_fences(owner, live, state, constraints)


def _facet_preflight(connection, library_id, ids):
    from music_app.services.sample_playlist_facets import physical_preflight
    physical_preflight(connection, library_id, ids)


def _project_facets(owner, connection, live, rows, candidates, diagnostics,
                    fields, constraints, state, discovery):
    if not fields:
        return candidates
    admitted_ids = {candidate.track_id for candidate in candidates}
    rows = [row for row in rows if row["original_local_track_id"] in admitted_ids]
    from music_app.services.sample_playlist_facets import project
    state = state if state is not None else {}
    # Use the existing method-specific identity owner, not a display-text guess.
    state["track_artist_ids"] = {}
    for row in rows:
        track, _reason = inventory.normalize_cached_track_identity(row)
        _recording, _evidence, artist = _resolved_identity(row, track,
            random=state.get("selection_method") == "random")
        state["track_artist_ids"][row["original_local_track_id"]] = artist
    # The candidates already carry the correct resolved grouping identities.
    # For track-basis candidates, pass that exact identity to the shared helper.
    by_id = {row["original_local_track_id"]: row for row in rows}
    for candidate in candidates:
        row = by_id[candidate.track_id]
        if row["is_compilation"] is True or row["original_album_id"] is None:
            state["track_artist_ids"][candidate.track_id] = (candidate.primary_artist_ref.split(":", 1)[1]
                if candidate.primary_artist_ref else None)
    return project(owner, connection, live, rows, candidates, diagnostics, fields,
        constraints, state, discovery=discovery)


def _prepare_sample_snapshot(owner, connection, live, *, playlist_ref, revision,
                              selection_method, constraints=None, include_observations=True,
                              facet_fields=(), facet_state=None, facet_discovery=False):
    """Same-transaction receipt composition; observations are historical on read.

    Observation-free validation preserves the original method's identity/group
    semantics. In particular Most listened never acquires Random's artist fallback.
    The extra immutable evidence is private; the public snapshot DTO is unchanged.
    """
    if selection_method not in ("most_listened", "random") or type(include_observations) is not bool:
        raise ValueError("Invalid Sample source mode")
    most_listened = selection_method == "most_listened"
    facet_state = facet_state if facet_state is not None else {}
    playlist_ref, revision = uuid_ref(playlist_ref), playlist_revision(revision)
    def parent():
        value = owner._playlist(connection, live, playlist_ref)
        owner._require(live, (BROWSE,), constraints, value)
        owner._require(live, (BROWSE, CREATE), constraints)
        if str(value["revision"]) != revision:
            raise PlaylistError("revision_conflict", 409)

    def readable(kind, identity):
        return owner._resource_allowed(live, BROWSE,
            ResourceScope(kind, str(identity)), constraints) is True

    parent()
    members = _members(connection, playlist_ref)
    positions = {}
    for _ref, position, track_id, _original in members:
        if track_id is not None:
            positions.setdefault(track_id, position)
    # Only identity columns are read before per-resource admission.
    identities = connection.execute("""select id,album_id from library.local_tracks
        where library_id=%s and id=any(%s::bigint[]) order by id""",
        (live.library_id, list(positions))).fetchall() if positions else []
    admitted = [row["id"] for row in identities if readable("track", row["id"])
                and (row["album_id"] is None or readable("album", row["album_id"]))]
    rows = inventory.read_inventory(connection, live.library_id,
        track_ids=admitted, lock=True, include_popularity=most_listened and include_observations,
        **({"preflight": _facet_preflight} if facet_fields else {})) if admitted else []
    # A concurrent identity deletion/remap can finish while inventory locks
    # are acquired. Lock and compare exact membership after those waits.
    connection.execute("""select ref from app.playlist_items where playlist_ref=%s
        order by position,ref for share""", (playlist_ref,)).fetchall()
    if _members(connection, playlist_ref) != members:
        raise PlaylistError("source_changed", 409)
    candidates, diagnostics, admitted_resources, digests, identity_evidence = _candidate_facts(
        rows, positions, readable, live.library_id, most_listened=most_listened,
        include_observations=include_observations)
    candidates = _project_facets(owner, connection, live, rows, candidates, diagnostics,
        facet_fields, constraints, facet_state, facet_discovery)
    parent()
    lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
        actor_session_id=live.actor.session_id, clock=owner._clock)
    snapshot = PlaylistSampleSnapshot(playlist_ref, revision, live.library_id,
        live.actor.account_id, live.actor.session_id, evidence_digest(members),
        tuple(candidates), tuple(sorted(diagnostics)),
        tuple((item.track_id, digests[item.track_id]) for item in candidates))
    def finish():
        _finish_facets(owner, live, facet_state, constraints)
        # Consumers cannot turn an earlier admission into a later write grant.
        # Account/library/grant locks remain held; session expiry needs a fresh
        # clock after time spent acquiring locks and evaluating the source.
        parent()
        if _members(connection, playlist_ref) != members:
            raise PlaylistError("source_changed", 409)
        if any(not readable("track", track_id) or
               (album_id is not None and not readable("album", album_id))
               for track_id, album_id in admitted_resources):
            raise PlaylistError("source_unavailable", 404)
        lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id, clock=owner._clock)
    return snapshot, tuple(identity_evidence[item.track_id] for item in candidates), finish


@contextmanager
def _playlist_sample_snapshot(owner, connection, live, *, playlist_ref, revision,
                              selection_method, constraints=None, include_observations=True,
                              facet_fields=(), facet_state=None, facet_discovery=False):
    snapshot, identities, finish = _prepare_sample_snapshot(owner, connection, live,
        playlist_ref=playlist_ref, revision=revision, selection_method=selection_method,
        constraints=constraints, include_observations=include_observations, facet_fields=facet_fields,
        facet_state=facet_state, facet_discovery=facet_discovery)
    yield snapshot, identities
    finish()


def sample_inventory_ref(value, kind, library_id=None):
    import re
    match = re.fullmatch(r"inventory-(album|track):([1-9][0-9]*):([1-9][0-9]*)", value) if type(value) is str else None
    if match is None or match[1] != kind or any(len(match[n]) > 19 or int(match[n]) > 2**63-1 for n in (2, 3)):
        raise PlaylistError("invalid_command")
    library, identity = int(match[2]), int(match[3])
    if library_id is not None and library != library_id:
        raise PlaylistError("source_changed", 409)
    return library, identity


def normalize_sample_origin(value, library_id=None):
    """Closed typed source selection. Never admit a parentless catalog selector."""
    if type(value) is not dict:
        raise PlaylistError("invalid_command")
    kind = value.get("kind")
    if kind == "album_top" and set(value) == {"kind", "top_ref", "revision"}:
        return {"kind": kind, "top_ref": uuid_ref(value["top_ref"]), "revision": playlist_revision(value["revision"])}
    if kind == "album_set" and set(value) == {"kind", "selections"}:
        items = value["selections"]
        if type(items) is not list:
            raise PlaylistError("invalid_command")
        if len(items) > MAX_PLAYLIST_ITEMS_PER_COMMAND:
            raise PlaylistError("source_too_large", 413)
        result, seen = [], set()
        for item in items:
            if type(item) is not dict:
                raise PlaylistError("invalid_command")
            if item == {"kind": "unavailable"}:
                result.append({"kind": "unavailable"})
            elif set(item) == {"kind", "inventory_album_ref"} and item["kind"] == "local":
                ref = item["inventory_album_ref"]
                sample_inventory_ref(ref, "album", library_id)
                if ref in seen:
                    raise PlaylistError("invalid_command")
                seen.add(ref)
                result.append({"kind": "local", "inventory_album_ref": ref})
            else:
                raise PlaylistError("invalid_command")
        return {"kind": kind, "selections": result}
    if kind == "album_details" and set(value) == {"kind", "track_refs"}:
        refs = value["track_refs"]
        if type(refs) is not list:
            raise PlaylistError("invalid_command")
        if len(refs) > MAX_PLAYLIST_ITEMS_PER_COMMAND:
            raise PlaylistError("source_too_large", 413)
        for ref in refs:
            sample_inventory_ref(ref, "track", library_id)
        if len(set(refs)) != len(refs):
            raise PlaylistError("invalid_command")
        return {"kind": kind, "track_refs": list(refs)}
    raise PlaylistError("invalid_command")


def _origin_member(index, *, item=None, catalog=None, remote=None, album=None, tracks=(), omission=None):
    return {"index": index, "item_ref": item, "catalog_ref": catalog,
        "remote_admission_ref": remote, "inventory_album_ref": album,
        "track_refs": list(tracks), "omission": omission}


def _prepare_origin_snapshot(owner, connection, live, *, origin, selection_method,
                             constraints=None, include_observations=True, retained_proof=None,
                             facet_fields=(), facet_state=None, facet_discovery=False):
    from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
    from music_app.services.owned_album_tops import AlbumTopError
    from music_app.services import album_top_remote_membership as remote_membership
    from music_app.services.album_top_native_binding import lock_binding, eligible_editions
    facet_state = facet_state if facet_state is not None else {}
    origin = normalize_sample_origin(origin, live.library_id)
    owner._require(live, (BROWSE, CREATE), constraints)
    def readable(kind, identity):
        return owner._resource_allowed(live, BROWSE, ResourceScope(kind, str(identity)), constraints) is True
    tops = PostgresOwnedAlbumTopsService(owner._config, connect=owner._connect, clock=owner._clock)
    def top_members():
        try:
            top = tops._top(connection, live, origin["top_ref"])
            tops._require(live, (BROWSE,), constraints, top)
            if str(top["revision"]) != origin["revision"]:
                raise PlaylistError("revision_conflict", 409)
            members = connection.execute("""select ref,catalog_ref from app.album_list_items
                where top_ref=%s order by curator_position,ref limit %s""",
                (origin["top_ref"], MAX_PLAYLIST_ITEMS_PER_COMMAND+1)).fetchall()
            if len(members) > MAX_PLAYLIST_ITEMS_PER_COMMAND:
                raise PlaylistError("source_too_large", 413)
            return top, members, remote_membership.bindings(connection, top)
        except AlbumTopError as error:
            raise PlaylistError(error.code, error.status_code) from None
    # Discovery never takes an album SHARE lock. All relevant album UPDATE
    # locks precede eligibility, bounded track discovery and the legacy reader.
    locked_albums, track_plan, expected_parents = set(), {}, {}
    remaining = MAX_PLAYLIST_ITEMS_PER_COMMAND
    def lock_albums(identities):
        identities = sorted(set(identities))
        rows = connection.execute("""select id from library.local_albums
            where library_id=%s and id=any(%s::bigint[]) order by id for update""",
            (live.library_id, identities)).fetchall() if identities else []
        if {row["id"] for row in rows} != set(identities):
            if origin["kind"] == "album_set":
                raise PlaylistError("source_unavailable", 404)
            raise PlaylistError("source_changed", 409)
        locked_albums.update(identities)
    def probe_album(identity, limit):
        rows = connection.execute("""select id,disc_number,track_number from library.local_tracks
            where library_id=%s and album_id=%s order by id limit %s""",
            (live.library_id, identity, limit)).fetchall()
        return sorted(rows, key=lambda row: tuple((0, n) if type(n) is int and n > 0 else (1, 0)
            for n in (row["disc_number"], row["track_number"])) + (row["id"],))
    def album_tracks(identity, *, expected=None):
        nonlocal remaining
        if identity not in locked_albums:
            raise PlaylistError("source_changed", 409)
        if not readable("album", identity):
            raise PlaylistError("source_unavailable", 404)
        if identity not in track_plan:
            limit = min(remaining + 1, expected + 1) if expected is not None else remaining + 1
            tracks = probe_album(identity, limit)
            if expected is not None and len(tracks) != expected:
                raise PlaylistError("source_changed", 409)
            track_plan[identity] = tracks
        tracks = track_plan[identity]
        if len(tracks) > remaining:
            raise PlaylistError("source_too_large", 413)
        remaining -= len(tracks)
        for row in tracks:
            expected_parents[row["id"]] = identity
        return tracks
    def retained_count(index):
        return len(retained_proof["members"][index]["track_refs"]) if retained_proof is not None and index < len(retained_proof["members"]) else None
    proof = {"kind": origin["kind"], "members": []}
    if origin["kind"] == "album_top":
        top, members, remote = top_members()
        # The existing real Top tuple is the sole privileged catalog lock seam.
        for row in sorted(members, key=lambda row: (str(row["catalog_ref"]), str(row["ref"]))):
            if str(row["ref"]) not in remote:
                try:
                    lock_binding(connection, top_ref=origin["top_ref"], item_ref=str(row["ref"]),
                        library_id=live.library_id, revision=origin["revision"], catalog_ref=str(row["catalog_ref"]))
                except AlbumTopError as error:
                    raise PlaylistError(error.code, error.status_code) from None
        catalogs = sorted({str(row["catalog_ref"]) for row in members if str(row["ref"]) not in remote})
        linked = connection.execute("""select l.local_album_id as id,l.catalog_ref
            from library.catalog_album_links l
            where l.library_id=%s and l.catalog_ref=any(%s::uuid[])
            order by l.local_album_id,l.catalog_ref""", (live.library_id, catalogs)).fetchall() if catalogs else []
        linked_ids = {row["id"] for row in linked}
        lock_albums(linked_ids)
        def editions_for(catalog):
            rows = eligible_editions(connection, live.library_id, catalog)
            if any(row["id"] not in linked_ids for row in rows):
                raise PlaylistError("source_changed", 409)
            return rows
        for index, row in enumerate(members):
            item, catalog = str(row["ref"]), str(row["catalog_ref"])
            remote_row = remote.get(item)
            if remote_row is not None:
                member = _origin_member(index, item=item, catalog=catalog, remote=str(remote_row["ref"]), omission="remote_summary")
            elif retained_proof is not None and index < len(retained_proof["members"]) and retained_proof["members"][index]["omission"] in ("unavailable", "ambiguous_edition"):
                old = retained_proof["members"][index]
                if old["item_ref"] != item or old["catalog_ref"] != catalog or old["remote_admission_ref"] is not None:
                    raise PlaylistError("source_changed", 409)
                member = dict(old)
            else:
                editions = editions_for(catalog)
                if len(editions) != 1:
                    reason = "ambiguous_edition" if editions and all(readable("album", e["id"]) for e in editions) else "unavailable"
                    member = _origin_member(index, item=item, catalog=catalog, omission=reason)
                elif not readable("album", editions[0]["id"]):
                    member = _origin_member(index, item=item, catalog=catalog, omission="unavailable")
                else:
                    identity = editions[0]["id"]
                    tracks = album_tracks(identity, expected=retained_count(index))
                    member = _origin_member(index, item=item, catalog=catalog,
                        album=f"inventory-album:{live.library_id}:{identity}",
                        tracks=[f"inventory-track:{live.library_id}:{t['id']}" for t in tracks],
                        omission=None if tracks else "tracks_unavailable")
            proof["members"].append(member)
    elif origin["kind"] == "album_set":
        # Global inventory lock order is independent of user selection order.
        selected = sorted(sample_inventory_ref(s["inventory_album_ref"], "album", live.library_id)[1]
                          for s in origin["selections"] if s["kind"] == "local")
        lock_albums(selected)
        for index, item in enumerate(origin["selections"]):
            if item["kind"] == "unavailable":
                member = _origin_member(index, omission="unavailable")
            else:
                identity = sample_inventory_ref(item["inventory_album_ref"], "album", live.library_id)[1]
                tracks = album_tracks(identity, expected=retained_count(index))
                member = _origin_member(index, album=item["inventory_album_ref"],
                    tracks=[f"inventory-track:{live.library_id}:{t['id']}" for t in tracks],
                    omission=None if tracks else "tracks_unavailable")
            proof["members"].append(member)
    else:
        selected = [sample_inventory_ref(ref, "track", live.library_id)[1] for ref in origin["track_refs"]]
        parents = connection.execute("""select id,album_id from library.local_tracks
            where library_id=%s and id=any(%s::bigint[]) order by id""",
            (live.library_id, selected)).fetchall() if selected else []
        if {row["id"] for row in parents} != set(selected):
            raise PlaylistError("source_unavailable", 404)
        expected_parents.update((row["id"], row["album_id"]) for row in parents)
        lock_albums(row["album_id"] for row in parents if row["album_id"] is not None)
        proof["members"] = [_origin_member(i, tracks=[ref]) for i, ref in enumerate(origin["track_refs"])]
    occurrences = [ref for member in proof["members"] for ref in member["track_refs"]]
    if len(occurrences) > MAX_PLAYLIST_ITEMS_PER_COMMAND:
        raise PlaylistError("source_too_large", 413)
    positions = {}
    for position, ref in enumerate(occurrences):
        positions.setdefault(sample_inventory_ref(ref, "track", live.library_id)[1], position)
    # Fail fast against the unchanged tracks-first legacy reader. Raising out
    # of the authorized context rolls the entire transaction back; never query
    # this connection again after a failed NOWAIT statement.
    try:
        resources = connection.execute("""select id,album_id from library.local_tracks
            where library_id=%s and id=any(%s::bigint[]) order by id for update nowait""",
            (live.library_id, sorted(positions))).fetchall() if positions else []
    except Exception as error:
        if getattr(error, "sqlstate", None) == "55P03":
            raise PlaylistError("concurrent_change", 409) from None
        raise
    if {row["id"]: row["album_id"] for row in resources} != expected_parents:
        raise PlaylistError("source_changed", 409)
    # Parent changes cannot cause a late, potentially lower-ID album lock.
    if any(row["album_id"] is not None and row["album_id"] not in locked_albums for row in resources):
        raise PlaylistError("source_changed", 409)
    # Held album UPDATE locks prevent new FK membership; the exact locked
    # track-to-parent map above rejects departures/deletions during discovery.
    # Final proof probes below remain bounded by each admitted count + 1.
    if {row["id"] for row in resources} != set(positions) or any(not readable("track", row["id"]) or
            row["album_id"] is not None and not readable("album", row["album_id"]) for row in resources):
        raise PlaylistError("source_unavailable", 404)
    rows = inventory.read_inventory(connection, live.library_id, track_ids=list(positions), lock=True,
        include_popularity=selection_method == "most_listened" and include_observations,
        **({"preflight": _facet_preflight} if facet_fields else {})) if positions else []
    if {row["original_local_track_id"] for row in rows} != set(positions):
        raise PlaylistError("source_changed", 409)
    candidates, diagnostics, admitted_resources, digests, evidence = _candidate_facts(rows, positions, readable,
        live.library_id, most_listened=selection_method == "most_listened", include_observations=include_observations)
    candidates = _project_facets(owner, connection, live, rows, candidates, diagnostics,
        facet_fields, constraints, facet_state, facet_discovery)
    membership = evidence_digest({"domain": "membership_v2", "value": proof})
    snapshot = _OriginSampleSnapshot("", "", live.library_id, live.actor.account_id, live.actor.session_id,
        membership, tuple(candidates), tuple(sorted(diagnostics)), tuple((c.track_id, digests[c.track_id]) for c in candidates), proof)
    def finish():
        _finish_facets(owner, live, facet_state, constraints)
        owner._require(live, (BROWSE, CREATE), constraints)
        if origin["kind"] == "album_top":
            _top, current, current_remote = top_members()
            if [(str(r["ref"]),str(r["catalog_ref"])) for r in current] != [(m["item_ref"],m["catalog_ref"]) for m in proof["members"]]:
                raise PlaylistError("source_changed", 409)
            for member in proof["members"]:
                row = current_remote.get(member["item_ref"])
                if (str(row["ref"]) if row else None) != member["remote_admission_ref"]:
                    raise PlaylistError("source_changed", 409)
                if member["inventory_album_ref"] is not None:
                    identity = sample_inventory_ref(member["inventory_album_ref"], "album", live.library_id)[1]
                    editions = editions_for(member["catalog_ref"])
                    if len(editions) != 1 or editions[0]["id"] != identity:
                        raise PlaylistError("source_changed", 409)
        for member in proof["members"]:
            if member["inventory_album_ref"] is not None:
                identity = sample_inventory_ref(member["inventory_album_ref"], "album", live.library_id)[1]
                if identity not in locked_albums or not readable("album", identity):
                    raise PlaylistError("source_unavailable", 404)
                if [f"inventory-track:{live.library_id}:{t['id']}" for t in probe_album(identity, len(member["track_refs"]) + 1)] != member["track_refs"]:
                    raise PlaylistError("source_changed", 409)
        if any(not readable("track", track) or album is not None and not readable("album", album) for track, album in admitted_resources):
            raise PlaylistError("source_unavailable", 404)
        lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id, clock=owner._clock)
    finish()
    return snapshot, tuple(evidence[c.track_id] for c in candidates), finish
