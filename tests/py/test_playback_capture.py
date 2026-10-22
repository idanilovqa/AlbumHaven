"""Pure evidence contracts. No application configuration or persistence needed."""
from copy import deepcopy
import hashlib
import json

import pytest

from music_app.services.playback_capture import (
    CaptureError, PROTOCOL, capture_digest, normalize_capture_envelope, parse_capture_body,
)


def envelope(sequence=1):
    return dict(protocol=PROTOCOL, device_uuid='11111111-1111-4111-8111-111111111111',
        capture_uuid='22222222-2222-4222-8222-222222222222', sequence=sequence,
        initial_path='/synthetic/music.flac', evidence=dict(runs=[dict(source_start48=96_000,
            frames=128, output_start=256, ordinal_start=0, epoch=1, anchor_before=None,
            anchor_after=None, quality='unknown')], anchors=[], gaps=[], terminal=False, terminal_reason=None))


def test_absolute_offset_repeats_and_identity_free_digest():
    first=envelope()
    run=first['evidence']['runs'][0]
    first['evidence']['runs'].append(dict(run, output_start=384, ordinal_start=128))
    parsed=normalize_capture_envelope(first)
    assert [r['source_start48'] for r in parsed['evidence']['runs']] == [96_000,96_000]
    expected=hashlib.sha256((PROTOCOL+'\n1\n'+json.dumps(parsed['evidence'],sort_keys=True,separators=(',',':'))).encode()).hexdigest()
    assert capture_digest(1,parsed['evidence']) == expected
    second=deepcopy(first)
    second['initial_path']='/different/locator.flac'
    second['capture_uuid']='33333333-3333-4333-8333-333333333333'
    assert capture_digest(1,normalize_capture_envelope(second)['evidence']) == expected


@pytest.mark.parametrize('value',[True,1.0,'1',-1,9_007_199_254_740_992,None])
def test_integer_coercions_and_overflow_rejected(value):
    data=envelope(); data['evidence']['runs'][0]['frames']=value
    with pytest.raises(CaptureError): normalize_capture_envelope(data)


@pytest.mark.parametrize('field',['account_id','bindingSerial','path','title','capture_uuid'])
def test_identity_or_arbitrary_fields_cannot_enter_child_body(field):
    data=envelope(); data['evidence']['runs'][0][field]='private'
    with pytest.raises(CaptureError): normalize_capture_envelope(data)


@pytest.mark.parametrize('raw',[b'{"protocol":"x","protocol":"y"}', b'{"n":NaN}', b'{"n":1.5}', b'\xff', b'['*10000])
def test_duplicate_keys_nonfinite_floats_utf8_and_deep_input_rejected(raw):
    with pytest.raises(CaptureError): parse_capture_body(raw)


def test_terminal_only_has_frozen_identity_and_cannot_be_empty_nonterminal():
    data=envelope(2); data['evidence']['runs']=[]
    with pytest.raises(CaptureError): normalize_capture_envelope(data)
    data['evidence'].update(terminal=True,terminal_reason='ended')
    parsed=normalize_capture_envelope(data)
    assert parsed['evidence']['terminal'] is True
    changed=deepcopy(parsed); changed['evidence'].update(terminal=False,terminal_reason=None)
    assert capture_digest(2,parsed['evidence']) != capture_digest(2,changed['evidence'])


def test_mixed_epoch_loss_envelope_is_explicit_unknown_and_can_overlap_known_run():
    data=envelope(); data['evidence']['gaps']=[dict(ordinal_start=0,ordinal_end=512,positive_frames=128,
        output_start=256,output_end=768,epoch=None,reasons=['buffer_credit'])]
    assert normalize_capture_envelope(data)['evidence']['gaps'][0]['epoch'] is None


def test_oversized_body_and_run_bound():
    with pytest.raises(CaptureError) as error: parse_capture_body(b' '*32769)
    assert error.value.status == 413
    data=envelope(); data['evidence']['runs'] *= 257
    with pytest.raises(CaptureError): normalize_capture_envelope(data)


def test_unknown_anchor_cannot_smuggle_a_wall_time():
    data=envelope(); data['evidence']['anchors']=[dict(epoch=1,probe_id=1,output_frame=0,
        utc_lower_ms=1000,utc_upper_ms=1001,monotonic_probe_span_ms=2,max_quantum_frames=128,quality='unknown')]
    with pytest.raises(CaptureError): normalize_capture_envelope(data)


def test_known_runs_must_be_ordered_but_source_positions_may_repeat():
    data=envelope(); run=data['evidence']['runs'][0]
    data['evidence']['runs'].append(dict(run,ordinal_start=64,output_start=512))
    with pytest.raises(CaptureError): normalize_capture_envelope(data)


def test_pre_epoch_utc_bounds_are_valid_signed_safe_integers():
    data=envelope();data['evidence']['anchors']=[dict(epoch=1,probe_id=1,output_frame=256,
        utc_lower_ms=-1000,utc_upper_ms=-995,monotonic_probe_span_ms=2,max_quantum_frames=128,quality='bounded')]
    assert normalize_capture_envelope(data)['evidence']['anchors'][0]['utc_lower_ms']==-1000
    data['evidence']['anchors'][0]['utc_lower_ms']=-9_007_199_254_740_992
    with pytest.raises(CaptureError):normalize_capture_envelope(data)


def test_unpaired_surrogate_locator_is_invalid_capture_not_transport_failure():
    data=envelope();data['initial_path']='/synthetic/\ud800.flac'
    with pytest.raises(CaptureError,match='invalid_capture') as error:
        parse_capture_body(json.dumps(data).encode())
    assert error.value.status==400


@pytest.mark.parametrize('lower,upper',[(-9_007_199_254_740_991,-9_007_199_254_740_990),
                                       (9_007_199_254_740_990,9_007_199_254_740_991)])
def test_signed_utc_safe_integer_endpoints(lower,upper):
    data=envelope();data['evidence']['anchors']=[dict(epoch=1,probe_id=1,output_frame=256,
        utc_lower_ms=lower,utc_upper_ms=upper,monotonic_probe_span_ms=0,max_quantum_frames=1,quality='bounded')]
    parsed=normalize_capture_envelope(data)
    assert parsed['evidence']['anchors'][0]['utc_upper_ms']==upper
    data['evidence']['anchors'][0]['utc_upper_ms']=9_007_199_254_740_992
    with pytest.raises(CaptureError):normalize_capture_envelope(data)
