"""Pure admission contract tests; no application, decoder, route or DB imports."""
from dataclasses import replace

import pytest

from music_app.services import measured_listen_admission as admission
from music_app.services import measured_listen_evidence as evidence

RATE = 8000
DEVICE = "10000000-0000-4000-8000-000000000001"
SESSION = "10000000-0000-4000-8000-000000000002"
DECODER = "10000000-0000-4000-8000-000000000003"
OTHER = "10000000-0000-4000-8000-000000000004"
IDENTITY = admission.AdmissionIdentity(evidence.EvidenceScope(11, 22, 33), DEVICE, SESSION, RATE, DECODER)
PARTIAL = admission.AdmissionMetadata(IDENTITY, 7, ((0, RATE),))


def payload(**changes):
    return {"version": evidence.VERSION, "device_id": DEVICE, "session_id": SESSION,
            "checkpoint_sequence": 0, "sample_rate": RATE,
            "histogram_bin_frames": RATE, "histogram": [[0, RATE]],
            "rendered_frames": RATE, "max_observed_frame": RATE,
            "coverage_intervals": [[0, RATE]], "coverage_complete": True,
            "instrumentation_complete": True, "resolution_state": "one_second",
            "finalized": False, **changes}


def checkpoint(**changes):
    # Shape-only helper deliberately uses immutable identity, not a fake length.
    return evidence._normalize_checkpoint(payload(**changes), RATE, evidence.MAX_INTEGER)


def accepted(value=None, metadata=PARTIAL):
    value = checkpoint() if value is None else value
    decision = admission.compare_admitted_checkpoint(None, value, metadata)
    assert decision.kind == "accept"
    return admission.AcceptedEvidence(metadata, value, decision.digest)


def error(code, operation):
    with pytest.raises(evidence.EvidenceError) as result:
        operation()
    assert result.value.code == code


def verified(total=RATE, revision=8):
    return admission.AdmissionMetadata(IDENTITY, revision, ((0, total),),
                                       "verified_complete", total, admission.VERIFIED_PROVENANCE)


def test_interrupted_partial_session_accepts_without_claiming_total_or_completion():
    record = accepted(checkpoint(finalized=True))
    assert record.admission.verified_total_frames is None
    assert record.admission.extent_state == "observed_partial"
    assert record.checkpoint.coverage_complete is True
    assert record.checkpoint.finalized is True
    assert not hasattr(record, "song_complete")
    assert record.admission.metadata_revision == 7
    assert record.checkpoint.checkpoint_sequence == 0


def test_seek_only_observations_accept_exact_ranges_but_reject_gap():
    metadata = replace(PARTIAL, observed_intervals=((2 * RATE, 3 * RATE),))
    valid = payload(histogram=[[2, RATE]], max_observed_frame=3 * RATE,
                    coverage_intervals=[[2 * RATE, 3 * RATE]])
    assert admission.normalize_admitted_checkpoint(valid, metadata).rendered_frames == RATE
    invalid = {**valid, "histogram": [[1, RATE], [2, RATE]], "rendered_frames": 2 * RATE,
               "coverage_intervals": [[RATE, 3 * RATE]]}
    error("coverage_outside_observation", lambda: admission.normalize_admitted_checkpoint(invalid, metadata))


def test_same_bin_gap_is_rejected_even_when_bin_intersects_observation():
    metadata = replace(PARTIAL, observed_intervals=((0, 10), (20, 30)))
    error("coverage_outside_observation", lambda: admission.normalize_admitted_checkpoint(
        payload(histogram=[[0, 30]], rendered_frames=30, max_observed_frame=30,
                coverage_intervals=[[0, 30]]), metadata))


def test_unknown_coverage_still_requires_observed_extent_endpoint():
    metadata = replace(PARTIAL, observed_intervals=((0, 10), (20, 30)))
    error("extent_outside_observation", lambda: admission.normalize_admitted_checkpoint(
        payload(histogram=[[0, 10]], rendered_frames=10, max_observed_frame=20,
                coverage_intervals=[], coverage_complete=False), metadata))


def test_incomplete_coverage_does_not_authorize_histogram_in_unobserved_bin():
    metadata = replace(PARTIAL, observed_intervals=((0, RATE), (2 * RATE, 3 * RATE)))
    error("histogram_outside_observation", lambda: admission.normalize_admitted_checkpoint(
        payload(histogram=[[1, 1], [2, 1]], rendered_frames=2, max_observed_frame=3 * RATE,
                coverage_intervals=[], coverage_complete=False), metadata))


def test_bin_intersection_is_possible_support_not_unique_position_attestation():
    metadata = replace(PARTIAL, observed_intervals=((100, 101),))
    value = admission.normalize_admitted_checkpoint(payload(
        histogram=[[0, 10000]], rendered_frames=10000, max_observed_frame=101,
        coverage_intervals=[], coverage_complete=False), metadata)
    assert value.coverage_intervals == ()
    assert value.rendered_frames == 10000  # Retained local loops may repeat.


