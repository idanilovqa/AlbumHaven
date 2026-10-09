"""Complete bounded selection receipts, separate from paged catalogue search."""
from uuid import uuid4
from music_app.services.policy import ResourceScope

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.owned_playlists import (
    BROWSE, CREATE, COMPLETE_INVENTORY_PROTOCOL, COMPLETE_ACTIVITY_PROTOCOL, MAX_PLAYLIST_ITEMS_PER_COMMAND,
    PlaylistError, inventory_identity, uuid_ref,
)
from music_app.services import playlist_creation_sources_postgres as sources


def inventory_selection_refs(value, library_id):
    if not isinstance(value,list) or not 1 <= len(value) <= MAX_PLAYLIST_ITEMS_PER_COMMAND:
        raise PlaylistError("invalid_command")
    identities=[inventory_identity(ref) for ref in value]
    if any(library != library_id for library,_ in identities):
        raise PlaylistError("source_unavailable",404)
    ids=[track for _,track in identities]
    if len(set(ids)) != len(ids):
        raise PlaylistError("duplicate_identity",409)
    return ids


def _header(connection,context,now,*,protocol,kind,origin=None):
    from psycopg.types.json import Jsonb
    source={"ref":str(uuid4()),"revision":str(uuid4()),"library_id":context.library_id,
        "actor_account_id":context.actor.account_id,"session_id":context.actor.session_id,
        "expires_at":now+sources.SOURCE_LIFETIME,"inventory_upper_id":0,
        "protocol":protocol,"source_kind":kind,"origin_descriptor":origin}
    connection.execute("""insert into app.playlist_creation_sources
        (ref,revision,actor_account_id,session_id,library_id,protocol,expires_at,
         inventory_upper_id,source_kind,origin_descriptor)
        values(%(ref)s,%(revision)s,%(actor_account_id)s,%(session_id)s,%(library_id)s,
          %(protocol)s,%(expires_at)s,0,%(source_kind)s,%(origin_descriptor)s)""",
        {**source,"origin_descriptor":Jsonb(origin) if origin is not None else None})
    return source


