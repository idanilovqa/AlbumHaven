"""Synthetic state-machine tests; no SQL is executed by this adapter.

Authored only. The adapter intentionally models state but is not evidence of
real PostgreSQL locking, rollback, commit durability, or tenant isolation.
"""
from contextlib import contextmanager
from datetime import date, datetime, timezone
import json

import pytest
from music_app.services import foobar_default_source as subject
from music_app.services import foobar_account_authority as authority
from music_app.services.current_actor import CurrentActor, ActorState
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.foobar_source_postgres import SourceUnavailable, SourceStale

REF = '7147f513-5981-482f-b280-73e0a1de125a'
OTHER = '8e68b91f-e00b-4360-9f9e-5fd396e11b09'


def context(account=1, session=11):
    return PolicyContext(actor=CurrentActor(state=ActorState.ACTIVE,
                         account_id=account, session_id=session),
                         action='account.self.foobar.write', resource=None,
                         target_account_id=None, library_id=None,
                         deployment_mode='local',
                         request_origin=RequestOrigin('test', 'synthetic'),
                         client_surface_class='private_web')


def stream(ref):
    now = datetime(2026, 10, 23, 7, tzinfo=timezone.utc)
    generation = (now.date()-date(1970, 1, 1)).days
    return dict(source_ref=ref, revision=7, current_generation=generation,
                retired_through=generation-1, created_at=now, updated_at=now,
                clock_high_water=now, observed_at=now, isolation='read committed')


class SyntheticStore:
    def __init__(self):
        self.rows = {}
        self.events = []
        self.locked = None
        self.lose_ack = False
        self.fail_exit = False
        self.read_override = None

    @contextmanager
    def transaction(self, database_url, ctx, *, constraints=None):
        assert self.locked is None
        self.locked = ctx.actor.account_id
        self.events.append(('lock', self.locked))
        try:
            yield self, ctx, datetime.now(timezone.utc)
            if self.fail_exit:
                raise RuntimeError('synthetic commit failure')
            self.events.append(('commit', self.locked))
            if self.lose_ack:
                self.lose_ack = False
                raise RuntimeError('synthetic lost acknowledgement after commit')
        finally:
            self.locked = None

    def query(self, connection, sql, frame, *, maximum):
        assert connection is self
        account, ref = json.loads(frame)
        assert account == self.locked
        assert 'library' not in sql.lower()
        assert 'integration.foobar_import_streams_v2' in sql
        self.events.append(('query', sql, account, ref, maximum))
        owned = self.rows.setdefault(account, {})
        if sql == subject._ACCOUNT_LIST:
            assert maximum == 17
            return [dict(source_ref=key, is_default=default)
                    for key, default in sorted(owned.items())][:17]
        if sql == subject._ACCOUNT_INSERT:
            assert maximum == 1 and not owned
            assert ref not in owned
            owned[ref] = True
            return [dict(source_ref=ref)]
        if sql == subject._ACCOUNT_READ:
            assert maximum == 1
            if self.read_override is not None:
                return self.read_override
            return [stream(ref)] if ref in owned else []
        if sql == subject._ACCOUNT_TOUCH:
            assert maximum == 1 and ref in owned
            return [stream(ref)]
        raise AssertionError('Unexpected statement')


@pytest.fixture
def store(monkeypatch):
    value = SyntheticStore()
    monkeypatch.setattr(authority, 'current_foobar_account_transaction', value.transaction)
    monkeypatch.setattr(authority, 'require_account_foobar', lambda ctx, constraints=None: ctx)
    monkeypatch.setattr(subject, '_foobar_taste_connection', lambda connection: None)
    monkeypatch.setattr(subject, '_query', value.query)
    return value


def test_zero_sources_creates_random_persisted_default_and_commits(store):
    result = subject.select_account_foobar_source('synthetic', context())
    assert store.rows[1] == {result.source_ref: True}
    assert result.ownership_protocol == 'foobar_account_source_v2'
    assert store.events[-1] == ('commit', 1)
    from uuid import UUID
    assert UUID(result.source_ref).version == 4


def test_lost_ack_retry_reselects_one_persisted_default(store):
    store.lose_ack = True
    with pytest.raises(SourceUnavailable):
        subject.select_account_foobar_source('synthetic', context())
    persisted = next(iter(store.rows[1]))
    result = subject.select_account_foobar_source('synthetic', context())
    assert result.source_ref == persisted
    assert len(store.rows[1]) == 1
    assert sum(e[0] == 'query' and e[1] == subject._ACCOUNT_INSERT for e in store.events) == 1


def test_account_isolation_for_implicit_and_explicit_selection(store):
    store.rows = {1: {REF: True}, 2: {OTHER: True}}
    assert subject.select_account_foobar_source('synthetic', context(1)).source_ref == REF
    assert subject.select_account_foobar_source('synthetic', context(2)).source_ref == OTHER
    with pytest.raises(SourceStale):
        subject.select_account_foobar_source('synthetic', context(2), source_ref=REF)
    assert store.rows == {1: {REF: True}, 2: {OTHER: True}}


