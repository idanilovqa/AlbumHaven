"""Current-authority, cache-only global popularity Search and native re-proof.

Every page/action reevaluates the complete admitted library. The 100-row wire
limit does not bound capture, locks, memory, or ranking work.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import hmac
import json
import math
import re

from music_app.services.admin_member_mutation_postgres import (
    lock_current_actor_session, RecentAuthenticationRequired,
)
from music_app.services.postgres_connections import pooled_connection
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import (
    current_library_transaction, require_private_action, PrivateLibraryAuthorityError,
)
from music_app.services.private_search_contract import (
    PrivateSearchError, PopularitySearchRequest, normalize_popularity_search_query,
)
from music_app.services.private_popularity_search_cursor import PopularitySearchCodec
from music_app.services import private_popularity_search_inventory as inventory
from music_app.services.popularity_snapshots import select_local_popular_tracks
from music_app.services.private_native_targets import PrivateNativeTargets, NativeTargetError
from music_app.services.library_roots import (
    normalize_persisted_library_root_settings, _root_paths_from_settings,
    resolve_configured_media_path,
)

_UINT = 9007199254740991
_REASONS = ('missing_recording_identity', 'missing_provider_mapping', 'provider_unavailable',
            'mapping_mismatch', 'missing_global_metric', 'ambiguous_attribution',
            'missing_canonical_artist')
_ABSENT = object()


def _unavailable():
    raise PrivateSearchError('private_search_unavailable', 503)


def _restart():
    raise PrivateSearchError('search_cursor_restart_required', 409)


def _text(value, maximum, *, nullable=False, nonempty=False):
    if value is None and nullable:
        return None
    if (type(value) is not str or '\0' in value
            or any('\ud800' <= ch <= '\udfff' for ch in value)
            or nonempty and not value or len(value) > maximum):
        _unavailable()
    return value


def _label(value):
    if value is None:
        return None
    _text(value, max(1024, len(value)) if type(value) is str else 1024)
    return value[:1024]


def _duration(value):
    if value is None:
        return None
    if type(value) not in (int, float, Decimal) or not math.isfinite(value) or not 0 <= value <= _UINT:
        _unavailable()
    return float(value) if type(value) is Decimal else value


def _exact(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        _unavailable()
    return value


def _booleans(value, keys):
    _exact(value, keys)
    if any(type(item) is not bool for item in value.values()):
        _unavailable()
    return value


def _date(value):
    if not isinstance(value, datetime) or value.utcoffset() is None:
        _unavailable()
    return value.astimezone(timezone.utc).isoformat()


def _private_value(value):
    """Canonical private evidence only; never serialize this into a DTO/token."""
    if isinstance(value, datetime):
        return {'utc_datetime': _date(value)}
    if isinstance(value, Decimal):
        if not value.is_finite():
            _unavailable()
        return {'decimal': str(value)}
    if type(value) is dict:
        return {key: _private_value(item) for key, item in value.items()}
    if type(value) in (tuple, list):
        return [_private_value(item) for item in value]
    return value


def _digest(value):
    return hashlib.sha256(json.dumps(_private_value(value), sort_keys=True,
        separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')).hexdigest()


def normalize_popularity_native_command(command, *, operation):
    """Validate all syntax before any capture or native execution."""
    if operation not in {'bindings', 'single', 'batch'} or type(command) is not dict:
        raise PrivateSearchError()
    keys = ({'result_token', 'row_ref', 'intent'} if operation == 'single' else
            {'result_token', 'row_refs'} | ({'intent'} if operation == 'batch' else set()))
    if set(command) != keys and not (operation == 'single' and set(command) == keys | {'target_kind'}):
        raise PrivateSearchError()
    token = command['result_token']
    if type(token) is not str or not token.isascii() or not 1 <= len(token) <= 4096:
        raise PrivateSearchError()
    intent = command.get('intent')
    if operation != 'bindings' and (type(intent) is not str or intent not in (
            {'metadata', 'play', 'details'} if operation == 'single' else {'metadata', 'play'})):
        raise PrivateSearchError('invalid_command', 422)
    if 'target_kind' in command and (intent != 'details' or command['target_kind'] != 'album'
                                       or type(command['target_kind']) is not str):
        raise PrivateSearchError('invalid_command', 422)
    refs = [command['row_ref']] if operation == 'single' else command['row_refs']
    if (type(refs) is not list or not 1 <= len(refs) <= 100
            or any(type(ref) is not str or re.fullmatch(r'popular_[0-9a-f]{64}', ref) is None for ref in refs)
            or len(set(refs)) != len(refs)):
        raise PrivateSearchError()
    return refs


def _native_target(target, *, intent, library_id, track_id):
    """Validate the actual native owner's exact target; never invent authority."""
    coordinate = f'inventory-track:{library_id}:{track_id}'
    if intent == 'details':
        _exact(target, ('album_ref', 'allowed_actions'))
        _text(target['album_ref'], 16384, nonempty=True)
        actions = _booleans(target['allowed_actions'], ('can_view_details', 'can_play_album'))
        if actions['can_view_details'] is not True:
            _unavailable()
        return target
    labels = ('title', 'artist', 'album_title', 'duration_seconds')
    if intent == 'play':
        _exact(target, ('inventory_track_ref', 'track_ref', 'path', *labels))
        _text(target['track_ref'], 16384, nonempty=True)
        if target['path'] != target['track_ref']:
            _unavailable()
    else:
        _exact(target, ('inventory_track_ref', 'track_ref', 'canonical_track_ref',
            'source_readable', *labels, 'availability', 'allowed_actions', 'playback_state',
            'track_preference'))
        _text(target['track_ref'], 16384, nullable=True, nonempty=True)
        if (target['canonical_track_ref'] != target['track_ref'] or target['source_readable'] is not True
                or target['availability'] not in {'local', 'unresolved'}):
            _unavailable()
        actions = _booleans(target['allowed_actions'], ('can_read', 'can_play'))
        playback = _booleans(target['playback_state'], ('can_start_here',))
        if actions['can_read'] is not True or playback['can_start_here'] != actions['can_play']:
            _unavailable()
        preference = target['track_preference']
        if preference is not None:
            _exact(preference, ('rating', 'love_tier', 'allowed_actions'))
            rating = preference['rating']
            if (rating is not None and (type(rating) is not int or not 1 <= rating <= 5)
                    or preference['love_tier'] not in {'off', 'loved', 'obsessed'}):
                _unavailable()
            pref_actions = _exact(preference['allowed_actions'],
                ('client_surface_class', 'can_rate', 'can_set_love_tier'))
            if (pref_actions['client_surface_class'] not in {'cloud_web', 'private_web', 'desktop', 'mobile', 'tv', 'node'}
                    or type(pref_actions['can_rate']) is not bool or type(pref_actions['can_set_love_tier']) is not bool):
                _unavailable()
    if target['inventory_track_ref'] != coordinate:
        _unavailable()
    return {**target, **{key: _label(target[key]) for key in labels[:-1]},
            'duration_seconds': _duration(target['duration_seconds'])}


