"""Pure codec specifications only; no DB, policy or runtime-authority proof.

Authentication of cursor bytes does not establish a live actor, friend,
subject mapping, receipt, expiry or resource permission. Those checks belong
to the guarded reader and are not simulated by these codec tests.
"""
import base64
import json

import pytest

from music_app.services.private_listener_search_cursor import (
    decode_listener_cursor, encode_listener_cursor,
)
from music_app.services.social_cursors import (
    _cipher, decode_search_cursor, decode_social_cursor, encode_search_cursor,
    encode_social_cursor,
)


SECRET = 'listener-cursor-pure-specification-secret-0001'
SNAPSHOT = 'A' * 43
MAX_BIGINT = 9223372036854775807


def scope(**changes):
    return {
        'actor_account_id': 41, 'actor_session_id': 81, 'library_id': 73,
        'context_ref': 'a' * 64, 'username': 'maya',
        'account_ref': '20000000-0000-4000-8000-000000000001',
        'audience': 'friend', 'relationship_revision': 5, **changes,
    }


def payload(**changes):
    return {'version': 'listener-history-v1', 'scope': scope(),
            'snapshot_ref': SNAPSHOT, 'page': 2, **changes}


def signed(value):
    return signed_bytes(json.dumps(value, separators=(',', ':')).encode())


def signed_bytes(value):
    # Authenticated malformed payloads exercise shape checks after decryption.
    return _cipher(SECRET).encrypt(value).decode('ascii')


def rejected(token):
    with pytest.raises(ValueError, match=r'^Invalid Listener cursor\.$'):
        decode_listener_cursor(token, secret=SECRET)


@pytest.mark.parametrize('audience,revision', [('own', None), ('friend', 1), ('friend', MAX_BIGINT)])
@pytest.mark.parametrize('page', [2, 100, 10**18])
def test_round_trip_preserves_exact_dialect_and_scope(audience, revision, page):
    current = scope(audience=audience, relationship_revision=revision)
    token = encode_listener_cursor(SNAPSHOT, page, secret=SECRET, scope=current)
    assert len(token) <= 4096
    assert decode_listener_cursor(token, secret=SECRET) == payload(scope=current, page=page)
    assert json.loads(_cipher(SECRET).decrypt(token.encode('ascii'))) == payload(scope=current, page=page)


def test_none_is_the_only_absent_continuation():
    assert decode_listener_cursor(None, secret=SECRET) is None
    for value in ('', False, 0, [], {}):
        rejected(value)


@pytest.mark.parametrize('page', [None, True, False, 0, 1, -1, 2.0, '2', 10**18 + 1,
                                  float('nan'), float('inf'), [], {}])
def test_page_must_be_an_actual_bounded_continuation_integer(page):
    rejected(signed(payload(page=page)))
    with pytest.raises(ValueError, match=r'^Invalid Listener cursor\.$'):
        encode_listener_cursor(SNAPSHOT, page, secret=SECRET, scope=scope())


@pytest.mark.parametrize('key', ['actor_account_id', 'actor_session_id', 'library_id'])
@pytest.mark.parametrize('value', [True, False, None, 0, -1, 1.0, '1', MAX_BIGINT + 1, [], {}])
def test_ids_reject_boolean_noninteger_and_out_of_range_values(key, value):
    invalid = scope(**{key: value})
    rejected(signed(payload(scope=invalid)))
    with pytest.raises(ValueError, match=r'^Invalid Listener cursor\.$'):
        encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=invalid)


def test_bigint_upper_boundary_is_preserved_without_coercion():
    current = scope(actor_account_id=MAX_BIGINT, actor_session_id=MAX_BIGINT, library_id=MAX_BIGINT)
    token = encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=current)
    assert decode_listener_cursor(token, secret=SECRET)['scope'] == current


@pytest.mark.parametrize('value', [None, True, '', 'A' * 64, 'a' * 63, 'a' * 65,
                                  'g' * 64, 'a' * 63 + '\n', [], {}])
def test_context_ref_is_exact_lowercase_hex64(value):
    rejected(signed(payload(scope=scope(context_ref=value))))


@pytest.mark.parametrize('value', [None, True, '', 'ma', 'Maya', ' maya', 'maya ', '@maya',
                                  'may a', 'm\u00e1ya', 'a' * 65, 'maya\n', [], {}])
def test_username_must_already_be_canonical_for_auth_normalizer(value):
    rejected(signed(payload(scope=scope(username=value))))


@pytest.mark.parametrize('username', ['may', 'maya_1', 'a.b-c', 'a' * 64])
def test_canonical_auth_usernames_are_preserved(username):
    current = scope(username=username)
    token = encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=current)
    assert decode_listener_cursor(token, secret=SECRET)['scope']['username'] == username


@pytest.mark.parametrize('value', [None, True, '', 'not-a-uuid',
    'ABCDEF00-0000-4000-8000-000000000001', 'abcdef00000040008000000000000001',
    '{abcdef00-0000-4000-8000-000000000001}', 'urn:uuid:abcdef00-0000-4000-8000-000000000001',
    'abcdef00-0000-4000-8000-000000000001\n', [], {}])
def test_account_ref_is_a_canonical_uuid_string(value):
    rejected(signed(payload(scope=scope(account_ref=value))))


def test_lowercase_uuid_letters_are_accepted():
    current = scope(account_ref='abcdef00-0000-4000-8000-000000000001')
    token = encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=current)
    assert decode_listener_cursor(token, secret=SECRET)['scope'] == current


