"""Own-user Artist Loves on the ordinary transactional Playlist boundary."""
from dataclasses import dataclass
from datetime import datetime
from uuid import uuid4

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.artist_family_postgres import (
    ArtistFamilyIdentityUnavailable, load_artist_family_identity_scope,
)
from music_app.services.artist_loved_playlists import (
    ARTIST_LOVED_PROTOCOL, ArtistLovedTooLarge,
    normalize_artist_loved_descriptor, normalize_artist_loved_recipe,
    select_artist_loved_track_ids,
)
from music_app.services.library_mix import ArtistMixScope
from music_app.services.owned_playlists import BROWSE, CREATE, MAX_PLAYLIST_ITEMS_PER_COMMAND, PlaylistError, uuid_ref
from music_app.services.policy import ResourceScope
from music_app.services import playlist_creation_sources_postgres as sources


@dataclass(frozen=True, slots=True)
class _Basis:
    memberships: tuple
    albums: tuple
    tracks: tuple


def _scope(memberships):
    # Every existing Gallery category/type, independent of transient filters.
    return ArtistMixScope(memberships, (), ("main_library", "new_arrivals", "hoard"),
                          ("studio", "ep", "live", "demo", "compilation", "single"))


def _allowed(owner, context, constraints, kind, identity):
    return owner._resource_allowed(context, BROWSE, ResourceScope(kind, str(identity)), constraints)


def _members(owner, connection, context, recipe, constraints):
    try:
        return load_artist_family_identity_scope(connection, library_id=context.library_id,
            root_artist_id=recipe.root_artist_id, scope_mode=recipe.scope_mode,
            is_artist_readable=lambda identity: _allowed(owner, context, constraints, "artist", identity))
    except ArtistFamilyIdentityUnavailable:
        raise PlaylistError("artist_loved_unavailable", 503) from None
    except PermissionError:
        raise PlaylistError("source_unavailable", 404) from None


def _albums(owner, connection, context, memberships, constraints, *, lock_albums=None):
    from music_app.services.library_mix_inventory_postgres import scoped_album_order
    try:
        return scoped_album_order(connection, context, _scope(memberships), dynamic=True,
            is_readable=lambda identity: _allowed(owner, context, constraints, "album", identity),
            is_artist_readable=lambda identity: _allowed(owner, context, constraints, "artist", identity),
            lock_albums=lock_albums)
    except PlaylistError as error:
        if error.code == "library_mix_unavailable":
            raise PlaylistError("artist_loved_unavailable", 503) from None
        raise


def _tracks(owner, connection, context, albums, constraints):
    from music_app.services.library_mix_inventory_postgres import scoped_track_ids
    return tuple(identity for identity in scoped_track_ids(connection, context.library_id, albums)
                 if _allowed(owner, context, constraints, "track", identity))


def _basis(owner, connection, context, recipe, constraints, *, allow_missing=False):
    members = _members(owner, connection, context, recipe, constraints)
    if members is None:
        if allow_missing:
            return None
        raise PlaylistError("source_unavailable", 404)
    albums = _albums(owner, connection, context, members, constraints)
    return _Basis(members, albums, _tracks(owner, connection, context, albums, constraints))


def _confirm(owner, connection, context, recipe, basis, constraints, *,
             required_ids=(), complete=False, allow_missing=False):
    """Re-resolve live family after waits; a fixed ArtistMixScope is insufficient."""
    members = _members(owner, connection, context, recipe, constraints)
    if members is None:
        if allow_missing:
            return None
        raise PlaylistError("source_unavailable", 404)
    if basis is None or members != basis.memberships:
        raise PlaylistError("source_changed", 409)
    # Existing inventory-before-parent order is retained. This owner may wait
    # on album/artist/credit locks, so read the family vector again afterwards.
    albums = _albums(owner, connection, context, members, constraints, lock_albums=basis.albums)
    members = _members(owner, connection, context, recipe, constraints)
    if members is None:
        if allow_missing:
            return None
        raise PlaylistError("source_unavailable", 404)
    if members != basis.memberships or albums != basis.albums:
        raise PlaylistError("source_changed", 409)
    tracks = _tracks(owner, connection, context, albums, constraints)
    if (complete and tracks != basis.tracks) or not set(required_ids).issubset(tracks):
        raise PlaylistError("source_changed", 409)
    return basis


