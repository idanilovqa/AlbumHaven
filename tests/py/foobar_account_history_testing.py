"""Genuine account/session/read/write owners over controlled SQL driver rows.

No product owner is patched: only the pooled connection and clock are replaced.
The bounded query result model is not evidence of PostgreSQL plans, triggers,
constraints, locking, transaction isolation or durable persistence.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
import json
from uuid import uuid4

from music_app.services import foobar_account_history_postgres as history
from music_app.services import foobar_account_history_projection_writer as writer
from music_app.services import foobar_account_history_readiness as readiness
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.foobar_account_import_jobs_testing import (
    JobBoundary, STATE, authority, account_authority, requested_context, p, a, f, URL, GEN, CAPACITY,
)
from tests.py.foobar_account_associations_v3_testing import make_command, prepare, apply
from tests.py.foobar_account_history_driver import current_source
from tests.py.foobar_account_history_values import (
    SOURCE, OTHER_SOURCE, OBS, FIRST, LAST, projection, materialize, bound_row, digest, payload, codec,
)


def read_only(target):
    return PolicyEvaluationConstraints(request_origin_allowed=target.action == 'account.self.foobar.read')


def read_context(account=1, session=3):
    context = requested_context(None)
    return replace(context, actor=replace(context.actor, account_id=account, session_id=session,
        current_library_id=None, library_relationships=(), capability_grants=(), is_bootstrap_owner=False),
        target_account_id=account, library_id=None)


class HistoryBoundary(JobBoundary):
    def __init__(self):
        super().__init__()
        self.read_current = {}
        self.source_catalog = {(1, SOURCE): dict(source_ref=SOURCE, created_at=self.now,
            is_default=True, observation_count=0)}
        self.history_page_frames = []
        self.page_override = None
        self.after_page = None
        self.read_locks = []
        self.fetch_limits = []

    @contextmanager
    def transaction(self):
        before = deepcopy(tuple(getattr(self, name) for name in STATE))
        try:
            yield
        except BaseException:
            for name, value in zip(STATE, before):
                setattr(self, name, value)
            raise

    def cursor(self, rows):
        cursor = super().cursor(rows)
        original = cursor.fetchmany
        def bounded(maximum):
            self.fetch_limits.append(maximum)
            return original(maximum)
        cursor.fetchmany = bounded
        return cursor

    def binding(self, scope, stored):
        source_row, revision = current_source(self, scope[2])
        if source_row is not None:
            current = (revision, digest(bytes.fromhex(source_row[6])), digest(bytes.fromhex(source_row[7])))
        else:
            current = self.read_current.get(scope, (None, None, None))
        return dict(deepcopy(stored), current_revision=current[0],
            current_effective_sha256=current[1], current_display_sha256=current[2])

    def execute(self, sql, params=None, **kwargs):
        if sql == self.fail_sql:
            self.calls.append(sql)
            raise OSError('synthetic controlled history driver failure')
        if sql == history._LOCK_SQL or sql in history._LIST_SQL.values() or sql in history._SOURCE_LIST_SQL.values():
            self.calls.append(sql)
            assert kwargs == {'binary': True} and len(params) == 1 and type(params[0]) is bytes
            assert len(params[0]) <= history.MAX_FRAME_BYTES
            frame = json.loads(params[0])
            self.history_page_frames.append((sql, deepcopy(frame)))
            if sql in history._SOURCE_LIST_SQL.values():
                assert frame[0] == self.tx_account and not self.locked_sources
                rows = [deepcopy(row) for (account, source), row in self.source_catalog.items()
                    if account == frame[0] and (frame[1] is None or source > frame[1])]
                rows.sort(key=lambda row: row['source_ref'])
                result = rows[:21]
            else:
                assert frame['account_id'] == self.tx_account
                owner = frame['account_id'], frame['source_ref']
                if sql == history._LOCK_SQL:
                    if owner not in self.sources:
                        return self.cursor([])
                    self.locked_sources.add(owner)
                    self.read_locks.append(owner)
                    return self.cursor([dict(revision=self.revision)])
                assert owner in self.locked_sources
                family, mode, cursor_kind = next(key for key, value in history._LIST_SQL.items() if value == sql)
                # This is a known-query driver projection over persisted scalars,
                # not a copied Python repository, codec or authority result.
                arms = (('first', 1), ('last', 0)) if mode == 'individual' else (('last', 0),)
                candidates = []
                for column, rank in arms:
                    rows = []
                    for scope, stored in self.history_projections.items():
                        if scope[:2] != owner:
                            continue
                        key = stored[family + '_' + column]
                        if key is None or (mode == 'individual' and column == 'last' and not stored[family + '_last_present']):
                            continue
                        position = key, rank, scope[2]
                        if cursor_kind is not None:
                            prior_rank = 1 if cursor_kind == 'first_boundary' else 0
                            if not position < (frame['sort_key'], prior_rank, frame['observation_ref']):
                                continue
                        rows.append((position, scope, stored))
                    rows.sort(key=lambda value: value[0], reverse=True)
                    assert 'limit 21' in sql
                    candidates.extend(rows[:21])
                candidates.sort(key=lambda value: value[0], reverse=True)
                assert len(candidates) <= (42 if mode == 'individual' else 21)
                result = [dict(self.binding(scope, stored), observation_ref=scope[2],
                    sort_key=key[0], arm_rank=key[1]) for key, scope, stored in candidates[:21]]
            if self.after_page is not None:
                self.after_page(self)
            return self.cursor(result if self.page_override is None else deepcopy(self.page_override))
        return super().execute(sql, params, **kwargs)


def install(monkeypatch):
    db = HistoryBoundary()
    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return db.now
    for owner in (authority, account_authority):
        monkeypatch.setattr(owner, 'datetime', FrozenDateTime)
        monkeypatch.setattr(owner, 'pooled_connection', db.pool)
    monkeypatch.setattr(p, 'current_foobar_import_transaction', authority.current_foobar_import_transaction)
    assert history.current_foobar_account_read_transaction is account_authority.current_foobar_account_read_transaction
    return db


def seed(db, count=43, *, account_id=1, source_ref=SOURCE, first=FIRST, last=LAST, total=2):
    """Synthetic persisted SQL-result rows for the standalone read contract."""
    db.sources.add((account_id, source_ref))
    db.source_catalog[(account_id, source_ref)] = dict(source_ref=source_ref, created_at=db.now,
        is_default=source_ref == SOURCE, observation_count=count)
    db.revision = max(db.revision, 1)
    refs = []
    for index in range(1, count + 1):
        ref = '00000000-0000-4000-8000-%012x' % index
        value = projection(play_count=total, first_played=first, last_played=last,
            play_count_enhanced=3, first_played_enhanced=first, last_played_enhanced=last)
        row = bound_row(value)
        db.read_current[(account_id, source_ref, ref)] = (
            row.pop('current_revision'), row.pop('current_effective_sha256'), row.pop('current_display_sha256'))
        db.history_projections[(account_id, source_ref, ref)] = row
        refs.append(ref)
    return refs


def listed(db, *, family='standard', mode='individual', cursor=None, source_ref=SOURCE, context=None, constraints=read_only):
    request = history.FoobarHistoryRequest(source_ref, family, mode, cursor)
    return history.read_foobar_history(URL, context or read_context(), request, constraints=constraints)


def all_pages(db, **kwargs):
    items, pages, cursor = [], [], None
    while True:
        page = listed(db, cursor=cursor, **kwargs)
        assert len(page.items) <= 20
        items.extend(page.items)
        pages.append(page)
        if page.next_cursor is None:
            return tuple(items), tuple(pages)
        assert page.next_cursor != cursor
        cursor = page.next_cursor


def install_existing_genuine(monkeypatch):
    """Retain accepted exact existing-source SQL model, use real outer authority.

    Unlike the legacy install_existing fixture, this replaces only native pool,
    session SQL rows and time. No transaction-owner/authority function is faked.
    """
    from datetime import timedelta
    from tests.py.foobar_account_existing_chain_synthetic import ExistingBoundary
    from tests.py.foobar_account_chain_synthetic import Cursor
    db = ExistingBoundary()
    db.closed = False
    db.accounts = {1: True}
    db.sessions = {(1, 3): True}
    db.tx_account = None
    db.rollbacks = []
    names = ('receipt', 'receipts', 'keys', 'source_row', 'revision', 'revisions',
             'observation_revision', 'observation_inserts', 'history_projections')
    original_execute = db.execute

    def cursor(rows):
        value = Cursor(rows); db.cursors.append(value); return value

    def execute(sql, params=None, **kwargs):
        if sql in ('set transaction isolation level read committed', "set local lock_timeout = '250ms'",
                   "set local statement_timeout = '1000ms'"):
            db.calls.append(sql); return cursor([])
        if sql == 'select id,is_active,disabled_at from app.accounts where id=%s for update':
            db.calls.append(sql)
            account, = params; db.tx_account = account
            return cursor([] if account not in db.accounts else [dict(id=account,
                is_active=db.accounts[account], disabled_at=None)])
        if 'from app.account_sessions' in sql:
            db.calls.append(sql)
            session, account = params
            assert account == db.tx_account
            return cursor([] if (account, session) not in db.sessions else [dict(id=session,
                account_id=account, authenticated_at=db.now, idle_expires_at=db.now + timedelta(days=1),
                absolute_expires_at=db.now + timedelta(days=1), revoked_at=None if db.sessions[(account, session)] else db.now)])
        return original_execute(sql, params, **kwargs)

    @contextmanager
    def pool(url):
        assert url == URL
        before = deepcopy(tuple(getattr(db, name) for name in names))
        try:
            yield db
        except BaseException as error:
            for name, value in zip(names, before): setattr(db, name, value)
            db.rollbacks.append(type(error))
            raise
        else:
            db.commits += 1
            if db.lose_ack:
                db.lose_ack = False
                raise OSError('synthetic acknowledgement loss after committed state')
        finally:
            db.tx_account = None

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None): return db.now
    monkeypatch.setattr(db, 'execute', execute)
    for owner in (authority, account_authority):
        monkeypatch.setattr(owner, 'datetime', FrozenDateTime)
        monkeypatch.setattr(owner, 'pooled_connection', pool)
    monkeypatch.setattr(p, 'current_foobar_import_transaction', authority.current_foobar_import_transaction)
    return db
