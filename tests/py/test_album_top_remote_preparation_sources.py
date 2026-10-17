"""Pure C2 wire contracts; no provider, SQL, app factory or configuration.

Legacy v1 remains distinguishable for exact replay. A preparation UUID is only
a lookup identity; this normalizer never grants reservation or provider rights.
"""
from collections import UserDict
from copy import deepcopy
from dataclasses import FrozenInstanceError
from uuid import UUID

import pytest

from music_app.services.album_top_remote_sources import (
    PreparedRemoteTopAcquisitionCommand,
    RemoteTopAcquisitionCommand,
    RemoteTopDestination,
    normalize_pending_remote_selector,
    normalize_remote_acquisition,
    normalize_remote_maintenance,
    normalize_remote_preparation,
    remote_preparation_ref,
)
from music_app.services.owned_album_tops import AlbumTopError


REQUEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
DRAFT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
TOP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
PREPARATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
GROUP = 'c9fdb94c-4975-4ed6-a96f-ef6d80bb7738'
OTHER_GROUP = '8e68819d-71be-4e7d-b41d-f1df81b01d3f'
ZERO = '00000000-0000-0000-0000-000000000000'
HEX = '0123456789abcdef' * 4
# Independent literal JSON vectors, hashed as text without importing production.
V2_CREATE_DIGEST = '114a96f1d7d64e31a7a55f5a66b6c4415f1242c81f380f77a59b46b5a9ce6bb4'
V2_TOP_DIGEST = '5ddb8d1973b2c5838ec7f24641e0d8d98a6a63538ffdb147a9a640a57839c31e'
V1_CREATE_DIGEST = '1a3377e6c4698113a877d363600341d8efd0cffffe571bb03e2d9b126ae45e91'


class TextSubclass(str):
    pass


class DictSubclass(dict):
    pass


BAD_REFS = [None, True, False, 1, 1.0, '', ZERO, REQUEST.upper(),
    REQUEST.replace('-', ''), '{' + REQUEST + '}', 'urn:uuid:' + REQUEST,
    ' ' + REQUEST, REQUEST + '\n', UUID(REQUEST), TextSubclass(REQUEST), [], {}]


def destination(revision=None):
    return ({'kind': 'create', 'draft_ref': DRAFT} if revision is None else
            {'kind': 'top', 'top_ref': TOP, 'revision': revision})


def acquisition(**changes):
    return {'version': 2, 'preparation_ref': PREPARATION, 'request_key': REQUEST,
            'destination': destination(), 'release_group_id': GROUP, **changes}


def begin(**changes):
    return {'destination': destination(), 'form_ref': DRAFT, **changes}


def invalid(call, code='invalid_command'):
    with pytest.raises(AlbumTopError) as caught:
        call()
    assert (caught.value.code, caught.value.status_code) == (code, 422)


def test_v2_is_exact_frozen_detached_command_with_literal_digest():
    payload = acquisition()
    before = deepcopy(payload)
    command = normalize_remote_acquisition(payload)
    assert type(command) is PreparedRemoteTopAcquisitionCommand
    assert type(command.destination) is RemoteTopDestination
    assert command.payload() == before and command.digest == V2_CREATE_DIGEST
    payload['preparation_ref'] = OTHER
    payload['request_key'] = OTHER
    payload['destination']['draft_ref'] = OTHER
    output = command.payload()
    output['version'] = 1
    output['destination']['draft_ref'] = OTHER
    assert command.payload() == before and command.digest == V2_CREATE_DIGEST
    with pytest.raises(FrozenInstanceError):
        command.preparation_ref = OTHER
    with pytest.raises(FrozenInstanceError):
        command.destination.ref = OTHER


def test_v2_digest_retains_bigint_revision_and_ignores_dictionary_order_only():
    payload = acquisition(destination=destination('9007199254740993'))
    command = normalize_remote_acquisition(payload)
    reordered = {'release_group_id': GROUP, 'destination': {
        'revision': '9007199254740993', 'top_ref': TOP, 'kind': 'top'},
        'request_key': REQUEST, 'preparation_ref': PREPARATION, 'version': 2}
    assert command.destination.revision == '9007199254740993'
    assert command.digest == normalize_remote_acquisition(reordered).digest == V2_TOP_DIGEST


