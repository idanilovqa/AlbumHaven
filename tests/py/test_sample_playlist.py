"""Independent pure Sample evaluator contracts; no source capture or activation."""
from dataclasses import FrozenInstanceError, fields, replace
from datetime import datetime, timezone
from decimal import Decimal
import random
import secrets

import pytest

from music_app.services import popularity_snapshots as popularity
from music_app.services import sample_playlist as sample


NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)


def candidate(track_id=1, *, count=10, **changes):
    values = dict(track_id=track_id, canonical_recording_id=f"recording:{track_id}",
                  recording_evidence="resolved:recording", album_ref="album:a", primary_artist_ref="artist:a",
                  source_position=track_id, disc_number=1, track_number=1, duration_seconds=120,
                  styles=frozenset({"style:prog"}), countries=frozenset({"country:GB"}))
    values.update(changes)
    if values["canonical_recording_id"] is None and "recording_evidence" not in changes:
        values["recording_evidence"] = None
    mapping = popularity.LocalTrackEvidence(track_id, f"mapping:{track_id}", "lastfm", f"lastfm:{track_id}",
        values["canonical_recording_id"], values["recording_evidence"], values["primary_artist_ref"],
        "resolved:artist" if values["primary_artist_ref"] is not None else None)
    observation = popularity.PopularityObservation("lastfm", "overall_scrobbles", mapping.source_entity_id,
        "opaque:observation", NOW, NOW, count, "missing" if count is None else "resolved")
    values.setdefault("popularity_track", mapping)
    values.setdefault("popularity", popularity.CachedPopularity(track_id, mapping.mapping_revision, observation))
    return sample.SampleCandidate(**values)


def options(**changes):
    return sample.SampleOptions(**(dict(selection_basis="per_album", songs_per_group=1,
                                        unknown_facets="exclude") | changes))


def evaluate(rows, **changes):
    return sample.evaluate_sample_playlist(rows, options(**changes))


def random_select(rows, order, **changes):
    return sample.evaluate_sample_playlist(rows, options(selection_method="random", **changes), random_order=order)


def changed_observation(row, **changes):
    return replace(row, popularity=replace(row.popularity, observation=replace(row.popularity.observation, **changes)))


def prohibit_popularity_reads(monkeypatch, ids):
    def read(self, name):
        if name in {"popularity_track", "popularity"} and object.__getattribute__(self, "track_id") in ids:
            raise AssertionError("Ignored popularity field was accessed")
        return object.__getattribute__(self, name)
    monkeypatch.setattr(sample.SampleCandidate, "__getattribute__", read)


def selector_spy(monkeypatch):
    calls = []
    def wrapped(rows, **kwargs):
        captured = tuple(rows)
        result = popularity.select_local_popular_tracks(captured, **kwargs)
        calls.append((captured, kwargs, result))
        return result
    monkeypatch.setattr(sample, "select_local_popular_tracks", wrapped)
    return calls


# G1: default shared global popularity, zero, quota and source-order ties.
def test_default_most_listened_global_counts_and_zero_with_explicit_policy_and_quota():
    rows = [candidate(4, source_position=0, album_ref="album:b", count=30),
            candidate(2, source_position=1, count=30), candidate(3, source_position=2, count=80),
            candidate(1, source_position=3, album_ref="album:c", count=0),
            candidate(5, source_position=4, album_ref="album:d", count=None)]
    value = evaluate(reversed(rows))
    assert options().selection_method == "most_listened"
    assert value.track_ids == (3, 4, 1)
    assert value.diagnostics == ((2, "quota_exceeded"), (5, "missing_global_metric"))
    assert value.group_counts == (("album:b", 1), ("album:a", 1), ("album:c", 1), ("album:d", 0))
    assert value.random_order is None


def test_tied_counts_use_complete_stable_source_disc_track_id_order_not_input_order():
    rows = [candidate(9, source_position=1, disc_number=1, track_number=2),
            candidate(10, source_position=1, disc_number=1, track_number=1),
            candidate(3, source_position=1, disc_number=None, track_number=1),
            candidate(4, source_position=1, disc_number=2, track_number=None),
            candidate(5, source_position=1, disc_number=2, track_number=1),
            candidate(7, source_position=0), candidate(11, source_position=1, disc_number=1, track_number=1)]
    assert evaluate(reversed(rows), songs_per_group=20).track_ids == (7, 10, 11, 9, 5, 4, 3)


def test_complete_selection_has_no_fifty_row_page_or_inferred_ui_quota_maximum():
    rows = tuple(candidate(i, count=i) for i in range(1, 76))
    value = evaluate(rows, songs_per_group=10**8)
    assert value.track_ids == tuple(range(75, 0, -1))
    assert value.group_counts == (("album:a", 75),)
    assert value.diagnostics == ()


# G2: independent restrictions, OR within facets, AND across facets, unknowns.
def test_all_unrestricted_filters_admit_unknown_facets_even_with_exclude_policy():
    row = candidate(duration_seconds=None, styles=None, countries=None)
    value = evaluate([row])
    assert value.track_ids == (1,)
    assert value.diagnostics == ()


