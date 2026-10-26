"""Pure public/private capture boundary contracts; no application bootstrap.

The complete real source owner is loaded only when a test runner executes this
module. These synthetic packets are not producer traces or storage evidence.
"""
from copy import deepcopy
from enum import Enum
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


class ProtocolString(str):
    pass


class ProtocolEnum(str, Enum):
    V1 = 'app-rendered-position-v1'
    V2 = 'app-rendered-position-v2'


class EqualityProtocol:
    """Legacy direct-call value; deliberately not JSON serializable or coercible."""
    def __init__(self, value):
        self.value = value

    def __eq__(self, other):
        return self.value == other

    def __ne__(self, other):
        return self.value != other

    def __str__(self):
        raise AssertionError('protocol objects must not be coerced to strings')


def nonexact_protocols(protocol):
    return [('str_subclass', ProtocolString(protocol)),
            ('str_enum', ProtocolEnum(protocol)),
            ('equality_object', EqualityProtocol(protocol))]


def packet(protocol='app-rendered-position-v2'):
    run = dict(source_start48=100, frames=2, output_start=256, ordinal_start=0,
               epoch=1, anchor_before=None, anchor_after=None, quality='unknown')
    evidence = dict(runs=[run], anchors=[], gaps=[], terminal=False, terminal_reason=None)
    if protocol == 'app-rendered-position-v2':
        evidence['owner_uuid'] = '33333333-3333-4333-8333-333333333333'
        run.update(binding_serial=1, generation=1, stream_id=1,
                   source_base48=100, continuity_serial=1)
    return dict(protocol=protocol, device_uuid='11111111-1111-4111-8111-111111111111',
                capture_uuid='22222222-2222-4222-8222-222222222222', sequence=1,
                initial_path='/synthetic/track.flac', evidence=evidence)


class CapturePublicBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        file = Path(__file__).resolve().parents[2] / 'music_app/services/playback_capture.py'
        spec = importlib.util.spec_from_file_location('_capture_public_boundary_owner', file)
        cls.capture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.capture)

    def assert_error(self, call, code, status=400):
        with self.assertRaises(self.capture.CaptureError) as caught:
            call()
        self.assertEqual((caught.exception.code, caught.exception.status), (code, status))

    def test_public_v1_uses_the_shared_owner_and_returns_fresh_data(self):
        data = packet(self.capture.PROTOCOL)
        with patch.object(self.capture, '_normalize_capture_envelope',
                          wraps=self.capture._normalize_capture_envelope) as shared:
            normalized = self.capture.normalize_capture_envelope(data)
        shared.assert_called_once_with(data)
        delegated = shared.call_args.args[0]
        self.assertIsNot(delegated, data)
        self.assertIs(delegated['protocol'], self.capture.PROTOCOL)
        self.assertIs(delegated['evidence'], data['evidence'])
        self.assertEqual(normalized, data)
        self.assertIsNot(normalized, data)
        self.assertIsNot(normalized['evidence']['runs'][0], data['evidence']['runs'][0])

    def test_public_v1_body_and_digest_remain_in_the_v1_domain(self):
        data = packet(self.capture.PROTOCOL)
        parsed = self.capture.parse_capture_body(json.dumps(data).encode())
        self.assertEqual(parsed, data)
        canonical = json.dumps(data['evidence'], sort_keys=True, separators=(',', ':'))
        expected = hashlib.sha256((self.capture.PROTOCOL+'\n1\n'+canonical).encode()).hexdigest()
        self.assertEqual(self.capture.capture_digest(1, parsed['evidence']), expected)

    def test_private_v2_normalization_remains_available_without_public_admission(self):
        data = packet()
        normalized = self.capture._normalize_capture_envelope(data)
        self.assertEqual(normalized, data)
        self.assertIsNot(normalized, data)
        self.assert_error(lambda: self.capture.normalize_capture_envelope(data),
                          'unsupported_capture_version')
        self.assert_error(lambda: self.capture.parse_capture_body(json.dumps(data).encode()),
                          'unsupported_capture_version')

    def test_public_v2_stops_before_the_private_evidence_validator(self):
        with patch.object(self.capture, '_normalize_capture_envelope',
                          side_effect=AssertionError('public v2 entered private validator')):
            self.assert_error(lambda: self.capture.normalize_capture_envelope(packet()),
                              'unsupported_capture_version')

    def test_v2_version_error_precedes_malformed_evidence_and_scalar_fields(self):
        variants = [packet() for _ in range(6)]
        variants[0]['evidence'] = None
        variants[1]['evidence']['runs'][0]['frames'] = False
        variants[2]['evidence'].pop('owner_uuid')
        variants[3]['device_uuid'] = 'not-a-uuid'
        variants[4]['sequence'] = 0
        variants[5]['initial_path'] = '/synthetic/\ud800.flac'
        for data in variants:
            with self.subTest(data=data):
                self.assert_error(lambda: self.capture.normalize_capture_envelope(data),
                                  'unsupported_capture_version')
                self.assert_error(lambda: self.capture.parse_capture_body(json.dumps(data).encode()),
                                  'unsupported_capture_version')

    def test_outer_shape_error_still_precedes_version_rejection(self):
        missing = packet(); missing.pop('sequence')
        extra = packet(); extra['unexpected'] = True
        for data in (missing, extra, [], None):
            with self.subTest(data=data):
                self.assert_error(lambda: self.capture.normalize_capture_envelope(data), 'invalid_capture')
                self.assert_error(lambda: self.capture.parse_capture_body(json.dumps(data).encode()),
                                  'invalid_capture')

    def test_unknown_and_nonstring_protocols_keep_public_version_error(self):
        for protocol in ('future-capture', None, True, 1, [], {}):
            data = packet(); data['protocol'] = protocol
            with self.subTest(protocol=protocol):
                self.assert_error(lambda: self.capture.normalize_capture_envelope(data),
                                  'unsupported_capture_version')

    def test_duplicate_keys_floats_and_invalid_json_fail_before_version_dispatch(self):
        encoded = json.dumps(packet()).encode()
        duplicate = encoded[:-1] + b',"protocol":"app-rendered-position-v2"}'
        floating = encoded.replace(b'"sequence": 1', b'"sequence": 1.0')
        for raw in (duplicate, floating, b'\xff', b'{', b'{"n":NaN}'):
            with self.subTest(raw=raw):
                self.assert_error(lambda: self.capture.parse_capture_body(raw), 'invalid_capture')

    def test_raw_body_limit_precedes_v2_version_error(self):
        raw = json.dumps(packet()).encode()
        raw += b' ' * (self.capture.BODY_LIMIT + 1 - len(raw))
        self.assert_error(lambda: self.capture.parse_capture_body(raw), 'capture_too_large', 413)

    def test_private_v2_still_rejects_malformed_owner_and_causal_evidence(self):
        bad_owner = packet(); bad_owner['evidence']['owner_uuid'] = '00000000-0000-0000-0000-000000000000'
        bad_serial = packet(); bad_serial['evidence']['runs'][0]['continuity_serial'] = 2
        bad_frame = packet(); bad_frame['evidence']['runs'][0]['frames'] = True
        for data in (bad_owner, bad_serial, bad_frame):
            with self.subTest(data=data):
                self.assert_error(lambda: self.capture._normalize_capture_envelope(data), 'invalid_capture')

    def test_private_v2_keeps_safe_loop_and_generation_epoch_distinctions(self):
        data = packet()
        first = data['evidence']['runs'][0]
        data['evidence']['runs'].append(dict(first, ordinal_start=2, output_start=258, epoch=2))
        self.assertEqual(self.capture._normalize_capture_envelope(data), data)
        reset = deepcopy(data)
        reset['evidence']['runs'][1].update(binding_serial=2, generation=2, stream_id=2,
                                          continuity_serial=2)
        self.assertEqual(self.capture._normalize_capture_envelope(reset), reset)
        reset['evidence']['runs'][1]['epoch'] = 1
        self.assert_error(lambda: self.capture._normalize_capture_envelope(reset), 'invalid_capture')

    def test_v1_does_not_accept_position_only_evidence_fields(self):
        data = packet(); data['protocol'] = self.capture.PROTOCOL
        self.assert_error(lambda: self.capture.normalize_capture_envelope(data), 'invalid_capture')
        data['evidence'].pop('owner_uuid')
        self.assert_error(lambda: self.capture.normalize_capture_envelope(data), 'invalid_capture')

    def test_private_validation_does_not_mutate_later_public_rejection(self):
        data = packet(); original = deepcopy(data)
        normalized = self.capture._normalize_capture_envelope(data)
        self.assertEqual(data, original)
        self.assert_error(lambda: self.capture.normalize_capture_envelope(normalized),
                          'unsupported_capture_version')

    def test_public_legacy_protocol_objects_are_canonical_without_input_mutation(self):
        for kind, protocol in nonexact_protocols(self.capture.PROTOCOL):
            with self.subTest(kind=kind):
                data = packet(self.capture.PROTOCOL)
                data['protocol'] = protocol
                before_envelope = dict(data)
                evidence, runs = data['evidence'], data['evidence']['runs']
                first = runs[0]
                before_evidence = deepcopy(evidence)
                normalized = self.capture.normalize_capture_envelope(data)
                self.assertEqual(normalized, packet(self.capture.PROTOCOL))
                self.assertIs(type(normalized['protocol']), str)
                self.assertIs(normalized['protocol'], self.capture.PROTOCOL)
                self.assertIs(data['protocol'], protocol)
                self.assertIs(data['evidence'], evidence)
                self.assertIs(data['evidence']['runs'], runs)
                self.assertIs(runs[0], first)
                self.assertEqual(evidence, before_evidence)
                self.assertEqual(data, before_envelope)
                self.assertIsNot(normalized['evidence'], evidence)
                self.assertIsNot(normalized['evidence']['runs'][0], first)
                if kind == 'equality_object':
                    self.assertEqual(protocol.value, self.capture.PROTOCOL)

    def test_public_equal_nonidentical_plain_string_emits_the_protocol_constant(self):
        protocol = ''.join((self.capture.PROTOCOL[:-1], self.capture.PROTOCOL[-1]))
        self.assertIs(type(protocol), str)
        self.assertEqual(protocol, self.capture.PROTOCOL)
        self.assertIsNot(protocol, self.capture.PROTOCOL)
        data = packet(self.capture.PROTOCOL); data['protocol'] = protocol
        before_envelope = dict(data)
        evidence, runs = data['evidence'], data['evidence']['runs']
        first = runs[0]
        before_evidence = deepcopy(evidence)
        normalized = self.capture.normalize_capture_envelope(data)
        self.assertEqual(normalized, packet(self.capture.PROTOCOL))
        self.assertIs(type(normalized['protocol']), str)
        self.assertIs(normalized['protocol'], self.capture.PROTOCOL)
        self.assertIs(data['protocol'], protocol)
        self.assertIs(data['evidence'], evidence)
        self.assertIs(data['evidence']['runs'], runs)
        self.assertIs(runs[0], first)
        self.assertEqual(evidence, before_evidence)
        self.assertEqual(data, before_envelope)

    def test_legacy_equality_accepted_versions_keep_malformed_evidence_precedence(self):
        variants = nonexact_protocols(self.capture.PROTOCOL)
        variants.append(('plain', ''.join((self.capture.PROTOCOL[:-1], self.capture.PROTOCOL[-1]))))
        for kind, protocol in variants:
            for evidence in (None, dict(packet(self.capture.PROTOCOL)['evidence'], runs=None)):
                with self.subTest(kind=kind, evidence=evidence):
                    data = packet(self.capture.PROTOCOL)
                    data.update(protocol=protocol, evidence=evidence)
                    self.assert_error(lambda: self.capture.normalize_capture_envelope(data), 'invalid_capture')
                    self.assertIs(data['protocol'], protocol)
                    self.assertIs(data['evidence'], evidence)

    def test_missing_and_extra_outer_fields_precede_any_protocol_comparison(self):
        class ComparisonForbidden:
            def __ne__(self, other):
                raise AssertionError('protocol comparison preceded outer-shape validation')
        variants = nonexact_protocols(self.capture.PROTOCOL) + [('comparison_trap', ComparisonForbidden())]
        for kind, protocol in variants:
            for shape in ('missing', 'extra'):
                with self.subTest(kind=kind, shape=shape):
                    data = packet(self.capture.PROTOCOL); data['protocol'] = protocol
                    if shape == 'missing':
                        data.pop('sequence')
                    else:
                        data['unexpected'] = True
                    self.assert_error(lambda: self.capture.normalize_capture_envelope(data), 'invalid_capture')
                    self.assertIs(data['protocol'], protocol)

    def test_private_normalizer_keeps_strict_protocol_types_for_both_versions(self):
        for version in (self.capture.PROTOCOL, self.capture.POSITION_PROTOCOL):
            for kind, protocol in nonexact_protocols(version):
                with self.subTest(version=version, kind=kind):
                    data = packet(version); data['protocol'] = protocol
                    self.assert_error(lambda: self.capture._normalize_capture_envelope(data),
                                      'unsupported_capture_version')
                    self.assertIs(data['protocol'], protocol)

    def test_private_exact_strings_keep_their_respective_evidence_schemas(self):
        for protocol in (self.capture.PROTOCOL, self.capture.POSITION_PROTOCOL):
            with self.subTest(protocol=protocol):
                data = packet(protocol)
                normalized = self.capture._normalize_capture_envelope(data)
                self.assertEqual(normalized, data)
                self.assertEqual('owner_uuid' in normalized['evidence'],
                                 protocol == self.capture.POSITION_PROTOCOL)


if __name__ == '__main__':
    unittest.main()
