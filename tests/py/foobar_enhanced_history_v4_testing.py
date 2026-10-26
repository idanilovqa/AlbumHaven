"""AUTHORED ONLY: actual Enhanced reader/policy/session over controlled SQL rows.

No Python/import/collection/test/SQL execution occurred during authoring. This
boundary does not attest PostgreSQL plans, locks, isolation, index completeness,
trigger semantics, persistence, migration readiness or real user data. Fixtures
prescribe result rows; they do not replace or simulate the production reader.
"""
from collections import deque
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
from hashlib import sha256
import json
import pytest

from music_app.services import foobar_account_authority as account_authority
from music_app.services import foobar_account_enhanced_history as reader
from music_app.services import foobar_account_history_readiness as readiness
from music_app.services import foobar_enhanced_entry_readiness as entry_readiness
from music_app.services import foobar_enhanced_entry_projection as codec
from music_app.services import foobar_enhanced_source_evidence as evidence
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.foobar_account_history_native_testing import (
    NativeBoundary, NOW, URL, SOURCE, OTHER_SOURCE, OBS,
    context as native_context,
)

EPOCH = 116444736000000000
BASE = EPOCH + 17000000000000000
UNRESOLVED = 18446744073709551615
BOUNDARIES = []


@pytest.fixture(autouse=True)
def checked_enhanced_driver():
    BOUNDARIES.clear()
    yield
    assert all(not db.driver_errors for db in BOUNDARIES), [db.driver_errors for db in BOUNDARIES]
    assert all(not db.pages for db in BOUNDARIES), 'An expected bounded page was not consumed'


def context(account=1, session=3):
    # Deliberately carry ambient library grants. The genuine account owner must
    # strip them before policy evaluation, never rely on fixture-level narrowing.
    return native_context(account=account, session=session)


def read_only(target):
    assert target.action == 'account.self.foobar.read'
    assert target.target_account_id == target.actor.account_id
    assert target.library_id is None and target.resource is None
    assert target.actor.current_library_id is None
    assert target.actor.library_relationships == ()
    assert target.actor.capability_grants == ()
    assert target.actor.is_bootstrap_owner is False
    return PolicyEvaluationConstraints(request_origin_allowed=True)


def reference(index):
    return '00000000-0000-4000-8000-%012x' % index


def materialize(ticks=(BASE,), cached=(), *, revision=1, store_key=1, unavailable=False):
    """Actual codecs create synthetic persisted header/child projections."""
    effective = evidence.EnhancedEffectiveEvidence(store_key,
        'unavailable' if unavailable else 'available',
        None if unavailable else tuple(ticks), None if unavailable else tuple(cached),
        None if unavailable else evidence.LOCAL_PROVENANCE)
    effective_bytes = evidence.encode_enhanced_effective(effective)
    display_bytes = evidence.encode_enhanced_display(evidence.EnhancedDisplayEvidence(
        store_key, 'source_record', 'Foobar record ' + str(store_key), False))
    header = codec.build_enhanced_history_header(effective_bytes=effective_bytes,
        display_bytes=display_bytes, source_revision=revision)
    entries = tuple(codec.iter_local_entry_projections(effective_bytes))
    return header, entries


def bound_row(header, entry=None, *, observation=OBS):
    header_bytes = codec.encode_enhanced_history_header(header)
    entry_bytes = None if entry is None else codec.encode_local_entry(entry)
    return dict(observation_ref=observation, source_revision=header.source_revision,
        ordinal=-1 if entry is None else entry.ordinal,
        sort_key=reader.MIN_KEY if entry is None else entry.sort_key,
        raw_filetime_le=None if entry is None else entry.raw_filetime_le,
        resolved=None if entry is None else entry.state == 'resolved',
        entry_bytes=entry_bytes,
        entry_sha256=None if entry_bytes is None else sha256(entry_bytes).hexdigest(),
        evidence_kind='enhanced_store', header_revision=header.source_revision,
        header_bytes=header_bytes, header_sha256=sha256(header_bytes).hexdigest(),
        effective_sha256=header.effective_evidence_sha256, display_sha256=header.display_sha256,
        local_entry_count=header.local_entry_count, local_vector_sha256=header.local_vector_sha256,
        current_revision=header.source_revision,
        current_effective_sha256=header.effective_evidence_sha256,
        current_display_sha256=header.display_sha256)


