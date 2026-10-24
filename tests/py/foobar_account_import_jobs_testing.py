"""Authored-only SQL-result boundary for genuine durable jobs and Prepare/Apply.

Nothing in this file certifies PostgreSQL locking, triggers, or isolation. The
production authority owners, session validator, gates, parser, indexed planner,
repository, writers, finalizer, and automatic checkpoint hooks are not replaced.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid4
import json

from music_app.services import foobar_account_authority as account_authority
from music_app.services import foobar_account_import_jobs as jobs
from music_app.services import foobar_account_import_jobs_readiness as readiness
from music_app.services import foobar_account_import_status as receipt_status
from music_app.services import foobar_account_retry_reconciliation as retry
from music_app.services import foobar_account_indexed_upload as indexed
from tests.py.foobar_account_associations_v3_testing import (
    V3Boundary, p, a, f, authority, associations, make_command, requested_context,
    prepared, PAYLOAD, CAPACITY, SOURCE, GEN,
)

URL = 'synthetic:no-network'
OTHER_SOURCE = '44444444-4444-4444-8444-444444444444'
JOB = '55555555-5555-4555-8555-555555555555'
COUNTERS = ('unchanged_count', 'source_only_count', 'taste_only_count', 'both_count',
            'ratings_count', 'favorites_count', 'association_count')
STATE = ('receipt', 'receipts', 'keys', 'key_scopes', 'key_times', 'revision', 'source_rows',
         'source_versions', 'history', 'bindings', 'tastes', 'job_rows', 'attempts', 'history_projections')
JOB_FIELDS = ('job_ref', 'upload_sha256', 'parser_version', 'mapping_name',
              'original_matching_library_id', 'original_generation', 'total_rows',
              'version', 'confirmed_through', 'next_batch_no', 'cancel_requested',
              'created_at', 'updated_at') + COUNTERS
ATTEMPT_FIELDS = ('batch_no', 'attempt_no', 'generation', 'original_session_id',
    'window_start', 'window_end', 'expected_revision', 'inventory_sha256',
    'prepare_key', 'prepare_command_sha256', 'apply_key', 'apply_command_sha256',
    'receipt_ref', 'prepared_sha256', 'decision_sha256', 'authority_sha256',
    'state', 'terminal_bytes', 'terminal_sha256', 'committed_revision',
    'created_at', 'updated_at')


def snapshot(db):
    return deepcopy(tuple(getattr(db, name) for name in STATE))


def project(row, names):
    return {name: deepcopy(row[name]) for name in names}


class JobBoundary(V3Boundary):
    def __init__(self, library=7):
        super().__init__(library)
        self.receipts, self.key_scopes, self.job_rows, self.attempts = {}, {}, {}, {}
        self.key_times = {}
        self.sources = {(1, SOURCE), (1, OTHER_SOURCE), (2, OTHER_SOURCE)}
        self.accounts = {1: True, 2: True}
        self.sessions = {(1, 3): True, (1, 4): True, (2, 5): True}
        self.schema = [{'structural_ready': True}]
        self.closed = False
        self.info = SimpleNamespace(transaction_status=2)
        self.tx_account = None
        self.locked_sources = set()
        self.job_frames = []
        self.commit_views, self.rollbacks = [], []
        self.explicit_rollbacks = 0
        self.transaction_before = None
        self.before_commit = None

    def rollback(self):
        """Driver boundary for the genuine rollback-only preflight owner."""
        assert self.transaction_before is not None
        self.explicit_rollbacks += 1
        for name, value in zip(STATE, deepcopy(self.transaction_before)):
            setattr(self, name, value)
        self.info.transaction_status = 0

    @contextmanager
    def pool(self, url):
        assert url == URL
        before = snapshot(self)
        self.transaction_before = before
        self.tx_account = None
        self.locked_sources = set()
        self.info.transaction_status = 2
        try:
            yield self
            if self.before_commit is not None:
                self.before_commit(self)
        except BaseException as error:
            for name, value in zip(STATE, before):
                setattr(self, name, value)
            self.rollbacks.append(type(error))
            raise
        else:
            self.commits += 1
            self.commit_views.append(snapshot(self))
            if self.lose_ack:
                self.lose_ack = False
                raise OSError('synthetic committed acknowledgement lost')
        finally:
            self.tx_account = None
            self.locked_sources = set()

    def execute(self, sql, params=None, **kwargs):
        if sql == self.fail_sql:
            self.calls.append(sql)
            raise OSError('synthetic driver operation failure')
        if sql in (
            'set transaction isolation level read committed',
            "set local lock_timeout = '250ms'",
            "set local statement_timeout = '1000ms'",
            "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))",
        ):
            self.calls.append(sql)
            return self.cursor([])
        if sql == 'select id,is_active,disabled_at from app.accounts where id=%s for update':
            self.calls.append(sql)
            account, = params
            assert not kwargs
            self.tx_account = account
            return self.cursor([] if account not in self.accounts else [dict(
                id=account, is_active=self.accounts[account], disabled_at=None)])
        if 'from app.account_sessions' in sql:
            self.calls.append(sql)
            session, account = params
            assert account == self.tx_account and not kwargs
            live = self.sessions.get((account, session))
            return self.cursor([] if live is None else [dict(id=session, account_id=account,
                authenticated_at=self.now, idle_expires_at=self.now + timedelta(days=1),
                absolute_expires_at=self.now + timedelta(days=1),
                revoked_at=None if live else self.now)])
        if sql == readiness._SCHEMA_SQL:
            self.calls.append(sql)
            assert self.tx_account is not None and params is None and not kwargs
            return self.cursor(deepcopy(self.schema))
        return super().execute(sql, params, **kwargs)

    def stream(self):
        rows = tuple(self.receipts.values())
        return dict(revision=self.revision, current_generation=self.current_generation,
            retired_through=self.retired_through, prepared_today=len(rows),
            receipt_count=len(rows), ready_count=sum(r['state'] == 'ready' for r in rows),
            receipt_reserved_bytes=4194304 * sum(r['state'] == 'ready' for r in rows),
            request_key_count=len(self.keys), observed_at=self.now, isolation='read committed')

    def _job_sql(self, sql, frame):
        assert frame['account_id'] == self.tx_account
        owner = (frame['account_id'], frame['source_ref'])
        assert owner in self.locked_sources
        scope = owner + (frame['job_ref'],)
        self.job_frames.append((sql, deepcopy(frame)))
        if sql == jobs._JOB_SQL:
            row = self.job_rows.get(scope)
            return [] if row is None else [project(row, JOB_FIELDS)]
        if sql == jobs._INSERT_JOB_SQL:
            assert scope not in self.job_rows
            row = {name: frame[name] for name in JOB_FIELDS[:7]}
            row.update(version=0, confirmed_through=0, next_batch_no=1,
                cancel_requested=False, created_at=self.now, updated_at=self.now)
            row.update({name: 0 for name in COUNTERS})
            self.job_rows[scope] = row
            return [{'job_ref': frame['job_ref']}]
        if sql in (jobs._FIND_PREPARE_SQL, jobs._FIND_APPLY_SQL):
            return [dict(job_ref=k[2], batch_no=row['batch_no'], attempt_no=row['attempt_no'])
                for k, row in self.attempts.items() if k[:2] == owner
                and row['generation'] == frame['generation']
                and (frame['request_key'] in (row['prepare_key'], row['apply_key'])
                     or sql == jobs._FIND_APPLY_SQL and row['receipt_ref'] == frame['receipt_ref'])]
        if sql == jobs._COLLISION_SQL:
            names = {frame['prepare_key'], frame['apply_key']}
            occupied = any(key in names and self.key_scopes[key] == owner + (frame['generation'],)
                for key in self.keys)
            occupied = occupied or any(k[:2] == owner and a['generation'] == frame['generation']
                and names.intersection((a['prepare_key'], a['apply_key'])) for k, a in self.attempts.items())
            return [{'collision': 1}] if occupied else []
        if sql == jobs._ATTEMPT_SQL:
            rows = [row for k, row in self.attempts.items() if k[:3] == scope
                and row['batch_no'] == frame['batch_no']
                and (frame['attempt_no'] is None or row['attempt_no'] == frame['attempt_no'])]
            return [] if not rows else [project(max(rows, key=lambda r: r['attempt_no']), ATTEMPT_FIELDS)]
        if sql == jobs._INSERT_ATTEMPT_SQL:
            key = scope + (frame['batch_no'], frame['attempt_no'])
            assert key not in self.attempts
            row = {name: None for name in ATTEMPT_FIELDS}
            for name in ('batch_no', 'attempt_no', 'generation', 'window_start',
                         'expected_revision', 'inventory_sha256', 'prepare_key',
                         'prepare_command_sha256', 'apply_key'):
                row[name] = frame[name]
            row.update(original_session_id=frame['session_id'], state='claimed',
                       created_at=self.now, updated_at=self.now)
            self.attempts[key] = row
            return [project(row, ('batch_no', 'attempt_no'))]
        if sql == jobs._JOB_CAS_SQL:
            row = self.job_rows[scope]
            if row['version'] != frame['expected_version']:
                return []
            row.update(version=row['version'] + 1, updated_at=self.now,
                **{name: frame[name] for name in ('confirmed_through', 'next_batch_no', 'cancel_requested')})
            row.update({name: frame[name] for name in COUNTERS})
            return [{'version': row['version']}]
        if sql in (jobs._READY_SQL, jobs._CONFIRM_SQL, jobs._DISCARD_SQL):
            row = self.attempts[scope + (frame['batch_no'], frame['attempt_no'])]
            if sql == jobs._READY_SQL:
                if row['state'] != 'claimed': return []
                row.update(state='ready', **{name: frame[name] for name in (
                    'window_end', 'receipt_ref', 'prepared_sha256', 'decision_sha256',
                    'authority_sha256', 'apply_command_sha256')})
            elif sql == jobs._CONFIRM_SQL:
                if row['state'] != 'ready': return []
                body = bytes.fromhex(frame['terminal_hex'])
                row.update(state='confirmed', terminal_bytes=body,
                    terminal_sha256=sha256(body).hexdigest(),
                    committed_revision=frame['committed_revision'])
            else:
                if row['state'] not in ('claimed', 'ready'): return []
                row['state'] = 'discarded'
            row['updated_at'] = self.now
            return [project(row, ('batch_no', 'attempt_no'))]
        if sql == jobs._RECEIPT_SQL:
            rows = [r for r in self.receipts.values() if tuple(r['header'][i] for i in (0, 3, 4))
                == owner + (frame['generation'],) and r['prepare_key'] == frame['prepare_key']]
            names = ('receipt_ref', 'prepare_key', 'apply_key', 'original_session_id',
                'state', 'expected_revision', 'committed_revision', 'upload_sha256',
                'parser_version', 'mapping_name', 'total_rows', 'window_start', 'window_end',
                'inventory_sha256', 'authority_sha256', 'prepared_sha256', 'decision_sha256',
                'created_at', 'ready_until', 'expires_at', 'terminal_bytes', 'terminal_sha256')
            return [project(dict(r, terminal_bytes=r['terminal']), names) for r in rows]
        if sql == jobs._KEYS_SQL:
            names = (frame['prepare_key'], frame['apply_key'])
            return sorted((dict(self.keys[key], request_key=key) for key in names
                if key in self.keys and self.key_scopes[key] == owner + (frame['generation'],)),
                key=lambda row: row['operation'])
        if sql == jobs._TOMBSTONE_SQL:
            key = self.keys.get(frame['prepare_key'])
            if (key is None or key['operation'] != 'prepare' or key['state'] != 'active'
                    or key['receipt_ref'] != frame['receipt_ref']): return []
            assert self.key_scopes[frame['prepare_key']] == owner + (frame['generation'],)
            key.update(state='tombstone', receipt_ref=None)
            self.key_times[frame['prepare_key']]['retired_at'] = self.now
            self.key_times[frame['prepare_key']]['retired_reason'] = 'discarded'
            return [{'request_key': frame['prepare_key']}]
        if sql == jobs._DELETE_READY_SQL:
            receipt = self.receipts.get(frame['receipt_ref'])
            if (receipt is None or receipt['state'] != 'ready'
                    or receipt['prepare_key'] != frame['prepare_key']): return []
            assert tuple(receipt['header'][i] for i in (0, 3, 4)) == owner + (frame['generation'],)
            del self.receipts[frame['receipt_ref']]
            if self.receipt is receipt: self.receipt = None
            return [{'receipt_ref': frame['receipt_ref']}]
        raise AssertionError('Unmodeled durable job SQL')

    def dispatch(self, sql, params):
        frame = json.loads(params[0])
        if isinstance(frame, dict):
            return self._job_sql(sql, frame)
        if sql in (receipt_status._SCALAR_SQL, receipt_status._KEY_SQL, retry._KEY_SQL):
            account, library, source, generation, identity = frame
            assert account == self.tx_account and library is None
            assert (account, source) in self.locked_sources
            scope = (account, source, generation)
            if sql == receipt_status._SCALAR_SQL:
                r = self.receipts.get(identity)
                if r is None or tuple(r['header'][i] for i in (0, 3, 4)) != scope:
                    return []
                self.receipt = r
                values = dict(r, prepared_null=r['prepared'] is None,
                    terminal_null=r['terminal'] is None, prepared_size=len(r['prepared'] or b''),
                    terminal_size=len(r['terminal'] or b''), observed_at=self.now)
                return [project(values, receipt_status._SCALAR_FIELDS)]
            selected = ((identity,) if sql == retry._KEY_SQL else tuple(sorted(self.keys,
                key=lambda key: (self.keys[key]['operation'], key))))
            rows = []
            for key in selected:
                if key not in self.keys or self.key_scopes[key] != scope:
                    continue
                stored = self.keys[key]
                if sql == receipt_status._KEY_SQL and stored['original_receipt_ref'] != identity:
                    continue
                values = dict(stored, **self.key_times[key], request_key=key, observed_at=self.now)
                fields = receipt_status._KEY_FIELDS if sql == receipt_status._KEY_SQL else retry._KEY_FIELDS
                rows.append(project(values, fields))
            return rows
        if sql in (p.gate._LOCK_SQL, p.gate._ROLL_SQL):
            assert frame[0] == self.tx_account
            owner = (frame[0], frame[3])
            if owner not in self.sources: return []
            self.locked_sources.add(owner)
            return [self.stream()]
        if sql == p.gate._KEY_SQL:
            key = self.keys.get(frame[5])
            self.receipt = None if key is None else self.receipts.get(key['receipt_ref'])
            if key is not None and self.receipt is None:
                row = {name: None for name in p.gate._KEY_FIELDS}
                row.update(operation=key['operation'], command_sha256=key['command_sha256'],
                    original_receipt_ref=key['original_receipt_ref'], key_state=key['state'],
                    receipt_ref=key['receipt_ref'], observed_at=self.now)
                return [row]
        elif sql == p._RECEIPT_SCALAR_SQL:
            self.receipt = self.receipts.get(frame[4])
        elif sql == p._INSERT_READY_SQL:
            self.receipt = None
        rows = super().dispatch(sql, params)
        if sql in (p._INSERT_READY_SQL, f._COMMIT_SQL):
            r = self.receipt
            self.receipts[r['receipt_ref']] = r
            scope = tuple(r['header'][i] for i in (0, 3, 4))
            self.key_scopes[r['prepare_key']] = scope
            self.key_times.setdefault(r['prepare_key'], dict(created_at=r['created_at'],
                retired_at=None, retired_reason=None))
            if r['apply_key'] is not None:
                self.key_scopes[r['apply_key']] = scope
                self.key_times.setdefault(r['apply_key'], dict(created_at=r['committed_at'],
                    retired_at=None, retired_reason=None))
        return rows


def install(monkeypatch, *, library=7):
    db = JobBoundary(library)

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return db.now

    for owner in (authority, account_authority):
        monkeypatch.setattr(owner, 'datetime', FrozenDateTime)
        monkeypatch.setattr(owner, 'pooled_connection', db.pool)
    # Restore the actual owner if another suite installed its old outer fixture.
    monkeypatch.setattr(p, 'current_foobar_import_transaction', authority.current_foobar_import_transaction)
    return db


def start(db, *, payload=PAYLOAD, library=None, job_ref=JOB):
    ctx = requested_context(library)
    seed = make_command(db, payload=payload, library=library)
    upload = indexed.open_account_indexed_upload(ctx, payload=payload,
        command=seed, intake_capacity=CAPACITY)
    cmd = jobs.FoobarJobCommand(seed.source_ref, job_ref, seed.upload_sha256,
        p.parser._VERSION, seed.mapping_name, library, seed.generation,
        upload._upload.terminal.summary.data_rows)
    status = jobs.start_foobar_import_job(URL, ctx, command=cmd)
    assert status.command == cmd and status.confirmed_through == 0
    batch = jobs.claim_next_foobar_job_batch(URL, ctx, source_ref=cmd.source_ref,
        job_ref=job_ref, inventory_sha256=seed.inventory_sha256,
        expected_revision=seed.expected_revision, expected_generation=seed.generation)
    return ctx, cmd, batch, upload


def status(ctx, cmd):
    return jobs.read_foobar_import_job(URL, ctx, source_ref=cmd.source_ref, job_ref=cmd.job_ref)


def claim(ctx, cmd, inventory, *, expected_revision=None, expected_generation=None):
    current = status(ctx, cmd)
    return jobs.claim_next_foobar_job_batch(URL, ctx, source_ref=cmd.source_ref,
        job_ref=cmd.job_ref, inventory_sha256=inventory,
        expected_revision=current.source_revision if expected_revision is None else expected_revision,
        expected_generation=current.current_generation if expected_generation is None else expected_generation)


def prepare(ctx, batch, upload):
    return p.prepare_indexed_foobar_import(URL, ctx, upload=upload,
        command=batch.prepare_command, intake_capacity=CAPACITY)


def apply(ctx, batch):
    assert batch.apply_command is not None
    return a.apply_foobar_import(URL, ctx, command=batch.apply_command, intake_capacity=CAPACITY)


def reconcile(ctx, cmd, batch):
    return jobs.reconcile_foobar_job_batch(URL, ctx, source_ref=cmd.source_ref,
        job_ref=cmd.job_ref, batch_no=batch.batch_no, attempt_no=batch.attempt_no)


def resume(ctx, cmd):
    return jobs.resume_foobar_import_job(URL, ctx, source_ref=cmd.source_ref, job_ref=cmd.job_ref)


def cancel(ctx, cmd):
    return jobs.cancel_foobar_import_job(URL, ctx, source_ref=cmd.source_ref, job_ref=cmd.job_ref)


def row(db, cmd, batch):
    return db.attempts[(1, cmd.source_ref, cmd.job_ref, batch.batch_no, batch.attempt_no)]


def payload_rows(count, *, wide=False):
    return b'path\ttitle\trating\tfavorite\tplay_count\n' + b''.join(
        ('/unknown-%d.flac\t' % i).encode() + (b'x' * 8192 if wide else b'Track')
        + b'\t4\t1\t19\n' for i in range(count))