@pytest.mark.parametrize("restriction,facts", [
    ({"length": "up_to_3"}, {"duration_seconds": 239, "styles": None, "countries": None}),
    ({"styles": frozenset({"style:prog"})}, {"duration_seconds": None, "countries": None}),
    ({"countries": frozenset({"country:GB"})}, {"duration_seconds": None, "styles": None}),
])
def test_each_facet_can_be_restricted_while_other_facets_are_independently_unrestricted(restriction, facts):
    assert evaluate([candidate(**facts)], **restriction).track_ids == (1,)


def test_or_within_each_facet_and_and_across_length_style_country():
    rows = [candidate(1, styles=frozenset({"style:prog", "style:jazz"}), countries=frozenset({"country:GB", "country:DE"})),
            candidate(2, duration_seconds=240), candidate(3, styles=frozenset({"style:jazz"})),
            candidate(4, countries=frozenset({"country:DE"})),
            candidate(5, duration_seconds=240, styles=frozenset(), countries=frozenset())]
    value = evaluate(rows, songs_per_group=9, length="up_to_3", styles=frozenset({"style:prog", "style:metal"}),
                     countries=frozenset({"country:US", "country:GB"}))
    assert value.track_ids == (1,)
    assert value.diagnostics == ((2, "length_filtered"), (3, "style_filtered"), (4, "country_filtered"),
                                (5, "country_filtered"), (5, "length_filtered"), (5, "style_filtered"))


@pytest.mark.parametrize("policy", ["include", "exclude"])
@pytest.mark.parametrize("field,restriction,reason", [
    ("duration_seconds", {"length": "up_to_5"}, "unknown_length"),
    ("styles", {"styles": frozenset({"style:prog"})}, "unknown_style"),
    ("countries", {"countries": frozenset({"country:GB"})}, "unknown_country"),
])
def test_unknown_restricted_facets_follow_only_explicit_caller_policy(policy, field, restriction, reason):
    value = evaluate([candidate(**{field: None})], unknown_facets=policy, **restriction)
    # R3 successor: only the two include-policy Style/Country cases change.
    included = policy == "include" and field == "duration_seconds"
    assert value.track_ids == ((1,) if included else ())
    assert value.diagnostics == (() if included else ((1, reason),))


@pytest.mark.parametrize("policy", ["include", "exclude"])
@pytest.mark.parametrize("field,allowed,reason", [("styles", "style:prog", "style_filtered"),
                                                 ("countries", "country:GB", "country_filtered")])
def test_known_empty_is_not_unknown_and_cannot_match_restricted_facet(policy, field, allowed, reason):
    value = evaluate([candidate(**{field: frozenset()})], unknown_facets=policy, **{field: frozenset({allowed})})
    assert value.track_ids == ()
    assert value.diagnostics == ((1, reason),)


@pytest.mark.parametrize("field,known,allowed,reason", [
    ("styles", "Style:Prog", "style:prog", "style_filtered"),
    ("countries", "country:gb", "country:GB", "country_filtered"),
    ("styles", "style:prog ", "style:prog", "style_filtered"),
])
def test_facet_identities_are_exact_without_case_or_whitespace_rewriting(field, known, allowed, reason):
    value = evaluate([candidate(**{field: frozenset({known})})], **{field: frozenset({allowed})})
    assert value.track_ids == ()
    assert value.diagnostics == ((1, reason),)


# G3: exact minute-bucket cutoffs and numeric validation.
DURATION_CASES = [("up_to_3", "0", True), ("up_to_3", "239.999", True), ("up_to_3", "240", False),
    ("up_to_5", "334", True), ("up_to_5", "359.999", True), ("up_to_5", "360", False),
    ("up_to_8", "539.999", True), ("up_to_8", "540", False),
    ("up_to_10", "659.999", True), ("up_to_10", "660", False),
    ("over_10", "659.999", False), ("over_10", "660", True), ("over_10", "661", True)]


@pytest.mark.parametrize("length,seconds,accepted", DURATION_CASES)
@pytest.mark.parametrize("numeric", [float, Decimal])
def test_exact_duration_bucket_boundaries(length, seconds, accepted, numeric):
    value = evaluate([candidate(duration_seconds=numeric(seconds))], length=length)
    assert value.track_ids == ((1,) if accepted else ())
    assert value.diagnostics == (() if accepted else ((1, "length_filtered"),))


@pytest.mark.parametrize("seconds", [True, False, -1, -0.01, float("nan"), float("inf"), -float("inf"),
    Decimal("NaN"), Decimal("sNaN"), Decimal("Infinity"), Decimal("-1"), "120", complex(120, 0), object()])
def test_invalid_duration_fails_even_without_restrictive_length_filter(seconds):
    with pytest.raises(ValueError):
        evaluate([candidate(duration_seconds=seconds)])


def test_duration_eligibility_is_per_song_not_total_playlist_runtime():
    value = evaluate([candidate(1, duration_seconds=230), candidate(2, duration_seconds=230)],
                     length="up_to_3", songs_per_group=2)
    assert value.track_ids == (1, 2)
    assert value.group_counts == (("album:a", 2),)


