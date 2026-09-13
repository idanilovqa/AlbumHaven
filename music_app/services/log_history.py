from __future__ import annotations
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import hashlib
import json
import logging
import math
import re
import uuid


class LogHistoryQueryError(ValueError):

    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code
        self.payload = {'ok': False, 'error': message}

@dataclass(frozen=True)
class HistoryScope:
    library_id: int
    account_id: int | None = None
    origin_kind: str = 'background'

    def __post_init__(self):
        if type(self.library_id) is not int or self.library_id <= 0:
            raise ValueError('Valid history library scope is required')
        if self.account_id is not None and (type(self.account_id) is not int or self.account_id <= 0):
            raise ValueError('Invalid history actor')
        if self.origin_kind not in ('request', 'background', 'retry'):
            raise ValueError('Invalid history origin')

@dataclass(frozen=True)
class LogHistoryQuery:
    from_utc: str | None = None
    to_utc: str | None = None
    sources: tuple[str, ...] = ()
    event_types: tuple[str, ...] = ()
    event_ids: tuple[str, ...] = ()
    text: str = ''


def _utc(value):
    if not isinstance(value, str) or len(value) > 64 or 'T' not in value:
        raise LogHistoryQueryError('History dates require an explicit timezone')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat()
    except ValueError:
        raise LogHistoryQueryError('Invalid history timestamp') from None


def normalize_log_history_query(payload=None):
    if isinstance(payload, LogHistoryQuery):
        payload = asdict(payload)
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise LogHistoryQueryError('Invalid history query')
    values = {key: _utc(payload[key]) if payload.get(key) else None for key in ('from_utc', 'to_utc')}
    if values['from_utc'] and values['to_utc'] and (values['from_utc'] >= values['to_utc']):
        raise LogHistoryQueryError('History interval must have positive length')
    for key in ('sources', 'event_types', 'event_ids'):
        raw = payload.get(key, [])
        if (not isinstance(raw, (list, tuple)) or len(raw) > 100
                or any(not isinstance(value, str) or not value.strip() or len(value) > 256 for value in raw)):
            raise LogHistoryQueryError('History filters allow at most 100 nonempty strings of 256 characters')
        values[key] = tuple(sorted(set((value.strip() for value in raw))))
    text = payload.get('text', '')
    if not isinstance(text, str) or len(text) > 2048:
        raise LogHistoryQueryError('History text must be a string of at most 2048 characters')
    return LogHistoryQuery(**values, text=text.strip())


def history_query_fingerprint(query):
    return hashlib.sha256(json.dumps(asdict(query), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _sanitize_text(value):
    text = str(value)
    text = re.sub('(?i)\\bauthorization\\s*[:=]\\s*bearer\\s+[^\\s,;]+', '[redacted]', text)
    text = re.sub('(["\\\'])(?:[A-Za-z]:[\\\\/]|\\\\\\\\|/)[^"\\\']*\\1', '[path]', text)
    text = re.sub('https?://[^\\s/@:]+:[^\\s/@]+@', 'https://[redacted]@', text, flags=re.I)
    text = re.sub('(?i)\\b(?:token|password|secret|authorization|api[_-]?key)\\s*[:=]\\s*[^\\s,;]+', '[redacted]', text)
    text = re.sub('[A-Za-z]:[\\\\/][^\\s,;]+|\\\\\\\\[^\\s,;]+|(?<![\\w:])/(?:[^\\s/]+/)*[^\\s,;]+', '[path]', text)
    return text[:8192]
_TEXT_FIELDS = frozenset(('id', 'action', 'source', 'source_label', 'level', 'message', 'error', 'artist', 'album', 'title', 'event_type'))
_NUMBER_FIELDS = frozenset(('count', 'file_count', 'processed', 'downloaded', 'not_touched', 'not_found', 'failed', 'skipped', 'updated', 'created', 'deleted', 'retry_count', 'elapsed_seconds'))


def _normalize_log_history_item(entry):
    result = {}
    for key in _TEXT_FIELDS:
        if isinstance(entry.get(key), (str, int, float)):
            result[key] = _sanitize_text(entry[key])
    for key in _NUMBER_FIELDS:
        value = entry.get(key)
        if type(value) in (int, float) and math.isfinite(value):
            result[key] = value
    result['id'] = result.get('id') or uuid.uuid4().hex
    value = entry.get('timestamp')
    try:
        result['timestamp'] = _utc(value.isoformat() if isinstance(value, datetime) else value)
    except LogHistoryQueryError:
        result['timestamp'] = datetime.now(timezone.utc).isoformat()
    result.setdefault('action', 'Activity')
    return result


def append_log_history(config, entry, *, scope=None):
    if scope is None:
        logging.getLogger(__name__).debug('Operational history event omitted: no trusted library provenance')
        return []
    return LogHistoryPostgresAdapter(config).append(_normalize_log_history_item(entry), scope=scope)


def load_log_history_snapshot(config, *, scope, query=None, cursor=None, page_size=500, snapshot=None):
    query = normalize_log_history_query(query)
    return LogHistoryPostgresAdapter(config).page(scope=scope, query=query, cursor=cursor, page_size=page_size, snapshot=snapshot)


def export_log_history(config, *, scope, query=None, snapshot=None):
    query = normalize_log_history_query(query)
    return LogHistoryPostgresAdapter(config).export(scope=scope, query=query, snapshot=snapshot)


def load_log_history(config, *, scope):
    return load_log_history_snapshot(config, scope=scope)['items']


def load_log_history_revision(config, *, scope):
    return LogHistoryPostgresAdapter(config).revision(scope=scope)


def _reset_log_history_for_tests():
    pass

async def history_scope_for_request(request, *, required=True):
    from fastapi import HTTPException
    from music_app.services.current_actor_asgi import current_actor_from_request
    from music_app.services.policy_asgi import _library_scope
    actor = await current_actor_from_request(request)
    library_id = _library_scope(actor, 'library.logs.read', None)
    if not actor.is_authenticated or actor.account_id is None or library_id is None:
        if required:
            raise HTTPException(status_code=403, detail='Current library membership is required')
        return None
    scope = HistoryScope(library_id=library_id, account_id=actor.account_id, origin_kind='request')
    request.state.history_scope = scope
    return scope


def resolve_media_host_history_scope(config):
    from music_app.services.library_roots import configured_library_root_paths_snapshot
    from music_app.services.log_history_postgres import _connect
    try:
        roots = tuple((str(path) for path in configured_library_root_paths_snapshot(config)))
        if not roots:
            return None
        with _connect(str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '')) as connection:
            rows = connection.execute("""select r.library_id,r.root_path from library.library_roots r
                join library.library_root_settings s on s.library_id=r.library_id
                where r.root_path=any(%s) and r.metadata->>'deactivated' is distinct from 'true'""", (list(roots),)).fetchall()
        libraries = {row['library_id'] for row in rows}
        if len(libraries) != 1 or {row['root_path'] for row in rows} != set(roots):
            return None
        return HistoryScope(library_id=libraries.pop(), origin_kind='background')
    except Exception:
        logging.getLogger(__name__).warning('Operational history has no verified media-host library provenance')
        return None
from music_app.services.log_history_postgres import LogHistoryPostgresAdapter