@pytest.mark.parametrize('owned', [{REF: False}, {REF: False, OTHER: False}])
def test_nondefault_sources_require_explicit_choice_without_designation(store, owned):
    store.rows[1] = dict(owned)
    with pytest.raises(subject.FoobarSourceChoiceRequired):
        subject.select_account_foobar_source('synthetic', context())
    assert store.rows[1] == owned
    assert not any(e[0] == 'query' and e[1] in (subject._ACCOUNT_INSERT, subject._ACCOUNT_TOUCH)
                   for e in store.events)
    result = subject.select_account_foobar_source('synthetic', context(), source_ref=REF)
    assert result.source_ref == REF and store.rows[1] == owned


def test_explicit_missing_never_creates_even_when_account_empty(store):
    with pytest.raises(SourceStale):
        subject.select_account_foobar_source('synthetic', context(), source_ref=REF)
    assert not store.rows[1]
    assert not any(e[0] == 'query' and e[1] == subject._ACCOUNT_INSERT for e in store.events)


def test_existing_default_among_sixteen_is_reused(store):
    store.rows[1] = {f'00000000-0000-4000-8000-{i:012x}': False for i in range(15)}
    store.rows[1][REF] = True
    assert subject.select_account_foobar_source('synthetic', context()).source_ref == REF
    assert len(store.rows[1]) == 16


def test_seventeenth_source_fails_closed_without_insert(store):
    store.rows[1] = {f'00000000-0000-4000-8000-{i:012x}': i == 0 for i in range(17)}
    with pytest.raises(SourceUnavailable):
        subject.select_account_foobar_source('synthetic', context())
    assert len(store.rows[1]) == 17
    assert not any(e[0] == 'query' and e[1] == subject._ACCOUNT_INSERT for e in store.events)


def test_transaction_exit_failure_returns_no_result(store):
    store.rows[1] = {REF: True}
    store.fail_exit = True
    with pytest.raises(SourceUnavailable):
        subject.select_account_foobar_source('synthetic', context())


def test_mismatched_read_row_does_not_touch(store):
    store.rows[1] = {REF: True}
    store.read_override = [stream(OTHER)]
    with pytest.raises(SourceUnavailable):
        subject.select_account_foobar_source('synthetic', context())
    assert not any(e[0] == 'query' and e[1] == subject._ACCOUNT_TOUCH for e in store.events)


@pytest.mark.parametrize('rows', [None, (), [{}], [{'source_ref': REF, 'is_default': 1}],
    [{'source_ref': REF.upper(), 'is_default': True}],
    [{'source_ref': REF, 'is_default': False}, {'source_ref': REF, 'is_default': False}],
    [{'source_ref': REF, 'is_default': True}, {'source_ref': OTHER, 'is_default': True}],
    [{'source_ref': REF, 'is_default': True, 'extra': None}]])
def test_malformed_source_list_rejected(rows):
    with pytest.raises(SourceUnavailable):
        subject._account_source_choices(rows)


def test_explicit_existing_selection_does_not_scan_or_apply_creation_cap(store):
    store.rows[1] = {f'00000000-0000-4000-8000-{i:012x}': False for i in range(17)}
    store.rows[1][REF] = False
    assert subject.select_account_foobar_source('synthetic', context(), source_ref=REF).source_ref == REF
    assert not any(e[0] == 'query' and e[1] in (subject._ACCOUNT_LIST, subject._ACCOUNT_INSERT)
                   for e in store.events)


@pytest.mark.parametrize('rows', [None, [], (), [{}], [{'source_ref': OTHER}],
    [{'source_ref': OTHER}, {'source_ref': OTHER}], [{'source_ref': OTHER, 'extra': 1}]])
def test_malformed_insert_ack_cannot_reach_read_touch_or_result(store, monkeypatch, rows):
    original = store.query
    def query(connection, sql, frame, *, maximum):
        if sql == subject._ACCOUNT_INSERT:
            # Deliberately malformed acknowledgement, not an actual DB write.
            store.events.append(('malformed_insert',))
            return rows
        return original(connection, sql, frame, maximum=maximum)
    monkeypatch.setattr(subject, '_query', query)
    with pytest.raises(SourceUnavailable):
        subject.select_account_foobar_source('synthetic', context())
    assert not any(e[0] == 'query' and e[1] in (subject._ACCOUNT_READ, subject._ACCOUNT_TOUCH)
                   for e in store.events)
    assert not any(e[0] == 'commit' for e in store.events)


@pytest.mark.parametrize('delta', [-1, 1])
def test_touch_backwards_or_future_day_generation_returns_no_selection(store, monkeypatch, delta):
    store.rows[1] = {REF: True}
    original = store.query
    def query(connection, sql, frame, *, maximum):
        rows = original(connection, sql, frame, maximum=maximum)
        if sql == subject._ACCOUNT_TOUCH:
            rows[0]['current_generation'] += delta
            if delta < 0:
                # Keep the row internally valid to isolate monotonicity failure.
                rows[0]['retired_through'] -= 1
        return rows
    monkeypatch.setattr(subject, '_query', query)
    with pytest.raises(SourceUnavailable):
        subject.select_account_foobar_source('synthetic', context())
    assert not any(e[0] == 'commit' for e in store.events)
