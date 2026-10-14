"""Library Mix source receipts and saved recipes on the owned Playlist boundary.

Provider ingestion is a separate cache writer. Every request here reads cached
normalized evidence only, inside the caller's current-library transaction.
"""
from dataclasses import dataclass
from datetime import datetime
from collections import Counter

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.library_mix import (
    LibraryMixCandidate, LibraryMixTooLarge, build_library_mix,
    normalize_library_mix_recipe, recipe_payload,
)
from music_app.services.owned_playlists import (
    BROWSE, CREATE, LIBRARY_MIX_PROTOCOL, PlaylistError, uuid_ref,
    inventory_identity,
)
from music_app.services.policy import ResourceScope
from music_app.services.popularity_snapshots import CachedPopularity
from music_app.services import playlist_creation_sources_postgres as sources

POPULARITY_REFRESH_STATUSES = frozenset(("idle", "queued", "running", "complete", "blocked", "cancelled"))


@dataclass(frozen=True, slots=True)
class LibraryMixSnapshot:
    """Complete server-owned mapping snapshot, never supplied by a browser.

    The adapter admits track IDs through the required per-resource predicate
    before loading metadata or evaluating mappings, groups or cached observations.
    It pins admitted mapping and primary-group evidence in this transaction.
    Missing mappings are explicit diagnostics, never guessed
    title matches or synthetic zero counts. Observation keys are local track IDs.
    """
    library_id: int
    candidates: tuple[LibraryMixCandidate, ...]
    snapshots: dict[int, CachedPopularity]
    diagnostics: tuple[tuple[int, str], ...] = ()
    refresh_status: str = "idle"


def read_popularity_refresh_status(connection, library_id):
    """The caller has already authorized this current library; return no job IDs."""
    from music_app.services.library_popularity_jobs import read_job
    job = read_job(connection, library_id)
    status = job["status"] if job else "idle"
    if not isinstance(status, str) or status not in POPULARITY_REFRESH_STATUSES:
        raise PlaylistError("library_mix_unavailable", 503)
    return status


def _request_popularity_refresh(owner, library_id, observed_status):
    """Enqueue after the authorized transaction exits; preserve committed reads.

    Local enqueue False can mean singleflight, shutdown or disabled integration.
    Durable progress, never that Boolean, is authoritative. Separate errors keep
    a committed cached source usable without presenting an unverified refresh.
    """
    result = {"popularity_refresh_status": observed_status}
    try:
        from music_app.services.library_popularity_jobs import refresh_is_configured
        if not refresh_is_configured(owner._config):
            result["popularity_refresh_error"] = "not_configured"
            return result
        from music_app.services.state import queue_library_popularity_refresh
        queued = queue_library_popularity_refresh(owner._config, library_id=library_id, complete=True)
    except Exception:
        result["popularity_refresh_error"] = "enqueue_unavailable"
        return result
    try:
        with owner._connect(owner._url) as connection:
            result["popularity_refresh_status"] = read_popularity_refresh_status(connection, library_id)
    except Exception:
        # Successful enqueue confirms queued work even if a later status read
        # fails. It does not claim provider completion or refreshed membership.
        if queued:
            result["popularity_refresh_status"] = "queued"
        result["popularity_refresh_error"] = "status_unavailable"
    return result


def _recipe(value):
    try:
        return normalize_library_mix_recipe(value)
    except (TypeError, ValueError):
        raise PlaylistError("invalid_library_mix_recipe") from None


def _stored_recipe(value):
    if not isinstance(value, dict) or type(value.get("version")) is not int:
        raise PlaylistError("source_changed", 409)
    recipe = _recipe({key: value.get(key) for key in
                      ("selection_basis", "songs_per_group", "auto_update", "playback_order")})
    if value != recipe_payload(recipe):
        raise PlaylistError("source_changed", 409)
    return recipe


def load_recipes(connection, library_id, playlist_refs):
    if not playlist_refs:
        return {}
    rows = connection.execute("""select * from app.playlist_library_mixes
        where library_id=%s and playlist_ref=any(%s::uuid[])""",
        (library_id, playlist_refs)).fetchall()
    return {str(row["playlist_ref"]): dict(row) for row in rows}


def recipe_from_row(row):
    return _stored_recipe({
        "version": row["recipe_version"], "source": row["source"],
        "provider": row["provider"], "metric": row["metric"],
        "selection_basis": row["selection_basis"],
        "songs_per_group": row["songs_per_group"], "auto_update": row["auto_update"],
        "playback_order": row["playback_order"],
    })


def require_manual_membership(command, playlist):
    row = playlist.get("library_mix")
    if row and recipe_from_row(row).auto_update and (
        command.action in {"add", "remove", "reorder"}
        or command.action == "save" and "item_order" in command.data
    ):
        raise PlaylistError("library_mix_membership_locked", 409)


