"""Pure C2 consent/DTO/mapping contracts; authored source, runtime NOT RUN.

The existing B snapshot fixture is synthetic non-provenance context. No fixture
in this module establishes a captured image, database admission, source authority,
or successful publication. Cursor encryption/MAC, proof parsing/canonicalization,
and all functions under assertion remain genuine. Mapping SQL is only recorded.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from uuid import UUID

import pytest

from music_app.services import album_top_artwork_draft as draft
from music_app.services import album_top_artwork_publication as publication
from music_app.services import album_top_artwork_review as review
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import artwork_proof_codec as codec
from music_app.services import _top_artwork_draft_proof as proof
from music_app.services import social_cursors
from music_app.services.owned_album_tops import AlbumTopError, normalize_top_command
from tests.py.test_top_artwork_review import snapshot, uid
from tests.py.test_artwork_proof_codec import inventory, source, acquisition

SECRET = 'publication-consent-test-only-secret-0123456789'
B_KEYS = {'witness_version', 'metadata_generation', 'metadata_evidence_revision',
          'asset_manifest_digest', 'review_digest', 'token'}
INTENT_KEYS = {'version', 'action', 'link_state', 'link_revision', 'intent_digest', 'token'}
DESCRIPTOR_KEYS = {'version', 'kind', 'preparation_ref', 'preparation_revision',
                   'context_ref', 'review_witness', 'publication_intent'}
MAPPING_KEYS = {'curator_position', 'item_ref', 'original_position',
                'presentation_ref', 'descriptor_witness'}
HEADER = {'title': 'A considered selection', 'description': 'A deliberately reviewed description.'}
ENABLED = {'link_state': 'enabled', 'link_revision': '7'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def fails(code, operation, status=409):
    with pytest.raises(AlbumTopError) as caught:
        operation()
    assert (caught.value.code, caught.value.status_code, str(caught.value)) == (code, status, code)


def synthetic_state(value):
    """Build B's phase-boundary input, not metadata capture or provenance."""
    asset, reviewed, total = review._compact(value, kind=value['kind'],
                                            metadata_evidence_revision='e' * 64)
    items = []
    for row in value['rows']:
        items.append(review._summary(row, {'item': draft.source_item(row), 'metadata': {
            'album_ref': row['catalog_ref'], 'title': 'Synthetic album',
            'artist': 'Synthetic artist', 'year': 2026, 'tracks': [{'title': 'Synthetic track'}]}}))
    return {'kind': value['kind'], 'snapshot_digest': value['digest'],
            'metadata_generation': value['metadata_generation'],
            'metadata_evidence_revision': 'e' * 64, 'asset_manifest_digest': asset,
            'review_digest': reviewed, 'included_count': value['included_count'],
            'total_image_bytes': total, 'items': items}


def issue(value, *, header=None, action='save', link=None):
    return review.finish_publication_review(value, synthetic_state(value), kind=value['kind'],
        cursor_secret=SECRET, header=HEADER if header is None else header,
        action=action, link=ENABLED if link is None else link)


def descriptor(value, response=None):
    response = issue(value) if response is None else response
    header = value['header']
    result = {'version': 2, 'kind': value['kind'], 'preparation_ref': str(header['ref']),
        'preparation_revision': str(header['revision']), 'context_ref': header['context_ref'],
        'review_witness': deepcopy(response['review_witness']),
        'publication_intent': deepcopy(response['publication_intent'])}
    if value['kind'] == 'draft':
        result.update(draft_ref=str(header['draft_ref']), draft_revision=str(header['draft_revision']))
    return result


def payload(value, response=None):
    return {'request_key': uid(900001), 'revision': str(value['header']['top_revision']),
            **HEADER, 'items': [draft.source_item(row) for row in value['rows']],
            'evidence_revision': 'e' * 64, 'artwork_publication': descriptor(value, response)}


def verify(value, consent, *, header=None, action='save', link=None, secret=SECRET):
    return review.verify_publication_intent(value, consent, cursor_secret=secret,
        header=HEADER if header is None else header, action=action,
        link=ENABLED if link is None else link)


def expected_identity(value):
    """Independent explicit B identity order, not the implementation helper."""
    header = value['header']
    return [str(header['library_id']), str(header['owner_account_id']),
            str(header['original_session_id']), header['context_ref'], str(header['top_ref']),
            str(header['top_revision']), str(header['ref']), str(header['revision']),
            str(header['request_generation']), header['expires_at'].isoformat(),
            str(header['draft_ref']) if header['draft_ref'] is not None else None,
            str(header['draft_revision']) if header['draft_revision'] is not None else None,
            header['baseline_digest']]


def expected_intent_scope(value, witness, *, header=None, action='save', link=None):
    header, link = HEADER if header is None else header, ENABLED if link is None else link
    return ['private-top-artwork-publication-intent-v1', 1, value['kind'],
            *expected_identity(value), value['digest'], witness['metadata_generation'],
            witness['metadata_evidence_revision'], witness['asset_manifest_digest'],
            witness['review_digest'], header['title'], header['description'],
            action, link['link_state'], link['link_revision']]