# G4: filter before canonical copy selection, cache access and quota.
@pytest.mark.parametrize("method", ["most_listened", "random"])
def test_earliest_filtered_copy_does_not_suppress_later_eligible_canonical_copy(method, monkeypatch):
    first = candidate(1, duration_seconds=300, count=10000)
    later = candidate(2, canonical_recording_id=first.canonical_recording_id, count=1)
    other = candidate(3, count=2)
    prohibit_popularity_reads(monkeypatch, {1})
    value = sample.evaluate_sample_playlist([other, later, first], options(selection_method=method, length="up_to_3"),
        random_order=(2, 3) if method == "random" else None)
    assert value.track_ids == ((2,) if method == "random" else (3,))
    assert value.diagnostics == ((1, "length_filtered"), (3 if method == "random" else 2, "quota_exceeded"))


def test_filtered_rows_report_all_facet_failures_and_do_not_report_missing_identity_or_mapping(monkeypatch):
    row = candidate(canonical_recording_id=None, album_ref=None, duration_seconds=None, styles=None, countries=None,
                    popularity_track=None, popularity=object())
    prohibit_popularity_reads(monkeypatch, {1})
    value = evaluate([row], length="up_to_3", styles=frozenset({"style:prog"}), countries=frozenset({"country:GB"}))
    assert value.track_ids == ()
    assert value.diagnostics == ((1, "unknown_country"), (1, "unknown_length"), (1, "unknown_style"))
    assert value.group_counts == ()


def test_eligible_copy_survives_an_earlier_copy_without_the_selected_group():
    earlier = candidate(1, album_ref=None)
    later = candidate(2, canonical_recording_id=earlier.canonical_recording_id)
    value = evaluate([earlier, later])
    assert value.track_ids == (2,)
    assert value.diagnostics == ((1, "missing_group_identity"),)


# G5: trusted grouping, source-copy ownership and no featured multiplication.
@pytest.mark.parametrize("basis,expected,groups", [
    ("per_album", (1, 2, 3), (("album:a", 1), ("album:b", 1), ("album:compilation", 1))),
    ("per_artist", (1, 3), (("artist:album", 1), ("artist:compilation-track", 1))),
])
def test_only_supplied_primary_group_is_used_for_albums_compilations_and_featured_guests(basis, expected, groups):
    rows = [candidate(1, count=30, primary_artist_ref="artist:album"),
            candidate(2, count=20, album_ref="album:b", primary_artist_ref="artist:album"),
            candidate(3, count=10, album_ref="album:compilation", primary_artist_ref="artist:compilation-track")]
    rows[0] = replace(rows[0], popularity_track=replace(rows[0].popularity_track, canonical_artist_id="artist:featured"))
    value = evaluate(rows, selection_basis=basis)
    assert value.track_ids == expected
    assert value.group_counts == groups
    assert all(group != "artist:featured" for group, _ in value.group_counts)


@pytest.mark.parametrize("basis", ["per_album", "per_artist"])
@pytest.mark.parametrize("method", ["most_listened", "random"])
def test_shared_recording_first_eligible_source_copy_owns_one_group_even_when_later_copy_is_more_popular(basis, method):
    first = candidate(8, source_position=0, count=1, album_ref="album:first", primary_artist_ref="artist:first")
    later = candidate(2, source_position=1, count=900, canonical_recording_id=first.canonical_recording_id,
                      album_ref="album:later", primary_artist_ref="artist:later")
    value = sample.evaluate_sample_playlist([later, first], options(selection_basis=basis, selection_method=method),
        random_order=(8,) if method == "random" else None)
    prefix = "album" if basis == "per_album" else "artist"
    assert value.track_ids == (8,)
    assert value.diagnostics == ((2, "duplicate_canonical_recording"),)
    assert value.group_counts == ((f"{prefix}:first", 1), (f"{prefix}:later", 0))


def test_distinct_recordings_are_not_merged_by_album_or_primary_artist():
    value = evaluate([candidate(1), candidate(2)], songs_per_group=2)
    assert value.track_ids == (1, 2)
    assert value.diagnostics == ()


# G6: missing canonical/group identity, visible zero/short groups, no padding.
@pytest.mark.parametrize("basis,missing", [("per_album", "album_ref"), ("per_artist", "primary_artist_ref")])
def test_missing_canonical_and_selected_group_report_both_without_fabricated_identity(basis, missing):
    row = candidate(canonical_recording_id=None, **{missing: None})
    value = evaluate([row], selection_basis=basis)
    assert value.track_ids == ()
    assert value.diagnostics == ((1, "missing_canonical_recording"), (1, "missing_group_identity"))
    assert value.group_counts == ()


@pytest.mark.parametrize("method", ["most_listened", "random"])
def test_provider_or_local_identity_cannot_rescue_unresolved_canonical_recording(method):
    row = candidate(canonical_recording_id=None)
    value = sample.evaluate_sample_playlist([row], options(selection_method=method),
        random_order=() if method == "random" else None)
    assert value.track_ids == ()
    assert value.diagnostics == ((1, "missing_canonical_recording"),)
    assert value.group_counts == (("album:a", 0),)


@pytest.mark.parametrize("basis,missing", [("per_album", "primary_artist_ref"), ("per_artist", "album_ref")])
def test_unused_group_identity_can_be_unknown_without_excluding_selected_group(basis, missing):
    value = evaluate([candidate(**{missing: None})], selection_basis=basis)
    assert value.track_ids == (1,)
    assert value.diagnostics == ()


