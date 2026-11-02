"""Pure native-v3 assertion contract, not decoder/storage/rendering qualification.

All packets are deterministic synthetic assertions. Delivery gates remain v2-only.
The source owner is loaded through the established public-boundary test seam.
"""
import asyncio
from copy import deepcopy
from enum import Enum
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

V1 = 'app-rendered-position-v1'
V2 = 'app-rendered-position-v2'
V3 = 'app-rendered-position-v3'
MAX = 9_007_199_254_740_991
REF = '44444444-4444-4444-8444-444444444444'
NEXT_REF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def packet(rate=44100):
    return dict(protocol=V3, device_uuid='11111111-1111-4111-8111-111111111111',
        capture_uuid='22222222-2222-4222-8222-222222222222', sequence=1,
        initial_path='/synthetic/track.flac', evidence=dict(
            owner_uuid='33333333-3333-4333-8333-333333333333', graph_rate_hz=rate,
            runs=[dict(decoded_start_frame=0, frames=rate // 100, output_start_frame=256,
                ordinal_start_frame=0, epoch=1, binding_serial=1, generation=1,
                stream_id=1, continuity_serial=1, observation_ref=REF,
                anchor_before=None, anchor_after=None, quality='unknown')],
            anchors=[], gaps=[], terminal=False, terminal_reason=None))


def gap():
    return dict(ordinal_start=0, ordinal_end=12, positive_frames=9,
                output_start=256, output_end=268, epoch=None, reasons=['buffer_credit'])


def anchor(probe=1):
    return dict(epoch=1, probe_id=probe, output_frame=256, utc_lower_ms=1000,
                utc_upper_ms=1002, monotonic_probe_span_ms=2, max_quantum_frames=128,
                quality='bounded')


def pair():
    data = packet()
    first = data['evidence']['runs'][0]
    second = dict(first, decoded_start_frame=441, output_start_frame=697,
                  ordinal_start_frame=441)
    data['evidence']['runs'].append(second)
    return data


