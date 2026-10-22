"""Additive semantic tests; historical duration/scalar tests remain unchanged."""
from dataclasses import replace
import pytest
from test_sample_playlist import candidate, evaluate, options, random_select


@pytest.mark.parametrize("policy", ["include", "exclude"])
@pytest.mark.parametrize("facet,token,reason", [
    ("styles", "genre-tag:Rock", "unknown_style"),
    ("countries", "musicbrainz-country:GB", "unknown_country")])
def test_active_missing_metadata_is_excluded_independently_of_duration_policy(policy, facet, token, reason):
    row = candidate(**{facet: None})
    value = evaluate([row], unknown_facets=policy, **{facet: frozenset({token})})
    assert value.track_ids == () and value.diagnostics == ((1, reason),)
    assert evaluate([row], unknown_facets=policy).track_ids == (1,)


@pytest.mark.parametrize("policy", ["include", "exclude"])
def test_only_corresponding_active_facet_excludes_missing_values(policy):
    style = candidate(styles=frozenset({"genre-tag:Rock"}), countries=None)
    country = candidate(styles=None, countries=frozenset({"musicbrainz-country:GB"}))
    assert evaluate([style], unknown_facets=policy, styles=style.styles).track_ids == (1,)
    assert evaluate([country], unknown_facets=policy, countries=country.countries).track_ids == (1,)
    for row in (style, country):
        assert evaluate([row], unknown_facets=policy, styles=frozenset({"genre-tag:Rock"}),
            countries=frozenset({"musicbrainz-country:GB"})).track_ids == ()


def test_exact_union_or_and_filtering_precedes_canonical_dedupe_and_quota():
    rows = [candidate(1, canonical_recording_id="recording:shared", styles=None),
        candidate(2, canonical_recording_id="recording:shared", styles=frozenset({"genre-tag:Jazz", "genre-tag:Rock"}),
            countries=frozenset({"musicbrainz-country:GB"})),
        candidate(3, styles=frozenset({"genre-tag:Rock"}), countries=frozenset({"musicbrainz-country:US"}))]
    value = evaluate(rows, songs_per_group=2, unknown_facets="include",
        styles=frozenset({"genre-tag:Rock", "genre-tag:Metal"}), countries=frozenset({"musicbrainz-country:GB"}))
    assert value.track_ids == (2,)
    assert value.diagnostics == ((1, "country_filtered"), (1, "unknown_style"), (3, "country_filtered"))


@pytest.mark.parametrize("basis", ["per_album", "per_artist"])
@pytest.mark.parametrize("quota", [1, 2, 5001, 10**8])
def test_explicit_quota_has_no_facet_resource_limit(basis, quota):
    rows = [candidate(i, styles=frozenset({"genre-tag:Rock"})) for i in range(1, 5)]
    result = evaluate(rows, selection_basis=basis, songs_per_group=quota, styles=frozenset({"genre-tag:Rock"}))
    assert len(result.track_ids) == min(quota, 4)


@pytest.mark.parametrize("policy,expected", [("include", (1,)), ("exclude", ())])
def test_duration_unknown_policy_is_not_repurposed_to_implement_facet_exclusion(policy, expected):
    assert evaluate([candidate(duration_seconds=None)], length="up_to_3",
        unknown_facets=policy).track_ids == expected