def _fence(owner, connection, context, constraints, *, source=None, playlist=None):
    owner._require(context, (BROWSE, CREATE) if source is not None else (BROWSE,), constraints, playlist)
    now = lock_current_actor_session(connection, actor_account_id=context.actor.account_id,
        actor_session_id=context.actor.session_id, clock=owner._clock)
    if source is not None and source["expires_at"] <= now:
        raise PlaylistError("source_expired", 410)
    return now


def _love_ids(connection, context, ordered_ids):
    """Use the canonical taste owner, including its alias-conflict semantics."""
    from music_app.services.track_preferences_postgres import (
        TrackPreferenceScopeError, load_track_preferences_on_connection,
    )
    refs = connection.execute("""select id,track_key from library.local_tracks
        where library_id=%s and id=any(%s::bigint[]) order by id""",
        (context.library_id, list(ordered_ids))).fetchall()
    try:
        taste = load_track_preferences_on_connection(connection, [row["track_key"] for row in refs],
            account_id=context.actor.account_id, library_id=context.library_id)
    except TrackPreferenceScopeError:
        raise PlaylistError("forbidden", 403) from None
    tiers = {row["track_id"]: row["love_tier"] for row in taste.values()}
    try:
        return select_artist_loved_track_ids(ordered_ids, tiers)
    except ArtistLovedTooLarge:
        raise PlaylistError("artist_loved_too_large", 422) from None


def _evaluate(owner, connection, context, recipe, constraints, *, allow_missing=False):
    basis = _basis(owner, connection, context, recipe, constraints, allow_missing=allow_missing)
    if basis is None:
        return [], basis, ()
    current = sources.inventory_rows(connection, context.library_id, basis.tracks,
                                     lock=True, config=owner._config)
    if _confirm(owner, connection, context, recipe, basis, constraints,
                complete=True, allow_missing=allow_missing) is None:
        return [], None, ()
    positions = {identity: position for position, identity in enumerate(basis.albums)}
    ordered = sorted((row for row in current.values() if row["availability"] == "local"
                      and _allowed(owner, context, constraints, "track", row["original_local_track_id"])),
        key=lambda row: (positions[row["original_album_id"]], row["disc_number"] or 2**31,
                         row["track_number"] or 2**31, row["original_local_track_id"]))
    ordered_ids = tuple(row["original_local_track_id"] for row in ordered)
    identities = _love_ids(connection, context, ordered_ids)
    return [current[identity] for identity in identities], basis, ordered_ids


def _source_recipe(source):
    origin = source.get("origin_descriptor")
    if (source.get("protocol") != ARTIST_LOVED_PROTOCOL or source.get("source_kind") != "library"
            or not isinstance(origin, dict) or set(origin) != {"artist_loved", "entry_order", "evaluated_at"}):
        raise PlaylistError("source_changed", 409)
    try:
        recipe = normalize_artist_loved_recipe(origin["artist_loved"])
        evaluated = datetime.fromisoformat(origin["evaluated_at"])
        if evaluated.utcoffset() is None:
            raise ValueError("Missing evaluation timezone")
        refs = origin["entry_order"]
        if not isinstance(refs, list) or len(refs) > MAX_PLAYLIST_ITEMS_PER_COMMAND:
            raise ValueError("Invalid complete entry order")
        if refs != [uuid_ref(ref) for ref in refs] or len(set(refs)) != len(refs):
            raise ValueError("Invalid complete entry order")
    except (TypeError, ValueError, PlaylistError):
        raise PlaylistError("source_changed", 409) from None
    return recipe


def _selected(owner, connection, context, source, refs, constraints):
    recipe = _source_recipe(source)
    if refs != source["origin_descriptor"]["entry_order"]:
        raise PlaylistError("source_changed", 409)
    basis = _basis(owner, connection, context, recipe, constraints)
    rows = sources.selected_entries(connection, context, source, refs, config=owner._config)
    identities = [row["original_local_track_id"] for row in rows]
    _confirm(owner, connection, context, recipe, basis, constraints, required_ids=identities)
    _fence(owner, connection, context, constraints, source=source)
    return rows, recipe, basis