class CompletePlaylistSources:
    def __init__(self,*,playlists):
        self._playlists=playlists
        self._config=dict(playlists._config)

    def from_inventory(self,context,track_refs,*,constraints=None):
        ids=inventory_selection_refs(track_refs,context.library_id)
        owner=self._playlists
        with owner._authorized(context,constraints) as (connection,live,_now):
            owner._require(live,(BROWSE,CREATE),constraints)
            if any(not owner._resource_allowed(live,BROWSE,ResourceScope("track",str(identity)),constraints) for identity in ids):
                raise PlaylistError("source_unavailable",404)
            current=sources.inventory_rows(connection,live.library_id,ids,lock=True,config=self._config)
            if set(current)!=set(ids):
                raise PlaylistError("source_changed",409)
            now=lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=owner._clock)
            source=_header(connection,live,now,protocol=COMPLETE_INVENTORY_PROTOCOL,kind="library")
            # _observe_page stores only these explicitly selected inventory rows;
            # no whole catalogue is copied and caller order is preserved.
            observed=sources._observe_page(connection,source,[current[identity] for identity in ids])
            from psycopg.types.json import Jsonb
            connection.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s",
                (Jsonb({"entry_order":[str(row["ref"]) for row in observed]}),source["ref"]))
            return {"status":"ready","data":{**sources.source_envelope(source),
                "entries_complete":True,"entries":[sources.project_entry(source,row,album_readable=lambda album_id:owner._resource_allowed(
                    live,BROWSE,ResourceScope("album",str(album_id)),constraints)) for row in observed],
                "retained_parent_albums":[],"actor_scope":owner._scope(live)}}

    def from_activity(self,context,origin,row_refs,*,constraints=None):
        from music_app.services import playlist_activity_sources as activity
        origin=activity.normalize_activity_origin(origin)
        if (not isinstance(row_refs,list) or not 1 <= len(row_refs) <= MAX_PLAYLIST_ITEMS_PER_COMMAND
                or any(not isinstance(ref,str) for ref in row_refs) or len(set(row_refs))!=len(row_refs)):
            raise PlaylistError("invalid_command")
        owner=self._playlists
        target=activity.lock_target(owner,context,origin=origin,constraints=constraints)
        with owner._authorized(context,constraints,target_account_id=target) as (connection,live,now):
            owner._require(live,(BROWSE,CREATE),constraints)
            source=_header(connection,live,now,protocol=COMPLETE_ACTIVITY_PROTOCOL,kind="activity",origin={"activity":origin})
            rows=activity.capture(connection,live,source,origin,row_refs,config=self._config,constraints=constraints)
            from psycopg.types.json import Jsonb
            connection.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s",
                (Jsonb({"activity":origin,"entry_order":[str(row["ref"]) for row in rows]}),source["ref"]))
            lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=owner._clock)
            return {"status":"ready","data":{**sources.source_envelope(source),
                "entries_complete":True,"entries":[sources.project_entry(source,row,
                    album_readable=lambda album_id:owner._resource_allowed(live,BROWSE,ResourceScope("album",str(album_id)),constraints)) for row in rows],
                "retained_parent_albums":[],"actor_scope":owner._scope(live)}}

    def read(self,context,*,ref,revision,protocol=COMPLETE_INVENTORY_PROTOCOL,constraints=None):
        owner=self._playlists
        ref,revision=uuid_ref(ref),uuid_ref(revision)
        target=None
        if protocol==COMPLETE_ACTIVITY_PROTOCOL:
            from music_app.services import playlist_activity_sources as activity
            target=activity.lock_target(owner,context,source_ref=ref,constraints=constraints)
        with owner._authorized(context,constraints,target_account_id=target) as (connection,live,now):
            owner._require(live,(BROWSE,CREATE),constraints)
            if protocol not in {COMPLETE_INVENTORY_PROTOCOL,COMPLETE_ACTIVITY_PROTOCOL}:
                raise PlaylistError("invalid_source_query")
            source=sources.load_source(connection,live,ref,revision,now,
                protocol=protocol,kind="activity" if protocol==COMPLETE_ACTIVITY_PROTOCOL else "library")
            rows=connection.execute("""select * from app.playlist_creation_entries
                where source_ref=%s order by created_at,ref""",(source["ref"],)).fetchall()
            # Complete selected sources need their exact authored order. The
            # immutable source origin holds only receipt IDs, not new authority.
            origin=source.get("origin_descriptor") or {}
            refs=origin.get("entry_order")
            if (not isinstance(refs,list) or len(refs)!=len(rows) or len(refs)>MAX_PLAYLIST_ITEMS_PER_COMMAND
                    or set(refs)!={str(row["ref"]) for row in rows}):
                raise PlaylistError("source_changed",409)
            if protocol==COMPLETE_ACTIVITY_PROTOCOL:
                from music_app.services import playlist_activity_sources as activity
                selected=activity.selected(connection,live,source,refs,config=self._config,constraints=constraints)
            else:
                if any(not owner._resource_allowed(live,BROWSE,ResourceScope("track",str(row["original_local_track_id"])),constraints) for row in rows):
                    raise PlaylistError("source_unavailable",404)
                selected=sources.selected_entries(connection,live,source,refs,config=self._config)
            now=lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=owner._clock)
            if source["expires_at"]<=now:
                raise PlaylistError("source_expired",410)
            return {"status":"ready","data":{**sources.source_envelope(source),
                "entries_complete":True,"entries":[sources.project_entry(source,row,album_readable=lambda album_id:owner._resource_allowed(
                    live,BROWSE,ResourceScope("album",str(album_id)),constraints)) for row in selected],
                "retained_parent_albums":[],"actor_scope":owner._scope(live)}}
