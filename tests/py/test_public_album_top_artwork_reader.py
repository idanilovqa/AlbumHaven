"""Pure D contracts and explicitly controlled service seams, not SQL proof.

The genuine database composition is in test_public_album_top_artwork_reader_postgres.
These fixtures supply no acquisition proof, publishing authority or capability.
"""
from contextlib import contextmanager
from copy import deepcopy
from hashlib import sha256
from uuid import UUID

import pytest

from music_app.services import public_album_tops as projection
from music_app.services import public_album_tops_postgres as reader
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy import RequestOrigin

SHARE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
PUBLICATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
ASSET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
ORIGIN = 'https://public.example.test'
PNG = b'\x89PNG\r\n\x1a\nsynthetic-signature-and-digest-only-not-decoded'
TOP = {'ref': OTHER, 'library_id': 3, 'owner_account_id': 4, 'deleted_at': None}
PUBLIC = {'ref': PUBLICATION, 'contract_version': 2, 'publication_revision': 7,
          'item_count': 1, 'title': 'Approved Top', 'description': ''}
METADATA_SOURCES = [{'selected_local_album_id': 31, 'selected_source_ref': OTHER,
                     'selected_library_root_id': 41}]
ARTWORK_SOURCES = [{'selected_local_album_id': 31, 'artwork_root_id': 42}]


def rejected(action, status=404):
    with pytest.raises(AlbumTopError) as error:
        action()
    assert (error.value.code, error.value.status_code) == ('unavailable', status)


def retained_item(**changes):
    return {'item_ref': ITEM, 'catalog_ref': OTHER, 'presentation_ref': PUBLICATION,
            'original_position': 8, 'curator_position': 1, 'contract_version': 1,
            'title': 'Album', 'artist': 'Artist', 'year': 2001,
            'included': True, 'asset_ref': ASSET, **changes}


def asset(**changes):
    return {'ref': ASSET, 'sanitizer_contract': 1, 'mime_type': 'image/png',
            'width': 1, 'height': 256, 'byte_length': len(PNG), 'stored_length': len(PNG),
            'content_digest': sha256(PNG).hexdigest(), 'png': PNG, **changes}


def dto():
    return {**projection.snapshot_header(PUBLIC, SHARE), 'title': 'Approved Top', 'description': '',
            'items': [projection.snapshot_item(retained_item(), share_ref=SHARE, publication_contract_version=2)],
            'next_cursor': None, 'allowed_actions': {'can_read': True, 'can_open_item': True}}


@pytest.mark.parametrize('version', [1, 2])
def test_header_discriminator_is_added_only_for_v2_and_presentation_stays_v1(version):
    result = projection.snapshot_header({**PUBLIC, 'contract_version': version}, SHARE)
    assert result == {'share_ref': SHARE, 'publication_ref': PUBLICATION, 'publication_revision': '7',
                      **({'publication_contract_version': 2} if version == 2 else {})}
    row = projection.snapshot_item(retained_item(), share_ref=SHARE, publication_contract_version=version)
    assert row['artwork_ref'] == (ASSET if version == 2 else None)
    assert set(row) == {'item_ref', 'original_position', 'curator_position', 'album_ref', 'presentation_ref',
                        'title', 'artist', 'year', 'artwork_ref', 'details_path'}
    rejected(lambda: projection.snapshot_item(retained_item(contract_version=2), share_ref=SHARE,
                                              publication_contract_version=version))


@pytest.mark.parametrize('version', [None, True, False, '2', 0, 3, 2.0])
def test_publication_version_never_uses_coercion(version):
    rejected(lambda: projection.snapshot_header({**PUBLIC, 'contract_version': version}, SHARE))
    rejected(lambda: projection.snapshot_item(retained_item(), share_ref=SHARE,
                                              publication_contract_version=version))


@pytest.mark.parametrize('included,ref', [(False, None), (True, ASSET), (True, UUID(ASSET))])
def test_exact_included_excluded_projection_never_emits_retained_private_fields(included, ref):
    row = retained_item(included=included, asset_ref=ref, private_path='/private/sentinel',
                        proof_value_digest='a' * 64, artwork_root_id=42, source_stamp={'private': True})
    result = projection.snapshot_item(row, share_ref=SHARE, publication_contract_version=2)
    assert result['artwork_ref'] == (ASSET if included else None)
    assert 'sentinel' not in str(result) and 'proof' not in str(result) and 'source_stamp' not in result


