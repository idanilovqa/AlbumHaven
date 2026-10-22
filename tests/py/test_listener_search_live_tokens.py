"""Authenticated live token schemas and independent raw dialect regressions."""
from copy import deepcopy
import json
import pytest
from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.private_listener_search_cursor import (
    encode_listener_search_token as encode, decode_listener_search_token as decode,
    encode_listener_cursor, decode_listener_cursor, MAX_SAFE_INTEGER,
)
from music_app.services.social_cursors import _cipher

SECRET = 'listener-token-test-only-secret-20261018'


def scope(filtered=False):
    return {'actor_account_id':1,'actor_session_id':2,'library_id':3,'context_ref':'a'*64,
        'username':'maya','account_ref':'00000000-0000-4000-8000-000000000001',
        'audience':'friend','relationship_revision':1,'love_include':['loved'] if filtered else [],
        'love_exclude':[],'page_size':100,'love_revision':0 if filtered else None,
        'taste_policy_digest':'b'*64 if filtered else None}


def payload(purpose='cursor', filtered=False):
    value = {'version':'listener-search-v1','purpose':purpose,'scope':scope(filtered),
             'snapshot_ref':issue_opaque_token().raw}
    if purpose == 'cursor':
        value['position'] = {'after_ordinal':100,'matched_before':0 if filtered else 100}
    return value


def encrypt(value):
    return _cipher(SECRET).encrypt(json.dumps(value,separators=(',',':')).encode()).decode()


@pytest.mark.parametrize('purpose',['cursor','result'])
@pytest.mark.parametrize('filtered',[False,True])
def test_round_trip_exact_keys_and_no_row_authority(purpose,filtered):
    value = payload(purpose,filtered)
    encoded = encode(value['snapshot_ref'],secret=SECRET,scope=value['scope'],purpose=purpose,
                     position=value.get('position'))
    assert decode(encoded,secret=SECRET,purpose=purpose) == value
    assert len(encoded) <= 4096 and value['snapshot_ref'] not in encoded
    for forbidden in ('row_refs','allowed_actions','native_ids','prelock','hint','path'):
        assert forbidden not in value and forbidden not in value['scope']


@pytest.mark.parametrize('purpose',['cursor','result'])
@pytest.mark.parametrize('layer',['top','scope'])
@pytest.mark.parametrize('mutation',['missing','extra'])
def test_every_key_is_exact(purpose,layer,mutation):
    initial = payload(purpose)
    target = initial if layer == 'top' else initial['scope']
    for key in tuple(target):
        value = deepcopy(initial)
        changed = value if layer == 'top' else value['scope']
        if mutation == 'missing':
            del changed[key]
        else:
            changed['unexpected_' + key] = changed[key]
        with pytest.raises(ValueError):
            decode(encrypt(value),secret=SECRET,purpose=purpose)


@pytest.mark.parametrize('field,bad', [
    ('actor_account_id',True),('actor_account_id',0),('actor_session_id',-1),('library_id',2**63),
    ('context_ref','A'*64),('username','MAYA'),('username','ｍaya'),('account_ref','bad'),
    ('audience','public'),('relationship_revision',None),('page_size',True),('page_size',0),
    ('page_size',101),('love_include',['off']),('love_include',['loved','loved']),
    ('love_include',['obsessed','loved']),('love_exclude',['unknown']),
    ('love_revision',-1),('love_revision',True),('taste_policy_digest','A'*64),
])
def test_invalid_authenticated_scope_rejected(field,bad):
    value = payload(filtered=True)
    value['scope'][field] = bad
    with pytest.raises(ValueError):
        decode(encrypt(value),secret=SECRET,purpose='cursor')


@pytest.mark.parametrize('purpose',['cursor','result'])
def test_purpose_cannot_be_reused_and_raw_tokens_are_distinct(purpose):
    value = payload(purpose)
    token = encrypt(value)
    with pytest.raises(ValueError):
        decode(token,secret=SECRET,purpose='result' if purpose=='cursor' else 'cursor')
    with pytest.raises(ValueError):
        decode_listener_cursor(token,secret=SECRET)
    raw_scope = {k:v for k,v in scope().items() if k not in {
        'love_include','love_exclude','page_size','love_revision','taste_policy_digest'}}
    raw = encode_listener_cursor(value['snapshot_ref'],2,secret=SECRET,scope=raw_scope)
    assert decode_listener_cursor(raw,secret=SECRET)['page'] == 2
    with pytest.raises(ValueError):
        decode(raw,secret=SECRET,purpose=purpose)


@pytest.mark.parametrize('position',[{}, {'after_ordinal':0,'matched_before':0},
    {'after_ordinal':True,'matched_before':0}, {'after_ordinal':1,'matched_before':2},
    {'after_ordinal':1,'matched_before':-1}, {'after_ordinal':MAX_SAFE_INTEGER+1,'matched_before':0},
    {'after_ordinal':1,'matched_before':0,'page':2}])
def test_cursor_position_is_exact_bounded_and_positive(position):
    value = payload(filtered=True)
    value['position'] = position
    with pytest.raises(ValueError):
        decode(encrypt(value),secret=SECRET,purpose='cursor')


def test_history_only_requires_null_evidence_and_exact_cumulative_count():
    for field,value in [('love_revision',0),('taste_policy_digest','a'*64)]:
        data = payload()
        data['scope'][field] = value
        with pytest.raises(ValueError):
            decode(encrypt(data),secret=SECRET,purpose='cursor')
    data = payload()
    data['position']['matched_before'] = 99
    with pytest.raises(ValueError):
        decode(encrypt(data),secret=SECRET,purpose='cursor')


@pytest.mark.parametrize('token',['',None,'%', 'a'*4097,'a b','☃',True,{}])
def test_malformed_result_tokens_never_start_a_query(token):
    with pytest.raises(ValueError):
        decode(token,secret=SECRET,purpose='result')


def test_only_absent_cursor_starts_query_wrong_key_and_duplicate_json_fail():
    assert decode(None,secret=SECRET,purpose='cursor') is None
    data = payload()
    with pytest.raises(ValueError):
        decode(encrypt(data),secret='different-listener-test-only-secret-20261018',purpose='cursor')
    raw = json.dumps(data)[:-1] + ',"version":"listener-search-v1"}'
    duplicate = _cipher(SECRET).encrypt(raw.encode()).decode()
    with pytest.raises(ValueError):
        decode(duplicate,secret=SECRET,purpose='cursor')


def test_result_encoder_refuses_position_and_cursor_encoder_refuses_missing_position():
    value = payload()
    with pytest.raises(ValueError):
        encode(value['snapshot_ref'],secret=SECRET,scope=value['scope'],purpose='result',position=value['position'])
    with pytest.raises(ValueError):
        encode(value['snapshot_ref'],secret=SECRET,scope=value['scope'],purpose='cursor')
