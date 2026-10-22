"""Strict Artist Loved identity and complete deterministic selection contracts."""
from dataclasses import FrozenInstanceError
from uuid import uuid4

import pytest

from music_app.services.artist_loved_playlists import (
    ARTIST_LOVED_PROTOCOL,
    ArtistLovedRecipe,
    ArtistLovedTooLarge,
    normalize_artist_loved_descriptor,
    normalize_artist_loved_recipe,
    select_artist_loved_track_ids,
)
from music_app.services.owned_playlists import PlaylistError, normalize_playlist_command


def descriptor(**changes):
    return {"version": 1, "root_artist_id": "123", "scope_mode": "artist", **changes}


def recipe(**changes):
    return {**descriptor(), "source": "artist_loved", "auto_update": True,
            "playback_order": "regular", **changes}


@pytest.mark.parametrize("mode", ["artist", "family"])
@pytest.mark.parametrize("order", ["regular", "shuffle", "unplayed_first"])
def test_exact_descriptor_and_always_dynamic_recipe_round_trip(mode, order):
    value = ArtistLovedRecipe(123, mode, order)
    assert value.descriptor() == descriptor(scope_mode=mode)
    assert value.as_dict() == recipe(scope_mode=mode, playback_order=order)
    assert normalize_artist_loved_recipe(value.as_dict()) == value
    assert normalize_artist_loved_descriptor(value.descriptor()) == ArtistLovedRecipe(123, mode)
    assert ARTIST_LOVED_PROTOCOL == "artist_loved_selection_v1"
    with pytest.raises(FrozenInstanceError):
        value.root_artist_id = 456


def test_numeric_identity_round_trip_preserves_bigint_without_float_conversion():
    identity = 2**63 - 1
    value = normalize_artist_loved_descriptor(descriptor(root_artist_id=str(identity)))
    assert value.root_artist_id == identity
    assert value.descriptor()["root_artist_id"] == str(identity)


@pytest.mark.parametrize("bad", [None, True, False, 123, 1.5, "", "0", "00", "0123", "-1",
                                  "+123", " 123", "123 ", "1.0", "1e2", "１２３", "١٢٣",
                                  str(2**63), "9" * 100, [], {}])
def test_descriptor_root_requires_canonical_positive_bigint_text(bad):
    with pytest.raises(ValueError):
        normalize_artist_loved_descriptor(descriptor(root_artist_id=bad))


@pytest.mark.parametrize("bad", [None, True, 1.0, "1", 0, 2, [], {}])
def test_descriptor_version_is_exact_integer_one(bad):
    with pytest.raises(ValueError):
        normalize_artist_loved_descriptor(descriptor(version=bad))


@pytest.mark.parametrize("bad", [None, "", "all", "Artist", "selected_artists", True, [], {}])
def test_scope_mode_does_not_admit_popular_or_implicit_library_scope(bad):
    with pytest.raises(ValueError):
        normalize_artist_loved_descriptor(descriptor(scope_mode=bad))


@pytest.mark.parametrize("field", ["version", "root_artist_id", "scope_mode"])
def test_descriptor_requires_every_field(field):
    value = descriptor()
    del value[field]
    with pytest.raises(ValueError):
        normalize_artist_loved_descriptor(value)


@pytest.mark.parametrize("extra", [
    {"artist_name": "Artist"}, {"artist_ids": ["123", "456"]},
    {"memberships": [{"artist_id": "123", "basis": "primary_credit"}]},
    {"categories": ["main_library"]}, {"album_types": ["studio"]},
    {"album_order": ["9"]}, {"songs_per_group": 10}, {"selection_basis": "per_album"},
    {"playback_order": "shuffle"}, {"account_id": "1"}, {"library_id": "2"},
    {"love_tier": "loved"}, {"source_protocol": "artist_popular_selection_v1"},
])
def test_descriptor_cannot_capture_filter_playback_or_foreign_taste_state(extra):
    with pytest.raises(ValueError):
        normalize_artist_loved_descriptor({**descriptor(), **extra})


@pytest.mark.parametrize("bad", [None, [], "123", True])
def test_descriptor_and_recipe_require_objects(bad):
    with pytest.raises(ValueError):
        normalize_artist_loved_descriptor(bad)
    with pytest.raises(ValueError):
        normalize_artist_loved_recipe(bad)


@pytest.mark.parametrize("field,bad", [
    ("source", "artist_popular"), ("source", "library_mix"), ("source", None),
    ("auto_update", False), ("auto_update", 1), ("auto_update", "true"),
    ("playback_order", "popular_first"), ("playback_order", None),
    ("playback_order", []), ("scope_mode", "library"),
])
def test_recipe_rejects_static_or_reinterpreted_protocol(field, bad):
    with pytest.raises(ValueError):
        normalize_artist_loved_recipe(recipe(**{field: bad}))


@pytest.mark.parametrize("field", ["version", "root_artist_id", "scope_mode", "source",
                                  "auto_update", "playback_order"])
def test_recipe_cannot_default_missing_fields(field):
    value = recipe()
    del value[field]
    with pytest.raises(ValueError):
        normalize_artist_loved_recipe(value)