@pytest.mark.parametrize('included,ref', [(1, ASSET), (None, None), ('true', ASSET), (True, None),
                                        (True, ASSET.upper()), (False, ASSET)])
def test_invalid_artwork_mapping_fails_projection(included, ref):
    rejected(lambda: projection.snapshot_item(retained_item(included=included, asset_ref=ref),
                                              share_ref=SHARE, publication_contract_version=2))


def test_public_artwork_path_contains_only_four_canonical_identities():
    arguments = dict(share_ref=SHARE, publication_ref=PUBLICATION, item_ref=ITEM, asset_ref=ASSET)
    assert projection.public_artwork_path(**arguments) == (
        f'/public/album-tops/{SHARE}/publications/{PUBLICATION}/items/{ITEM}/artwork/{ASSET}.png')
    for field in arguments:
        for invalid in [arguments[field].upper(), arguments[field].replace('-', ''),
                        '../' + arguments[field], arguments[field] + '?token=x', UUID(arguments[field]), None]:
            rejected(lambda: projection.public_artwork_path(**{**arguments, field: invalid}))


@pytest.mark.parametrize('head_only', [False, True])
def test_png_exact_projection_and_limits(head_only):
    result = projection.snapshot_png(asset(), head_only=head_only)
    assert result == {'content_type': 'image/png', 'content_length': len(PNG),
                      'body': b'' if head_only else PNG}
    maximum = b'\x89PNG\r\n\x1a\n' + b'x' * (327680 - 8)
    assert projection.snapshot_png(asset(png=maximum, byte_length=len(maximum), stored_length=len(maximum),
        content_digest=sha256(maximum).hexdigest()), head_only=head_only)['content_length'] == 327680


@pytest.mark.parametrize('field,bad', [('sanitizer_contract', True), ('sanitizer_contract', 2),
    ('mime_type', 'image/jpeg'), ('mime_type', 'IMAGE/PNG'), ('width', True), ('width', 0), ('width', 257),
    ('height', 0), ('height', 257), ('byte_length', True), ('byte_length', 0), ('byte_length', 327681),
    ('stored_length', 0), ('stored_length', len(PNG) + 1), ('content_digest', 'A' * 64),
    ('content_digest', 'a' * 63), ('ref', ASSET.upper())])
@pytest.mark.parametrize('head_only', [False, True])
def test_png_malformed_scalar_metadata_fails_identically_for_get_and_head(field, bad, head_only):
    rejected(lambda: projection.snapshot_png(asset(**{field: bad}), head_only=head_only))


@pytest.mark.parametrize('bad', [None, bytearray(PNG), memoryview(PNG), PNG[:-1], b'x' * len(PNG)])
def test_get_rejects_wrong_body_type_length_signature_and_hash(bad):
    rejected(lambda: projection.snapshot_png(asset(png=bad), head_only=False))
    rejected(lambda: projection.snapshot_png(asset(content_digest='0' * 64), head_only=False))


def test_head_never_reads_body_or_hashes_it(monkeypatch):
    class Header(dict):
        def get(self, key, *args):
            assert key != 'png', 'HEAD accessed body'
            return super().get(key, *args)
        def __getitem__(self, key):
            assert key != 'png', 'HEAD accessed body'
            return super().__getitem__(key)
    def no_hash(*args, **kwargs):
        raise AssertionError('HEAD hashed image data')
    monkeypatch.setattr(projection.hashlib, 'sha256', no_hash)
    value = Header(asset()); value.pop('png')
    assert projection.snapshot_png(value, head_only=True)['body'] == b''


