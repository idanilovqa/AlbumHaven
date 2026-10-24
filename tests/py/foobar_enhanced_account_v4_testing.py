"""Authored only. Genuine v4 owners over controlled SQL/reader boundaries.

No protocol, source merge, policy, session, job checkpoint, finalizer, or codec
is substituted. Driver rows model storage, not PostgreSQL correctness. No SQL
or application code was executed while authoring this packet.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
from hashlib import sha256
import json
import pytest
from uuid import uuid4

from music_app.services import foobar_account_enhanced_prepare as enhanced_prepare
from music_app.services import foobar_account_enhanced_history as history_reader
from music_app.services import foobar_account_enhanced_source_plan as planner
from music_app.services import foobar_enhanced_entry_postgres as entries
from music_app.services import foobar_enhanced_entry_readiness as entry_readiness
from music_app.services import foobar_account_import_preflight as preflight
from tests.py.foobar_account_import_jobs_testing import (
    JobBoundary, snapshot, account_authority, authority, jobs, p, a, f,
    make_command, requested_context, CAPACITY, SOURCE, GEN, JOB, URL,
    status, claim, apply, reconcile, resume, cancel, row,
)
from tests.py.test_foobar_enhanced_raw_windows import Boundary as RawBoundary


BOUNDARIES = []


@pytest.fixture(autouse=True)
def checked_v4_driver():
    BOUNDARIES.clear()
    yield
    assert all(not db.driver_errors for db in BOUNDARIES), [db.driver_errors for db in BOUNDARIES]


def digest(value):
    return sha256(value).hexdigest()


def payload(row, index):
    return bytes.fromhex(row[index])


def same_incoming(old, new):
    # Independent storage comparison, not the planner's business decision.
    return json.loads(payload(old, 8))[:8] == json.loads(payload(new, 8))[:8]


class EnhancedBoundary(JobBoundary):
    def __init__(self, library=None):
        super().__init__(library)
        self.driver_errors = []
        self.entry_headers = {}
        self.immutable_rows = {}
        self.entry_children = {}
        self.raw_revision_bytes = 0
        self.revision_rows = 0
        self.entry_events = []
        self.extra_before = None
        self.override_source_bytes = None
        self.readback_rows = None

    def extra_snapshot(self):
        return deepcopy((self.entry_headers, self.entry_children,
                         self.raw_revision_bytes, self.revision_rows, self.immutable_rows))

    def restore_extra(self, state):
        (self.entry_headers, self.entry_children,
         self.raw_revision_bytes, self.revision_rows, self.immutable_rows) = deepcopy(state)

    @contextmanager
    def pool(self, url):
        before = self.extra_snapshot()
        commits = self.commits
        self.extra_before = before
        try:
            with super().pool(url) as connection:
                yield connection
        except BaseException:
            # A lost ACK after commit must retain durable state, unlike rollback.
            if self.commits == commits:
                self.restore_extra(before)
            raise

    def rollback(self):
        super().rollback()
        self.restore_extra(self.extra_before)

    def execute(self, sql, params=None, **kwargs):
        if sql == entry_readiness._SQL:
            self.calls.append(sql)
            assert params is None and not kwargs
            return self.cursor([dict(entries_ready=True, entries_writer_ready=True)])
        try:
            return super().execute(sql, params, **kwargs)
        except AssertionError as error:
            self.driver_errors.append(str(error))
            raise

    def dispatch(self, sql, params):
        v = json.loads(params[0])
        w = p.source
        if sql == history_reader._LOCK:
            assert v[:2] == [self.tx_account, SOURCE]
            self.locked_sources.add((self.tx_account, SOURCE))
            return [dict(revision=self.revision)]
        if sql == history_reader._sql("entries", False):
            assert v == [self.tx_account, SOURCE, None, None, None]
            assert (self.tx_account, SOURCE) in self.locked_sources
            assert self.readback_rows is not None
            result, self.readback_rows = self.readback_rows, None
            return deepcopy(result)
        if sql in (p.original_sources._SCALAR_SQL, p.original_sources._RAW_SQL):
            r = self.immutable_rows.get((v[3], v[4]))
            if r is None or digest(payload(r, 6)) != v[5] or digest(payload(r, 7)) != v[6]:
                return []
            if sql == p.original_sources._RAW_SQL:
                return [dict(identity_bytes=payload(r, 2), evidence_bytes=payload(r, 6),
                    display_bytes=payload(r, 7), incoming_evidence_bytes=payload(r, 8))]
            return [dict(identity_bytes_size=len(payload(r, 2)), evidence_bytes_size=len(payload(r, 6)),
                display_bytes_size=len(payload(r, 7)), identity_sha256=digest(payload(r, 2)),
                identity_kind=r[1], incoming_evidence_bytes_size=len(payload(r, 8)),
                incoming_evidence_sha256=digest(payload(r, 8)))]
        if sql == planner._PRIOR_SQL:
            r = self.source_rows[v[3]]
            return [dict(identity_bytes=payload(r, 2), evidence_bytes=payload(r, 6),
                         display_bytes=payload(r, 7), incoming_evidence_bytes=payload(r, 8))]
        if sql == p._CAPACITY_SQL:
            size = (sum(len(payload(r, 2)) for r in self.source_rows.values())
                    + self.raw_revision_bytes
                    + sum(len(r['projection_bytes']) for r in self.entry_headers.values())
                    + sum(len(r['projection_bytes']) for r in self.entry_children.values()))
            return [dict(observation_count=len(self.source_rows), revision_count=self.revision_rows,
                         source_bytes=size if self.override_source_bytes is None else self.override_source_bytes)]
        if sql == w._current_sql():
            result = super().dispatch(sql, params)
            for actual, incoming in zip(result, v[4]):
                old = self.by_identity(incoming[2])
                if old is not None:
                    actual['same_bytes'] = (all(old[i] == incoming[i] for i in (6, 7))
                                            and same_incoming(old, incoming))
            return result
        if sql == w._insert_revisions_sql():
            result = []
            for incoming in v[4]:
                old = self.source_rows.get(incoming[0])
                if old is None or any(old[i] != incoming[i] for i in (6, 7)) or not same_incoming(old, incoming):
                    self.source_rows[incoming[0]] = deepcopy(incoming)
                    self.source_versions[incoming[0]] = v[3] + 1
                    self.immutable_rows[(incoming[0], v[3]+1)] = deepcopy(incoming)
                    self.revision_rows += 1
                    self.raw_revision_bytes += sum(len(payload(incoming, i)) for i in (6, 7, 8))
                    result.append(dict(observation_ref=incoming[0]))
            return result
        if sql in (entries._OLD, entries._INSERT, entries._HEADER,
                   entries._DELETE, entries._VERIFY_HEADER, entries._READ):
            return self.entry_sql(sql, v)
        return super().dispatch(sql, params)

    def entry_sql(self, sql, v):
        account, source, observation, revision = v[:4]
        assert account == self.tx_account and (account, source) in self.locked_sources
        scope = account, source, observation
        header = self.entry_headers.get(scope)
        self.entry_events.append((sql, deepcopy(v)))
        if sql == entries._OLD:
            if header is None:
                return []
            children = [r for k, r in self.entry_children.items() if k[:4] == scope+(header['source_revision'],)]
            ordinals = [r['source_ordinal'] for r in children]
            return [dict(source_revision=header['source_revision'], evidence_kind='enhanced_store',
                header_bytes=len(header['projection_bytes']), local_entry_count=header['local_entry_count'],
                n=len(children), lo=min(ordinals) if ordinals else None,
                hi=max(ordinals) if ordinals else None,
                child_bytes=sum(len(r['projection_bytes']) for r in children))]
        if sql in (entries._INSERT, entries._HEADER):
            current = self.source_rows[observation]
            assert self.source_versions[observation] == revision
            assert v[4:6] == [digest(payload(current, 6)), digest(payload(current, 7))]
        if sql == entries._INSERT:
            result = []
            for ordinal, raw, resolved, sort_key, body in v[6]:
                key = scope+(revision, ordinal)
                assert key not in self.entry_children
                body = bytes.fromhex(body)
                self.entry_children[key] = dict(source_ordinal=ordinal, raw_filetime_le=bytes.fromhex(raw),
                    resolved=resolved, sort_key=sort_key, projection_bytes=body, projection_sha256=digest(body))
                result.append(dict(source_ordinal=ordinal))
            return result
        if sql == entries._HEADER:
            assert (header is None and v[9] is None) or (header is not None and header['source_revision'] == v[9])
            body = bytes.fromhex(v[6])
            self.entry_headers[scope] = dict(source_revision=revision, evidence_kind='enhanced_store',
                projection_bytes=body, projection_sha256=digest(body), local_entry_count=v[7],
                local_vector_sha256=v[8], effective_sha256=v[4], display_sha256=v[5],
                standard_first=None, standard_last=entries.codec.UNKNOWN_TIME,
                enhanced_first=None, enhanced_last=entries.codec.UNKNOWN_TIME,
                standard_last_present=False, enhanced_last_present=False)
            return [dict(observation_ref=observation)]
        if sql == entries._DELETE:
            keys = [k for k in self.entry_children if k[:4] == scope+(v[4],)]
            for key in keys:
                del self.entry_children[key]
            return [dict(n=len(keys))]
        if sql == entries._VERIFY_HEADER:
            if header is None:
                return []
            current = self.source_rows[observation]
            return [dict(header, current_revision=self.source_versions[observation],
                actual_effective_sha256=digest(payload(current, 6)),
                actual_display_sha256=digest(payload(current, 7)))]
        assert sql == entries._READ
        return [deepcopy(r) for k, r in sorted(self.entry_children.items())
                if k[:4] == scope+(revision,) and k[4] >= v[4]][:129]


def install(monkeypatch, library=None):
    db = EnhancedBoundary(library)
    BOUNDARIES.append(db)
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return db.now
    for owner in (authority, account_authority):
        monkeypatch.setattr(owner, 'datetime', Clock)
        monkeypatch.setattr(owner, 'pooled_connection', db.pool)
    monkeypatch.setattr(p, 'current_foobar_import_transaction', authority.current_foobar_import_transaction)
    return db


def seed(db, upload):
    return replace(make_command(db, library=db.library), request_key=str(uuid4()),
        upload_sha256=upload.upload_sha256, mapping_name=p.gate.ENHANCED_MAPPING,
        expected_revision=db.revision)


def start(db, upload, *, job_ref=None):
    ctx = requested_context(db.library)
    initial = seed(db, upload)
    cmd = jobs.FoobarJobCommand(SOURCE, job_ref or str(uuid4()), upload.upload_sha256,
        p.gate.ENHANCED_PARSER, p.gate.ENHANCED_MAPPING, db.library, GEN, upload.records)
    current = jobs.start_foobar_import_job(URL, ctx, command=cmd)
    assert current.confirmed_through == 0
    batch = claim(ctx, cmd, initial.inventory_sha256)
    return ctx, cmd, batch


def prepare(ctx, batch, upload):
    return enhanced_prepare.prepare_indexed_enhanced_import(URL, ctx, upload=upload,
        command=batch.prepare_command, intake_capacity=CAPACITY)


def complete(db, upload):
    ctx, cmd, batch = start(db, upload)
    while True:
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        apply(ctx, ready)
        result = reconcile(ctx, cmd, ready)
        if result.status.disposition == 'completed':
            return ctx, cmd, result.status
        batch = claim(ctx, cmd, batch.prepare_command.inventory_sha256)