@pytest.mark.parametrize("extra", [
    {"scope": {"kind": "library"}}, {"categories": []}, {"album_types": []},
    {"family_artist_ids": ["456"]}, {"artist_name": "Replacement Artist"},
    {"songs_per_group": 1}, {"love_tier": "obsessed"},
])
def test_recipe_never_retains_gallery_filters_family_snapshot_or_tier_selector(extra):
    with pytest.raises(ValueError):
        normalize_artist_loved_recipe({**recipe(), **extra})


def test_business_identity_is_owner_library_root_mode_and_ignores_playback_order():
    variants = [ArtistLovedRecipe(123, "family", order)
                for order in ("regular", "shuffle", "unplayed_first")]
    assert {value.business_identity(1, 2) for value in variants} == {(1, 2, 123, "family")}
    assert len({ArtistLovedRecipe(root, mode).business_identity(owner, library)
                for owner in (1, 2) for library in (10, 20)
                for root in (123, 456) for mode in ("artist", "family")}) == 16


@pytest.mark.parametrize("bad", [None, True, 0, -1, 1.0, "1", 2**63])
@pytest.mark.parametrize("field", ["root", "owner", "library"])
def test_internal_identity_rejects_coercion_and_invalid_bigints(field, bad):
    with pytest.raises(ValueError):
        value = ArtistLovedRecipe(bad if field == "root" else 123, "artist")
        value.business_identity(bad if field == "owner" else 1,
                                bad if field == "library" else 2)


def test_selects_loved_and_obsessed_together_in_exact_inventory_order():
    assert select_artist_loved_track_ids(
        [40, 10, 30, 20, 50], {10: "loved", 20: "obsessed", 30: "off", 40: "obsessed"},
    ) == (40, 10, 20)


def test_deduplicates_only_exact_local_track_identity_and_never_sorts_by_tier():
    # These distinct local IDs may describe the same title or recording. The
    # pure owner has no title/recording input with which to collapse them.
    assert select_artist_loved_track_ids(
        [900, 12, 900, 13, 12, 14], {900: "loved", 12: "obsessed", 13: "loved", 14: "off"},
    ) == (900, 12, 13)


def test_missing_off_and_noninventory_loves_do_not_widen_selection():
    assert select_artist_loved_track_ids([2, 1], {1: "off", 3: "loved", 4: "obsessed"}) == ()
    assert select_artist_loved_track_ids([], {1: "loved"}) == ()
    assert select_artist_loved_track_ids([1, 2], {}) == ()


def test_selection_reads_iterables_once_and_does_not_mutate_taste():
    tiers = {3: "loved", 1: "obsessed", 2: "off"}
    before = dict(tiers)
    assert select_artist_loved_track_ids(iter([3, 1, 2, 3]), tiers) == (3, 1)
    assert tiers == before


def test_exact_5000_result_is_complete_even_with_duplicates_and_extra_off_tracks():
    ordered = [*range(5000, 0, -1), 5001, 5002, *range(1, 5001)]
    tiers = {identity: "loved" if identity % 2 else "obsessed" for identity in range(1, 5001)}
    tiers[5001] = "off"
    assert select_artist_loved_track_ids(ordered, tiers) == tuple(range(5000, 0, -1))


def test_5001_distinct_loves_fail_instead_of_returning_partial_membership():
    with pytest.raises(ArtistLovedTooLarge):
        select_artist_loved_track_ids(range(1, 5002), {identity: "loved" for identity in range(1, 5002)})


@pytest.mark.parametrize("bad", [None, True, 0, -1, 1.0, "1", 2**63])
def test_selection_requires_exact_positive_numeric_inventory_identity(bad):
    with pytest.raises(ValueError):
        select_artist_loved_track_ids([bad], {})


@pytest.mark.parametrize("bad", [None, "favorite", "Love", "loved ", True, 1, [], {}])
def test_selection_rejects_unrecognized_canonical_taste(bad):
    with pytest.raises(ValueError):
        select_artist_loved_track_ids([1], {1: bad})


@pytest.mark.parametrize("bad", [None, [], ["loved"], "loved"])
def test_selection_requires_canonical_mapping(bad):
    with pytest.raises(ValueError):
        select_artist_loved_track_ids([1], bad)


@pytest.mark.parametrize("order", ["regular", "shuffle", "unplayed_first"])
def test_complete_backend_admits_loved_create_protocol_and_empty_snapshot(order):
    command = {"request_key": str(uuid4()), "mode": "ordinary", "title": "Artist Loves",
               "source_protocol": ARTIST_LOVED_PROTOCOL, "entry_refs": [],
               "source": {"kind": "library", "ref": str(uuid4()), "revision": str(uuid4())},
               "mix_playback_order": order}
    data = normalize_playlist_command("create", command).data
    assert data["source_protocol"] == ARTIST_LOVED_PROTOCOL
    assert data["entry_refs"] == [] and data["mix_playback_order"] == order
    for changes in ({"source_protocol": "artist_loved_selection_v2"},
                    {"mix_playback_order": "personal_popularity"},
                    {"source": {**command["source"], "kind": "playlist"}},
                    {"mode": "missing"}):
        with pytest.raises(PlaylistError, match="invalid_command"):
            normalize_playlist_command("create", {**command, **changes})