def expected_b_scope(value, witness):
    return ['private-top-artwork-reviewed-metadata-v1', 1, value['kind'],
            *expected_identity(value), value['digest'], witness['metadata_evidence_revision'],
            witness['asset_manifest_digest'], witness['review_digest']]


def explode(*args, **kwargs):
    pytest.fail('invalid or oversized input reached cryptography or aggregate serialization')


@pytest.mark.parametrize('title,description,expected', [
    ('  A title  ', '  exact description  ', {'title': 'A title', 'description': '  exact description  '}),
    ('é水😀', '', {'title': 'é水😀', 'description': ''}),
    ('e\u0301', '"\\é😀', {'title': 'e\u0301', 'description': '"\\é😀'}),
    ('x' * 100, 'y' * 1000, {'title': 'x' * 100, 'description': 'y' * 1000}),
])
def test_publication_header_normalizes_only_title_edges(title, description, expected):
    assert review.publication_header(title, description) == expected


@pytest.mark.parametrize('title,description', [
    (None, ''), (True, ''), ([], ''), ('', ''), ('   ', ''), ('x' * 101, ''),
    ('Title', None), ('Title', True), ('Title', 'x' * 1001), ('Title', '\x00'),
    ('Ti\ntle', ''), ('Ti\rtle', ''), ('Ti\ttle', ''), ('Title', 'line\nline'),
    ('Title', '\x1f'), ('Title', '\x7f'), ('\ud800', ''), ('Title', '\udfff'),
])
def test_publication_header_rejects_bad_types_controls_and_lengths(title, description):
    fails('invalid_command', lambda: review.publication_header(title, description), 422)


@pytest.mark.parametrize('state,revision', [('enabled', 1), ('revoked', 7),
                                         ('enabled', 9223372036854775807)])
def test_link_binding_uses_exact_current_state_and_decimal_revision(state, revision):
    assert review.publication_link({'state': state, 'link_revision': revision}) == {
        'link_state': state, 'link_revision': str(revision)}
    assert review.publication_link(None) == {'link_state': 'no_link', 'link_revision': None}


@pytest.mark.parametrize('link', [
    {'state': 'no_link', 'link_revision': 1}, {'state': 'ENABLED', 'link_revision': 1},
    {'state': 'enabled', 'link_revision': True}, {'state': 'revoked', 'link_revision': 0},
    {'state': 'enabled', 'link_revision': '1'},
    {'state': 'enabled', 'link_revision': 9223372036854775808},
])
def test_link_binding_does_not_coerce_internal_revision(link):
    fails('artwork_preparation_unavailable', lambda: review.publication_link(link))


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('action,link', [
    ('save', ENABLED), ('enable_external', ENABLED),
    ('enable_external', {'link_state': 'no_link', 'link_revision': None}),
    ('enable_external', {'link_state': 'revoked', 'link_revision': '9223372036854775807'}),
])
def test_exact_separate_authenticated_intent_and_unchanged_six_key_b_witness(kind, action, link):
    value = snapshot(kind=kind)
    response = issue(value, action=action, link=link)
    witness, intent = response['review_witness'], response['publication_intent']
    assert set(witness) == B_KEYS and set(intent) == INTENT_KEYS
    assert response['proposed_header'] == HEADER
    assert response['contract_version'] == 1
    b_scope = expected_b_scope(value, witness)
    scope = expected_intent_scope(value, witness, action=action, link=link)
    digest = hashlib.sha256(canonical(scope)).hexdigest()
    assert intent == {'version': 1, 'action': action, **link,
                      'intent_digest': digest, 'token': intent['token']}
    position = value['metadata_generation'] + 1
    assert social_cursors.decode_social_cursor(witness['token'], secret=SECRET, scope=b_scope) == position
    assert social_cursors.decode_social_cursor(intent['token'], secret=SECRET, scope=['private-top-artwork-publication-intent-v1', 1, digest]) == position
    with pytest.raises(ValueError, match='^Invalid Social cursor\\.$'):
        social_cursors.decode_social_cursor(witness['token'], secret=SECRET, scope=['private-top-artwork-publication-intent-v1', 1, digest])
    with pytest.raises(ValueError, match='^Invalid Social cursor\\.$'):
        social_cursors.decode_social_cursor(intent['token'], secret=SECRET, scope=b_scope)
    consent = descriptor(value, response)
    assert review.normalize_publication_descriptor(consent) == consent
    assert verify(deepcopy(value), consent, action=action, link=link) is None
    assert set(consent) == DESCRIPTOR_KEYS | ({'draft_ref', 'draft_revision'} if kind == 'draft' else set())


def test_publication_headers_leave_frozen_b_digests_unchanged():
    value = snapshot()
    first = issue(value)
    second = issue(value, header={'title': 'Another title', 'description': 'Other description'})
    for key in B_KEYS - {'token'}:
        assert first['review_witness'][key] == second['review_witness'][key]
    assert first['review_witness']['asset_manifest_digest'] == '1088374f9eadeb6feb5bfd8662edead735c706a828e6680b95e240194fc28738'
    assert first['review_witness']['review_digest'] == '24229b44cedc7272819ee50994649970dcc16dd9ec66fbd07fe724bcebc8d0bd'
    assert first['publication_intent']['intent_digest'] != second['publication_intent']['intent_digest']
    assert verify(value, descriptor(value, first)) is None
    fails('invalid_or_stale_review', lambda: verify(value, descriptor(value, first),
        header=second['proposed_header']))


