"""Pure dormant protocol regression cases. No app/config/database imports.

Golden envelopes, reductions and canonical bytes are independently design-derived.
The bounded disjoint-single-frame scenario below has closed-form expectations;
it is not a second implementation of the general reducer.
"""
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
OWNER = ROOT / 'music_app/services/measured_listen_evidence.py'
SPEC = importlib.util.spec_from_file_location('_isolated_measured_evidence_v2', OWNER)
E = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = E
SPEC.loader.exec_module(E)
V = json.loads((ROOT / 'tests/fixtures/measured_evidence_v2_vectors.json').read_text())
CASES = {x['name']: x for x in V['positives']}


def mutate(envelope, changes):
    value = deepcopy(envelope)
    for change in changes:
        target = value
        for segment in change['path'][:-1]:
            target = target[int(segment)] if isinstance(target, list) else target[segment]
        key = int(change['path'][-1]) if isinstance(target, list) else change['path'][-1]
        if change['op'] == 'delete':
            del target[key]
        elif isinstance(target, list) and key == len(target):
            target.append(deepcopy(change['value']))
        else:
            target[key] = deepcopy(change['value'])
    return value


def accepted(name):
    case = CASES[name]
    prior = accepted(case['previous']) if case['previous'] else None
    return E.compare_checkpoint_v2(prior, case['envelope'], V['binding'], case['observed_ranges'])['state']


def next_empty(state):
    body = deepcopy(state['latest'])
    body.update(checkpoint_sequence=body['checkpoint_sequence'] + 1,
                previous_digest=E.checkpoint_digest_v2(state['latest']), epochs=[], slices=[], terminal=None)
    return body


