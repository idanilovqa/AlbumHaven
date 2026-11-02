"""Independent, fixed historical input identities; never derive these from 0169.

The public JSON envelope is transport, not SQL authority. Only decoded SQL and
reviewed per-input provenance identities define the version-two oracle.
"""
import copy
import hashlib
import json
from pathlib import Path

import pytest

from tests.py import listening_tracking_migration_support as support

DESCRIPTION = 'Independent historical DDL oracle; outer documentary comments removed without changing executable SQL or quoted bodies.'
# Independently reviewed original/sanitized pairs, not candidate self-attestation.
PAIRS = {
    'position-v2': ('917977e64a6d69c6bf536a2b4c3c054a53b7bb988b54e715e97edde4cf6e18e5',
        '2a923bdc5f39ada667181df658c0264cd05a7bfc8952dea51634db6bd41ab577'),
    'history-revision': ('5aa8fc86c032db5ee964575b40de8997c0305c3857b904d94d10e51fc484540a',
        'f9f98ac70675bfaaef2f53020be34e7df294afd26593afd7a9f8ac152dadcea0'),
    'raw-survival': ('35ca8e03feb90256d1b793f5da126c0957dcc46001591f01979528bc3f11e2b5',
        '3a7972f9ac2a4b824184f380ccc4e8917aa0b343a990c02b8ba8f168342e0b3a'),
    'edition-selection': ('2f3c8659fde033c9f131575a226f793e5e6f0ca4bb1de8489f3ab979756b6dc2',
        '66339ed670501bab2d0ab556f1fe6762aa174ab0d565bafdfca259cc82f796cf'),
    'decoder-observation': ('f88489a4cfc6066b0d77ba563f2b2f49d151b58ec56e485c182a36dfdc61aef1',
        '5b54ed25b6281722818cacd9d087d19d3b7eef400f6579044e09c05b1a152126'),
    'derived-state': ('3af0896935ff82142d4c74cfa05bd8e220702925093e8c13623073fc86e4ff08',
        '031c7ccf00a252b37342112928660133d307edf14bc1aa1c6a7a6ed1d497bca5'),
    'settings': ('c7d3e4eef247ead193686b5f7ee58b1443720816fb331f1d9ad32f1f8f319c8e',
        '8b95dfe9d5d67f84d5c7f2e4fb1cb61613a42e743dd18ef1fc97c8f1a8120b98'),
    'native-rating-intent': ('6d9c316833644143f2eedc65a589d58e09c1f27857528459af936860549eb057',
        '1abea6aa8f020da5e84d6552854bbba5a78588116fb1369eef297c5d990079f1'),
    'top-baselines': ('59f2fe748d1f8fe8e58a910b1af0b82774454f21e832137cc124f85686648e06',
        'bcb1ddb871ae22c3b7a936ed0ddff7b503e946127cdb24eda76b333060765234'),
    'absolute-coordinates': ('f9d91fa276494da4eabc1ad7b1a34220c5f4648236577fc5ced63762581db164',
        '6b6371659ff04a164412f0be18dc44f2200a0889680717b71207cab49e897c45'),
    'converted-coordinates': ('f84072f7b3b32970ac850a3cd7398d625666c842a726da73cc6a2760e303c1f4',
        '978d752586002f6acfecf449d1ca6725de2f82efcb4966b14c61794a03ccadef'),
}
BUNDLE = Path(__file__).resolve().parents[1] / 'fixtures/listening-tracking/historical-inputs-v2.json'


@pytest.fixture(scope='module')
def public_payload():
    assert BUNDLE.is_file(), 'Independent public historical fixture not delivered'
    return json.loads(BUNDLE.read_text(encoding='utf-8'))


def test_public_oracle_is_delivered():
    assert BUNDLE.is_file(), 'Independent public historical fixture not delivered'


def test_original_identities_remain_fixed():
    assert support.INPUT_HASHES == {key: pair[0] for key, pair in PAIRS.items()}


