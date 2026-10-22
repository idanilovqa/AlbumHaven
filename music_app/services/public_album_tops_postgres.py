"""Bounded immutable Top snapshots under current publication and actor policy.

This service registers no routes. Publication-only member reads deliberately do
not enter the working-Top authority or grant any working, media or progress right.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import re

from music_app.services.admin_member_mutation_postgres import (
    RecentAuthenticationRequired, lock_current_actor_session,
)
from music_app.services.album_top_publication import lock_link, publication_version
from music_app.services.album_top_publication_authority import (
    publication_owner_eligibility, retained_sources, retained_artwork_sources,
)
from music_app.services.album_top_publication_evidence import MAX_TRACKS, MAX_TOTAL_TRACKS
from music_app.services.current_actor import ActorState
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, MAX_TOP_ITEMS
from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope
from music_app.services.postgres_connections import pooled_connection
from music_app.services.private_library_authority import (
    PrivateLibraryAuthorityError, current_library_transaction, require_private_action,
)
from music_app.services.public_album_tops import (
    public_ref, snapshot_header, snapshot_integer, snapshot_item, snapshot_ref,
    snapshot_text, snapshot_track, validate_public_page, snapshot_png, validate_snapshot_v2,
)
from music_app.services.social_cursors import decode_social_cursor, encode_social_cursor

_CONTEXT_REF = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_ITEM_COLUMNS = """i.item_ref,i.catalog_ref,i.presentation_ref,i.original_position,
    i.curator_position,p.contract_version,p.title,p.artist,p.year"""

# These are fixed internal fragments, never selected by a caller or request.
_ARTWORK_ITEM_COLUMNS = ",r.included,r.asset_ref"
_ARTWORK_ITEM_JOIN = """ join app.album_top_artwork_publication_rows r
    on r.publication_ref=i.publication_ref and r.item_ref=i.item_ref
      and r.top_ref=i.top_ref and r.library_id=i.library_id
      and r.catalog_ref=i.catalog_ref and r.presentation_ref=i.presentation_ref
      and r.original_position=i.original_position and r.curator_position=i.curator_position """
_ASSET_HEAD = """select a.ref,a.sanitizer_contract,a.mime_type,a.content_digest,
    a.width,a.height,a.byte_length,octet_length(a.png) as stored_length
    from app.album_top_artwork_publication_rows r
    join app.album_top_artwork_assets a on a.ref=r.asset_ref and a.top_ref=r.top_ref
      and a.library_id=r.library_id and a.owner_account_id=r.owner_account_id
    where r.publication_ref=%s and r.item_ref=%s and r.asset_ref=%s and r.included is true
      and r.top_ref=%s and r.library_id=%s and r.owner_account_id=%s"""
_ASSET_GET = """select a.ref,a.sanitizer_contract,a.mime_type,a.content_digest,
    a.width,a.height,a.byte_length,octet_length(a.png) as stored_length,
    case when octet_length(a.png) between 1 and 327680 then a.png end as png
    from app.album_top_artwork_publication_rows r
    join app.album_top_artwork_assets a on a.ref=r.asset_ref and a.top_ref=r.top_ref
      and a.library_id=r.library_id and a.owner_account_id=r.owner_account_id
    where r.publication_ref=%s and r.item_ref=%s and r.asset_ref=%s and r.included is true
      and r.top_ref=%s and r.library_id=%s and r.owner_account_id=%s"""


class PostgresPublicAlbumTopsService:
    def __init__(self, config, *, connect=None, clock=None):
        self._config = config
        self._url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._url:
            raise RuntimeError("PostgreSQL configuration is required for shared Album Tops.")
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    @staticmethod
    @contextmanager
    def _errors():
        # Translate only outside transaction contexts so every failure rolls back
        # and releases its locks before the unavailable result escapes.
        try:
            yield
        except (PrivateLibraryAuthorityError, RecentAuthenticationRequired):
            raise AlbumTopError("forbidden", 403) from None
        except AlbumTopError:
            raise
        except Exception:
            raise AlbumTopError("unavailable", 503) from None

    def _enabled(self):
        if self._config.get("ALBUM_HAVEN_PUBLIC_SHARING_ENABLED") is not True:
            raise AlbumTopError("unavailable", 404)

    @staticmethod
    def _discover(connection, share_ref):
        row = connection.execute("""select t.ref,t.owner_account_id,t.library_id,t.deleted_at
            from app.shared_links s join app.album_lists t
              on t.ref=s.top_ref and t.library_id=s.library_id where s.ref=%s""",
            (share_ref,)).fetchone()
        if row is None:
            raise AlbumTopError("unavailable", 404)
        snapshot_integer(row["owner_account_id"])
        snapshot_integer(row["library_id"])
        snapshot_ref(row["ref"])
        return row

    def _owner(self, connection, top, sources, constraints, artwork_sources=()):
        try:
            publication_owner_eligibility(connection, top=top, config=self._config,
                sources=sources, constraints=constraints, artwork_sources=artwork_sources)
        except AlbumTopError:
            raise AlbumTopError("unavailable", 404) from None

    def _locked_publication(self, connection, discovered, share_ref, constraints):
        # Account locks are already held. Acquire owner membership/grant locks
        # before the parent; the same predicate rechecks them after parent waits.
        self._owner(connection, discovered, [], constraints)
        top = connection.execute("""select ref,owner_account_id,library_id,deleted_at
            from app.album_lists where ref=%s for share""", (discovered["ref"],)).fetchone()
        if (top is None or top["deleted_at"] is not None
                or any(top[key] != discovered[key] for key in ("ref", "owner_account_id", "library_id"))):
            raise AlbumTopError("unavailable", 404)
        link = lock_link(connection, top)
        if (link is None or snapshot_ref(link["ref"]) != share_ref or link["state"] != "enabled"
                or link["active_publication_ref"] is None):
            raise AlbumTopError("unavailable", 404)
        publication = connection.execute("""select p.ref,p.top_ref,p.library_id,p.approved_by_account_id,
            p.publication_revision,p.contract_version,p.title,p.description,s.item_count
            from app.album_list_publications p join app.album_list_publication_seals s
              on s.publication_ref=p.ref and s.sealed_at is not null
                and s.seal_contract_version=p.contract_version and s.content_digest ~ '^[0-9a-f]{64}$'
            where p.ref=%s and p.top_ref=%s and p.library_id=%s""",
            (link["active_publication_ref"], top["ref"], top["library_id"])).fetchone()
        if publication is None or publication["approved_by_account_id"] != top["owner_account_id"]:
            raise AlbumTopError("unavailable", 404)
        # Validate even fields not emitted by the item response.
        snapshot_header(publication, share_ref)
        if publication["contract_version"] == 2:
            try:
                if publication_version(connection, top, publication["ref"]) != 2:
                    raise AlbumTopError("unavailable", 404)
            except AlbumTopError:
                raise AlbumTopError("unavailable", 404) from None
        snapshot_integer(publication["item_count"], minimum=0, maximum=MAX_TOP_ITEMS)
        snapshot_text(publication["title"], maximum=100)
        snapshot_text(publication["description"], empty=True)
        return top, publication

    @staticmethod
    def _manifest(connection, top, publication):
        # Completed seals freeze every child set. Validate all retained bindings
        # and declared bounds here; only an opened item counts its actual tracks.
        # Gallery pagination must not aggregate every presentation's track rows.
        stats = connection.execute("""select count(*) as total,
            count(*) filter(where i.top_ref=%s and i.library_id=%s
                and p.catalog_ref=i.catalog_ref and p.contract_version=1
                and e.library_id=i.library_id and e.capture_builder_version=1
                and s.sealed_at is not null and s.seal_contract_version=1
                and s.library_id=e.library_id and s.selected_source_ref=e.selected_source_ref
                and s.capture_builder_version=e.capture_builder_version and s.evidence_digest=e.evidence_digest
                and s.track_count between 0 and %s and s.content_digest ~ '^[0-9a-f]{64}$') as valid,
            coalesce(sum(s.track_count),0) as total_tracks,
            min(i.curator_position) as first,max(i.curator_position) as last
            from app.album_list_publication_items i
            left join catalog.album_presentation_versions p on p.ref=i.presentation_ref
            left join library.album_presentation_evidence e on e.presentation_ref=i.presentation_ref
            left join library.album_presentation_seals s on s.presentation_ref=i.presentation_ref
            where i.publication_ref=%s""",
            (top["ref"], top["library_id"], MAX_TRACKS, publication["ref"])).fetchone()
        total = publication["item_count"]
        snapshot_integer(stats["total_tracks"], minimum=0, maximum=MAX_TOTAL_TRACKS)
        if (stats["total"] != total or stats["valid"] != total
                or total and (stats["first"], stats["last"]) != (1, total)):
            raise AlbumTopError("unavailable", 404)
        sources = retained_sources(connection, publication["ref"])
        if len(sources) > total or total and not sources:
            raise AlbumTopError("unavailable", 404)
        for source in sources:
            snapshot_integer(source["selected_local_album_id"])
            snapshot_ref(source["selected_source_ref"])
            snapshot_integer(source["selected_library_root_id"])
        return total, sources

    @classmethod
    def _retained_manifest(cls, connection, top, publication):
        """Complete versioned scopes; preserve the existing metadata helper API."""
        total, sources = cls._manifest(connection, top, publication)
        artwork_sources = cls._artwork_manifest(connection, top, publication) if publication["contract_version"] == 2 else []
        return total, sources, artwork_sources

    @staticmethod
    def _artwork_manifest(connection, top, publication):
        # Compact immutable keys/asset headers only. Proof JSON and PNG bodies
        # are deliberately absent; the accepted sealer owns proof validation.
        stats = connection.execute("""select count(*) as total,
            count(*) filter(where r.top_ref=%s and r.library_id=%s and r.owner_account_id=%s
              and (r.item_ref,r.catalog_ref,r.presentation_ref,r.original_position,r.curator_position,
                   r.top_ref,r.library_id)=(i.item_ref,i.catalog_ref,i.presentation_ref,i.original_position,
                   i.curator_position,i.top_ref,i.library_id)
              and (r.local_album_id,r.metadata_source_ref,r.metadata_root_id,r.library_id)=
                  (e.selected_local_album_id,e.selected_source_ref,e.selected_library_root_id,e.library_id)
              and ((r.included is false and r.artwork_root_id is null and r.asset_ref is null
                    and r.proof_value_digest is null)
                or (r.included is true and r.artwork_root_id>0
                    and r.proof_value_digest ~ '^[0-9a-f]{64}$'
                    and q.value_digest=r.proof_value_digest and q.proof_version in (1,2)
                    and a.ref=r.asset_ref and a.sanitizer_contract=1 and a.mime_type='image/png'
                    and a.width between 1 and 256 and a.height between 1 and 256
                    and a.byte_length between 1 and 327680 and a.content_digest ~ '^[0-9a-f]{64}$')))
              as valid,
            count(*) filter(where r.included is true) as included_count,
            coalesce(sum(case when r.included then a.byte_length else 0 end),0)::bigint as image_bytes,
            min(r.curator_position) as first,max(r.curator_position) as last
            from app.album_top_artwork_publication_rows r
            left join app.album_list_publication_items i
              on i.publication_ref=r.publication_ref and i.item_ref=r.item_ref
            left join library.album_presentation_evidence e on e.presentation_ref=r.presentation_ref
            left join app.album_top_artwork_assets a on a.ref=r.asset_ref and a.top_ref=r.top_ref
              and a.library_id=r.library_id and a.owner_account_id=r.owner_account_id
            left join app.album_top_artwork_publication_proofs q on q.value_digest=r.proof_value_digest
              and q.top_ref=r.top_ref and q.library_id=r.library_id and q.owner_account_id=r.owner_account_id
            where r.publication_ref=%s""",
            (top["ref"], top["library_id"], top["owner_account_id"], publication["ref"])).fetchone()
        lineage = connection.execute("""select row_count,included_count
            from app.album_top_artwork_publication_lineage
            where publication_ref=%s and top_ref=%s and library_id=%s and owner_account_id=%s""",
            (publication["ref"], top["ref"], top["library_id"], top["owner_account_id"])).fetchone()
        total = publication["item_count"]
        if (lineage is None or stats["total"] != total or stats["valid"] != total
                or lineage["row_count"] != total or lineage["included_count"] != stats["included_count"]
                or total and (stats["first"], stats["last"]) != (1, total)):
            raise AlbumTopError("unavailable", 404)
        snapshot_integer(stats["included_count"], minimum=0, maximum=total)
        snapshot_integer(stats["image_bytes"], minimum=0, maximum=128 * 1024 * 1024)
        sources = retained_artwork_sources(connection, publication["ref"])
        if len(sources) > stats["included_count"] or stats["included_count"] and not sources:
            raise AlbumTopError("unavailable", 404)
        for source in sources:
            snapshot_integer(source["selected_local_album_id"])
            snapshot_integer(source["artwork_root_id"])
        return sources

    def _page(self, connection, top, publication, *, share_ref, item_ref, limit,
              cursor, cursor_secret, member_scope, constraints):
        total, sources, artwork_sources = self._retained_manifest(connection, top, publication)
        self._owner(connection, top, sources, constraints, artwork_sources)
        version = publication["contract_version"]
        columns = _ITEM_COLUMNS + (_ARTWORK_ITEM_COLUMNS if version == 2 else "")
        artwork_join = _ARTWORK_ITEM_JOIN if version == 2 else ""
        kind = "top" if item_ref is None else "item"
        scope = [("public-album-top-member-v" if member_scope else "public-album-top-guest-v") + str(version),
                 kind, share_ref, snapshot_ref(publication["ref"]), limit,
                 "curator" if item_ref is None else "track", item_ref, *member_scope]
        if version == 2:
            scope.append(version)
        item = None
        if item_ref is not None:
            row = connection.execute("select " + columns + """,s.track_count
                from app.album_list_publication_items i join catalog.album_presentation_versions p
                  on p.ref=i.presentation_ref and p.catalog_ref=i.catalog_ref
                join library.album_presentation_seals s on s.presentation_ref=p.ref
                  and s.sealed_at is not null and s.seal_contract_version=1
                """ + artwork_join + """ where i.publication_ref=%s and i.item_ref=%s and i.top_ref=%s and i.library_id=%s""",
                (publication["ref"], item_ref, top["ref"], top["library_id"])).fetchone()
            if row is None:
                raise AlbumTopError("unavailable", 404)
            item = snapshot_item(row, share_ref=share_ref, publication_contract_version=version)
            stats = connection.execute("""select count(*) as total,min(position) as first,
                max(position) as last from catalog.album_presentation_tracks where presentation_ref=%s""",
                (item["presentation_ref"],)).fetchone()
            total = snapshot_integer(row["track_count"], minimum=0, maximum=MAX_TRACKS)
            if stats["total"] != total or total and (stats["first"], stats["last"]) != (1, total):
                raise AlbumTopError("unavailable", 404)
        try:
            after = decode_social_cursor(cursor, secret=cursor_secret, scope=scope)
        except ValueError:
            raise AlbumTopError("invalid_cursor", 400) from None
        if cursor is not None and after >= total:
            raise AlbumTopError("invalid_cursor", 400)
        if item is None:
            rows = connection.execute("select " + columns + """
                from app.album_list_publication_items i join catalog.album_presentation_versions p
                  on p.ref=i.presentation_ref and p.catalog_ref=i.catalog_ref
                """ + artwork_join + """ where i.publication_ref=%s and i.top_ref=%s and i.library_id=%s and i.curator_position>%s
                order by i.curator_position limit %s""",
                (publication["ref"], top["ref"], top["library_id"], after, limit + 1)).fetchall()
            entries = [snapshot_item(row, share_ref=share_ref, publication_contract_version=version) for row in rows]
            positions = [row["curator_position"] for row in entries]
        else:
            rows = connection.execute("""select ref,position,title,artist,duration_ms
                from catalog.album_presentation_tracks where presentation_ref=%s and position>%s
                order by position limit %s""", (item["presentation_ref"], after, limit + 1)).fetchall()
            entries = [snapshot_track(row) for row in rows]
            positions = [row["position"] for row in entries]
        expected = min(limit + 1, total - after)
        if len(entries) != expected or positions != list(range(after + 1, after + expected + 1)):
            raise AlbumTopError("unavailable", 404)
        result = {**snapshot_header(publication, share_ref),
                  "next_cursor": encode_social_cursor(after + limit if len(entries) > limit else None,
                      secret=cursor_secret, scope=scope),
                  "allowed_actions": {"can_read": True, "can_open_item": True}}
        if item is None:
            result.update(title=snapshot_text(publication["title"], maximum=100),
                          description=snapshot_text(publication["description"], empty=True), items=entries[:limit])
        else:
            result.update(item=item, tracks=entries[:limit], track_count=total)
        if version == 2:
            validate_snapshot_v2(result, share_ref=share_ref, item_ref=item_ref, limit=limit)
            self._owner(connection, top, sources, constraints, artwork_sources)
        return result

    def read_guest(self, *, share_ref, request_origin, cursor_secret, item_ref=None,
                   cursor=None, limit=None, constraints=None):
        share_ref = public_ref(share_ref)
        item_ref = public_ref(item_ref) if item_ref is not None else None
        page = validate_public_page(kind="top" if item_ref is None else "item", cursor=cursor, limit=limit)
        self._guest_origin(request_origin)
        with self._errors():
            with self._connect(self._url) as connection:
                connection.execute("set transaction isolation level read committed")
                discovered = self._discover(connection, share_ref)
                connection.execute("select id from app.accounts where id=%s for share",
                    (discovered["owner_account_id"],)).fetchone()
                top, publication = self._locked_publication(connection, discovered, share_ref, constraints)
                result = self._page(connection, top, publication, share_ref=share_ref, item_ref=item_ref,
                    cursor_secret=cursor_secret, member_scope=[], constraints=constraints, **page)
                if publication["contract_version"] == 2:
                    self._guest_origin(request_origin)
                return result

    def _guest_origin(self, request_origin):
        self._enabled()
        if (not isinstance(request_origin, RequestOrigin) or request_origin.origin_type != "network"
                or request_origin.origin_key != self._config.get("ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN")):
            raise AlbumTopError("unavailable", 404)

    @staticmethod
    def _asset(connection, top, publication, *, item_ref, asset_ref, head_only):
        if type(head_only) is not bool or publication["contract_version"] != 2:
            raise AlbumTopError("unavailable", 404)
        row = connection.execute(_ASSET_HEAD if head_only else _ASSET_GET,
            (publication["ref"], item_ref, asset_ref, top["ref"], top["library_id"],
             top["owner_account_id"])).fetchone()
        return snapshot_png(row, head_only=head_only)

    def read_guest_artwork(self, *, share_ref, publication_ref, item_ref, asset_ref,
                           head_only, request_origin, constraints=None):
        share_ref, publication_ref = public_ref(share_ref), public_ref(publication_ref)
        item_ref, asset_ref = public_ref(item_ref), public_ref(asset_ref)
        if type(head_only) is not bool:
            raise AlbumTopError("unavailable", 404)
        self._guest_origin(request_origin)
        with self._errors():
            with self._connect(self._url) as connection:
                connection.execute("set transaction isolation level read committed")
                discovered = self._discover(connection, share_ref)
                connection.execute("select id from app.accounts where id=%s for share",
                    (discovered["owner_account_id"],)).fetchone()
                top, publication = self._locked_publication(connection, discovered, share_ref, constraints)
                if publication["contract_version"] != 2 or snapshot_ref(publication["ref"]) != publication_ref:
                    raise AlbumTopError("unavailable", 404)
                _, sources, artwork_sources = self._retained_manifest(connection, top, publication)
                self._owner(connection, top, sources, constraints, artwork_sources)
                result = self._asset(connection, top, publication, item_ref=item_ref,
                                     asset_ref=asset_ref, head_only=head_only)
                # Bytes/hash and all response SQL precede the final complete policy.
                self._owner(connection, top, sources, constraints, artwork_sources)
                self._guest_origin(request_origin)
                return result

    def recheck_guest_response(self, *, share_ref, publication_ref, publication_contract_version,
                               request_origin, item_ref=None, asset_ref=None, constraints=None):
        """Fresh authority for an already constructed immutable v2 response.

        No snapshot or token is returned. The route must not render/hash/read
        response data after this transaction; it only rechecks request origin.
        """
        share_ref, publication_ref = public_ref(share_ref), public_ref(publication_ref)
        item_ref = public_ref(item_ref) if item_ref is not None else None
        asset_ref = public_ref(asset_ref) if asset_ref is not None else None
        if (type(publication_contract_version) is not int or publication_contract_version != 2
                or asset_ref is not None and item_ref is None):
            raise AlbumTopError("unavailable", 404)
        self._guest_origin(request_origin)
        with self._errors():
            with self._connect(self._url) as connection:
                connection.execute("set transaction isolation level read committed")
                discovered = self._discover(connection, share_ref)
                connection.execute("select id from app.accounts where id=%s for share",
                    (discovered["owner_account_id"],)).fetchone()
                top, publication = self._locked_publication(connection, discovered, share_ref, constraints)
                if publication["contract_version"] != 2 or snapshot_ref(publication["ref"]) != publication_ref:
                    raise AlbumTopError("unavailable", 404)
                _, sources, artwork_sources = self._retained_manifest(connection, top, publication)
                if asset_ref is not None:
                    # Header-only even after GET: no second bytea transfer/hash.
                    self._asset(connection, top, publication, item_ref=item_ref, asset_ref=asset_ref, head_only=True)
                elif item_ref is not None:
                    row = connection.execute("""select item_ref from app.album_list_publication_items
                        where publication_ref=%s and item_ref=%s and top_ref=%s and library_id=%s""",
                        (publication["ref"], item_ref, top["ref"], top["library_id"])).fetchone()
                    if row is None:
                        raise AlbumTopError("unavailable", 404)
                self._owner(connection, top, sources, constraints, artwork_sources)
                self._guest_origin(request_origin)

    def read_published(self, context, *, top_ref, share_ref, context_ref, cursor_secret,
                       item_ref=None, cursor=None, limit=None, constraints=None):
        top_ref, share_ref = public_ref(top_ref), public_ref(share_ref)
        item_ref = public_ref(item_ref) if item_ref is not None else None
        page = validate_public_page(kind="top" if item_ref is None else "item", cursor=cursor, limit=limit)
        if (not isinstance(context, PolicyContext) or context.actor.state is not ActorState.ACTIVE
                or context.target_account_id not in (None, context.actor.account_id)
                or type(context_ref) is not str or not _CONTEXT_REF.fullmatch(context_ref)):
            raise AlbumTopError("forbidden", 403)
        self._enabled()
        with self._errors():
            # This lookup carries no authority and takes no row locks. The real
            # transaction locks requester and discovered owner in sorted order.
            with self._connect(self._url) as lookup:
                discovered = self._discover(lookup, share_ref)
            with current_library_transaction(self._url, context, constraints=constraints,
                    connect=self._connect, clock=self._clock,
                    target_account_id=discovered["owner_account_id"], read_only=True) as (connection, live, _):
                if snapshot_ref(discovered["ref"]) != top_ref or discovered["library_id"] != live.library_id:
                    raise AlbumTopError("unavailable", 404)
                top, publication = self._locked_publication(connection, discovered, share_ref, constraints)
                require_private_action(live, BROWSE, resource=ResourceScope("album_top", top_ref), constraints=constraints)
                result = self._page(connection, top, publication, share_ref=share_ref, item_ref=item_ref,
                    cursor_secret=cursor_secret, constraints=constraints,
                    member_scope=[live.actor.account_id, live.actor.session_id, live.library_id, context_ref, top_ref], **page)
                lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                    actor_session_id=live.actor.session_id, clock=self._clock)
                if publication["contract_version"] == 2:
                    _, sources, artwork_sources = self._retained_manifest(connection, top, publication)
                    self._owner(connection, top, sources, constraints, artwork_sources)
                    require_private_action(live, BROWSE, resource=ResourceScope("album_top", top_ref), constraints=constraints)
                return result
