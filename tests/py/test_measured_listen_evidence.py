"""Additive pure contract tests. No database, provider, route or player imports."""
from copy import deepcopy
from dataclasses import replace

import pytest

from music_app.services import measured_listen_evidence as evidence

RATE = 8000
MEDIA = evidence.MediaMetadata(RATE, RATE * 10000)
SCOPE = evidence.EvidenceScope(11, 22, 33)
DEVICE = "10000000-0000-4000-8000-000000000001"
SESSION = "10000000-0000-4000-8000-000000000002"


def payload(**changes):
    return {"version": evidence.VERSION, "device_id": DEVICE, "session_id": SESSION,
            "checkpoint_sequence": 0, "sample_rate": RATE,
            "histogram_bin_frames": RATE, "histogram": [[0, RATE]],
            "rendered_frames": RATE, "max_observed_frame": RATE,
            "coverage_intervals": [[0, RATE]], "coverage_complete": True,
            "instrumentation_complete": True, "resolution_state": "one_second",
            "finalized": False, **changes}


def normalized(**changes):
    return evidence.normalize_checkpoint(payload(**changes), MEDIA)


def error(code, operation):
    with pytest.raises(evidence.EvidenceError) as result:
        operation()
    assert result.value.code == code


def test_exact_roundtrip_is_immutable_and_does_not_mutate_input():
    source = payload()
    before = deepcopy(source)
    value = evidence.normalize_checkpoint(source, MEDIA)
    assert source == before
    source["histogram"][0][1] = 1
    assert value.histogram == ((0, RATE),)
    copy = value.wire()
    copy["coverage_intervals"][0][1] = 1
    assert value.coverage_intervals == ((0, RATE),)
    assert value.wire() == before