@pytest.mark.parametrize('field,bad', [
    ('version', True), ('version', 2), ('action', 'publish'), ('action', None),
    ('link_state', 'ENABLED'), ('link_state', None), ('link_revision', True),
    ('link_revision', 7), ('link_revision', '0'), ('link_revision', '07'),
    ('link_revision', '+7'), ('link_revision', '9223372036854775808'),
    ('link_revision', '9' * 100000), ('intent_digest', 'A' * 64),
    ('intent_digest', '0' * 63), ('token', None), ('token', ''),
    ('token', 'é'), ('token', 'x' * 4097),
])
def test_intent_normalization_fails_before_crypto(field, bad, monkeypatch):
    intent = issue(snapshot())['publication_intent']
    intent[field] = bad
    monkeypatch.setattr(review, 'decode_social_cursor', explode)
    monkeypatch.setattr(review, 'encode_social_cursor', explode)
    fails('invalid_or_stale_review', lambda: review.normalize_publication_intent(intent))


@pytest.mark.parametrize('change', [
    lambda intent: None, lambda intent: [], lambda intent: {},
    lambda intent: {**intent, 'extra': 'untrusted'},
    lambda intent: {key: value for key, value in intent.items() if key != 'token'},
    lambda intent: {**intent, 'action': 'save', 'link_state': 'revoked'},
    lambda intent: {**intent, 'action': 'save', 'link_state': 'no_link', 'link_revision': None},
    lambda intent: {**intent, 'action': 'enable_external', 'link_state': 'no_link', 'link_revision': '1'},
    lambda intent: {**intent, 'link_state': 'enabled', 'link_revision': None},
])
def test_intent_exact_shape_and_action_link_pairs(change):
    fails('invalid_or_stale_review', lambda: review.normalize_publication_intent(
        change(issue(snapshot())['publication_intent'])))