def test_v2_digest_binds_entire_normalized_body_including_namespace_and_request_key():
    values = [acquisition(), acquisition(preparation_ref=OTHER), acquisition(request_key=OTHER),
        acquisition(destination={'kind': 'create', 'draft_ref': OTHER}),
        acquisition(destination={'kind': 'top', 'top_ref': DRAFT, 'revision': '1'}),
        acquisition(destination=destination('1')), acquisition(destination=destination('2')),
        acquisition(release_group_id=OTHER_GROUP)]
    assert len({normalize_remote_acquisition(value).digest for value in values}) == len(values)


def test_legacy_triple_stays_v1_with_unchanged_payload_digest_and_key_semantics():
    legacy = {key: value for key, value in acquisition().items()
              if key not in {'version', 'preparation_ref'}}
    command = normalize_remote_acquisition(legacy)
    changed_key = normalize_remote_acquisition({**legacy, 'request_key': OTHER})
    assert type(command) is RemoteTopAcquisitionCommand
    assert command.payload() == legacy
    assert command.digest == changed_key.digest == V1_CREATE_DIGEST
    assert command.digest != normalize_remote_acquisition(acquisition()).digest
    assert not hasattr(command, 'preparation_ref')


@pytest.mark.parametrize('value', [None, True, [], (), '{}', {},
    UserDict(acquisition()), DictSubclass(acquisition())])
def test_v2_requires_exact_plain_dictionary(value):
    invalid(lambda: normalize_remote_acquisition(value))


@pytest.mark.parametrize('version', [None, True, False, 0, 1, 3, 2.0, '2',
    TextSubclass('2'), [], {}])
def test_version_is_exact_integer_two_without_guessing_or_coercion(version):
    invalid(lambda: normalize_remote_acquisition(acquisition(version=version)))


@pytest.mark.parametrize('field', ['version', 'preparation_ref', 'request_key',
                                  'destination', 'release_group_id'])
def test_incomplete_v2_cannot_fall_back_to_legacy(field):
    value = acquisition()
    del value[field]
    invalid(lambda: normalize_remote_acquisition(value))


@pytest.mark.parametrize('field,value', [
    ('actor_account_id', 41), ('owner_account_id', 42), ('library_id', 73),
    ('session_id', 8), ('context_ref', HEX), ('attempt_ref', OTHER),
    ('acquisition_ref', OTHER), ('form_ref', DRAFT), ('state', 'reserved'),
    ('dispatch', True), ('lease_until', '2099-01-01T00:00:00Z'),
    ('digest', HEX), ('title', 'Fabricated'), ('album', {'title': 'Fabricated'}),
    ('evidence_version', HEX), ('url', 'https://provider.invalid'),
    ('local_path', '/private/music'), (1, 'extra')])
def test_v2_cannot_supply_authority_dispatch_state_or_provider_facts(field, value):
    invalid(lambda: normalize_remote_acquisition({**acquisition(), field: value}))


@pytest.mark.parametrize('field', ['preparation_ref', 'request_key'])
@pytest.mark.parametrize('value', BAD_REFS)
def test_v2_references_are_exact_nonzero_canonical_uuids(field, value):
    invalid(lambda: normalize_remote_acquisition(acquisition(**{field: value})))


@pytest.mark.parametrize('value', BAD_REFS)
def test_v2_release_group_retains_existing_strict_identity_error(value):
    invalid(lambda: normalize_remote_acquisition(acquisition(release_group_id=value)),
            'invalid_release_group_id')


@pytest.mark.parametrize('value', [None, [], {}, {'kind': 'create', 'draft_ref': ZERO},
    {'kind': 'create', 'draft_ref': DRAFT, 'revision': '1'},
    {'kind': 'top', 'top_ref': TOP, 'revision': 1},
    {'kind': 'top', 'top_ref': TOP, 'revision': '01'},
    {'kind': 'top', 'top_ref': TOP, 'revision': '9223372036854775808'},
    {'kind': 'top', 'top_ref': TOP, 'revision': '1', 'owner_account_id': 41}])