def test_histogram_intersection_is_clipped_at_reported_extent():
    metadata = replace(PARTIAL, observed_intervals=((100, 101),))
    error("extent_outside_observation", lambda: admission.normalize_admitted_checkpoint(payload(
        histogram=[[0, 1]], rendered_frames=1, max_observed_frame=50,
        coverage_intervals=[], coverage_complete=False), metadata))


def test_empty_evidence_does_not_require_invented_full_length():
    metadata = replace(PARTIAL, observed_intervals=())
    value = checkpoint(histogram=[], rendered_frames=0, max_observed_frame=0, coverage_intervals=[])
    assert accepted(value, metadata).checkpoint.rendered_frames == 0


def test_metadata_growth_does_not_change_digest_or_original_replay_record():
    record = accepted()
    grown = replace(PARTIAL, metadata_revision=19, observed_intervals=((0, 4 * RATE),))
    decision = admission.compare_admitted_checkpoint(record, checkpoint(), grown)
    assert decision.kind == "replay"
    assert decision.digest == record.digest
    assert record.admission is PARTIAL
    assert record.admission.extent_state == "observed_partial"
    assert admission.admitted_checkpoint_digest(checkpoint(), grown.identity) == record.digest


def test_verified_upgrade_preserves_replay_and_does_not_manufacture_coverage():
    record = accepted()
    decision = admission.compare_admitted_checkpoint(record, checkpoint(), verified(4 * RATE))
    assert decision.kind == "replay"
    assert decision.digest == record.digest
    assert record.checkpoint.coverage_intervals == ((0, RATE),)
    assert record.admission.verified_total_frames is None


def test_metadata_revision_and_evidence_sequence_advance_independently():
    record = accepted()
    incoming = checkpoint(checkpoint_sequence=1, histogram=[[0, 2 * RATE]], rendered_frames=2 * RATE)
    assert admission.compare_admitted_checkpoint(record, incoming, PARTIAL).kind == "accept"
    grown = replace(PARTIAL, metadata_revision=100, observed_intervals=((0, 2 * RATE),))
    incoming = checkpoint(checkpoint_sequence=1, histogram=[[0, RATE], [1, RATE]],
                          rendered_frames=2 * RATE, max_observed_frame=2 * RATE,
                          coverage_intervals=[[0, 2 * RATE]])
    assert admission.compare_admitted_checkpoint(record, incoming, grown).kind == "accept"
    error("sequence_gap", lambda: admission.compare_admitted_checkpoint(
        record, replace(incoming, checkpoint_sequence=100), grown))


@pytest.mark.parametrize("identity", [
    replace(IDENTITY, scope=evidence.EvidenceScope(12, 22, 33)),
    replace(IDENTITY, scope=evidence.EvidenceScope(11, 23, 33)),
    replace(IDENTITY, scope=evidence.EvidenceScope(11, 22, 34)),
    replace(IDENTITY, device_id=OTHER), replace(IDENTITY, session_id=OTHER),
    replace(IDENTITY, decoder_instance_id=OTHER), replace(IDENTITY, sample_rate=16000),
])
def test_immutable_identity_cannot_be_replaced(identity):
    error("admission_identity_changed", lambda: admission.compare_admission(
        PARTIAL, replace(PARTIAL, identity=identity, metadata_revision=8)))


@pytest.mark.parametrize("identity", [
    replace(IDENTITY, scope=None), replace(IDENTITY, scope=evidence.EvidenceScope(True, 22, 33)),
    replace(IDENTITY, device_id="invalid"), replace(IDENTITY, session_id="invalid"),
    replace(IDENTITY, decoder_instance_id="00000000-0000-0000-0000-000000000000"),
    replace(IDENTITY, sample_rate=True),
])
def test_forged_identity_dataclasses_are_validated(identity):
    with pytest.raises(evidence.EvidenceError):
        admission.validate_admission(replace(PARTIAL, identity=identity))


@pytest.mark.parametrize("field", ["device_id", "session_id"])
def test_wire_identity_must_match_server_identity(field):
    error("admission_identity_changed", lambda: admission.normalize_admitted_checkpoint(
        payload(**{field: OTHER}), PARTIAL))


def test_wire_sample_rate_must_match_decoder_rate():
    error("metadata_mismatch", lambda: admission.normalize_admitted_checkpoint(
        payload(sample_rate=16000), PARTIAL))


def test_digest_domain_and_identity_are_explicit():
    value = checkpoint()
    digest = admission.admitted_checkpoint_digest(value, IDENTITY)
    assert digest != evidence.checkpoint_digest(value, evidence.MediaMetadata(RATE, RATE), IDENTITY.scope)
    for identity in (replace(IDENTITY, decoder_instance_id=OTHER),
                     replace(IDENTITY, scope=evidence.EvidenceScope(12, 22, 33))):
        assert admission.admitted_checkpoint_digest(value, identity) != digest