def test_intent_exact_6144_encoded_byte_boundary_and_4096_ascii_token_limit(monkeypatch):
    intent = {'version': 1, 'action': 'save', **ENABLED, 'intent_digest': 'a' * 64, 'token': ''}
    base = len(canonical(intent))
    budget = 6144 - base
    intent['token'] = '\\' * (budget // 2) + ('x' if budget % 2 else '')
    assert len(canonical(intent)) == 6144 and len(intent['token']) <= 4096
    monkeypatch.setattr(review, 'decode_social_cursor', explode)
    assert review.normalize_publication_intent(intent) == intent
    intent['token'] += 'x'
    fails('invalid_or_stale_review', lambda: review.normalize_publication_intent(intent))
    intent['token'] = 'x' * 4096
    assert review.normalize_publication_intent(intent)['token'] == 'x' * 4096
    intent['token'] += 'x'
    fails('invalid_or_stale_review', lambda: review.normalize_publication_intent(intent))


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('field', ['version', 'kind', 'preparation_ref', 'preparation_revision',
                                   'context_ref', 'review_witness', 'publication_intent'])
def test_descriptor_requires_every_common_field(kind, field):
    consent = descriptor(snapshot(kind=kind))
    del consent[field]
    fails('invalid_command', lambda: review.normalize_publication_descriptor(consent), 422)


@pytest.mark.parametrize('kind,changes', [
    ('saved', {'draft_ref': uid(3)}), ('saved', {'draft_revision': '11'}),
    ('saved', {'extra': None}), ('draft', {'extra': None}),
    ('draft', {'version': True}), ('draft', {'version': 1}),
    ('draft', {'kind': 'remote'}), ('draft', {'context_ref': 'A' * 64}),
])
def test_descriptor_cross_kind_extras_and_version_are_rejected(kind, changes):
    consent = descriptor(snapshot(kind=kind))
    consent.update(changes)
    fails('invalid_command', lambda: review.normalize_publication_descriptor(consent), 422)


@pytest.mark.parametrize('field', ['draft_ref', 'draft_revision'])
def test_draft_descriptor_requires_its_own_identity_fields(field):
    consent = descriptor(snapshot())
    del consent[field]
    fails('invalid_command', lambda: review.normalize_publication_descriptor(consent), 422)


@pytest.mark.parametrize('field,bad,code,status', [
    ('preparation_ref', '00000000-0000-0000-0000-000000000000', 'artwork_preparation_unavailable', 409),
    ('preparation_ref', 'invalid', 'artwork_preparation_unavailable', 409),
    ('draft_ref', None, 'artwork_preparation_unavailable', 409),
    ('preparation_revision', True, 'invalid_command', 422),
    ('preparation_revision', 5, 'invalid_command', 422),
    ('preparation_revision', '05', 'invalid_command', 422),
    ('preparation_revision', '9223372036854775808', 'invalid_command', 422),
    ('draft_revision', '0', 'invalid_command', 422),
    ('context_ref', 'c' * 65, 'invalid_command', 422),
])
def test_descriptor_identity_scalars_are_strict(field, bad, code, status):
    consent = descriptor(snapshot())
    consent[field] = bad
    fails(code, lambda: review.normalize_publication_descriptor(consent), status)


def test_whole_descriptor_budget_precedes_child_normalization_and_any_crypto(monkeypatch):
    consent = descriptor(snapshot())
    consent['review_witness']['token'] = '\\' * 4096
    consent['publication_intent']['token'] = '\\' * 4096
    assert len(canonical(consent)) > 12288
    monkeypatch.setattr(review, 'normalize_witness', explode)
    monkeypatch.setattr(review, 'normalize_publication_intent', explode)
    monkeypatch.setattr(review, 'decode_social_cursor', explode)
    monkeypatch.setattr(review, 'encode_social_cursor', explode)
    fails('artwork_validation_limit', lambda: review.normalize_publication_descriptor(consent))


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('action', ['save', 'enable_external'])
def test_command_preserves_full_local_vector_and_both_witnesses(kind, action, monkeypatch):
    value = snapshot(kind=kind, count=2)
    if kind == 'draft':
        value['rows'][0].update(row_kind='existing', saved_item_ref=uid(800001))
    response = issue(value, action=action)
    incoming = payload(value, response)
    original = deepcopy(incoming)
    monkeypatch.setattr(review, 'decode_social_cursor', explode)
    monkeypatch.setattr(review, 'require_key', explode)
    command = normalize_top_command(action, incoming, top_ref=uid(1))
    assert command.data == {key: item for key, item in original.items() if key != 'request_key'}
    assert incoming == original
    assert command.data['artwork_publication'] is not incoming['artwork_publication']
    assert command.data['artwork_publication']['review_witness'] is not incoming['artwork_publication']['review_witness']
    assert command.data['artwork_publication']['publication_intent'] is not incoming['artwork_publication']['publication_intent']
    if kind == 'draft':
        assert command.data['items'][0]['item_ref'] == uid(800001)
        assert command.data['items'][1]['item_ref'] is None
        assert command.data['items'][1]['item_ref'] != value['rows'][1]['row_ref']
        assert b'"item_ref":null' in canonical(command.data)
        assert b'"None"' not in canonical(command.data)


@pytest.mark.parametrize('field', ['title', 'description', 'items', 'evidence_revision'])
@pytest.mark.parametrize('action', ['save', 'enable_external'])
def test_descriptor_command_requires_explicit_complete_header_vector_and_evidence(field, action):
    incoming = payload(snapshot())
    del incoming[field]
    fails('invalid_command', lambda: normalize_top_command(action, incoming, top_ref=uid(1)), 422)


@pytest.mark.parametrize('change', [
    lambda body: body.update(item_selections=[]),
    lambda body: body['items'][0].pop('selected_local_album_id'),
    lambda body: body['items'][0].pop('selected_source_ref'),
    lambda body: body['items'][0].update(selected_local_album_id=True),
    lambda body: body['items'][0].update(selected_local_album_id='100'),
    lambda body: body['items'][0].update(selected_local_album_id=0),
    lambda body: body['items'][0].update(selected_local_album_id=9223372036854775808),
    lambda body: body['items'][0].update(item_ref='None'),
    lambda body: body['items'][0].update(source={'kind': 'remote_retained', 'admission_ref': uid(8), 'evidence_version': 'a' * 64}),
    lambda body: body['items'][0].update(kind='new_remote'),
    lambda body: body.update(items=[{'kind': 'new_remote', 'source': {'kind': 'remote_acquisition'}}]),
])
def test_descriptor_command_rejects_incomplete_local_selection_and_remote_shapes(change):
    incoming = payload(snapshot())
    change(incoming)
    fails('invalid_command', lambda: normalize_top_command('save', incoming, top_ref=uid(1)), 422)


@pytest.mark.parametrize('action', ['create', 'revoke_external', 'add', 'remove', 'reorder', 'delete', 'copy'])
def test_descriptor_cannot_be_attached_to_an_unrelated_action(action):
    incoming = {'request_key': uid(900001), 'revision': '3',
                'artwork_publication': descriptor(snapshot())}
    fails('invalid_command', lambda: normalize_top_command(action, incoming, top_ref=uid(1)), 422)


@pytest.mark.parametrize('which,field,replacement', [
    ('review_witness', 'metadata_generation', '24'),
    ('review_witness', 'metadata_evidence_revision', '0' * 64),
    ('review_witness', 'asset_manifest_digest', '0' * 64),
    ('review_witness', 'review_digest', '0' * 64),
    ('review_witness', 'token', 'bounded-but-unauthenticated-b-token'),
    ('publication_intent', 'action', 'enable_external'),
    ('publication_intent', 'link_revision', '8'),
    ('publication_intent', 'link_state', 'revoked'),
    ('publication_intent', 'intent_digest', '0' * 64),
    ('publication_intent', 'token', 'bounded-but-unauthenticated-intent-token'),
])
def test_existing_command_digest_covers_every_variable_witness_field(which, field, replacement):
    incoming = payload(snapshot())
    if field == 'link_state':
        incoming['artwork_publication']['publication_intent']['action'] = 'enable_external'
    first = normalize_top_command('save', incoming, top_ref=uid(1))
    changed = deepcopy(incoming)
    changed['artwork_publication'][which][field] = replacement
    second = normalize_top_command('save', changed, top_ref=uid(1))
    assert first.digest != second.digest
    expected = {'action': 'save', 'top_ref': uid(1), 'data': second.data}
    assert second.digest == hashlib.sha256(canonical(expected)).hexdigest()


def test_command_digest_uses_normalized_header_and_exact_description_and_request_key_independence():
    incoming = payload(snapshot())
    first = normalize_top_command('save', incoming, top_ref=uid(1))
    incoming['title'] = '  ' + incoming['title'] + '  '
    incoming['request_key'] = uid(900002)
    assert normalize_top_command('save', incoming, top_ref=uid(1)).digest == first.digest
    incoming['description'] += ' '
    assert normalize_top_command('save', incoming, top_ref=uid(1)).digest != first.digest


@pytest.mark.parametrize('header,action,link', [
    ({**HEADER, 'title': HEADER['title'] + '!'}, 'save', ENABLED),
    ({**HEADER, 'description': HEADER['description'] + ' '}, 'save', ENABLED),
    (HEADER, 'enable_external', ENABLED),
    (HEADER, 'save', {'link_state': 'enabled', 'link_revision': '8'}),
    (HEADER, 'enable_external', {'link_state': 'revoked', 'link_revision': '7'}),
    (HEADER, 'enable_external', {'link_state': 'no_link', 'link_revision': None}),
])
def test_authenticated_consent_rejects_header_action_and_link_tampering(header, action, link):
    value = snapshot()
    consent = descriptor(value)
    fails('invalid_or_stale_review', lambda: verify(value, consent, header=header, action=action, link=link))


def test_recomputed_unsigned_intent_digest_does_not_authorize_a_changed_title():
    value = snapshot()
    consent = descriptor(value)
    header = {**HEADER, 'title': 'Unreviewed replacement'}
    scope = expected_intent_scope(value, consent['review_witness'], header=header)
    consent['publication_intent']['intent_digest'] = hashlib.sha256(canonical(scope)).hexdigest()
    fails('invalid_or_stale_review', lambda: verify(value, consent, header=header))


@pytest.mark.parametrize('field,replacement', [
    ('library_id', 70), ('owner_account_id', 80), ('original_session_id', 90),
    ('context_ref', '0' * 64), ('top_ref', UUID(uid(700001))), ('top_revision', 4),
    ('ref', UUID(uid(700002))), ('revision', 6), ('request_generation', 18),
    ('expires_at', datetime(2026, 10, 17, 5, tzinfo=timezone.utc)),
    ('draft_ref', UUID(uid(700003))), ('draft_revision', 12), ('baseline_digest', '0' * 64),
])
def test_consent_authenticates_every_original_scope_and_full_s_identity(field, replacement):
    value = snapshot()
    consent = descriptor(value)
    value['header'][field] = replacement
    fails('invalid_or_stale_review', lambda: verify(value, consent))


@pytest.mark.parametrize('change', [
    lambda value: value.update(digest='0' * 64),
    lambda value: value.update(metadata_generation=24),
    lambda value: value['rows'][-1].update(catalog_ref=uid(600001)),
    lambda value: value['rows'][-1].update(row_ref=uid(600002)),
    lambda value: value['rows'][-1].update(saved_item_ref=uid(600003), row_kind='existing'),
    lambda value: value['rows'][-1].update(asset_ref=UUID(uid(600004))),
    lambda value: value['rows'][-1].update(content_digest='0' * 64),
    lambda value: value['rows'][-1].update(proof_digest='0' * 64),
    lambda value: value['rows'][-1].update(acquisition_digest='0' * 64),
    lambda value: value['rows'][-1].update(width=4),
    lambda value: value['rows'][-1].update(height=4),
    lambda value: value['rows'][-1].update(byte_length=19),
])
def test_full_vector_off_page_changes_cannot_reuse_consent(change):
    value = snapshot(count=101)
    consent = descriptor(value)
    change(value)
    fails('invalid_or_stale_review', lambda: verify(value, consent))


@pytest.mark.parametrize('operation', ['reorder', 'remove', 'exclude'])
def test_full_vector_reorder_removal_and_explicit_exclusion_require_new_consent(operation):
    value = snapshot(count=101)
    consent = descriptor(value)
    if operation == 'reorder':
        value['rows'][0], value['rows'][-1] = value['rows'][-1], value['rows'][0]
        for position, row in enumerate(value['rows'], 1):
            row['position'] = position
    elif operation == 'remove':
        value['rows'].pop()
        value['header']['item_count'] -= 1
        value['included_count'] -= 1
    else:
        row = value['rows'][-1]
        row.update(included=False, status='excluded', asset_ref=None, content_digest=None,
                   width=None, height=None, byte_length=None, proof_digest=None, acquisition_digest=None)
        value['included_count'] -= 1
    fails('invalid_or_stale_review', lambda: verify(value, consent))


def test_new_genuine_b_witness_for_changed_full_s_cannot_reuse_old_publication_intent():
    value = snapshot()
    consent = descriptor(value)
    value['digest'] = '0' * 64
    value['metadata_generation'] += 1
    new_b = review.finish_review(value, synthetic_state(value), kind='draft', cursor_secret=SECRET)
    consent['review_witness'] = new_b['review_witness']
    assert review.verify_witness(value, consent['review_witness'], kind='draft', cursor_secret=SECRET) is None
    fails('invalid_or_stale_review', lambda: verify(value, consent))


@pytest.mark.parametrize('which', ['review_witness', 'publication_intent'])
def test_ciphertext_corruption_is_a_sanitized_failure(which):
    value = snapshot()
    consent = descriptor(value)
    token = consent[which]['token']
    consent[which]['token'] = token[:20] + ('A' if token[20] != 'A' else 'B') + token[21:]
    fails('invalid_or_stale_review', lambda: verify(value, consent))


@pytest.mark.parametrize('token_source', ['ordinary_cursor', 'b_witness', 'wrong_position'])
def test_intent_does_not_accept_other_domains_or_authenticated_wrong_generation(token_source):
    value = snapshot()
    consent = descriptor(value)
    if token_source == 'ordinary_cursor':
        token = social_cursors.encode_social_cursor(24, secret=SECRET, scope=['ordinary-list'])
    elif token_source == 'b_witness':
        token = consent['review_witness']['token']
    else:
        token = social_cursors.encode_social_cursor(25, secret=SECRET,
            scope=['private-top-artwork-publication-intent-v1', 1,
                   consent['publication_intent']['intent_digest']])
    consent['publication_intent']['token'] = token
    fails('invalid_or_stale_review', lambda: verify(value, consent))


@pytest.mark.parametrize('secret', [None, '', 'short', b'x' * 32, '\ud800' * 32])
def test_missing_or_invalid_server_key_remains_distinct_and_never_enters_crypto(secret, monkeypatch):
    value = snapshot()
    consent = descriptor(value)
    monkeypatch.setattr(review, 'decode_social_cursor', explode)
    monkeypatch.setattr(review, 'encode_social_cursor', explode)
    fails('review_key_unavailable', lambda: verify(value, consent, secret=secret), 503)


def test_rotated_secret_does_not_authenticate_old_intent():
    value = snapshot()
    consent = descriptor(value)
    fails('invalid_or_stale_review', lambda: verify(value, consent, secret=SECRET + '-rotated'))


@pytest.mark.parametrize('kind', ['saved', 'draft'])
@pytest.mark.parametrize('count', [0, 1, 100, 101, 250, 5000])
def test_empty_and_all_excluded_review_keep_complete_vector_and_actual_nulls(kind, count, monkeypatch):
    value = snapshot(kind=kind, included=False, count=count)
    monkeypatch.setattr(evidence, 'capture_artwork_review', explode)
    monkeypatch.setattr(codec, 'prepare_inventory_binding', explode)
    response = issue(value)
    assert response['item_count'] == len(response['items']) == count
    assert response['included_count'] == response['total_image_bytes'] == 0
    assert [row['position'] for row in response['items']] == list(range(1, count + 1))
    assert all(row['artwork_ref'] is row['width'] is row['height'] is None for row in response['items'])
    if kind == 'draft':
        assert all(row['saved_item_ref'] is None for row in response['items'])
    assert verify(value, descriptor(value, response)) is None


def test_full_response_budget_includes_escaped_header_and_both_opaque_tokens(monkeypatch):
    value = snapshot(count=2)
    header = {'title': 'A "quoted" title', 'description': 'Backslash \\ and é水😀'}
    response = issue(value, header=header)
    size = len(canonical(response))
    assert review._MAX_SUMMARY == 36 * 1024 * 1024
    assert review._json_size(response, size) == size
    monkeypatch.setattr(review, '_MAX_SUMMARY', size)
    assert len(canonical(issue(value, header=header))) == size
    monkeypatch.setattr(review, '_MAX_SUMMARY', size - 1)
    original = evidence.canonical
    def bounded_encode(data):
        if type(data) is dict and 'proposed_header' in data:
            assert len(canonical(data)) <= size - 1, 'oversized publication response serialized'
        return original(data)
    monkeypatch.setattr(evidence, 'canonical', bounded_encode)
    fails('artwork_validation_limit', lambda: issue(value, header=header))


def test_oversized_intent_scope_is_rejected_before_intent_crypto(monkeypatch):
    value = snapshot()
    state = synthetic_state(value)
    original = review.encode_social_cursor
    calls = []
    def record(position, *, secret, scope):
        calls.append(scope[0])
        assert scope[0] != 'private-top-artwork-publication-intent-v1'
        return original(position, secret=secret, scope=scope)
    monkeypatch.setattr(review, 'encode_social_cursor', record)
    # Deliberately invalid trusted-boundary input: the public normalizer rejects
    # this earlier. The fixed issuer must still bound the scope before crypto.
    fails('artwork_validation_limit', lambda: review.finish_publication_review(value, state,
        kind='draft', cursor_secret=SECRET, header={'title': 'Title', 'description': 'x' * 100000},
        action='save', link=ENABLED))
    assert calls == ['private-top-artwork-reviewed-metadata-v1']


class MappingResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class MappingConnection:
    """Records bounded projections; has no transaction, admission or authority."""
    def __init__(self, values):
        self.values, self.calls = values, []

    def execute(self, sql, params):
        self.calls.append((sql, params))
        assert sql.lstrip().startswith('select row_ref,position,')
        assert 'octet_length(source_stamp::text)<=65536' in sql
        assert 'octet_length(acquisition_stamp::text)<=2048' in sql
        assert 'order by position limit 101' in sql
        assert 'position>%s and position<=%s' in sql
        assert 0 < params[2] - params[1] <= 100
        return MappingResult([deepcopy(row) for row in self.values
                              if params[1] < row['position'] <= params[2]])


def mapping_inputs(count, *, kind='draft', included=True):
    """Genuine codec bindings over synthetic descriptors, never capture proof."""
    value = snapshot(kind=kind, included=included, count=count)
    value['header']['library_id'] = 1
    prepared = codec.prepare_inventory_binding(inventory()) if kind == 'draft' and included else None
    values, final, presentations = [], [], []
    for index, row in enumerate(value['rows']):
        # The actual apply result may contain newly allocated IDs. A staging row
        # identity is never a substitute for its actual final item UUID.
        final.append({'curator_position': index + 1, 'item_ref': uid(1000000 + index),
                      'original_position': 5000 - index, 'album_ref': row['catalog_ref']})
        presentations.append(uid(2000000 + index))
        if kind == 'draft' and included:
            stamp = source(bound=True)
            stamp['local_album_id'] = row['selected_local_album_id']
            acquired = acquisition(stamp)
            expected, digest, acquisition_digest = proof.ready_binding(stamp, acquired, prepared,
                library_id=1, local_album_id=row['selected_local_album_id'])
            row.update(expected=expected, proof_digest=digest, acquisition_digest=acquisition_digest)
            values.append({'row_ref': UUID(row['row_ref']), 'position': row['position'],
                           'source_stamp': stamp, 'acquisition_stamp': acquired})
    return value, prepared, final, presentations, values


@pytest.mark.parametrize('count', [0, 1, 100, 101, 250, 5000])
def test_exact_actual_apply_mapping_pages_and_genuine_canonical_descriptor_witnesses(count):
    value, prepared, final, presentations, values = mapping_inputs(count)
    connection = MappingConnection(values)
    result = []
    for offset in range(0, count, 100):
        page = publication._mapping_page(connection, value, prepared, final, presentations, offset)
        assert 1 <= len(page) <= 100
        assert all(set(item) == MAPPING_KEYS for item in page)
        result.extend(page)
    assert len(result) == count
    assert len(connection.calls) == (count + 99) // 100
    for index, item in enumerate(result):
        assert item == {'curator_position': index + 1, 'item_ref': final[index]['item_ref'],
                        'original_position': final[index]['original_position'],
                        'presentation_ref': presentations[index],
                        'descriptor_witness': codec.canonical_source_bytes(values[index]['source_stamp']).decode('utf-8')}
        assert item['item_ref'] != value['rows'][index]['row_ref']
        assert len(item['descriptor_witness'].encode('utf-8')) <= 65536
    for index, (_, params) in enumerate(connection.calls):
        assert params == (value['header']['ref'], index * 100, min(count, (index + 1) * 100))


@pytest.mark.parametrize('kind,included', [('saved', True), ('saved', False), ('draft', False)])
def test_saved_legacy_and_excluded_mapping_witnesses_remain_actual_null(kind, included, monkeypatch):
    value, prepared, final, presentations, values = mapping_inputs(101, kind=kind, included=included)
    monkeypatch.setattr(proof, 'ready_binding', explode)
    monkeypatch.setattr(codec, 'canonical_source_bytes', explode)
    connection = MappingConnection(values)
    result = []
    for offset in (0, 100):
        result.extend(publication._mapping_page(connection, value, prepared, final, presentations, offset))
    assert len(result) == 101 and all(item['descriptor_witness'] is None for item in result)
    assert b'"descriptor_witness":null' in canonical(result)
    assert b'"None"' not in canonical(result)
    assert len(connection.calls) == (2 if kind == 'draft' else 0)


@pytest.mark.parametrize('change', [
    lambda values: values.pop(),
    lambda values: values[0].update(row_ref=UUID(uid(500001))),
    lambda values: values[0].update(position=0),
    lambda values: values[0]['acquisition_stamp']['file'].update(ctime_ns='1'),
])
def test_mapping_rejects_missing_wrong_identity_or_changed_acquisition_page(change):
    value, prepared, final, presentations, values = mapping_inputs(2)
    change(values)
    connection = MappingConnection(values)
    fails('artwork_source_changed', lambda: publication._mapping_page(
        connection, value, prepared, final, presentations, 0))


def test_mapping_revalidates_current_expected_source_and_complete_proof_digests():
    value, prepared, final, presentations, values = mapping_inputs(101)
    # Change the last page's source and its paired descriptor digest together.
    # The real codec accepts the pair; fresh retained S still rejects it.
    values[-1]['source_stamp']['root']['inode'] = '43'
    values[-1]['acquisition_stamp'] = acquisition(values[-1]['source_stamp'])
    connection = MappingConnection(values)
    fails('artwork_source_changed', lambda: publication._mapping_page(
        connection, value, prepared, final, presentations, 100))
    assert len(connection.calls) == 1 and connection.calls[0][1][1:] == (100, 101)


def test_mapping_never_accepts_an_unsigned_noncanonical_descriptor_digest():
    value, prepared, final, presentations, values = mapping_inputs(1)
    values[0]['acquisition_stamp']['descriptor_digest'] = hashlib.sha256(b'noncanonical witness').hexdigest()
    connection = MappingConnection(values)
    with pytest.raises(codec.InvalidArtworkProof, match='^artwork_proof_invalid$'):
        publication._mapping_page(connection, value, prepared, final, presentations, 0)


@pytest.mark.parametrize('value', [None, [], True, 'opaque-token', {}])
def test_descriptor_rejects_non_object_and_missing_shape_without_crypto(value, monkeypatch):
    monkeypatch.setattr(review, 'decode_social_cursor', explode)
    monkeypatch.setattr(review, 'encode_social_cursor', explode)
    fails('invalid_command', lambda: review.normalize_publication_descriptor(value), 422)


@pytest.mark.parametrize('extra', ['title', 'description', 'action', 'publication_intent'])
def test_publication_consent_does_not_widen_the_six_key_b_witness(extra):
    witness = issue(snapshot())['review_witness']
    witness[extra] = 'untrusted'
    fails('invalid_or_stale_review', lambda: review.normalize_witness(witness))


@pytest.mark.parametrize('old_kind,new_kind', [('saved', 'draft'), ('draft', 'saved')])
def test_genuine_consent_cannot_cross_saved_and_draft_identity(old_kind, new_kind):
    previous = snapshot(kind=old_kind)
    response = issue(previous)
    current = snapshot(kind=new_kind)
    # New descriptor shape is valid, but its two genuine old tokens still bind
    # the original preparation kind and its exact nullable draft identity.
    consent = descriptor(current, response)
    assert review.normalize_publication_descriptor(consent) == consent
    fails('invalid_or_stale_review', lambda: verify(current, consent))


@pytest.mark.parametrize('link', [
    {'link_state': 'no_link', 'link_revision': None},
    {'link_state': 'revoked', 'link_revision': '7'},
])
def test_save_intent_cannot_be_issued_for_a_missing_or_revoked_link(link):
    fails('invalid_or_stale_review', lambda: issue(snapshot(), action='save', link=link))


def test_publication_review_adds_only_bounded_header_and_intent_to_private_b_projection():
    value = snapshot(count=101)
    state = synthetic_state(value)
    b_response = review.finish_review(value, state, kind='draft', cursor_secret=SECRET)
    response = issue(value)
    assert set(response) == set(b_response) | {'proposed_header', 'publication_intent'}
    assert response['items'] == b_response['items']
    assert len(response['items']) == 101
    encoded = canonical(response)
    for private in (b'source_stamp', b'acquisition_stamp', b'selected_source_ref',
                    b'proof_digest', b'content_digest', b'root_id', b'"tracks"'):
        assert private not in encoded
    assert 'cursor_secret' not in response and 'token' not in state


def test_mapping_mixed_inclusion_preserves_full_order_and_excluded_null_witness():
    value, prepared, final, presentations, values = mapping_inputs(3)
    value['rows'][1].update(included=False, status='excluded', asset_ref=None, content_digest=None,
        width=None, height=None, byte_length=None, proof_digest=None, acquisition_digest=None)
    value['included_count'] = 2
    del values[1]
    connection = MappingConnection(values)
    result = publication._mapping_page(connection, value, prepared, final, presentations, 0)
    assert [item['curator_position'] for item in result] == [1, 2, 3]
    assert [item['item_ref'] for item in result] == [item['item_ref'] for item in final]
    assert [item['presentation_ref'] for item in result] == presentations
    assert result[1]['descriptor_witness'] is None
    assert result[0]['descriptor_witness'] == codec.canonical_source_bytes(values[0]['source_stamp']).decode('utf-8')
    assert result[2]['descriptor_witness'] == codec.canonical_source_bytes(values[1]['source_stamp']).decode('utf-8')
    assert len(connection.calls) == 1


@pytest.mark.parametrize('character', ['x', 'é', '水', '😀'])
def test_maximum_legal_unicode_header_authenticates_full_scope_with_compact_bounded_token(character):
    value = snapshot()
    header = review.publication_header(character * 100, character * 1000)
    response = issue(value, header=header)
    intent = response['publication_intent']
    scope = expected_intent_scope(value, response['review_witness'], header=header)
    digest = hashlib.sha256(canonical(scope)).hexdigest()
    assert intent['intent_digest'] == digest
    assert len(canonical(scope)) <= 6144
    assert 1 <= len(intent['token']) <= 4096 and intent['token'].isascii()
    assert social_cursors.decode_social_cursor(intent['token'], secret=SECRET,
        scope=['private-top-artwork-publication-intent-v1', 1, digest]) == 24
    assert verify(value, descriptor(value, response), header=header) is None


def test_first_aggregate_review_serialization_already_has_complete_publication_envelope(monkeypatch):
    value = snapshot(count=2)
    original = evidence.canonical
    responses = []
    def record(data):
        if type(data) is dict and 'review_witness' in data:
            assert 'proposed_header' in data and 'publication_intent' in data
            assert review._json_size(data, 36 * 1024 * 1024) == len(canonical(data))
            responses.append(deepcopy(data))
        return original(data)
    monkeypatch.setattr(evidence, 'canonical', record)
    response = issue(value)
    assert responses == [response]
