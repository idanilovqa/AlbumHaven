"""Last.fm observation multiplicity and reversible, evidence-only correlation."""
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from uuid import UUID

from .measured_listen_history import measured_identity

from .lastfm import LastfmSession, validate_scrobble_reply_identity


class HistoryUnavailable(RuntimeError):
    pass


class HistoryStale(ValueError):
    pass


def binding(session):
    if (type(session) is not LastfmSession or type(session.username) is not str
            or not 1 <= len(session.username) <= 1024
            or session.username != session.username.strip()
            or any(ord(c) < 32 for c in session.username)):
        raise HistoryStale('Last.fm connection is unavailable.')
    try:
        instant = datetime.fromisoformat(session.connected_at.replace('Z', '+00:00'))
        if instant.tzinfo is None or instant.utcoffset() is None:
            raise ValueError()
        return session.username, instant.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError, AttributeError, OverflowError):
        raise HistoryStale('Last.fm connection lineage is unavailable.') from None


def tuple_key(track):
    return track['timestamp'], track['artist'], track['track'], track['album']


def tuple_digest(key):
    return hashlib.sha256(json.dumps(list(key), ensure_ascii=False,
        separators=(',', ':')).encode('utf-8')).hexdigest()


def multiset(pages):
    return Counter(tuple_key(track) for page in pages for track in page['tracks'])


def bound_submission_request(row, *, account_id, library_id, provider_username, connection_started_at):
    """Validate one genuine measured occurrence and its immutable attempt request.

    Called on repository-owned records, not arbitrary request payloads. Returns
    no send authorization and never modifies a receipt, row or timestamp.
    """
    if (any(type(value) is not int or value <= 0 for value in
            (account_id,library_id,row.get('account_id'),row.get('library_id'),row.get('id')))
            or row.get('account_id') != account_id or row.get('library_id') != library_id
            or row.get('source_family') != 'rendered_local_listen_session'
            or row.get('measurement_version') != 'rendered-pcm-v1'):
        return None
    payload = row.get('payload')
    if (type(payload) is not dict
            or payload.get('source_provenance') != {'kind':'local_playback','provider':'album_haven'}):
        return None
    identity = payload.get('scrobble_submission_identity')
    if (type(identity) is not dict or set(identity) != {'version','provider','account_id','library_id',
            'occurrence_id','attempt','provider_username','connection_started_at','request','reply'}
            or type(identity.get('version')) is not int or identity.get('version') != 1
            or type(identity.get('account_id')) is not int or type(identity.get('library_id')) is not int
            or identity.get('provider') != 'lastfm'
            or identity.get('account_id') != account_id or identity.get('library_id') != library_id
            or identity.get('occurrence_id') != payload.get('id')
            or type(identity.get('occurrence_id')) is not str
            or len(identity['occurrence_id']) != 64
            or any(c not in '0123456789abcdef' for c in identity['occurrence_id'])
            or type(identity.get('attempt')) is not int
            or not 1 <= identity['attempt'] <= 5
            or type(payload.get('scrobble_retry_count')) is not int
            or identity['attempt'] != payload.get('scrobble_retry_count')
            or identity.get('provider_username') != provider_username
            or identity.get('connection_started_at') != connection_started_at):
        return None
    try:
        device, session = row['device_id'], row['session_id']
        if (type(device) is not str or type(session) is not str
                or str(UUID(device)) != device or str(UUID(session)) != session):
            return None
        physical = measured_identity(account_id,library_id,device,session)
        if (row.get('source_entry_id') != physical
                or hashlib.sha256(physical.encode()).hexdigest() != identity['occurrence_id']):
            return None
    except (KeyError, ValueError, AttributeError):
        return None
    request = identity.get('request')
    if type(request) is not dict or set(request) != {
            'artist','track','album','album_artist','track_number','timestamp'}:
        return None
    if (type(request['timestamp']) is not int or request['timestamp'] <= 0
            or any(type(request[field]) is not str or len(request[field])>1024
                or any(ord(c)<32 for c in request[field]) for field in
                ('artist','track','album','album_artist','track_number'))
            or not request['artist'] or not request['track']):
        return None
    played = row.get('played_at')
    if (not isinstance(played,datetime) or played.tzinfo is None or played.utcoffset() is None
            or int(played.timestamp()) != request['timestamp']):
        return None
    return request


def uncertain_request_tuple(row, **scope):
    """A possible history observation, never an accepted receipt or send grant."""
    request=bound_submission_request(row,**scope)
    if request is None:return None
    payload=row['payload']
    if (row.get('scrobble_status') == 'scrobbled' or payload.get('scrobbled') is not False
            or payload.get('scrobble_submission_state') not in ('attempting','sent','uncertain')
            or payload['scrobble_submission_identity'].get('reply') is not None):
        return None
    return tuple_key(request)


def accepted_tuple(row, *, account_id, library_id, provider_username, connection_started_at):
    """Only a bound genuine accepted echo qualifies for reversible correlation."""
    request=bound_submission_request(row,account_id=account_id,library_id=library_id,
        provider_username=provider_username,connection_started_at=connection_started_at)
    if request is None:return None
    payload=row['payload']
    if payload.get('scrobble_submission_state')!='accepted' or payload.get('scrobbled') is not True:
        return None
    identity=payload['scrobble_submission_identity']
    try:
        reply = validate_scrobble_reply_identity(identity.get('reply'), request=request)
    except (KeyError, TypeError, ValueError):
        return None
    if reply is None:
        return None
    return tuple_key(reply)


def reconcile_observed(native_rows, imported_rows, *, account_id, library_id,
                       provider_username, connection_started_at, uncertain_timestamps):
    """Derived links only. Every raw row is retained in the returned sources.

    Consumers count each link once plus each unmatched source. They must display
    uncertainty and the exact_observed_tuple label; this is not provider-ID proof.
    """
    native_by_key, remote_by_key = defaultdict(list), defaultdict(list)
    native_rows, imported_rows = list(native_rows), list(imported_rows)
    for row in native_rows:
        key = accepted_tuple(row, account_id=account_id, library_id=library_id,
            provider_username=provider_username, connection_started_at=connection_started_at)
        if key is not None and key[0] not in uncertain_timestamps:
            native_by_key[key].append(row)
    for row in imported_rows:
        if (row['account_id'] == account_id and row['provider_username'] == provider_username
                and row['connection_started_at'] == connection_started_at
                and row['played_at'] not in uncertain_timestamps):
            remote_by_key[(row['played_at'],row['artist'],row['track'],row['album'])].append(row)
    links = []
    for key in sorted(native_by_key.keys() & remote_by_key.keys()):
        # Duplicate native evidence IDs are ambiguous, never merged twice.
        native = sorted(native_by_key[key], key=lambda row: row['id'])
        ids = [row['payload']['id'] for row in native]
        if len(set(ids)) != len(ids):
            continue
        remote = sorted(remote_by_key[key], key=lambda row: row['ordinal'])
        if len({row['ordinal'] for row in remote}) != len(remote):
            continue
        for own, imported in zip(native, remote):
            links.append({'native_id': own['id'], 'remote_key': [imported['played_at'],
                imported['tuple_digest'], imported['ordinal']], 'kind': 'exact_observed_tuple'})
    return {'native': native_rows, 'imported': imported_rows, 'links': links,
        'uncertain_timestamps': sorted(uncertain_timestamps),
        'combined_count': len(native_rows) + len(imported_rows) - len(links)}