@pytest.mark.parametrize("change,code", [
    ({"version": "rendered-pcm-v1"}, "invalid_version"),
    ({"device_id": "00000000-0000-0000-0000-000000000000"}, "invalid_identity"),
    ({"session_id": SESSION.upper().replace("10000000", "AAAAAAAA")}, "invalid_identity"),
    ({"session_id": None}, "invalid_identity"),
    ({"checkpoint_sequence": True}, "invalid_integer"),
    ({"checkpoint_sequence": -1}, "invalid_integer"),
    ({"checkpoint_sequence": evidence.MAX_INTEGER + 1}, "invalid_integer"),
    ({"sample_rate": RATE + 1}, "metadata_mismatch"),
    ({"sample_rate": 7999}, "invalid_integer"),
    ({"sample_rate": 192001}, "invalid_integer"),
    ({"rendered_frames": float("nan")}, "invalid_integer"),
    ({"rendered_frames": float("inf")}, "invalid_integer"),
    ({"rendered_frames": 1.0}, "invalid_integer"),
    ({"max_observed_frame": MEDIA.total_frames + 1}, "invalid_integer"),
    ({"histogram_bin_frames": RATE * 2}, "invalid_resolution"),
    ({"resolution_state": "coarsened"}, "invalid_resolution"),
    ({"histogram": [[0, RATE - 1]]}, "histogram_total_mismatch"),
    ({"histogram": [[1, RATE]]}, "invalid_histogram"),
    ({"histogram": [[0, 0]]}, "invalid_histogram"),
    ({"histogram": [[0, 1], [0, RATE - 1]]}, "invalid_histogram"),
    ({"histogram": [[0, True]]}, "invalid_integer"),
    ({"histogram": {0: RATE}}, "invalid_pairs"),
    ({"histogram": [(0, RATE)]}, "invalid_pairs"),
    ({"histogram": [[0, RATE, 1]]}, "invalid_pairs"),
    ({"coverage_intervals": [[0, RATE // 2], [RATE // 2, RATE]]}, "invalid_coverage"),
    ({"coverage_intervals": [[1, 1]]}, "invalid_coverage"),
    ({"coverage_intervals": [[0, RATE + 1]]}, "invalid_coverage"),
    ({"coverage_intervals": []}, "rendered_without_coverage"),
    ({"finalized": 1}, "invalid_flag"),
    ({"coverage_complete": "true"}, "invalid_flag"),
    ({"instrumentation_complete": None}, "invalid_flag"),
])
def test_malformed_wire_is_rejected(change, code):
    error(code, lambda: evidence.normalize_checkpoint(payload(**change), MEDIA))


@pytest.mark.parametrize("kind", ["extra", "missing", "scope"])
def test_exact_wire_keys_prevent_scope_injection(kind):
    value = payload()
    if kind == "missing":
        value.pop("finalized")
    else:
        value["account_id" if kind == "scope" else "unexpected"] = 11
    error("invalid_fields", lambda: evidence.normalize_checkpoint(value, MEDIA))


@pytest.mark.parametrize("field,limit", [("histogram", evidence.MAX_BINS),
                                         ("coverage_intervals", evidence.MAX_INTERVALS)])
def test_pair_count_bound_precedes_iteration(field, limit):
    error("invalid_pairs", lambda: evidence.normalize_checkpoint(payload(**{field: [[0, 1]] * (limit + 1)}), MEDIA))


@pytest.mark.parametrize("metadata", [None, {}, evidence.MediaMetadata(True, 100),
                                      evidence.MediaMetadata(8000, 0)])
def test_metadata_is_explicit_and_validated_but_never_authenticated(metadata):
    with pytest.raises(evidence.EvidenceError):
        evidence.normalize_checkpoint(payload(), metadata)


def test_short_and_empty_measurements_have_no_meaningful_listen_threshold():
    value = normalized(rendered_frames=1, max_observed_frame=1,
                       histogram=[[0, 1]], coverage_intervals=[[0, 1]], finalized=True)
    assert value.rendered_frames == 1
    empty = normalized(rendered_frames=0, max_observed_frame=0, histogram=[], coverage_intervals=[])
    assert empty.rendered_frames == 0  # Future service may omit an empty row.


def test_repeat_intensity_increases_without_increasing_unique_coverage():
    old = normalized()
    new = normalized(checkpoint_sequence=1, histogram=[[0, 3 * RATE]], rendered_frames=3 * RATE)
    assert new.coverage_intervals == old.coverage_intervals
    assert evidence.compare_checkpoint(old, new, MEDIA, SCOPE).kind == "accept"


def test_coverage_support_is_per_bin_not_just_global_sum():
    error("coverage_without_rendered_support", lambda: normalized(
        max_observed_frame=2 * RATE, histogram=[[1, RATE]], coverage_intervals=[[0, RATE]],
        coverage_complete=False))


def test_fragmentation_lower_bound_can_remain_frozen_while_time_grows():
    old = normalized(coverage_complete=False)
    new = normalized(checkpoint_sequence=1, max_observed_frame=3 * RATE,
                     histogram=[[0, RATE], [2, RATE]], rendered_frames=2 * RATE,
                     coverage_complete=False)
    assert evidence.compare_checkpoint(old, new, MEDIA, SCOPE).kind == "accept"
    assert new.coverage_intervals == old.coverage_intervals


def test_coarsening_boundary_and_exact_frame_conservation():
    assert evidence.bin_width(RATE, RATE * 2048) == RATE
    assert evidence.bin_width(RATE, RATE * 2048 + 1) == 2 * RATE
    assert evidence.bin_width(RATE, RATE * 4096 + 1) == 4 * RATE
    old = normalized(histogram=[[0, RATE], [1, RATE], [2047, 1]],
                     rendered_frames=2 * RATE + 1, max_observed_frame=2047 * RATE + 1,
                     coverage_intervals=[[0, 2 * RATE], [2047 * RATE, 2047 * RATE + 1]])
    new = normalized(checkpoint_sequence=1, histogram_bin_frames=2 * RATE,
                     resolution_state="coarsened", histogram=[[0, 2 * RATE], [1023, 1], [1024, 1]],
                     rendered_frames=2 * RATE + 2, max_observed_frame=2048 * RATE + 1,
                     coverage_intervals=[[0, 2 * RATE], [2047 * RATE, 2047 * RATE + 1],
                                         [2048 * RATE, 2048 * RATE + 1]])
    assert evidence.compare_checkpoint(old, new, MEDIA, SCOPE).kind == "accept"
    assert sum(count for _, count in new.histogram) == old.rendered_frames + 1
    assert len(new.coverage_intervals) == 3  # Coarsening never fills the skipped gap.


def test_equal_global_sum_cannot_move_prior_weight_between_bins():
    old = normalized(max_observed_frame=2 * RATE, histogram=[[0, RATE], [1, RATE]],
                     rendered_frames=2 * RATE, coverage_intervals=[[0, 2 * RATE]])
    new = normalized(checkpoint_sequence=1, max_observed_frame=2 * RATE,
                     histogram=[[0, RATE - 1], [1, RATE + 1]], rendered_frames=2 * RATE,
                     coverage_complete=False, coverage_intervals=[[0, RATE - 1]])
    error("coverage_regressed", lambda: evidence.compare_checkpoint(old, new, MEDIA, SCOPE))
    sparse_old = normalized(max_observed_frame=2 * RATE, histogram=[[0, RATE], [1, RATE]],
                            rendered_frames=2 * RATE, coverage_complete=False, coverage_intervals=[])
    sparse_new = replace(new, coverage_intervals=())
    error("histogram_regressed", lambda: evidence.compare_checkpoint(sparse_old, sparse_new, MEDIA, SCOPE))


@pytest.mark.parametrize("field", ["coverage_complete", "instrumentation_complete"])
def test_incomplete_quality_is_sticky(field):
    old = normalized(**{field: False})
    new = normalized(checkpoint_sequence=1)
    error("quality_regressed", lambda: evidence.compare_checkpoint(old, new, MEDIA, SCOPE))


def test_new_latest_exact_replay_conflict_gap_stale_and_finalized_semantics():
    first = normalized()
    decision = evidence.compare_checkpoint(None, first, MEDIA, SCOPE)
    assert decision.kind == "accept"
    assert evidence.compare_checkpoint(first, first, MEDIA, SCOPE) == evidence.Decision("replay", decision.digest)
    changed = normalized(instrumentation_complete=False)
    error("sequence_conflict", lambda: evidence.compare_checkpoint(first, changed, MEDIA, SCOPE))
    error("sequence_gap", lambda: evidence.compare_checkpoint(None, normalized(checkpoint_sequence=1), MEDIA, SCOPE))
    error("sequence_gap", lambda: evidence.compare_checkpoint(first, normalized(checkpoint_sequence=2), MEDIA, SCOPE))
    final = normalized(checkpoint_sequence=1, finalized=True)
    assert evidence.compare_checkpoint(first, final, MEDIA, SCOPE).kind == "accept"
    assert evidence.compare_checkpoint(final, final, MEDIA, SCOPE).kind == "replay"
    assert evidence.compare_checkpoint(final, first, MEDIA, SCOPE).kind == "stale"
    assert evidence.compare_checkpoint(final, changed, MEDIA, SCOPE).kind == "stale"  # No invented old-byte receipt.
    error("already_finalized", lambda: evidence.compare_checkpoint(final, normalized(checkpoint_sequence=2), MEDIA, SCOPE))


def test_identity_checked_before_stale_sequence_result():
    previous = normalized(checkpoint_sequence=1)
    wrong = normalized(session_id="10000000-0000-4000-8000-000000000099")
    error("identity_changed", lambda: evidence.compare_checkpoint(previous, wrong, MEDIA, SCOPE))


def test_digest_binds_scope_metadata_identity_and_canonical_bytes():
    first = normalized()
    digest = evidence.checkpoint_digest(first, MEDIA, SCOPE)
    assert len(digest) == 64
    reordered = dict(reversed(list(payload().items())))
    assert evidence.checkpoint_digest(evidence.normalize_checkpoint(reordered, MEDIA), MEDIA, SCOPE) == digest
    for field in ("account_id", "library_id", "track_id"):
        assert evidence.checkpoint_digest(first, MEDIA, replace(SCOPE, **{field: 44})) != digest
    assert evidence.checkpoint_digest(first, replace(MEDIA, total_frames=MEDIA.total_frames + 1), SCOPE) != digest
    error("invalid_integer", lambda: evidence.checkpoint_digest(first, MEDIA, replace(SCOPE, account_id=True)))


def test_constructed_dataclass_cannot_bypass_normalization():
    forged = replace(normalized(), histogram=((0, -1),))
    error("invalid_integer", lambda: evidence.checkpoint_digest(forged, MEDIA, SCOPE))


def test_observed_extent_needs_weight_in_its_last_bin_even_for_lower_bound_coverage():
    error("unsupported_extent", lambda: normalized(max_observed_frame=3 * RATE,
          coverage_complete=False))


def test_counter_and_coverage_regressions_are_distinct():
    old = normalized(histogram=[[0, 2 * RATE]], rendered_frames=2 * RATE)
    error("counter_regressed", lambda: evidence.compare_checkpoint(old, normalized(checkpoint_sequence=1), MEDIA, SCOPE))
    old = normalized()
    new = normalized(checkpoint_sequence=1, coverage_intervals=[[1, RATE]])
    error("coverage_regressed", lambda: evidence.compare_checkpoint(old, new, MEDIA, SCOPE))


def test_previous_coarse_weight_cannot_disappear_when_resolution_doubles():
    old = normalized(histogram=[[0, 2 * RATE], [2047, 1]],
                     rendered_frames=2 * RATE + 1, max_observed_frame=2047 * RATE + 1,
                     coverage_complete=False, coverage_intervals=[])
    new = normalized(checkpoint_sequence=1, histogram_bin_frames=2 * RATE,
                     resolution_state="coarsened", histogram=[[0, RATE], [1023, 1], [1024, RATE]],
                     rendered_frames=2 * RATE + 1, max_observed_frame=2048 * RATE + 1,
                     coverage_complete=False, coverage_intervals=[])
    error("histogram_regressed", lambda: evidence.compare_checkpoint(old, new, MEDIA, SCOPE))


def test_safe_integer_boundary_is_checked_without_float_rounding():
    media = evidence.MediaMetadata(RATE, evidence.MAX_INTEGER)
    width = evidence.bin_width(RATE, evidence.MAX_INTEGER)
    index = (evidence.MAX_INTEGER - 1) // width
    value = evidence.normalize_checkpoint(payload(
        max_observed_frame=evidence.MAX_INTEGER, histogram_bin_frames=width,
        resolution_state="coarsened", histogram=[[index, evidence.MAX_INTEGER]],
        rendered_frames=evidence.MAX_INTEGER, coverage_complete=False, coverage_intervals=[]), media)
    assert value.rendered_frames == evidence.MAX_INTEGER
    assert sum(weight for _, weight in value.histogram) == evidence.MAX_INTEGER


def test_complete_coverage_requires_support_for_every_weighted_bin():
    error("rendered_without_coverage", lambda: normalized(
        max_observed_frame=2 * RATE, histogram=[[0, RATE], [1, RATE]],
        rendered_frames=2 * RATE, coverage_intervals=[[RATE, 2 * RATE]]))


@pytest.mark.parametrize("complete", [True, False])
def test_old_repeated_time_cannot_become_unique_coverage_without_new_frames(complete):
    old = normalized(max_observed_frame=1, coverage_intervals=[[0, 1]],
                     coverage_complete=complete)
    new = normalized(checkpoint_sequence=1, coverage_complete=complete)
    error("coverage_without_new_rendered_support",
          lambda: evidence.compare_checkpoint(old, new, MEDIA, SCOPE))


def test_new_same_bin_coverage_is_accepted_only_with_enough_incremental_weight():
    old = normalized(max_observed_frame=1, coverage_intervals=[[0, 1]])
    new = normalized(checkpoint_sequence=1, rendered_frames=2 * RATE - 1,
                     histogram=[[0, 2 * RATE - 1]])
    assert evidence.compare_checkpoint(old, new, MEDIA, SCOPE).kind == "accept"


@pytest.mark.parametrize("complete", [True, False])
def test_coarsening_cannot_use_other_bins_new_weight_to_backfill_old_repeated_positions(complete):
    old = normalized(max_observed_frame=2047 * RATE + 1,
                     histogram=[[0, RATE], [2047, 1]], rendered_frames=RATE + 1,
                     coverage_intervals=[[0, 1], [2047 * RATE, 2047 * RATE + 1]],
                     coverage_complete=complete)
    new = normalized(checkpoint_sequence=1, histogram_bin_frames=2 * RATE,
                     resolution_state="coarsened", max_observed_frame=2048 * RATE + 1,
                     histogram=[[0, RATE], [1023, 1], [1024, RATE]],
                     rendered_frames=2 * RATE + 1,
                     coverage_intervals=[[0, RATE], [2047 * RATE, 2047 * RATE + 1],
                                         [2048 * RATE, 2048 * RATE + 1]],
                     coverage_complete=complete)
    # Global added coverage equals global new rendered frames; bin0 has no new
    # weight, so the unrelated new bin cannot pay for its coverage expansion.
    error("coverage_without_new_rendered_support",
          lambda: evidence.compare_checkpoint(old, new, MEDIA, SCOPE))


def test_coarsening_accepts_new_coverage_supported_in_each_coarsened_bin():
    old = normalized(max_observed_frame=2047 * RATE + 1,
                     histogram=[[0, RATE], [2047, 1]], rendered_frames=RATE + 1,
                     coverage_intervals=[[0, 1], [2047 * RATE, 2047 * RATE + 1]])
    new = normalized(checkpoint_sequence=1, histogram_bin_frames=2 * RATE,
                     resolution_state="coarsened", max_observed_frame=2048 * RATE + 1,
                     histogram=[[0, 2 * RATE - 1], [1023, 1], [1024, 1]],
                     rendered_frames=2 * RATE + 1,
                     coverage_intervals=[[0, RATE], [2047 * RATE, 2047 * RATE + 1],
                                         [2048 * RATE, 2048 * RATE + 1]])
    assert evidence.compare_checkpoint(old, new, MEDIA, SCOPE).kind == "accept"


def test_incomplete_previous_coverage_cannot_retrofit_unknown_old_positions():
    old = normalized(coverage_intervals=[], coverage_complete=False)
    new = normalized(checkpoint_sequence=1, coverage_complete=False)
    error("coverage_without_new_rendered_support",
          lambda: evidence.compare_checkpoint(old, new, MEDIA, SCOPE))
    supported = normalized(checkpoint_sequence=1, coverage_complete=False,
                           histogram=[[0, 2 * RATE]], rendered_frames=2 * RATE)
    assert evidence.compare_checkpoint(old, supported, MEDIA, SCOPE).kind == "accept"


def test_coverage_subtraction_handles_merge_and_multiple_old_intervals():
    old = normalized(max_observed_frame=5, histogram=[[0, 3]], rendered_frames=3,
                     coverage_intervals=[[0, 1], [2, 3], [4, 5]])
    new = normalized(checkpoint_sequence=1, max_observed_frame=5,
                     histogram=[[0, 5]], rendered_frames=5, coverage_intervals=[[0, 5]])
    assert evidence.compare_checkpoint(old, new, MEDIA, SCOPE).kind == "accept"


def test_incomplete_extent_cannot_advance_using_only_old_bin_weight():
    old = normalized(max_observed_frame=1, coverage_intervals=[], coverage_complete=False)
    new = normalized(checkpoint_sequence=1, coverage_intervals=[], coverage_complete=False)
    error("extent_without_new_rendered_support",
          lambda: evidence.compare_checkpoint(old, new, MEDIA, SCOPE))
