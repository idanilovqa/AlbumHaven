"""D reads over genuine accepted C2 publication, policy, and runtime SQL.

Source-authored, NOT RUN. The real C2 saved/draft review and execute owners mint
all v2 lineage, retained rows, consent, sanitized PNGs and consumption. No fake
proof, capability result, SQL row, publishing receipt or authorization is used.
The C1 publication_case owns retained-aware teardown. Explicit corruption below
uses the admitted non-superuser migrator, disables only the named immutability
trigger in a transaction, and restores it before commit. Runtime grants and all
foreign keys/checks remain untouched. Runtime readers never decode an image.
"""
import asyncio
from contextlib import contextmanager
from copy import copy
from dataclasses import replace
from hashlib import sha256
import json
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

from music_app.routes import public_album_tops_asgi as routes
from music_app.services import public_album_tops_postgres as reader
from music_app.services.owned_album_tops import ACCESS, BROWSE, AlbumTopError
from music_app.services.capabilities import grant_keys_for_action
from music_app.services.current_actor import CapabilityGrant
from music_app.services.policy import RequestOrigin, ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_top_artwork_publication_retention_postgres import publication_case, POSIX_CAPTURE, runtime
# Binding: C2 r2 helper SHA256 309a6cee2523e26815310668f4786c1751f9416a2a6bfe7512d29331c6a268aa.
from tests.py.test_top_artwork_publication_postgres import (
    c2_case, ready, review_command, execute, publication_rows, trap_pixels, CONTEXT, HEADER,
)
from tests.py.test_public_album_top_http import app_for, exchange
from tests.py.test_public_album_top_html import BROWSER, Page
from tests.py.test_album_top_collaboration_postgres import member

GUEST_SECRET = 'synthetic-d-guest-pagination-key-only'
ARTWORK = 'library.artwork.read'


def effective_policy(case, action, *, resource=None, constraints=None):
    """Evaluate actual persisted grants; never install this context as authority."""
    with case.db.connect() as connection:
        rows = connection.execute('''select capability_key,scope_kind,scope_id from app.capabilities
            where account_id=%s and revoked_at is null order by id''',
            (case.db.owner.account_id,)).fetchall()
    actor = replace(case.db.owner, capability_grants=tuple(
        CapabilityGrant(row['capability_key'], row['scope_kind'], row['scope_id']) for row in rows))
    context = replace(case.db.context(actor), action=action,
        resource=resource or ResourceScope('album_top', case.top['top_ref']))
    narrowed = constraints(context) if constraints else None
    return PolicyEvaluator().evaluate(context, constraints=narrowed).decision.allowed


def revoke_effective_action(case, action):
    """Remove all current aliases, then prove the intended effective denial."""
    assert effective_policy(case, action) is True
    keys = sorted(grant_keys_for_action(action))
    with case.db.connect() as connection:
        connection.execute('''update app.capabilities set revoked_at=clock_timestamp()
            where account_id=%s and capability_key=any(%s) and revoked_at is null''',
            (case.db.owner.account_id, keys))
    assert effective_policy(case, action) is False


def publish(case, *, action='enable_external', kind='saved'):
    state, payload = ready(case, kind)
    _, command = review_command(case, state, kind, payload, action=action)
    case.top = execute(case, command)
    return state, case.top


def service_for(case):
    return reader.PostgresPublicAlbumTopsService(case.db.service._config, connect=case.db.service._connect)


def subjects(case, row=None):
    result = {'share_ref': case.top['publication']['share_ref'],
              'publication_ref': case.top['publication']['publication_ref'],
              'request_origin': RequestOrigin('network', case.db.service._config['ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN'])}
    if row is not None: result.update(item_ref=str(row['item_ref']), asset_ref=str(row['asset_ref']))
    return result


def metadata(case, service, **options):
    target = subjects(case); target.pop('publication_ref')
    return service.read_guest(**{**target, 'cursor_secret': GUEST_SECRET, **options})


def image(case, service, row, **options):
    return service.read_guest_artwork(**{**subjects(case, row), 'head_only': False, **options})


def admit(case, service, row=None, **options):
    return service.recheck_guest_response(**{**subjects(case, row), 'publication_contract_version': 2, **options})