def test_short_groups_are_not_padded_or_filled_by_borrowing_other_group_quota():
    rows = [candidate(1, album_ref="album:short", count=1)] + [candidate(i, album_ref="album:long", count=100-i) for i in range(2, 7)]
    value = evaluate(rows, songs_per_group=3)
    assert value.track_ids == (2, 3, 4, 1)
    assert value.group_counts == (("album:short", 1), ("album:long", 3))
    assert value.diagnostics == ((5, "quota_exceeded"), (6, "quota_exceeded"))


# G7: preserve real cached-popularity reasons, including provider conflicts.
@pytest.mark.parametrize("change,reason", [
    ("absent_cache", "missing_global_metric"), ("missing_count", "missing_global_metric"),
    ("ambiguous", "ambiguous_attribution"), ("cache_local", "mapping_mismatch"),
    ("cache_revision", "mapping_mismatch"), ("cache_source", "mapping_mismatch"),
    ("cache_provider", "mapping_mismatch"),
])
def test_actual_selector_rejection_reasons_are_retained(change, reason):
    row = candidate()
    if change == "absent_cache": row = replace(row, popularity=None)
    elif change == "missing_count": row = changed_observation(row, count=None, attribution_state="missing")
    elif change == "ambiguous": row = changed_observation(row, count=900, attribution_state="ambiguous")
    elif change == "cache_local": row = replace(row, popularity=replace(row.popularity, local_track_id=99))
    elif change == "cache_revision": row = replace(row, popularity=replace(row.popularity, mapping_revision="stale"))
    elif change == "cache_source": row = changed_observation(row, source_entity_id="lastfm:other")
    else: row = replace(row, popularity_track=replace(row.popularity_track, provider="other-provider"))
    value = evaluate([row])
    assert value.track_ids == ()
    assert value.diagnostics == ((1, reason),)
    assert value.group_counts == (("album:a", 0),)


def test_missing_provider_mapping_is_not_a_fake_zero_or_fallback_for_most_listened():
    value = evaluate([candidate(popularity_track=None, popularity=None)])
    assert value.track_ids == ()
    assert value.diagnostics == ((1, "missing_provider_mapping"),)


@pytest.mark.parametrize("change", ["local_id", "recording_id", "missing_recording", "recording_evidence", "raw_mapping"])
def test_present_mapping_must_bind_exact_local_and_canonical_identity(change):
    row = candidate()
    mapping = row.popularity_track
    if change == "local_id": mapping = replace(mapping, track_id=2)
    elif change == "recording_id": mapping = replace(mapping, canonical_recording_id="recording:other")
    elif change == "missing_recording": mapping = replace(mapping, canonical_recording_id=None, recording_evidence=None)
    elif change == "recording_evidence": mapping = replace(mapping, recording_evidence=None)
    else: mapping = {"track_id": 1, "canonical_recording_id": "recording:1"}
    with pytest.raises(ValueError):
        evaluate([replace(row, popularity_track=mapping)])


@pytest.mark.parametrize("change", ["raw_cache", "personal_metric", "boolean_count", "overflow_count", "naive_time", "missing_with_zero"])
def test_malformed_popularity_facts_propagate_actual_validator_failure(change):
    row = candidate()
    if change == "raw_cache": row = replace(row, popularity={"count": 99})
    elif change == "personal_metric": row = changed_observation(row, metric="personal_plays")
    elif change == "boolean_count": row = changed_observation(row, count=True)
    elif change == "overflow_count": row = changed_observation(row, count=2**53)
    elif change == "naive_time": row = changed_observation(row, observed_at=NOW.replace(tzinfo=None))
    else: row = changed_observation(row, count=0, attribution_state="missing")
    with pytest.raises(ValueError):
        evaluate([row])


def test_later_usable_copy_may_represent_recording_when_earlier_copy_lacks_metric():
    first = candidate(1, popularity=None)
    second = candidate(2, canonical_recording_id=first.canonical_recording_id)
    value = evaluate([first, second])
    assert value.track_ids == (2,)
    assert value.diagnostics == ((1, "missing_global_metric"),)


@pytest.mark.parametrize("conflict", ["recording", "artist"])
def test_real_provider_conflicts_are_ambiguous_not_canonical_duplicates(conflict):
    first = candidate(1)
    second = candidate(2, canonical_recording_id="recording:other" if conflict == "recording" else first.canonical_recording_id)
    second = replace(second, popularity_track=replace(second.popularity_track,
        source_entity_id=first.popularity_track.source_entity_id,
        canonical_artist_id="artist:other" if conflict == "artist" else first.popularity_track.canonical_artist_id))
    second = changed_observation(second, source_entity_id=first.popularity_track.source_entity_id)
    value = evaluate([first, second], songs_per_group=2)
    assert value.track_ids == ()
    assert value.diagnostics == ((1, "ambiguous_attribution"), (2, "ambiguous_attribution"))


