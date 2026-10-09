"""Transactional same-server Playlists; PostgreSQL is the sole durable authority."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
import json
from uuid import uuid4

from music_app.services.private_album_artwork import album_artwork_url
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from music_app.services.private_library_authority import current_library_transaction, PrivateLibraryAuthorityError
from music_app.services.owned_playlists import (
    BROWSE, CREATE, MANAGE, ITEMS, ACCESS, SETTINGS, PlaylistError, PlaylistCommand,
    command_actions, inventory_identity, normalize_playlist_command,
    require_playlist_authority, uuid_ref,
)
from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator
from music_app.services.postgres_connections import pooled_connection
from music_app.services.social_cursors import decode_social_cursor, encode_social_cursor
from music_app.services import playlist_creation_sources_postgres as sources


class PostgresOwnedPlaylistsService:
    def __init__(self, config, *, connect=None, clock=None):
        self._config = dict(config)
        self._url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._url:
            raise RuntimeError("Postgres configuration is required for Playlists.")
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    @contextmanager
    def _authorized(self, context, constraints, *, target_account_id=None, target_account_ids=()):
        # Shared library authority validates scope both before and after locks.
        try:
            with current_library_transaction(self._url,context,constraints=constraints,
                    connect=self._connect,clock=self._clock,target_account_id=target_account_id,target_account_ids=target_account_ids) as (connection,live,now):
                yield connection,live,now
        except (RecentAuthenticationRequired,PrivateLibraryAuthorityError):
            raise PlaylistError("forbidden", 403) from None
        except PlaylistError:
            raise
        except Exception as error:
            code = getattr(error, "sqlstate", None)
            if code in {"23505", "23503", "40001", "40P01"}:
                # The connection context has already rolled back. No automatic
                # mutation retry, partial acknowledgement or new operation key.
                reason = "duplicate_identity" if code == "23505" else "source_changed" if code == "23503" else "concurrent_change"
                raise PlaylistError(reason, 409) from None
            raise

    @staticmethod
    def _playlist(connection, context, playlist_ref, *, allow_deleted=False, write=False):
        # Lock the parent BEFORE reading editor eligibility. An EXISTS evaluated
        # before a lock wait could retain an editor grant just revoked by owner.
        row = connection.execute(f"""select * from app.playlists
            where ref=%s and library_id=%s for {"update" if write else "share"}""",
            (playlist_ref, context.library_id)).fetchone()
        if row is None:
            raise PlaylistError("playlist_unavailable", 404)
        playlist = dict(row)
        owner = playlist["owner_account_id"] == context.actor.account_id
        if playlist["deleted_at"] is not None and (not allow_deleted or not owner):
            raise PlaylistError("playlist_unavailable", 404)
        playlist["editor_grant"] = False
        if not owner:
            grant = connection.execute("""select ref from app.playlist_access_grants
                where playlist_ref=%s and library_id=%s and account_id=%s and role='editor'""",
                (playlist_ref, context.library_id, context.actor.account_id)).fetchone()
            playlist["editor_grant"] = grant is not None
        if not (owner or playlist["editor_grant"] or playlist["visibility"] == "server_shared"):
            raise PlaylistError("playlist_unavailable", 404)
        return playlist

    @staticmethod
    def _require(context, actions, constraints, playlist=None, *, owner_only=False):
        target = replace(context, resource=ResourceScope("playlist",str(playlist["ref"])) if playlist else None)
        authority = dict(owner_account_id=playlist["owner_account_id"] if playlist else None,
                         editor_grant=playlist.get("editor_grant", False) if playlist else False,
                         visibility=playlist["visibility"] if playlist else "private", owner_only=owner_only)
        if not callable(constraints):
            require_playlist_authority(target, required_actions=actions, constraints=constraints, **authority)
            return
        # Action-dependent deployment/origin/client constraints must be resolved
        # for the refreshed actor, including independently projected grants.
        browse = constraints(replace(target, action=BROWSE))
        for action in actions:
            specific = constraints(replace(target, action=action))
            if not isinstance(browse, PolicyEvaluationConstraints) or not isinstance(specific, PolicyEvaluationConstraints):
                raise RuntimeError("Playlist policy constraints are invalid.")
            combined = PolicyEvaluationConstraints(
                deployment_allowed=browse.deployment_allowed and specific.deployment_allowed,
                client_surface_allowed=browse.client_surface_allowed and specific.client_surface_allowed,
                request_origin_allowed=browse.request_origin_allowed and specific.request_origin_allowed)
            require_playlist_authority(target, required_actions=(BROWSE, action), constraints=combined, **authority)

    @staticmethod
    def _resource_allowed(context, action, resource, constraints):
        target = replace(context, action=action, resource=resource)
        specific = constraints(target) if callable(constraints) else constraints
        if specific is not None and not isinstance(specific, PolicyEvaluationConstraints):
            raise RuntimeError("Playlist policy constraints are invalid.")
        return PolicyEvaluator().evaluate(target, constraints=specific).decision.allowed

    def begin_source(self, context, *, constraints=None):
        with self._authorized(context, constraints) as (connection, live, now):
            self._require(live,(BROWSE,CREATE),constraints)
            data = sources.begin_source(connection, live, now)
            return {"status":"ready","data":{**data,"actor_scope":self._scope(live)}}

    def read_source_page(self, context, *, source_ref, source_revision, query="", cursor=None, limit=100, constraints=None):
        with self._authorized(context, constraints) as (connection, live, now):
            self._require(live,(BROWSE,CREATE),constraints)
            source = sources.load_source(connection,live,source_ref,source_revision,now)
            data = sources.search_entries(connection,live,source,query=query,cursor=cursor,limit=limit,
                is_readable=lambda track_id:self._resource_allowed(live,BROWSE,ResourceScope("track",str(track_id)),constraints),
                album_readable=lambda album_id:self._resource_allowed(live,BROWSE,ResourceScope("album",str(album_id)),constraints),config=self._config)
            current = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=self._clock)
            if source["expires_at"] <= current:
                raise PlaylistError("source_expired", 410)
            return {"status":"ready","data":{**data,"actor_scope":self._scope(live)}}

    @staticmethod
    def _scope(context):
        # The native boundary keeps this private; it is never request authority.
        return {"account_id":context.actor.account_id,"library_id":context.library_id}

    def execute(self, context, command: PlaylistCommand, *, constraints=None):
        # Treat even direct service callers as untrusted commands. A mutated
        # dataclass/dict cannot bypass validation or alter the checked digest.
        if not isinstance(command,PlaylistCommand):
            raise PlaylistError("invalid_command")
        command = normalize_playlist_command(command.action,
            {**command.data,"request_key":command.request_key},playlist_ref=command.playlist_ref)
        from music_app.services import playlist_queue_sources as queue
        queue_ref = (command.data["source"]["ref"] if command.action=="create" and command.data["source_protocol"]=="complete_inventory_selection_v1"
            else command.data.get("source_guard",{}).get("source",{}).get("ref"))
        queue_targets = queue.lock_targets(self,context,source_ref=queue_ref,constraints=constraints) if queue_ref else ()
        lock_target=command.data.get("account_id")
        if command.action == "decide_edit_request":
            if not isinstance(context,PolicyContext):
                raise PlaylistError("forbidden",403)
            with self._connect(self._url) as lookup:
                request = lookup.execute("""select requester_account_id from app.playlist_edit_requests
                    where ref=%s and playlist_ref=%s and library_id=%s""",
                    (command.data["request_ref"],command.playlist_ref,context.library_id)).fetchone()
                lock_target = request["requester_account_id"] if request else None
        if command.action=="create" and command.data["source"]["kind"]=="activity":
            from music_app.services import playlist_activity_sources as activity
            lock_target=activity.lock_target(self,context,source_ref=command.data["source"]["ref"],constraints=constraints)
        with self._authorized(context,constraints,target_account_id=lock_target,target_account_ids=queue_targets) as (connection,live,now):
            prior = connection.execute("""select * from app.playlist_operations
                where actor_account_id=%s and library_id=%s and request_key=%s for update""",
                (live.actor.account_id,live.library_id,command.request_key)).fetchone()
            if prior is not None:
                return self._replay(connection,live,prior,command,constraints)
            if command.action == "copy":
                from music_app.services import playlist_viewer_actions as viewers
                playlist = self._playlist(connection,live,command.playlist_ref,write=True)
                self._require(live,(BROWSE,),constraints,playlist)
                if str(playlist["revision"]) != command.data["revision"]:
                    raise PlaylistError("revision_conflict",409)
                receipt = viewers.copy_playlist(self,connection,live,command,playlist,constraints)
            elif command.action == "create":
                self._require(live,(BROWSE,CREATE),constraints)
                if command.data["source"]["kind"]=="playlist":
                    from music_app.services import playlist_missing_sources as missing
                    source=missing.source_for_command(connection,live,command,now)
                else:
                    source = sources.load_source(connection,live,command.data["source"]["ref"],command.data["source"]["revision"],now,
                        protocol=command.data["source_protocol"], kind=command.data["source"]["kind"])
                if queue.is_queue(source):
                    selected=queue.selected(self,connection,live,source,command.data["entry_refs"],constraints=constraints)
                elif source.get("source_kind")=="playlist":
                    selected=missing.selected(self,connection,live,source,command.data["entry_refs"],constraints=constraints)
                elif source.get("source_kind")=="activity":
                    from music_app.services import playlist_activity_sources as activity
                    selected=activity.selected(connection,live,source,command.data["entry_refs"],
                        config=self._config,constraints=constraints)
                else:
                    selected = sources.selected_entries(connection,live,source,command.data["entry_refs"],config=self._config)
                if any(not self._resource_allowed(live,BROWSE,ResourceScope("track",str(row["original_local_track_id"])),constraints)
                       for row in selected if row["original_local_track_id"] is not None):
                    raise PlaylistError("item_unavailable", 409)
                # Inventory/source waits must not retain an earlier session or
                # draft-expiry decision beyond the eventual mutation point.
                mutation_now = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                    actor_session_id=live.actor.session_id, clock=self._clock)
                if source["expires_at"] <= mutation_now:
                    raise PlaylistError("source_expired", 410)
                ref = str(uuid4())
                connection.execute("""insert into app.playlists(ref,owner_account_id,library_id,title,description)
                    values (%s,%s,%s,%s,%s)""",(ref,live.actor.account_id,live.library_id,command.data["title"],command.data["description"]))
                self._insert_items(connection,live,ref,selected,offset=0,source=source)
                receipt = self._receipt(live,command,ref,1,True,added_count=len(selected))
            else:
                guard_source=None
                guard_selected=None
                if command.action=="add" and "source_guard" in command.data:
                    guard=command.data["source_guard"]
                    guard_source=sources.load_source(connection,live,guard["source"]["ref"],guard["source"]["revision"],now,
                        protocol=guard["source_protocol"],kind="library")
                    guard_selected=queue.selected(self,connection,live,guard_source,guard["entry_refs"],
                        constraints=constraints,destination=command.playlist_ref)
                    expected=[f"inventory-track:{live.library_id}:{row['original_local_track_id']}" for row in guard_selected]
                    if expected!=command.data["track_refs"]:raise PlaylistError("source_changed",409)
                playlist = self._playlist(connection,live,command.playlist_ref,write=True)
                self._require(live,(BROWSE,MANAGE) if command.action == "save" else command_actions(command),
                    constraints,playlist, owner_only=command.action == "delete")
                if str(playlist["revision"]) != command.data["revision"]:
                    raise PlaylistError("revision_conflict",409)
                rows = (connection.execute("select * from app.playlist_items where playlist_ref=%s order by position",
                    (command.playlist_ref,)).fetchall() if command.action in {"save", "add", "remove", "reorder"} else [])
                order = [str(row["ref"]) for row in rows]
                requested_order = command.data.get("item_order")
                if requested_order is not None and (len(requested_order)!=len(order) or set(requested_order)!=set(order)):
                    raise PlaylistError("invalid_item_order",409)
                actions = command_actions(command)
                if command.action == "save" and requested_order == order:
                    actions = (BROWSE,MANAGE)
                self._require(live,actions,constraints,playlist)
                lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                    actor_session_id=live.actor.session_id, clock=self._clock)
                changed, counts = self._mutate(connection,live,command,playlist,rows,order,constraints=constraints,
                    source=guard_source,selected=guard_selected)
                revision = playlist["revision"]
                if changed:
                    updated = connection.execute("""update app.playlists set revision=revision+1,updated_at=now()
                        where ref=%s returning revision""",(command.playlist_ref,)).fetchone()
                    revision = updated["revision"]
                receipt = self._receipt(live,command,command.playlist_ref,revision,changed,**counts)
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=self._clock)
            # The receipt and every item are committed by this same connection
            # context. Returning from inside it cannot acknowledge a failed commit.
            connection.execute("""insert into app.playlist_operations
                (actor_account_id,library_id,request_key,original_session_id,action,playlist_ref,command_digest,receipt)
                values (%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                (live.actor.account_id,live.library_id,command.request_key,live.actor.session_id,
                 command.action,receipt["playlist_id"],command.digest,json.dumps(receipt)))
            return receipt

    def _replay(self,connection,context,prior,command,constraints):
        if prior["original_session_id"]!=context.actor.session_id:
            raise PlaylistError("operation_unavailable",404)
        if prior["command_digest"]!=command.digest or prior["action"]!=command.action:
            raise PlaylistError("idempotency_key_reused",409)
        playlist = self._playlist(connection,context,str(prior["playlist_ref"]),allow_deleted=True)
        self._require(context,(BROWSE,),constraints,playlist)
        lock_current_actor_session(connection, actor_account_id=context.actor.account_id,
            actor_session_id=context.actor.session_id, clock=self._clock)
        return dict(prior["receipt"])

    def read_operation(self,context,request_key,*,constraints=None):
        key=uuid_ref(request_key)
        with self._authorized(context,constraints) as (connection,live,_now):
            row=connection.execute("""select * from app.playlist_operations
                where actor_account_id=%s and library_id=%s and request_key=%s and original_session_id=%s""",
                (live.actor.account_id,live.library_id,key,live.actor.session_id)).fetchone()
            if row is None:
                return {"status":"unknown"}
            playlist=self._playlist(connection,live,str(row["playlist_ref"]),allow_deleted=True)
            self._require(live,(BROWSE,),constraints,playlist)
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=self._clock)
            return {"status":"committed","receipt":dict(row["receipt"])}

    @staticmethod
    def _receipt(context,command,ref,revision,changed,**counts):
        return {"ok":True,"action":command.action,"request_key":command.request_key,
                "playlist_id":str(ref),"revision":str(revision),"changed":changed,
                "actor_scope":PostgresOwnedPlaylistsService._scope(context),**counts}

    @staticmethod
    def _insert_items(connection,context,playlist_ref,rows,*,offset,source=None):
        if not rows:
            return
        values = []
        for index, row in enumerate(rows, start=offset + 1):
            values.append({
                "ref": str(uuid4()), "playlist_ref": str(playlist_ref), "library_id": context.library_id,
                "position": index, "original_local_track_id": row["original_local_track_id"],
                "local_track_id": row.get("validated_match_track_id", row["original_local_track_id"]),
                **{key: row.get(key) for key in ("title", "artist", "album_title", "original_album_id",
                                               "release_year", "disc_number", "track_number", "duration_seconds")},
                "source_ref": str(source["ref"]) if source else None,
                "source_entry_ref": str(row["ref"]) if source else None,
                "source_revision": str(source["revision"]) if source else None,
                "source_kind": source.get("source_kind","library") if source else "library",
                "source_label": row.get("source_label"),
                # Queue receipts authorize this transaction, not durable musical
                # provenance. Keep existing Activity/Playlist lineage intact.
                "source_lineage": (None if (row.get("source_lineage") or {}).get("queue")=="queue_occurrences_v1"
                    else row.get("source_lineage")),
            })
        connection.execute("""insert into app.playlist_items
            (ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,
             title,artist,album_title,original_album_id,release_year,disc_number,track_number,duration_seconds,
             source_ref,source_entry_ref,source_revision,source_kind,source_label,source_lineage)
            select ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,
             title,artist,album_title,original_album_id,release_year,disc_number,track_number,duration_seconds,
             source_ref,source_entry_ref,source_revision,source_kind,source_label,source_lineage
            from jsonb_to_recordset(%s::jsonb) as input(
             ref uuid,playlist_ref uuid,library_id bigint,position integer,original_local_track_id bigint,
             local_track_id bigint,title text,artist text,album_title text,original_album_id bigint,
             release_year integer,disc_number integer,track_number integer,duration_seconds numeric,
             source_ref uuid,source_entry_ref uuid,source_revision uuid,source_kind text,source_label text,source_lineage jsonb)""", (json.dumps(values, allow_nan=False),))

    @staticmethod
    def _set_order(connection,playlist_ref,order):
        # The deferred unique constraint permits in-place swaps without fake
        # temporary positions or changing stable item identities.
        connection.execute("""update app.playlist_items i set position=o.position
            from unnest(%s::uuid[]) with ordinality as o(ref,position)
            where i.playlist_ref=%s and i.ref=o.ref""",(order,playlist_ref))

    def _mutate(self,connection,context,command,playlist,rows,order,*,constraints=None,source=None,selected=None):
        data=command.data
        from music_app.services import playlist_viewer_actions as viewers
        if command.action == "request_edit":
            return viewers.request_edit(self,connection,context,command,playlist,constraints)
        if command.action == "decide_edit_request":
            return viewers.decide(self,connection,context,command,playlist,constraints)
        if command.action == "delete":
            viewers.invalidate(connection,command.playlist_ref)
            connection.execute("update app.playlists set deleted_at=now() where ref=%s", (command.playlist_ref,))
            return True, {"deleted": True}
        if command.action == "default_sort":
            changed = playlist["default_sort"] != data["sort"]
            if changed:
                connection.execute("update app.playlists set default_sort=%s::jsonb where ref=%s",
                    (json.dumps(data["sort"]) if data["sort"] is not None else None, command.playlist_ref))
            return changed, {"saved_default_sort": data["sort"]}
        if command.action == "visibility":
            changed = playlist["visibility"] != data["visibility"]
            if changed:
                if data["visibility"] == "private":
                    viewers.invalidate(connection,command.playlist_ref)
                connection.execute("update app.playlists set visibility=%s where ref=%s",
                                   (data["visibility"], command.playlist_ref))
            return changed, {"visibility": data["visibility"]}
        if command.action == "grant_editor":
            if data["account_id"] == playlist["owner_account_id"]:
                raise PlaylistError("invalid_editor", 409)
            member = connection.execute("""select a.id from app.accounts a
                join library.library_memberships m on m.account_id=a.id
                where a.id=%s and m.library_id=%s and a.is_active=true and a.disabled_at is null
                for share of a,m""", (data["account_id"], context.library_id)).fetchone()
            if member is None:
                raise PlaylistError("grant_target_unavailable", 404)
            prior = connection.execute("""select ref from app.playlist_access_grants
                where playlist_ref=%s and account_id=%s""",
                (command.playlist_ref, data["account_id"])).fetchone()
            if prior is not None:
                viewers.invalidate(connection,command.playlist_ref,account_id=data["account_id"],status="approved")
                return False, {"grant_ref": str(prior["ref"])}
            lock_current_actor_session(connection, actor_account_id=context.actor.account_id,
                actor_session_id=context.actor.session_id, clock=self._clock)
            grant_ref = str(uuid4())
            connection.execute("""insert into app.playlist_access_grants
                (ref,playlist_ref,library_id,account_id,role) values (%s,%s,%s,%s,'editor')""",
                (grant_ref, command.playlist_ref, context.library_id, data["account_id"]))
            viewers.invalidate(connection,command.playlist_ref,account_id=data["account_id"],status="approved")
            return True, {"grant_ref": grant_ref}
        if command.action == "revoke_editor":
            row = connection.execute("""delete from app.playlist_access_grants
                where ref=%s and playlist_ref=%s and library_id=%s returning ref""",
                (data["grant_ref"], command.playlist_ref, context.library_id)).fetchone()
            if row is None:
                raise PlaylistError("grant_unavailable", 404)
            return True, {"grant_ref": str(row["ref"])}
        if command.action == "save":
            title=data.get("title",playlist["title"])
            description=data.get("description",playlist["description"])
            metadata_changed=title!=playlist["title"] or description!=playlist["description"]
            desired=data.get("item_order",order)
            order_changed=desired!=order
            if metadata_changed:
                connection.execute("update app.playlists set title=%s,description=%s where ref=%s",(title,description,command.playlist_ref))
            if order_changed:
                self._set_order(connection,command.playlist_ref,desired)
            return metadata_changed or order_changed,{}
        if command.action == "reorder":
            changed=data["item_order"]!=order
            if changed:
                self._set_order(connection,command.playlist_ref,data["item_order"])
            return changed,{}
        if command.action == "remove":
            refs=data["item_refs"]
            if not set(refs)<=set(order):
                raise PlaylistError("item_unavailable",409)
            connection.execute("delete from app.playlist_items where playlist_ref=%s and ref=any(%s::uuid[])",(command.playlist_ref,refs))
            removed = set(refs)
            self._set_order(connection,command.playlist_ref,[ref for ref in order if ref not in removed])
            return True,{"removed_count":len(refs)}
        identities=[inventory_identity(ref) for ref in data["track_refs"]]
        if any(library_id!=context.library_id for library_id,_ in identities):
            raise PlaylistError("item_unavailable",409)
        ids=[track_id for _,track_id in identities]
        if len(set(ids))!=len(ids) or set(ids)&{row["original_local_track_id"] for row in rows}:
            raise PlaylistError("duplicate_identity",409)
        if any(not self._resource_allowed(context,BROWSE,ResourceScope("track",str(track_id)),constraints) for track_id in ids):
            raise PlaylistError("item_unavailable",409)
        if source is not None:
            mutation_now=lock_current_actor_session(connection,actor_account_id=context.actor.account_id,
                actor_session_id=context.actor.session_id,clock=self._clock)
            if source["expires_at"]<=mutation_now:raise PlaylistError("source_expired",410)
            self._insert_items(connection,context,command.playlist_ref,selected,offset=len(order),source=source)
            return True,{"added_count":len(ids)}
        current=sources.inventory_rows(connection,context.library_id,ids,lock=True,config=self._config)
        if len(current)!=len(ids) or any(row["availability"]!="local" for row in current.values()):
            raise PlaylistError("item_unavailable",409)
        lock_current_actor_session(connection, actor_account_id=context.actor.account_id,
            actor_session_id=context.actor.session_id, clock=self._clock)
        self._insert_items(connection,context,command.playlist_ref,[current[track_id] for track_id in ids],offset=len(order))
        return True,{"added_count":len(ids)}

    def read(self,context,*,playlist_ref=None,query="",constraints=None):
        if playlist_ref is not None:
            playlist_ref=uuid_ref(playlist_ref)
        if not isinstance(query,str) or len(query)>200:
            raise PlaylistError("invalid_source_query")
        with self._authorized(context,constraints) as (connection,live,_now):
            playlists=connection.execute("""select p.* from app.playlists p
                where p.library_id=%s and p.deleted_at is null and
                  (p.owner_account_id=%s or p.visibility='server_shared' or exists (
                    select 1 from app.playlist_access_grants g where g.playlist_ref=p.ref
                      and g.library_id=p.library_id and g.account_id=%s and g.role='editor'))
                order by p.ref for share of p""",
                (live.library_id,live.actor.account_id,live.actor.account_id)).fetchall()
            refs = [str(row["ref"]) for row in playlists]
            # Fresh statements after parent lock waits: a revoked editor cannot
            # retain an old EXISTS result and item counts match locked content.
            editors = {str(row["playlist_ref"]) for row in connection.execute("""
                select playlist_ref from app.playlist_access_grants
                where library_id=%s and account_id=%s and playlist_ref=any(%s::uuid[]) and role='editor'""",
                (live.library_id,live.actor.account_id,refs)).fetchall()}
            counts = {str(row["playlist_ref"]):row["item_count"] for row in connection.execute("""
                select playlist_ref,count(*) as item_count from app.playlist_items
                where playlist_ref=any(%s::uuid[]) group by playlist_ref""", (refs,)).fetchall()}
            projected = [{**row,"editor_grant":str(row["ref"]) in editors,
                          "item_count":counts.get(str(row["ref"]),0)} for row in playlists]
            projected.sort(key=lambda row:(row["updated_at"],str(row["ref"])),reverse=True)
            cards=[self._card(live,row,constraints) for row in projected
                   if row["deleted_at"] is None and self._allows(live,(BROWSE,),constraints,row)]
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=self._clock)
            payload={"playlist_actions":{"can_create":self._allows(live,(BROWSE,CREATE),constraints)},
                "playlist_creation_protocol":"library_selection_v1", "actor_scope":self._scope(live),
                "playlist_sidebar":{"active_playlist_id":playlist_ref or "","items":[
                    {"playlist_id":card["playlist_id"],"title":card["title"],"item_count":card["item_count"],
                     "is_active":card["playlist_id"]==playlist_ref,"allowed_actions":{"can_open":True}} for card in cards]}}
            if playlist_ref is None:
                folded=query.strip().casefold()
                payload["playlist_index"]={"query":query,"playlists":[card for card in cards if folded in card["title"].casefold()]}
                return payload
            playlist=self._playlist(connection,live,playlist_ref)
            self._require(live,(BROWSE,),constraints,playlist)
            rows=connection.execute("select * from app.playlist_items where playlist_ref=%s order by position",(playlist_ref,)).fetchall()
            current=sources.inventory_rows(connection,live.library_id,[row["local_track_id"] for row in rows
                if row["local_track_id"] is not None and self._resource_allowed(live,BROWSE,ResourceScope("track",str(row["local_track_id"])),constraints)],config=self._config)
            card=self._card(live,{**playlist,"item_count":len(rows)},constraints)
            tracks=[self._track_row(live,row,current.get(row["local_track_id"]),constraints=constraints) for row in rows]
            payload["playlist_detail"]={**card,"items_complete":True,"query":"",
                "active_sort":{"key":"playlist_position","direction":"asc"},"saved_default_sort":playlist["default_sort"],
                "allowed_actions":{**card["allowed_actions"],"can_play":any(row["allowed_actions"]["can_play"] for row in tracks),
                    "can_inspect_missing":self._allows(live,(BROWSE,CREATE),constraints) and any(row["availability"]=="missing" for row in tracks)},
                "track_rows":tracks}
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=self._clock)
            return payload

    def read_sharing(self,context,playlist_ref,*,cursor_secret=None,cursor=None,constraints=None):
        from music_app.services import playlist_viewer_actions as viewers
        ref = uuid_ref(playlist_ref)
        with self._authorized(context,constraints) as (connection,live,_now):
            playlist = self._playlist(connection,live,ref)
            self._require(live,(BROWSE,),constraints,playlist)
            manage = self._allows(live,(BROWSE,ACCESS),constraints,playlist,owner_only=True)
            row = connection.execute("""select status from app.playlist_edit_requests
                where playlist_ref=%s and requester_account_id=%s order by id desc limit 1""",
                (ref,live.actor.account_id)).fetchone()
            scope=["playlist-sharing-requests-v1",live.actor.account_id,live.actor.session_id,live.library_id,ref]
            try:
                after=decode_social_cursor(cursor,secret=cursor_secret,scope=scope)
            except ValueError:
                raise PlaylistError("invalid_cursor") from None
            if cursor is not None and not manage:
                raise PlaylistError("forbidden",403)
            pending,after = viewers.pending(self,connection,live,constraints,playlist_ref=ref,after=after,limit=100) if manage else ([],None)
            lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=self._clock)
            return {"playlist_id":ref,"revision":str(playlist["revision"]),"visibility":playlist["visibility"],
                "can_manage":manage,"can_request_edit":playlist["owner_account_id"]!=live.actor.account_id and not playlist["editor_grant"],
                "can_copy":self._allows(live,(BROWSE,CREATE),constraints),
                "request_status":row["status"] if row and row["status"]!="revoked" else "none",
                "pending_requests":pending,"next_pending_cursor":encode_social_cursor(after,secret=cursor_secret,scope=scope),
                "actor_scope":self._scope(live)}

    def read_edit_requests(self,context,*,cursor_secret,cursor=None,limit=50,constraints=None):
        from music_app.services import playlist_viewer_actions as viewers
        if type(limit) is not int or not 1<=limit<=100:
            raise PlaylistError("invalid_access_query")
        with self._authorized(context,constraints) as (connection,live,_now):
            self._require(live,(BROWSE,),constraints)
            scope=["playlist-edit-requests-v1",live.actor.account_id,live.actor.session_id,live.library_id]
            try:
                after=decode_social_cursor(cursor,secret=cursor_secret,scope=scope)
            except ValueError:
                raise PlaylistError("invalid_cursor") from None
            rows,after=viewers.pending(self,connection,live,constraints,after=after,limit=limit)
            lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=self._clock)
            return {"requests":rows,"next_cursor":encode_social_cursor(after,secret=cursor_secret,scope=scope),
                "actor_scope":self._scope(live)}

    def read_access(self,context,playlist_ref,*,constraints=None):
        ref = uuid_ref(playlist_ref)
        with self._authorized(context,constraints) as (connection,live,_now):
            playlist = self._playlist(connection,live,ref)
            self._require(live,(BROWSE,ACCESS),constraints,playlist,owner_only=True)
            grants = connection.execute("""select g.ref,g.account_id,g.role,p.account_ref::text,
                    a.display_name,a.username_display,(a.is_active and a.disabled_at is null) as is_active
                from app.playlist_access_grants g join app.accounts a on a.id=g.account_id
                join app.social_profiles p on p.account_id=a.id
                join library.library_memberships m on m.account_id=g.account_id and m.library_id=g.library_id
                where g.playlist_ref=%s and g.library_id=%s
                order by g.account_id""", (ref,live.library_id)).fetchall()
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=self._clock)
            return {"playlist_id":ref,"revision":str(playlist["revision"]),
                    "visibility":playlist["visibility"],"actor_scope":self._scope(live),
                    "grants":[{"grant_ref":str(row["ref"]),"account_id":row["account_id"],
                               "account_ref":row["account_ref"],"display_name":row["display_name"],
                               "username_display":row["username_display"],"is_active":row["is_active"],
                               "role":row["role"]} for row in grants]}

    def read_access_candidates(self,context,playlist_ref,*,cursor_secret,query="",cursor=None,limit=50,constraints=None):
        ref = uuid_ref(playlist_ref)
        if (not isinstance(query,str) or len(query)>100 or "\0" in query
                or any("\ud800"<=char<="\udfff" for char in query)
                or type(limit) is not int or not 1<=limit<=100):
            raise PlaylistError("invalid_access_query")
        with self._authorized(context,constraints) as (connection,live,_now):
            playlist = self._playlist(connection,live,ref)
            self._require(live,(BROWSE,ACCESS),constraints,playlist,owner_only=True)
            scope = ["playlist-access-candidates-v1",live.actor.account_id,live.actor.session_id,
                     live.library_id,ref,query]
            try:
                after = decode_social_cursor(cursor,secret=cursor_secret,scope=scope)
            except ValueError:
                raise PlaylistError("invalid_cursor") from None
            # This is a Playlist recipient directory, not Social discovery.
            # social_profiles supplies only the existing stable account UUID.
            rows = connection.execute("""select a.id as account_id,p.account_ref::text,
                    a.display_name,a.username_display,g.ref as grant_ref,g.role
                from app.accounts a join app.social_profiles p on p.account_id=a.id
                join library.library_memberships m on m.account_id=a.id and m.library_id=%(library_id)s
                left join app.playlist_access_grants g on g.account_id=a.id
                    and g.library_id=m.library_id and g.playlist_ref=%(playlist_ref)s
                where a.id<>%(owner_id)s and a.id>%(after)s and a.is_active and a.disabled_at is null
                    and (a.display_name ilike %(query)s or a.username_display ilike %(query)s)
                order by a.id limit %(limit)s""", {
                    "library_id":live.library_id,"playlist_ref":ref,"owner_id":playlist["owner_account_id"],
                    "after":after,"limit":limit+1,
                    "query":"%"+query.replace("\\","\\\\").replace("%","\\%").replace("_","\\_")+"%",
                }).fetchall()
            candidates = [{"account_ref":row["account_ref"],"account_id":row["account_id"],
                "display_name":row["display_name"],"username_display":row["username_display"],
                "grant_ref":str(row["grant_ref"]) if row["grant_ref"] is not None else None,"role":row["role"],
                "allowed_actions":{"can_grant_editor":row["grant_ref"] is None}} for row in rows[:limit]]
            next_cursor = encode_social_cursor(candidates[-1]["account_id"] if len(rows)>limit else None,
                secret=cursor_secret,scope=scope)
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=self._clock)
            return {"playlist_id":ref,"revision":str(playlist["revision"]),"candidates":candidates,
                    "next_cursor":next_cursor,"actor_scope":self._scope(live)}

    @classmethod
    def _allows(cls,context,actions,constraints,playlist=None,*,owner_only=False):
        try:
            cls._require(context,actions,constraints,playlist,owner_only=owner_only)
            return True
        except PlaylistError:
            return False

    @classmethod
    def _card(cls,context,row,constraints):
        manage=cls._allows(context,(BROWSE,MANAGE),constraints,row)
        items=cls._allows(context,(BROWSE,ITEMS),constraints,row)
        settings=cls._allows(context,(BROWSE,SETTINGS),constraints,row)
        access=cls._allows(context,(BROWSE,ACCESS),constraints,row,owner_only=True)
        delete=cls._allows(context,(BROWSE,MANAGE),constraints,row,owner_only=True)
        return {"playlist_id":str(row["ref"]),"title":row["title"],"description":row["description"],
                "revision":str(row["revision"]),"item_count":int(row["item_count"]),"visibility":row["visibility"],"playlist_kind":"manual",
                "allowed_actions":{"can_open":True,"can_read":True,"can_export":True,
                    "can_edit":manage,"can_rename":manage,"can_reorder":items,"can_add":items,"can_remove":items,
                    "can_delete":delete,"can_play":False,"can_share":access,
                    "can_view_sharing":True,
                    "can_request_edit":row["owner_account_id"]!=context.actor.account_id and not row.get("editor_grant",False),
                    "can_copy":cls._allows(context,(BROWSE,CREATE),constraints),"can_save_default_sort":settings,"can_create_album_top":False,"can_create_sample":False}}

    @classmethod
    def _track_row(cls,context,row,current,*,constraints=None):
        readable = bool(current) and cls._resource_allowed(context,BROWSE,
            ResourceScope("track",str(row["local_track_id"])),constraints)
        play = readable and current["availability"] == "local" and cls._resource_allowed(context,
            "library.media.read",ResourceScope("track",str(row["local_track_id"])),constraints)
        album_id = current.get("original_album_id") if readable else None
        details = album_id is not None and cls._resource_allowed(context,BROWSE,
            ResourceScope("album",str(album_id)),constraints)
        return {"playlist_item_id":str(row["ref"]),"playlist_position":row["position"],
                "title":row["title"],"artist":row["artist"],"album_title":row["album_title"],
                "disc_number":row["disc_number"],"track_number":row["track_number"],
                "duration_seconds":float(row["duration_seconds"]) if row["duration_seconds"] is not None else None,
                "year":row["release_year"],"availability":current["availability"] if readable else "unresolved",
                "inventory_track_ref":f"inventory-track:{context.library_id}:{row['local_track_id']}" if readable else None,
                "album_ref":f"inventory-album:{context.library_id}:{album_id}" if details else None,
                "artwork_url":album_artwork_url(context,album_id,constraints=constraints) if details else None,
                "canonical_track_ref":None,"source_readable":True,"metadata_state":"last_known",
                "source_kind":row.get("source_kind","library"),"source_label":row.get("source_label"),
                "source_ref":str(row["source_ref"]) if row["source_ref"] else None,
                "allowed_actions":{"can_read":True,"can_play":play,"can_view_details":details}}