def entry_rows(ticks, *, observation=OBS, cached=(), revision=1):
    header, entries = materialize(ticks, cached, revision=revision)
    return [bound_row(header, entry, observation=observation) for entry in entries]


def position(row, *, way='older', view='entries', revision=1, account=1, source=SOURCE):
    return reader.EnhancedHistoryCursor(account, source, revision, view,
        row['sort_key'], row['observation_ref'], row['ordinal'], way)


class EnhancedBoundary(NativeBoundary):
    def __init__(self):
        super().__init__()
        self.pages = deque()
        self.page_calls = []

    def page(self, rows, *, view='entries', anchor=None, account=1, source=SOURCE):
        self.pages.append((view, anchor, account, source, deepcopy(rows)))

    @contextmanager
    def cursor(self):
        """Driver cursor interface used by the records-index catalog probe."""
        db = self
        class Probe:
            result = None
            def execute(self, sql, params=None):
                self.result = db.execute(sql, params)
            def fetchmany(self, count):
                assert self.result is not None
                return self.result.fetchmany(count)
        probe = Probe()
        try:
            yield probe
        finally:
            if probe.result is not None:
                probe.result.close()

    def rows(self, sql, params, kwargs):
        if sql == 'select id,is_active,disabled_at from app.accounts where id=%s for update':
            assert params == (self.account,) and not kwargs
            return [dict(id=self.account, is_active=self.active, disabled_at=None)]
        if sql == entry_readiness._SQL:
            assert params is None and not kwargs
            return [dict(entries_ready=True, entries_writer_ready=False)]
        if sql == reader._RECORDS_INDEX_SQL:
            assert params is None and not kwargs
            return [dict(ready=True)]
        if sql == reader._LOCK:
            assert kwargs == {'binary': True} and len(params) == 1 and type(params[0]) is bytes
            frame = json.loads(params[0])
            assert len(params[0]) <= 1024 and len(frame) == 5 and frame[0] == self.account
            self.frames.append((sql, frame))
            revision = self.sources.get(tuple(frame[:2]))
            return [] if revision is None else [dict(revision=revision)]
        if 'chosen as materialized' in sql:
            assert self.pages, 'Unexpected Enhanced page query'
            view, anchor, account, source, rows = self.pages.popleft()
            direction = 'older' if anchor is None else anchor.direction
            assert sql == reader._sql(view, anchor is not None, direction)
            assert kwargs == {'binary': True} and len(params) == 1 and type(params[0]) is bytes
            frame = json.loads(params[0])
            assert frame == [account, source,
                None if anchor is None else anchor.sort_key,
                None if anchor is None else anchor.observation_ref,
                None if anchor is None else anchor.ordinal]
            assert len(params[0]) <= 1024
            assert reader._LOCK in self.calls and entry_readiness._SQL in self.calls
            self.frames.append((sql, frame))
            self.page_calls.append(sql)
            return rows
        return super().rows(sql, params, kwargs)


def install(monkeypatch):
    db = EnhancedBoundary()
    BOUNDARIES.append(db)
    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW
    monkeypatch.setattr(account_authority, 'pooled_connection', db.pool)
    monkeypatch.setattr(account_authority, 'datetime', FrozenDateTime)
    # No reader, authority, session, policy, readiness or codec owner is patched.
    assert reader.current_foobar_account_read_transaction is account_authority.current_foobar_account_read_transaction
    assert reader.require_foobar_history_on_connection is readiness.require_foobar_history_on_connection
    return db


def invoke(*, view='entries', anchor=None, source=SOURCE, ctx=None, constraints=read_only, req=None):
    request = reader.EnhancedHistoryRequest(source, view, anchor) if req is None else req
    return reader.read_enhanced_history(URL, context() if ctx is None else ctx,
        request, constraints=constraints)


def assert_no_side_effects(db):
    assert not db.physical
    assert not any(sql.lstrip().lower().startswith(('insert ', 'update ', 'delete ', 'create ', 'alter '))
        for sql in db.calls)
    assert not any('from library.' in sql or 'local_track_files' in sql for sql in db.calls)
    assert all(count <= 22 for _, kind, count in db.fetches if kind == 'many')