def test_public_payload_matches_reviewed_identities(public_payload):
    assert set(public_payload) == {'schemaVersion', 'description', 'inputs'}
    assert type(public_payload['schemaVersion']) is int
    assert public_payload['schemaVersion'] == 2
    assert public_payload['description'] == DESCRIPTION
    assert [item['id'] for item in public_payload['inputs']] == list(PAIRS)
    for item in public_payload['inputs']:
        assert set(item) == {'id', 'originalSha256', 'sanitizedSha256', 'sql'}
        assert (item['originalSha256'], item['sanitizedSha256']) == PAIRS[item['id']]
        assert type(item['sql']) is str
        assert hashlib.sha256(item['sql'].encode('utf-8')).hexdigest() == PAIRS[item['id']][1]


@pytest.mark.parametrize('envelope', ['compact', 'pretty-lf', 'pretty-crlf', 'outer-whitespace'])
def test_decoded_sql_not_outer_json_bytes_is_authoritative(public_payload, envelope):
    raw = json.dumps(public_payload, indent=None if envelope == 'compact' else 2)
    if envelope == 'pretty-crlf':
        raw = raw.replace('\n', '\r\n')
    if envelope == 'outer-whitespace':
        raw = ' \r\n\t' + raw + '\r\n  '
    assert support.decode_inputs(raw) == {item['id']: item['sql'] for item in public_payload['inputs']}


@pytest.mark.parametrize('mutation', [
    'missing-input', 'duplicate-input', 'unknown-input', 'reordered-inputs',
    'extra-root', 'missing-description', 'changed-description', 'extra-item',
    'missing-original', 'missing-sanitized', 'original-spoof', 'sanitized-spoof',
    'changed-sql', 'sql-crlf', 'self-signed-corruption', 'sql-null', 'sql-list',
    'version-bool', 'version-string', 'version-unknown', 'mixed-v1-item',
])
def test_public_loader_rejects_mutation(public_payload, mutation):
    payload = copy.deepcopy(public_payload)
    item = payload['inputs'][0]
    if mutation == 'missing-input': payload['inputs'].pop()
    elif mutation == 'duplicate-input': payload['inputs'][-1] = copy.deepcopy(item)
    elif mutation == 'unknown-input': item['id'] = 'unknown'
    elif mutation == 'reordered-inputs': payload['inputs'].reverse()
    elif mutation == 'extra-root': payload['path'] = 'not-permitted'
    elif mutation == 'missing-description': del payload['description']
    elif mutation == 'changed-description': payload['description'] += ' changed'
    elif mutation == 'extra-item': item['path'] = 'not-permitted'
    elif mutation == 'missing-original': del item['originalSha256']
    elif mutation == 'missing-sanitized': del item['sanitizedSha256']
    elif mutation == 'original-spoof': item['originalSha256'] = '0' * 64
    elif mutation == 'sanitized-spoof': item['sanitizedSha256'] = '0' * 64
    elif mutation == 'changed-sql': item['sql'] += ' '
    elif mutation == 'sql-crlf': item['sql'] = item['sql'].replace('\n', '\r\n')
    elif mutation == 'self-signed-corruption':
        item['sql'] += '\nselect 1;'
        item['sanitizedSha256'] = hashlib.sha256(item['sql'].encode()).hexdigest()
    elif mutation == 'sql-null': item['sql'] = None
    elif mutation == 'sql-list': item['sql'] = []
    elif mutation == 'version-bool': payload['schemaVersion'] = True
    elif mutation == 'version-string': payload['schemaVersion'] = '2'
    elif mutation == 'version-unknown': payload['schemaVersion'] = 3
    elif mutation == 'mixed-v1-item':
        del item['originalSha256']
        del item['sanitizedSha256']
    with pytest.raises((AssertionError, ValueError)):
        support.decode_inputs(json.dumps(payload))


@pytest.mark.parametrize('field', ['schemaVersion', 'description', 'id', 'sql', 'originalSha256', 'sanitizedSha256'])
def test_duplicate_json_keys_are_not_silently_collapsed(public_payload, field):
    raw = json.dumps(public_payload)
    value = public_payload[field] if field in public_payload else public_payload['inputs'][0][field]
    token = json.dumps(field) + ': ' + json.dumps(value)
    assert token in raw
    raw = raw.replace(token, token + ', ' + token, 1)
    with pytest.raises((AssertionError, ValueError)):
        support.decode_inputs(raw)