def png_path(case, row):
    target = subjects(case, row)
    return (f"/public/album-tops/{target['share_ref']}/publications/{target['publication_ref']}"
            f"/items/{target['item_ref']}/artwork/{target['asset_ref']}.png")


def app_and_host(case, service):
    app = app_for(service); app.state.config = case.db.service._config
    return app, urlsplit(case.db.service._config['ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN']).netloc


@contextmanager
def ledger(case, service):
    """Transparent real runtime connection wrapper; no replacement SQL values."""
    connect = service._connect
    trace = {'sql': [], 'connections': 0, 'bodies': 0, 'headers': 0, 'rows': 0}
    class Connection:
        def __init__(self, real): self.real = real
        def __getattr__(self, key): return getattr(self.real, key)
        def execute(self, statement, params=None):
            text = ' '.join(str(statement).lower().split())
            trace['sql'].append(text)
            for forbidden in ('source_stamp', 'acquisition_stamp', 'from app.album_list_items ',
                              'library.local_track_files', 'library.local_tracks',
                              'from app.album_top_artwork_preparations', 'from app.album_top_artwork_preparation_items'):
                assert forbidden not in text, f'Guest read reached private recapture material: {forbidden}'
            result = self.real.execute(statement, params)
            # Must follow, never precede, the owner's isolation-level statement.
            if text == 'set transaction isolation level read committed':
                assert_runtime_role(self.real, case.db)
            if statement == reader._ASSET_GET: trace['bodies'] += 1
            if statement == reader._ASSET_HEAD: trace['headers'] += 1
            return result
    @contextmanager
    def connected(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            trace['connections'] += 1
            yield Connection(connection)
    service._connect = connected
    try: yield trace
    finally: service._connect = connect


@pytest.fixture
def published_artwork(c2_case):
    case = c2_case.build(2)
    state, _ = publish(case)
    rows = publication_rows(case, case.top)[2]
    assert len(rows) == 2 and all(row['included'] for row in rows)
    return case, state, rows, service_for(case)


@POSIX_CAPTURE
def test_real_c2_retained_png_and_metadata_survive_consumption_session_and_files(published_artwork, monkeypatch):
    case, state, rows, service = published_artwork
    assert case.metadata_root != case.artwork_root
    with case.db.connect() as connection:
        for table in ('album_top_artwork_preparations', 'album_top_artwork_preparation_items', 'album_top_artwork_draft_items'):
            assert connection.execute(f'select 1 from app.{table} where owner_account_id=%s',
                                      (case.db.owner.account_id,)).fetchone() is None
        expected = connection.execute('select png,content_digest,byte_length from app.album_top_artwork_assets where ref=%s',
                                      (rows[0]['asset_ref'],)).fetchone()
    # A genuine later working edit leaves this immutable publication unchanged.
    working = case.db.service.execute(case.db.context(), case.db.command('remove', case.top,
        item_refs=[str(rows[0]['item_ref'])]))
    case.top = {**case.top, **working}
    for path in case.cover_paths: path.unlink()
    with case.db.connect() as connection:
        connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
                           (case.db.owner.session_id,))
    trap_pixels(monkeypatch, all_observation=True)
    with ledger(case, service) as trace:
        value = metadata(case, service, limit=1)
        item = metadata(case, service, item_ref=str(rows[0]['item_ref']))
        actual = image(case, service, rows[0])
        head = image(case, service, rows[0], head_only=True)
        assert admit(case, service, rows[0]) is None
    assert value['publication_contract_version'] == item['publication_contract_version'] == 2
    assert value['items'][0]['item_ref'] == item['item']['item_ref'] == str(rows[0]['item_ref'])
    assert actual['body'] == bytes(expected['png']) and actual['content_length'] == expected['byte_length']
    assert sha256(actual['body']).hexdigest() == expected['content_digest']
    assert head == {'content_type': 'image/png', 'content_length': actual['content_length'], 'body': b''}
    assert trace['bodies'] == 1 and trace['headers'] == 2 and trace['connections'] == 5
    serialized = json.dumps(value) + json.dumps(item)
    for private in ('source_stamp', 'acquisition_stamp', 'artwork_root_id', 'local_album_id',
                    'preparation_ref', 'review_witness', str(case.directory)):
        assert private not in serialized


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('count', [0, 1, 100, 101, 250, 5000])
def test_actual_empty_and_all_excluded_v2_pagination_remains_bounded(c2_case, kind, count, monkeypatch):
    case = c2_case.build(count, excluded=range(count)); publish(case, kind=kind)
    service = service_for(case); trap_pixels(monkeypatch, all_observation=True)
    with ledger(case, service) as trace:
        value = metadata(case, service, limit=100)
        first_queries = len(trace['sql'])
        assert value['publication_contract_version'] == 2
        assert len(value['items']) == min(count, 100)
        assert all(row['artwork_ref'] is None for row in value['items'])
        assert bool(value['next_cursor']) is (count > 100)
        assert admit(case, service) is None
    assert trace['bodies'] == trace['headers'] == 0
    # Source-selected upper bound, deliberately not a latency or RSS claim.
    # SQL scope reconstruction is set-based; there is no statement per member.
    assert first_queries <= 32 and len(trace['sql']) <= 64
    if count > 100:
        second = metadata(case, service, limit=100, cursor=value['next_cursor'])
        assert second['items'][0]['curator_position'] == 101
    with case.db.connect() as connection:
        assert connection.execute('select 1 from app.album_top_artwork_publication_consumptions where publication_ref=%s',
                                  (subjects(case)['publication_ref'],)).fetchone() is not None


