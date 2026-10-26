"""NEW Stage A replacement plus transcript-reconstructed Stage B tests.
Source-only; requires fresh independent review and acceptance.

The pure module is loaded by file only at authorized test execution, bypassing package
bootstrap. This file uses only the Python standard library. No DB/app fixtures.
"""
from copy import deepcopy
from fractions import Fraction
import importlib.util
from itertools import product
from pathlib import Path
import sys
import unittest


MAX_I64 = (1 << 63) - 1
UNKNOWN = 'unknown'


def q(numerator, denominator=1):
    value = Fraction(numerator, denominator)
    return {'numerator': value.numerator, 'denominator': value.denominator}


def uid(number):
    return '00000000-0000-4000-8000-' + format(number, '012x')


def occurrence(lower=101, upper=101, basis='utc-ms'):
    return {'basis': basis, 'lower': q(lower), 'upper': q(upper)}


def mapping():
    return dict(actor_id=1, library_id=2, mapping_id='map-1', revision='map-r1',
                authority_ref='admitted-fixture-mapping', local_album_key='local-album',
                catalog_album_ref='catalog-album')


def member(track_id=11):
    return dict(track_id=track_id, required_class='unknown', media_extent_frames=96000,
                inventory_duration_ms=2500)


def run(index=0, parent=1, track=11, start=0, frames=48000):
    return dict(actor_id=1, library_id=2, local_album_key='local-album', track_id=track,
                capture_parent_uuid=uid(parent), checkpoint_sequence=1, run_index=index,
                checkpoint_digest='a' * 64, timeline_uuid=uid(100), source_start48=start,
                frames=frames, output_start=1000 + start, ordinal_start=start, epoch=1,
                binding_serial=parent, v1_session_uuid=None, anchor_before=None, anchor_after=None,
                quality='unknown', occurrence=None)


def batch():
    return dict(actor_id=1, library_id=2, local_album_key='local-album',
                source_cutoff={'basis': 'utc-ms', 'value': q(10000)}, evidence_revision='rev-1',
                scope={'kind': 'lifetime', 'baseline_id': None},
                snapshot=dict(snapshot_id='snapshot-1', fingerprint='b' * 64, library_id=2,
                    local_album_key='local-album', catalog_album_ref=None, mapping_id=None,
                    status='observed', provenance='local-inventory-v1', denominator_complete=False,
                    members=[member(11), member(12)], reason=None),
                runs=[], continuity=[], legacy_measured=[], imported_reported=[], mappings=[],
                history={'status': 'complete_recorded_scope', 'reasons': []})


def event(seq=1):
    return dict(type='event', actor_id=1, library_id=2, timeline_uuid=uid(100), event_sequence=seq,
                kind='natural_transition', output_frame=49000,
                before={'capture_uuid':uid(1),'binding_serial':1,'epoch':1},
                after={'capture_uuid':uid(2),'binding_serial':2,'epoch':2},
                quality='exact', observation=None, occurrence=None)


def loss(summary='loss-1', reported=None, parent=1):
    provenance = None if reported is None else dict(basis='accepted_capture_receipt',
        capture_parent_uuid=uid(parent), checkpoint_sequence=1, checkpoint_digest='a' * 64)
    return dict(type='loss', actor_id=1, library_id=2, local_album_key='local-album',
                timeline_uuid=uid(100), evidence_revision='rev-1', summary_id=summary,
                through=4, lost=[[2, 3]], reported_positive_frames=reported,
                report_provenance=provenance)


def legacy(record='legacy-1', seconds=None, plays=1):
    return dict(actor_id=1, library_id=2, local_album_key='local-album', source_kind='legacy-measured-v1',
                source_record_id=record, revision='r1', track_id=11, reported_plays=plays,
                measured_seconds=seconds)


def imported(record='import-1', source='lastfm-scrobble', plays=1):
    return dict(actor_id=1, library_id=2, local_album_key='local-album', source_kind=source,
                source_record_id=record, revision='r1', track_id=11, reported_plays=plays)


def membership():
    return dict(actor_id=1, library_id=2, top_ref='top-1', catalog_album_ref='catalog-album',
                item_incarnation_ref='item-1', participant_baseline_id='baseline-1',
                baseline_time={'basis': 'utc-ms', 'value': q(100)},
                baseline_provenance=dict(item_incarnation_ref='item-1', participant_ref='participant-1',
                    origin='item_added', authority_ref='admitted-top-baseline'),
                active=True, revision='membership-r1', input_evidence_complete=True, input_reasons=[])


def rating(identifier='rating-1', when=None):
    return dict(actor_id=1, library_id=2, catalog_album_ref='catalog-album', rating_event_id=identifier,
                kind='native_rating_intent', value_ref='same-existing-rating-value',
                occurrence=occurrence() if when is None else when,
                identity={'basis': 'catalog_native', 'authority_ref': 'native-rating-owner'})


def play(identifier='play-1', result=True, policy='approved'):
    return dict(actor_id=1, library_id=2, catalog_album_ref='catalog-album',
                witness_namespace='native-approved-fixture', witness_id=identifier,
                occurrence=occurrence(), identity={'basis': 'catalog_native', 'authority_ref': 'play-owner'},
                qualification={'policy_version': 'fixture-policy', 'policy_status': policy, 'result': result})


def metric_value(result, name):
    return result['metrics'][name]['value']


def source_group(result, kind):
    return next(group for group in result['metrics']['source_time_totals'] if group['source_kind'] == kind)


