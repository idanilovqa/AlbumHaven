"""User-scoped durable offline Top source processing and review evidence.

This owns only source work, not Top membership, source locks or a generic queue.
The deterministic worker runs outside database locks. A crashed attempt is
recoverable through process(); reads never start work or renew its claim.
"""
import json
from datetime import timedelta
from uuid import uuid4

from music_app.services.album_top_source_parse import parse_source, source_command
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, CREATE, top_uuid

_CLAIM_TIME = timedelta(minutes=1)


class TopSourceImports:
    def __init__(self, tops):
        self.tops = tops

    @staticmethod
    def _row(connection, live, ref, *, write=False):
        row = connection.execute('''select * from app.album_top_source_jobs
            where ref=%s and actor_account_id=%s and library_id=%s for ''' +
            ('update' if write else 'share'),
            (ref, live.actor.account_id, live.library_id)).fetchone()
        if row is None:
            raise AlbumTopError('source_job_unavailable', 404)
        return row

    @staticmethod
    def _project(row, *, evidence=True):
        result = {'job_ref': str(row['ref']), 'request_key': str(row['request_key']),
                  'status': row['status'], 'revision': str(row['revision']),
                  'title': row['source']['title'] if evidence else row['title'],
                  'kind': row['source']['kind'] if evidence else row['kind'],
                  'created_at': row['created_at'].isoformat(),
                  'updated_at': row['updated_at'].isoformat(),
                  'phase': 'review_evidence' if row['status'] == 'completed' else 'source_processing',
                  'error': row['error_code'], 'top_ref': None}
        if evidence:
            result.update(source=row['source'], review=row['review_result'])
        return result

    def submit(self, context, payload, *, constraints=None):
        command, digest = source_command(payload)
        with self.tops._authorized(context, constraints) as (connection, live, _):
            self.tops._require(live, (BROWSE, CREATE), constraints)
            row = connection.execute('''select * from app.album_top_source_jobs
                where actor_account_id=%s and library_id=%s and request_key=%s for update''',
                (live.actor.account_id, live.library_id, command['request_key'])).fetchone()
            if row is not None:
                if row['command_digest'] != digest:
                    raise AlbumTopError('request_key_conflict', 409)
            else:
                now = self.tops._clock()
                row = connection.execute('''insert into app.album_top_source_jobs
                    (ref,actor_account_id,library_id,request_key,command_digest,source,
                     status,revision,created_at,updated_at)
                    values(%s,%s,%s,%s,%s,%s::jsonb,'queued',1,%s,%s) returning *''',
                    (str(uuid4()), live.actor.account_id, live.library_id, command['request_key'],
                     digest, json.dumps(command, ensure_ascii=False), now, now)).fetchone()
            ref = str(row['ref'])
        # Admission commits first. A lost response or interrupted worker can be
        # recovered by exact submit replay or the explicit process endpoint.
        return self.process(context, ref, constraints=constraints)

    def read(self, context, ref, *, constraints=None):
        ref = top_uuid(ref)
        with self.tops._authorized(context, constraints) as (connection, live, _):
            self.tops._require(live, (BROWSE, CREATE), constraints)
            return self._project(self._row(connection, live, ref))

    def list(self, context, *, cursor=None, constraints=None):
        cursor = top_uuid(cursor) if cursor is not None else None
        with self.tops._authorized(context, constraints) as (connection, live, _):
            self.tops._require(live, (BROWSE, CREATE), constraints)
            params = [live.actor.account_id, live.library_id]
            clause = ''
            if cursor is not None:
                previous = connection.execute('''select created_at,ref from app.album_top_source_jobs
                    where ref=%s and actor_account_id=%s and library_id=%s for share''',
                    (cursor, live.actor.account_id, live.library_id)).fetchone()
                if previous is None:
                    raise AlbumTopError('source_job_unavailable', 404)
                clause = ' and (created_at,ref)<(%s,%s)'
                params.extend((previous['created_at'], previous['ref']))
            rows = connection.execute('''select ref,request_key,status,revision,
                source->>'title' as title,source->>'kind' as kind,
                created_at,updated_at,error_code from app.album_top_source_jobs
                where actor_account_id=%s and library_id=%s''' + clause +
                ' order by created_at desc,ref desc limit 51', params).fetchall()
            return {'jobs': [self._project(row, evidence=False) for row in rows[:50]],
                    'next_cursor': str(rows[49]['ref']) if len(rows) > 50 else None}

    def cancel(self, context, ref, *, constraints=None):
        ref = top_uuid(ref)
        with self.tops._authorized(context, constraints) as (connection, live, _):
            self.tops._require(live, (BROWSE, CREATE), constraints)
            row = self._row(connection, live, ref, write=True)
            # Cancellation is monotonic and retains original evidence, including
            # an already produced review. No worker can resurrect this job.
            if row['status'] != 'canceled':
                row = connection.execute('''update app.album_top_source_jobs set
                    status='canceled',revision=revision+1,attempt_ref=null,lease_until=null,
                    error_code=null,updated_at=%s where ref=%s returning *''',
                    (self.tops._clock(), ref)).fetchone()
            return self._project(row)

    def process(self, context, ref, *, constraints=None):
        ref = top_uuid(ref)
        with self.tops._authorized(context, constraints) as (connection, live, _):
            self.tops._require(live, (BROWSE, CREATE), constraints)
            row = self._row(connection, live, ref, write=True)
            now = self.tops._clock()  # sampled after the claim lock, not on entry
            if row['status'] in ('completed', 'canceled') or (
                    row['status'] == 'running' and row['lease_until'] > now):
                return self._project(row)
            attempt = str(uuid4())
            row = connection.execute('''update app.album_top_source_jobs set
                status='running',revision=revision+1,attempt_ref=%s,lease_until=%s,
                error_code=null,updated_at=%s where ref=%s returning *''',
                (attempt, now + _CLAIM_TIME, now, ref)).fetchone()
            command = row['source']
        # Pure, bounded processing has no authority and does not hold SQL locks.
        # Failures are explicit and retryable, never successful review evidence.
        # Process termination still leaves a lease recoverable by a later request.
        failure = None
        try:
            review = parse_source(command)
        except Exception:
            review = None
            failure = 'source_processing_failed'
        with self.tops._authorized(context, constraints) as (connection, live, _):
            self.tops._require(live, (BROWSE, CREATE), constraints)
            row = self._row(connection, live, ref, write=True)
            now = self.tops._clock()
            if (row['status'] != 'running' or str(row['attempt_ref']) != attempt
                    or row['lease_until'] <= now):
                return self._project(row)
            row = connection.execute('''update app.album_top_source_jobs set
                status=%s,revision=revision+1,review_result=%s::jsonb,error_code=%s,
                attempt_ref=null,lease_until=null,updated_at=%s where ref=%s returning *''',
                ('failed' if failure else 'completed',
                 json.dumps(review, ensure_ascii=False) if review is not None else None,
                 failure, now, ref)).fetchone()
            return self._project(row)