@POSIX_CAPTURE
@pytest.mark.parametrize('field', ['share_ref', 'publication_ref', 'item_ref', 'asset_ref'])
@pytest.mark.parametrize('head_only', [False, True])
def test_each_requested_identity_substitution_is_unavailable(published_artwork, field, head_only):
    case, _, rows, service = published_artwork
    assert_error(lambda: image(case, service, rows[0], **{field: str(uuid4()), 'head_only': head_only}), 'unavailable', 404)
    if field in ('item_ref', 'asset_ref'):
        assert_error(lambda: image(case, service, rows[0], **{field: str(rows[1][field]), 'head_only': head_only}),
                     'unavailable', 404)


@POSIX_CAPTURE
@pytest.mark.parametrize('failure', ['owner', 'membership', 'browse', 'access', 'artwork'])
def test_current_durable_owner_revocation_blocks_every_guest_representation(published_artwork, failure):
    case, _, rows, service = published_artwork
    assert image(case, service, rows[0])['body']
    with case.db.connect() as connection:
        if failure == 'owner':
            connection.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s',
                               (case.db.owner.account_id,))
        elif failure == 'membership':
            connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                               (case.db.owner.account_id, case.db.library))
    if failure in {'browse', 'access', 'artwork'}:
        revoke_effective_action(case, {'browse': BROWSE, 'access': ACCESS, 'artwork': ARTWORK}[failure])
    for action in (lambda: metadata(case, service), lambda: metadata(case, service, item_ref=str(rows[0]['item_ref'])),
                   lambda: image(case, service, rows[0]), lambda: image(case, service, rows[0], head_only=True),
                   lambda: admit(case, service, rows[0])):
        assert_error(action, 'unavailable', 404)


@POSIX_CAPTURE
@pytest.mark.parametrize('scope', ['top_browse', 'top_access', 'metadata_album', 'metadata_source',
                                   'metadata_root', 'artwork_album', 'artwork_root'])
def test_offpage_scoped_deny_is_not_hidden_by_allowed_sibling(published_artwork, scope):
    case, _, rows, service = published_artwork
    observations = []
    target = {'top_browse': (BROWSE, 'album_top', case.top['top_ref']),
              'top_access': (ACCESS, 'album_top', case.top['top_ref']),
              'metadata_album': (BROWSE, 'album', str(case.album_ids[1])),
              'metadata_source': (BROWSE, 'album_metadata_source', case.source_refs[1]),
              'metadata_root': (BROWSE, 'library_root', str(case.metadata_root)),
              'artwork_album': (ARTWORK, 'album', str(case.album_ids[1])),
              'artwork_root': (BROWSE, 'library_root', str(case.artwork_root))}[scope]
    def constraints(context):
        resource = context.resource
        key = (context.action, resource.resource_kind, resource.resource_ref) if resource else None
        observations.append(key)
        return PolicyEvaluationConstraints(request_origin_allowed=key != target)
    for action in (lambda: metadata(case, service, limit=1, constraints=constraints),
                   lambda: metadata(case, service, item_ref=str(rows[0]['item_ref']), constraints=constraints),
                   lambda: image(case, service, rows[0], constraints=constraints),
                   lambda: image(case, service, rows[0], head_only=True, constraints=constraints),
                   lambda: admit(case, service, rows[0], constraints=constraints)):
        assert_error(action, 'unavailable', 404)
    assert target in observations