@pytest.mark.parametrize("changes,code", [
    ({"metadata_revision": 6}, "metadata_revision_regressed"),
    ({"observed_intervals": ((0, 2 * RATE),)}, "metadata_revision_conflict"),
    ({"metadata_revision": 8, "observed_intervals": ((0, RATE - 1),)}, "observed_intervals_regressed"),
    ({"metadata_revision": 8, "observed_intervals": ()}, "observed_intervals_regressed"),
])
def test_metadata_regressions_are_rejected(changes, code):
    error(code, lambda: admission.compare_admission(PARTIAL, replace(PARTIAL, **changes)))


def test_server_limited_flag_is_sticky_and_does_not_fabricate_client_quality():
    limited = replace(PARTIAL, metadata_revision=8, admission_limited=True)
    assert admission.compare_admission(PARTIAL, limited) == limited
    error("admission_quality_regressed", lambda: admission.compare_admission(
        limited, replace(limited, metadata_revision=9, admission_limited=False)))
    assert accepted(metadata=limited).checkpoint.coverage_complete is True


@pytest.mark.parametrize("ranges", [
    [], ((1, 1),), ((-1, 10),), ((0, True),), ((0, 10), (10, 20)),
    ((0, 10), (9, 20)), ((20, 30), (0, 10)), ([0, 10],),
    ((0, evidence.MAX_INTEGER + 1),), ((0, 1),) * (evidence.MAX_INTERVALS + 1),
])
def test_observation_union_is_strict_canonical_and_bounded(ranges):
    with pytest.raises(evidence.EvidenceError):
        admission.validate_admission(replace(PARTIAL, observed_intervals=ranges))


def test_fragmentation_limit_is_explicit_and_never_bridges_gaps():
    ranges = tuple((2 * i, 2 * i + 1) for i in range(evidence.MAX_INTERVALS))
    metadata = replace(PARTIAL, observed_intervals=ranges, admission_limited=True)
    assert admission.validate_admission(metadata).observed_intervals == ranges
    error("coverage_outside_observation", lambda: admission.normalize_admitted_checkpoint(payload(
        histogram=[[0, 3]], rendered_frames=3, max_observed_frame=3,
        coverage_intervals=[[0, 3]]), metadata))


@pytest.mark.parametrize("changes,code", [
    ({"verified_total_frames": RATE}, "invalid_extent_provenance"),
    ({"extent_provenance": admission.VERIFIED_PROVENANCE}, "invalid_extent_provenance"),
    ({"extent_state": "estimated"}, "invalid_extent_state"),
    ({"admission_limited": 1}, "invalid_flag"),
    ({"metadata_revision": True}, "invalid_integer"),
])
def test_partial_metadata_never_implies_verified_extent(changes, code):
    error(code, lambda: admission.validate_admission(replace(PARTIAL, **changes)))


@pytest.mark.parametrize("changes,code", [
    ({"extent_provenance": "seek_eos"}, "invalid_extent_provenance"),
    ({"extent_provenance": None}, "invalid_extent_provenance"),
    ({"observed_intervals": ((1, RATE),)}, "verified_extent_conflict"),
    ({"observed_intervals": ((0, 10), (20, RATE))}, "verified_extent_conflict"),
    ({"verified_total_frames": None}, "invalid_integer"),
    ({"verified_total_frames": True}, "invalid_integer"),
])
def test_verified_extent_requires_explicit_from_zero_provenance(changes, code):
    error(code, lambda: admission.validate_admission(replace(verified(), **changes)))


def test_verified_smaller_extent_is_conflict_not_truncation_even_for_replay():
    record = accepted()
    error("verified_extent_conflict", lambda: admission.compare_admitted_checkpoint(
        record, checkpoint(), verified(RATE - 1)))
    assert record.checkpoint.max_observed_frame == RATE


def test_verified_extent_cannot_change_or_downgrade():
    current = verified()
    for future in (verified(RATE + 1, 9), verified(RATE - 1, 9),
                   replace(PARTIAL, metadata_revision=9)):
        error("verified_extent_conflict", lambda: admission.compare_admission(current, future))


def test_new_checkpoint_checks_current_observation_before_acceptance():
    record = accepted()
    value = checkpoint(checkpoint_sequence=1, histogram=[[0, RATE], [1, RATE]],
                       rendered_frames=2 * RATE, max_observed_frame=2 * RATE,
                       coverage_intervals=[[0, 2 * RATE]])
    error("coverage_outside_observation", lambda: admission.compare_admitted_checkpoint(record, value, PARTIAL))