@pytest.mark.parametrize('change', [
    lambda value: value.update(publication_contract_version=True),
    lambda value: value.update(publication_contract_version='2'),
    lambda value: value.update(publication_contract_version=1),
    lambda value: value.pop('publication_contract_version'),
    lambda value: value.update(context_ref='private'),
    lambda value: value['items'][0].update(artwork_url='https://private.example/'),
    lambda value: value['items'][0].update(artwork_ref='https://private.example/'),
    lambda value: value['allowed_actions'].update(can_play=True),
    lambda value: value['allowed_actions'].update(can_read=1),
    lambda value: value.update(items=value['items'] * 2),
])
def test_v2_positive_dto_rejects_mixed_or_extra_shapes(change):
    value = dto(); change(value)
    with pytest.raises(AlbumTopError):
        projection.validate_snapshot_v2(value, share_ref=SHARE, item_ref=None, limit=50)


@pytest.mark.parametrize('rows', [[], [retained_item(included=False, asset_ref=None)]])
def test_zero_and_all_excluded_are_still_explicit_v2(rows):
    value = dto()
    value['items'] = [projection.snapshot_item(row, share_ref=SHARE, publication_contract_version=2) for row in rows]
    assert projection.validate_snapshot_v2(value, share_ref=SHARE, item_ref=None, limit=50) is value
    assert value['publication_contract_version'] == 2


def test_encoded_response_bound_measures_escaped_bytes_not_character_count():
    assert projection.MAX_PUBLIC_RESPONSE_BYTES == 8 * 1024 * 1024
    projection.bound_snapshot_response({'text': '\U0001f3b5' * 1000})
    rejected(lambda: projection.bound_snapshot_response({'text': '\U0001f3b5' * 700000}), 503)


class Result:
    def __init__(self, value): self.value = value
    def fetchone(self): return self.value
    def fetchall(self): return self.value


class Seam:
    """Controlled transaction ordering only; deliberately not a SQL emulator."""
    def __init__(self):
        self.events = []
        self.asset = asset()
        self.publication = deepcopy(PUBLIC)
        self.exit_error = False
        self.final_denial = False
        self.policy_calls = 0
        self.config = {'ALBUM_HAVEN_APP_DATABASE_URL': 'synthetic-unit-only',
                       'ALBUM_HAVEN_PUBLIC_SHARING_ENABLED': True,
                       'ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN': ORIGIN}
        self.service = reader.PostgresPublicAlbumTopsService(self.config, connect=self.connect)
        self.service._discover = lambda connection, share: TOP
        self.service._locked_publication = lambda connection, discovered, share, constraints: (TOP, self.publication)
        self.service._retained_manifest = lambda connection, top, publication: (1, METADATA_SOURCES, ARTWORK_SOURCES)
        self.service._owner = self.owner
    def owner(self, connection, top, sources, constraints, artwork_sources=()):
        assert sources == METADATA_SOURCES and artwork_sources == ARTWORK_SOURCES
        self.policy_calls += 1; self.events.append('policy')
        if self.final_denial and self.policy_calls == 2:
            raise AlbumTopError('unavailable', 404)
    def execute(self, sql, params=None):
        self.events.append(('sql', sql, params))
        if sql in (reader._ASSET_GET, reader._ASSET_HEAD):
            assert params == (PUBLICATION, ITEM, ASSET, OTHER, 3, 4)
            return Result(self.asset)
        return Result({'item_ref': ITEM})
    @contextmanager
    def connect(self, url):
        self.events.append('enter')
        try: yield self
        finally:
            self.events.append('exit')
            if self.exit_error: raise RuntimeError('private transaction failure')
    def arguments(self):
        return dict(share_ref=SHARE, publication_ref=PUBLICATION, item_ref=ITEM, asset_ref=ASSET,
                    request_origin=RequestOrigin('network', ORIGIN))


@pytest.mark.parametrize('head_only', [False, True])
def test_service_body_validation_and_last_sql_precede_complete_final_policy(monkeypatch, head_only):
    seam = Seam(); actual = reader.snapshot_png
    def observed(value, **kwargs):
        result = actual(value, **kwargs); seam.events.append('validated'); return result
    monkeypatch.setattr(reader, 'snapshot_png', observed)
    result = seam.service.read_guest_artwork(**seam.arguments(), head_only=head_only)
    assert result['body'] == (b'' if head_only else PNG)
    assert seam.events[-3:] == ['validated', 'policy', 'exit']
    queries = [event[1] for event in seam.events if isinstance(event, tuple)]
    assert queries[-1] == (reader._ASSET_HEAD if head_only else reader._ASSET_GET)
    assert seam.policy_calls == 2