@pytest.fixture(scope='module')
def capture():
    path = Path(__file__).resolve().parents[2] / 'music_app/services/playback_capture.py'
    spec = importlib.util.spec_from_file_location('_native_v3_capture_contract_owner', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rejected(capture, callback, code='invalid_capture', status=400):
    with pytest.raises(capture.CaptureError) as error:
        callback()
    assert (error.value.code, error.value.status) == (code, status)


@pytest.mark.parametrize('rate', [44100, 48000], ids=['N3-01-native44100', 'N3-02-native48000'])
def test_native_v3_coordinates_remain_native(capture, rate):
    data = packet(rate)
    normalized = capture._normalize_capture_envelope(data)
    assert normalized == data
    assert normalized is not data
    assert normalized['evidence']['runs'][0]['frames'] == rate // 100
    assert set(normalized['evidence']['runs'][0]) == {
        'decoded_start_frame', 'frames', 'output_start_frame', 'ordinal_start_frame',
        'epoch', 'binding_serial', 'generation', 'stream_id', 'continuity_serial',
        'observation_ref', 'anchor_before', 'anchor_after', 'quality'}


@pytest.mark.parametrize('rate', [44100, 48000], ids=['rate=44100', 'rate=48000'])
@pytest.mark.parametrize('kind', ['terminal', 'gap'], ids=['kind=terminal', 'kind=gap'])
def test_n3_03_terminal_and_loss_need_no_fabricated_run(capture, rate, kind):
    data = packet(rate)
    data['evidence']['runs'] = []
    if kind == 'terminal':
        data['evidence'].update(terminal=True, terminal_reason='ended')
    else:
        data['evidence']['gaps'] = [gap()]
    assert capture._normalize_capture_envelope(data) == data


def test_n3_04_digest_has_literal_v3_namespace_rate_and_observation(capture):
    evidence = packet()['evidence']
    expected = hashlib.sha256(('app-rendered-position-v3\n1\n' + canonical(evidence)).encode()).hexdigest()
    actual = capture.capture_digest(1, evidence, protocol=V3)
    assert actual == expected
    assert capture.capture_digest(1, dict(reversed(list(evidence.items()))), protocol=V3) == expected
    rate = deepcopy(evidence); rate['graph_rate_hz'] = 48000
    ref = deepcopy(evidence); ref['runs'][0]['observation_ref'] = NEXT_REF
    assert capture.capture_digest(1, rate, protocol=V3) != expected
    assert capture.capture_digest(1, ref, protocol=V3) != expected
    assert capture.capture_digest(2, evidence, protocol=V3) != expected
    assert capture.capture_digest(1, evidence, protocol=V2) != expected


def test_n3_05_decoder_reset_does_not_reset_graph_or_ordinal(capture):
    data = pair()
    data['evidence']['runs'][1].update(decoded_start_frame=0, binding_serial=2,
        generation=2, stream_id=2, observation_ref=NEXT_REF, epoch=2, continuity_serial=2)
    assert capture._normalize_capture_envelope(data) == data


def test_n3_06_repeat_decoded_interval_is_not_output_overlap(capture):
    data = pair()
    data['evidence']['runs'][1].update(decoded_start_frame=0, continuity_serial=2)
    assert capture._normalize_capture_envelope(data) == data


@pytest.mark.parametrize('rate', ['missing', None, True, 44100.0, '44100', 0, 96000], ids=['rate=missing', 'rate=None', 'rate=True', 'rate=44100.0', 'rate=44100', 'rate=0', 'rate=96000'])
def test_n3_07_graph_rate_is_required_exact_supported_integer(capture, rate):
    data = packet()
    if rate == 'missing':
        del data['evidence']['graph_rate_hz']
    else:
        data['evidence']['graph_rate_hz'] = rate
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


@pytest.mark.parametrize('field', ['source_rate_hz', 'converter_recipe_id', 'source_start48',
    'source_base48', 'source_origin_whole', 'source_observation_ref', 'run_index', 'account_id', 'unexpected'], ids=['field=source_rate_hz', 'field=converter_recipe_id', 'field=source_start48', 'field=source_base48', 'field=source_origin_whole', 'field=source_observation_ref', 'field=run_index', 'field=account_id', 'field=unexpected'])
def test_n3_07_no_source_recipe_legacy_or_database_run_fields(capture, field):
    data = packet(); data['evidence']['runs'][0][field] = 1
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


@pytest.mark.parametrize('field', ['decoded_start_frame', 'frames', 'output_start_frame',
    'ordinal_start_frame', 'epoch', 'binding_serial', 'generation', 'stream_id', 'continuity_serial'], ids=['field=decoded_start_frame', 'field=frames', 'field=output_start_frame', 'field=ordinal_start_frame', 'field=epoch', 'field=binding_serial', 'field=generation', 'field=stream_id', 'field=continuity_serial'])
@pytest.mark.parametrize('value', [-1, True, 1.0, MAX + 1], ids=['value=-1', 'value=True', 'value=1.0', 'value=9007199254740992'])
def test_n3_08_all_run_counters_are_exact_safe_integers(capture, field, value):
    data = packet(); data['evidence']['runs'][0][field] = value
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


@pytest.mark.parametrize('field', ['frames', 'epoch', 'binding_serial', 'generation', 'stream_id', 'continuity_serial'], ids=['field=frames', 'field=epoch', 'field=binding_serial', 'field=generation', 'field=stream_id', 'field=continuity_serial'])
def test_n3_08_positive_run_fields_reject_zero(capture, field):
    data = packet(); data['evidence']['runs'][0][field] = 0
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


@pytest.mark.parametrize('field', ['decoded_start_frame', 'output_start_frame', 'ordinal_start_frame'], ids=['field=decoded_start_frame', 'field=output_start_frame', 'field=ordinal_start_frame'])
def test_n3_08_each_interval_end_must_be_safe(capture, field):
    data = packet(); data['evidence']['runs'][0][field] = MAX - 440
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


def test_n3_08_exact_max_interval_boundary_is_accepted(capture):
    data = packet()
    data['evidence']['runs'][0].update(frames=1, decoded_start_frame=MAX-1,
        output_start_frame=MAX-1, ordinal_start_frame=MAX-1)
    assert capture._normalize_capture_envelope(data) == data


def test_n3_08_aggregate_positive_frames_cannot_overflow(capture):
    data = packet()
    data['evidence']['runs'][0].update(frames=MAX, output_start_frame=0)
    data['evidence']['gaps'] = [gap()]
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


@pytest.mark.parametrize('value', ['missing', None, '00000000-0000-0000-0000-000000000000',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'not-a-uuid'], ids=['value=missing', 'value=None', 'value=00000000-0000-0000-0000-000000000000', 'value=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'value=not-a-uuid'])
def test_n3_09_observation_is_required_canonical_nonzero_uuid(capture, value):
    data = packet()
    if value == 'missing':
        del data['evidence']['runs'][0]['observation_ref']
    else:
        data['evidence']['runs'][0]['observation_ref'] = value
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


@pytest.mark.parametrize('change', ['binding_generation', 'binding_stream', 'binding_ref',
    'epoch_backwards', 'generation_backwards', 'continuity_backwards',
    'generation_without_epoch', 'continuity_jump', 'first_continuity_jump', 'same_continuity_unequal_gaps'], ids=['change=binding_generation', 'change=binding_stream', 'change=binding_ref', 'change=epoch_backwards', 'change=generation_backwards', 'change=continuity_backwards', 'change=generation_without_epoch', 'change=continuity_jump', 'change=first_continuity_jump', 'change=same_continuity_unequal_gaps'])
def test_n3_10_envelope_visible_lineage_contradictions(capture, change):
    data = pair(); first, second = data['evidence']['runs']
    if change == 'binding_generation': second.update(generation=2, epoch=2, continuity_serial=2)
    elif change == 'binding_stream': second['stream_id'] = 2
    elif change == 'binding_ref': second['observation_ref'] = NEXT_REF
    elif change == 'epoch_backwards': first['epoch'] = 2
    elif change == 'generation_backwards':
        first['generation'] = 2; second.update(binding_serial=2, observation_ref=NEXT_REF, continuity_serial=2)
    elif change == 'continuity_backwards':
        first.update(ordinal_start_frame=1, continuity_serial=2); second['ordinal_start_frame'] = 442
    elif change == 'generation_without_epoch':
        second.update(binding_serial=2, generation=2, observation_ref=NEXT_REF, continuity_serial=2)
    elif change == 'continuity_jump': second['continuity_serial'] = 3
    elif change == 'first_continuity_jump': first['continuity_serial'] = 2
    else: second['output_start_frame'] += 1
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


@pytest.mark.parametrize('field', ['output_start_frame', 'ordinal_start_frame'], ids=['field=output_start_frame', 'field=ordinal_start_frame'])
@pytest.mark.parametrize('kind', ['overlap', 'reverse'], ids=['kind=overlap', 'kind=reverse'])
def test_n3_11_graph_and_ordinal_order_not_decoder_order(capture, field, kind):
    data = pair()
    first, second = data['evidence']['runs']
    if kind == 'reverse':
        first[field] = 256
        second[field] = 255
    else:
        second[field] = first[field] + first['frames'] - 1
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


def test_n3_12_run_count_and_envelope_byte_caps_are_independent(capture):
    # Existing bounded array seam: valid count is not permission for an oversized envelope.
    rows = [None] * 256
    assert capture._array(rows, 256) is rows
    rejected(capture, lambda: capture._array(rows + [None], 256))
    data = packet(); base = data['evidence']['runs'][0]
    data['evidence']['runs'] = [dict(base, decoded_start_frame=i, frames=1,
        output_start_frame=256+i, ordinal_start_frame=i) for i in range(256)]
    assert len(canonical(data).encode()) > 32768
    rejected(capture, lambda: capture._normalize_capture_envelope(data), 'capture_too_large', 413)
    data['evidence']['runs'].append(dict(base))
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


@pytest.mark.parametrize('field', ['anchors', 'gaps'], ids=['field=anchors', 'field=gaps'])
@pytest.mark.parametrize('count', [8, 9], ids=['count=8', 'count=9'])
def test_n3_12_bounded_anchor_and_gap_counts(capture, field, count):
    data = packet()
    data['evidence'][field] = [anchor(i+1) if field == 'anchors' else gap() for i in range(count)]
    if count == 8:
        assert capture._normalize_capture_envelope(data) == data
    else:
        rejected(capture, lambda: capture._normalize_capture_envelope(data))


@pytest.mark.parametrize('size', [32768, 32769], ids=['size=32768', 'size=32769'])
def test_n3_12_exact_canonical_utf8_envelope_byte_budget(capture, size):
    data = packet(); data['initial_path'] = 'é'
    padding = size - len(canonical(data).encode('utf-8'))
    assert padding > 0
    data['initial_path'] += 'x' * padding
    assert len(canonical(data).encode('utf-8')) == size
    assert len(data['initial_path']) <= 32768
    if size == 32768:
        assert capture._normalize_capture_envelope(data) == data
    else:
        rejected(capture, lambda: capture._normalize_capture_envelope(data), 'capture_too_large', 413)


@pytest.mark.parametrize('change', ['duplicate', 'reverse_utc', 'span', 'quantum', 'unknown_bounds',
    'bounded_run_without_refs', 'wrong_ref_epoch', 'zero_ref_probe'], ids=['change=duplicate', 'change=reverse_utc', 'change=span', 'change=quantum', 'change=unknown_bounds', 'change=bounded_run_without_refs', 'change=wrong_ref_epoch', 'change=zero_ref_probe'])
def test_n3_12_anchor_bounds_and_run_quality(capture, change):
    data = packet(); data['evidence']['anchors'] = [anchor()]
    a = data['evidence']['anchors'][0]; run = data['evidence']['runs'][0]
    if change == 'duplicate': data['evidence']['anchors'].append(deepcopy(a))
    elif change == 'reverse_utc': a['utc_lower_ms'] = 1003
    elif change == 'span': a['monotonic_probe_span_ms'] = 251
    elif change == 'quantum': a['max_quantum_frames'] = 2049
    elif change == 'unknown_bounds': a['quality'] = 'unknown'
    elif change == 'bounded_run_without_refs': run['quality'] = 'bounded'
    elif change == 'wrong_ref_epoch': run['anchor_before'] = [2, 1]
    else: run['anchor_after'] = [1, 0]
    rejected(capture, lambda: capture._normalize_capture_envelope(data))



@pytest.mark.parametrize('change', ['empty', 'terminal_type', 'terminal_no_reason', 'nonterminal_reason',
    'gap_zero', 'gap_ordinal_short', 'gap_output_short', 'gap_empty_reasons',
    'gap_duplicate_reasons', 'gap_unsorted_reasons', 'gap_unknown_reason'], ids=['change=empty', 'change=terminal_type', 'change=terminal_no_reason', 'change=nonterminal_reason', 'change=gap_zero', 'change=gap_ordinal_short', 'change=gap_output_short', 'change=gap_empty_reasons', 'change=gap_duplicate_reasons', 'change=gap_unsorted_reasons', 'change=gap_unknown_reason'])
def test_n3_12_terminal_and_loss_semantics_remain_bounded(capture, change):
    data = packet(); data['evidence']['gaps'] = [gap()]
    evidence = data['evidence']; loss = evidence['gaps'][0]
    if change == 'empty': evidence.update(runs=[], gaps=[])
    elif change == 'terminal_type': evidence['terminal'] = 1
    elif change == 'terminal_no_reason': evidence['terminal'] = True
    elif change == 'nonterminal_reason': evidence['terminal_reason'] = 'ended'
    elif change == 'gap_zero': loss['positive_frames'] = 0
    elif change == 'gap_ordinal_short': loss['ordinal_end'] = 8
    elif change == 'gap_output_short': loss['output_end'] = 264
    elif change == 'gap_empty_reasons': loss['reasons'] = []
    elif change == 'gap_duplicate_reasons': loss['reasons'] = ['buffer_credit', 'buffer_credit']
    elif change == 'gap_unsorted_reasons': loss['reasons'] = ['queue_capacity', 'buffer_credit']
    else: loss['reasons'] = ['invented']
    rejected(capture, lambda: capture._normalize_capture_envelope(data))


def test_n3_13_all_nested_values_are_fresh_without_input_mutation(capture):
    data = packet(); data['evidence']['anchors'] = [anchor(), anchor(2)]
    data['evidence']['gaps'] = [gap()]
    data['evidence']['runs'][0].update(anchor_before=[1, 1], anchor_after=[1, 2], quality='bounded')
    data['v1_session_uuid'] = '55555555-5555-4555-8555-555555555555'
    before = deepcopy(data)
    normalized = capture._normalize_capture_envelope(data)
    assert normalized == before and data == before
    def assert_fresh(a, b):
        if isinstance(a, dict):
            assert a is not b
            for key in a: assert_fresh(a[key], b[key])
        elif isinstance(a, list):
            assert a is not b
            for x, y in zip(a, b): assert_fresh(x, y)
    assert_fresh(normalized, data)
    normalized['evidence']['runs'][0]['anchor_before'][1] = 99
    normalized['evidence']['gaps'][0]['reasons'].append('numeric_limit')
    assert data == before


@pytest.mark.parametrize('gate', ['public_direct', 'public_parser', 'private_parser', 'selection', 'writer'], ids=['gate=public_direct', 'gate=public_parser', 'gate=private_parser', 'gate=selection', 'gate=writer'])
def test_n3_14_v3_delivery_gates_remain_closed_before_any_database(gate):
    # Gate-unit scope: real imports and validators; no app creation or fake SQL success.
    from music_app.services import playback_capture as real
    from music_app.services import playback_position_transport as transport
    from music_app.services import playback_edition_selection as selection
    from music_app.services import playback_capture_postgres as writer
    data = packet()
    connect = Mock(side_effect=AssertionError('v3 attempted a connection'))
    with patch.object(writer, 'current_library_transaction', side_effect=AssertionError('v3 attempted a transaction')) as transaction:
        calls = {
            'public_direct': lambda: real.normalize_capture_envelope(data),
            'public_parser': lambda: real.parse_capture_body(canonical(data).encode()),
            'private_parser': lambda: transport.parse_position_capture_body(canonical(data).encode()),
            'selection': lambda: selection.normalize_selected_position_envelope(data),
            'writer': lambda: writer._record_position_checkpoint('never-connect', object(), data,
                expected_scope='synthetic-scope', connect=connect),
        }
        rejected(real, calls[gate], 'unsupported_capture_version')
    transaction.assert_not_called(); connect.assert_not_called()


def test_n3_14_actual_context_response_still_advertises_v2_48000_only():
    # Route-unit scope: authority/readiness supplied, actual route builds the response.
    from music_app.routes import playback_capture_asgi as route
    from music_app.services import playback_position_transport as transport
    request = SimpleNamespace(query_params={}, app=SimpleNamespace(state=SimpleNamespace(
        config={'ALBUM_HAVEN_POSITION_CAPTURE_ENABLED': True})))
    authority = AsyncMock(return_value=(object(), None, 'never-connect', 'synthetic-scope'))
    ready = Mock(return_value={'selections': False, 'observations': False})
    async def invoke(function, *args, **kwargs):
        return function(*args, **kwargs)
    with patch.object(route, '_authority', authority), patch.object(route, 'run_in_threadpool', invoke), \
            patch.object(transport, 'check_position_capture_context', ready):
        response = asyncio.run(route.playback_position_context(request))
    authority.assert_awaited_once_with(request); ready.assert_called_once()
    assert response.status_code == 200
    body = json.loads(response.body)
    assert body['protocol'] == V1
    assert body['supported_protocols'] == [V2]
    assert body['source_rate'] == body['output_rate'] == 48000


def legacy_packet(version):
    # Literal existing public-boundary fixture, not v3 fields renamed at runtime.
    run = dict(source_start48=100, frames=2, output_start=256, ordinal_start=0,
               epoch=1, anchor_before=None, anchor_after=None, quality='unknown')
    evidence = dict(runs=[run], anchors=[], gaps=[], terminal=False, terminal_reason=None)
    if version == V2:
        evidence['owner_uuid'] = '33333333-3333-4333-8333-333333333333'
        run.update(binding_serial=1, generation=1, stream_id=1, source_base48=100, continuity_serial=1)
    return dict(protocol=version, device_uuid='11111111-1111-4111-8111-111111111111',
        capture_uuid='22222222-2222-4222-8222-222222222222', sequence=1,
        initial_path='/synthetic/track.flac', evidence=evidence)


# Independent literal before-implementation goldens; never regenerated by the owner under test.
LEGACY_GOLDENS = {
    'v1': (
        '{"capture_uuid":"22222222-2222-4222-8222-222222222222","device_uuid":"11111111-1111-4111-8111-111111111111","evidence":{"anchors":[],"gaps":[],"runs":[{"anchor_after":null,"anchor_before":null,"epoch":1,"frames":2,"ordinal_start":0,"output_start":256,"quality":"unknown","source_start48":100}],"terminal":false,"terminal_reason":null},"initial_path":"/synthetic/track.flac","protocol":"app-rendered-position-v1","sequence":1}',
        '23df52981822387105e917e93bfe4038be71bfaaaaee4bb30c74699ffba3bd1a'),
    'v2': (
        '{"capture_uuid":"22222222-2222-4222-8222-222222222222","device_uuid":"11111111-1111-4111-8111-111111111111","evidence":{"anchors":[],"gaps":[],"owner_uuid":"33333333-3333-4333-8333-333333333333","runs":[{"anchor_after":null,"anchor_before":null,"binding_serial":1,"continuity_serial":1,"epoch":1,"frames":2,"generation":1,"ordinal_start":0,"output_start":256,"quality":"unknown","source_base48":100,"source_start48":100,"stream_id":1}],"terminal":false,"terminal_reason":null},"initial_path":"/synthetic/track.flac","protocol":"app-rendered-position-v2","sequence":1}',
        'fe33effcd53fe1e66791ad05461373c895e144000f6deba4b5c1c19fd59ad522'),
    'v2_selected_observed': (
        '{"capture_uuid":"22222222-2222-4222-8222-222222222222","device_uuid":"11111111-1111-4111-8111-111111111111","edition_selection_ref":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","evidence":{"anchors":[],"gaps":[],"owner_uuid":"33333333-3333-4333-8333-333333333333","runs":[{"anchor_after":null,"anchor_before":null,"binding_serial":1,"continuity_serial":1,"epoch":1,"frames":2,"generation":1,"ordinal_start":0,"output_start":256,"quality":"unknown","source_base48":100,"source_observation_ref":"44444444-4444-4444-8444-444444444444","source_start48":100,"stream_id":1}],"terminal":false,"terminal_reason":null},"initial_path":"/synthetic/track.flac","protocol":"app-rendered-position-v2","sequence":1}',
        'f5227854ea643fb49144f44475f85b85489efaeb748557409a19cb5fe8c42d88'),
}


@pytest.mark.parametrize('variant', ['v1', 'v2', 'v2_selected_observed'], ids=['variant=v1', 'variant=v2', 'variant=v2_selected_observed'])
def test_n3_15_legacy_exact_bytes_hashes_and_optional_composition(capture, variant):
    from music_app.services import playback_position_transport as transport
    from music_app.services import playback_edition_selection as selection
    version = V1 if variant == 'v1' else V2
    data = legacy_packet(version)
    if variant == 'v2_selected_observed':
        data['edition_selection_ref'] = NEXT_REF
        data['evidence']['runs'][0]['source_observation_ref'] = REF
        normalized = selection.normalize_selected_position_envelope(data)
    else:
        normalized = capture._normalize_capture_envelope(data)
    encoded, expected_digest = LEGACY_GOLDENS[variant]
    assert canonical(normalized).encode('utf-8') == encoded.encode('utf-8')
    assert capture.canonical_json(normalized) == encoded
    assert capture.capture_digest(1, normalized['evidence'], protocol=version) == expected_digest
    parser = capture.parse_capture_body if variant == 'v1' else transport.parse_position_capture_body
    assert canonical(parser(encoded.encode('utf-8'))) == encoded


class ProtocolString(str):
    pass


class ProtocolEnum(str, Enum):
    V1 = V1
    V3 = V3


class EqualityProtocol:
    def __init__(self, value): self.value = value
    def __eq__(self, other): return self.value == other
    def __ne__(self, other): return self.value != other
    def __str__(self): raise AssertionError('Protocol coercion is forbidden')


@pytest.mark.parametrize('kind', ['subclass', 'enum', 'equality'], ids=['kind=subclass', 'kind=enum', 'kind=equality'])
def test_n3_15_public_v1_legacy_protocol_compatibility_and_error_precedence(capture, kind):
    protocol = {'subclass': ProtocolString(V1), 'enum': ProtocolEnum.V1, 'equality': EqualityProtocol(V1)}[kind]
    data = legacy_packet(V1); data['protocol'] = protocol
    normalized = capture.normalize_capture_envelope(data)
    assert canonical(normalized) == LEGACY_GOLDENS['v1'][0]
    assert type(normalized['protocol']) is str
    assert data['protocol'] is protocol
    data['evidence'] = None
    rejected(capture, lambda: capture.normalize_capture_envelope(data))


@pytest.mark.parametrize('kind', ['int', 'subclass', 'enum', 'equality', 'unknown'], ids=['kind=int', 'kind=subclass', 'kind=enum', 'kind=equality', 'kind=unknown'])
def test_n3_16_private_v3_protocol_requires_exact_known_string(capture, kind):
    protocol = {'int': 3, 'subclass': ProtocolString(V3), 'enum': ProtocolEnum.V3,
                'equality': EqualityProtocol(V3), 'unknown': 'app-rendered-position-v99'}[kind]
    data = packet(); data['protocol'] = protocol
    rejected(capture, lambda: capture._normalize_capture_envelope(data), 'unsupported_capture_version')
    rejected(capture, lambda: capture.capture_digest(1, data['evidence'], protocol=protocol), 'unsupported_capture_version')
    rejected(capture, lambda: capture.normalize_capture_envelope(data), 'unsupported_capture_version')


@pytest.mark.parametrize('kind', ['duplicate', 'float', 'nan', 'infinity', 'invalid_utf8', 'oversized'], ids=['kind=duplicate', 'kind=float', 'kind=nan', 'kind=infinity', 'kind=invalid_utf8', 'kind=oversized'])
@pytest.mark.parametrize('boundary', ['public', 'private'], ids=['boundary=public', 'boundary=private'])
def test_n3_16_raw_parser_errors_precede_v3_dispatch(kind, boundary):
    from music_app.services import playback_capture as real
    from music_app.services import playback_position_transport as transport
    raw = canonical(packet()).encode()
    if kind == 'duplicate': raw = raw[:-1] + b',"protocol":"app-rendered-position-v3"}'
    elif kind == 'float': raw = raw.replace(b'"sequence":1', b'"sequence":1.0')
    elif kind == 'nan': raw = raw.replace(b'"sequence":1', b'"sequence":NaN')
    elif kind == 'infinity': raw = raw.replace(b'"sequence":1', b'"sequence":Infinity')
    elif kind == 'invalid_utf8': raw = b'\xff'
    else: raw += b' ' * (32769 - len(raw))
    parser = real.parse_capture_body if boundary == 'public' else transport.parse_position_capture_body
    rejected(real, lambda: parser(raw), 'capture_too_large' if kind == 'oversized' else 'invalid_capture',
             413 if kind == 'oversized' else 400)


@pytest.mark.parametrize('shape', ['missing', 'extra'], ids=['shape=missing', 'shape=extra'])
def test_n3_16_public_outer_shape_error_precedes_protocol(capture, shape):
    data = packet()
    if shape == 'missing': del data['sequence']
    else: data['unexpected'] = True
    rejected(capture, lambda: capture.normalize_capture_envelope(data))
