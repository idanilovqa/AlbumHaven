from __future__ import annotations
import base64
from datetime import datetime, timezone, timedelta
import hashlib
import hmac
import json


def _connect(url):
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(url, row_factory=dict_row)


class LogHistoryPostgresAdapter:

    def __init__(self, config, *, connect=None):
        self.url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '')
        self.connect = connect or _connect

    def _connection(self):
        if not self.url:
            raise RuntimeError('Postgres operational history is unavailable')
        return self.connect(self.url)

    def _head(self, connection, scope, *, lock=False):
        row = connection.execute('select * from ops.log_history_heads where library_id=%s' + (' for update' if lock else ''), (scope.library_id,)).fetchone()
        if row is None:
            connection.execute('insert into ops.log_history_heads(library_id) values(%s) on conflict do nothing', (scope.library_id,))
            row = connection.execute('select * from ops.log_history_heads where library_id=%s' + (' for update' if lock else ''), (scope.library_id,)).fetchone()
        return row

    def append(self, entry, *, scope):
        from psycopg.types.json import Jsonb
        from .log_history import _normalize_log_history_item
        item = _normalize_log_history_item(entry)
        with self._connection() as connection:
            head = self._head(connection, scope, lock=True)
            self._prune(connection, scope, datetime.now(timezone.utc))
            revision = int(head['revision']) + 1
            connection.execute('insert into ops.log_history_events(library_id,event_id,revision,event_timestamp,payload) values(%s,%s,%s,%s,%s)', (scope.library_id, item['id'], revision, item['timestamp'], Jsonb(item)))
            connection.execute('update ops.log_history_heads set revision=%s where library_id=%s', (revision, scope.library_id))
        return item

    def revision(self, *, scope):
        with self._connection() as connection:
            head = self._head(connection, scope)
            return f"{scope.library_id}:{head['revision']}:{head['retention_epoch']}"

    def _token(self, body, head):
        data = json.dumps(body, sort_keys=True, separators=(',', ':')).encode()
        encoded = base64.urlsafe_b64encode(data).decode().rstrip('=')
        signature = hmac.new(str(head['token_secret']).encode(), encoded.encode(), hashlib.sha256).hexdigest()
        return encoded + '.' + signature

    def _decode(self, value, head, scope, query, kind):
        from .log_history import LogHistoryQueryError, history_query_fingerprint
        try:
            (encoded, signature) = value.split('.')
            expected = hmac.new(str(head['token_secret']).encode(), encoded.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, signature):
                raise ValueError()
            body = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
            if body['library'] != scope.library_id or body['query'] != history_query_fingerprint(query) or body['kind'] != kind:
                raise ValueError()
            if body['epoch'] != head['retention_epoch']:
                raise LogHistoryQueryError('History snapshot expired; refresh the query', 410)
            if type(body['revision']) is not int or body['revision'] < 0 or body['revision'] > head['revision']:
                raise ValueError()
            return body
        except LogHistoryQueryError:
            raise
        except (AttributeError, KeyError, ValueError, TypeError):
            raise LogHistoryQueryError('Invalid history cursor or snapshot') from None

    def _read(self, *, scope, query, snapshot=None, cursor=None, limit=500):
        from .log_history import LogHistoryQueryError, normalize_log_history_query, history_query_fingerprint, _normalize_log_history_item
        query = normalize_log_history_query(query)
        # Pruning commits separately; the bounded read keeps one MVCC snapshot.
        self.prune(scope=scope)
        with self._connection() as connection:
            # A concurrent prune must not silently remove rows after token validation.
            connection.execute('set transaction isolation level repeatable read')
            head = self._head(connection, scope)
            upper = self._decode(snapshot, head, scope, query, 'snapshot') if snapshot else {'library': scope.library_id, 'query': history_query_fingerprint(query), 'epoch': head['retention_epoch'], 'revision': head['revision'], 'kind': 'snapshot'}
            snapshot = snapshot or self._token(upper, head)
            after = None
            if cursor:
                after = self._decode(cursor, head, scope, query, 'cursor')
                if after['revision'] != upper['revision']:
                    raise LogHistoryQueryError('Cursor belongs to another snapshot')
            where = []
            params = [scope.library_id, upper['revision']]
            for (key, operator) in [('from_utc', '>='), ('to_utc', '<')]:
                value = getattr(query, key)
                if value:
                    where.append('event_timestamp ' + operator + ' %s')
                    params.append(value)
            for (values, column) in [(query.sources, "payload->>'source'"), (query.event_types, "payload->>'action'"), (query.event_ids, 'event_id')]:
                if values:
                    where.append(column + '=any(%s)')
                    params.append(list(values))
            if query.text:
                where.append("position(lower(%s) in lower(concat_ws(' ',payload->>'action',payload->>'message',payload->>'error',payload->>'artist',payload->>'album',payload->>'title'))) > 0")
                params.append(query.text)
            if after:
                where.append('(event_timestamp,event_id)>(%s,%s)')
                params.extend([after['timestamp'], after['event_id']])
            sql = """with visible as (
                select distinct on(event_id) event_id,event_timestamp,payload from ops.log_history_events
                where library_id=%s and revision<=%s order by event_id,revision desc
            ) select * from visible"""
            if where:
                sql += ' where ' + ' and '.join(where)
            sql += ' order by event_timestamp,event_id limit %s'
            params.append(limit + 1)
            records = connection.execute(sql, params).fetchall()
            next_cursor = None
            if len(records) > limit:
                last = records[limit - 1]
                next_cursor = self._token({**upper, 'kind': 'cursor', 'timestamp': last['event_timestamp'].isoformat(), 'event_id': last['event_id']}, head)
            items = [_normalize_log_history_item(row['payload']) for row in records[:limit]]
            return {'items': items, 'snapshot': snapshot, 'revision': f"{scope.library_id}:{upper['revision']}:{upper['epoch']}", 'next_cursor': next_cursor, 'count': len(items)}

    def page(self, *, scope, query, page_size=500, cursor=None, snapshot=None):
        from .log_history import LogHistoryQueryError
        if type(page_size) is not int or not 1 <= page_size <= 500:
            raise LogHistoryQueryError('History pages contain at most 500 events')
        return self._read(scope=scope, query=query, snapshot=snapshot, cursor=cursor, limit=page_size)

    def export(self, *, scope, query, snapshot=None):
        from .log_history import LogHistoryQueryError
        result = self._read(scope=scope, query=query, snapshot=snapshot, limit=100000)
        if result['next_cursor']:
            raise LogHistoryQueryError('Export exceeds 100000 events; narrow the query', 413)
        return result

    def _prune(self, connection, scope, now):
        cutoff = now - timedelta(days=90)
        if connection.execute('select 1 from ops.log_history_events where library_id=%s and recorded_at<%s limit 1', (scope.library_id, cutoff)).fetchone() is None:
            return
        self._head(connection, scope, lock=True)
        deleted = connection.execute('delete from ops.log_history_events where library_id=%s and recorded_at<%s returning revision', (scope.library_id, cutoff)).fetchall()
        if deleted:
            connection.execute('update ops.log_history_heads set retention_epoch=retention_epoch+1 where library_id=%s', (scope.library_id,))

    def prune(self, *, scope, now=None):
        with self._connection() as connection:
            self._prune(connection, scope, now or datetime.now(timezone.utc))
