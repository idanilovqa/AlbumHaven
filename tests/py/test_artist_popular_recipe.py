"""Additive scoped recipe tests; whole-library v1 remains a separate parser."""
from copy import deepcopy

import pytest

from music_app.services.library_mix import (
    normalize_library_mix_recipe, recipe_payload, normalize_artist_mix_scope,
    artist_recipe_payload,
)


def scope():
    return {"kind": "selected_artists", "artist_ids": ["8", "7"],
            "memberships": [{"artist_id": "8", "basis": "family_credit"},
                            {"artist_id": "7", "basis": "primary_credit"}],
            "album_order": ["20", "10"], "categories": ["main_library", "new_arrivals", "hoard"],
            "album_types": ["studio", "ep"]}


def options():
    return {"selection_basis": "per_artist", "songs_per_group": 3,
            "auto_update": False, "playback_order": "regular"}


def test_scope_canonicalizes_ids_but_never_reorders_albums():
    result = normalize_artist_mix_scope(scope())
    assert result.memberships == ((7, "primary_credit"), (8, "family_credit"))
    assert result.album_order == (20, 10)
    assert result.as_dict()["artist_ids"] == ["7", "8"]


def test_scoped_payload_cannot_be_confused_with_legacy_whole_library():
    recipe = normalize_library_mix_recipe(options())
    old = recipe_payload(recipe)
    assert old == {"version": 1, "source": "whole_library", "provider": "lastfm",
                   "metric": "overall_scrobbles", **options()}
    new = artist_recipe_payload(recipe, normalize_artist_mix_scope(scope()))
    assert new["version"] == 2
    assert new["source"] == "artist_selection"
    assert new["scope"]["memberships"][1] == {"artist_id": "8", "basis": "family_credit"}
    assert recipe_payload(recipe) == old
    with pytest.raises(ValueError):
        normalize_library_mix_recipe({**options(), "scope": scope()})


@pytest.mark.parametrize("bad", [0, True, None, "", "0", "01", "-1", "1.0", "١", "A", "Artist/path", str(2**63)])
def test_identity_is_exact_positive_local_bigint_string(bad):
    value = scope()
    value["artist_ids"][0] = bad
    value["memberships"][0]["artist_id"] = bad
    with pytest.raises(ValueError):
        normalize_artist_mix_scope(value)


@pytest.mark.parametrize("field", ["artist_ids", "memberships", "album_order"])
def test_duplicate_scope_members_are_rejected(field):
    value = scope()
    value[field].append(deepcopy(value[field][0]))
    with pytest.raises(ValueError):
        normalize_artist_mix_scope(value)


def test_empty_artists_never_means_whole_library_but_empty_albums_is_explicit():
    value = scope()
    value["album_order"] = []
    assert normalize_artist_mix_scope(value).album_order == ()
    value["artist_ids"] = value["memberships"] = []
    with pytest.raises(ValueError):
        normalize_artist_mix_scope(value)


def test_membership_operator_cannot_target_another_id():
    value = scope()
    value["memberships"][0]["artist_id"] = "99"
    with pytest.raises(ValueError):
        normalize_artist_mix_scope(value)


def test_unknown_fields_and_operators_fail_closed():
    for extra in ({"artist_name": "A"}, {"family_root": "7"}, {"dynamic_family": True}):
        with pytest.raises(ValueError):
            normalize_artist_mix_scope({**scope(), **extra})
    value = scope()
    value["memberships"][0]["basis"] = "all_credits"
    with pytest.raises(ValueError):
        normalize_artist_mix_scope(value)


def test_fixed_and_dynamic_are_explicit_recipe_options_over_same_scope():
    saved_scope = normalize_artist_mix_scope(scope())
    for dynamic in (False, True):
        result = artist_recipe_payload(normalize_library_mix_recipe({**options(), "auto_update": dynamic}), saved_scope)
        assert result["auto_update"] is dynamic
        assert result["scope"] == saved_scope.as_dict()


@pytest.mark.parametrize("field", ["categories", "album_types"])
@pytest.mark.parametrize("bad", [None, "all", ["unknown"], [True], ["studio", "studio"]])
def test_scope_filter_unknown_or_ambiguous_values_rejected(field, bad):
    value = scope()
    value[field] = bad
    with pytest.raises(ValueError):
        normalize_artist_mix_scope(value)


def test_explicit_empty_filters_stay_empty():
    value = scope()
    value["categories"] = value["album_types"] = []
    parsed = normalize_artist_mix_scope(value)
    assert parsed.categories == parsed.album_types == ()


@pytest.mark.parametrize("album,categories,types,expected", [
    ({"root_provenance": {"primary_category": "main_library", "categories": ["hoard"]}}, ["main_library"], ["studio"], False),
    ({"root_provenance": {"categories": [" HOARD "]}}, ["hoard"], ["studio"], True),
    ({"root_provenance": {"categories": ["unknown"]}}, ["main_library"], ["studio"], True),
    ({"library_root_category": "new_arrivals"}, ["new_arrivals"], ["studio"], True),
    ({"releaseType": "compilations"}, ["main_library"], ["compilation"], True),
    ({"release_type": "live"}, ["main_library"], ["live"], False),
    ({"is_compilation": True}, ["main_library"], ["studio"], False),
])
def test_scoped_filter_uses_gallery_projection_semantics(album, categories, types, expected):
    from music_app.services.library_mix_inventory_postgres import scoped_gallery_album_matches
    value = scope()
    value.update(categories=categories, album_types=types)
    assert scoped_gallery_album_matches(album, normalize_artist_mix_scope(value)) is expected
