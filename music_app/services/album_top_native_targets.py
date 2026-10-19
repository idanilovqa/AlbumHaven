"""Action-time Album Details targets for exact saved Top members."""
import re

from music_app.services.owned_album_tops import AlbumTopError, BROWSE, top_uuid, top_revision
from music_app.services.policy import ResourceScope
from music_app.services.private_native_targets import PrivateNativeTargets, NativeTargetError, allows
from music_app.services import album_top_remote_membership as remote_membership
from music_app.services.album_top_native_binding import lock_binding, eligible_editions


_INVENTORY_REF = re.compile(r'inventory-album:([1-9][0-9]{0,18}):([1-9][0-9]{0,18})\Z')


class AlbumTopNativeTargets:
    def __init__(self, tops):
        self.tops = tops

    def resolve(self, context, *, top_ref, item_ref, revision, inventory_album_ref,
                context_ref, constraints=None):
        ref, item = top_uuid(top_ref), top_uuid(item_ref)
        revision = top_revision(revision)
        remote_membership.require_context(context_ref)
        match = _INVENTORY_REF.fullmatch(inventory_album_ref) if isinstance(inventory_album_ref, str) else None
        if match is None:
            raise AlbumTopError('invalid_command', 422)
        library, album_id = map(int, match.groups())
        if max(library, album_id) > 9223372036854775807:
            raise AlbumTopError('invalid_command', 422)
        with self.tops._authorized(context, constraints) as (connection, live, _):
            if library != live.library_id:
                raise AlbumTopError('item_unavailable', 404)
            top = self.tops._top(connection, live, ref)
            self.tops._require(live, (BROWSE,), constraints, top)
            if str(top['revision']) != revision:
                raise AlbumTopError('revision_conflict', 409)
            if item in remote_membership.bindings(connection, top):
                raise AlbumTopError('item_unavailable', 404)
            # Top's shared lock stabilizes membership. Runtime has no catalog
            # UPDATE rights; a tuple-bounded helper owns its row-lock privilege.
            member = connection.execute('''select catalog_ref from app.album_list_items
                where top_ref=%s and ref=%s''', (ref, item)).fetchone()
            if member is None:
                raise AlbumTopError('item_unavailable', 404)
            catalog_ref = str(member['catalog_ref'])
            lock_binding(connection, top_ref=ref, item_ref=item, library_id=library,
                         revision=revision, catalog_ref=catalog_ref)

            def current_mapping():
                eligible = eligible_editions(connection, library, catalog_ref)
                return len(eligible) == 1 and eligible[0]['id'] == album_id

            if not current_mapping():
                raise AlbumTopError('native_binding_changed', 409)
            try:
                target = PrivateNativeTargets(self.tops._config).resolve_album(
                    connection, live, album_id, constraints=constraints)
            except NativeTargetError as error:
                raise AlbumTopError(error.code, error.status_code) from None
            # Callable deployment constraints can change while inventory locks
            # wait. Recheck source and Album Browse before returning native data;
            # _authorized provides the final current actor/session expiry fence.
            self.tops._require(live, (BROWSE,), constraints, top)
            if not allows(live, BROWSE, ResourceScope('album', str(album_id)), constraints):
                raise AlbumTopError('forbidden', 403)
            if not current_mapping():
                raise AlbumTopError('native_binding_changed', 409)
            return {'top_ref': ref, 'revision': revision, 'item_ref': item,
                    'catalog_ref': catalog_ref, 'inventory_album_ref': inventory_album_ref,
                    'native_target': {'album_ref': target['album_ref'],
                                      'allowed_actions': {'can_view_details': True, 'can_play_album': False}}}
