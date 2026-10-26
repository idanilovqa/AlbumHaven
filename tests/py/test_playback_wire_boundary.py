"""Actual serialized Python -> client/worklet -> Python boundary fixture."""
import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from music_app.services.playback_capture import normalize_capture_envelope,CaptureError
from music_app.services.playback_position_transport import parse_position_capture_body
from music_app.services import playback_decoder_observation as observation


def test_rendered_checkpoint_round_trip_retains_alias_identity_and_excludes_unplayed(monkeypatch):
    fixture=Path(__file__).parents[1]/'js/runtime/producer-checkpoint.json'
    # The v1 public route remains closed to v2; use the actual private v2 parser.
    with pytest.raises(CaptureError,match='unsupported_capture_version'):
        normalize_capture_envelope(json.loads(fixture.read_text()))
    checkpoint=parse_position_capture_body(fixture.read_bytes())
    evidence=checkpoint['evidence'];runs=evidence['runs']
    assert [(r['binding_serial'],r['source_start48'],r['frames']) for r in runs]==[(1,0,2),(2,12003,4),(1,6,2)]
    assert sum(r['frames'] for r in runs)==8  # Sixteen enqueued, only eight rendered.
    assert [r['source_observation_ref'] for r in runs]==[
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111']
    parent=dict(original_track_id=1,original_file_id=2,original_root_id=3)
    rows=[dict(parent,observation_ref=ref,auth_session_guard='guard',original_library_id=8,
        generation=7,stream_id=11,source_base48=0,extent_frames48=extent)
        for ref,extent in [(runs[0]['source_observation_ref'],16),(runs[1]['source_observation_ref'],20000)]]
    class Connection:
        def execute(self,sql,params):
            assert 'account_id=%s' in sql and params[0]==9
            return self
        def fetchall(self):return rows
    monkeypatch.setattr(observation,'decoder_observation_ready',lambda connection:True)
    live=SimpleNamespace(actor=SimpleNamespace(account_id=9),library_id=8)
    observation.validate_known_observations(Connection(),live,parent,evidence,'guard')
    rows[1]['original_library_id']=99
    with pytest.raises(CaptureError,match='capture_conflict'):
        observation.validate_known_observations(Connection(),live,parent,evidence,'guard')