def test_v2_and_begin_reuse_exact_destination_contract(value):
    invalid(lambda: normalize_remote_acquisition(acquisition(destination=value)))
    invalid(lambda: normalize_remote_preparation(begin(destination=value)))


def test_begin_returns_detached_destination_and_create_form_is_existing_draft():
    payload = begin()
    result, form_ref = normalize_remote_preparation(payload)
    assert type(result) is RemoteTopDestination
    assert result.payload() == destination() and form_ref == DRAFT
    payload['destination']['draft_ref'] = OTHER
    payload['form_ref'] = OTHER
    assert result.payload() == destination() and form_ref == DRAFT
    invalid(lambda: normalize_remote_preparation(begin(form_ref=OTHER)))


@pytest.mark.parametrize('revision', ['1', '9007199254740993', '9223372036854775807'])
def test_existing_top_begin_binds_form_separately_from_exact_top_revision(revision):
    result, form_ref = normalize_remote_preparation(begin(destination=destination(revision), form_ref=OTHER))
    assert result.payload() == destination(revision) and form_ref == OTHER


@pytest.mark.parametrize('value', [None, True, [], '{}', {}, UserDict(begin()), DictSubclass(begin()),
    {'destination': destination()}, {'form_ref': DRAFT}])
def test_begin_requires_exact_plain_object_and_both_fields(value):
    invalid(lambda: normalize_remote_preparation(value))


@pytest.mark.parametrize('field,value', [('preparation_ref', PREPARATION), ('request_key', REQUEST),
    ('version', 2), ('actor_account_id', 41), ('owner_account_id', 41),
    ('library_id', 73), ('context_ref', HEX), ('accepts_until', '2099-01-01'),
    ('closed_at', None), ('capacity', {'attempt_slots_remaining': 512}), (1, 'extra')])
def test_begin_never_accepts_browser_parent_insertion_or_capacity_authority(field, value):
    invalid(lambda: normalize_remote_preparation({**begin(), field: value}))


@pytest.mark.parametrize('value', BAD_REFS)
def test_form_and_close_lookup_references_share_strict_nonzero_uuid_contract(value):
    invalid(lambda: normalize_remote_preparation(begin(form_ref=value)))
    invalid(lambda: remote_preparation_ref(value))


def test_close_lookup_normalizes_reference_without_inserting_a_namespace():
    assert remote_preparation_ref(PREPARATION) == PREPARATION


@pytest.mark.parametrize('mode', ['reclaim', 'discard_legacy'])
def test_maintenance_accepts_only_explicit_bounded_operation(mode):
    assert normalize_remote_maintenance({'mode': mode}) == mode


@pytest.mark.parametrize('value', [None, True, [], '{}', {}, {'mode': None}, {'mode': True},
    {'mode': 'RECLAIM'}, {'mode': 'reclaim '}, {'mode': 'discard'},
    {'mode': 'reclaim', 'preparation_ref': PREPARATION}, {'mode': 'reclaim', 'limit': 9999},
    {'mode': 'reclaim', 'before': '2099-01-01'}, {'mode': 'reclaim', 'actor_account_id': 42},
    {'mode': TextSubclass('reclaim')}, UserDict({'mode': 'reclaim'}), DictSubclass({'mode': 'reclaim'})])
def test_maintenance_cannot_choose_arbitrary_records_limits_or_deadlines(value):
    invalid(lambda: normalize_remote_maintenance(value))


@pytest.mark.parametrize('field,value', [('preparation_ref', PREPARATION), ('request_key', REQUEST),
    ('version', 2), ('attempt_ref', OTHER), ('dispatch', True), ('state', 'consumed')])
def test_pending_membership_selector_stays_exact_and_has_no_preparation_bypass(field, value):
    selector = {'kind': 'remote_acquisition', 'acquisition_ref': OTHER, 'evidence_version': HEX}
    assert normalize_pending_remote_selector(selector) == selector
    invalid(lambda: normalize_pending_remote_selector({**selector, field: value}))