# G8: Random does not read, validate or compare ignored popularity fields.
@pytest.mark.parametrize("bad", [None, {"malformed": []}, object(), "unavailable"])
def test_random_resolved_track_needs_no_provider_mapping_or_usable_cache(bad, monkeypatch):
    row = candidate(popularity_track=bad, popularity=bad)
    prohibit_popularity_reads(monkeypatch, {1})
    value = random_select([row], (1,))
    assert value.track_ids == (1,)
    assert value.diagnostics == ()
    assert value.random_order == (1,)


class NeverCompare:
    def __eq__(self, other):
        raise AssertionError("Ignored popularity equality was evaluated")

    def __bool__(self):
        raise AssertionError("Ignored popularity truthiness was evaluated")


def test_random_duplicate_local_rows_compare_only_non_popularity_facts(monkeypatch):
    first = candidate(popularity_track=NeverCompare(), popularity=NeverCompare())
    repeated = replace(first, popularity_track=NeverCompare(), popularity=NeverCompare())
    prohibit_popularity_reads(monkeypatch, {1})
    value = random_select([first, repeated, first], (1,))
    assert value.track_ids == (1,)
    assert value.diagnostics == ()
    assert value.group_counts == (("album:a", 1),)


def test_filtered_most_listened_duplicate_rows_also_do_not_access_or_compare_ignored_cache(monkeypatch):
    first = candidate(duration_seconds=240, popularity_track=NeverCompare(), popularity=NeverCompare())
    repeated = replace(first, popularity_track=NeverCompare(), popularity=NeverCompare())
    prohibit_popularity_reads(monkeypatch, {1})
    value = evaluate([first, repeated], length="up_to_3")
    assert value.track_ids == ()
    assert value.diagnostics == ((1, "length_filtered"),)
    assert value.group_counts == (("album:a", 0),)


def test_random_dedupes_before_permutation_and_quota_even_if_duplicate_belongs_to_other_group(monkeypatch):
    first = candidate(1, popularity_track=None, popularity=None)
    duplicate = candidate(2, canonical_recording_id=first.canonical_recording_id, album_ref="album:other",
                          popularity_track=NeverCompare(), popularity=NeverCompare())
    third = candidate(3, popularity_track={}, popularity={})
    prohibit_popularity_reads(monkeypatch, {1, 2, 3})
    value = random_select([third, duplicate, first], (3, 1))
    assert value.track_ids == (3,)
    assert value.random_order == (3, 1)
    assert value.diagnostics == ((1, "quota_exceeded"), (2, "duplicate_canonical_recording"))
    assert value.group_counts == (("album:a", 1), ("album:other", 0))


# G9: exact caller permutation, deterministic replay and no PRNG.
@pytest.mark.parametrize("order", [None, (), (1,), (1, 1), (1, 2, 3), (2, 3), (True, 2), (1.0, 2),
                                    ("1", 2), [1, 2], {1, 2}, {1: 1, 2: 2}])
def test_random_order_is_a_strict_complete_immutable_permutation(order):
    with pytest.raises(ValueError):
        random_select([candidate(1), candidate(2)], order)


def test_random_order_cannot_include_later_canonical_copy_in_place_of_first():
    first = candidate(1)
    later = candidate(2, canonical_recording_id=first.canonical_recording_id)
    with pytest.raises(ValueError):
        random_select([later, first], (2,))


@pytest.mark.parametrize("order", [None, (1,), [ ]])
def test_empty_random_input_still_requires_exact_empty_tuple(order):
    with pytest.raises(ValueError):
        random_select([], order)


def test_empty_random_input_returns_empty_permutation_and_visible_zero_filtered_group():
    value = random_select([candidate(duration_seconds=240)], (), length="up_to_3")
    assert value.track_ids == ()
    assert value.random_order == ()
    assert value.diagnostics == ((1, "length_filtered"),)
    assert value.group_counts == (("album:a", 0),)
    assert random_select([], ()).group_counts == ()


@pytest.mark.parametrize("order", [(), (1,), [1], False])
def test_most_listened_rejects_any_supplied_random_order(order):
    with pytest.raises(ValueError):
        sample.evaluate_sample_playlist([candidate()], options(), random_order=order)