def test_replay_conflict_stale_and_finalized_semantics_match_existing_contract():
    record = accepted()
    conflict = checkpoint(histogram=[[0, 2 * RATE]], rendered_frames=2 * RATE)
    error("sequence_conflict", lambda: admission.compare_admitted_checkpoint(record, conflict, PARTIAL))
    final = checkpoint(checkpoint_sequence=1, finalized=True)
    decision = admission.compare_admitted_checkpoint(record, final, PARTIAL)
    record = admission.AcceptedEvidence(PARTIAL, final, decision.digest)
    assert admission.compare_admitted_checkpoint(record, final, PARTIAL).kind == "replay"
    assert admission.compare_admitted_checkpoint(record, checkpoint(), PARTIAL).kind == "stale"
    error("already_finalized", lambda: admission.compare_admitted_checkpoint(
        record, replace(final, checkpoint_sequence=2), PARTIAL))


def test_accepted_snapshot_and_digest_are_revalidated():
    record = accepted()
    error("accepted_digest_mismatch", lambda: admission.compare_admitted_checkpoint(
        replace(record, digest="0" * 64), checkpoint(), PARTIAL))
    error("coverage_outside_observation", lambda: admission.compare_admitted_checkpoint(
        replace(record, admission=replace(PARTIAL, observed_intervals=((0, 1),))), checkpoint(), PARTIAL))


def test_repeated_weight_cannot_be_repurposed_as_new_unique_coverage():
    old = checkpoint(histogram=[[0, 100]], rendered_frames=100, max_observed_frame=10,
                     coverage_intervals=[[0, 10]])
    record = accepted(old)
    value = checkpoint(checkpoint_sequence=1, histogram=[[0, 100]], rendered_frames=100,
                       max_observed_frame=20, coverage_intervals=[[0, 20]])
    error("coverage_without_new_rendered_support", lambda: admission.compare_admitted_checkpoint(record, value, PARTIAL))


def test_incremental_conservation_is_per_bin_and_preserves_unknown_lower_bound():
    metadata = replace(PARTIAL, observed_intervals=((0, 2 * RATE),))
    old = checkpoint(histogram=[[0, 100], [1, 1]], rendered_frames=101,
                     max_observed_frame=RATE + 1, coverage_intervals=[[0, 10]], coverage_complete=False)
    record = accepted(old, metadata)
    value = checkpoint(checkpoint_sequence=1, histogram=[[0, 100], [1, 11]], rendered_frames=111,
                       max_observed_frame=RATE + 1, coverage_intervals=[[0, 20]], coverage_complete=False)
    error("coverage_without_new_rendered_support", lambda: admission.compare_admitted_checkpoint(record, value, metadata))


def test_exact_lower_bound_and_quality_remain_sticky():
    old = checkpoint(coverage_complete=False, instrumentation_complete=False)
    record = accepted(old)
    error("quality_regressed", lambda: admission.compare_admitted_checkpoint(
        record, replace(old, checkpoint_sequence=1, coverage_complete=True), PARTIAL))
    error("quality_regressed", lambda: admission.compare_admitted_checkpoint(
        record, replace(old, checkpoint_sequence=1, instrumentation_complete=True), PARTIAL))
    error("coverage_regressed", lambda: admission.compare_admitted_checkpoint(
        record, replace(old, checkpoint_sequence=1, coverage_intervals=()), PARTIAL))


def test_coarsening_reuses_weight_conservation_without_media_length_assumption():
    extent = RATE * evidence.MAX_BINS
    metadata = replace(PARTIAL, observed_intervals=((0, extent + RATE),))
    old = checkpoint(histogram=[[0, 10], [evidence.MAX_BINS - 1, 1]], rendered_frames=11,
                     max_observed_frame=extent, coverage_intervals=[[0, 10]], coverage_complete=False)
    record = accepted(old, metadata)
    value = checkpoint(checkpoint_sequence=1, histogram_bin_frames=2 * RATE,
                       histogram=[[0, 10], [1023, 1], [1024, 1]], rendered_frames=12,
                       max_observed_frame=extent + 1, coverage_intervals=[[0, 10]],
                       coverage_complete=False, resolution_state="coarsened")
    assert admission.compare_admitted_checkpoint(record, value, metadata).kind == "accept"


def test_fixed_metadata_api_and_digest_payload_remain_separate():
    value = checkpoint()
    small = evidence.MediaMetadata(RATE, RATE)
    big = evidence.MediaMetadata(RATE, 2 * RATE)
    assert evidence.checkpoint_digest(value, small, IDENTITY.scope) != evidence.checkpoint_digest(value, big, IDENTITY.scope)
    error("invalid_metadata", lambda: evidence.normalize_checkpoint(payload(), PARTIAL))
    error("invalid_admission", lambda: admission.normalize_admitted_checkpoint(payload(), small))
