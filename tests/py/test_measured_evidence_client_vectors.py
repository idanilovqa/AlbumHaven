"""Shared hand-authored JS/Python parity vectors, no application/config imports."""
import json
from pathlib import Path

import pytest

from music_app.services import measured_listen_admission as admission
from music_app.services import measured_listen_evidence as evidence

VECTORS = json.loads((Path(__file__).parents[1] / 'fixtures' / 'measured_evidence_client_vectors.json').read_text())


@pytest.mark.parametrize('case', VECTORS['cases'], ids=lambda case: case['name'])
def test_client_vectors_normalize_and_progress_under_real_python_admission(case):
    binding = VECTORS['binding']
    identity = admission.AdmissionIdentity(
        evidence.EvidenceScope(binding['account_id'], binding['library_id'], binding['track_id']),
        binding['device_id'], binding['session_id'], binding['sample_rate'], binding['decoder_instance_id'])
    metadata = admission.AdmissionMetadata(identity, 0, tuple(map(tuple, case['observed_intervals'])))
    previous = None
    for sequence, expected in enumerate(case['checkpoints']):
        payload = {'version': evidence.VERSION, 'device_id': binding['device_id'],
                   'session_id': binding['session_id'], 'sample_rate': binding['sample_rate'],
                   'checkpoint_sequence': sequence, 'coverage_complete': True,
                   'instrumentation_complete': True, 'finalized': False,
                   **{key: value for key, value in expected.items() if key != 'after'}}
        checkpoint = admission.normalize_admitted_checkpoint(payload, metadata)
        decision = admission.compare_admitted_checkpoint(previous, checkpoint, metadata)
        assert decision.kind == 'accept'
        assert checkpoint.wire() == payload
        assert sum(weight for _, weight in checkpoint.histogram) == checkpoint.rendered_frames
        previous = admission.AcceptedEvidence(metadata, checkpoint, decision.digest)
        assert admission.compare_admitted_checkpoint(previous, checkpoint, metadata).kind == 'replay'
