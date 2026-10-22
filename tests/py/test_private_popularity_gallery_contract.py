"""G1 independent actual codec/normalizer tests. Authored, not executed."""
from copy import deepcopy
import base64
import json
import pytest
from starlette.datastructures import QueryParams
from music_app.services.private_popularity_search_cursor import PopularitySearchCodec
from music_app.services.gallery_scope import normalize_visible_categories
from music_app.services.private_popularity_search_postgres import normalize_popularity_album_command, PostgresPopularitySearch
from music_app.services.private_search_contract import PrivateSearchError, normalize_private_search_request

SECRET = 'independent-gallery-contract-secret-20261018'
NOW = 1700000000


def receipt(kind='album-publication'):
    album = kind.startswith('album-')
    value = dict(version=2 if album else 1, kind=kind, scope_digest='a'*64,
        evidence_digest='b'*64, offset=1 if kind.endswith('page') else 0,
        limit=2, issued_at=NOW, expires_at=NOW+1800, query=':popular',
        visibility={'gallery_scope':'all','categories':sorted(normalize_visible_categories([], 'all'))})
    if album: value['presentation'] = 'albums'
    return value


def rejected(call, status=400):
    with pytest.raises(PrivateSearchError) as caught: call()
    assert caught.value.status_code == status


@pytest.mark.parametrize('kind', ['page','publication','album-page','album-publication'])
def test_actual_codec_exact_family_and_original_lifetime(kind):
    codec = PopularitySearchCodec(SECRET)
    value = receipt(kind)
    token = codec.encode(value, kind, NOW)
    assert codec.decode(token, kind, NOW+1799) == value
    for other in {'page','publication','album-page','album-publication'} - {kind}:
        rejected(lambda: codec.decode(token, other, NOW))
    rejected(lambda: codec.decode(token, kind, NOW+1800), 409)
    for key in value:
        invalid = dict(value); invalid.pop(key)
        rejected(lambda: codec.encode(invalid, kind, NOW))
    rejected(lambda: codec.encode({**value,'extra':None}, kind, NOW))
    assert set(value) == {'version','kind','scope_digest','evidence_digest','offset','limit',
        'issued_at','expires_at','query','visibility'} | ({'presentation'} if kind.startswith('album-') else set())


@pytest.mark.parametrize('field,value', [('version',True),('version',2.0),('offset',False),
    ('limit',1.0),('issued_at',True),('expires_at',NOW+1800.0),('presentation','tracks'),
    ('scope_digest','A'*64),('query','\ud800'),('visibility',{'gallery_scope':'all','categories':['z','a']})])
def test_v2_strict_scalar_and_visibility_validation(field,value):
    codec = PopularitySearchCodec(SECRET)
    rejected(lambda: codec.encode({**receipt(),field:value},'album-publication',NOW))


def test_canonical_encrypted_encoding_and_duplicate_json():
    codec = PopularitySearchCodec(SECRET)
    token = codec.encode(receipt(), 'album-publication', NOW)
    rejected(lambda: codec.decode(token+'=', 'album-publication', NOW))
    rejected(lambda: codec.decode(' '+token, 'album-publication', NOW))
    raw = json.dumps(receipt())[:-1] + ',"version":2}'
    duplicate = codec._cipher('album-publication').encrypt(raw.encode()).decode()
    rejected(lambda: codec.decode(duplicate,'album-publication',NOW))
    raw = base64.urlsafe_b64decode(token)
    assert base64.urlsafe_b64encode(raw).decode() == token



@pytest.mark.parametrize('query', [':popular', ':tracks genre:jazz :popular per_artist:1'])
def test_presentation_preserves_query_without_rewriting_track_domain(query):
    for presentation in ['tracks','albums']:
        value = normalize_private_search_request(QueryParams([('q',query),('search_presentation',presentation)]))
        assert value.query == query and value.presentation == presentation
        assert value.criteria.as_payload()['predicate_domain'] == 'tracks'
    assert normalize_private_search_request(QueryParams({'q':query})).presentation == 'tracks'


def command(kind='album-publication'):
    field = 'album_ref' if kind == 'album-publication' else 'row_ref'
    prefix = 'popular_album_' if kind == 'album-publication' else 'popular_'
    return {'source':{'kind':kind,'result_token':'abc',field:prefix+'a'*64},
        'native_album_ref':'native album', 'page_key':'search-detail-page-1',
        'rows':[{'slot':'search-detail-row-1','inventory_track_ref':'inventory-track:1:2'}]}


