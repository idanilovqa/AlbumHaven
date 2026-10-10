"""Transactional authenticated Album Tops over the shared catalog/artifact boundary."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4

from music_app.services.owned_album_tops import (
    AlbumTopError, AlbumTopCommand, BROWSE, CREATE, MANAGE, ITEMS, ACCESS, PROGRESS, MAX_TOP_ITEMS,
    command_actions, require_top_authority, top_uuid, normalize_top_command,
    normalize_top_publication_preview,
)
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services import album_top_viewer_actions as viewers
from music_app.services import album_top_progress as progress
from music_app.services import album_top_publication as publication
from music_app.services import album_top_publication_evidence as publication_evidence
from music_app.services.postgres_connections import pooled_connection
from music_app.services.social_cursors import encode_social_cursor
from music_app.services.private_library_authority import (
    current_library_transaction, PrivateLibraryAuthorityError,
)


class PostgresOwnedAlbumTopsService:
    def __init__(self, config, *, connect=None, clock=None):
        self._config = config
        self._url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._url:
            raise RuntimeError("PostgreSQL configuration is required for Album Tops.")
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    @contextmanager
    def _authorized(self, context, constraints, *, target_account_id=None):
        try:
            with current_library_transaction(self._url, context, constraints=constraints,
                    connect=self._connect, clock=self._clock, target_account_id=target_account_id) as transaction:
                yield transaction
                connection, live, _ = transaction
                # A database lock may outlive the session expiry checked on entry.
                # Recheck before either a response or a mutation can escape commit.
                lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                    actor_session_id=live.actor.session_id, clock=self._clock)
        except PrivateLibraryAuthorityError:
            raise AlbumTopError("forbidden", 403) from None
        except AlbumTopError:
            raise
        except Exception as error:
            code = getattr(error, "sqlstate", None)
            if code in {"23505", "23503", "40001", "40P01"}:
                raise AlbumTopError("concurrent_change", 409) from None
            raise

    @staticmethod
    def _require(context, actions, constraints, top=None, *, owner_only=False):
        if not isinstance(context, PolicyContext):
            raise AlbumTopError("forbidden", 403)
        target = replace(context, resource=ResourceScope("album_top", str(top["ref"])) if top else None)
        require_top_authority(target, required_actions=actions,
            owner_account_id=top["owner_account_id"] if top else None,
            editor_grant=top.get("editor_grant", False) if top else False,
            visibility=top["visibility"] if top else "private",
            owner_only=owner_only, constraints=constraints)

    @staticmethod
    def _top(connection, context, ref, *, write=False, allow_deleted=False):
        # A grant read embedded in the locking query could survive an owner
        # revocation while waiting. Read eligibility only AFTER the parent lock.
        row = connection.execute("""select * from app.album_lists where ref=%s
            and library_id=%s for """ + ("update" if write else "share"),
            (ref, context.library_id)).fetchone()
        if row is None:
            raise AlbumTopError("top_unavailable", 404)
        top = dict(row)
        owner = top["owner_account_id"] == context.actor.account_id
        if top["deleted_at"] is not None and (not allow_deleted or not owner):
            raise AlbumTopError("top_unavailable", 404)
        top["editor_grant"] = False
        if not owner:
            top["editor_grant"] = connection.execute("""select ref from app.album_list_access_grants
                where top_ref=%s and library_id=%s and account_id=%s and role='editor'""",
                (ref, context.library_id, context.actor.account_id)).fetchone() is not None
        if not (owner or top["editor_grant"] or top["visibility"] == "server_shared"):
            raise AlbumTopError("top_unavailable", 404)
        return top

    def _allows(self, context, actions, constraints, top=None, *, owner_only=False):
        try:
            self._require(context, actions, constraints, top, owner_only=owner_only)
            return True
        except AlbumTopError as error:
            if error.status_code != 403:
                raise
            return False

    def _actions(self, context, constraints, top=None):
        actions = {action: True for action in ((BROWSE, MANAGE, ITEMS) if top else (BROWSE, CREATE))
                   if self._allows(context, tuple(dict.fromkeys((BROWSE, action))), constraints, top)}
        if top is None:
            return {**actions, "can_create": actions.get(CREATE, False)}
        read, manage, items = (actions.get(action, False) for action in (BROWSE, MANAGE, ITEMS))
        return {**actions, "can_read": read, "can_edit": manage, "can_rename": manage,
                "can_add": items, "can_remove": items, "can_reorder": items,
                "can_delete": self._allows(context, (BROWSE, MANAGE), constraints, top, owner_only=True),
                "can_share": self._allows(context, (BROWSE, ACCESS), constraints, top, owner_only=True),
                "can_view_sharing": read,
                "can_manage_own_progress": self._allows(context, (BROWSE, PROGRESS), constraints, top),
                "can_request_edit": read and top["visibility"] == "server_shared"
                    and top["owner_account_id"] != context.actor.account_id and not top.get("editor_grant", False),
                "can_copy": read and self._allows(context, (BROWSE, CREATE), constraints)}

    def list(self, context, *, cursor_secret, cursor=None, limit=50, constraints=None):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise AlbumTopError("invalid_query")
        with self._authorized(context, constraints) as (connection, live, _):
            self._require(live, (BROWSE,), constraints)
            scope = ["album-top-index-v1", live.actor.account_id, live.actor.session_id, live.library_id]
            after = viewers.page_position(cursor, cursor_secret, scope)
            rows = connection.execute("""select p.ref,p.id from app.album_lists p
                where p.library_id=%s and p.deleted_at is null and p.id>%s
                  and (p.owner_account_id=%s or p.visibility='server_shared' or exists(
                    select 1 from app.album_list_access_grants g where g.top_ref=p.ref
                      and g.library_id=p.library_id and g.account_id=%s and g.role='editor'))
                order by p.id limit %s""",
                (live.library_id, after, live.actor.account_id, live.actor.account_id, limit + 1)).fetchall()
            tops = []
            for row in rows[:limit]:
                try:
                    top = self._top(connection, live, str(row["ref"]))
                except AlbumTopError as error:
                    if error.status_code != 404:
                        raise
                    continue
                actions = self._actions(live, constraints, top)
                if actions["can_read"]:
                    tops.append({"top_ref": str(top["ref"]), "title": top["title"],
                        "description": top["description"], "revision": str(top["revision"]),
                        "visibility": top["visibility"], "allowed_actions": actions})
            return {"tops": tops, "allowed_actions": self._actions(live, constraints),
                "next_cursor": encode_social_cursor(rows[limit - 1]["id"] if len(rows) > limit else None,
                                                     secret=cursor_secret, scope=scope)}

    def admit_inventory_album(self, context, *, album_id, constraints=None):
        """Admit current inventory evidence without deduping display names or editions."""
        if type(album_id) is not int or album_id <= 0 or album_id > 9223372036854775807:
            raise AlbumTopError("invalid_command")
        with self._authorized(context, constraints) as (connection, live, _):
            self._require(live, (BROWSE, CREATE), constraints)
            from music_app.services.private_library_authority import require_private_action
            require_private_action(live, BROWSE, resource=ResourceScope("album", str(album_id)), constraints=constraints)
            row = connection.execute("""select a.title,a.release_year,ar.name as artist_display
                from library.local_albums a join library.local_artists ar
                  on ar.id=a.artist_id and ar.library_id=a.library_id
                where a.id=%s and a.library_id=%s for update of a""",
                (album_id, live.library_id)).fetchone()
            if row is None:
                raise AlbumTopError("album_unavailable", 404)
            existing = connection.execute("""select catalog_ref from library.catalog_album_links
                where library_id=%s and local_album_id=%s""", (live.library_id, album_id)).fetchone()
            if existing:
                return {"album_ref": str(existing["catalog_ref"])}
            title, artist = row["title"], row["artist_display"]
            if any(not isinstance(value, str) or not value.strip() or len(value) > 1000 for value in (title, artist)):
                raise AlbumTopError("album_metadata_unresolved", 409)
            ref = str(uuid4())
            year = row["release_year"]
            connection.execute("""insert into catalog.release_groups(ref,title,artist_display,release_year)
                values(%s,%s,%s,%s)""", (ref, title, artist, year if type(year) is int and 1 <= year <= 9999 else None))
            connection.execute("""insert into library.catalog_album_links(library_id,local_album_id,catalog_ref)
                values(%s,%s,%s)""", (live.library_id, album_id, ref))
            return {"album_ref": ref}

    @staticmethod
    def _catalog(connection, context, refs, constraints):
        if not refs:
            return
        rows = connection.execute("""select l.catalog_ref,l.local_album_id
            from library.catalog_album_links l join library.local_albums a
              on a.id=l.local_album_id and a.library_id=l.library_id
            where l.library_id=%s and l.catalog_ref=any(%s::uuid[]) for share of a""",
            (context.library_id, refs)).fetchall()
        required_refs = set(refs)
        if {str(row["catalog_ref"]) for row in rows} != required_refs:
            raise AlbumTopError("album_unavailable", 409)
        from music_app.services.private_library_authority import require_private_action
        authorized_refs = set()
        for row in rows:
            try:
                require_private_action(context, BROWSE,
                    resource=ResourceScope("album", str(row["local_album_id"])), constraints=constraints)
            except PrivateLibraryAuthorityError:
                continue
            authorized_refs.add(str(row["catalog_ref"]))
        if authorized_refs != required_refs:
            raise AlbumTopError("forbidden", 403)

    def read(self, context, *, top_ref, constraints=None):
        ref = top_uuid(top_ref)
        with self._authorized(context, constraints) as (connection, live, _):
            top = self._top(connection, live, ref)
            self._require(live, (BROWSE,), constraints, top)
            rows = connection.execute("""select i.ref,i.catalog_ref,i.original_position,i.curator_position,
                c.title,c.artist_display,c.release_year from app.album_list_items i
                join catalog.release_groups c on c.ref=i.catalog_ref
                where i.top_ref=%s order by i.curator_position""", (ref,)).fetchall()
            return {"top_ref": ref, "title": top["title"], "description": top["description"],
                "revision": str(top["revision"]), "visibility": top["visibility"],
                "allowed_actions": self._actions(live, constraints, top),
                "top_viewer_overlay": progress.read_overlay(connection, live, top),
                "items": [{**row, "ref": str(row["ref"]), "catalog_ref": str(row["catalog_ref"])} for row in rows]}

    def execute(self, context, command: AlbumTopCommand, *, constraints=None):
        from psycopg.types.json import Jsonb
        if not isinstance(command, AlbumTopCommand):
            raise AlbumTopError("invalid_command")
        if type(command.data) is not dict:
            raise AlbumTopError("invalid_command")
        command = normalize_top_command(command.action,
            {**command.data, "request_key": command.request_key}, top_ref=command.top_ref)
        manual_progress = command.action == "set_manual_completion"
        lock_target = command.data.get("account_id")
        if command.action == "decide_edit_request":
            self._require(context, (BROWSE,), constraints)
            # Discover the target before taking ANY account/parent locks. The
            # locked request is checked against this identity inside the write.
            with self._connect(self._url) as lookup:
                request = lookup.execute("""select requester_account_id from app.album_list_edit_requests
                    where ref=%s and top_ref=%s and library_id=%s""",
                    (command.data["request_ref"], command.top_ref, context.library_id)).fetchone()
                lock_target = request["requester_account_id"] if request else None
        with self._authorized(context, constraints, target_account_id=lock_target) as (connection, live, now):
            # Actor lock held by current_library_transaction serializes operation keys.
            prior = connection.execute("""select command_digest,receipt,top_ref,required_actions,publication_ref from app.album_list_operations
                where actor_account_id=%s and library_id=%s and request_key=%s""",
                (live.actor.account_id, live.library_id, command.request_key)).fetchone()
            if prior:
                if prior["command_digest"] != command.digest:
                    raise AlbumTopError("request_key_conflict", 409)
                retained = self._top(connection, live, str(prior["top_ref"]),
                                     allow_deleted=not manual_progress and prior["publication_ref"] is None)
                self._require(live, (BROWSE,), constraints, retained)
                self._require(live, command_actions(command), constraints,
                    retained if command.action not in {"create", "copy"} else None,
                    owner_only=command.action == "delete")
                # Copy receipts bind the destination. Source edits or revocation
                # cannot duplicate a landed copy, including from a new session.
                if command.action in {"create", "copy"} and retained["owner_account_id"] != live.actor.account_id:
                    raise AlbumTopError("top_unavailable", 404)
                if manual_progress:
                    progress.require_member(connection, live, retained, command.data["album_ref"])
                publication.replay(self, connection, live, command, retained, prior, constraints)
                return dict(prior["receipt"])
            if command.action == "create":
                self._require(live, command_actions(command), constraints)
                ref = str(uuid4())
                connection.execute("""insert into app.album_lists(ref,owner_account_id,library_id,title,description)
                    values(%s,%s,%s,%s,%s)""", (ref, live.actor.account_id, live.library_id,
                    command.data["title"], command.data["description"]))
                top = self._top(connection, live, ref, write=True)
            else:
                # Self progress shares the parent lock with other viewers while
                # excluding content/visibility edits through the existing owner.
                top = self._top(connection, live, command.top_ref, write=not manual_progress)
                self._require(live, (BROWSE,), constraints, top)
                self._require(live, command_actions(command), constraints,
                              None if command.action == "copy" else top, owner_only=command.action == "delete")
                if not manual_progress and str(top["revision"]) != command.data["revision"]:
                    raise AlbumTopError("revision_conflict", 409)
            required_actions = command_actions(command)
            if command.action in {"save", "enable_external", "revoke_external"}:
                receipt, required_actions = publication.save(self, connection, live, command, top, now, constraints)
            elif manual_progress:
                receipt = progress.set_manual_completion(connection, live, command, top, now)
            elif command.action == "copy":
                receipt = viewers.copy_top(connection, live, command, top)
            else:
                receipt = self._mutate(connection, live, command, top, now, constraints,
                                       locked_target=lock_target)
            connection.execute("""insert into app.album_list_operations
                (actor_account_id,library_id,request_key,original_session_id,action,top_ref,command_digest,receipt,required_actions,publication_ref)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (live.actor.account_id, live.library_id,
                command.request_key, live.actor.session_id, command.action, receipt["top_ref"], command.digest,
                Jsonb(receipt), list(required_actions), receipt.get("publication", {}).get("publication_ref")))
            return receipt

    def _mutate(self, connection, live, command, top, now, constraints, *, locked_target=None):
        ref = str(top["ref"])
        rows = connection.execute("""select ref,catalog_ref,curator_position from app.album_list_items
            where top_ref=%s order by curator_position""", (ref,)).fetchall() if command.action in {
                "create", "add", "remove", "reorder"} else []
        order = [str(row["ref"]) for row in rows]
        changed, counts = True, {}
        if command.action in {"visibility", "grant_editor", "revoke_editor", "request_edit", "decide_edit_request"}:
            changed, counts = viewers.mutate(self, connection, live, command, top, constraints,
                                             locked_target=locked_target)
        elif command.action in {"create", "add"}:
            refs = command.data["album_refs"]
            self._catalog(connection, live, refs, constraints)
            if len(order) + len(refs) > MAX_TOP_ITEMS:
                raise AlbumTopError("top_too_large", 413)
            if set(refs).intersection(str(row["catalog_ref"]) for row in rows):
                raise AlbumTopError("duplicate_album", 409)
            first = top["next_original_position"]
            if first + len(refs) > 9223372036854775807:
                raise AlbumTopError("position_exhausted", 409)
            if refs:
                connection.execute("""insert into app.album_list_items
                    (ref,top_ref,library_id,catalog_ref,original_position,curator_position)
                    select incoming.item_ref,%s,%s,incoming.album_ref,%s+incoming.position-1,
                           %s+incoming.position
                    from unnest(%s::uuid[],%s::uuid[]) with ordinality
                      as incoming(item_ref,album_ref,position)""",
                    (ref, live.library_id, first, len(order), [str(uuid4()) for _ in refs], refs))
            connection.execute("update app.album_lists set next_original_position=%s where ref=%s",
                               (first + len(refs), ref))
        elif command.action in {"remove", "reorder"}:
            selected = command.data["item_refs" if command.action == "remove" else "item_order"]
            if (not set(selected).issubset(order) or command.action == "reorder" and set(selected) != set(order)):
                raise AlbumTopError("items_changed", 409)
            if command.action == "remove":
                connection.execute("delete from app.album_list_items where top_ref=%s and ref=any(%s::uuid[])", (ref, selected))
                removed = set(selected)
                order = [item for item in order if item not in removed]
            else:
                order = selected
            connection.execute("""update app.album_list_items as item set curator_position=ordering.position
                from unnest(%s::uuid[]) with ordinality as ordering(ref,position)
                where item.ref=ordering.ref and item.top_ref=%s""", (order, ref))
        elif command.action == "delete":
            link = publication.lock_link(connection, top, write=True)
            if link is not None:
                publication.revoke(connection, top, link, now)
            connection.execute("update app.album_lists set deleted_at=%s where ref=%s", (now, ref))
        revision = top["revision"]
        if changed and command.action != "create":
            if revision == 9223372036854775807:
                raise AlbumTopError("revision_exhausted", 409)
            revision += 1
        if changed:
            connection.execute("update app.album_lists set revision=%s,updated_at=%s where ref=%s", (revision, now, ref))
        receipt = {"top_ref": ref, "revision": str(revision), "action": command.action,
                   "request_key": command.request_key, **counts}
        return receipt

    def publication_preview(self, context, *, top_ref, payload, constraints=None):
        """P1 service-only complete source review, without durable side effects."""
        ref = top_uuid(top_ref)
        preview = normalize_top_publication_preview(payload)
        with self._authorized(context, constraints) as (connection, live, _):
            top = self._top(connection, live, ref)
            self._require(live, (BROWSE, ACCESS), constraints, top, owner_only=True)
            publication.lock_link(connection, top)
            if str(top["revision"]) != preview["revision"]:
                raise AlbumTopError("revision_conflict", 409)
            current = publication.working_items(connection, top)
            publication.validate_draft(self, connection, live, top, preview["items"], current, constraints)
            captured = publication_evidence.capture(connection, live, top=top, items=preview["items"], constraints=constraints)
            self._require(live, (BROWSE, ACCESS), constraints, top, owner_only=True)
            return {"top_ref": ref, "revision": preview["revision"],
                "evidence_revision": captured["evidence_revision"],
                "items": [{**row["item"], "title": row["metadata"]["title"],
                    "artist": row["metadata"]["artist"], "year": row["metadata"]["year"],
                    "track_count": len(row["metadata"]["tracks"])} for row in captured["items"]]}

    def read_sharing(self, context, top_ref, *, cursor_secret=None, cursor=None, constraints=None):
        ref = top_uuid(top_ref)
        with self._authorized(context, constraints) as (connection, live, _):
            top = self._top(connection, live, ref)
            self._require(live, (BROWSE,), constraints, top)
            return viewers.sharing(self, connection, live, top, constraints,
                                   cursor_secret=cursor_secret, cursor=cursor)

    def read_edit_requests(self, context, *, cursor_secret, cursor=None, limit=50, constraints=None):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise AlbumTopError('invalid_query')
        with self._authorized(context, constraints) as (connection, live, _):
            self._require(live, (BROWSE,), constraints)
            scope = ['album-top-edit-requests-v1', live.actor.account_id, live.actor.session_id, live.library_id]
            after = viewers.page_position(cursor, cursor_secret, scope)
            requests, after = viewers.pending(self, connection, live, constraints, after=after, limit=limit)
            return {'requests': requests, 'next_cursor': encode_social_cursor(after, secret=cursor_secret, scope=scope)}

    def read_access(self, context, top_ref, *, cursor_secret=None, cursor=None, limit=50, constraints=None):
        ref = top_uuid(top_ref)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise AlbumTopError('invalid_query')
        with self._authorized(context, constraints) as (connection, live, _):
            top = self._top(connection, live, ref)
            self._require(live, (BROWSE, ACCESS), constraints, top, owner_only=True)
            return viewers.access_directory(self, connection, live, top, constraints,
                                            cursor_secret=cursor_secret, cursor=cursor, limit=limit)

    def read_access_candidates(self, context, top_ref, *, cursor_secret, query='', cursor=None,
                               limit=50, constraints=None):
        ref = top_uuid(top_ref)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise AlbumTopError('invalid_query')
        with self._authorized(context, constraints) as (connection, live, _):
            top = self._top(connection, live, ref)
            self._require(live, (BROWSE, ACCESS), constraints, top, owner_only=True)
            return viewers.access_directory(self, connection, live, top, constraints,
                cursor_secret=cursor_secret, cursor=cursor, limit=limit, query=query)