def project_recipe(row, *, refresh_status="last_computed"):
    if row is None:
        return None
    return {**recipe_payload(recipe_from_row(row)), "refresh_status": refresh_status,
            "last_evaluated_at": row["last_evaluated_at"].isoformat(),
            "coverage": row["coverage"]}


def _evaluate(owner, connection, context, recipe, constraints):
    def can_read_track(track_id):
        return owner._resource_allowed(context, BROWSE,
            ResourceScope("track", str(track_id)), constraints)

    reader = owner._library_mix_reader
    if reader is None:
        from music_app.services.library_mix_inventory_postgres import read_snapshot
        reader = read_snapshot
    snapshot = reader(connection, context, is_readable=can_read_track)
    if (not isinstance(snapshot, LibraryMixSnapshot) or snapshot.library_id != context.library_id
            or not isinstance(snapshot.refresh_status, str)
            or snapshot.refresh_status not in POPULARITY_REFRESH_STATUSES):
        raise PlaylistError("library_mix_unavailable", 503)
    ids = [candidate.track.track_id for candidate in snapshot.candidates
           if can_read_track(candidate.track.track_id)]
    current = sources.inventory_rows(connection, context.library_id, ids,
                                    lock=True, config=owner._config)

    def readable(candidate):
        row = current.get(candidate.track.track_id)
        return bool(row and row["availability"] == "local" and can_read_track(candidate.track.track_id))

    try:
        selection = build_library_mix(snapshot.candidates, recipe,
            is_local_readable=readable,
            read_snapshot=lambda candidate: snapshot.snapshots.get(candidate.track.track_id))
    except LibraryMixTooLarge:
        raise PlaylistError("library_mix_too_large", 422) from None
    diagnostics = list(selection.diagnostics)
    for track_id, reason in snapshot.diagnostics:
        if can_read_track(track_id):
            diagnostics.append((track_id, reason))
    rows = [current[candidate.track.track_id] for candidate in selection.tracks]
    return rows, diagnostics, snapshot


def _diagnostics(context, values):
    return [{"inventory_track_ref": f"inventory-track:{context.library_id}:{track_id}",
             "reason": reason} for track_id, reason in values]


def _coverage(rows, diagnostics):
    return {"selected_count": len(rows), "excluded_count": len(diagnostics),
            "reasons": dict(Counter(reason for _, reason in diagnostics)),
            "diagnostics_truncated": len(diagnostics) > 100}


def _source_payload(owner, connection, context, source, selected, constraints):
    from music_app.services.listen_history_postgres import read_scoped_track_play_counts
    origin = source["origin_descriptor"]
    recipe = _stored_recipe(origin.get("library_mix"))
    personal = read_scoped_track_play_counts(connection, account_id=context.actor.account_id,
        library_id=context.library_id, track_ids=[row["original_local_track_id"] for row in selected])
    popularity_status = read_popularity_refresh_status(connection, context.library_id)
    entries = []
    for row in selected:
        entry = sources.project_entry(source, row, album_readable=lambda album_id:
            owner._resource_allowed(context, BROWSE, ResourceScope("album", str(album_id)), constraints))
        track_id = row["original_local_track_id"]
        entry["allowed_actions"]["can_play"] = row["availability"] == "local" and owner._resource_allowed(
            context, "library.media.read", ResourceScope("track", str(track_id)), constraints)
        entry["play_count"] = personal.get(track_id)
        entry["popularity_count"] = origin.get("popularity_counts", {}).get(str(track_id))
        entries.append(entry)
    now = lock_current_actor_session(connection, actor_account_id=context.actor.account_id,
        actor_session_id=context.actor.session_id, clock=owner._clock)
    if source["expires_at"] <= now:
        raise PlaylistError("source_expired", 410)
    diagnostics = []
    for item in origin.get("diagnostics", []):
        library_id, track_id = inventory_identity(item["inventory_track_ref"])
        if library_id == context.library_id and owner._resource_allowed(
                context, BROWSE, ResourceScope("track", str(track_id)), constraints):
            diagnostics.append(item)
    return {"status": "ready", "data": {
        **sources.source_envelope(source), "entries_complete": True,
        "allowed_actions": {"can_read": True, "can_use_for_playlist": True,
                            "can_play": any(entry["allowed_actions"]["can_play"] for entry in entries)},
        "entries": entries, "retained_parent_albums": [],
        "library_mix": recipe_payload(recipe), "diagnostics": diagnostics,
        "coverage": origin.get("coverage", {}),
        "popularity_refresh_status": popularity_status,
        "actor_scope": owner._scope(context),
    }}