def test_head_sql_contains_scalar_length_but_no_body_projection():
    head = ' '.join(reader._ASSET_HEAD.lower().split()).split(' from ')[0]
    get = ' '.join(reader._ASSET_GET.lower().split()).split(' from ')[0]
    assert 'octet_length(a.png) as stored_length' in head
    assert 'a.png' not in head.replace('octet_length(a.png)', '')
    assert 'case when octet_length(a.png) between 1 and 327680 then a.png end as png' in get


@pytest.mark.parametrize('failure', ['final_policy', 'exit', 'wrong_generation', 'v1', 'corrupt_body'])
def test_no_artwork_result_escapes_failed_final_policy_transaction_or_binding(failure):
    seam = Seam()
    if failure == 'final_policy': seam.final_denial = True
    elif failure == 'exit': seam.exit_error = True
    elif failure == 'wrong_generation': seam.publication['ref'] = OTHER
    elif failure == 'v1': seam.publication['contract_version'] = 1
    else: seam.asset['png'] = b'x' * len(PNG)
    rejected(lambda: seam.service.read_guest_artwork(**seam.arguments(), head_only=False),
             503 if failure == 'exit' else 404)
    assert seam.events[-1] == 'exit'


def test_response_admission_is_a_fresh_transaction_header_only_and_returns_no_token():
    seam = Seam()
    assert seam.service.recheck_guest_response(**seam.arguments(), publication_contract_version=2) is None
    assert seam.events[0] == 'enter' and seam.events[-2:] == ['policy', 'exit']
    assert [entry[1] for entry in seam.events if isinstance(entry, tuple)][-1] == reader._ASSET_HEAD
    assert reader._ASSET_GET not in [entry[1] for entry in seam.events if isinstance(entry, tuple)]


@pytest.mark.parametrize('changes', [{'publication_contract_version': True}, {'publication_contract_version': 1},
    {'publication_contract_version': '2'}, {'publication_ref': OTHER}, {'item_ref': None},
    {'request_origin': RequestOrigin('network', 'https://foreign.example.test')}])
def test_response_admission_rejects_unbound_version_target_and_origin(changes):
    seam = Seam()
    arguments = {**seam.arguments(), 'publication_contract_version': 2, **changes}
    rejected(lambda: seam.service.recheck_guest_response(**arguments))


@pytest.mark.parametrize('total,included', [(0, 0), (1, 0), (1, 1)])
def test_compact_manifest_unit_contract_and_distinct_artwork_root(monkeypatch, total, included):
    stats = {'total': total, 'valid': total, 'included_count': included, 'image_bytes': included * len(PNG),
             'first': 1 if total else None, 'last': total or None}
    lineage = {'row_count': total, 'included_count': included}
    sources = deepcopy(ARTWORK_SOURCES) if included else []
    class Compact:
        def __init__(self): self.sql = []
        def execute(self, sql, params):
            self.sql.append(sql)
            assert 'source_stamp' not in sql and 'acquisition_stamp' not in sql and 'a.png' not in sql
            return Result(stats if len(self.sql) == 1 else lineage)
    connection = Compact()
    monkeypatch.setattr(reader, 'retained_artwork_sources', lambda connection, ref: sources)
    result = reader.PostgresPublicAlbumTopsService._artwork_manifest(connection, TOP, {**PUBLIC, 'item_count': total})
    assert result == sources and len(connection.sql) == 2
    for change in [{'valid': total + 1}, {'total': total + 1}, {'image_bytes': 134217729},
                   {'included_count': True}]:
        saved = deepcopy(stats); stats.update(change); connection.sql.clear()
        rejected(lambda: reader.PostgresPublicAlbumTopsService._artwork_manifest(connection, TOP,
                    {**PUBLIC, 'item_count': total}))
        stats.clear(); stats.update(saved)
    if included:
        for field in ('selected_local_album_id', 'artwork_root_id'):
            saved = sources[0][field]; sources[0][field] = True; connection.sql.clear()
            rejected(lambda: reader.PostgresPublicAlbumTopsService._artwork_manifest(connection, TOP, PUBLIC))
            sources[0][field] = saved