def _payload(owner, connection, context, source, rows, recipe, basis, constraints):
    from music_app.services.listen_history_postgres import read_scoped_track_play_counts
    counts = read_scoped_track_play_counts(connection, account_id=context.actor.account_id,
        library_id=context.library_id, track_ids=[row["original_local_track_id"] for row in rows])
    entries = []
    for row in rows:
        entry = sources.project_entry(source, row, album_readable=lambda identity:
            _allowed(owner, context, constraints, "album", identity))
        identity = row["original_local_track_id"]
        entry["allowed_actions"]["can_play"] = row["availability"] == "local" and owner._resource_allowed(
            context, "library.media.read", ResourceScope("track", str(identity)), constraints)
        entry["play_count"] = counts.get(identity)
        entries.append(entry)
    _confirm(owner, connection, context, recipe, basis, constraints,
             required_ids=[row["original_local_track_id"] for row in rows])
    _fence(owner, connection, context, constraints, source=source)
    return {"status": "ready", "data": {**sources.source_envelope(source),
        "entries_complete": True, "entries": entries, "retained_parent_albums": [],
        "artist_loved": recipe.as_dict(), "actor_scope": owner._scope(context),
        "allowed_actions": {"can_read": True, "can_use_for_playlist": True,
                            "can_play": any(entry["allowed_actions"]["can_play"] for entry in entries)}}}


def capture(owner, context, payload, *, constraints=None):
    from psycopg.types.json import Jsonb
    from music_app.services.playlist_complete_sources import _header
    try:
        recipe = normalize_artist_loved_descriptor(payload)
    except (TypeError, ValueError):
        raise PlaylistError("invalid_artist_loved_descriptor") from None
    with owner._authorized(context, constraints) as (connection, live, _now):
        owner._require(live, (BROWSE, CREATE), constraints)
        rows, basis, _ordered_ids = _evaluate(owner, connection, live, recipe, constraints)
        owner._require(live, (BROWSE, CREATE), constraints)
        now = _fence(owner, connection, live, constraints)
        source = _header(connection, live, now, protocol=ARTIST_LOVED_PROTOCOL, kind="library")
        observed = sources._observe_page(connection, source, rows)
        origin = {"artist_loved": recipe.as_dict(), "entry_order": [str(row["ref"]) for row in observed],
                  "evaluated_at": now.isoformat()}
        connection.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s",
                           (Jsonb(origin), source["ref"]))
        source["origin_descriptor"] = origin
        return _payload(owner, connection, live, source, observed, recipe, basis, constraints)


def read_capture(owner, context, source_ref, source_revision, *, constraints=None):
    ref, revision = uuid_ref(source_ref), uuid_ref(source_revision)
    with owner._authorized(context, constraints) as (connection, live, now):
        owner._require(live, (BROWSE, CREATE), constraints)
        source = sources.load_source(connection, live, ref, revision, now,
                                     protocol=ARTIST_LOVED_PROTOCOL, kind="library")
        _source_recipe(source)
        rows, recipe, basis = _selected(owner, connection, live, source,
            source["origin_descriptor"]["entry_order"], constraints)
        return _payload(owner, connection, live, source, rows, recipe, basis, constraints)


def native_queue(owner, context, payload, *, constraints=None, media_resolver=None):
    from music_app.services.listen_history_postgres import read_scoped_track_play_counts
    from music_app.services.private_native_targets import PrivateNativeTargets, NativeTargetError
    if (not isinstance(payload, dict) or set(payload) != {
            "source_ref", "source_revision", "entry_refs", "starting_entry_ref"}
            or not isinstance(payload["entry_refs"], list)
            or not 1 <= len(payload["entry_refs"]) <= MAX_PLAYLIST_ITEMS_PER_COMMAND):
        raise PlaylistError("invalid_command")
    ref, revision = uuid_ref(payload["source_ref"]), uuid_ref(payload["source_revision"])
    refs = [uuid_ref(value) for value in payload["entry_refs"]]
    starting = uuid_ref(payload["starting_entry_ref"])
    if len(set(refs)) != len(refs) or starting not in refs:
        raise PlaylistError("invalid_command")
    with owner._authorized(context, constraints) as (connection, live, now):
        owner._require(live, (BROWSE, CREATE), constraints)
        source = sources.load_source(connection, live, ref, revision, now,
                                     protocol=ARTIST_LOVED_PROTOCOL, kind="library")
        _source_recipe(source)
        order = source["origin_descriptor"]["entry_order"]
        if set(order) != set(refs):
            raise PlaylistError("source_changed", 409)
        rows, recipe, basis = _selected(owner, connection, live, source, order, constraints)
        identities = {str(row["ref"]): row["original_local_track_id"] for row in rows}
        try:
            targets = PrivateNativeTargets(owner._config, media_resolver=media_resolver).resolve_play_queue(
                connection, live, [identities[entry] for entry in refs], constraints=constraints)
        except NativeTargetError as error:
            raise PlaylistError(error.code, error.status_code) from None
        counts = read_scoped_track_play_counts(connection, account_id=live.actor.account_id,
            library_id=live.library_id, track_ids=list(targets))
        _confirm(owner, connection, live, recipe, basis, constraints, required_ids=list(identities.values()))
        _fence(owner, connection, live, constraints, source=source)
        tracks, unavailable = [], []
        for entry in refs:
            target = targets.get(identities[entry])
            if target is not None and not owner._resource_allowed(live, "library.media.read",
                    ResourceScope("track", str(identities[entry])), constraints):
                target = None
            if target is None:
                if entry == starting:
                    raise PlaylistError("item_unavailable", 404)
                unavailable.append(entry)
            else:
                tracks.append({"playlist_item_id": entry, "play_count": counts.get(identities[entry]),
                    "native_target": {**target, "playlist_item_id": entry}})
        _fence(owner, connection, live, constraints, source=source)
        return {"source": {"kind": "library", "ref": ref, "revision": revision},
                "source_protocol": ARTIST_LOVED_PROTOCOL, "starting_item_ref": starting,
                "tracks": tracks, "unavailable_item_refs": unavailable}