def test_all_excluded_does_not_require_artwork_grant_or_unselected_root(c2_case):
    case = c2_case.build(2, excluded=(0, 1)); publish(case); service = service_for(case)
    with case.db.connect() as connection:
        connection.execute('update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key=%s',
                           (case.db.owner.account_id, ARTWORK))
    def deny_unused(context):
        resource = context.resource
        denied = resource is not None and resource.resource_kind == 'library_root' and resource.resource_ref == str(case.artwork_root)
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    assert len(metadata(case, service, constraints=deny_unused)['items']) == 2
    assert admit(case, service, constraints=deny_unused) is None


@POSIX_CAPTURE
@pytest.mark.parametrize('change', ['revoke', 'republish'])
def test_old_png_generation_and_cursor_cannot_survive_real_link_change(published_artwork, change):
    case, _, rows, service = published_artwork
    before = subjects(case, rows[0]); page = metadata(case, service, limit=1)
    if change == 'revoke':
        case.top = case.db.service.execute(case.db.context(), case.db.command('revoke_external', case.top))
    else:
        publish(case, action='save')
        assert subjects(case)['share_ref'] == before['share_ref']
        assert subjects(case)['publication_ref'] != before['publication_ref']
    assert_error(lambda: service.read_guest_artwork(**before, head_only=False), 'unavailable', 404)
    assert_error(lambda: service.recheck_guest_response(**before, publication_contract_version=2), 'unavailable', 404)
    assert_error(lambda: metadata(case, service, limit=1, cursor=page['next_cursor']),
                 'invalid_cursor' if change == 'republish' else 'unavailable', 400 if change == 'republish' else 404)


@POSIX_CAPTURE
@pytest.mark.parametrize('representation', ['png', 'json', 'html'])
@pytest.mark.parametrize('change', ['revoke', 'republish', 'policy', 'deployment'])
def test_real_response_construction_gap_requires_fresh_current_admission(published_artwork, monkeypatch, representation, change):
    case, _, rows, service = published_artwork
    app, host = app_and_host(case, service); prepared = []; changed = []
    def alter():
        if changed: return
        changed.append(True)
        if change == 'revoke':
            case.top = case.db.service.execute(case.db.context(), case.db.command('revoke_external', case.top))
        elif change == 'republish': publish(case, action='save')
        elif change == 'policy': revoke_effective_action(case, ARTWORK)
        else: case.db.service._config['ALBUM_HAVEN_PUBLIC_SHARING_ENABLED'] = False
    if representation == 'png':
        original = routes.Response
        def construct(*args, **kwargs):
            response = original(*args, **kwargs); prepared.append(response.body); alter(); return response
        monkeypatch.setattr(routes, 'Response', construct)
    else:
        original = routes._response
        def construct(*args, **kwargs):
            response = original(*args, **kwargs)
            if response.status_code == 200: prepared.append(response.body); alter()
            return response
        monkeypatch.setattr(routes, '_response', construct)
    path = png_path(case, rows[0]) if representation == 'png' else '/public/album-tops/' + subjects(case)['share_ref']
    status, body, _ = asyncio.run(exchange(app, path=path, host=host,
        headers={'accept': BROWSER if representation == 'html' else 'application/json'}))
    assert status == 404 and len(prepared) == 1 and prepared[0] and changed == [True]
    assert b'Explicit artwork publication' not in body and not body.startswith(b'\x89PNG')
    assert Page(body).payload is None if representation == 'html' else json.loads(body) == {'ok': False, 'error': 'unavailable'}