class AlbumListeningStageAContract(unittest.TestCase):
    """NEW replacement tests, not recovered or covered by prior acceptance.

    Literal examples and bounded input-domain tables are independent oracles.
    Large boundary fixtures are authored only, with no performance claim.
    """
    @classmethod
    def setUpClass(cls):
        cls._module_name = '_album_listening_metrics_pure_contract'
        cls._previous_module = sys.modules.get(cls._module_name)
        path = Path(__file__).resolve().parents[2] / 'music_app/services/album_listening_metrics.py'
        spec = importlib.util.spec_from_file_location(cls._module_name, path)
        if spec is None or spec.loader is None:
            raise AssertionError('Missing pure source owner')
        module = importlib.util.module_from_spec(spec)
        sys.modules[cls._module_name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            if cls._previous_module is None:
                sys.modules.pop(cls._module_name, None)
            else:
                sys.modules[cls._module_name] = cls._previous_module
            raise
        cls.compute = staticmethod(module.compute_album_listening_metrics)
        cls.complete = staticmethod(module.evaluate_membership_completion_evidence)

    @classmethod
    def tearDownClass(cls):
        if cls._previous_module is None:
            sys.modules.pop(cls._module_name, None)
        else:
            sys.modules[cls._module_name] = cls._previous_module

    def assert_invalid(self, result, code='invalid_shape', completion=False):
        expected = dict(status='invalid_metrics_input', reasons=[code])
        if completion:
            expected.update(automatic_eligibility=UNKNOWN, rating_event_ids=[],
                            play_witness_ids=[], item_incarnation_ref=None,
                            participant_baseline_id=None)
        self.assertEqual(result, expected)

    def assert_resource(self, result, completion=False):
        expected = dict(status='incomplete', reasons=['resource_limit'])
        if completion:
            expected.update(automatic_eligibility=UNKNOWN, rating_event_ids=[],
                            play_witness_ids=[], item_incarnation_ref=None,
                            participant_baseline_id=None)
        self.assertEqual(result, expected)

    def assert_unallocated(self, result):
        self.assertEqual(result['status'], 'incomplete')
        self.assertEqual(result['predicates']['listened'], UNKNOWN)
        self.assertEqual(result['witnesses'], [])
        for name in ('full', 'partial', 'uninterrupted_full', 'target_coverage',
                     'tracks_at_target', 'album_time_equivalents'):
            self.assertEqual(result['metrics'][name], dict(value=None, status='unavailable',
                                                          reasons=['allocation_not_evaluated']))

    def test_replacement_empty_complete_and_partial_history(self):
        for status, expected in [('complete_recorded_scope', False), ('partial', UNKNOWN), ('unknown', UNKNOWN)]:
            value = batch(); value['history']['status'] = status
            result = self.compute(value)
            self.assert_unallocated(result)
            self.assertEqual(result['predicates']['has_plays'], expected)
            for name in ('known_position_frames', 'native_recorded_frames', 'reported_lost_frames'):
                self.assertEqual(result['metrics'][name], dict(value=0, status='exact_recorded', reasons=[]))

    def test_replacement_policy_target_never_release_allocator(self):
        value = batch(); value['runs'] = [run()]
        for policy in (None, dict(version='v', status='proposed'), dict(version='v', status='approved')):
            for target in (1, 5, MAX_I64):
                result = self.compute(value, policy=policy, target=target)
                self.assert_unallocated(result)
                self.assertEqual(result['target'], target)
                self.assertEqual(result['predicates']['has_plays'], True)
                self.assertEqual(result['policy_status'], 'absent' if policy is None else policy['status'])

    def test_replacement_native_repeat_time_and_position_union(self):
        value = batch(); value['runs'] = [run(0, start=0), run(1, start=24000), run(2, start=96000, frames=24000)]
        result = self.compute(value)
        self.assertEqual(metric_value(result, 'native_recorded_frames'), 120000)
        self.assertEqual(metric_value(result, 'known_position_frames'), 96000)
        self.assertEqual(source_group(result, 'native-v2')['seconds']['value'], q(5, 2))
        self.assertEqual(result['metrics']['track_coverage'][0]['source_intervals'], [[0, 72000], [96000, 120000]])

    def test_replacement_distinct_track_coordinates_do_not_union(self):
        value = batch(); value['runs'] = [run(), run(parent=2, track=12)]
        result = self.compute(value)
        self.assertEqual(metric_value(result, 'known_position_frames'), 96000)
        self.assertEqual([r['track_id'] for r in result['metrics']['track_coverage']], [11, 12])

    def test_replacement_replay_dedup_and_input_permutation(self):
        value = batch(); value['runs'] = [run(1, start=48000), run(), run()]
        value['imported_reported'] = [imported('z'), imported('a')]
        before = deepcopy(value); result = self.compute(value)
        self.assertEqual(value, before)
        self.assertEqual(metric_value(result, 'native_recorded_frames'), 96000)
        other = deepcopy(value)
        for field in ('runs', 'imported_reported'):
            other[field].reverse()
        self.assertEqual(self.compute(other), result)
        self.assertEqual(other['runs'], list(reversed(before['runs'])))

    def test_replacement_run_replay_content_is_immutable(self):
        for field, changed in [('frames', 47999), ('epoch', 2), ('anchor_before', [1, 2]),
                               ('occurrence', occurrence()), ('v1_session_uuid', uid(9))]:
            value = batch(); first = run(); second = deepcopy(first); second[field] = changed
            value['runs'] = [first, second]
            self.assert_invalid(self.compute(value), 'evidence_conflict')

    def test_replacement_parent_track_timeline_and_binding_are_immutable(self):
        for change in ({'track_id': 12}, {'timeline_uuid': uid(101)},
                       {'capture_parent_uuid': uid(2)}):
            value = batch(); second = run(index=1); second.update(change)
            value['runs'] = [run(), second]
            self.assert_invalid(self.compute(value), 'evidence_conflict')

    def test_replacement_checkpoint_digest_not_identity(self):
        value = batch(); second = run(index=1); second['checkpoint_digest'] = 'c' * 64
        value['runs'] = [run(), second]
        self.assert_invalid(self.compute(value), 'checkpoint_digest_conflict')
        second['checkpoint_sequence'] = 2
        self.assertEqual(metric_value(self.compute(value), 'native_recorded_frames'), 96000)

    def test_replacement_positive_run_needs_no_clock_or_amplitude(self):
        value = batch(); value['runs'] = [run(frames=1)]
        result = self.compute(value)
        self.assertEqual(result['predicates']['has_plays'], True)
        self.assertEqual(source_group(result, 'native-v2')['seconds']['value'], q(1, 48000))
        self.assert_unallocated(result)

    def test_replacement_output_ordinal_inventory_and_wall_time_not_source_time(self):
        value = batch(); record = run(start=24000, frames=24000)
        record.update(output_start=987654, ordinal_start=999, occurrence=occurrence(-20, -10))
        value['runs'] = [record]; value['snapshot']['members'][0]['inventory_duration_ms'] = MAX_I64
        result = self.compute(value)
        self.assertEqual(source_group(result, 'native-v2')['seconds']['value'], q(1, 2))
        self.assertEqual(result['metrics']['track_coverage'][0]['source_intervals'], [[24000, 48000]])

    def test_replacement_signed_integer_bounds_and_boolean_rejection(self):
        for field, invalid in [('frames', 0), ('frames', True), ('frames', MAX_I64+1),
                               ('run_index', -1), ('track_id', 0), ('epoch', False),
                               ('source_start48', -1), ('output_start', MAX_I64)]:
            value = batch(); record = run(); record[field] = invalid; value['runs'] = [record]
            self.assert_invalid(self.compute(value), 'invalid_integer')

    def test_replacement_identifier_and_closed_record_domains(self):
        for field, invalid in [('capture_parent_uuid', uid(10).upper()), ('checkpoint_digest', 'A'*64),
                               ('local_album_key', ''), ('local_album_key', '\x00'),
                               ('local_album_key', 'é'*65)]:
            value = batch(); record = run(); record[field] = invalid; value['runs'] = [record]
            self.assert_invalid(self.compute(value), 'invalid_identifier')
        for invalid in (None, [], {}, dict(batch(), extra=True)):
            self.assert_invalid(self.compute(invalid))
        value = batch(); value['runs'] = [dict(run(), amplitude=0)]
        self.assert_invalid(self.compute(value))

    def test_replacement_rational_and_occurrence_domains(self):
        for invalid in (dict(numerator=2, denominator=2), dict(numerator=True, denominator=1),
                        dict(numerator=1, denominator=0), dict(numerator=1, denominator=-1),
                        dict(numerator=1.0, denominator=1)):
            value = batch(); value['source_cutoff']['value'] = invalid
            self.assert_invalid(self.compute(value), 'invalid_rational')
        value = batch(); record = run(); record['occurrence'] = occurrence(2, 1); value['runs'] = [record]
        self.assert_invalid(self.compute(value), 'invalid_time_bounds')

    def test_replacement_policy_target_and_namespace_validation(self):
        for target in (0, -1, True, 1.0, MAX_I64+1):
            self.assert_invalid(self.compute(batch(), target=target), 'invalid_target')
        for policy in ({}, dict(version='v', status='active'), dict(version='', status='approved')):
            self.assert_invalid(self.compute(batch(), policy=policy), 'invalid_policy')
        value = batch(); record = run(); record['quality'] = 'exact'; value['runs'] = [record]
        self.assert_invalid(self.compute(value), 'invalid_namespace')

    def test_replacement_anchor_epoch_and_event_observation_validation(self):
        value = batch(); record = run(); record.update(quality='bounded', anchor_before=[1, 1], anchor_after=[1, 2])
        value['runs'] = [record]
        self.assertEqual(metric_value(self.compute(value), 'native_recorded_frames'), 48000)
        record['anchor_after'] = [2, 2]; self.assert_invalid(self.compute(value))
        for changes in ({'kind': 'capture_resync'}, {'output_frame': None},
                        {'observation': dict(revision=1, generation=1)}):
            value = batch(); ev = event(); ev.update(changes); value['continuity'] = [ev]
            self.assert_invalid(self.compute(value))
        value = batch(); ev = event(); ev.update(kind='capture_resync', observation=dict(revision=1, generation=1))
        value['continuity'] = [ev]; self.assert_unallocated(self.compute(value))

    def test_replacement_scope_and_snapshot_reject_without_partial_result(self):
        for field in ('actor_id', 'library_id', 'local_album_key', 'track_id'):
            value = batch(); record = run(); record[field] = 'other' if field == 'local_album_key' else 999
            value['runs'] = [record]; self.assert_invalid(self.compute(value), 'scope_mismatch')
        value = batch(); value['snapshot']['members'].append(member())
        self.assert_invalid(self.compute(value), 'invalid_snapshot')
        value = batch(); value['snapshot']['denominator_complete'] = True
        self.assert_invalid(self.compute(value), 'invalid_snapshot')

    def test_replacement_explicit_mapping_and_immutable_revision(self):
        value = batch(); value['snapshot'].update(catalog_album_ref='catalog-album', mapping_id='map-1')
        self.assert_invalid(self.compute(value), 'mapping_missing')
        value['mappings'] = [mapping()]; self.assert_unallocated(self.compute(value))
        changed = mapping(); changed['revision'] = 'r2'; value['mappings'].append(changed)
        self.assert_invalid(self.compute(value), 'mapping_conflict')

    def test_replacement_denominator_does_not_activate_stage_a(self):
        value = batch(); value['snapshot'].update(provenance='authoritative-catalog-v1',
            denominator_complete=True, catalog_album_ref='catalog-album', mapping_id='map-1')
        for item in value['snapshot']['members']: item['required_class'] = 'required'
        value['mappings'] = [mapping()]; value['runs'] = [run(), run(parent=2, track=12)]
        self.assert_unallocated(self.compute(value, policy=dict(version='v', status='approved')))
        value['snapshot']['members'][0]['media_extent_frames'] = None
        self.assert_invalid(self.compute(value), 'invalid_snapshot')

    def test_replacement_unknown_snapshot_can_report_recorded_time(self):
        value = batch(); value['snapshot'].update(status='unknown', reason='snapshot_unknown', members=[])
        value['runs'] = [run()]; result = self.compute(value)
        self.assertEqual(metric_value(result, 'native_recorded_frames'), 48000)
        self.assertIn('denominator_unavailable', result['reasons'])
        self.assert_unallocated(result)

    def test_replacement_loss_does_not_fabricate_frames_or_time(self):
        value = batch(); value['continuity'] = [loss()]
        result = self.compute(value)
        self.assertEqual(result['metrics']['reported_lost_frames'], dict(value=None, status='unavailable', reasons=['loss_time_unknown']))
        self.assertEqual(metric_value(result, 'native_recorded_frames'), 0)
        self.assertEqual(metric_value(result, 'known_position_frames'), 0)
        self.assertEqual(source_group(result, 'native-v2')['seconds']['value'], q(0))

    def test_replacement_receipt_reports_use_maximum_not_sum(self):
        value = batch(); value['continuity'] = [loss('a', 100), loss('b', 200, parent=2)]
        result = self.compute(value)
        self.assertEqual(result['metrics']['reported_lost_frames'], dict(value=200, status='lower_bound', reasons=[]))
        self.assertEqual(result['predicates']['has_plays'], True)
        self.assertEqual(metric_value(result, 'native_recorded_frames'), 0)

    def test_replacement_receipt_quantities_and_digest_conflicts(self):
        value = batch(); value['continuity'] = [loss('a', 100), loss('b', 101)]
        self.assert_invalid(self.compute(value), 'evidence_conflict')
        value['continuity'] = [loss('a', 100)]; value['runs'] = [run()]
        value['continuity'][0]['report_provenance']['checkpoint_digest'] = 'c'*64
        self.assert_invalid(self.compute(value), 'checkpoint_digest_conflict')

    def test_replacement_event_and_loss_duplicate_content_conflicts(self):
        for first, field, changed in [(event(), 'kind', 'pause'), (loss(), 'through', 5)]:
            value = batch(); other = deepcopy(first); other[field] = changed
            value['continuity'] = [first, deepcopy(first)]
            self.assert_unallocated(self.compute(value))
            value['continuity'] = [first, other]
            self.assert_invalid(self.compute(value), 'evidence_conflict')

    def test_replacement_legacy_imports_remain_separate_from_native(self):
        value = batch(); value['legacy_measured'] = [legacy(seconds=q(3, 2))]
        value['imported_reported'] = [imported(plays=7)]; value['runs'] = [run()]
        result = self.compute(value)
        self.assertEqual(metric_value(result, 'native_recorded_frames'), 48000)
        self.assertEqual(source_group(result, 'legacy-measured-v1')['seconds']['value'], q(3, 2))
        self.assertEqual(source_group(result, 'lastfm-scrobble')['seconds']['value'], None)
        self.assertEqual(source_group(result, 'lastfm-scrobble')['buckets'][0]['reported_plays']['value'], 7)
        value['runs'][0]['v1_session_uuid'] = uid(9)
        self.assertEqual(self.compute(value)['metrics'], result['metrics'])

    def test_replacement_unknown_source_time_and_partial_known_sum(self):
        value = batch(); value['legacy_measured'] = [legacy('a', q(1, 3)), legacy('b', None)]
        result = self.compute(value)
        self.assertEqual(source_group(result, 'legacy-measured-v1')['seconds'], dict(value=q(1, 3), status='lower_bound', reasons=[]))
        value['legacy_measured'] = [legacy(seconds=None, plays=None)]
        self.assertEqual(source_group(self.compute(value), 'legacy-measured-v1')['seconds']['value'], None)

    def test_replacement_source_record_identity_excludes_revision(self):
        value = batch(); value['imported_reported'] = [imported(), imported()]
        self.assertEqual(len(source_group(self.compute(value), 'lastfm-scrobble')['buckets']), 1)
        value['imported_reported'][1]['revision'] = 'r2'
        self.assert_invalid(self.compute(value), 'evidence_conflict')

    def test_replacement_zero_imports_require_complete_scope_for_false(self):
        for history, expected in [('complete_recorded_scope', False), ('partial', UNKNOWN)]:
            value = batch(); value['history']['status'] = history
            value['imported_reported'] = [imported(plays=0)]
            self.assertEqual(self.compute(value)['predicates']['has_plays'], expected)

    def test_replacement_totals_exceed_input_integer_width_without_truncation(self):
        value = batch(); value['runs'] = [run(parent=p, frames=MAX_I64-1000) for p in (1, 2)]
        result = self.compute(value)
        self.assertEqual(metric_value(result, 'native_recorded_frames'), 2*(MAX_I64-1000))
        self.assertEqual(source_group(result, 'native-v2')['seconds']['value'], q(2*(MAX_I64-1000), 48000))

    def test_replacement_exact_rational_256_bit_boundary(self):
        denominators = [9223372036854775783, 9223372036854775643, 9223372036854775549, 9223372036854775507]
        value = batch(); value['legacy_measured'] = [legacy(str(i), q(1, d)) for i, d in enumerate(denominators)]
        value['legacy_measured'].append(legacy('z', q(1, 16)))
        expected = sum((Fraction(1, d) for d in denominators), Fraction(1, 16))
        self.assertEqual(source_group(self.compute(value), 'legacy-measured-v1')['seconds']['value'], q(expected))
        value['legacy_measured'][-1]['measured_seconds'] = q(1, 32)
        self.assert_resource(self.compute(value))
        value['legacy_measured'].reverse(); self.assert_resource(self.compute(value))

    def test_replacement_raw_collection_limits_precede_validation(self):
        for field, limit, entry in [('runs', 100000, run()), ('continuity', 100000, event()),
                                    ('mappings', 4096, mapping()), ('imported_reported', 1024, imported())]:
            value = batch(); value[field] = [entry]*limit
            self.assert_unallocated(self.compute(value))
            value[field].append(None)
            self.assert_resource(self.compute(value))
        value = batch(); value['legacy_measured'] = [legacy()]*512; value['imported_reported'] = [imported()]*513
        self.assert_resource(self.compute(value))

    def test_replacement_member_reason_and_loss_range_limits(self):
        value = batch(); value['snapshot']['members'] = [member(i+1) for i in range(512)]
        self.assert_unallocated(self.compute(value))
        value['snapshot']['members'].append(None); self.assert_resource(self.compute(value))
        value = batch(); value['history'] = dict(status='partial', reasons=['history_partial']*8)
        self.assert_unallocated(self.compute(value))
        value['history']['reasons'].append(None); self.assert_resource(self.compute(value))
        value = batch(); receipt = loss(); receipt.update(through=16, lost=[[i, i] for i in range(1, 16, 2)])
        value['continuity'] = [receipt]; self.assert_unallocated(self.compute(value))
        receipt['lost'].append(None); self.assert_resource(self.compute(value))

    def test_replacement_completion_empty_scope_and_inactive_validation(self):
        owner = membership()
        self.assertEqual(self.complete(owner, [], [])['automatic_eligibility'], False)
        owner['input_evidence_complete'] = False
        self.assertEqual(self.complete(owner, [], [])['automatic_eligibility'], UNKNOWN)
        owner['active'] = False
        self.assertEqual(self.complete(owner, [rating()], [play()])['automatic_eligibility'], False)
        wrong = rating(); wrong['actor_id'] = 9
        self.assert_invalid(self.complete(owner, [wrong], [play()]), 'scope_mismatch', completion=True)

    def test_replacement_completion_literal_three_value_truth_table(self):
        # Explicit nine-entry conjunction oracle, not copied production branching.
        cases = [(True, True, True), (True, False, False), (True, UNKNOWN, UNKNOWN),
                 (False, True, False), (False, False, False), (False, UNKNOWN, False),
                 (UNKNOWN, True, UNKNOWN), (UNKNOWN, False, False), (UNKNOWN, UNKNOWN, UNKNOWN)]
        for left, right, expected in cases:
            r = rating(); r['occurrence'] = {True: occurrence(), False: occurrence(100, 100), UNKNOWN: None}[left]
            p = play(result=right)
            result = self.complete(membership(), [r], [p])
            self.assertEqual(result['automatic_eligibility'], expected)

    def test_replacement_completion_strict_baseline_crossing_and_clock(self):
        for when, expected in [(occurrence(99, 99), False), (occurrence(100, 100), False),
                               (occurrence(100, 101), UNKNOWN), (occurrence(101), True),
                               (None, UNKNOWN), (occurrence(101, basis='unreconciled'), UNKNOWN)]:
            r = rating(); r['occurrence'] = when
            self.assertEqual(self.complete(membership(), [r], [play()])['automatic_eligibility'], expected)

    def test_replacement_completion_fractional_freshness_no_rounding(self):
        owner = membership(); owner['baseline_time']['value'] = q(MAX_I64-1, MAX_I64)
        r = rating(); r['occurrence'] = dict(basis='utc-ms', lower=q(1), upper=q(1))
        p = play(); p['occurrence'] = deepcopy(r['occurrence'])
        self.assertEqual(self.complete(owner, [r], [p])['automatic_eligibility'], True)
        r['occurrence']['lower'] = r['occurrence']['upper'] = q(MAX_I64-1, MAX_I64)
        self.assertEqual(self.complete(owner, [r], [p])['automatic_eligibility'], False)

    def test_replacement_completion_proposed_policy_never_qualifies(self):
        for policy in ('proposed', 'unknown'):
            for candidate in (True, False, UNKNOWN):
                result = self.complete(membership(), [rating()], [play(result=candidate, policy=policy)])
                self.assertEqual(result['automatic_eligibility'], UNKNOWN)
                self.assertEqual(result['play_witness_ids'], [])
                self.assertIn('qualification_pending', result['reasons'])
        p = play(result=False); p['occurrence'] = None
        self.assertEqual(self.complete(membership(), [rating()], [p])['automatic_eligibility'], False)

    def test_replacement_completion_genuine_rerating_not_current_or_replay(self):
        for kind in ('current_preference', 'imported', 'replay', 'recomputed'):
            r = rating(); r['kind'] = kind
            self.assertEqual(self.complete(membership(), [r], [play()])['automatic_eligibility'], False)
        r = rating(); duplicate = deepcopy(r)
        result = self.complete(membership(), [r, duplicate, rating('new-action')], [play()])
        self.assertEqual(result['automatic_eligibility'], True)
        self.assertEqual(result['rating_event_ids'], ['new-action', 'rating-1'])

    def test_replacement_completion_existential_true_in_partial_scope(self):
        owner = membership(); owner['input_evidence_complete'] = False
        r = rating('unknown'); r['occurrence'] = None
        result = self.complete(owner, [r, rating()], [play('unknown', result=UNKNOWN), play()])
        self.assertEqual(result['automatic_eligibility'], True)
        self.assertEqual(result['status'], 'incomplete')
        self.assertEqual(result['rating_event_ids'], ['rating-1'])
        self.assertEqual(result['play_witness_ids'], [dict(witness_namespace='native-approved-fixture', witness_id='play-1')])

    def test_replacement_completion_local_mapping_required_and_scoped(self):
        r = rating(); r['identity'] = dict(basis='local_album', local_album_key='local-album', mapping=None)
        self.assert_invalid(self.complete(membership(), [r], [play()]), 'mapping_missing', completion=True)
        r['identity']['mapping'] = mapping()
        self.assertEqual(self.complete(membership(), [r], [play()])['automatic_eligibility'], True)
        r['identity']['mapping']['catalog_album_ref'] = 'other'
        self.assert_invalid(self.complete(membership(), [r], [play()]), 'scope_mismatch', completion=True)

    def test_replacement_completion_replay_identity_excludes_time_and_policy(self):
        for ratings, plays in [([rating(), rating()], [play()]), ([rating()], [play(), play()])]:
            self.assertEqual(self.complete(membership(), ratings, plays)['automatic_eligibility'], True)
        r = rating(); r['occurrence'] = occurrence(102, 102)
        self.assert_invalid(self.complete(membership(), [rating(), r], [play()]), 'evidence_conflict', completion=True)
        p = play(result=False)
        self.assert_invalid(self.complete(membership(), [rating()], [play(), p]), 'evidence_conflict', completion=True)
        p['witness_namespace'] = 'another-owner'
        self.assertEqual(self.complete(membership(), [rating()], [play(), p])['automatic_eligibility'], True)

    def test_replacement_completion_incarnation_baseline_and_no_manual_mutation(self):
        owner = membership(); owner.update(item_incarnation_ref='item-2', participant_baseline_id='baseline-2')
        owner['baseline_provenance']['item_incarnation_ref'] = 'item-2'
        before = deepcopy(owner); result = self.complete(owner, [rating()], [play()])
        self.assertEqual(owner, before)
        self.assertEqual(result['item_incarnation_ref'], 'item-2')
        self.assertEqual(result['participant_baseline_id'], 'baseline-2')
        self.assertEqual(set(result), set(('status automatic_eligibility rating_event_ids play_witness_ids reasons item_incarnation_ref participant_baseline_id').split()))
        owner['manually_completed'] = True
        self.assert_invalid(self.complete(owner, [rating()], [play()]), completion=True)

    def test_replacement_completion_determinism_and_no_input_mutation(self):
        owner = membership(); ratings = [rating('z'), rating('a')]; plays = [play('z'), play('a')]
        before = deepcopy((owner, ratings, plays)); result = self.complete(owner, ratings, plays)
        self.assertEqual((owner, ratings, plays), before)
        self.assertEqual(result, self.complete(owner, list(reversed(ratings)), list(reversed(plays))))
        self.assertEqual(result['rating_event_ids'], ['a', 'z'])
        self.assertEqual([p['witness_id'] for p in result['play_witness_ids']], ['a', 'z'])

    def test_replacement_completion_raw_caps_and_resource_precedence(self):
        self.assertEqual(self.complete(membership(), [rating()]*4096, [play()])['automatic_eligibility'], True)
        self.assertEqual(self.complete(membership(), [rating()], [play()]*4096)['automatic_eligibility'], True)
        self.assert_resource(self.complete(None, [rating()]*4097, []), completion=True)
        self.assert_resource(self.complete(None, [], [play()]*4097), completion=True)
        owner = membership(); owner.update(input_evidence_complete=False, input_reasons=['history_partial']*8)
        self.assertEqual(self.complete(owner, [rating()], [play()])['automatic_eligibility'], True)
        owner['input_reasons'].append(None)
        self.assert_resource(self.complete(owner, [], []), completion=True)

    def test_replacement_completion_combined_inline_mapping_cap(self):
        r = rating(); p = play()
        identity = dict(basis='local_album', local_album_key='local-album', mapping=mapping())
        r['identity'] = deepcopy(identity); p['identity'] = deepcopy(identity)
        self.assertEqual(self.complete(membership(), [r]*2048, [p]*2048)['automatic_eligibility'], True)
        self.assert_resource(self.complete(membership(), [r]*2048, [p]*2049), completion=True)

    def test_replacement_negative_reliable_time_is_valid_not_receipt_time(self):
        owner = membership(); owner['baseline_time']['value'] = q(-100)
        r = rating(); r['occurrence'] = occurrence(-99, -99)
        p = play(); p['occurrence'] = occurrence(-99, -99)
        self.assertEqual(self.complete(owner, [r], [p])['automatic_eligibility'], True)
        r['occurrence'] = occurrence(-100, -100)
        self.assertEqual(self.complete(owner, [r], [p])['automatic_eligibility'], False)

    def test_replacement_completion_malformed_closed_shapes(self):
        for owner, ratings, plays in [(None, [], []), (dict(membership(), extra=1), [], []),
                                      (membership(), None, []), (membership(), [], {}),
                                      (membership(), [dict(rating(), extra=1)], [])]:
            self.assert_invalid(self.complete(owner, ratings, plays), completion=True)
        p = play(); p['qualification']['result'] = 1
        self.assert_invalid(self.complete(membership(), [], [p]), 'invalid_namespace', completion=True)

    def test_replacement_completion_baseline_provenance_scope(self):
        owner = membership(); owner['baseline_provenance']['item_incarnation_ref'] = 'other-item'
        self.assert_invalid(self.complete(owner, [rating()], [play()]), 'scope_mismatch', completion=True)
        owner = membership(); owner['active'] = 1
        self.assert_invalid(self.complete(owner, [], []), completion=True)

    def test_replacement_completion_inline_mapping_revision_conflict(self):
        r = rating(); p = play()
        r['identity'] = dict(basis='local_album', local_album_key='local-album', mapping=mapping())
        p['identity'] = deepcopy(r['identity']); p['identity']['mapping']['revision'] = 'r2'
        self.assert_invalid(self.complete(membership(), [r], [p]), 'mapping_conflict', completion=True)

    def test_replacement_completion_missing_rating_or_play_false_in_complete_scope(self):
        for ratings, plays, reason in [([], [play()], 'rating_missing'), ([rating()], [], 'play_missing')]:
            result = self.complete(membership(), ratings, plays)
            self.assertEqual(result['automatic_eligibility'], False)
            self.assertEqual(result['status'], 'complete')
            self.assertIn(reason, result['reasons'])

    def test_replacement_completion_definitely_old_unapproved_play_is_false(self):
        for policy in ('proposed', 'unknown'):
            p = play(policy=policy); p['occurrence'] = occurrence(100, 100)
            result = self.complete(membership(), [rating()], [p])
            self.assertEqual(result['automatic_eligibility'], False)
            self.assertEqual(result['play_witness_ids'], [])

    def test_replacement_nullable_qualification_unknown_not_approval(self):
        p = play(); p['qualification'] = None
        result = self.complete(membership(), [rating()], [p])
        self.assertEqual(result['automatic_eligibility'], UNKNOWN)
        self.assertIn('qualification_pending', result['reasons'])

    def test_replacement_missing_extent_and_unknown_class_leave_denominator_unavailable(self):
        value = batch(); value['snapshot']['members'][0]['media_extent_frames'] = None
        value['runs'] = [run()]
        result = self.compute(value)
        self.assertIn('denominator_unavailable', result['reasons'])
        self.assertEqual(metric_value(result, 'known_position_frames'), 48000)
        self.assert_unallocated(result)

    def test_replacement_membership_scope_requires_explicit_baseline(self):
        value = batch(); value['scope'] = dict(kind='membership', baseline_id='baseline-1')
        result = self.compute(value); self.assertEqual(result['scope'], value['scope'])
        self.assert_unallocated(result)
        value['scope']['baseline_id'] = None; self.assert_invalid(self.compute(value))
        value['scope'] = dict(kind='lifetime', baseline_id='baseline-1')
        self.assert_invalid(self.compute(value))

    def test_replacement_loss_ranges_are_ordered_disjoint_and_canonical(self):
        for ranges in ([[0, 1]], [[3, 2]], [[1, 5]], [[1, 2], [3, 4]], [[3, 3], [1, 1]]):
            value = batch(); receipt = loss(); receipt['lost'] = ranges; value['continuity'] = [receipt]
            code = 'invalid_integer' if ranges == [[0, 1]] else 'invalid_shape'
            self.assert_invalid(self.compute(value), code)
        value = batch(); receipt = loss(); receipt.update(lost=[], reported_positive_frames=0,
            report_provenance=dict(basis='accepted_capture_receipt', capture_parent_uuid=uid(1),
                                   checkpoint_sequence=1, checkpoint_digest='a'*64))
        value['continuity'] = [receipt]
        self.assertEqual(self.compute(value)['predicates']['has_plays'], False)

    def test_replacement_event_endpoint_binding_conflict(self):
        value = batch(); value['runs'] = [run()]
        ev = event(); ev['before']['capture_uuid'] = uid(9); value['continuity'] = [ev]
        self.assert_invalid(self.compute(value), 'evidence_conflict')
        ev = event(); ev['timeline_uuid'] = uid(999); value['continuity'] = [ev]
        self.assert_invalid(self.compute(value), 'evidence_conflict')

    def test_replacement_projection_root_contract_and_source_order(self):
        value = batch(); value['imported_reported'] = [imported('z', 'manual-reported'), imported('a', 'foobar-playcount')]
        result = self.compute(value)
        self.assertEqual(set(result), set(('status actor_id library_id local_album_key source_cutoff evidence_revision scope snapshot history_status policy_version policy_status target metrics witnesses predicates reasons').split()))
        self.assertEqual([g['source_kind'] for g in result['metrics']['source_time_totals']],
                         ['foobar-playcount', 'manual-reported', 'native-v2'])
        self.assertEqual(result['snapshot'], dict(snapshot_id='snapshot-1', fingerprint='b'*64, status='observed'))


# Stage B candidate contract R2: source-authored, never executed in this packet.
# Synthetic authority below assumes chronological maximal traversals, authorized
# catalog/order, complete event enumeration and source cutoff. It is NOT evidence
# that an adapter exists or that empty continuity establishes those premises.
B_METRICS = ('full', 'partial', 'uninterrupted_full', 'target_coverage',
             'tracks_at_target', 'album_time_equivalents')
B_DEPENDENT = B_METRICS[:-1]


def b_ref(record):
    return {key: record[key] for key in
            ('capture_parent_uuid', 'checkpoint_sequence', 'run_index')}


def b_key(ref):
    return (ref['capture_parent_uuid'], ref['checkpoint_sequence'], ref['run_index'])


def b_endpoint(record):
    return dict(capture_uuid=record['capture_parent_uuid'],
                binding_serial=record['binding_serial'], epoch=record['epoch'])


def b_fixture(extents, sessions=(), optional=(), order=None):
    """Each session is [(track_id, source_start, source_end), ...].

    Independent synthetic timelines certify distinct scope-frontier sessions.
    Multi-track sessions assert exact natural transitions, NOT calendar inference.
    All coordinates passed to the public callable come from native Run records.
    """
    value = batch()
    order = list(extents) if order is None else list(order)
    value['snapshot'].update(provenance='authoritative-catalog-v1',
        denominator_complete=True, catalog_album_ref='catalog-album', mapping_id='map-1',
        members=[dict(track_id=t, required_class='optional' if t in optional else 'required',
                      media_extent_frames=d, inventory_duration_ms=1) for t, d in extents.items()])
    value['mappings'] = [mapping()]
    projection = dict(version='album-traversal-projection-v1', snapshot_id='snapshot-1',
        snapshot_fingerprint='b'*64, authority_ref='synthetic-admitted-maximal-complete-cutoff',
        ordered_track_ids=order, partition_status='complete', traversals=[], reasons=[])
    parent = 1
    for number, spans in enumerate(sessions):
        refs, joins, previous, output = [], [], None, 1000
        for t, start, end in spans:
            record = run(parent=parent, track=t, start=start, frames=end-start)
            record.update(timeline_uuid=uid(1000000+number), output_start=output, ordinal_start=0)
            parent += 1
            if previous is not None:
                ev = event(len(joins)+1)
                ev.update(timeline_uuid=record['timeline_uuid'], output_frame=output,
                          before=b_endpoint(previous), after=b_endpoint(record))
                value['continuity'].append(ev)
                joins.append(dict(kind='natural_transition',
                    event_ref=dict(timeline_uuid=ev['timeline_uuid'], event_sequence=ev['event_sequence']),
                    gap_basis='no_gap', gap_frames=0))
            value['runs'].append(record); refs.append(b_ref(record))
            previous = record; output += end-start
        projection['traversals'].append(dict(run_refs=refs, joins=joins,
                                            start_boundary='scope_edge', end_boundary='scope_edge'))
    return value, projection


def b_whole(first, last, extent=480000):
    return [(t, 0, extent) for t in range(first, last+1)]


def b_geometry(value, projection):
    """Small-fixture oracle: literal physical spans, not production normalization."""
    members = {m['track_id']: m for m in value['snapshot']['members']}
    required = [t for t in projection['ordered_track_ids'] if members[t]['required_class']=='required']
    denominator = sum(members[t]['media_extent_frames'] for t in required)
    offset, cores = Fraction(0), {}
    for t in required:
        d = members[t]['media_extent_frames']; trim = min(Fraction(48000), Fraction(d, 200))
        cores[t] = (trim, Fraction(d)-trim, offset)
        offset += d-2*trim
    records = {b_key(b_ref(r)): r for r in value['runs']}
    traversals, tokens = [], []
    for traversal in projection['traversals']:
        spans = []
        for ref in traversal['run_refs']:
            record = records[b_key(ref)]; t = record['track_id']
            if t in required:
                spans.append((t, Fraction(record['source_start48']),
                              Fraction(record['source_start48']+record['frames'])))
        traversals.append(spans)
        actual = sum((end-start for _, start, end in spans), Fraction(0))
        clipped = []
        for t, start, end in spans:
            left, right, base = cores[t]
            lo, hi = max(left,start), min(right,end)
            if lo < hi: clipped.append((base+lo-left,base+hi-left))
        if actual*5 >= denominator and clipped:
            tokens.append(dict(key=tuple(b_key(r) for r in traversal['run_refs']),
                               a=min(x[0] for x in clipped), b=max(x[1] for x in clipped),
                               spans=spans))
    return denominator, offset, required, members, traversals, tokens


def b_overlap(left, right):
    return sum((max(Fraction(0), min(b,d)-max(a,c))
                for t,a,b in left['spans'] for u,c,d in right['spans'] if t==u), Fraction(0))


def b_exhaustive(value, projection, target=5):
    """Independent bounded oracle: enumerate every path then every disjoint set.

    No flow, residual graph, cost potential, grouping or prefix feasibility solver.
    Deliberately limited to <=10 substantial tokens; never used for cap fixtures.
    Inputs to this oracle are valid synthetic monotone, disjoint-span traversals.
    """
    D, C, required, members, traversals, tokens = b_geometry(value, projection)
    if len(tokens)>10: raise AssertionError('Exhaustive oracle is small-fixture only')
    paths = []
    def walk(path, cost):
        last = tokens[path[-1]]
        if last['b']==C: paths.append((tuple(path),cost)); return
        for i, nxt in enumerate(tokens):
            overlap = b_overlap(last,nxt)
            if nxt['b']>last['b'] and nxt['a']<=last['b'] and overlap>0:
                walk(path+[i],cost+overlap)
    for i, token in enumerate(tokens):
        if token['a']==0: walk([i],Fraction(0))
    best = (0,0,Fraction(0),())
    def choose(at, used, selected, cost):
        nonlocal best
        keys = tuple(sorted(tuple(tokens[i]['key'] for i in path) for path in selected))
        score = (-len(selected),len(used),cost,keys)
        if score<best: best=score
        for index in range(at,len(paths)):
            path, extra = paths[index]
            if not used.intersection(path):
                choose(index+1,used.union(path),selected+[path],cost+extra)
    choose(0,set(),[],Fraction(0))
    covered, tracks = Fraction(0), 0
    for t in required:
        d = members[t]['media_extent_frames']
        points = sorted({Fraction(0),Fraction(d)} |
                        {x for spans in traversals for u,a,b in spans if u==t for x in (a,b)})
        entire = True
        for left,right in zip(points,points[1:]):
            midpoint = (left+right)/2
            layers = sum(any(u==t and a<=midpoint<b for u,a,b in spans) for spans in traversals)
            covered += (right-left)*min(layers,target)
            entire = entire and layers>=target
        tracks += entire
    native = sum(r['frames'] for r in value['runs'] if r['track_id'] in required)
    return dict(full=-best[0], partial=len(tokens)-best[1],
        uninterrupted_full=sum(t['a']==0 and t['b']==C for t in tokens),
        target_coverage=q(covered/(target*D)), tracks_at_target=tracks,
        album_time_equivalents=q(native,D)), best[3], best[:3]


class AlbumListeningStageBCandidateContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Separate execution gate; this method has only been parsed, never called.
        cls._name = '_album_listening_metrics_stage_b_contract'
        cls._old = sys.modules.get(cls._name)
        path = Path(__file__).resolve().parents[2] / 'music_app/services/album_listening_metrics.py'
        spec = importlib.util.spec_from_file_location(cls._name,path)
        if spec is None or spec.loader is None: raise AssertionError('Missing pure source owner')
        module = importlib.util.module_from_spec(spec); sys.modules[cls._name]=module
        try: spec.loader.exec_module(module)
        except BaseException:
            if cls._old is None: sys.modules.pop(cls._name,None)
            else: sys.modules[cls._name]=cls._old
            raise
        cls.candidate = staticmethod(module.compute_album_listening_candidates)
        cls.stage_a = staticmethod(module.compute_album_listening_metrics)
        cls.completion = staticmethod(module.evaluate_membership_completion_evidence)

    @classmethod
    def tearDownClass(cls):
        if cls._old is None: sys.modules.pop(cls._name,None)
        else: sys.modules[cls._name]=cls._old

    def assert_invalid(self, value, code='evidence_conflict'):
        self.assertEqual(value,dict(status='invalid_metrics_input',reasons=[code]))

    def assert_resource(self, value):
        self.assertEqual(value,dict(status='incomplete',reasons=['resource_limit']))

    def check(self, value, projection, expected=None, target=5, oracle=True):
        before = deepcopy((value,projection))
        result = self.candidate(value,projection,target=target)
        self.assertEqual((value,projection),before)
        self.assertEqual(set(result),set(('status policy_version policy_status actor_id library_id '
            'local_album_key evidence_revision snapshot_id snapshot_fingerprint scope target qualification '
            'predicates completion_witnesses metrics required_time_basis witnesses reasons').split()))
        self.assertEqual(result['status'],'incomplete')
        self.assertEqual(result['policy_version'],'album-overlap-r3-candidate-v1')
        self.assertEqual(result['policy_status'],'proposed')
        self.assertEqual(result['qualification'],UNKNOWN)
        self.assertEqual(result['predicates'],{'listened':UNKNOWN})
        self.assertEqual(result['completion_witnesses'],[])
        self.assertEqual(result['required_time_basis'],'native_required_track_frames')
        self.assertEqual(result['target'],target)
        for key in ('actor_id','library_id','local_album_key','evidence_revision','scope'):
            self.assertEqual(result[key],value[key])
        self.assertEqual(result['snapshot_id'],value['snapshot']['snapshot_id'])
        self.assertEqual(result['snapshot_fingerprint'],value['snapshot']['fingerprint'])
        self.assertEqual(set(result['metrics']),set(B_METRICS))
        self.assertEqual(result['reasons'],sorted(set(result['reasons'])))
        for reason in ('qualification_pending','candidate_only'): self.assertIn(reason,result['reasons'])
        for metric in result['metrics'].values():
            self.assertEqual(set(metric),{'value','status','reasons'})
            self.assertEqual(metric['reasons'],sorted(set(metric['reasons'])))
            if metric['value'] is not None:
                self.assertEqual(metric['status'],'exact_recorded')
                for reason in ('qualification_pending','candidate_only'): self.assertIn(reason,metric['reasons'])
        if expected is not None:
            for name,number in expected.items(): self.assertEqual(metric_value(result,name),number,name)
        if oracle:
            numbers,paths,_ = b_exhaustive(value,projection,target)
            for name,number in numbers.items(): self.assertEqual(metric_value(result,name),number,name)
            actual = tuple(tuple(tuple(b_key(r) for r in token) for token in witness['tokens'])
                           for witness in result['witnesses'])
            self.assertEqual(actual,paths)
            refs = []
            for witness in result['witnesses']:
                self.assertEqual(set(witness),{'tokens','uninterrupted'})
                self.assertIs(witness['uninterrupted'],len(witness['tokens'])==1)
                refs.extend(b_key(r) for token in witness['tokens'] for r in token)
            self.assertEqual(len(refs),len(set(refs)))
        return result

    def test_b_empty_complete_is_candidate_zero_never_qualification(self):
        value,projection=b_fixture({11:480000})
        self.check(value,projection,dict(full=0,partial=0,uninterrupted_full=0,
                   target_coverage=q(0),tracks_at_target=0,album_time_equivalents=q(0)))

    def test_b_stage_a_approved_metadata_and_completion_stay_inert(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        old=self.stage_a(value,policy={'version':'fixture-policy','status':'approved'})
        self.check(value,projection,dict(full=1,uninterrupted_full=1,partial=0))
        self.assertEqual(self.stage_a(value,policy={'version':'fixture-policy','status':'approved'}),old)
        for name in B_METRICS:
            self.assertEqual(old['metrics'][name],dict(value=None,status='unavailable',reasons=['allocation_not_evaluated']))
        self.assertEqual(old['predicates']['listened'],UNKNOWN)
        result=self.completion(membership(),[rating()],[play(policy='proposed')])
        self.assertEqual(result['automatic_eligibility'],UNKNOWN)
        self.assertEqual(result['play_witness_ids'],[])

    def test_b_physical_fringe_overlap_touching_cores_is_real_edge(self):
        value,projection=b_fixture({11:480000,12:480000},[
            [(11,0,480000),(12,0,1000)],[(11,479000,480000),(12,0,480000)]])
        self.check(value,projection,dict(full=1,partial=0,uninterrupted_full=0,
            target_coverage=q(481,2400),album_time_equivalents=q(481,480)))

    def test_b_same_core_endpoint_without_physical_overlap_is_not_edge(self):
        value,projection=b_fixture({11:480000,12:480000},[[(11,0,480000)],[(12,0,480000)]])
        self.check(value,projection,dict(full=0,partial=2,uninterrupted_full=0,target_coverage=q(1,5)))

    def test_b_twelve_track_five_three_two_whole_token_capacity(self):
        value,projection=b_fixture({t:480000 for t in range(1,13)},
                                  [b_whole(1,5)]*5+[b_whole(4,9)]*3+[b_whole(8,12)]*2)
        self.check(value,projection,dict(full=2,partial=4,uninterrupted_full=0,
            tracks_at_target=7,target_coverage=q(47,60),album_time_equivalents=q(53,12)))

    def test_b_separate_long_final_track_cannot_complete_by_union(self):
        extents={1:480000,2:480000,3:480000,4:480000,5:57600000}
        value,projection=b_fixture(extents,[b_whole(1,3),[(4,0,480000)],[(5,0,57600000)]])
        self.check(value,projection,dict(full=0,uninterrupted_full=0,target_coverage=q(1,5)))

    def test_b_actual_denominator_not_core_at_substantial_boundary(self):
        for end,partial in [(199999,0),(200000,1),(200001,1)]:
            value,projection=b_fixture({11:1000000},[[(11,0,end)]])
            self.check(value,projection,dict(full=0,partial=partial))

    def test_b_fractional_trim_short_final_track_and_full_extent_target(self):
        value,projection=b_fixture({11:201,12:1},[[(11,1,201),(12,0,1)]])
        self.check(value,projection,dict(full=1,uninterrupted_full=1,
            target_coverage=q(201,1010),tracks_at_target=0))
        value,projection=b_fixture({11:20000000},[[(11,48000,19952000)]])
        self.check(value,projection,dict(full=1,target_coverage=q(1244,6250)))

    def test_b_replay_layers_12_20_14_15_2_duration_weighted(self):
        sessions=[[(t,0,480000)] for t,count in enumerate((12,20,14,15,2),1) for _ in range(count)]
        value,projection=b_fixture({t:480000 for t in range(1,6)},sessions)
        self.check(value,projection,dict(full=0,partial=63,uninterrupted_full=0,
            target_coverage=q(22,25),tracks_at_target=4,album_time_equivalents=q(63,5)),oracle=False)
        value,projection=b_fixture({1:480000,2:960000},[[(1,0,480000)]]*5+[[(2,0,960000)]]*2)
        self.check(value,projection,dict(target_coverage=q(3,5),tracks_at_target=1))

    def test_b_non_substantial_layers_still_supply_target(self):
        value,projection=b_fixture({t:480000 for t in range(1,7)},[[(6,0,480000)]]*5)
        self.check(value,projection,dict(full=0,partial=0,target_coverage=q(1,6),tracks_at_target=1))

    def test_b_half_open_adjacent_source_coverage_has_no_point_mass(self):
        value,projection=b_fixture({11:1000000},[[(11,0,500000)],[(11,500000,1000000)]])
        self.check(value,projection,dict(full=0,partial=2,target_coverage=q(1,5)))

    def test_b_target_changes_no_allocation_witness_or_time(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]]*2)
        a=self.check(value,projection,target=5);b=self.check(value,projection,target=2)
        for key in ('witnesses','qualification','completion_witnesses'):self.assertEqual(a[key],b[key])
        for key in ('full','partial','uninterrupted_full','album_time_equivalents'):
            self.assertEqual(a['metrics'][key],b['metrics'][key])
        self.assertEqual(metric_value(b,'target_coverage'),q(1))
        self.assertEqual(metric_value(b,'tracks_at_target'),1)

    def test_b_uninterrupted_count_not_added_to_capacity_full(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]]*3)
        self.check(value,projection,dict(full=3,uninterrupted_full=3,partial=0))

    def test_b_partial_can_decrease_as_new_evidence_consumes_whole_token(self):
        a,pa=b_fixture({11:1000000},[[(11,0,600000)]])
        old=self.check(a,pa,dict(full=0,partial=1))
        b,pb=b_fixture({11:1000000},[[(11,0,600000)],[(11,400000,1000000)]])
        b['history']=deepcopy(a['history'])
        new=self.check(b,pb,dict(full=1,partial=0))
        self.assertEqual(b['runs'][0],a['runs'][0])
        self.assertGreater(metric_value(new,'album_time_equivalents')['numerator'],
                           metric_value(old,'album_time_equivalents')['numerator'])
        # Complete recorded scope exposes exact leftover tokens. Missing older
        # evidence can consume those leftovers, so it cannot expose a lifetime
        # partial count, even as full/time/coverage remain valid lower bounds.
        for value, projection, full in ((a, pa, 0), (b, pb, 1)):
            value['history']={'status':'partial','reasons':['history_partial']}
            before=deepcopy((value,projection))
            result=self.candidate(value,projection)
            self.assertEqual((value,projection),before)
            self.assertEqual(metric_value(result,'full'),full)
            self.assertEqual(result['metrics']['partial']['status'],'unavailable')
            self.assertIsNone(result['metrics']['partial']['value'])
            for name, metric in result['metrics'].items():
                if name != 'partial': self.assertEqual(metric['status'],'lower_bound')
                self.assertIn('history_incomplete',metric['reasons'])

    def test_b_global_flow_reassignment_beats_first_available_path(self):
        # One physical track; scale 100000 makes trim 6000, not invented normalized input.
        spans=[(0,600000),(0,400000),(300000,800000),(500000,1000000),
               (700000,1200000),(900000,1200000)]
        value,projection=b_fixture({11:1200000},[[(11,a,b)] for a,b in spans])
        self.check(value,projection,dict(full=2,partial=0,uninterrupted_full=0))

    def test_b_equal_full_minimizes_consumed_tokens_before_overlap(self):
        spans=[(0,900000),(0,400000),(300000,700000),(600000,1000000)]
        value,projection=b_fixture({11:1000000},[[(11,a,b)] for a,b in spans])
        result=self.check(value,projection,dict(full=1,partial=2))
        self.assertEqual(result['witnesses'][0]['tokens'],
                         [[b_ref(value['runs'][0])],[b_ref(value['runs'][3])]])
        # Additional direct whole token must remain its own one-token witness.
        value,projection=b_fixture({11:1000000},[[(11,0,1000000)],[(11,0,700000)],[(11,300000,1000000)]])
        result=self.check(value,projection,dict(full=2,partial=0))
        self.assertEqual(sorted(len(w['tokens']) for w in result['witnesses']),[1,2])

    def test_b_overlap_cost_precedes_smallest_token_key(self):
        # Earlier sink has larger overlap; equal F/K must choose later lower-overlap key.
        value,projection=b_fixture({11:1000000},[[(11,0,700000)],[(11,200000,1000000)],[(11,600000,1000000)]])
        result=self.check(value,projection,dict(full=1,partial=1))
        self.assertEqual(result['witnesses'][0]['tokens'][-1],[b_ref(value['runs'][2])])

    def test_b_one_frame_overlap_cost_not_display_rounded(self):
        value,projection=b_fixture({11:10000000},[[(11,0,7000000)],[(11,6000000,10000000)],[(11,6000001,10000000)]])
        result=self.check(value,projection)
        self.assertEqual(result['witnesses'][0]['tokens'][-1],[b_ref(value['runs'][2])])

    def test_b_lex_path_list_and_identical_group_token_identity(self):
        value,projection=b_fixture({11:1000000},[[(11,0,600000)]]*2+[[(11,400000,1000000)]]*2)
        result=self.check(value,projection,dict(full=2,partial=0))
        self.assertEqual(result['witnesses'][0]['tokens'],[[b_ref(value['runs'][0])],[b_ref(value['runs'][2])]])
        self.assertEqual(result['witnesses'][1]['tokens'],[[b_ref(value['runs'][1])],[b_ref(value['runs'][3])]])

    def test_b_prefix_cannot_detach_or_reuse_capacity_to_claim_fixed_optimum(self):
        # Small-key M1 continuation from S1 strands S2: prefix must stay attached.
        spans=[(0,600000),(0,400000),(300000,800000),(500000,1000000),
               (700000,1200000),(900000,1200000)]
        value,projection=b_fixture({11:1200000},[[(11,a,b)] for a,b in spans])
        result=self.check(value,projection,dict(full=2,partial=0))
        self.assertEqual(result['witnesses'][0]['tokens'][1],[b_ref(value['runs'][3])])

    def test_b_exhaustive_small_physical_families_and_input_permutations(self):
        # Deterministic bounded catalogue; no randomness or production-derived expectations.
        catalogue=[(0,400000),(0,650000),(250000,750000),(550000,1000000),(700000,1000000)]
        for bits in product((False,True),repeat=len(catalogue)):
            sessions=[[(11,a,b)] for keep,(a,b) in zip(bits,catalogue) if keep]
            value,projection=b_fixture({11:1000000},sessions)
            expected=self.check(value,projection)
            value['runs'].reverse();projection['traversals'].reverse()
            self.assertEqual(self.candidate(value,projection),expected)

    def test_b_authoritative_order_not_numeric_id_or_member_arrival_order(self):
        value,projection=b_fixture({91:480000,3:480000},[[(91,0,480000),(3,0,480000)]],order=[91,3])
        result=self.check(value,projection,dict(full=1))
        value['snapshot']['members'].reverse();value['runs'].reverse();value['continuity'].reverse()
        self.assertEqual(self.candidate(value,projection),result)
        # Reversed authority is a distinct snapshot and physically reversed traversal.
        value,projection=b_fixture({91:480000,3:480000},[[(3,0,480000),(91,0,480000)]],order=[3,91])
        value['snapshot'].update(snapshot_id='snapshot-reversed',fingerprint='c'*64)
        projection.update(snapshot_id='snapshot-reversed',snapshot_fingerprint='c'*64)
        self.check(value,projection,dict(full=1))

    def test_b_optional_frames_never_enter_required_numerator_or_overlap(self):
        value,projection=b_fixture({11:480000,12:480000,13:480000},
            [[(11,0,480000),(12,0,480000)],[(12,0,480000),(13,0,480000)]],optional=(12,))
        self.check(value,projection,dict(full=0,partial=2,target_coverage=q(1,5),album_time_equivalents=q(1)))
        native=metric_value(self.stage_a(value),'native_recorded_frames')
        self.assertEqual(native,1920000)

    def test_b_imports_and_legacy_seconds_never_become_candidate_layers(self):
        value,projection=b_fixture({11:480000})
        value['imported_reported']=[imported(plays=63)]
        value['legacy_measured']=[legacy(seconds=q(100000),plays=63)]
        self.check(value,projection,dict(full=0,partial=0,target_coverage=q(0),album_time_equivalents=q(0)))

    def test_b_duplicate_source_replay_deduplicates_but_reference_reuse_conflicts(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        expected=self.check(value,projection)
        value['runs']*=3
        self.assertEqual(self.candidate(value,projection),expected)
        projection['traversals'].append(deepcopy(projection['traversals'][0]))
        self.assert_invalid(self.candidate(value,projection))

    def test_b_checkpoint_fragments_are_one_token_one_layer(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        first=value['runs'][0];first['frames']=240000
        second=deepcopy(first);second.update(checkpoint_sequence=2,source_start48=240000,
            output_start=241000,ordinal_start=240000,checkpoint_digest='c'*64)
        value['runs'].append(second)
        projection['traversals'][0].update(run_refs=[b_ref(first),b_ref(second)],joins=[dict(
            kind='same_track_contiguous',event_ref=None,gap_basis='no_gap',gap_frames=0)])
        self.check(value,projection,dict(full=1,partial=0,uninterrupted_full=1,target_coverage=q(1,5)))

    def test_b_wrap_break_makes_distinct_layers_not_source_repetition_join(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)],[(11,0,480000)]])
        a,b=value['runs'];b.update(timeline_uuid=a['timeline_uuid'],output_start=481000)
        ev=event();ev.update(kind='seek',timeline_uuid=a['timeline_uuid'],output_frame=481000,
                            before=b_endpoint(a),after=b_endpoint(b))
        value['continuity']=[ev]
        projection['traversals'][0]['end_boundary']='break';projection['traversals'][1]['start_boundary']='break'
        self.check(value,projection,dict(full=2,target_coverage=q(2,5)))

    def test_b_gap_12000_inclusive_requires_explicit_synthetic_admission(self):
        for gap in (0,12000,12001):
            value,projection=b_fixture({11:480000,12:480000},[[(11,0,480000),(12,0,480000)]])
            value['runs'][1]['output_start']+=gap
            join=projection['traversals'][0]['joins'][0]
            join.update(gap_frames=gap,gap_basis='confirmed_natural_transition' if gap else 'no_gap')
            # authority_ref explicitly assumes proved natural nonmedia gap, not elapsed-time heuristic.
            if gap<=12000:self.check(value,projection,dict(full=1))
            else:self.assert_invalid(self.candidate(value,projection))
        join['gap_frames']=1;join['gap_basis']='no_gap';value['runs'][1]['output_start']=481001
        self.assert_invalid(self.candidate(value,projection))

    def test_b_join_endpoint_parent_epoch_timeline_and_missing_event_conflicts(self):
        for mutation in ('parent','epoch','timeline','missing_event','wrong_kind','event_outside'):
            value,projection=b_fixture({11:480000,12:480000},[[(11,0,480000),(12,0,480000)]])
            if mutation=='parent':value['continuity'][0]['after']['capture_uuid']=uid(999)
            if mutation=='epoch':value['continuity'][0]['after']['epoch']=9
            if mutation=='timeline':value['runs'][1]['timeline_uuid']=uid(999)
            if mutation=='missing_event':value['continuity']=[]
            if mutation=='wrong_kind':value['continuity'][0]['kind']='pause'
            if mutation=='event_outside':value['continuity'][0]['output_frame']+=1
            with self.subTest(mutation=mutation):self.assert_invalid(self.candidate(value,projection))

    def test_b_source_hole_skip_wrap_and_known_extent_overrun_reject(self):
        for spans in ([[(11,0,479999),(12,0,480000)]],
                      [[(11,0,480000),(13,0,480000)]],
                      [[(12,0,480000),(11,0,480000)]],
                      [[(11,0,480001)]]):
            value,projection=b_fixture({11:480000,12:480000,13:480000},spans)
            self.assert_invalid(self.candidate(value,projection))

    def test_b_exact_break_inside_run_or_join_rejects_even_noncomplete(self):
        for partial in (False,True):
            for position in (1001,481000):
                value,projection=b_fixture({11:480000,12:480000},[[(11,0,480000),(12,0,480000)]])
                ev=event(2);ev.update(kind='pause',timeline_uuid=value['runs'][0]['timeline_uuid'],output_frame=position)
                value['continuity'].append(ev)
                if partial:projection.update(partition_status='partial',reasons=['traversal_partial'])
                self.assert_invalid(self.candidate(value,projection))

    def test_b_exact_break_at_outer_endpoint_is_allowed(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        ev=event();ev.update(kind='pause',timeline_uuid=value['runs'][0]['timeline_uuid'],output_frame=481000)
        value['continuity']=[ev];projection['traversals'][0]['end_boundary']='break'
        self.check(value,projection,dict(full=1))

    def test_b_scope_edge_cannot_hide_mergeable_internal_split(self):
        value,projection=b_fixture({11:480000},[[(11,0,240000)],[(11,240000,480000)]])
        first,second=value['runs'];second.update(capture_parent_uuid=first['capture_parent_uuid'],
            binding_serial=first['binding_serial'],run_index=1,timeline_uuid=first['timeline_uuid'],
            output_start=241000,ordinal_start=240000)
        projection['traversals'][1]['run_refs']=[b_ref(second)]
        for boundary in ('scope_edge','break'):
            projection['traversals'][0]['end_boundary']=boundary
            projection['traversals'][1]['start_boundary']=boundary
            self.assert_invalid(self.candidate(value,projection))

    def test_b_unknown_partition_keeps_only_independent_required_time(self):
        for status in ('partial','unknown'):
            value,projection=b_fixture({11:480000},[[(11,0,480000)]])
            projection.update(partition_status=status,reasons=['traversal_'+status])
            projection['traversals'][0]['start_boundary']='unknown'
            result=self.check(value,projection,dict(album_time_equivalents=q(1)),oracle=False)
            for name in B_DEPENDENT:
                self.assertIsNone(metric_value(result,name))
                self.assertEqual(result['metrics'][name]['status'],'unavailable')
                self.assertIn('traversal_unknown',result['metrics'][name]['reasons'])
            self.assertEqual(result['witnesses'],[])

    def test_b_unlocated_unknown_event_and_losses_complete_vs_honest_partial(self):
        unknown=event();unknown.update(kind='pause',quality='unknown',output_frame=None)
        for fence in (unknown,loss(),loss(reported=1)):
            value,projection=b_fixture({11:480000},[[(11,0,480000)]])
            admitted_fence=deepcopy(fence)
            admitted_fence['timeline_uuid']=value['runs'][0]['timeline_uuid']
            value['continuity']=[admitted_fence]
            self.assert_invalid(self.candidate(value,projection))
            projection.update(partition_status='partial',reasons=['traversal_partial'])
            result=self.check(value,projection,dict(album_time_equivalents=q(1)),oracle=False)
            for name in B_DEPENDENT:
                self.assertIsNone(metric_value(result,name))
                for reason in ('traversal_unknown','continuity_unknown'):
                    self.assertIn(reason,result['metrics'][name]['reasons'])

    def test_b_empty_loss_with_null_or_zero_report_is_not_unknown_fence(self):
        for reported in (None,0):
            value,projection=b_fixture({11:480000},[[(11,0,480000)]])
            entry=loss(reported=reported);entry['lost']=[]
            entry['timeline_uuid']=value['runs'][0]['timeline_uuid']
            value['continuity']=[entry]
            self.check(value,projection,dict(full=1))

    def test_b_missing_denominator_is_unavailable_not_zero_or_geometry_error(self):
        for kind in ('classification','extent','local','optional_only','snapshot_unknown'):
            value,projection=b_fixture({11:480000})
            value['snapshot']['denominator_complete']=False
            if kind=='classification':value['snapshot']['members'][0]['required_class']='unknown'
            if kind=='extent':value['snapshot']['members'][0]['media_extent_frames']=None
            if kind=='local':value['snapshot']['provenance']='local-inventory-v1'
            if kind=='optional_only':value['snapshot']['members'][0]['required_class']='optional'
            if kind=='snapshot_unknown':
                value['snapshot'].update(status='unknown',reason='snapshot_unknown',members=[])
                projection['ordered_track_ids']=[]
            result=self.check(value,projection,oracle=False)
            for name in B_METRICS:
                self.assertIsNone(metric_value(result,name))
                self.assertIn('denominator_unavailable',result['metrics'][name]['reasons'])

    def test_b_missing_short_required_final_track_not_dropped(self):
        value,projection=b_fixture({11:480000,12:1},[[(11,0,480000)]]*5)
        self.check(value,projection,dict(full=0,partial=5,tracks_at_target=1,
                                      target_coverage=q(480000,480001)))

    def test_b_unknown_optional_extent_does_not_authorize_transition(self):
        value,projection=b_fixture({11:480000,12:480000,13:480000},
            [[(11,0,480000),(12,0,480000),(13,0,480000)]],optional=(12,))
        value['snapshot']['members'][1]['media_extent_frames']=None
        projection.update(partition_status='partial',reasons=['traversal_partial','continuity_unknown'])
        result=self.check(value,projection,dict(album_time_equivalents=q(1)),oracle=False)
        for name in B_DEPENDENT:self.assertIsNone(metric_value(result,name))

    def test_b_reference_resolution_and_complete_accounting(self):
        for mutation in ('missing','omitted','empty','duplicate'):
            value,projection=b_fixture({11:480000},[[(11,0,480000)]])
            if mutation=='missing':projection['traversals'][0]['run_refs'][0]['run_index']=99
            if mutation=='omitted':projection['traversals']=[]
            if mutation=='empty':projection['traversals'][0]['run_refs']=[]
            if mutation=='duplicate':projection['traversals']*=2
            result=self.candidate(value,projection)
            if mutation=='empty':self.assertEqual(result['status'],'invalid_metrics_input')
            else:self.assert_invalid(result)

    def test_b_closed_projection_shapes_domains_and_order_consistency(self):
        for malformed in (None,[],{},'projection'):
            self.assert_invalid(self.candidate(batch(),malformed),'invalid_shape')
        for key,bad in [('authority_ref','é'*65),('snapshot_fingerprint','B'*64)]:
            value,projection=b_fixture({11:480000});projection[key]=bad
            self.assert_invalid(self.candidate(value,projection),'invalid_identifier')
        value,projection=b_fixture({11:480000});projection['approved']=True
        self.assert_invalid(self.candidate(value,projection),'invalid_shape')
        for order in ([11,11],[],[12]):
            value,projection=b_fixture({11:480000});projection['ordered_track_ids']=order
            self.assertEqual(self.candidate(value,projection)['status'],'invalid_metrics_input')
        for target in (True,0,-1,1.0,'5',MAX_I64+1):
            value,projection=b_fixture({11:480000})
            self.assert_invalid(self.candidate(value,projection,target=target),'invalid_target')

    def test_b_arithmetic_overflow_does_not_mask_earlier_reference_or_domain_error(self):
        denominators=[9223372036854775783,9223372036854775643,9223372036854775549,9223372036854775507,32]
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        value['legacy_measured']=[legacy('r'+str(i),q(1,d),0) for i,d in enumerate(denominators)]
        self.assert_resource(self.candidate(value,projection))
        projection['traversals'][0]['run_refs'][0]['run_index']=99
        self.assert_invalid(self.candidate(value,projection))
        projection['traversals'][0]['run_refs'][0]['run_index']=True
        self.assert_invalid(self.candidate(value,projection),'invalid_integer')
        value['legacy_measured'].reverse()
        self.assert_invalid(self.candidate(value,projection),'invalid_integer')

    def test_b_substantial_token_cap_4096_and_4097_no_partial_optimum(self):
        # SOURCE-ONLY large fixture. No speed/memory/scalability claim.
        for count in (4096,4097):
            value,projection=b_fixture({11:480000},[[(11,0,480000)]]*count)
            if count==4097:self.assert_resource(self.candidate(value,projection))
            else:
                result=self.check(value,projection,dict(full=4096,partial=0,uninterrupted_full=4096,
                    tracks_at_target=1,target_coverage=q(1),album_time_equivalents=q(4096)),oracle=False)
                self.assertEqual(len(result['witnesses']),4096)
                self.assertEqual([w['tokens'] for w in result['witnesses']],
                                 [[[b_ref(r)]] for r in value['runs']])

    def test_b_reachable_512_group_130816_edge_max_and_513_group_rejection(self):
        # Every earlier end extends to every later end with real physical overlap.
        # No invented 130817-edge independent case: 513 groups is the failing cap.
        for count in (512,513):
            value,projection=b_fixture({11:10000000},
                [[(11,0,2000000+j*10000)] for j in range(count)])
            if count==513:self.assert_resource(self.candidate(value,projection))
            else:
                self.assertEqual(count*(count-1)//2,130816)
                self.check(value,projection,dict(full=0,partial=512,uninterrupted_full=0,
                    tracks_at_target=0,target_coverage=q(709,1000),
                    album_time_equivalents=q(58304,250)),oracle=False)

    def test_b_group_cap_does_not_count_non_substantial_multiplicity_only_spans(self):
        value,projection=b_fixture({11:10000000},[[(11,0,1000+j)] for j in range(513)])
        self.check(value,projection,dict(full=0,partial=0,uninterrupted_full=0),oracle=False)

    def test_b_candidate_raw_run_limit_counts_before_replay_dedup(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        value['runs']*=100000
        self.check(value,projection,dict(full=1,partial=0,target_coverage=q(1,5),
                                      album_time_equivalents=q(1)),oracle=False)
        value['runs'].append(value['runs'][0])
        self.assert_resource(self.candidate(value,projection))

    def test_b_failure_is_immutable_and_has_no_partial_candidate_witness(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        projection['traversals'][0]['run_refs'][0]['run_index']=99
        before=deepcopy((value,projection));self.assert_invalid(self.candidate(value,projection))
        self.assertEqual((value,projection),before)

    def test_b_join_shape_numeric_domains_and_reference_closed_keys(self):
        for field,bad in [('gap_frames',True),('gap_frames',-1),('gap_frames',1.0),('gap_frames',MAX_I64+1)]:
            value,projection=b_fixture({11:480000,12:480000},[[(11,0,480000),(12,0,480000)]])
            projection['traversals'][0]['joins'][0][field]=bad
            self.assert_invalid(self.candidate(value,projection),'invalid_integer')
        for extra in ('source_start48','approved','token_id'):
            value,projection=b_fixture({11:480000},[[(11,0,480000)]])
            projection['traversals'][0]['run_refs'][0][extra]=1
            self.assert_invalid(self.candidate(value,projection),'invalid_shape')
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        projection['traversals'][0]['joins']=[dict(kind='same_track_contiguous',event_ref=None,
                                               gap_basis='no_gap',gap_frames=0)]
        self.assertEqual(self.candidate(value,projection)['status'],'invalid_metrics_input')

    def test_b_conflicting_source_identity_and_event_reuse_never_duplicate_tokens(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        conflict=deepcopy(value['runs'][0]);conflict['frames']=240000
        value['runs'].append(conflict)
        self.assert_invalid(self.candidate(value,projection))
        value['runs'].reverse();self.assert_invalid(self.candidate(value,projection))
        value,projection=b_fixture({11:480000,12:480000},
            [[(11,0,480000),(12,0,480000)],[(11,0,480000),(12,0,480000)]])
        projection['traversals'][1]['joins'][0]['event_ref']=deepcopy(
            projection['traversals'][0]['joins'][0]['event_ref'])
        self.assert_invalid(self.candidate(value,projection))

    def test_b_unknown_denominator_still_checks_known_extent_and_references(self):
        value,projection=b_fixture({11:480000,12:480000},[[(11,0,480001)]])
        value['snapshot']['denominator_complete']=False
        value['snapshot']['members'][1]['media_extent_frames']=None
        self.assert_invalid(self.candidate(value,projection))
        value['runs'][0]['frames']=480000
        projection['traversals'][0]['run_refs'][0]['run_index']=99
        self.assert_invalid(self.candidate(value,projection))

    def test_b_overlapping_timeline_ranges_cannot_be_two_concurrent_passes(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)],[(11,0,480000)]])
        value['runs'][1]['timeline_uuid']=value['runs'][0]['timeline_uuid']
        self.assert_invalid(self.candidate(value,projection))

    def test_b_raw_traversal_reference_and_join_caps_precede_conflict(self):
        # SOURCE-ONLY fixtures; repeated refs deliberately conflict below raw caps.
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        traversal=projection['traversals'][0]
        traversal['run_refs']=[traversal['run_refs'][0]]*100000
        traversal['joins']=[dict(kind='same_track_contiguous',event_ref=None,
                                gap_basis='no_gap',gap_frames=0)]*99999
        self.assert_invalid(self.candidate(value,projection))
        traversal['run_refs'].append(traversal['run_refs'][0])
        self.assert_resource(self.candidate(value,projection))
        traversal['run_refs'].pop();traversal['joins'].append(traversal['joins'][0])
        self.assert_resource(self.candidate(value,projection))

    def test_b_earlier_shape_and_scope_conflicts_have_canonical_priority(self):
        value,projection=b_fixture({11:480000},[[(11,0,480000)]])
        projection['traversals'][0]['run_refs'][0]['run_index']=99
        value['runs'][0]['actor_id']=9
        self.assert_invalid(self.candidate(value,projection),'scope_mismatch')
        projection['unexpected']=0
        self.assert_invalid(self.candidate(value,projection),'invalid_shape')

    def test_b_candidate_preserves_all_stage_a_raw_collection_boundaries(self):
        for field,entry,limit in [('continuity',event(),100000),
                ('legacy_measured',legacy(seconds=q(1)),1024),
                ('imported_reported',imported(),1024),('mappings',mapping(),4096)]:
            value,projection=b_fixture({11:480000})
            value[field]=[entry]*limit
            expected=deepcopy(value);expected[field]=[entry]
            self.assertEqual(self.candidate(value,projection),self.candidate(expected,projection))
            value[field].append(entry)
            self.assert_resource(self.candidate(value,projection))
        value,projection=b_fixture({t:480000 for t in range(1,513)})
        self.check(value,projection,dict(full=0,target_coverage=q(0)),oracle=False)
        value['snapshot']['members'].append(dict(track_id=513,required_class='required',
            media_extent_frames=480000,inventory_duration_ms=1))
        projection['ordered_track_ids'].append(513)
        self.assert_resource(self.candidate(value,projection))

    def test_b_prefix_next_feasible_choice_must_preserve_overlap_optimum(self):
        # All three-token paths share the first token. Smallest middle token
        # increases adjacent redundancy; a detached prefix cannot hide its cost.
        spans=[(0,400000),(200000,800000),(300000,800000),(700000,1000000)]
        value,projection=b_fixture({11:1000000},[[(11,a,b)] for a,b in spans])
        result=self.check(value,projection,dict(full=1,partial=1))
        self.assertEqual(result['witnesses'][0]['tokens'],
            [[b_ref(value['runs'][0])],[b_ref(value['runs'][2])],[b_ref(value['runs'][3])]])

    # Independent S1-S3 regression fixtures from the accepted binding and source
    # review. Source-only authoring: no fixture or candidate execution performed.
    def test_b_projection_reason_raw_eight_nine_boundary_before_dedup(self):
        value,projection=b_fixture({11:480000})
        projection.update(partition_status='partial',reasons=['traversal_partial']*8)
        result=self.check(value,projection,dict(album_time_equivalents=q(0)),oracle=False)
        for name in B_DEPENDENT:
            self.assertIsNone(metric_value(result,name))
            self.assertIn('traversal_unknown',result['metrics'][name]['reasons'])
        projection['reasons'].append('traversal_partial')
        self.assert_resource(self.candidate(value,projection))

    def test_b_nine_raw_projection_reasons_precede_malformed_reason_domain(self):
        for malformed in (None,{},True,'not-a-reason'):
            value,projection=b_fixture({11:480000})
            projection.update(partition_status='partial',reasons=['traversal_partial']*8+[malformed])
            before=deepcopy((value,projection))
            self.assert_resource(self.candidate(value,projection))
            self.assertEqual((value,projection),before)

    def test_b_unknown_optional_extent_honest_partial_join_positive_control(self):
        value,projection=b_fixture({11:480000,12:480000,13:480000},
            [[(11,0,480000),(12,0,480000),(13,0,480000)]],optional=(12,))
        value['snapshot']['members'][1]['media_extent_frames']=None
        projection.update(partition_status='partial',reasons=['traversal_partial','continuity_unknown'])
        result=self.check(value,projection,dict(album_time_equivalents=q(1)),oracle=False)
        for name in B_DEPENDENT:
            self.assertIsNone(metric_value(result,name))
            self.assertEqual(result['metrics'][name]['status'],'unavailable')
        self.assertEqual(result['witnesses'],[])

    def test_b_unknown_optional_extent_cannot_mask_false_next_source_start(self):
        value,projection=b_fixture({11:480000,12:480000,13:480000},
            [[(11,0,480000),(12,100,480000),(13,0,480000)]],optional=(12,))
        value['snapshot']['members'][1]['media_extent_frames']=None
        projection.update(partition_status='partial',reasons=['traversal_partial','continuity_unknown'])
        # Exact event endpoints/output agree; source_start=100 independently
        # contradicts the asserted natural join despite the unknown optional end.
        self.assert_invalid(self.candidate(value,projection))

    def test_b_unknown_optional_extent_cannot_mask_known_short_previous_end(self):
        value,projection=b_fixture({11:480000,12:480000,13:480000},
            [[(11,0,479999),(12,0,480000),(13,0,480000)]],optional=(12,))
        value['snapshot']['members'][1]['media_extent_frames']=None
        projection.update(partition_status='partial',reasons=['traversal_partial','continuity_unknown'])
        self.assert_invalid(self.candidate(value,projection))

    def test_b_unknown_optional_extent_cannot_mask_known_nonadjacent_order(self):
        for order,spans in [([11,13,12],[(11,0,480000),(12,0,480000)]),
                            ([11,12,13],[(12,0,480000),(11,0,480000)])]:
            value,projection=b_fixture({11:480000,12:480000,13:480000},
                                       [spans],optional=(12,),order=order)
            value['snapshot']['members'][1]['media_extent_frames']=None
            projection.update(partition_status='partial',reasons=['traversal_partial','continuity_unknown'])
            with self.subTest(order=order):self.assert_invalid(self.candidate(value,projection))

    def test_b_partial_unlocated_fence_does_not_prove_contiguous_fragments_mergeable(self):
        for fence_kind in ('unknown_pause','lost_sequence','positive_loss'):
            value,projection=b_fixture({11:480000},[[(11,0,240000)],[(11,240000,480000)]])
            first,second=value['runs']
            second.update(capture_parent_uuid=first['capture_parent_uuid'],
                binding_serial=first['binding_serial'],checkpoint_sequence=2,checkpoint_digest='c'*64,
                timeline_uuid=first['timeline_uuid'],output_start=241000,ordinal_start=240000)
            projection['traversals'][1]['run_refs']=[b_ref(second)]
            projection['traversals'][0]['end_boundary']='unknown'
            projection['traversals'][1]['start_boundary']='unknown'
            projection.update(partition_status='partial',reasons=['traversal_partial','continuity_unknown'])
            if fence_kind=='unknown_pause':
                fence=event();fence.update(kind='pause',quality='unknown',output_frame=None,
                    before=b_endpoint(first),after=b_endpoint(second))
            else:
                fence=loss(reported=1 if fence_kind=='positive_loss' else None)
            fence['timeline_uuid']=first['timeline_uuid'];value['continuity']=[fence]
            result=self.check(value,projection,dict(album_time_equivalents=q(1)),oracle=False)
            for name in B_DEPENDENT:
                self.assertIsNone(metric_value(result,name))
                for reason in ('traversal_unknown','continuity_unknown'):
                    self.assertIn(reason,result['metrics'][name]['reasons'])
            self.assertEqual(result['witnesses'],[])

    def test_b_proven_contiguous_no_fence_split_rejects_but_outer_break_allows(self):
        value,projection=b_fixture({11:480000},[[(11,0,240000)],[(11,240000,480000)]])
        first,second=value['runs']
        second.update(capture_parent_uuid=first['capture_parent_uuid'],
            binding_serial=first['binding_serial'],checkpoint_sequence=2,checkpoint_digest='c'*64,
            timeline_uuid=first['timeline_uuid'],output_start=241000,ordinal_start=240000)
        projection['traversals'][1]['run_refs']=[b_ref(second)]
        self.assert_invalid(self.candidate(value,projection))
        # Located pause at both outer endpoints genuinely separates the traversals;
        # no tolerance heals it, and the captured half intervals do not overlap.
        fence=event();fence.update(kind='pause',timeline_uuid=first['timeline_uuid'],
            output_frame=241000,before=b_endpoint(first),after=b_endpoint(second))
        value['continuity']=[fence]
        projection['traversals'][0]['end_boundary']='break'
        projection['traversals'][1]['start_boundary']='break'
        self.check(value,projection,dict(full=0,partial=2,uninterrupted_full=0,
            target_coverage=q(1,5),tracks_at_target=0,album_time_equivalents=q(1)))

    def test_b_partial_uncertified_positive_natural_gap_remains_unknown(self):
        value,projection=b_fixture({11:480000,12:480000},[[(11,0,480000)],[(12,0,480000)]])
        first,second=value['runs'];second.update(timeline_uuid=first['timeline_uuid'],output_start=481100)
        transition=event();transition.update(timeline_uuid=first['timeline_uuid'],output_frame=481000,
            before=b_endpoint(first),after=b_endpoint(second))
        value['continuity']=[transition]
        projection['traversals'][0]['end_boundary']='unknown'
        projection['traversals'][1]['start_boundary']='unknown'
        projection.update(partition_status='partial',reasons=['traversal_partial','continuity_unknown'])
        # No Join exists, so no gap_basis certifies this 100-frame nonmedia gap.
        result=self.check(value,projection,dict(album_time_equivalents=q(1)),oracle=False)
        for name in B_DEPENDENT:
            self.assertIsNone(metric_value(result,name))
            self.assertEqual(result['metrics'][name]['status'],'unavailable')
            self.assertIn('traversal_unknown',result['metrics'][name]['reasons'])
        self.assertEqual(result['witnesses'],[])

    def test_b_proven_zero_gap_natural_split_rejects_without_unlocated_fence(self):
        value,projection=b_fixture({11:480000,12:480000},[[(11,0,480000)],[(12,0,480000)]])
        first,second=value['runs'];second.update(timeline_uuid=first['timeline_uuid'],output_start=481000)
        transition=event();transition.update(timeline_uuid=first['timeline_uuid'],output_frame=481000,
            before=b_endpoint(first),after=b_endpoint(second))
        value['continuity']=[transition]
        self.assert_invalid(self.candidate(value,projection))
        # Honest partial status cannot waive an independently proved contradiction.
        projection.update(partition_status='partial',reasons=['traversal_partial'])
        self.assert_invalid(self.candidate(value,projection))

    def test_b_missing_denominator_alone_does_not_invent_continuity_conflict(self):
        value,projection=b_fixture({11:480000,12:480000},[[(11,0,480000)]])
        value['snapshot']['denominator_complete']=False
        value['snapshot']['members'][1]['media_extent_frames']=None
        # Complete partition covers every supplied Run and asserts no unresolved join.
        result=self.check(value,projection,oracle=False)
        for name in B_METRICS:
            self.assertIsNone(metric_value(result,name))
            self.assertEqual(result['metrics'][name]['status'],'unavailable')
            self.assertIn('denominator_unavailable',result['metrics'][name]['reasons'])
        self.assertEqual(result['witnesses'],[])


if __name__ == "__main__":
    unittest.main()