@pytest.mark.parametrize('audience,revision', [
    ('own', 0), ('own', 1), ('own', False), ('own', ''),
    ('friend', None), ('friend', 0), ('friend', -1), ('friend', True),
    ('friend', 1.0), ('friend', '1'), ('friend', MAX_BIGINT + 1),
    ('friend', []), ('friend', {}), ('public', None), ('Own', None),
    ('Friend', 1), (None, None), (True, None), ([], None), ({}, None),
])
def test_audience_and_relationship_revision_have_exact_coupling(audience, revision):
    rejected(signed(payload(scope=scope(audience=audience, relationship_revision=revision))))


@pytest.mark.parametrize('snapshot_ref', [None, True, '', 'A' * 42, 'A' * 44, 'A' * 43 + '=',
    'A' * 42 + '+', 'A' * 42 + '/', 'A' * 42 + '\n', 'A' * 42 + 'B', [], {}])
def test_snapshot_requires_token43_and_canonical_hash_opaque_token_validation(snapshot_ref):
    rejected(signed(payload(snapshot_ref=snapshot_ref)))
    with pytest.raises(ValueError, match=r'^Invalid Listener cursor\.$'):
        encode_listener_cursor(snapshot_ref, 2, secret=SECRET, scope=scope())


@pytest.mark.parametrize('key', ['version', 'scope', 'snapshot_ref', 'page'])
def test_every_payload_key_is_required(key):
    value = payload()
    del value[key]
    rejected(signed(value))


@pytest.mark.parametrize('key', list(scope()))
def test_every_scope_key_is_required(key):
    current = scope()
    del current[key]
    rejected(signed(payload(scope=current)))


@pytest.mark.parametrize('value', [None, True, 1, 'listener-history-v1', [], {}])
def test_nonpayloads_and_empty_payloads_are_rejected(value):
    rejected(signed(value))


@pytest.mark.parametrize('value', [None, True, 1, 'friend', []])
def test_scope_must_be_a_dictionary(value):
    rejected(signed(payload(scope=value)))


@pytest.mark.parametrize('version', [None, True, 1, 2, '1', 'listener-history-v2', 'own-love-v1',
                                     'listener-history-v1 ', [], {}])
def test_version_is_an_exact_separate_string_dialect(version):
    rejected(signed(payload(version=version)))


def test_extra_fields_are_not_ignored_at_either_level():
    rejected(signed(payload(extra=True)))
    rejected(signed(payload(scope=scope(target_account_id=42))))
    with pytest.raises(ValueError, match=r'^Invalid Listener cursor\.$'):
        encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=scope(extra=True))


def test_duplicate_json_keys_are_rejected_at_both_levels():
    text = json.dumps(payload(), separators=(',', ':'))
    rejected(signed_bytes((text[:-1] + ',"page":2}').encode()))
    rejected(signed_bytes(text.replace('"actor_account_id":41',
        '"actor_account_id":41,"actor_account_id":41').encode()))


@pytest.mark.parametrize('raw', [b'', b'{', b'null', b'\xff', b'{} trailing', b'[' * 1500 + b']' * 1500])
def test_authenticated_malformed_json_is_rejected(raw):
    rejected(signed_bytes(raw))


@pytest.mark.parametrize('token', ['A' * 4097, 'A' * 4096, 'not-a-fernet-token', 'gAAAAA==',
                                  '\n', '\u2603', b'ciphertext', 123, True, [], {}])
def test_malformed_ciphertext_is_rejected(token):
    rejected(token)


def test_ciphertext_requires_canonical_base64_and_no_surrounding_whitespace():
    token = encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=scope())
    for invalid in (' ' + token, token + '\n', token + '=', token + '!', '+' + token, '/' + token):
        rejected(invalid)


def test_tampered_ciphertext_and_wrong_secret_are_rejected():
    token = encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=scope())
    raw = bytearray(base64.urlsafe_b64decode(token))
    raw[-1] ^= 1
    rejected(base64.urlsafe_b64encode(raw).decode('ascii'))
    with pytest.raises(ValueError, match=r'^Invalid Listener cursor\.$'):
        decode_listener_cursor(token, secret='different-listener-secret-at-least-32-bytes')


def test_missing_secret_stays_a_configuration_failure():
    token = encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=scope())
    with pytest.raises(RuntimeError):
        encode_listener_cursor(SNAPSHOT, 2, secret='', scope=scope())
    with pytest.raises(RuntimeError):
        decode_listener_cursor(token, secret='')


def test_social_and_search_dialects_cannot_be_used_as_listener_continuations():
    rejected(encode_social_cursor(1, secret=SECRET, scope=[]))
    rejected(encode_search_cursor({'anchor': None, 'pending': None}, secret=SECRET,
        scope=['own-love-v1'], kind='tracks',
        selection={'state': 'all_artists', 'artist': None, 'witness': None, 'pending': None}))


def test_listener_dialect_is_not_an_existing_social_or_search_cursor():
    token = encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=scope())
    with pytest.raises(ValueError):
        decode_social_cursor(token, secret=SECRET, scope=[])
    with pytest.raises(ValueError):
        decode_search_cursor(token, secret=SECRET)


def test_codec_preserves_bound_values_without_claiming_current_authority():
    # No DB or policy owner is invoked. The reader must compare these values
    # to current server-side facts; successful decoding is only syntax proof.
    current = scope(actor_account_id=99, actor_session_id=100, library_id=101,
        context_ref='b' * 64, username='someone_else',
        account_ref='30000000-0000-4000-8000-000000000001', relationship_revision=6)
    token = encode_listener_cursor(SNAPSHOT, 2, secret=SECRET, scope=current)
    assert decode_listener_cursor(token, secret=SECRET)['scope'] == current