# The following trusted fixture corruptions isolate reader validation. They do
# not claim that runtime can mutate any retained row; all ordinary immutable
# protections and privileges are unchanged before the reader is called.
CORRUPTIONS = {
    'lineage_count': ('album_top_artwork_publication_lineage', 'row_count=row_count+1'),
    'included_count': ('album_top_artwork_publication_lineage', 'included_count=included_count-1'),
    'consumption_digest': ('album_top_artwork_publication_consumptions', "seal_digest=repeat('0',64)"),
    'consumption_count': ('album_top_artwork_publication_consumptions', 'removed_items=removed_items-1'),
    'consumption_proof_budget': ('album_top_artwork_publication_consumptions', 'released_proof_bytes=released_proof_bytes+1'),
    'consumption_deadline': ('album_top_artwork_publication_consumptions', "consumed_at=consumed_at+interval '2 hours'"),
    'mapping_local_album': ('album_top_artwork_publication_rows', 'local_album_id=local_album_id+1000000'),
    'mapping_metadata_root': ('album_top_artwork_publication_rows', 'metadata_root_id=metadata_root_id+1000000'),
    'mapping_metadata_source': ('album_top_artwork_publication_rows', 'metadata_source_ref=%s'),
    'mapping_original_position': ('album_top_artwork_publication_rows', 'original_position=original_position+1000000'),
    'mapping_presentation': ('album_top_artwork_publication_rows', 'presentation_ref=%s'),
    'mapping_catalog': ('album_top_artwork_publication_rows', 'catalog_ref=%s'),
}


@POSIX_CAPTURE
@pytest.mark.parametrize('failure', list(CORRUPTIONS))
def test_retained_attestation_or_offpage_mapping_corruption_fails_every_reader(published_artwork, failure):
    case, _, rows, service = published_artwork
    table, expression = CORRUPTIONS[failure]
    with case.db.connect() as connection:
        assert connection.execute('select rolsuper from pg_roles where rolname=current_user').fetchone()['rolsuper'] is False
        connection.execute(f'alter table app.{table} disable trigger artwork_publication_immutable')
        parameters = ([str(uuid4())] if '%s' in expression else []) + [subjects(case)['publication_ref']]
        suffix = ' and curator_position=2' if table.endswith('_rows') else ''
        connection.execute(f'update app.{table} set {expression} where publication_ref=%s{suffix}', parameters)
        connection.execute(f'alter table app.{table} enable trigger artwork_publication_immutable')
    for action in (lambda: metadata(case, service, limit=1),
                   lambda: metadata(case, service, item_ref=str(rows[0]['item_ref'])),
                   lambda: image(case, service, rows[0]), lambda: image(case, service, rows[0], head_only=True),
                   lambda: admit(case, service, rows[0])):
        assert_error(action, 'unavailable', 404)


@POSIX_CAPTURE
def test_real_get_and_final_admission_transfer_one_bounded_body_head_transfers_none(published_artwork, monkeypatch):
    case, _, rows, service = published_artwork; trap_pixels(monkeypatch, all_observation=True)
    app, host = app_and_host(case, service)
    with ledger(case, service) as trace:
        status, body, headers = asyncio.run(exchange(app, path=png_path(case, rows[0]), host=host,
            headers={'range': 'bytes=0-1', 'if-none-match': '*'}))
        assert status == 200 and body.startswith(b'\x89PNG')
        assert trace['bodies'] == 1 and trace['headers'] == 1 and trace['connections'] == 2
        assert b'content-range' not in headers and b'etag' not in headers
    with ledger(case, service) as trace:
        status, head, head_headers = asyncio.run(exchange(app, 'HEAD', png_path(case, rows[0]), host=host))
        assert status == 200 and head == b'' and trace['bodies'] == 0
        assert trace['headers'] == 2 and trace['connections'] == 2
    assert head_headers[b'content-length'] == headers[b'content-length'] == str(len(body)).encode()


