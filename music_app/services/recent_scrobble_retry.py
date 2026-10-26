"""Internal targeted measured retry through the existing guarded bridge.

No HTTP route is installed. A Recent resolver result is only a locator: each
claim reacquires live authority and rereads exact server-owned receipt facts.
"""
from datetime import datetime, timedelta, timezone

from music_app.services.home_activity import HomeActivityError
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from music_app.services.lastfm import get_saved_lastfm_session, lastfm_api_enabled, scrobble_track
from music_app.services.lastfm_sync_bridge import (
    _submit_guarded_measured_scrobble, build_pending_scrobble_payload,
    validate_pending_scrobble_payload,
)
from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter, _listen_history_item_from_row
from music_app.services.measured_listen_history import measured_provider_guard, measured_identity
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import current_library_transaction, require_private_action, PrivateLibraryAuthorityError
from music_app.services.recent_scrobble_admission import RecentScrobbleAdmission, _current_target

_SUBMIT = 'integration.lastfm.scrobbles.submit'


def _retry_payload_and_count(entry, now, played_at):
    """Strict current retry gate; no missing-state inference or timestamp reset."""
    if (entry.get('scrobbled') is not False or entry.get('scrobble_eligible') is not True
            or entry.get('scrobble_submission_state') != 'not_sent'
            or entry.get('scrobble_retryable') is not True
            or entry.get('scrobble_retry_exhausted', False) is not False
            or entry.get('scrobble_reauthentication_required', False) is not False):
        return None
    count = entry.get('scrobble_retry_count', 0)
    if type(count) is not int or not 0 <= count < 5:
        return None
    timestamp = entry.get('started_at_unix')
    if type(timestamp) is not int or timestamp <= 0:
        return None
    try:
        started = datetime.fromisoformat(str(entry['started_at']).replace('Z', '+00:00'))
        if (started.tzinfo is None or started.utcoffset() is None or int(started.timestamp()) != timestamp
                or started > now or not isinstance(played_at, datetime) or played_at != started):
            return None
        if count:
            previous = datetime.fromisoformat(str(entry['last_scrobble_attempt_at']).replace('Z', '+00:00'))
            if previous.tzinfo is None or previous.utcoffset() is None:
                return None
            if now < previous + timedelta(seconds=min(1800, 60 * (2 ** (count - 1)))):
                return None
        payload = build_pending_scrobble_payload(entry)
        if validate_pending_scrobble_payload(payload) or payload['timestamp'] != timestamp:
            return None
    except (KeyError, ValueError, TypeError, OverflowError):
        return None
    return payload, count