def capture(owner, context, payload, *, constraints=None):
    from music_app.services.playlist_complete_sources import _header
    from psycopg.types.json import Jsonb
    recipe = _recipe(payload)
    with owner._authorized(context, constraints) as (connection, live, _now):
        owner._require(live, (BROWSE, CREATE), constraints)
        rows, diagnostics, snapshot = _evaluate(owner, connection, live, recipe, constraints)
        now = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id, clock=owner._clock)
        source = _header(connection, live, now, protocol=LIBRARY_MIX_PROTOCOL, kind="library")
        observed = sources._observe_page(connection, source, rows)
        origin = {"library_mix": recipe_payload(recipe),
                  "entry_order": [str(row["ref"]) for row in observed],
                  "diagnostics": _diagnostics(live, diagnostics[:100]),
                  "coverage": _coverage(rows, diagnostics),
                  "popularity_counts": {str(row["original_local_track_id"]):
                      snapshot.snapshots[row["original_local_track_id"]].observation.count for row in rows},
                  "evaluated_at": now.isoformat()}
        connection.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s",
            (Jsonb(origin), source["ref"]))
        source["origin_descriptor"] = origin
        result = _source_payload(owner, connection, live, source, observed, constraints)
        verified_library_id = live.library_id
    result["data"].update(_request_popularity_refresh(owner, verified_library_id,
        result["data"]["popularity_refresh_status"]))
    return result


def selected(owner, connection, context, source, entry_refs, *, constraints=None):
    origin = source.get("origin_descriptor")
    if not isinstance(origin, dict) or entry_refs != origin.get("entry_order"):
        raise PlaylistError("source_changed", 409)
    _stored_recipe(origin.get("library_mix"))
    rows = sources.selected_entries(connection, context, source, entry_refs, config=owner._config)
    if any(not owner._resource_allowed(context, BROWSE,
            ResourceScope("track", str(row["original_local_track_id"])), constraints) for row in rows):
        raise PlaylistError("source_unavailable", 404)
    return rows


def read_capture(owner, context, source_ref, source_revision, *, constraints=None):
    ref, revision = uuid_ref(source_ref), uuid_ref(source_revision)
    with owner._authorized(context, constraints) as (connection, live, now):
        owner._require(live, (BROWSE, CREATE), constraints)
        source = sources.load_source(connection, live, ref, revision, now,
                                     protocol=LIBRARY_MIX_PROTOCOL, kind="library")
        refs = (source.get("origin_descriptor") or {}).get("entry_order")
        if not isinstance(refs, list):
            raise PlaylistError("source_changed", 409)
        rows = selected(owner, connection, live, source, refs, constraints=constraints)
        now = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id, clock=owner._clock)
        if source["expires_at"] <= now:
            raise PlaylistError("source_expired", 410)
        return _source_payload(owner, connection, live, source, rows, constraints)


def native_queue(owner, context, payload, *, constraints=None, media_resolver=None):
    from music_app.services.listen_history_postgres import read_scoped_track_play_counts
    from music_app.services.private_native_targets import PrivateNativeTargets
    if (not isinstance(payload, dict) or set(payload) != {
            "source_ref", "source_revision", "entry_refs", "starting_entry_ref"}
            or not isinstance(payload["entry_refs"], list)
            or not 1 <= len(payload["entry_refs"]) <= 5000):
        raise PlaylistError("invalid_command")
    ref, revision = uuid_ref(payload["source_ref"]), uuid_ref(payload["source_revision"])
    refs = [uuid_ref(value) for value in payload["entry_refs"]]
    starting = uuid_ref(payload["starting_entry_ref"])
    if len(set(refs)) != len(refs) or starting not in refs:
        raise PlaylistError("invalid_command")
    with owner._authorized(context, constraints) as (connection, live, now):
        owner._require(live, (BROWSE, CREATE), constraints)
        source = sources.load_source(connection, live, ref, revision, now,
                                     protocol=LIBRARY_MIX_PROTOCOL, kind="library")
        order = (source.get("origin_descriptor") or {}).get("entry_order")
        if not isinstance(order, list) or set(order) != set(refs):
            raise PlaylistError("source_changed", 409)
        rows = selected(owner, connection, live, source, order, constraints=constraints)
        by_ref = {str(row["ref"]): row["original_local_track_id"] for row in rows}
        targets = PrivateNativeTargets(owner._config, media_resolver=media_resolver).resolve_play_queue(
            connection, live, [by_ref[entry] for entry in refs], constraints=constraints)
        counts = read_scoped_track_play_counts(connection, account_id=live.actor.account_id,
            library_id=live.library_id, track_ids=list(targets))
        tracks, unavailable = [], []
        for entry in refs:
            target = targets.get(by_ref[entry])
            if target is None:
                if entry == starting:
                    raise PlaylistError("item_unavailable", 404)
                unavailable.append(entry)
            else:
                tracks.append({"playlist_item_id": entry, "play_count": counts.get(by_ref[entry]),
                    "native_target": {**target, "playlist_item_id": entry}})
        now = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id, clock=owner._clock)
        if source["expires_at"] <= now:
            raise PlaylistError("source_expired", 410)
        return {"source": {"kind": "library", "ref": ref, "revision": revision},
                "source_protocol": LIBRARY_MIX_PROTOCOL, "starting_item_ref": starting,
                "tracks": tracks, "unavailable_item_refs": unavailable}