class MeasuredEvidenceV2Tests(unittest.TestCase):
    def rejected(self, action, code=None):
        with self.assertRaises(E.EvidenceError) as caught:
            action()
        if code:
            self.assertEqual(caught.exception.code, code)

    def test_golden_envelopes_canonical_digest_reduction_replay_and_detachment(self):
        for case in V['positives']:
            with self.subTest(case=case['name']):
                original = deepcopy(case['envelope'])
                prior = accepted(case['previous']) if case['previous'] else None
                prior_copy = deepcopy(prior)
                result = E.compare_checkpoint_v2(prior, original, V['binding'], case['observed_ranges'])
                self.assertEqual(result['kind'], 'accept')
                self.assertEqual(result['digest'], case['digest'])
                self.assertEqual(E.canonical_checkpoint_v2(original), case['canonical'].encode('ascii'))
                self.assertEqual(E.parse_checkpoint_v2(case['canonical']), original)
                state = result['state']
                self.assertEqual(state['latest'], original)
                for key, expected in case['expected_cursor'].items():
                    self.assertEqual(state[key], expected)
                self.assertEqual(prior, prior_copy)
                replay = E.compare_checkpoint_v2(state, original, V['binding'], case['observed_ranges'])
                self.assertEqual(replay, {'kind': 'replay', 'digest': case['digest'], 'state': None})
                original['cumulative']['histogram'][0][1] = 999
                self.assertEqual(state['latest'], case['envelope'])
                if prior:
                    prior['epochs'][0]['wall_origin_us'] = 123
                    self.assertEqual(state['epochs'][0], prior_copy['epochs'][0])

    def test_design_negative_mutations(self):
        for case in V['negative_mutations']:
            with self.subTest(case=case['name']):
                base = CASES[case['base']]
                body = mutate(base['envelope'], case['changes'])
                parent = base['previous'] if case['previous'] == 'inherit' else case['previous']
                prior = accepted(parent) if parent else None
                action = (lambda: E.normalize_checkpoint_v2(body)) if case['stage'] == 'normalize' else (
                    lambda: E.compare_checkpoint_v2(prior, body, V['binding'], base['observed_ranges']))
                self.rejected(action, case['code'])

    def test_occurrence_mapping_and_overflows(self):
        for case in V['mapping']:
            self.assertEqual(E.occurrence_boundary_v2(case['epoch'], case['tick'], case['rate']), case['expected'])
        epoch = deepcopy(V['mapping'][0]['epoch'])
        self.rejected(lambda: E.occurrence_boundary_v2(epoch, 9007199254740991, 48000))
        epoch['audio_origin_tick'] = 1
        self.rejected(lambda: E.occurrence_boundary_v2(epoch, 0, 48000))
        # At a calendar boundary the +/-21 us interval crosses the boundary.
        epoch.update(audio_origin_tick=0, wall_origin_us=0)
        self.assertEqual(E.occurrence_boundary_v2(epoch, 0, 48000), {'wall_us': 0, 'uncertainty_us': 21})

    def test_strict_raw_json_and_exact_body_byte_cap(self):
        body = CASES['one_second']['canonical']
        for raw in [body[:-1] + ',"version":"rendered-position-slices-v2"}',
                    body.replace('"quality":"app_clock_estimate"', '"quality":"app_clock_estimate","qual\\u0069ty":"unknown"', 1),
                    body.replace('"sample_rate":48000', '"sample_rate":48000.0'),
                    body.replace('"sample_rate":48000', '"sample_rate":48e3'),
                    body.replace('"checkpoint_sequence":0', '"checkpoint_sequence":-0'),
                    body.replace('"sample_rate":48000', '"sample_rate":NaN'),
                    body.replace('"sample_rate":48000', '"sample_rate":Infinity'),
                    body.replace('"sample_rate":48000', '"sample_rate":9007199254740992'),
                    body + 'x', body[:-1], '{"x":' + '[' * 40 + '0' + ']' * 40 + '}', '\u00e9']:
            self.rejected(lambda: E.parse_checkpoint_v2(raw))
        padded = body + ' ' * (262144 - len(body))
        self.assertEqual(E.parse_checkpoint_v2(padded), CASES['one_second']['envelope'])
        self.rejected(lambda: E.parse_checkpoint_v2(padded + ' '))

    def test_binding_and_exact_observed_ranges(self):
        case = CASES['one_second']
        for key in ['decoder_instance_id', 'process_epoch', 'device_id', 'session_id']:
            binding = {**V['binding'], key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}
            self.rejected(lambda: E.compare_checkpoint_v2(None, case['envelope'], binding, case['observed_ranges']), 'identity_changed')
        binding = {**V['binding'], 'sample_rate': 44100}
        self.rejected(lambda: E.compare_checkpoint_v2(None, case['envelope'], binding, case['observed_ranges']), 'identity_changed')
        for observed in [[], [[0,1]], [[0,20000],[20001,48000]], [[0,20000],[20000,48000]], [[2,1]]]:
            self.rejected(lambda: E.compare_checkpoint_v2(None, case['envelope'], V['binding'], observed))

    def test_stale_conflict_terminal_and_retired_epoch(self):
        state = accepted('collection_limited')
        stale = E.compare_checkpoint_v2(state, CASES['one_second']['envelope'], V['binding'], [[0,48000]])
        self.assertEqual(stale['kind'], 'stale'); self.assertIsNone(stale['state'])
        changed = deepcopy(state['latest']); changed['terminal'] = 'client_stopped'
        self.rejected(lambda: E.compare_checkpoint_v2(state, changed, V['binding'], [[0,48000]]), 'sequence_conflict')
        body = next_empty(state)
        self.rejected(lambda: E.compare_checkpoint_v2(state, body, V['binding'], [[0,48000]]), 'already_finalized')
        state = accepted('occurrence_loss'); body = next_empty(state)
        self.rejected(lambda: E.compare_checkpoint_v2(state, body, V['binding'], [[0,48000]]), 'unchanged_checkpoint')
        body['cumulative']['occurrence_complete'] = True
        self.rejected(lambda: E.compare_checkpoint_v2(state, body, V['binding'], [[0,48000]]))
        state = accepted('unknown_to_known'); body = next_empty(state)
        item = deepcopy(CASES['unknown']['envelope']['slices'][0])
        item.update(slice_id=2, first_consumption_frame=2, render_start_tick=2, render_end_tick=3, runs=[[2,1,2]])
        body['slices'] = [item]
        body['cumulative'].update(rendered_frames=3, max_observed_frame=3, histogram=[[0,3]], coverage_intervals=[[0,3]])
        self.rejected(lambda: E.compare_checkpoint_v2(state, body, V['binding'], [[0,3]]), 'retired_epoch')

    def test_finite_shape_limits_at_and_above_boundaries(self):
        # Normalization boundaries only; duplicate shapes below are not valid history.
        base = deepcopy(CASES['one_frame_tick_one']['envelope'])
        for key, limit, item in [('slices',128,base['slices'][0]), ('epochs',16,base['epochs'][0])]:
            body = deepcopy(base); body[key] = [deepcopy(item) for _ in range(limit)]
            E.normalize_checkpoint_v2(body)
            body[key].append(deepcopy(item)); self.rejected(lambda: E.normalize_checkpoint_v2(body))
        body = deepcopy(base); item = body['slices'][0]
        item.update(frames=256, render_start_tick=0, render_end_tick=256, runs=[[0,1,i] for i in range(256)])
        E.normalize_checkpoint_v2(body)
        item['runs'].append([0,1,256]); item['frames']=257; item['render_end_tick']=257
        self.rejected(lambda: E.normalize_checkpoint_v2(body))
        item['runs'].pop(); item['frames']=256; item['render_end_tick']=256
        body['slices'] = [deepcopy(item) for _ in range(8)]
        E.normalize_checkpoint_v2(body)
        body['slices'].append(deepcopy(base['slices'][0])); self.rejected(lambda: E.normalize_checkpoint_v2(body))
        for path, maximum in [('checkpoint_sequence',719), ('slice_id',7199), ('epoch_id',63)]:
            body = deepcopy(base)
            if path == 'checkpoint_sequence': body.update(checkpoint_sequence=maximum, previous_digest='0'*64)
            elif path == 'slice_id': body['slices'][0][path] = maximum
            else: body['epochs'][0][path] = maximum
            E.normalize_checkpoint_v2(body)
        body = deepcopy(base)
        body['cumulative'].update(rendered_frames=2048,max_observed_frame=98304000,
                                 histogram=[[i,1] for i in range(2048)],coverage_intervals=[])
        E.normalize_checkpoint_v2(body)
        body['cumulative']['histogram'].append([2048,1]); self.rejected(lambda: E.normalize_checkpoint_v2(body))
        body = deepcopy(base)
        body['cumulative'].update(rendered_frames=4096,max_observed_frame=8191,histogram=[[0,4096]],
                                 coverage_intervals=[[2*i,2*i+1] for i in range(4096)])
        E.normalize_checkpoint_v2(body)
        body['cumulative']['coverage_intervals'].append([8192,8193]); self.rejected(lambda: E.normalize_checkpoint_v2(body))

    def test_coverage_overflow_retains_prior_union_and_never_recovers(self):
        state = None
        for batch in range(16):
            count = (batch+1)*256
            body = deepcopy(CASES['one_second']['envelope']) if state is None else next_empty(state)
            item = deepcopy(CASES['one_second']['envelope']['slices'][0])
            item.update(slice_id=batch,first_consumption_frame=batch*256,frames=256,
                        render_start_tick=batch*256,render_end_tick=count,
                        runs=[[2*i,1,i] for i in range(batch*256,count)])
            body['slices']=[item]
            body['cumulative'].update(rendered_frames=count,max_observed_frame=2*count-1,
                                     histogram=[[0,count]],coverage_intervals=[[2*i,2*i+1] for i in range(count)])
            result=E.compare_checkpoint_v2(state,body,V['binding'],[[0,8193]])
            self.assertEqual(result['kind'],'accept'); state=result['state']
        old=deepcopy(state)
        body=next_empty(state); item=deepcopy(CASES['one_second']['envelope']['slices'][0])
        item.update(slice_id=16,first_consumption_frame=4096,frames=1,render_start_tick=4096,render_end_tick=4097,runs=[[8192,1,4096]])
        body['slices']=[item]
        body['cumulative'].update(rendered_frames=4097,max_observed_frame=8193,histogram=[[0,4097]],coverage_complete=False)
        result=E.compare_checkpoint_v2(state,body,V['binding'],[[0,8193]])
        self.assertEqual(result['kind'],'accept'); self.assertEqual(state,old)
        self.assertEqual(result['state']['latest']['cumulative']['coverage_intervals'],old['latest']['cumulative']['coverage_intervals'])
        state=result['state']; body=next_empty(state)
        item.update(slice_id=17,first_consumption_frame=4097,frames=8193,render_start_tick=4097,render_end_tick=12290,runs=[[0,8193,4097]])
        body['slices']=[item]
        body['cumulative'].update(rendered_frames=12290,histogram=[[0,12290]],coverage_intervals=[[0,8193]])
        self.assertEqual(E.compare_checkpoint_v2(state,body,V['binding'],[[0,8193]])['kind'],'accept')
        body['cumulative']['coverage_complete']=True
        self.rejected(lambda:E.compare_checkpoint_v2(state,body,V['binding'],[[0,8193]]))

    def test_v1_prefix_and_version_isolation(self):
        # Normalize only Git checkout CRLF before comparing the LF source prefix.
        prefix=OWNER.read_bytes().replace(b'\r\n', b'\n')[:13471]
        self.assertEqual(hashlib.sha256(prefix).hexdigest(),'218f403d9980b649851c0d2eeff946ac7dac8dd5c5c06c7ae076d7db63116752')
        self.assertEqual(E.VERSION,'rendered-position-histogram-v1')
        self.rejected(lambda:E.normalize_checkpoint(CASES['one_second']['envelope'],E.MediaMetadata(48000,48000)))

    def test_max_slices_new_epochs_lifetime_epochs_and_total_runs_accept(self):
        state = None
        # Four packets: each declares 16 epochs, uses 128 slices, and each epoch
        # owns eight one-frame slices. Expected union [0,512), weight 512.
        for batch in range(4):
            body = deepcopy(CASES['one_second']['envelope']) if state is None else next_empty(state)
            body['epochs'] = [{**deepcopy(CASES['one_second']['envelope']['epochs'][0]), 'epoch_id': batch*16+i} for i in range(16)]
            body['slices'] = []
            for offset in range(128):
                index = batch*128+offset
                item = deepcopy(CASES['one_frame_tick_one']['envelope']['slices'][0])
                item.update(slice_id=index,epoch_id=batch*16+offset//8,first_consumption_frame=index,
                            render_start_tick=offset%8,render_end_tick=offset%8+1,runs=[[index,1,offset%8]])
                body['slices'].append(item)
            total = (batch+1)*128
            body['cumulative'].update(rendered_frames=total,max_observed_frame=total,histogram=[[0,total]],coverage_intervals=[[0,total]])
            result = E.compare_checkpoint_v2(state,body,V['binding'],[[0,512]])
            self.assertEqual(result['kind'],'accept'); state=result['state']
        self.assertEqual(len(state['epochs']),64)
        body=next_empty(state); body['epochs']=[{**state['epochs'][-1],'epoch_id':64}]
        self.rejected(lambda:E.compare_checkpoint_v2(state,body,V['binding'],[[0,512]]))
        body=deepcopy(CASES['one_second']['envelope']); body['slices']=[]
        for index in range(8):
            item=deepcopy(CASES['one_second']['envelope']['slices'][0])
            item.update(slice_id=index,first_consumption_frame=index*256,frames=256,
                        render_start_tick=index*256,render_end_tick=(index+1)*256,
                        runs=[[i,1,i] for i in range(index*256,(index+1)*256)])
            body['slices'].append(item)
        body['cumulative'].update(rendered_frames=2048,max_observed_frame=2048,histogram=[[0,2048]],coverage_intervals=[[0,2048]])
        self.assertEqual(E.compare_checkpoint_v2(None,body,V['binding'],[[0,2048]])['kind'],'accept')

    def test_canonical_body_limit_and_trusted_state_corruption(self):
        body=deepcopy(CASES['maximum_safe_source_end']['envelope'])
        # Each of 4096 disjoint intervals near MAX has 16-digit endpoints.
        # 128 slices of 16 runs and 1399 bins exceed the canonical byte cap.
        body['cumulative'].update(rendered_frames=4096,histogram=[[i,2] for i in range(1398)]+[[1398,1300]],
            coverage_intervals=[[9007199254732800+2*i,9007199254732801+2*i] for i in range(4096)])
        body['slices']=[]
        for index in range(128):
            item=deepcopy(CASES['one_second']['envelope']['slices'][0])
            origin=9007199254740000
            item.update(slice_id=7199,first_consumption_frame=9007199254730000,frames=16,render_start_tick=origin,render_end_tick=origin+16,
                        runs=[[9007199254740990,1,origin+i] for i in range(16)])
            body['slices'].append(item)
        self.assertGreater(len(json.dumps(body,sort_keys=True,separators=(',',':'))),262144)
        self.rejected(lambda:E.normalize_checkpoint_v2(body),'checkpoint_body_limit')
        for field,value in [('last_slice_id',1),('last_epoch_id',1),('last_render_end_tick',47999)]:
            state=accepted('one_second'); state[field]=value
            self.rejected(lambda:E.compare_checkpoint_v2(state,CASES['one_second']['envelope'],V['binding'],[[0,48000]]),'invalid_state')