def test_random_replay_is_exact_without_random_or_secrets_calls(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Pure evaluator attempted to generate randomness")
    for name in ["random", "seed", "shuffle", "sample", "choice", "choices", "randrange", "randint", "Random", "SystemRandom"]:
        monkeypatch.setattr(random, name, forbidden)
    for name in ["choice", "randbelow", "token_bytes", "token_hex", "token_urlsafe", "SystemRandom"]:
        monkeypatch.setattr(secrets, name, forbidden)
    rows = tuple(candidate(i, popularity_track=None, popularity=None) for i in range(1, 5))
    order = (3, 1, 4, 2)
    first = random_select(rows, order, songs_per_group=2)
    second = random_select(iter(rows), order, songs_per_group=2)
    assert first == second
    assert first.track_ids == (3, 1)
    assert first.random_order == order
    assert first.diagnostics == ((2, "quota_exceeded"), (4, "quota_exceeded"))


def test_changed_candidate_membership_or_canonical_representative_invalidates_old_random_permutation():
    first, second = candidate(1), candidate(2)
    assert random_select([first, second], (2, 1), songs_per_group=2).track_ids == (2, 1)
    for changed in ([first], [first, second, candidate(3)],
                    [replace(first, duration_seconds=240), replace(second, canonical_recording_id=first.canonical_recording_id)]):
        with pytest.raises(ValueError):
            random_select(changed, (2, 1), length="up_to_3")


# G10: strict public values, local duplicates and once-captured immutable input.
@pytest.mark.parametrize("missing", ["selection_basis", "songs_per_group", "unknown_facets"])
def test_quota_basis_and_unknown_policy_are_required_without_ui_defaults(missing):
    values = dict(selection_basis="per_album", songs_per_group=1, unknown_facets="exclude")
    del values[missing]
    with pytest.raises(TypeError):
        sample.SampleOptions(**values)


@pytest.mark.parametrize("change", [
    {"selection_basis": "album"}, {"selection_basis": None}, {"selection_basis": True},
    {"songs_per_group": 0}, {"songs_per_group": -1}, {"songs_per_group": True}, {"songs_per_group": False},
    {"songs_per_group": 1.0}, {"songs_per_group": "2"}, {"songs_per_group": None},
    {"unknown_facets": "default"}, {"unknown_facets": None}, {"unknown_facets": False},
    {"selection_method": "popular"}, {"selection_method": None}, {"selection_method": False},
    {"length": "up_to_15"}, {"length": "over_15"}, {"length": ""}, {"length": 3},
    {"styles": frozenset()}, {"styles": {"style:prog"}}, {"styles": ["style:prog"]},
    {"styles": "style:prog"}, {"styles": frozenset({" "})}, {"styles": frozenset({1})},
    {"countries": frozenset()}, {"countries": {"country:GB"}}, {"countries": ["country:GB"]},
    {"countries": "country:GB"}, {"countries": frozenset({""})}, {"countries": frozenset({None})},
])
def test_invalid_options_fail_closed_without_coercion(change):
    with pytest.raises(ValueError):
        evaluate([], **change)


@pytest.mark.parametrize("change", [
    {"canonical_recording_id": ""}, {"canonical_recording_id": " "}, {"canonical_recording_id": 1},
    {"canonical_recording_id": True}, {"recording_evidence": None}, {"recording_evidence": " "},
    {"recording_evidence": 1}, {"canonical_recording_id": None, "recording_evidence": "orphan evidence"},
    {"album_ref": ""}, {"album_ref": " "}, {"album_ref": 1}, {"album_ref": True},
    {"primary_artist_ref": ""}, {"primary_artist_ref": " "}, {"primary_artist_ref": 1}, {"primary_artist_ref": False},
    {"styles": {"style:prog"}}, {"styles": ["style:prog"]}, {"styles": "style:prog"},
    {"styles": frozenset({""})}, {"styles": frozenset({None})},
    {"countries": {"country:GB"}}, {"countries": ["country:GB"]}, {"countries": "country:GB"},
    {"countries": frozenset({" "})}, {"countries": frozenset({2})},
])
def test_invalid_candidate_identity_evidence_or_mutable_facets_fail_closed(change):
    with pytest.raises(ValueError):
        random_select([candidate(**change)], (1,))


@pytest.mark.parametrize("bad", [None, {}, {"selection_basis": "per_album"}, "most_listened", True])
def test_raw_options_are_not_a_second_unvalidated_protocol(bad):
    with pytest.raises(ValueError):
        sample.evaluate_sample_playlist([], bad)


@pytest.mark.parametrize("bad", [None, {}, {"track_id": 1}, "track", True])
def test_raw_candidate_is_not_an_admitted_domain_fact(bad):
    with pytest.raises(ValueError):
        evaluate([bad])


@pytest.mark.parametrize("bad", [None, 1, True])
def test_noniterable_candidate_input_fails_closed(bad):
    with pytest.raises(ValueError):
        evaluate(bad)


@pytest.mark.parametrize("change", [
    {"canonical_recording_id": "recording:other"}, {"recording_evidence": "resolved:other"},
    {"album_ref": "album:other"}, {"primary_artist_ref": "artist:other"}, {"source_position": 99},
    {"disc_number": 2}, {"track_number": 2}, {"duration_seconds": 240},
    {"styles": frozenset({"style:other"})}, {"countries": frozenset({"country:US"})},
])
def test_random_rejects_conflicting_duplicate_local_facts_without_reading_popularity(change, monkeypatch):
    first = candidate(popularity_track=NeverCompare(), popularity=NeverCompare())
    repeated = replace(first, **change)
    prohibit_popularity_reads(monkeypatch, {1})
    with pytest.raises(ValueError):
        random_select([first, repeated], (1,))


@pytest.mark.parametrize("change", ["mapping", "cache"])
def test_eligible_most_listened_duplicate_local_id_requires_equal_mapping_and_cache_facts(change):
    first = candidate()
    repeated = replace(first, popularity_track=replace(first.popularity_track, mapping_revision="changed")) if change == "mapping" \
        else changed_observation(first, count=999)
    with pytest.raises(ValueError):
        evaluate([first, repeated])


@pytest.mark.parametrize("method", ["most_listened", "random"])
def test_exact_repeated_local_facts_collapse_once_without_duplicate_canonical_diagnostic(method):
    row = candidate()
    value = sample.evaluate_sample_playlist([row, replace(row), row], options(selection_method=method),
        random_order=(1,) if method == "random" else None)
    assert value.track_ids == (1,)
    assert value.diagnostics == ()
    assert value.group_counts == (("album:a", 1),)


@pytest.mark.parametrize("method", ["most_listened", "random"])
def test_candidate_generator_is_captured_once_and_original_facts_are_unchanged(method):
    rows = (candidate(2, count=30), candidate(1, count=10))
    before = tuple(tuple(getattr(row, field.name) for field in fields(row)) for row in rows)
    class Once:
        iterations = 0
        def __iter__(self):
            self.iterations += 1
            assert self.iterations == 1, "original source iterable was consumed more than once"
            yield from rows
    captured = Once()
    value = sample.evaluate_sample_playlist(captured, options(selection_method=method, songs_per_group=2),
        random_order=(2, 1) if method == "random" else None)
    assert captured.iterations == 1
    assert value.track_ids == (2, 1)
    assert tuple(tuple(getattr(row, field.name) for field in fields(row)) for row in rows) == before


# G11: two actual full-input selector calls, never representative-only replay.
def test_two_real_full_input_selector_passes_preserve_provider_conflicts_and_duplicate_vs_quota(monkeypatch):
    first = candidate(1, source_position=1, count=10)
    duplicate = candidate(2, source_position=2, count=999, canonical_recording_id=first.canonical_recording_id, album_ref="album:b")
    winner = candidate(3, source_position=0, count=20)
    conflict_a = candidate(4, source_position=3, count=50, album_ref="album:conflict")
    conflict_b = candidate(5, source_position=4, count=60, album_ref="album:conflict")
    conflict_b = replace(conflict_b, popularity_track=replace(conflict_b.popularity_track,
        source_entity_id=conflict_a.popularity_track.source_entity_id))
    conflict_b = changed_observation(conflict_b, source_entity_id=conflict_a.popularity_track.source_entity_id)
    rows = [conflict_b, duplicate, first, conflict_a, winner]
    calls = selector_spy(monkeypatch)
    value = evaluate(rows)
    assert len(calls) == 2
    expected = tuple(row.popularity_track for row in [winner, first, duplicate, conflict_a, conflict_b])
    original_by_id = {row.track_id: row for row in expected}
    assert calls[0][0] == calls[1][0]
    assert all(left is right for left, right in zip(calls[0][0], calls[1][0]))
    for captured, kwargs, _ in calls:
        assert len(captured) == 5 and {row.track_id for row in captured} == set(original_by_id)
        assert all(row is original_by_id[row.track_id] for row in captured)
        assert kwargs["limit"] == 5
        assert kwargs.get("offset", 0) == 0
        assert kwargs.get("max_per_artist") is None
        assert callable(kwargs["group_identity"])
        assert callable(kwargs["tie_breaker"])
        assert {row.track_id: kwargs["group_identity"](row) for row in captured} == {1: "album:a", 2: "album:b", 3: "album:a", 4: "album:conflict", 5: "album:conflict"}
        assert {row.track_id: kwargs["tie_breaker"](row) for row in captured} == {track: (n, False, 1, False, 1, track) for n, track in [(0, 3), (1, 1), (2, 2), (3, 4), (4, 5)]}
        assert all(kwargs["is_local_readable"](row) and kwargs["matches_filter"](row) for row in captured)
    assert calls[0][1]["max_per_group"] == 5
    assert calls[1][1]["max_per_group"] == 1
    assert tuple(row.track_id for row in calls[0][2].tracks) == (3, 1)
    assert tuple(row.track_id for row in calls[1][2].tracks) == (3,)
    assert calls[0][2].diagnostics == calls[1][2].diagnostics == ((4, "ambiguous_attribution"), (5, "ambiguous_attribution"))
    assert value.track_ids == (3,)
    assert value.diagnostics == ((1, "quota_exceeded"), (2, "duplicate_canonical_recording"),
                                (4, "ambiguous_attribution"), (5, "ambiguous_attribution"))
    assert value.group_counts == (("album:a", 1), ("album:b", 0), ("album:conflict", 0))


def test_selector_full_limit_counts_unique_mapped_eligible_rows_and_both_calls_receive_them(monkeypatch):
    one, two = candidate(1), candidate(2)
    missing = candidate(3, popularity_track=None)
    filtered = candidate(4, duration_seconds=240)
    calls = selector_spy(monkeypatch)
    value = evaluate([filtered, missing, two, one, replace(one)], songs_per_group=9, length="up_to_3")
    assert len(calls) == 2
    assert calls[0][0] == calls[1][0]
    assert all(len(rows) == 2 and {row.track_id for row in rows} == {1, 2} for rows, _, _ in calls)
    assert [kwargs["limit"] for _, kwargs, _ in calls] == [2, 2]
    assert [kwargs["max_per_group"] for _, kwargs, _ in calls] == [2, 9]
    assert value.track_ids == (1, 2)
    assert value.diagnostics == ((3, "missing_provider_mapping"), (4, "length_filtered"))


@pytest.mark.parametrize("rows", [(), ("missing_mapping",)])
def test_empty_mapped_most_listened_still_delegates_twice_with_nonzero_full_limit(rows, monkeypatch):
    values = [] if not rows else [candidate(popularity_track=None)]
    calls = selector_spy(monkeypatch)
    value = evaluate(values, songs_per_group=7)
    assert len(calls) == 2
    assert all(captured == () and kwargs["limit"] == 1 and callable(kwargs["group_identity"]) for captured, kwargs, _ in calls)
    assert [kwargs["max_per_group"] for _, kwargs, _ in calls] == [1, 7]
    assert value.track_ids == ()
    assert value.diagnostics == (((1, "missing_provider_mapping"),) if rows else ())


def test_random_does_not_invoke_most_listened_selector(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Random reached popularity selector")
    monkeypatch.setattr(sample, "select_local_popular_tracks", forbidden)
    assert random_select([candidate(popularity_track=None, popularity=None)], (1,)).track_ids == (1,)


# G12: bounded identities, ordered diagnostics/groups and immutable ID-only output.
@pytest.mark.parametrize("field,value", [
    ("track_id", 0), ("track_id", -1), ("track_id", 2**63), ("track_id", True), ("track_id", 1.0), ("track_id", "1"),
    ("source_position", -1), ("source_position", 2**63), ("source_position", True), ("source_position", 0.0), ("source_position", None),
    ("disc_number", 0), ("disc_number", -1), ("disc_number", 2**31), ("disc_number", False), ("disc_number", 1.0), ("disc_number", "1"),
    ("track_number", 0), ("track_number", -1), ("track_number", 2**31), ("track_number", True), ("track_number", 1.0), ("track_number", "1"),
])
def test_track_and_position_bounds_reject_booleans_coercion_and_overflow(field, value):
    with pytest.raises(ValueError):
        random_select([candidate(**{field: value})], (1,))


def test_maximum_track_source_and_disc_track_positions_are_valid_without_overflow():
    maximum = 2**63 - 1
    row = candidate(maximum, source_position=maximum, disc_number=2**31 - 1, track_number=2**31 - 1)
    value = evaluate([row])
    assert value.track_ids == (maximum,)
    assert value.diagnostics == ()
    assert evaluate([candidate(source_position=0, disc_number=None, track_number=None)]).track_ids == (1,)


def test_integer_subclasses_are_not_strict_integer_identities_or_quota():
    class Integer(int):
        pass
    for field in ["track_id", "source_position", "disc_number", "track_number"]:
        with pytest.raises(ValueError):
            evaluate([candidate(**{field: Integer(1)})])
    with pytest.raises(ValueError):
        evaluate([], songs_per_group=Integer(1))
    with pytest.raises(ValueError):
        random_select([candidate()], (Integer(1),))


def test_diagnostics_sort_by_source_then_reason_and_zero_groups_follow_source_not_name_or_input():
    rows = [candidate(20, source_position=4, canonical_recording_id=None, album_ref=None),
            candidate(3, source_position=2, album_ref="album:short", popularity=None),
            candidate(2, source_position=1),
            candidate(50, source_position=0, album_ref="album:z", duration_seconds=660, styles=frozenset(), countries=frozenset())]
    value = evaluate(rows, length="up_to_3", styles=frozenset({"style:prog"}), countries=frozenset({"country:GB"}))
    assert value.track_ids == (2,)
    assert value.diagnostics == ((50, "country_filtered"), (50, "length_filtered"), (50, "style_filtered"),
                                (3, "missing_global_metric"), (20, "missing_canonical_recording"), (20, "missing_group_identity"))
    assert value.group_counts == (("album:z", 0), ("album:a", 1), ("album:short", 0))


def test_public_dataclass_shapes_are_frozen_slotted_and_result_contains_only_scalar_tuples():
    row, config = candidate(), options()
    value = random_select([row], (1,))
    assert [field.name for field in fields(row)] == ["track_id", "canonical_recording_id", "recording_evidence", "album_ref",
        "primary_artist_ref", "source_position", "disc_number", "track_number", "duration_seconds", "styles", "countries",
        "popularity_track", "popularity"]
    assert [field.name for field in fields(config)] == ["selection_basis", "songs_per_group", "unknown_facets", "selection_method", "length", "styles", "countries"]
    assert [field.name for field in fields(value)] == ["track_ids", "diagnostics", "group_counts", "random_order"]
    assert isinstance(value, sample.SampleSelection)
    for instance, field in [(row, "track_id"), (config, "songs_per_group"), (value, "track_ids")]:
        assert not hasattr(instance, "__dict__")
        with pytest.raises(FrozenInstanceError):
            setattr(instance, field, None)
    def scalar_tree(item):
        if type(item) is tuple:
            return all(scalar_tree(child) for child in item)
        return item is None or type(item) in {str, int}
    assert all(scalar_tree(getattr(value, field.name)) for field in fields(value))
    assert type(value.track_ids) is tuple and type(value.diagnostics) is tuple and type(value.group_counts) is tuple
    assert value.random_order == (1,)
    bare = sample.SampleCandidate(1, "recording:1", "resolved", "album:a", "artist:a", 0, None, None, None, None, None)
    assert bare.popularity_track is None and bare.popularity is None
