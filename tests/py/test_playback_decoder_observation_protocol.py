"""UNRUN private normalizer composition; original public protocol remains exact."""
from copy import deepcopy
import json
import pytest
from music_app.services.playback_capture import CaptureError,PROTOCOL,parse_capture_body,canonical_json
from music_app.services.playback_edition_selection import normalize_selected_position_envelope
from music_app.services.playback_position_transport import parse_position_capture_body
from tests.py.test_playback_capture_public_boundary import packet

REF='11111111-1111-4111-8111-111111111111'

def test_private_run_reference_survives_real_parser_without_fabricating_extent():
    raw=packet();raw['evidence']['runs'][0]['source_observation_ref']=REF
    original=deepcopy(raw)
    value=parse_position_capture_body(json.dumps(raw).encode())
    assert value['evidence']['runs'][0]['source_observation_ref']==REF
    assert 'extent_frames48' not in value['evidence']['runs'][0]
    assert raw==original
    without=deepcopy(raw);without['evidence']['runs'][0].pop('source_observation_ref')
    assert canonical_json(value)!=canonical_json(normalize_selected_position_envelope(without))

@pytest.mark.parametrize('ref',[None,'',{},'00000000-0000-0000-0000-000000000000','AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])
def test_invalid_optional_ref_cannot_enter_private_checkpoint(ref):
    raw=packet();raw['evidence']['runs'][0]['source_observation_ref']=ref
    with pytest.raises(CaptureError):normalize_selected_position_envelope(raw)

def test_public_v1_rejects_private_run_field():
    raw=packet(PROTOCOL);raw['evidence']['runs'][0]['source_observation_ref']=REF
    with pytest.raises(CaptureError):parse_capture_body(json.dumps(raw).encode())