@pytest.mark.parametrize('kind', ['album-publication','track-publication'])
def test_source_union_and_bigint_identity_are_exact(kind):
    value = command(kind)
    assert normalize_popularity_album_command(value, operation='matches') == value
    for key in value:
        bad = deepcopy(value); bad.pop(key)
        rejected(lambda: normalize_popularity_album_command(bad, operation='matches'))
    bad = deepcopy(value); bad['source']['extra'] = None
    rejected(lambda: normalize_popularity_album_command(bad,operation='matches'))
    for identity in ['inventory-track:01:2','inventory-track:1:0','inventory-track:1:2.0',
                     'inventory-track:1:+2','inventory-track:1:２']:
        bad = deepcopy(value); bad['rows'][0]['inventory_track_ref'] = identity
        rejected(lambda: normalize_popularity_album_command(bad,operation='matches'))
    bad = deepcopy(value); bad['rows'][0]['inventory_track_ref'] = 'inventory-track:1:9223372036854775808'
    rejected(lambda: normalize_popularity_album_command(bad,operation='matches'),422)


@pytest.mark.parametrize('mutation', ['empty','101','duplicate_slot','duplicate_ref'])
def test_bounded_rows_and_uniqueness(mutation):
    value = command()
    second = {'slot':'search-detail-row-2','inventory_track_ref':'inventory-track:1:3'}
    if mutation == 'empty': value['rows'] = []
    elif mutation == '101': value['rows'] *= 101
    else:
        second['slot' if mutation == 'duplicate_slot' else 'inventory_track_ref'] = value['rows'][0]['slot' if mutation == 'duplicate_slot' else 'inventory_track_ref']
        value['rows'].append(second)
    rejected(lambda: normalize_popularity_album_command(value,operation='matches'),422)


@pytest.mark.parametrize('now', [NOW,NOW+1799])
def test_lifetime_uses_original_pair_and_exact_authoritative_now(now):
    assert PostgresPopularitySearch._lifetime(receipt(), now) == {
        'issued_at':NOW,'expires_at':NOW+1800,'server_now':now}


@pytest.mark.parametrize('now', [True,float(NOW),NOW-1,NOW+1800])
def test_lifetime_never_accepts_invalid_or_expired_clock(now):
    rejected(lambda: PostgresPopularitySearch._lifetime(receipt(),now),409)


@pytest.mark.parametrize('field,value',[('native_album_ref','x'*16385),('native_album_ref','\ud800'),
    ('native_album_ref','a\0b'),('page_key','search-detail-page-0'),
    ('page_key','search-detail-page-01'),('page_key','search-detail-page-'+'1'*80)])
def test_native_reference_and_page_key_bounds(field,value):
    bad = command(); bad[field] = value
    rejected(lambda: normalize_popularity_album_command(bad,operation='matches'))


def test_target_exact_keys_and_actual_opaque_reference_shape():
    value = {'result_token':'abc','album_ref':'popular_album_'+'a'*64}
    assert normalize_popularity_album_command(value,operation='target') == value
    for bad in [{**value,'extra':None},{**value,'album_ref':'popular_'+'a'*64},
                {**value,'album_ref':'popular_album_'+'A'*64},{**value,'result_token':'x'*4097}]:
        rejected(lambda: normalize_popularity_album_command(bad,operation='target'))


def test_valid_max_length_utf8_query_round_trips_without_truncation():
    codec = PopularitySearchCodec(SECRET)
    value = receipt()
    prefix = ':popular artist:'
    value['query'] = prefix + '𐐀' * (200-len(prefix))
    assert len(value['query']) == 200
    # Deseret letters are astral word characters; emoji-only predicates are
    # rejected by the actual shared search-term normalizer.
    # Real query and canonical visibility validation remain enabled.
    encoded = codec.encode(value,'album-publication',NOW)
    assert codec.decode(encoded,'album-publication',NOW) == value
    raw = json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',', ':'),allow_nan=False).encode('utf-8')
    # Independent Fernet framing calculation, not a substitute codec/validator.
    cipher_bytes = 57 + 16 * (len(raw)//16 + 1)
    assert len(encoded.encode('ascii')) == 4 * ((cipher_bytes+2)//3)
    assert len(encoded) <= 4096


def test_oversized_token_is_rejected_before_cipher_access(monkeypatch):
    codec = PopularitySearchCodec(SECRET)
    calls = []
    def forbidden(*args,**kwargs):
        calls.append(True)
        raise AssertionError('Oversized transport token reached cipher')
    monkeypatch.setattr(codec,'_cipher',forbidden)
    rejected(lambda: codec.decode('A'*4097,'album-publication',NOW))
    assert calls == []
