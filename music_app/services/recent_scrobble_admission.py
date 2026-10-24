"""Resolve one own Recent occurrence for a future existing-owner retry claim.

This is an internal, read-only admission seam, NOT a send authorization token.
It neither calls Last.fm nor exposes a route. Returned facts can become stale;
a future targeted sender must recheck authority and receipt under its claim
protocol. Never call the separate-connection sender inside this transaction.
"""
from dataclasses import dataclass
import re

from music_app.services.activity_native_targets import normalize_native_origin
from music_app.services.allowed_actions import AllowedActions
from music_app.services.home_activity import ActivityScope, HomeActivityError
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.lastfm_listen_sync import build_recent_scrobble_delivery
from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services.private_library_authority import (
    current_library_transaction, require_private_action, PrivateLibraryAuthorityError,
)

_SUBMIT = 'integration.lastfm.scrobbles.submit'
_ROW_REF = re.compile(r'activity_[a-f0-9]{64}\Z')
_EVENT_KEY = re.compile(r'listen:event:([1-9][0-9]*)\Z')


@dataclass(frozen=True)
class RecentScrobbleTarget:
    """Internal identity plus reviewed outcome, never sufficient to send."""
    account_id: int
    actor_session_id: int
    library_id: int
    row_id: int
    track_id: int
    entry_id: str
    device_id: str
    playback_session_id: str
    state: str


def _current_target(row, *, context, row_id):
    if (not isinstance(row, dict) or type(row.get('track_id')) is not int or row['track_id'] <= 0
            or row.get('id') != row_id
            or row.get('account_id') != context.actor.account_id
            or row.get('library_id') != context.library_id
            or row.get('source_family') != 'rendered_local_listen_session'
            or row.get('measurement_version') != 'rendered-pcm-v1'):
        raise HomeActivityError('Action not permitted.', 403, 'activity_denied')
    metadata = row.get('metadata')
    payload = metadata.get('source_payload') if isinstance(metadata, dict) else None
    if not isinstance(payload, dict):
        raise HomeActivityError('Occurrence requires review.', 409, 'scrobble_receipt_unavailable')
    entry_id = payload.get('id')
    # The actual measured owner derives this key from the trusted scope and
    # stored device/session. Wire JSON is never used to choose these identities.
    from music_app.services.measured_listen_history import measured_identity
    import hashlib
    from uuid import UUID
    try:
        device_id, session_id = str(UUID(str(row['device_id']))), str(UUID(str(row['session_id'])))
    except (KeyError, ValueError, TypeError, AttributeError):
        raise HomeActivityError('Occurrence requires review.', 409, 'scrobble_receipt_unavailable') from None
    expected = hashlib.sha256(measured_identity(context.actor.account_id,
        context.library_id, device_id, session_id).encode()).hexdigest()
    if (type(entry_id) is not str or entry_id != expected
            or payload.get('device_id') != device_id or payload.get('session_id') != session_id
            or payload.get('measurement_version') != 'rendered-pcm-v1'):
        raise HomeActivityError('Occurrence requires review.', 409, 'scrobble_receipt_unavailable')
    facts = dict(payload)
    # Positive acceptance in either genuine stored representation is a fence.
    # Never infer not_sent from pending/null/failed status or an absent field.
    if row.get('scrobble_status') == 'scrobbled':
        facts['scrobbled'] = True
    delivery = build_recent_scrobble_delivery(facts,
        source_family=row['source_family'], measurement_version=row['measurement_version'],
        connection_state='unknown')
    return RecentScrobbleTarget(context.actor.account_id, context.actor.session_id,
        context.library_id, row_id, row['track_id'], entry_id, device_id, session_id, delivery['state'])


class RecentScrobbleAdmission:
    def __init__(self, config, *, connect=None, clock=None):
        self.config = config
        self.url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self.connect, self.clock = connect, clock

    def review(self, context, *, origin, row_ref, constraints=None):
        """Re-resolve opaque own occurrence and current policy; perform no send."""
        if (not isinstance(context, PolicyContext) or context.target_account_id is not None
                or type(row_ref) is not str or not _ROW_REF.fullmatch(row_ref)):
            raise HomeActivityError('Action not permitted.', 403, 'activity_denied')
        origin, query = normalize_native_origin(origin)
        if origin['audience'] != 'own' or query.kind != 'listens':
            raise HomeActivityError('Action not permitted.', 403, 'activity_denied')
        with current_library_transaction(self.url, context, constraints=constraints,
                connect=self.connect, clock=self.clock) as (connection, live, now):
            require_private_action(live, _SUBMIT, constraints=constraints)
            scope = ActivityScope(live.actor.account_id, live.actor.session_id, live.library_id)

            def resource_actions(kind, identity):
                resource = ResourceScope(kind, str(identity))
                try:
                    require_private_action(live, 'library.browse.read', resource=resource, constraints=constraints)
                except PrivateLibraryAuthorityError:
                    return AllowedActions(())
                return AllowedActions(('library.browse.read',))

            def lastfm_history_read():
                from music_app.services.lastfm_home_snapshot import account_read_allowed
                return account_read_allowed(live, constraints,
                    account_id=scope.account_id, session_id=scope.session_id)
            resource_actions.lastfm_history_read = lastfm_history_read
            resource_actions.scope_wide = not callable(constraints)
            selected = HomeActivityPostgresRepository(self.config).read_native_selection(
                connection, scope=scope, query=query, row_refs=[row_ref],
                allowed_actions_for_resource=resource_actions, now=now)
            if len(selected) != 1 or selected[0].get('row_ref') != row_ref:
                raise HomeActivityError('Action not permitted.', 403, 'activity_denied')
            lineage = selected[0]['lineage']
            match = _EVENT_KEY.fullmatch(lineage.get('row_key', ''))
            if (match is None or lineage.get('audience') != 'own' or lineage.get('kind') != 'listens'
                    or lineage.get('viewer_account_id') != scope.account_id
                    or lineage.get('subject_account_id') != scope.account_id
                    or lineage.get('library_id') != scope.library_id):
                raise HomeActivityError('Action not permitted.', 403, 'activity_denied')
            row_id = int(match.group(1))
            require_private_action(live, _SUBMIT,
                resource=ResourceScope('listen_history', str(row_id)), constraints=constraints)
            row = connection.execute('''select h.id,h.account_id,h.library_id,h.track_id,h.source_family,
                h.measurement_version,h.device_id,h.session_id,h.scrobble_status,h.metadata
                from integration.listen_history h
                join library.local_tracks t on t.id=h.track_id and t.library_id=h.library_id
                where h.id=%s and h.account_id=%s and h.library_id=%s''',
                (row_id, scope.account_id, scope.library_id)).fetchone()
            if row is None:
                raise HomeActivityError('Occurrence changed.', 409, 'scrobble_receipt_unavailable')
            row = dict(row)
            if type(row.get('track_id')) is not int or row['track_id'] <= 0:
                raise HomeActivityError('Occurrence requires review.', 409, 'scrobble_receipt_unavailable')
            if selected[0].get('canonical_resource') != {'kind': 'track', 'id': row['track_id']}:
                raise HomeActivityError('Occurrence changed.', 409, 'scrobble_receipt_unavailable')
            for action in ('library.browse.read', _SUBMIT):
                require_private_action(live, action,
                    resource=ResourceScope('track', str(row['track_id'])), constraints=constraints)
            return _current_target(row, context=live, row_id=row_id)