def save_recipe(connection, context, playlist_ref, source, *, playback_order=None):
    from psycopg.types.json import Jsonb
    origin = source["origin_descriptor"]
    recipe = _stored_recipe(origin.get("library_mix"))
    evaluated_at = datetime.fromisoformat(origin["evaluated_at"])
    connection.execute("""insert into app.playlist_library_mixes
        (playlist_ref, library_id, recipe_version, source, provider, metric,
         selection_basis, songs_per_group, auto_update, playback_order, last_evaluated_at, coverage)
        values (%s,%s,1,'whole_library','lastfm','overall_scrobbles',%s,%s,%s,%s,%s,%s)""",
        (playlist_ref, context.library_id, recipe.selection_basis,
         recipe.songs_per_group, recipe.auto_update, playback_order or recipe.playback_order,
         evaluated_at, Jsonb(origin["coverage"])))


def refresh_owned(owner, context, playlist_ref, *, constraints=None):
    """Reconcile under the ordinary parent lock before the shared read starts.

    Readers other than the owner never mutate membership using their own policy.
    A separate transaction avoids upgrading the directory's ordered shared locks.
    Retained items keep their stable IDs; result order is replaced, never appended.
    """
    from psycopg.types.json import Jsonb
    verified_library_id = None
    popularity_status = "idle"
    try:
        with owner._authorized(context, constraints) as (connection, live, _now):
            stored = load_recipes(connection, live.library_id, [playlist_ref]).get(playlist_ref)
            if stored is None or not recipe_from_row(stored).auto_update:
                return {"refresh_status": "snapshot"}
            playlist = owner._playlist(connection, live, playlist_ref, write=True)
            owner._require(live, (BROWSE,), constraints, playlist)
            stored = playlist.get("library_mix")
            if stored is None or not recipe_from_row(stored).auto_update:
                return {"refresh_status": "snapshot"}
            if playlist["owner_account_id"] != live.actor.account_id:
                return {"refresh_status": "owner_refresh_required"}
            verified_library_id = live.library_id
            popularity_status = read_popularity_refresh_status(connection, live.library_id)
            recipe = recipe_from_row(stored)
            desired, diagnostics, _snapshot = _evaluate(owner, connection, live, recipe, constraints)
            old = connection.execute("""select * from app.playlist_items
                where playlist_ref=%s order by position""", (playlist_ref,)).fetchall()
            desired_ids = [row["original_local_track_id"] for row in desired]
            desired_set = set(desired_ids)
            changed = [row["local_track_id"] for row in old] != desired_ids
            now = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=owner._clock)
            if changed:
                kept = {row["local_track_id"]: str(row["ref"]) for row in old
                        if row["local_track_id"] in desired_set}
                removed = [str(row["ref"]) for row in old if row["local_track_id"] not in kept]
                if removed:
                    connection.execute("delete from app.playlist_items where playlist_ref=%s and ref=any(%s::uuid[])",
                                       (playlist_ref, removed))
                fresh = [row for row in desired if row["original_local_track_id"] not in kept]
                owner._insert_items(connection, live, playlist_ref, fresh, offset=len(old))
                current = connection.execute("select ref,local_track_id from app.playlist_items where playlist_ref=%s",
                                             (playlist_ref,)).fetchall()
                by_track = {row["local_track_id"]: str(row["ref"]) for row in current}
                owner._set_order(connection, playlist_ref, [by_track[track_id] for track_id in desired_ids])
                connection.execute("update app.playlists set revision=revision+1,updated_at=now() where ref=%s",
                                   (playlist_ref,))
            connection.execute("update app.playlist_library_mixes set last_evaluated_at=%s,coverage=%s where playlist_ref=%s",
                               (now, Jsonb(_coverage(desired, diagnostics)), playlist_ref))
            refresh_status = "current"
    except PlaylistError as error:
        if error.code == "library_mix_unavailable":
            refresh_status = "unavailable"
        elif error.code == "library_mix_too_large":
            refresh_status = "too_large"
        else:
            raise
    result = {"refresh_status": refresh_status}
    if verified_library_id is not None:
        result.update(_request_popularity_refresh(owner, verified_library_id, popularity_status))
    return result