def test_real_v1_and_v2_coexist_without_adding_artwork_to_v1(c2_case):
    case = c2_case.build(1, excluded=(0,))
    items = [{key: value for key, value in row.items() if key != 'include_artwork'} for row in case.items]
    preview = case.db.service.publication_preview(case.db.context(), top_ref=case.top['top_ref'],
        payload={'revision': case.top['revision'], 'items': items})
    case.top = case.db.service.execute(case.db.context(), case.db.command('enable_external', case.top,
        **HEADER, items=items, evidence_revision=preview['evidence_revision']))
    old = subjects(case); service = service_for(case)
    legacy = metadata(case, service)
    assert 'publication_contract_version' not in legacy and legacy['items'][0]['artwork_ref'] is None
    publish(case, action='save')
    current = metadata(case, service)
    assert current['publication_contract_version'] == 2 and current['items'][0]['artwork_ref'] is None
    assert old['share_ref'] == subjects(case)['share_ref'] and old['publication_ref'] != current['publication_ref']


@POSIX_CAPTURE
def test_member_v2_reader_keeps_requester_session_and_current_owner_artwork_policy(published_artwork):
    case, _, rows, service = published_artwork
    visitor = member(case.db, grants=('capability.view', BROWSE))
    options = dict(top_ref=case.top['top_ref'], share_ref=subjects(case)['share_ref'], context_ref=CONTEXT,
                   cursor_secret=GUEST_SECRET)
    value = service.read_published(case.db.context(visitor), **options)
    assert value['publication_contract_version'] == 2 and value['items'][0]['artwork_ref'] == str(rows[0]['asset_ref'])
    with case.db.connect() as connection:
        connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s', (visitor.session_id,))
    assert_error(lambda: service.read_published(case.db.context(visitor), **options), 'forbidden', 403)


@POSIX_CAPTURE
@pytest.mark.parametrize('representation', ['top', 'item', 'get', 'head'])
def test_real_final_service_policy_runs_after_completed_result_validation(published_artwork, monkeypatch, representation):
    case, _, rows, service = published_artwork
    validated, observed = [], []
    def constraints(context):
        target = context.resource
        scoped = context.action == ARTWORK and target is not None and target.resource_kind == 'album'
        if scoped: observed.append(bool(validated))
        return PolicyEvaluationConstraints(request_origin_allowed=not (scoped and validated))
    if representation in ('get', 'head'):
        original = reader.snapshot_png
        def completed(*args, **kwargs):
            value = original(*args, **kwargs); validated.append(True); return value
        monkeypatch.setattr(reader, 'snapshot_png', completed)
        action = lambda: image(case, service, rows[0], head_only=representation == 'head', constraints=constraints)
    else:
        original = reader.validate_snapshot_v2
        def completed(*args, **kwargs):
            value = original(*args, **kwargs); validated.append(True); return value
        monkeypatch.setattr(reader, 'validate_snapshot_v2', completed)
        action = lambda: metadata(case, service, item_ref=str(rows[0]['item_ref']) if representation == 'item' else None,
                                  constraints=constraints)
    assert_error(action, 'unavailable', 404)
    assert validated == [True] and False in observed and observed[-1] is True


@POSIX_CAPTURE
def test_foreign_top_asset_is_not_readable_under_another_real_publication(published_artwork):
    case, _, rows, service = published_artwork
    # Allocate a distinct Top/item through the genuine owner over existing
    # source rows. Rebuilding the same Database would duplicate its track keys.
    # Assets are Top-scoped; retained-aware teardown owns both publications.
    other = copy(case)
    other.top, _ = case.db.create(refs=case.catalog_refs[:1])
    other_item = case.db.read(other.top)['items'][0]
    other.items = [{**case.items[0], 'item_ref': other_item['ref']}]
    other.payload = {**case.payload, 'revision': other.top['revision'],
                     'request_key': str(uuid4()), 'items': other.items}
    publish(other); other_row = publication_rows(other, other.top)[2][0]
    assert case.top['top_ref'] != other.top['top_ref']
    assert str(other_row['asset_ref']) != str(rows[0]['asset_ref'])
    assert image(case, service, rows[0])['body']
    assert image(other, service, other_row)['body']
    for changes in ({'asset_ref': str(other_row['asset_ref'])},
                    {'item_ref': str(other_row['item_ref']), 'asset_ref': str(other_row['asset_ref'])},
                    {'publication_ref': subjects(other)['publication_ref'],
                     'item_ref': str(other_row['item_ref']), 'asset_ref': str(other_row['asset_ref'])},
                    {'share_ref': subjects(other)['share_ref']}):
        assert_error(lambda: image(case, service, rows[0], **changes), 'unavailable', 404)
        assert_error(lambda: image(case, service, rows[0], head_only=True, **changes), 'unavailable', 404)