class RecentScrobbleRetry:
    def __init__(self, config, *, connect=None, clock=None):
        self.config = config
        self.url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self.connect, self.clock = connect, clock

    def submit(self, context, *, origin, row_ref, constraints=None):
        # Phase A ends before the provider owner is entered: no Home snapshot
        # or revision lock can self-block the delivery update's 0156 trigger.
        target = RecentScrobbleAdmission(self.config, connect=self.connect, clock=self.clock).review(
            context, origin=origin, row_ref=row_ref, constraints=constraints)
        with measured_provider_guard(self.config, account_id=target.account_id,
                library_id=target.library_id, device_id=target.device_id,
                session_id=target.playback_session_id):
            # Same provider -> account order as the existing measured bridge.
            # Do not call append_measured here: the retry only updates an exact
            # existing row, using a separate committed receipt transaction.
            with current_library_transaction(self.url, context, constraints=constraints,
                    connect=self.connect, clock=self.clock) as (connection, live, now):
                if (live.actor.account_id, live.actor.session_id, live.library_id) != (
                        target.account_id, target.actor_session_id, target.library_id):
                    raise HomeActivityError('Action not permitted.', 403, 'activity_denied')
                require_private_action(live, _SUBMIT, constraints=constraints)
                require_private_action(live, _SUBMIT,
                    resource=ResourceScope('listen_history', str(target.row_id)), constraints=constraints)
                row = connection.execute('''select h.* from integration.listen_history h
                    join library.local_tracks t on t.id=h.track_id and t.library_id=h.library_id
                    where h.id=%s and h.account_id=%s and h.library_id=%s''',
                    (target.row_id, target.account_id, target.library_id)).fetchone()
                if row is None:
                    raise HomeActivityError('Occurrence changed.', 409, 'scrobble_receipt_unavailable')
                row = dict(row)
                current = _current_target(row, context=live, row_id=target.row_id)
                if row.get('source_entry_id') != measured_identity(target.account_id,
                        target.library_id, current.device_id, current.playback_session_id):
                    raise HomeActivityError('Occurrence changed.', 409, 'scrobble_receipt_unavailable')
                if (current.entry_id, current.device_id, current.playback_session_id, current.track_id) != (
                        target.entry_id, target.device_id, target.playback_session_id, target.track_id):
                    raise HomeActivityError('Occurrence changed.', 409, 'scrobble_receipt_unavailable')
                for action in ('library.browse.read', _SUBMIT):
                    require_private_action(live, action,
                        resource=ResourceScope('track', str(row['track_id'])), constraints=constraints)
                # Positive column evidence is tested directly, even when malformed
                # provenance prevents the presentation classifier saying accepted.
                entry = _listen_history_item_from_row(row)
                if (row.get('scrobble_status') == 'scrobbled' or entry.get('scrobbled') is True
                        or entry.get('scrobble_submission_state') in ('accepted', 'attempting', 'sent', 'uncertain')
                        or current.state != 'not_sent'):
                    return {'attempted': False, 'state': current.state, 'result': 'not_submitted'}
                checked = _retry_payload_and_count(entry, now, row['played_at'])
                if checked is None:
                    return {'attempted': False, 'state': current.state, 'result': 'retry_blocked'}
                if not lastfm_api_enabled(self.config):
                    return {'attempted': False, 'state': current.state, 'result': 'connection_unavailable'}
                session = get_saved_lastfm_session(self.config, account_id=target.account_id)
                if session is None:
                    return {'attempted': False, 'state': current.state, 'result': 'connection_unavailable'}
                # Time-based expiry is not stopped by holding a row lock. Reuse
                # the real session owner immediately before the durable claim.
                now = lock_current_actor_session(connection, actor_account_id=target.account_id,
                    actor_session_id=target.actor_session_id,
                    clock=self.clock or (lambda: datetime.now(timezone.utc)))
                require_private_action(live, _SUBMIT, constraints=constraints)
                require_private_action(live, _SUBMIT,
                    resource=ResourceScope('listen_history', str(target.row_id)), constraints=constraints)
                for action in ('library.browse.read', _SUBMIT):
                    require_private_action(live, action,
                        resource=ResourceScope('track', str(row['track_id'])), constraints=constraints)
                checked = _retry_payload_and_count(entry, now, row['played_at'])
                if checked is None:
                    return {'attempted': False, 'state': current.state, 'result': 'retry_blocked'}
                payload, count = checked
                adapter = PostgresListenHistoryAdapter(self.config)
                expected_row = {key: row[key] for key in (
                    'id', 'account_id', 'library_id', 'track_id', 'source_family',
                    'measurement_version', 'device_id', 'session_id', 'source_entry_id', 'played_at')}
                attempted_at = now.astimezone(timezone.utc).isoformat()

                def before_provider():
                    try:
                        require_private_action(live, _SUBMIT, constraints=constraints)
                        require_private_action(live, _SUBMIT,
                            resource=ResourceScope('listen_history', str(target.row_id)), constraints=constraints)
                        for action in ('library.browse.read', _SUBMIT):
                            require_private_action(live, action,
                                resource=ResourceScope('track', str(row['track_id'])), constraints=constraints)
                        # Last blocking boundary before provider: sample time
                        # AFTER policy callbacks and the session query return.
                        lock_current_actor_session(connection, actor_account_id=target.account_id,
                            actor_session_id=target.actor_session_id,
                            clock=self.clock or (lambda: datetime.now(timezone.utc)))
                    except (RecentAuthenticationRequired, PrivateLibraryAuthorityError):
                        return False
                    return True

                def update(_config, entry_id, updates, *, account_id, library_id):
                    if (entry_id, account_id, library_id) != (target.entry_id, target.account_id, target.library_id):
                        raise HomeActivityError('Action not permitted.', 403, 'activity_denied')
                    claiming = updates.get('scrobble_submission_state') == 'attempting'
                    values = dict(updates)
                    if not claiming:
                        values['scrobble_retry_exhausted'] = count + 1 >= 5
                        if count + 1 >= 5:
                            values['scrobble_retryable'] = False
                        if values.get('scrobbled') is True:
                            values['scrobbled_at'] = attempted_at
                    return adapter.update_scoped_entry(account_id=account_id, library_id=library_id,
                        row_id=target.row_id, entry_id=entry_id, updates=values,
                        expected_receipt=entry if claiming else None, expected_row=expected_row)

                stored, _accepted, _error, attempted = _submit_guarded_measured_scrobble(
                    self.config, entry, payload, account_id=target.account_id, library_id=target.library_id,
                    lastfm_session=session, update_listen_history_entry=update, scrobble_track=scrobble_track,
                    claim_updates={'scrobble_retry_count': count + 1, 'last_scrobble_attempt_at': attempted_at},
                    before_provider=before_provider)
                reviewed_row = {**row, 'metadata': {**dict(row.get('metadata') or {}), 'source_payload': stored}}
                state = _current_target(reviewed_row, context=live, row_id=target.row_id).state
                return {'attempted': attempted, 'state': state, 'result': 'attempted' if attempted else 'claim_changed'}