def load_recipes(connection, library_id, playlist_refs):
    if not playlist_refs:
        return {}
    return {str(row["playlist_ref"]): dict(row) for row in connection.execute("""
        select * from app.playlist_artist_loved_recipes
        where library_id=%s and playlist_ref=any(%s::uuid[]) and retired_at is null""",
        (library_id, playlist_refs)).fetchall()}


def recipe_from_row(row):
    try:
        return normalize_artist_loved_recipe({"version": row["recipe_version"],
            "root_artist_id": str(row["root_artist_id"]), "scope_mode": row["scope_mode"],
            "source": "artist_loved", "auto_update": True, "playback_order": row["playback_order"]})
    except (KeyError, TypeError, ValueError):
        raise PlaylistError("artist_loved_unavailable", 503) from None


def project_recipe(row, *, refresh_status="last_computed"):
    if row is None:
        return None
    return {**recipe_from_row(row).as_dict(), "refresh_status": refresh_status,
            "last_evaluated_at": row["last_evaluated_at"].isoformat(), "root_state": row["root_state"]}


def require_manual_membership(command, playlist):
    if playlist.get("artist_loved") and (command.action in {"add", "remove", "reorder"}
            or command.action == "save" and "item_order" in command.data):
        raise PlaylistError("artist_loved_membership_locked", 409)


def create_from_source(owner, connection, context, command, source, *, constraints=None):
    """Called only after the ordinary original-session exact-replay lookup."""
    rows, recipe, basis = _selected(owner, connection, context, source, command.data["entry_refs"], constraints)
    existing = connection.execute("""select r.playlist_ref from app.playlist_artist_loved_recipes r
        join app.playlists p on p.ref=r.playlist_ref and p.library_id=r.library_id
          and p.owner_account_id=r.owner_account_id
        where r.owner_account_id=%s and r.library_id=%s and r.root_artist_id=%s
          and r.scope_mode=%s and r.retired_at is null and p.deleted_at is null""",
        recipe.business_identity(context.actor.account_id, context.library_id)).fetchone()
    if existing is not None:
        ref = str(existing["playlist_ref"])
        playlist = owner._playlist(connection, context, ref, write=True)
        owner._require(context, (BROWSE,), constraints, playlist, owner_only=True)
        stored = playlist.get("artist_loved")
        if stored is None or recipe_from_row(stored).business_identity(context.actor.account_id, context.library_id) != recipe.business_identity(context.actor.account_id, context.library_id):
            raise PlaylistError("source_changed", 409)
        # A different session uses this fresh source/key, never the old receipt.
        _confirm(owner, connection, context, recipe, basis, constraints,
                 required_ids=[row["original_local_track_id"] for row in rows])
        _fence(owner, connection, context, constraints, source=source, playlist=playlist)
        return owner._receipt(context, command, ref, playlist["revision"], False,
                              added_count=0, creation_outcome="existing")
    ref = str(uuid4())
    connection.execute("""insert into app.playlists(ref,owner_account_id,library_id,title,description)
        values(%s,%s,%s,%s,%s)""", (ref, context.actor.account_id, context.library_id,
        command.data["title"], command.data["description"]))
    owner._insert_items(connection, context, ref, rows, offset=0, source=source)
    connection.execute("""insert into app.playlist_artist_loved_recipes
        (playlist_ref,library_id,owner_account_id,recipe_version,root_artist_id,
         scope_mode,playback_order,last_evaluated_at)
        values(%s,%s,%s,1,%s,%s,%s,%s)""", (ref, context.library_id, context.actor.account_id,
        recipe.root_artist_id, recipe.scope_mode, command.data.get("mix_playback_order", recipe.playback_order),
        datetime.fromisoformat(source["origin_descriptor"]["evaluated_at"])))
    _confirm(owner, connection, context, recipe, basis, constraints,
             required_ids=[row["original_local_track_id"] for row in rows])
    _fence(owner, connection, context, constraints, source=source)
    return owner._receipt(context, command, ref, 1, True, added_count=len(rows), creation_outcome="created")