@POSIX_CAPTURE
@pytest.mark.parametrize('version', [1, 2])
def test_private_working_link_keeps_v1_and_v2_top_acl_and_artwork_eligibility(c2_case, version):
    case = c2_case.build(1, excluded=(0,) if version == 1 else ())
    if version == 2:
        publish(case)
    else:
        items = [{key: value for key, value in row.items() if key != 'include_artwork'} for row in case.items]
        preview = case.db.service.publication_preview(case.db.context(), top_ref=case.top['top_ref'],
            payload={'revision': case.top['revision'], 'items': items})
        case.top = case.db.service.execute(case.db.context(), case.db.command('enable_external', case.top,
            **HEADER, items=items, evidence_revision=preview['evidence_revision']))
    share = subjects(case)['share_ref']; service = service_for(case)
    assert case.db.service.resolve_public_link(case.db.context(), share_ref=share) == case.top['top_ref']
    # Even a current authenticated same-library Browser does not gain the
    # private Top's ACL merely by knowing its valid externally shared link.
    visitor = member(case.db, grants=('capability.view', BROWSE))
    assert_error(lambda: case.db.service.resolve_public_link(case.db.context(visitor), share_ref=share),
                 'top_unavailable', 404)
    assert metadata(case, service)['items'][0]['artwork_ref'] is not None if version == 2 else (
        metadata(case, service)['items'][0]['artwork_ref'] is None)
    target = ResourceScope('album', str(case.album_ids[0]))
    def deny_artwork(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            context.action == ARTWORK and context.resource == target))
    # Browse itself aliases ARTWORK, so durable removal cannot independently
    # deny Artwork while preserving the private reader's required Browse.
    assert effective_policy(case, BROWSE, constraints=deny_artwork) is True
    assert effective_policy(case, ARTWORK, resource=target) is True
    assert effective_policy(case, ARTWORK, resource=target, constraints=deny_artwork) is False
    if version == 2:
        assert_error(lambda: case.db.service.resolve_public_link(case.db.context(),
            share_ref=share, constraints=deny_artwork), 'unavailable', 404)
    else:
        assert case.db.service.resolve_public_link(case.db.context(),
            share_ref=share, constraints=deny_artwork) == case.top['top_ref']


@POSIX_CAPTURE
@pytest.mark.parametrize('scope', ['artwork_album', 'artwork_root'])
def test_private_working_link_rechecks_all_retained_artwork_scopes(published_artwork, scope):
    case, _, rows, _ = published_artwork
    assert case.metadata_root != case.artwork_root
    observed = []
    target = (ARTWORK, 'album', str(case.album_ids[1])) if scope == 'artwork_album' else (
        BROWSE, 'library_root', str(case.artwork_root))
    def constraints(context):
        resource = context.resource
        key = (context.action, resource.resource_kind, resource.resource_ref) if resource else None
        observed.append(key)
        return PolicyEvaluationConstraints(request_origin_allowed=key != target)
    assert_error(lambda: case.db.service.resolve_public_link(case.db.context(),
        share_ref=subjects(case)['share_ref'], constraints=constraints), 'unavailable', 404)
    assert target in observed


@POSIX_CAPTURE
def test_real_mismatched_header_and_seal_versions_fail_all_public_reads(published_artwork):
    case, _, rows, service = published_artwork
    # The existing migration owner may maintain this seal table. Runtime has
    # SELECT only. No new grants, dropped constraints, or disabled triggers.
    with case.db.connect() as connection:
        assert connection.execute('select rolsuper from pg_roles where rolname=current_user').fetchone()['rolsuper'] is False
        connection.execute('update app.album_list_publication_seals set seal_contract_version=1 where publication_ref=%s',
                           (subjects(case)['publication_ref'],))
    for action in (lambda: metadata(case, service), lambda: image(case, service, rows[0]),
                   lambda: image(case, service, rows[0], head_only=True), lambda: admit(case, service, rows[0])):
        assert_error(action, 'unavailable', 404)