@pytest.mark.parametrize('reverse', [False, True])
def test_legacy_v1_parser_remains_compatible_without_public_metadata(monkeypatch, reverse):
    # Small synthetic SQL exercises the old API without publishing private SQL.
    sql = {key: '-- synthetic legacy input ' + key for key in PAIRS}
    monkeypatch.setattr(support, 'INPUT_HASHES', {
        key: hashlib.sha256(value.encode()).hexdigest() for key, value in sql.items()})
    payload = {'schemaVersion': 1, 'inputs': [{'id': key, 'sql': value} for key, value in sql.items()]}
    if reverse:
        payload['inputs'].reverse()
    assert support.decode_inputs(json.dumps(payload)) == sql


def test_absent_external_path_selects_public_bundle(public_payload):
    assert support.proposal_inputs({}) == {item['id']: item['sql'] for item in public_payload['inputs']}


def test_explicit_external_bundle_is_used(tmp_path, public_payload):
    path = tmp_path / 'external.json'
    path.write_text(json.dumps(public_payload), encoding='utf-8')
    assert support.proposal_inputs({'ALBUM_HAVEN_TRACKING_MIGRATION_INPUTS': str(path)}) == {
        item['id']: item['sql'] for item in public_payload['inputs']}


@pytest.mark.parametrize('kind', ['missing', 'corrupt', 'oversized', 'directory', 'relative'])
def test_invalid_explicit_input_never_falls_back(tmp_path, kind):
    path = tmp_path / 'invalid.json'
    if kind == 'corrupt': path.write_text('{}', encoding='utf-8')
    elif kind == 'oversized': path.write_bytes(b' ' * 262145)
    elif kind == 'directory': path.mkdir()
    elif kind == 'relative': path = Path('relative-input.json')
    with pytest.raises((AssertionError, ValueError, OSError)):
        support.proposal_inputs({'ALBUM_HAVEN_TRACKING_MIGRATION_INPUTS': str(path)})


def test_explicit_empty_external_path_is_not_absent():
    with pytest.raises((AssertionError, ValueError, OSError)):
        support.proposal_inputs({'ALBUM_HAVEN_TRACKING_MIGRATION_INPUTS': ''})


def test_hardlinked_external_input_is_rejected(tmp_path, public_payload):
    import os
    path = tmp_path / 'input.json'
    path.write_text(json.dumps(public_payload), encoding='utf-8')
    os.link(path, tmp_path / 'second-name.json')
    assert path.stat().st_nlink == 2
    with pytest.raises((AssertionError, ValueError, OSError)):
        support.proposal_inputs({'ALBUM_HAVEN_TRACKING_MIGRATION_INPUTS': str(path)})


@pytest.mark.parametrize('kind', ['leaf-link', 'ancestor-link', 'parent-traversal'])
def test_external_path_must_equal_its_canonical_identity(tmp_path, public_payload, monkeypatch, kind):
    # Logical path contract only; real Windows reparse attacks belong to the
    # explicitly required native gate, not this model.
    path = tmp_path / 'input.json'
    path.write_text(json.dumps(public_payload), encoding='utf-8')
    original_resolve = Path.resolve
    other = tmp_path / 'other.json'
    if kind == 'ancestor-link':
        other = tmp_path.parent / 'other-parent' / path.name
    if kind == 'parent-traversal':
        subdir = tmp_path / 'subdir'
        subdir.mkdir()
        path = subdir / '..' / path.name
    else:
        def resolve(actual, *args, **kwargs):
            return other if actual == path else original_resolve(actual, *args, **kwargs)
        monkeypatch.setattr(Path, 'resolve', resolve)
    with pytest.raises((AssertionError, ValueError, OSError)):
        support.proposal_inputs({'ALBUM_HAVEN_TRACKING_MIGRATION_INPUTS': str(path)})
