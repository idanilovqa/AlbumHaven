"""C-2 integration contracts through genuine owner and PostgreSQL transactions.

NEW source-authored tests, NOT RUN. Included images use actual POSIX start and
advance acquisition; complete metadata comes from the existing real source,
track and physical-file fixture. Consent is issued by review_publication_* with
its real cursor codec. The C-1 direct-SQL fake review digests are never consent.

Transparent wrappers observe real statements, count fixed collaborators, or
raise after a named successful statement to test rollback. They do not fabricate
SQL results, authority, PNGs, proof success, receipts, or database time. Callback
constraints are read-only. Explicit between-transaction races and fixture-owned
shorter original deadlines are identified in their tests. There is no product
configuration-module import, route activation or runtime authorization here.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from threading import Barrier
from time import sleep
from uuid import uuid4

import pytest

from music_app.services import album_top_artwork_preparation as preparation
from music_app.services import album_top_artwork_publication as artwork_publication
from music_app.services import album_top_publication as publication
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import album_top_remote_membership as remote_membership
from music_app.services import artwork_proof_codec as codec
from music_app.services import public_top_artwork_acquisition as acquisition
from music_app.services.album_top_artwork_preparation import TopArtworkPreparationService
from music_app.services.owned_album_tops import ACCESS, AlbumTopError, normalize_top_command
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_collaboration_postgres import new_session, member
from tests.py import test_album_top_artwork_preparation_postgres as foundation
from tests.py.test_top_artwork_draft_preparation_postgres import command as draft_command
from tests.py.test_top_artwork_publication_retention_postgres import (
    PublicationCase, publication_case, teardown_publications, runtime,
    durable_snapshot, preparation_header, assert_staging_budget, POSIX_CAPTURE,
)
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.remote_top_postgres_support import remote
from tests.py.remote_top_retention_postgres_support import retained

CONTEXT = foundation.CONTEXT
SECRET = 'synthetic-c2-publication-consent-key-only'
OTHER_SECRET = 'synthetic-c2-coordinated-key-rotation-only'
KINDS = ('saved', 'draft')
COUNTS = (0, 1, 100, 101, 250, 5000)
HEADER = {'title': 'Explicit artwork publication', 'description': 'Owner-approved complete local draft'}
STEPS = (
    ('admit', 'select app.admit_top_artwork_publication('),
    ('membership', 'delete from app.album_list_items '),
    ('header', 'update app.album_lists set title='),
    ('map', 'select app.map_top_artwork_publication_page('),
    ('seal', 'select app.seal_top_artwork_publication('),
    ('pointer', 'insert into app.shared_links '),
    ('receipt', 'insert into app.album_list_operations '),
    ('consume', 'select app.consume_top_artwork_publication('),
    ('finalizer', 'set constraints app.artwork_publication_finalize immediate'),
)


def forbidden(*args, **kwargs):
    raise AssertionError('Forbidden I/O, discovery or legacy publication path reached')


def configure(case):
    # Explicit admitted synthetic service dictionary, never config.py or a route.
    case.db.service._config.update(ALBUM_HAVEN_PUBLIC_SHARING_ENABLED=True,
        ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN='https://albumhaven.example.test',
        ALBUM_HAVEN_PUBLIC_BASE_URL='https://albumhaven.example.test')
    with case.db.connect() as connection:
        connection.execute('''insert into app.capabilities
            (account_id,capability_key,scope_kind,scope_id)
            values(%s,%s,'library',%s) on conflict do nothing''',
            (case.db.owner.account_id, ACCESS, case.db.library))
    return case


@pytest.fixture
def c2_case(publication_case):
    return configure(publication_case)


@pytest.fixture
def c2_remote_case(retained, tmp_path):
    # C1 teardown must run before remote retention removes membership/history.
    case = configure(PublicationCase(retained.db, tmp_path))
    try:
        with runtime(case):
            pass
        yield case, retained
    finally:
        teardown_publications(case)


def ready(case, kind, *, payload=None):
    """Real start/advance, <=4 actual captures per request, fixed loop bound."""
    if kind == 'saved':
        payload = payload or {**case.payload, 'revision': case.top['revision'], 'request_key': str(uuid4())}
        state = case.start(payload=payload)
        included = sum(row['include_artwork'] for row in payload['items'])
    else:
        payload = payload or draft_command(case)
        state = case.service.start_draft(case.db.context(), top_ref=case.top['top_ref'],
            payload=payload, context_ref=CONTEXT)
        included = sum(row['include_artwork'] for row in payload['rows'])
    for _ in range(max(1, (included + 3) // 4)):
        if state['state'] == 'ready':
            break
        if kind == 'saved':
            state = case.advance(state)
        else:
            state = case.service.advance_draft(case.db.context(), top_ref=case.top['top_ref'],
                top_revision_value=case.top['revision'], preparation_ref=state['preparation_ref'],
                preparation_revision=state['preparation_revision'], draft_ref=payload['draft_ref'],
                draft_revision=payload['draft_revision'], request_key=str(uuid4()), context_ref=CONTEXT)
    assert state['state'] == 'ready', 'Actual preparation did not finish within its <=4-row batch bound'
    return state, payload


def identities(case, state, kind, payload):
    result = dict(top_ref=case.top['top_ref'], top_revision=case.top['revision'],
        preparation_ref=state['preparation_ref'], preparation_revision=state['preparation_revision'],
        context_ref=CONTEXT, cursor_secret=SECRET)
    if kind == 'draft':
        result.update(draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'])
    return result


def review_command(case, state, kind, payload, *, action='enable_external', header=None, constraints=None):
    header = HEADER if header is None else header
    method = case.service.review_publication_saved if kind == 'saved' else case.service.review_publication_draft
    approved = method(case.db.context(), **identities(case, state, kind, payload),
        **header, action=action, constraints=constraints)
    if kind == 'saved':
        items = [{key: value for key, value in row.items() if key != 'include_artwork'}
                 for row in payload['items']]
    else:
        items = [{'item_ref': row['selection'].get('item_ref'),
            'album_ref': row['selection']['album_ref'],
            'selected_local_album_id': row['selection']['source']['selected_local_album_id'],
            'selected_source_ref': row['selection']['source']['selected_source_ref']}
            for row in payload['rows']]
    descriptor = {'version': 2, 'kind': kind, 'preparation_ref': state['preparation_ref'],
        'preparation_revision': state['preparation_revision'], 'context_ref': CONTEXT,
        'review_witness': approved['review_witness'], 'publication_intent': approved['publication_intent']}
    if kind == 'draft':
        descriptor.update(draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'])
    command = normalize_top_command(action, {'request_key': str(uuid4()), 'revision': case.top['revision'],
        **approved['proposed_header'], 'items': items,
        'evidence_revision': approved['metadata_evidence_revision'], 'artwork_publication': descriptor},
        top_ref=case.top['top_ref'])
    return approved, command


def execute(case, command, *, actor=None, key=SECRET, **options):
    return case.db.service.execute(case.db.context(actor), command, cursor_secret=key, **options)


def changed(command, *, action=None, request_key=None, **data):
    return normalize_top_command(action or command.action,
        {**deepcopy(command.data), **data, 'request_key': request_key or command.request_key},
        top_ref=command.top_ref)


def trap_pixels(monkeypatch, *, all_observation=False):
    # execute constructs a fresh preparation owner, so patch the class/shared
    # primitive rather than only the fixture's earlier service instance.
    monkeypatch.setattr(preparation, 'capture_artwork', forbidden)
    monkeypatch.setattr(TopArtworkPreparationService, '_capture_rows', staticmethod(forbidden))
    monkeypatch.setattr(acquisition, '_read_bounded', forbidden)
    monkeypatch.setattr(acquisition, 'sanitize_artwork_pixels', forbidden)
    if all_observation:
        monkeypatch.setattr(preparation, 'describe_artwork_source', forbidden)
        monkeypatch.setattr(TopArtworkPreparationService, '_draft_probe', staticmethod(forbidden))
        monkeypatch.setattr(preparation, 'resolve_typed_artwork_observations', forbidden)
        monkeypatch.setattr(codec, 'prepare_inventory_binding', forbidden)


@contextmanager
def observe(case, *, after=None):
    """Actual runtime SQL; retain compact page identities, never PNG/proof bytes."""
    connect = case.db.service._connect
    trace = {'steps': [], 'pages': [], 'sql': [], 'active': 0, 'connections': 0}

    class Connection:
        def __init__(self, real):
            self.real = real
            self.role_checked = False

        def __getattr__(self, name):
            return getattr(self.real, name)

        def execute(self, sql, params=None):
            text = ' '.join(str(sql).lower().split())
            if not self.role_checked:
                assert text == 'set transaction isolation level read committed', (
                    'Owner must initialize transaction isolation before observed SQL')
            result = self.real.execute(sql, params)
            if not self.role_checked:
                # SELECT-based role checks must follow the owner's isolation
                # initialization, before its first authority/data query.
                assert_runtime_role(self.real, case.db)
                self.role_checked = True
            trace['sql'].append(text)
            for name, prefix in STEPS:
                if text.startswith(prefix):
                    trace['steps'].append(name)
            if text.startswith('select app.map_top_artwork_publication_page('):
                page = params[1].obj
                assert 1 <= len(page) <= 100
                assert all(set(row) == {'curator_position', 'item_ref', 'original_position',
                    'presentation_ref', 'descriptor_witness'} for row in page)
                trace['pages'].append([{
                    'curator_position': row['curator_position'], 'item_ref': row['item_ref'],
                    'original_position': row['original_position'], 'presentation_ref': row['presentation_ref'],
                    'has_witness': row['descriptor_witness'] is not None,
                } for row in page])
            if after is not None:
                after(self.real, text, params, trace)
            return result

    @contextmanager
    def connected(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            connection.execute("set local lock_timeout='5s'")
            connection.execute("set local statement_timeout='120s'")
            trace['active'] += 1
            trace['connections'] += 1
            try:
                yield Connection(connection)
            finally:
                trace['active'] -= 1

    case.db.service._connect = connected
    try:
        yield trace
    finally:
        case.db.service._connect = connect


def publication_rows(case, receipt):
    with case.db.connect() as connection:
        ref = receipt['publication']['publication_ref']
        header = connection.execute('select * from app.album_list_publications where ref=%s', (ref,)).fetchone()
        items = connection.execute('''select p.*,t.track_count from app.album_list_publication_items p
            join library.album_presentation_seals t on t.presentation_ref=p.presentation_ref
            where p.publication_ref=%s order by p.curator_position''', (ref,)).fetchall()
        retained_rows = connection.execute('''select * from app.album_top_artwork_publication_rows
            where publication_ref=%s order by curator_position''', (ref,)).fetchall()
        lineage = connection.execute('select * from app.album_top_artwork_publication_lineage where publication_ref=%s', (ref,)).fetchone()
        consumed = connection.execute('select * from app.album_top_artwork_publication_consumptions where publication_ref=%s', (ref,)).fetchone()
        seal = connection.execute('select * from app.album_list_publication_seals where publication_ref=%s', (ref,)).fetchone()
        operation = connection.execute('''select * from app.album_list_operations where actor_account_id=%s
            and library_id=%s and request_key=%s''',
            (case.db.owner.account_id, case.db.library, receipt['request_key'])).fetchone()
    return header, items, retained_rows, lineage, consumed, seal, operation


def assert_committed(case, state, command, receipt, trace, *, included):
    header, items, rows, lineage, consumed, seal, operation = publication_rows(case, receipt)
    assert receipt['revision'] == str(int(command.data['revision']) + 1)
    assert header['contract_version'] == seal['seal_contract_version'] == 2
    assert header['approved_top_revision'] == int(receipt['revision'])
    assert header['title'] == command.data['title'] and header['description'] == command.data['description']
    assert len(items) == len(rows) == len(command.data['items']) == lineage['row_count']
    assert [row['curator_position'] for row in items] == list(range(1, len(items) + 1))
    assert [str(row['catalog_ref']) for row in items] == [row['album_ref'] for row in command.data['items']]
    assert [str(row['item_ref']) for row in rows] == [str(row['item_ref']) for row in items]
    assert sum(row['included'] for row in rows) == included
    assert all(row['track_count'] == 1 for row in items)
    assert consumed['removed_items'] == len(items)
    assert consumed['build_xid'] == lineage['build_xid'] == seal['build_xid']
    assert consumed['seal_digest'] == seal['content_digest']
    assert consumed['consumed_at'] < lineage['expires_at']
    assert str(consumed['preparation_ref']) == state['preparation_ref']
    assert operation['receipt'] == receipt and operation['command_digest'] == command.digest
    assert operation['original_session_id'] == case.db.owner.session_id
    assert trace['steps'] == ['admit', 'membership', 'header'] + ['map'] * ((len(items) + 99) // 100) + [
        'seal', 'pointer', 'receipt', 'consume', 'finalizer']
    assert sum(map(len, trace['pages'])) == len(items)
    assert [entry['item_ref'] for page in trace['pages'] for entry in page] == [str(row['item_ref']) for row in items]
    assert [entry['original_position'] for page in trace['pages'] for entry in page] == [row['original_position'] for row in items]
    assert [entry['presentation_ref'] for page in trace['pages'] for entry in page] == [str(row['presentation_ref']) for row in items]
    with case.db.connect() as connection:
        assert connection.execute('select ref from app.album_top_artwork_preparations where ref=%s',
            (state['preparation_ref'],)).fetchone() is None
        link = connection.execute('select * from app.shared_links where top_ref=%s', (case.top['top_ref'],)).fetchone()
        assert str(link['active_publication_ref']) == receipt['publication']['publication_ref']
        assert link['state'] == 'enabled'
    assert_staging_budget(case, 0, 0, 0)


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('count', COUNTS)
def test_complete_excluded_and_empty_vectors_use_real_metadata_and_exact_pages(c2_case, monkeypatch, kind, count):
    case = c2_case.build(count, excluded=range(count))
    trap_pixels(monkeypatch, all_observation=True)
    state, payload = ready(case, kind)
    before = durable_snapshot(case)
    approved, command = review_command(case, state, kind, payload)
    assert approved['item_count'] == count and approved['included_count'] == 0
    assert durable_snapshot(case) == before, 'Review must not publish, claim, renew or consume'
    with observe(case) as trace:
        result = execute(case, command)
    assert_committed(case, state, command, result, trace, included=0)
    assert all(not row['has_witness'] for page in trace['pages'] for row in page)
    assert trace['connections'] == 1


@pytest.mark.parametrize('kind', KINDS)
@POSIX_CAPTURE
def test_genuine_included_publication_captures_metadata_once_and_never_decodes_again(c2_case, monkeypatch, kind):
    case = c2_case.build(3, excluded=(1,), same_pixels=True)
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    captures, applies, probes = [], [], []
    original_capture, original_apply = evidence.capture_artwork_review, publication.apply_draft
    original_probe = TopArtworkPreparationService._draft_probe
    def captured(*args, **kwargs):
        result = original_capture(*args, **kwargs)
        captures.append((len(result['items']), result['generation'], result['evidence_revision']))
        return result
    def applied(*args, **kwargs):
        applies.append(True)
        return original_apply(*args, **kwargs)
    monkeypatch.setattr(evidence, 'capture_artwork_review', captured)
    monkeypatch.setattr(publication, 'apply_draft', applied)
    trap_pixels(monkeypatch)
    with observe(case) as trace:
        def probed(snapshot):
            assert trace['active'] == 0, 'Descriptor observation must be outside authority transactions'
            probes.append(len(snapshot['rows']))
            return original_probe(snapshot)
        monkeypatch.setattr(TopArtworkPreparationService, '_draft_probe', staticmethod(probed))
        result = execute(case, command)
    assert captures == [(3, int(command.data['artwork_publication']['review_witness']['metadata_generation']),
                         command.data['evidence_revision'])]
    assert applies == [True] and probes == [3] and trace['connections'] == 2
    assert_committed(case, state, command, result, trace, included=2)
    assert [row['has_witness'] for page in trace['pages'] for row in page] == ([True, False, True] if kind == 'draft' else [False] * 3)


@POSIX_CAPTURE
def test_draft_actual_canonical_proofs_cross_100_row_boundary(c2_case, monkeypatch):
    case = c2_case.build(101, same_pixels=True, excluded=(99,))
    state, payload = ready(case, 'draft')
    _, command = review_command(case, state, 'draft', payload)
    original = codec.canonical_source_bytes
    derived = []
    def canonical(value):
        result = original(value)
        derived.append(len(result))
        return result
    monkeypatch.setattr(codec, 'canonical_source_bytes', canonical)
    trap_pixels(monkeypatch)
    with observe(case) as trace:
        result = execute(case, command)
    assert_committed(case, state, command, result, trace, included=100)
    assert list(map(len, trace['pages'])) == [100, 1]
    assert trace['pages'][0][-1]['has_witness'] is False
    assert trace['pages'][1][0]['has_witness'] is True
    assert len(derived) >= 100 and max(derived) <= 65536


@pytest.mark.parametrize('included', [False, pytest.param(True, marks=POSIX_CAPTURE)])
def test_draft_removal_reorder_and_new_member_bind_actual_final_uuids(c2_case, monkeypatch, included):
    case = c2_case.build(3, excluded=() if included else range(3))
    old = case.db.read(case.top)['items']
    case.top = case.db.service.execute(case.db.context(), case.db.command('remove', case.top, item_refs=[old[2]['ref']]))
    payload = draft_command(case, new=(2,), order=(2, 0))
    state, payload = ready(case, 'draft', payload=payload)
    _, command = review_command(case, state, 'draft', payload)
    trap_pixels(monkeypatch, all_observation=not included)
    with observe(case) as trace:
        result = execute(case, command)
    assert_committed(case, state, command, result, trace, included=2 if included else 0)
    _, items, _, _, _, _, _ = publication_rows(case, result)
    assert str(items[1]['item_ref']) == old[0]['ref']
    assert str(items[0]['item_ref']) not in {row['ref'] for row in old}
    assert [row['original_position'] for row in items] == [4, 1]
    assert command.data['items'][0]['item_ref'] is None
    assert command.data['items'][1]['item_ref'] == old[0]['ref']


@pytest.mark.parametrize('key', [None, '', 'short', OTHER_SECRET])
def test_new_publication_missing_or_rotated_key_has_no_v1_fallthrough(c2_case, monkeypatch, key):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, 'saved')
    _, command = review_command(case, state, 'saved', payload)
    before = durable_snapshot(case)
    monkeypatch.setattr(publication, 'save', forbidden)
    monkeypatch.setattr(remote_membership, 'discover_pending_sources', forbidden)
    trap_pixels(monkeypatch, all_observation=True)
    with observe(case) as trace:
        assert_error(lambda: execute(case, command, key=key),
            'invalid_or_stale_review' if key == OTHER_SECRET else 'review_key_unavailable',
            409 if key == OTHER_SECRET else 503)
    assert not trace['steps'] and durable_snapshot(case) == before
    if key != OTHER_SECRET:
        assert not any('from app.album_lists' in sql or 'album_top_artwork_preparations' in sql
                       for sql in trace['sql']), 'Missing-key fresh request must fail before target/preparation lookup'


@pytest.mark.parametrize('kind', KINDS)
def test_consumed_receipt_replays_from_new_session_without_key_or_staging(c2_case, monkeypatch, kind):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    result = execute(case, command)
    actor = new_session(case.db, case.db.owner)
    with case.db.connect() as connection:
        connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
            (case.db.owner.session_id,))
    before = durable_snapshot(case)
    monkeypatch.setattr(TopArtworkPreparationService, '__init__', forbidden)
    monkeypatch.setattr(remote_membership, 'bindings', forbidden)
    monkeypatch.setattr(evidence, 'capture_artwork_review', forbidden)
    with observe(case) as trace:
        assert execute(case, command, actor=actor, key=None) == result
    assert trace['steps'] == [] and durable_snapshot(case) == before
    assert not any('from app.album_top_artwork_preparations' in sql for sql in trace['sql'])
    assert_error(lambda: execute(case, changed(command, title='Same key, changed consent'), actor=actor, key=None),
        'request_key_conflict', 409)
    assert_error(lambda: execute(case, changed(command, request_key=str(uuid4())), actor=actor, key=None),
        'review_key_unavailable', 503)
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
def test_replaying_landed_enable_after_revoke_does_not_reactivate_pointer(c2_case, kind):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    result = execute(case, command)
    revoked = case.db.service.execute(case.db.context(), case.db.command('revoke_external', result))
    before = durable_snapshot(case)
    assert execute(case, command, key=None) == result
    assert durable_snapshot(case) == before
    assert revoked['publication']['state'] == 'revoked'
    assert before['shared_links'][0]['active_publication_ref'] is None


@POSIX_CAPTURE
def test_a2_receipt_wins_after_another_real_request_lands_in_the_outside_gap(c2_case, monkeypatch):
    case = c2_case.build(1)
    state, payload = ready(case, 'saved')
    _, command = review_command(case, state, 'saved', payload)
    original = TopArtworkPreparationService._draft_probe
    landed = []
    entered = False
    def probed(snapshot):
        nonlocal entered
        observations = original(snapshot)
        if not entered:
            entered = True
            landed.append(execute(case, command))
        return observations
    monkeypatch.setattr(TopArtworkPreparationService, '_draft_probe', staticmethod(probed))
    with observe(case) as trace:
        result = execute(case, command)
    assert landed == [result]
    assert trace['steps'].count('admit') == trace['steps'].count('receipt') == trace['steps'].count('consume') == 1
    assert preparation_header(case, state['preparation_ref']) is None


@pytest.mark.parametrize('change', ['title', 'description', 'action', 'order', 'source', 'witness', 'intent'])
def test_valid_normalized_but_unapproved_payload_rolls_back_without_admission(c2_case, change):
    case = c2_case.build(2, excluded=range(2))
    state, payload = ready(case, 'saved')
    _, command = review_command(case, state, 'saved', payload)
    if change in ('title', 'description'):
        command = changed(command, **{change: command.data[change] + ' changed'})
    elif change == 'action':
        command = changed(command, action='save')
    elif change == 'order':
        command = changed(command, items=list(reversed(command.data['items'])))
    elif change == 'source':
        items = deepcopy(command.data['items']); items[0]['selected_source_ref'] = str(uuid4())
        command = changed(command, items=items)
    else:
        descriptor = deepcopy(command.data['artwork_publication'])
        field = 'review_witness' if change == 'witness' else 'publication_intent'
        token = descriptor[field]['token']; middle = len(token) // 2
        descriptor[field]['token'] = token[:middle] + ('A' if token[middle] != 'A' else 'B') + token[middle + 1:]
        command = changed(command, artwork_publication=descriptor)
    before = durable_snapshot(case)
    with observe(case) as trace:
        assert_error(lambda: execute(case, command),
            'items_changed' if change in ('order', 'source') else 'invalid_or_stale_review', 409)
    assert trace['steps'] == [] and durable_snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
def test_off_page_metadata_change_invalidates_consent_without_recapturing_or_writes(c2_case, monkeypatch, kind):
    case = c2_case.build(101, excluded=range(101))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    with case.db.connect() as connection:
        connection.execute("update library.local_tracks set title=title||' changed' where album_id=%s and library_id=%s",
            (case.album_ids[-1], case.db.library))
    before = durable_snapshot(case)
    monkeypatch.setattr(evidence, 'capture_artwork_review', forbidden)
    with observe(case) as trace:
        assert_error(lambda: execute(case, command), 'invalid_or_stale_review', 409)
    assert trace['steps'] == [] and durable_snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('step', [name for name, _ in STEPS])
@POSIX_CAPTURE
def test_each_successful_included_checkpoint_rolls_back_the_entire_publication(c2_case, kind, step):
    case = c2_case.build(2, same_pixels=True)
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    before = durable_snapshot(case)
    hit = []
    def fail(connection, sql, params, trace):
        if trace['steps'] and trace['steps'][-1] == step and not hit:
            hit.append(step)
            raise RuntimeError('deliberate post-' + step + ' failure')
    with observe(case, after=fail):
        with pytest.raises(RuntimeError, match='deliberate post-' + step + ' failure'):
            execute(case, command)
    assert hit == [step]
    assert durable_snapshot(case) == before
    assert preparation_header(case, state['preparation_ref'])['state'] == 'ready'


@pytest.mark.parametrize('kind', KINDS)
def test_policy_denial_after_consume_and_immediate_finalizer_rolls_everything_back(c2_case, kind):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    before = durable_snapshot(case)
    drained = []
    def after(connection, sql, params, trace):
        if sql == 'set constraints app.artwork_publication_finalize immediate':
            drained.append(True)
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not drained)
    with observe(case, after=after) as trace:
        assert_error(lambda: execute(case, command, constraints=constraints), 'forbidden', 403)
    assert drained == [True] and trace['steps'][-2:] == ['consume', 'finalizer']
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('deadline_kind', ['preparation', 'held_session'])
def test_real_time_after_finalizer_and_slow_policy_cannot_escape_final_exit(c2_case, deadline_kind, record_property):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, 'saved')
    # Shorten only this synthetic fixture's original deadline before review.
    # No deadline is extended, no SQL time/clock is replaced, no sleep is skipped.
    with case.db.connect() as connection:
        if deadline_kind == 'preparation':
            deadline = connection.execute("""with t as (select clock_timestamp()+interval '15 seconds' as expiry)
                update app.album_top_artwork_preparations set created_at=t.expiry-interval '60 minutes',
                    expires_at=t.expiry from t where ref=%s returning expires_at""",
                (state['preparation_ref'],)).fetchone()['expires_at']
        else:
            deadline = connection.execute("""update app.account_sessions
                set idle_expires_at=clock_timestamp()+interval '15 seconds' where id=%s returning idle_expires_at""",
                (case.db.owner.session_id,)).fetchone()['idle_expires_at']
    _, command = review_command(case, state, 'saved', payload)
    before = durable_snapshot(case)
    drained, waited = [], []
    def after(connection, sql, params, trace):
        if sql == 'set constraints app.artwork_publication_finalize immediate':
            drained.append(connection)
    def constraints(context):
        if drained and not waited:
            now = drained[0].execute('select clock_timestamp() as now').fetchone()['now']
            assert now < deadline, 'Fixture did not reach the intended post-finalizer wait before expiry'
            delay = (deadline - now).total_seconds() + 0.05
            assert 0 < delay <= 15.05
            waited.append(delay)
            sleep(delay)
        return PolicyEvaluationConstraints()
    with observe(case, after=after):
        assert_error(lambda: execute(case, command, constraints=constraints),
            'artwork_preparation_unavailable' if deadline_kind == 'preparation' else 'forbidden',
            409 if deadline_kind == 'preparation' else 403)
    assert len(drained) == len(waited) == 1
    assert durable_snapshot(case) == before
    record_property('c2_real_' + deadline_kind + '_wait_seconds', waited[0])


@pytest.mark.parametrize('resource', ['metadata_root', 'artwork_root', 'artwork_album'])
@POSIX_CAPTURE
def test_retained_replay_uses_current_exact_metadata_and_artwork_scopes(c2_case, resource):
    case = c2_case.build(1)
    state, payload = ready(case, 'draft')
    _, command = review_command(case, state, 'draft', payload)
    execute(case, command)
    before = durable_snapshot(case)
    observed = []
    def constraints(context):
        if context.resource is None:
            return PolicyEvaluationConstraints()
        target = context.resource
        observed.append((context.action, target.resource_kind, target.resource_ref))
        denied = ((resource == 'metadata_root' and target.resource_kind == 'library_root'
                   and target.resource_ref == str(case.metadata_root)) or
                  (resource == 'artwork_root' and target.resource_kind == 'library_root'
                   and target.resource_ref == str(case.artwork_root)) or
                  (resource == 'artwork_album' and context.action == foundation.ARTWORK
                   and target.resource_kind == 'album' and target.resource_ref == str(case.album_ids[0])))
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    assert_error(lambda: execute(case, command, key=None, constraints=constraints), 'forbidden', 403)
    assert durable_snapshot(case) == before
    assert any(kind == ('album' if resource == 'artwork_album' else 'library_root')
               and ref == str(case.album_ids[0] if resource == 'artwork_album' else
                              case.artwork_root if resource == 'artwork_root' else case.metadata_root)
               for _, kind, ref in observed)


@pytest.mark.parametrize('kind', KINDS)
def test_excluded_metadata_root_browse_is_required_without_artwork_scope(c2_case, monkeypatch, kind):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    trap_pixels(monkeypatch, all_observation=True)
    before = durable_snapshot(case)
    assert_error(lambda: execute(case, command, constraints=foundation.deny_resource('library_root', case.metadata_root)),
        'forbidden', 403)
    assert durable_snapshot(case) == before
    # Denying the unselected artwork root must not mask the metadata allow or
    # force any image-root inventory/probe. Complete real metadata is published.
    with observe(case) as trace:
        result = execute(case, command, constraints=foundation.deny_resource('library_root', case.artwork_root))
    assert_committed(case, state, command, result, trace, included=0)


@pytest.mark.parametrize('same_key', [False, True])
def test_concurrent_real_requests_commit_once_and_preserve_exact_replay(c2_case, same_key):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, 'saved')
    _, first = review_command(case, state, 'saved', payload)
    second = first if same_key else changed(first, request_key=str(uuid4()))
    start = Barrier(2, timeout=10)
    def run(command):
        start.wait()
        try:
            return execute(case, command)
        except AlbumTopError as error:
            return error
    # Each real connection already has the foundation's 5s lock/20s statement
    # bounds. No fake serialization, sleeps or receipt injection are involved.
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, command) for command in (first, second)]
        results = [future.result(timeout=30) for future in futures]
    successes = [result for result in results if isinstance(result, dict)]
    if same_key:
        assert len(successes) == 2 and successes[0] == successes[1]
    else:
        assert len(successes) == 1
        errors = [result for result in results if isinstance(result, AlbumTopError)]
        assert len(errors) == 1 and errors[0].code == 'revision_conflict' and errors[0].status_code == 409
    snapshot = durable_snapshot(case)
    assert len(snapshot['album_list_publications']) == 1
    assert len(snapshot['album_top_artwork_publication_consumptions']) == 1
    assert sum(str(row['request_key']) in {first.request_key, second.request_key}
               for row in snapshot['album_list_operations']) == 1
    assert_staging_budget(case, 0, 0, 0)


@pytest.mark.parametrize('typed', [False, True])
@POSIX_CAPTURE
def test_active_v2_save_requires_fresh_consent_and_excluded_replacement_is_explicit(c2_case, monkeypatch, typed):
    case = c2_case.build(1)
    state, payload = ready(case, 'saved')
    _, first = review_command(case, state, 'saved', payload)
    case.top = execute(case, first)
    before = durable_snapshot(case)
    if typed:
        rows = draft_command(case)['rows']
        body = {'item_selections': [row['selection'] for row in rows]}
    else:
        body = {'items': first.data['items']}
    ordinary = case.db.command('save', case.top, title='No fresh consent', **body)
    trap_pixels(monkeypatch)
    assert_error(lambda: case.db.service.execute(case.db.context(), ordinary, context_ref=CONTEXT),
        'artwork_review_required', 409)
    assert durable_snapshot(case) == before
    # A fresh all-excluded review is an intentional image drop, preserving the
    # same local member and retaining the older publication independently.
    case.items = [{**row, 'include_artwork': False} for row in case.items]
    payload = {**case.payload, 'revision': case.top['revision'], 'request_key': str(uuid4()), 'items': case.items}
    state, payload = ready(case, 'saved', payload=payload)
    _, command = review_command(case, state, 'saved', payload, action='save')
    with observe(case) as trace:
        result = execute(case, command)
    assert_committed(case, state, command, result, trace, included=0)
    snapshot = durable_snapshot(case)
    assert len(snapshot['album_list_publications']) == 2
    assert len(snapshot['album_top_artwork_publication_rows']) == 2
    assert sum(row['included'] for row in snapshot['album_top_artwork_publication_rows']) == 1
    assert result['publication']['share_ref'] == case.top['publication']['share_ref']


def remote_existing(case, storage):
    """Real pending acquisition -> existing mixed Save, with synthetic provider facts only."""
    pending = storage.pending(case.top)
    storage.mapping(pending, case.items[0]['album_ref'])
    selection = {'kind': 'existing', 'item_ref': case.items[0]['item_ref'],
        'album_ref': case.items[0]['album_ref'], 'source': {
            'kind': 'remote_acquisition', 'acquisition_ref': pending['acquisition_ref'],
            'evidence_version': pending['evidence_version']}}
    command = case.db.command('save', case.top, item_selections=[selection])
    case.top = case.db.service.execute(case.db.context(), command, context_ref=CONTEXT)
    with case.db.connect() as connection:
        bridge = connection.execute('select * from app.album_list_item_remote_sources where top_ref=%s',
            (case.top['top_ref'],)).fetchone()
        assert bridge is not None and str(bridge['item_ref']) == case.items[0]['item_ref']
    return bridge


@pytest.mark.parametrize('kind', KINDS)
def test_remote_to_local_replacement_clears_exact_bridge_after_c1_admission(c2_remote_case, kind):
    case, storage = c2_remote_case
    case.build(1, excluded=(0,))
    bridge = remote_existing(case, storage)
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    calls = len(storage.remote.calls)
    with observe(case) as trace:
        result = execute(case, command)
    assert len(storage.remote.calls) == calls
    assert_committed(case, state, command, result, trace, included=0)
    admit = next(i for i, sql in enumerate(trace['sql']) if sql.startswith('select app.admit_top_artwork_publication('))
    clear = next(i for i, sql in enumerate(trace['sql']) if 'app.clear_top_remote_source_for_local(' in sql)
    apply = next(i for i, sql in enumerate(trace['sql']) if sql.startswith('delete from app.album_list_items '))
    assert admit < clear < apply
    with case.db.connect() as connection:
        assert connection.execute('select 1 from app.album_list_item_remote_sources where top_ref=%s',
            (case.top['top_ref'],)).fetchone() is None
        assert connection.execute('select 1 from app.album_top_remote_admissions where ref=%s',
            (bridge['admission_ref'],)).fetchone() is not None
    assert str(publication_rows(case, result)[1][0]['item_ref']) == case.items[0]['item_ref']


def test_later_working_remote_member_does_not_change_retained_v2_replay(c2_remote_case, monkeypatch):
    case, storage = c2_remote_case
    case.build(1, excluded=(0,))
    state, payload = ready(case, 'saved')
    _, command = review_command(case, state, 'saved', payload)
    result = execute(case, command)
    case.top = result
    pending = storage.pending(case.top)
    storage.mapping(pending, case.db.album_refs[1])
    # Add changes working membership without republishing the sealed version.
    add = case.db.command('add', case.top, selections=[{'kind': 'remote_acquisition',
        'acquisition_ref': pending['acquisition_ref'], 'evidence_version': pending['evidence_version']}])
    case.top = case.db.service.execute(case.db.context(), add, context_ref=CONTEXT)
    with case.db.connect() as connection:
        refs = connection.execute('select catalog_ref from app.album_list_items where top_ref=%s',
            (case.top['top_ref'],)).fetchall()
        for row in refs:
            if str(row['catalog_ref']) not in case.db.album_refs:
                case.db.album_refs.append(str(row['catalog_ref']))
        assert connection.execute('select 1 from app.album_list_item_remote_sources where top_ref=%s',
            (case.top['top_ref'],)).fetchone() is not None
    before = durable_snapshot(case)
    calls = len(storage.remote.calls)
    monkeypatch.setattr(remote_membership, 'bindings', forbidden)
    monkeypatch.setattr(remote_membership, 'require_context', forbidden)
    monkeypatch.setattr(TopArtworkPreparationService, '__init__', forbidden)
    assert execute(case, command, key=None) == result
    assert durable_snapshot(case) == before and len(storage.remote.calls) == calls


@pytest.mark.parametrize('kind', KINDS)
def test_consumed_start_namespace_precedes_old_revision_and_source_discovery(c2_case, monkeypatch, kind):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    result = execute(case, command)
    before = durable_snapshot(case)
    monkeypatch.setattr(evidence, 'selection_source', forbidden)
    monkeypatch.setattr(evidence, 'artwork_admission_page', forbidden)
    def restart(body):
        if kind == 'saved':
            return case.start(payload=body)
        return case.service.start_draft(case.db.context(), top_ref=case.top['top_ref'],
            payload=body, context_ref=CONTEXT)
    assert_error(lambda: restart(payload), 'artwork_preparation_consumed', 409)
    assert_error(lambda: restart({**payload, 'request_key': str(uuid4())}), 'revision_conflict', 409)
    assert durable_snapshot(case) == before
    assert result['revision'] != payload['revision']


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('change', ['context', 'original_session', 'preparation', 'preparation_revision'])
def test_fresh_unlanded_consent_cannot_cross_private_preparation_scope(c2_case, kind, change):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    descriptor = deepcopy(command.data['artwork_publication'])
    actor = None
    if change == 'context':
        descriptor['context_ref'] = 'b' * 64
    elif change == 'original_session':
        actor = new_session(case.db, case.db.owner)
    elif change == 'preparation':
        descriptor['preparation_ref'] = str(uuid4())
    else:
        descriptor['preparation_revision'] = str(int(descriptor['preparation_revision']) + 1)
    command = changed(command, artwork_publication=descriptor)
    before = durable_snapshot(case)
    with observe(case) as trace:
        assert_error(lambda: execute(case, command, actor=actor), 'artwork_preparation_unavailable', 409)
    assert not trace['steps'] and durable_snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('change', ['metadata', 'cover', 'cleanup'])
@POSIX_CAPTURE
def test_outside_observation_gap_rechecks_fresh_complete_s_and_cleanup(c2_case, monkeypatch, kind, change):
    case = c2_case.build(1)
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    original = TopArtworkPreparationService._draft_probe
    changed_state = []
    def probed(snapshot):
        result = original(snapshot)
        assert not changed_state
        if change == 'cover':
            path = foundation.png_file(case.artwork_path / 'replacement.png', 91)
            with case.db.connect() as connection:
                connection.execute('update library.local_albums set cover_path=%s where id=%s',
                    (str(path), case.album_ids[0]))
        elif change == 'metadata':
            with case.db.connect() as connection:
                connection.execute("update library.local_tracks set title=title||' changed' where library_id=%s and album_id=%s",
                    (case.db.library, case.album_ids[0]))
        else:
            # Real retirement and existing bounded cleanup run while the
            # publishing owner has released all authority transactions.
            with case.db.connect() as connection:
                connection.execute("""update app.album_top_artwork_preparations set state='cancelled',
                    lease_ref=null,lease_expires_at=null,batch_request_key=null,
                    batch_from_revision=null,batch_items=null where ref=%s""", (state['preparation_ref'],))
            reclaimed = case.service.cleanup(case.db.context(), top_ref=case.top['top_ref'],
                top_revision_value=case.top['revision'], context_ref=CONTEXT)
            assert reclaimed['items_deleted'] == 1
            assert reclaimed['preparations_deleted'] == 0 and reclaimed['tombstones_retained'] == 1
        changed_state.append(durable_snapshot(case))
        return result
    monkeypatch.setattr(TopArtworkPreparationService, '_draft_probe', staticmethod(probed))
    with observe(case) as trace:
        assert_error(lambda: execute(case, command),
            'artwork_preparation_unavailable' if change == 'cleanup' else 'artwork_source_changed', 409)
    assert len(changed_state) == 1 and durable_snapshot(case) == changed_state[0]
    assert trace['steps'] == []


@pytest.mark.parametrize('action', ['save', 'enable_external'])
def test_ordinary_v1_metadata_publication_keeps_existing_behavior_and_no_image_io(c2_case, monkeypatch, action):
    case = c2_case.build(1, excluded=(0,))
    items = [{key: value for key, value in case.items[0].items() if key != 'include_artwork'}]
    trap_pixels(monkeypatch, all_observation=True)
    monkeypatch.setattr(artwork_publication, 'save', forbidden)
    def legacy(top, action):
        preview = case.db.service.publication_preview(case.db.context(), top_ref=top['top_ref'],
            payload={'revision': top['revision'], 'items': items})
        command = case.db.command(action, top, **HEADER, items=items, evidence_revision=preview['evidence_revision'])
        return case.db.service.execute(case.db.context(), command), command
    first, command = legacy(case.top, 'enable_external')
    result = first if action == 'enable_external' else legacy(first, 'save')[0]
    assert case.db.service.execute(case.db.context(), command) == first
    with case.db.connect() as connection:
        rows = connection.execute('select contract_version from app.album_list_publications where top_ref=%s',
            (case.top['top_ref'],)).fetchall()
        assert len(rows) == (1 if action == 'enable_external' else 2)
        assert all(row['contract_version'] == 1 for row in rows)
        assert connection.execute('select 1 from app.album_top_artwork_publication_lineage where top_ref=%s',
            (case.top['top_ref'],)).fetchone() is None
    assert result['publication']['state'] == 'enabled'


@pytest.mark.parametrize('change', ['revision', 'revoked'])
def test_actual_link_binding_change_isolated_from_top_revision_rejects_old_intent(c2_case, change):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, 'saved')
    _, first = review_command(case, state, 'saved', payload)
    case.top = execute(case, first)
    state, payload = ready(case, 'saved')
    _, command = review_command(case, state, 'saved', payload, action='save')
    # Deliberate trusted-writer fixture mutation of real mutable link rows.
    # Normal owner operations also increment Top revision and would be rejected
    # earlier. Holding N fixed here isolates the independent consent link fence;
    # no authority, token, publication row, SQL result or provenance is faked.
    with case.db.connect() as connection:
        if change == 'revision':
            connection.execute('update app.shared_links set link_revision=link_revision+1 where top_ref=%s',
                (case.top['top_ref'],))
        else:
            connection.execute("""update app.shared_links set state='revoked',active_publication_ref=null,
                link_revision=link_revision+1,revoked_at=clock_timestamp() where top_ref=%s""",
                (case.top['top_ref'],))
        assert connection.execute('select revision from app.album_lists where ref=%s',
            (case.top['top_ref'],)).fetchone()['revision'] == int(command.data['revision'])
    before = durable_snapshot(case)
    with observe(case) as trace:
        assert_error(lambda: execute(case, command), 'invalid_or_stale_review', 409)
    assert trace['steps'] == [] and durable_snapshot(case) == before


@pytest.mark.parametrize('change', ['foreign_actor', 'deleted_top', 'disabled_owner', 'revoked_session'])
def test_landed_receipt_still_requires_current_nondisclosing_authority(c2_case, change):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, 'saved')
    _, command = review_command(case, state, 'saved', payload)
    result = execute(case, command)
    actor = None
    if change == 'foreign_actor':
        actor = member(case.db)
    elif change == 'deleted_top':
        case.db.service.execute(case.db.context(), case.db.command('delete', result))
    else:
        with case.db.connect() as connection:
            if change == 'disabled_owner':
                connection.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s',
                    (case.db.owner.account_id,))
            else:
                connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
                    (case.db.owner.session_id,))
    before = durable_snapshot(case)
    # Foreign actor owns no receipt under this key. The missing server key is
    # checked after their own current authority, before discovering our Top.
    expected = ('review_key_unavailable', 503) if change == 'foreign_actor' else (
        ('top_unavailable', 404) if change == 'deleted_top' else ('forbidden', 403))
    assert_error(lambda: execute(case, command, actor=actor, key=None), *expected)
    if change == 'foreign_actor':
        assert_error(lambda: execute(case, command, actor=actor), 'top_unavailable', 404)
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
def test_receipt_serialization_failure_after_consume_still_rolls_back(c2_case, monkeypatch, kind):
    case = c2_case.build(1, excluded=(0,))
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    before = durable_snapshot(case)
    original = artwork_publication.review._json_size
    hit = []
    def bounded(value, limit):
        if limit == 16384 and type(value) is dict and 'publication' in value:
            hit.append(True)
            raise RuntimeError('deliberate bounded receipt failure')
        return original(value, limit)
    monkeypatch.setattr(artwork_publication.review, '_json_size', bounded)
    with observe(case) as trace:
        with pytest.raises(RuntimeError, match='deliberate bounded receipt failure'):
            execute(case, command)
    assert hit == [True] and trace['steps'][-2:] == ['consume', 'finalizer']
    assert durable_snapshot(case) == before


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('scope', ['artwork_album', 'artwork_root'])
@POSIX_CAPTURE
def test_included_compact_final_fence_rechecks_exact_artwork_scope_after_consume(c2_case, kind, scope):
    case = c2_case.build(1)
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload)
    before = durable_snapshot(case)
    drained, denied = [], []
    def after(connection, sql, params, trace):
        if sql == 'set constraints app.artwork_publication_finalize immediate':
            drained.append(True)
    def constraints(context):
        # Permit earlier A1/A2 checks and the final durable-owner eligibility
        # context, whose session is None. Deny only the held requester's final
        # compact _draft_finish scope after actual consume/finalizer success.
        target = context.resource
        deny = bool(drained and context.actor.session_id == case.db.owner.session_id and target is not None and (
            (scope == 'artwork_album' and context.action == foundation.ARTWORK
             and target.resource_kind == 'album' and target.resource_ref == str(case.album_ids[0])) or
            (scope == 'artwork_root' and context.action == foundation.BROWSE
             and target.resource_kind == 'library_root' and target.resource_ref == str(case.artwork_root))))
        if deny:
            denied.append((context.actor.session_id, context.action, target.resource_kind, target.resource_ref))
        return PolicyEvaluationConstraints(request_origin_allowed=not deny)
    with observe(case, after=after) as trace:
        assert_error(lambda: execute(case, command, constraints=constraints), 'forbidden', 403)
    expected = (foundation.ARTWORK, 'album', str(case.album_ids[0])) if scope == 'artwork_album' else (
        foundation.BROWSE, 'library_root', str(case.artwork_root))
    assert drained == [True] and denied == [(case.db.owner.session_id, *expected)]
    assert trace['steps'][-2:] == ['consume', 'finalizer']
    assert durable_snapshot(case) == before
    assert preparation_header(case, state['preparation_ref'])['state'] == 'ready'