class PostgresPopularitySearch:
    def __init__(self, config, *, connect=None, clock=None):
        self._config = config
        self._url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def _now(self):
        now = self._clock()
        if not isinstance(now, datetime) or now.utcoffset() is None:
            _unavailable()
        seconds = math.floor(now.timestamp())
        if not 0 <= seconds <= _UINT:
            _unavailable()
        return seconds

    @contextmanager
    def _authorized(self, context, constraints):
        try:
            if not self._url:
                _unavailable()
            with current_library_transaction(self._url, context, constraints=constraints,
                    connect=self._connect, clock=self._clock, read_only=True) as transaction:
                yield transaction
        except (PrivateLibraryAuthorityError, RecentAuthenticationRequired):
            raise PrivateSearchError('private_search_forbidden', 403) from None

    def _native_targets(self, connection, live):
        # Always settings before inventory, including metadata/details/bindings.
        row = connection.execute('''select settings_payload from library.library_root_settings
            where library_id=%s for share''', (live.library_id,)).fetchone()
        roots = ()
        if row is not None:
            roots = _root_paths_from_settings(normalize_persisted_library_root_settings(row['settings_payload']))

        def media_resolver(config, raw_path, *, configured_root_paths=None, **options):
            return resolve_configured_media_path(config, raw_path,
                configured_root_paths=roots if configured_root_paths is None else configured_root_paths,
                **options)

        return PrivateNativeTargets(self._config, media_resolver=media_resolver)

    def _scope(self, live, request, context_ref):
        if type(context_ref) is not str or re.fullmatch('[0-9a-f]{64}', context_ref) is None:
            raise PrivateSearchError('stale_context', 409)
        return _digest(['popularity-search-v1', live.actor.account_id, live.actor.session_id,
            live.library_id, context_ref, request.criteria.semantic_payload(),
            request.visibility_payload(), request.limit])

    def _evaluate(self, connection, live, request, context_ref, codec, token, constraints):
        scope = self._scope(live, request, context_ref)
        if token is not None and not hmac.compare_digest(scope, token['scope_digest']):
            _restart()
        captured = inventory.capture(connection, live, request, constraints=constraints)
        selection = select_local_popular_tracks(captured.tracks,
            is_local_readable=lambda item: item.track_id in captured.matched_rows,
            matches_filter=lambda item: item.track_id in captured.matched_rows,
            read_snapshot=lambda item: captured.snapshots.get(item.track_id),
            max_per_artist=request.criteria.per_artist, max_per_group=None,
            offset=0, limit=max(1, len(captured.matched_rows)))
        if selection.total != len(selection.tracks) or selection.total > _UINT:
            _unavailable()
        selected = tuple(track.track_id for track in selection.tracks)
        evidence = _digest({'version': 1, 'scope': scope, 'universe': captured.universe,
            'facets': captured.facet_frame_text,
            'decisions': sorted((kind, identity, allowed) for (kind, identity), allowed in captured.decision_map.items()),
            'cache_rows': [captured.matched_rows[key] for key in sorted(captured.matched_rows)],
            'selected': selected})
        if token is not None and not hmac.compare_digest(evidence, token['evidence_digest']):
            _restart()
        refs = {codec.row_ref(evidence, live.library_id, identity): identity for identity in selected}
        if len(refs) != len(selected):
            _unavailable()
        return captured, selection, scope, evidence, refs

    def _finalize(self, connection, live, captured, expires_at, constraints):
        lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id, clock=self._clock)
        require_private_action(live, 'library.browse.read', constraints=constraints)
        try:
            inventory.recheck_admission(live, captured.universe, captured.decision_map, constraints=constraints)
        except inventory.CaptureChanged:
            # An authority change is not the initial capture-race retry case.
            _restart()
        if self._now() >= expires_at:
            _restart()

    @staticmethod
    def _payload(request, scope, evidence, offset, issued_at):
        return {'version': 1, 'kind': 'publication', 'scope_digest': scope,
            'evidence_digest': evidence, 'offset': offset, 'limit': request.limit,
            'issued_at': issued_at, 'expires_at': issued_at + 1800,
            'query': request.query, 'visibility': request.visibility_payload()}

    @staticmethod
    def _coverage(captured, selection):
        reasons = {key: set() for key in _REASONS}
        for identity, reason in (*captured.diagnostics, *selection.diagnostics):
            if reason not in reasons or identity not in captured.matched_rows:
                _unavailable()
            reasons[reason].add(identity)
        dates = [captured.snapshots[item.track_id].observation.observed_at for item in selection.tracks]
        return {'provider': 'lastfm', 'metric': 'overall_scrobbles',
            'label': 'Last.fm global scrobbles', 'genre_basis': 'stored_local_file_tags',
            'matched_local_rows': len(captured.matched_rows), 'selected_recordings': selection.total,
            'missing_genre_local_rows': captured.missing_genre_local_rows,
            'excluded_local_rows': {key: len(value) for key, value in reasons.items()},
            'oldest_observed_at': _date(min(dates)) if dates else None,
            'newest_observed_at': _date(max(dates)) if dates else None,
            'refresh_status': captured.refresh_status}

    def read(self, context, *, request, context_ref, cursor_secret, constraints=None):
        if type(request) is not PopularitySearchRequest:
            raise PrivateSearchError()
        codec = PopularitySearchCodec(cursor_secret)
        now = self._now()
        token = codec.decode(request.cursor, 'page', now) if request.cursor is not None else None
        issued = token['issued_at'] if token else now
        # Fail oversized query/visibility before O(library) evaluation.
        preflight = self._payload(request, '0' * 64, '0' * 64, 0, issued)
        codec.encode(preflight, 'publication', now)
        for attempt in range(2 if token is None else 1):
            try:
                with self._authorized(context, constraints) as (connection, live, _):
                    captured, selection, scope, evidence, refs = self._evaluate(
                        connection, live, request, context_ref, codec, token, constraints)
                    offset = token['offset'] if token else 0
                    if token is not None and offset >= selection.total:
                        _restart()
                    row_refs = list(refs)[offset:offset + request.limit]
                    tracks = []
                    for ref in row_refs:
                        identity = refs[ref]
                        row, observation = captured.matched_rows[identity], captured.snapshots[identity].observation
                        tracks.append({'id': ref, 'kind': 'track', 'title': _label(row['title']),
                            'artist': _label(row['artist']), 'album_title': _label(row['album_title']),
                            'duration_seconds': _duration(row['duration_seconds']), 'availability': 'local',
                            'popularity': {'provider': 'lastfm', 'metric': 'overall_scrobbles',
                                'count': observation.count, 'observed_at': _date(observation.observed_at)}})
                    payload = self._payload(request, scope, evidence, offset, issued)
                    result_token = codec.encode(payload, 'publication', self._now())
                    has_more = offset + len(tracks) < selection.total
                    next_cursor = codec.encode({**payload, 'kind': 'page', 'offset': offset + len(tracks)},
                        'page', self._now()) if has_more else None
                    result = {'status': 'ready', 'private_search': True, 'contract_version': 'popularity-search-v1',
                        'context_ref': context_ref, 'query': request.query, 'criteria': request.criteria.as_payload(),
                        'presentation': 'tracks', 'tracks': tracks,
                        'page': {'limit': request.limit, 'returned_count': len(tracks), 'has_more': has_more,
                            'next_cursor': next_cursor, 'total_matches': selection.total},
                        'popularity': self._coverage(captured, selection), 'native': {'result_token': result_token}}
                    self._finalize(connection, live, captured, issued + 1800, constraints)
                    return result
            except inventory.CaptureChanged:
                if token is not None or attempt:
                    _restart()
        _restart()

    def _native(self, context, *, operation, command, context_ref, cursor_secret, constraints):
        requested = normalize_popularity_native_command(command, operation=operation)
        codec = PopularitySearchCodec(cursor_secret)
        token = codec.decode(command['result_token'], 'publication', self._now())
        request = PopularitySearchRequest(query=token['query'],
            criteria=normalize_popularity_search_query(token['query']), limit=token['limit'],
            gallery_scope=token['visibility']['gallery_scope'], categories=tuple(token['visibility']['categories']))
        try:
            with self._authorized(context, constraints) as (connection, live, _):
                targets = self._native_targets(connection, live)
                captured, selection, scope, evidence, refs = self._evaluate(
                    connection, live, request, context_ref, codec, token, constraints)
                offset = token['offset']
                if offset > selection.total or offset == selection.total and offset != 0:
                    _restart()
                interval = set(list(refs)[offset:offset + token['limit']])
                if any(ref not in interval for ref in requested):
                    raise PrivateSearchError('private_search_forbidden', 403)
                # Membership for the whole command precedes every native call.
                def resolve(ref, intent):
                    identity = refs[ref]
                    try:
                        target = (targets.resolve_album(connection, live,
                            captured.matched_rows[identity]['original_album_id'], constraints=constraints)
                            if intent == 'details' else targets.resolve(connection, live, identity,
                                intent=intent, constraints=constraints))
                    except NativeTargetError as error:
                        if error.code in {'forbidden', 'item_unavailable'}:
                            return None
                        _unavailable()
                    return _native_target(target, intent=intent, library_id=live.library_id, track_id=identity)

                items = []
                for ref in requested:
                    if operation == 'bindings':
                        metadata, album = resolve(ref, 'metadata'), resolve(ref, 'details')
                        parent = None if album is None else {'kind': 'album', 'row_ref': ref,
                            'identity_ref': f"inventory-album:{live.library_id}:{captured.matched_rows[refs[ref]]['original_album_id']}",
                            'allowed_actions': {'can_view_details': True}}
                        items.append({'row_ref': ref, 'allowed_actions': {
                            'can_play': metadata is not None and metadata['allowed_actions']['can_play'],
                            'can_view_metadata': metadata is not None, 'can_view_details': parent is not None},
                            'album_target': parent})
                    else:
                        intent = command['intent']
                        target = resolve(ref, intent)
                        items.append({'row_ref': ref, 'intent': intent,
                            'target_kind': 'album' if intent == 'details' else None,
                            'status': 'ready' if target is not None else 'unavailable', 'native_target': target})
                # Recheck media intent after all resolutions. Browse cannot
                # retain a path when a dynamic media constraint has revoked it.
                for ref, item in zip(requested, items):
                    try:
                        require_private_action(live, 'library.media.read',
                            resource=ResourceScope('track', str(refs[ref])), constraints=constraints)
                        media_allowed = True
                    except PrivateLibraryAuthorityError:
                        media_allowed = False
                    if operation != 'bindings' and item['intent'] == 'details' and item['native_target'] is not None:
                        album_id = captured.matched_rows[refs[ref]]['original_album_id']
                        try:
                            require_private_action(live, 'library.media.read',
                                resource=ResourceScope('album', str(album_id)), constraints=constraints)
                            album_tracks = connection.execute('''select id from library.local_tracks
                                where library_id=%s and album_id=%s order by id''',
                                (live.library_id, album_id)).fetchall()
                            album_media = bool(album_tracks)
                            for track in album_tracks:
                                for action in ('library.browse.read', 'library.media.read'):
                                    require_private_action(live, action,
                                        resource=ResourceScope('track', str(track['id'])), constraints=constraints)
                        except PrivateLibraryAuthorityError:
                            album_media = False
                        item['native_target']['allowed_actions']['can_play_album'] = (
                            item['native_target']['allowed_actions']['can_play_album'] and album_media)
                    if not media_allowed:
                        if operation == 'bindings':
                            item['allowed_actions']['can_play'] = False
                        elif item['intent'] == 'play':
                            item.update(status='unavailable', native_target=None)
                        elif item['intent'] == 'metadata' and item['native_target'] is not None:
                            item['native_target']['allowed_actions']['can_play'] = False
                            item['native_target']['playback_state']['can_start_here'] = False
                versions = {'bindings': 'popularity-search-native-bindings-v1',
                    'single': 'popularity-search-native-v1', 'batch': 'popularity-search-native-batch-v1'}
                result = {'status': 'ready', 'private_search': True, 'contract_version': versions[operation],
                    'context_ref': context_ref, 'result_token': command['result_token'],
                    'data': items[0] if operation == 'single' else {'items': items}}
                self._finalize(connection, live, captured, token['expires_at'], constraints)
                return result
        except inventory.CaptureChanged:
            _restart()

    def project_bindings(self, context, *, result_token, row_refs, context_ref, cursor_secret, constraints=None):
        return self._native(context, operation='bindings', command={'result_token': result_token, 'row_refs': row_refs},
            context_ref=context_ref, cursor_secret=cursor_secret, constraints=constraints)

    def resolve_target(self, context, *, result_token, row_ref, intent, context_ref, cursor_secret,
                       target_kind=_ABSENT, constraints=None):
        command = {'result_token': result_token, 'row_ref': row_ref, 'intent': intent}
        if target_kind is not _ABSENT:
            command['target_kind'] = target_kind
        return self._native(context, operation='single', command=command,
            context_ref=context_ref, cursor_secret=cursor_secret, constraints=constraints)

    def resolve_targets(self, context, *, result_token, row_refs, intent, context_ref, cursor_secret, constraints=None):
        return self._native(context, operation='batch',
            command={'result_token': result_token, 'row_refs': row_refs, 'intent': intent},
            context_ref=context_ref, cursor_secret=cursor_secret, constraints=constraints)