def retire(connection, context, playlist_ref):
    connection.execute("""update app.playlist_artist_loved_recipes set retired_at=now()
        where playlist_ref=%s and library_id=%s and owner_account_id=%s and retired_at is null""",
        (playlist_ref, context.library_id, context.actor.account_id))


def refresh_owned(owner, context, playlist_ref, *, constraints=None):
    """Evaluate own taste, then lock/recheck the parent before atomic replacement."""
    import psycopg
    try:
        with owner._authorized(context, constraints) as (connection, live, _now):
            parent = connection.execute("""select * from app.playlists
                where ref=%s and library_id=%s and owner_account_id=%s and deleted_at is null""",
                (playlist_ref, live.library_id, live.actor.account_id)).fetchone()
            if parent is None:
                return {"refresh_status": "owner_refresh_required"}
            owner._require(live, (BROWSE,), constraints, dict(parent))
            stored = load_recipes(connection, live.library_id, [playlist_ref]).get(playlist_ref)
            if stored is None:
                return {"refresh_status": "last_computed"}
            recipe = recipe_from_row(stored)
            desired, basis, ordered_ids = _evaluate(owner, connection, live, recipe, constraints, allow_missing=True)
            playlist = owner._playlist(connection, live, playlist_ref, write=True)
            owner._require(live, (BROWSE,), constraints, playlist, owner_only=True)
            current = playlist.get("artist_loved")
            if current is None or recipe_from_row(current) != recipe:
                raise PlaylistError("source_changed", 409)
            final = _confirm(owner, connection, live, recipe, basis, constraints,
                required_ids=[row["original_local_track_id"] for row in desired],
                complete=True, allow_missing=True)
            if final is None:
                desired = []
            elif _love_ids(connection, live, ordered_ids) != tuple(
                    row["original_local_track_id"] for row in desired):
                # Canonical preference writes have their own transaction owner;
                # the Playlist actor lock alone does not freeze current taste.
                raise PlaylistError("source_changed", 409)
            old = connection.execute("select * from app.playlist_items where playlist_ref=%s order by position",
                                     (playlist_ref,)).fetchall()
            identities = [row["original_local_track_id"] for row in desired]
            changed = [row["local_track_id"] for row in old] != identities
            now = _fence(owner, connection, live, constraints, playlist=playlist)
            if changed:
                desired_set = set(identities)
                kept = {row["local_track_id"] for row in old if row["local_track_id"] in desired_set}
                removed = [str(row["ref"]) for row in old if row["local_track_id"] not in kept]
                if removed:
                    connection.execute("delete from app.playlist_items where playlist_ref=%s and ref=any(%s::uuid[])",
                                       (playlist_ref, removed))
                owner._insert_items(connection, live, playlist_ref,
                    [row for row in desired if row["original_local_track_id"] not in kept], offset=len(old))
                rows = connection.execute("select ref,local_track_id from app.playlist_items where playlist_ref=%s",
                                          (playlist_ref,)).fetchall()
                by_track = {row["local_track_id"]: str(row["ref"]) for row in rows}
                owner._set_order(connection, playlist_ref, [by_track[identity] for identity in identities])
                connection.execute("update app.playlists set revision=revision+1,updated_at=now() where ref=%s",
                                   (playlist_ref,))
            connection.execute("""update app.playlist_artist_loved_recipes
                set last_evaluated_at=%s,root_state=%s where playlist_ref=%s""",
                (now, "root_missing" if final is None else "present", playlist_ref))
            _fence(owner, connection, live, constraints, playlist=playlist)
            return {"refresh_status": "current"}
    except PlaylistError as error:
        if error.code == "artist_loved_too_large":
            return {"refresh_status": "too_large"}
        if error.code in {"artist_loved_unavailable", "source_changed", "concurrent_change"}:
            return {"refresh_status": "unavailable"}
        raise
    except psycopg.OperationalError:
        # Transaction context has rolled back every proposed item/state update.
        # Programming/schema errors deliberately propagate; no missing-schema fallback.
        return {"refresh_status": "unavailable"}
