"""Real response finalizer and both fixed projectors, scripted transaction I/O only."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
import psycopg
import pytest
from music_app.routes import api_read_asgi_routes as routes
from music_app.services import private_library_authority as authority
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_artist_loved_browse_projection import (
    mounted, io, connection, Step, row, receipt, context, NAME, REF, NOW, GROUP_FIELDS)
from tests.py.test_artist_listen_launch_projection import CREATE, BROWSE, LOVED_CREATE, launch


_ACTUAL_TOP_FINALIZER = routes._project_artist_listen_through_launches_for_request


def inject_stale(payload):
    payload['artist_listen_through_context_ref'] = REF
    for field in GROUP_FIELDS:
        for group in payload[field]: group['artist_listen_through_launch'] = launch()
    payload['artist_page']['artist_listen_through_launch'] = launch()
    payload['legacy']['nested'] = [{'artist_listen_through_launch': launch(),
                                  'artist_listen_through_context_ref': REF, 'metadata': 'kept'}]


def cleared(body):
    assert body['artist_listen_through_context_ref'] is None
    for field in GROUP_FIELDS:
        assert all(group['artist_listen_through_launch'] is None for group in body[field])
    assert body['artist_page']['artist_listen_through_launch'] is None
    assert body['legacy']['nested'] == [{'metadata': 'kept'}]


@pytest.fixture
def listen_mount(mounted, monkeypatch):
    # The inherited mount isolates Loved; this suite exercises both real owners.
    monkeypatch.setattr(routes, '_project_artist_listen_through_launches_for_request', _ACTUAL_TOP_FINALIZER)
    mounted.harness.resolver.actor = context(grants=(BROWSE, CREATE, LOVED_CREATE)).actor
    inject_stale(mounted.payload)
    return mounted


def transactions(monkeypatch, state, *, failure=None):
    observed = []
    real = routes.project_artist_listen_through_browse_launches
    def project(*args, **kwargs):
        result = real(*args, **kwargs)
        observed.append(kwargs['payload'])
        return result
    @contextmanager
    def transaction(url, supplied, **kwargs):
        assert kwargs['read_only'] is True
        if failure == 'denied': raise authority.PrivateLibraryAuthorityError('denied')
        count = len(observed)
        yield connection([Step('id=any', [row()], clauses=('for share',))]), supplied, NOW
        if len(observed) > count:
            cleared(observed[-1])
            if failure == 'exit': raise psycopg.OperationalError('synthetic commit/exit failure')
            if failure == 'context':
                state.request.state.current_actor = replace(state.request.state.current_actor,
                    session_id=state.request.state.current_actor.session_id + 1)
    monkeypatch.setattr(routes, 'project_artist_listen_through_browse_launches', project)
    monkeypatch.setattr(authority, 'current_library_transaction', transaction)
    return observed


def test_no_receipts_recursively_strips_stale_launches_without_cache_mutation(listen_mount):
    state = listen_mount; before = deepcopy(state.payload)
    status, headers, body = state.harness.request('GET', '/view-data')
    assert status == 200 and headers['cache-control'] == 'private, no-store'
    cleared(body); assert state.payload == before


@pytest.mark.parametrize('deny', [None, CREATE, LOVED_CREATE])
def test_generator_receipts_feed_independent_top_and_loved_owners(listen_mount, io, monkeypatch, deny):
    state = listen_mount
    found = [receipt(state.payload['artist_groups'][0]), receipt(state.payload['artist_page'], 'page')]
    state.receipts = (entry for entry in found)
    state.harness.app.state.policy_constraint_resolver = lambda ctx: PolicyEvaluationConstraints(
        request_origin_allowed=ctx.action != deny)
    before = deepcopy(state.payload)
    transactions(monkeypatch, state)
    status, headers, body = state.harness.request('GET', '/view-data')
    assert status == 200 and headers['cache-control'] == 'private, no-store'
    if deny == CREATE: cleared(body)
    else:
        stamp = state.harness.context_ref()
        assert body['artist_listen_through_context_ref'] == stamp
        assert body['artist_groups'][0]['artist_listen_through_launch'] == launch(reference=stamp)
        assert body['artist_page']['artist_listen_through_launch'] == launch(reference=stamp)
    if deny == LOVED_CREATE:
        assert body['artist_loved_context_ref'] is None
        assert body['artist_groups'][0]['artist_loved_launch'] is None
    else:
        assert body['artist_loved_context_ref'] == state.harness.context_ref()
        assert body['artist_groups'][0]['artist_loved_launch']['descriptor']['scope_mode'] == 'artist'
        assert body['artist_page']['artist_loved_launches']['family']['descriptor']['scope_mode'] == 'family'
    assert body['legacy']['nested'] == [{'metadata': 'kept'}]
    assert state.payload == before


@pytest.mark.parametrize('failure', ['exit', 'context', 'denied', 'transient'])
def test_top_launch_never_installs_after_failed_or_stale_finalization(listen_mount, io, monkeypatch, failure):
    state = listen_mount
    state.receipts = [receipt(state.payload['artist_groups'][0])]
    state.transient = failure == 'transient'
    before = deepcopy(state.payload)
    observed = transactions(monkeypatch, state, failure=failure)
    status, _, body = state.harness.request('GET', '/view-data')
    assert status == 200; cleared(body)
    assert len(observed) == (1 if failure in ('exit', 'context') else 0)
    assert state.payload == before


def test_both_optional_create_denials_leave_plain_metadata_browse_usable(listen_mount, io, monkeypatch):
    state = listen_mount; state.receipts = [receipt(state.payload['artist_groups'][0])]
    state.harness.app.state.policy_constraint_resolver = lambda ctx: PolicyEvaluationConstraints(
        request_origin_allowed=ctx.action not in (CREATE, LOVED_CREATE))
    transactions(monkeypatch, state)
    status, _, body = state.harness.request('GET', '/view-data')
    assert status == 200; cleared(body)
    assert body['artist_groups'][0]['artist'] == NAME
    assert body['artist_loved_context_ref'] is None
