"""Additive Album receipt units; no database or endpoint substitution in E2E."""
from copy import deepcopy

import pytest

from music_app.services import album_details, track_preferences
from music_app.services.library import strip_private_album_preference_overlays

PATH = "/synthetic/album-receipt/one.flac"
CANONICAL = "track:album-receipt-one"


def selected(*, track_id=11, active=True, tier="off", rating=None):
    return {"track_id": track_id, "track_key": CANONICAL, "track_ref": PATH,
            "is_active_path": active, "rating": rating, "love_tier": tier}


def album():
    return {"key": "receipt-album", "name": "Album", "album_artist": "Artist",
            "tracks": [{"track_id": 11, "path": PATH, "title": "One", "duration_seconds": 180}]}


@pytest.fixture
def store(monkeypatch):
    state = {"selected": {PATH: selected()}, "calls": []}
    class Store:
        def __init__(self, config):
            pass
        def load_track_preferences(self, refs, *, account_id, library_id):
            state["calls"].append((list(refs), account_id, library_id))
            return deepcopy(state["selected"])
    monkeypatch.setattr(track_preferences, "PostgresTrackPreferencesStore", Store)
    monkeypatch.setattr(track_preferences, "_require_postgres_track_preferences_selection", lambda config: None)
    monkeypatch.setattr(album_details, "_safe_scrobble_count_lookup", lambda *args, **kwargs: {})
    return state


def attach(data=None, **scope):
    return album_details._attach_album_detail_track_rows(
        data or album(), config={},
        **{"account_id": 7, "library_id": 9, "inventory_library_id": 9,
           "preference_action_resolver": lambda identity: True, **scope})


def rows(result):
    return [result["tracks"][0], result["track_rows"][0], result["gallery_list_block"]["track_rows"][0]]


def test_guarded_missing_taste_is_available_off_and_keeps_exact_canonical_identity(store):
    source = album()
    before = deepcopy(source)
    result = attach(source)
    assert source == before, "private reads must not mutate shared album caches"
    assert store["calls"] == [([PATH], 7, 9)]
    for row in rows(result):
        assert row["track_preference_state"] == "available"
        assert row["canonical_track_ref"] == CANONICAL
        assert row["inventory_track_ref"] == "inventory-track:9:11"
        assert row["track_preference"]["love_tier"] == "off"
        assert row["track_preference"]["rating"] is None
        assert row["track_preference"]["allowed_actions"]["can_set_love_tier"] is True


@pytest.mark.parametrize("selection", [{}, {PATH: selected(active=False)}, {PATH: selected(track_id=12)}])
def test_missing_conflicted_or_inactive_selection_never_becomes_known_off(store, selection):
    store["selected"] = selection
    for row in rows(attach()):
        assert row["track_preference_state"] == "unavailable"
        assert row.get("canonical_track_ref") is None
        assert row["track_preference"]["allowed_actions"]["can_set_love_tier"] is False


@pytest.mark.parametrize("tier,rating", [("off", None), ("loved", 4), ("obsessed", None)])
def test_successful_read_only_receipt_is_available_independently_of_write_permission(store, tier, rating):
    store["selected"] = {PATH: selected(tier=tier, rating=rating)}
    resolved = []
    def deny(identity):
        resolved.append(identity)
        return False
    for row in rows(attach(preference_action_resolver=deny)):
        assert row["track_preference_state"] == "available"
        assert row["canonical_track_ref"] == CANONICAL
        assert row["track_preference"]["love_tier"] == tier
        assert row["track_preference"]["rating"] == rating
        assert row["can_edit_preferences"] is False
        assert row["track_preference"]["allowed_actions"]["can_set_love_tier"] is False
    assert resolved == [11]


@pytest.mark.parametrize("scope", [{"account_id": None}, {"account_id": True}, {"library_id": None},
                                    {"inventory_library_id": None}, {"inventory_library_id": 10}, {"public_safe": True}])
def test_unscoped_or_public_album_never_obtains_a_private_receipt(store, scope):
    for row in rows(attach(**scope)):
        assert row.get("track_preference_state") != "available"
        assert row.get("canonical_track_ref") is None
    assert store["calls"] == []


def test_duplicate_sources_share_one_guarded_read_and_conflicting_ids_deny_all_aliases(store):
    source = album()
    source["duplicate_sources"] = [deepcopy(source)]
    result = attach(source)
    assert store["calls"] == [([PATH], 7, 9)]
    assert result["tracks"][0]["track_preference_state"] == "available"
    assert result["duplicate_sources"][0]["tracks"][0]["canonical_track_ref"] == CANONICAL
    source["duplicate_sources"][0]["tracks"][0]["track_id"] = 12
    result = attach(source)
    for row in [*rows(result), result["duplicate_sources"][0]["tracks"][0]]:
        assert row["track_preference_state"] == "unavailable"
        assert row.get("canonical_track_ref") is None


def test_actor_scopes_and_canonical_receipts_are_never_reused_from_shared_input(store):
    source = album()
    first = attach(source)
    store["selected"] = {PATH: selected(tier="obsessed", rating=5)}
    second = attach(source, account_id=8)
    assert store["calls"] == [([PATH], 7, 9), ([PATH], 8, 9)]
    assert first["tracks"][0]["track_preference"]["love_tier"] == "off"
    assert second["tracks"][0]["track_preference"]["love_tier"] == "obsessed"
    assert "track_preference_state" not in source["tracks"][0]


def test_public_stripping_removes_existing_private_receipts_in_every_nested_representation(store):
    source = attach()
    source["duplicate_sources"] = [deepcopy(source)]
    before = deepcopy(source)
    result = strip_private_album_preference_overlays(source)
    assert source == before
    def inspect(value):
        if isinstance(value, dict):
            assert value.get("canonical_track_ref") is None
            assert value.get("track_preference_state") != "available"
            for child in value.values():
                inspect(child)
        elif isinstance(value, list):
            for child in value:
                inspect(child)
    inspect(result)


def test_legacy_overlay_lookup_keeps_its_original_value_shape(store):
    result = track_preferences.build_track_preference_overlay_lookup(
        {}, account_id=7, library_id=9, track_refs=[PATH], preference_action_resolver=lambda _: True)
    assert set(result[PATH]) == {"rating", "love_tier", "allowed_actions"}
    assert result[PATH]["love_tier"] == "off"


def test_receipt_output_map_comes_from_the_same_exact_guarded_store_selection(store):
    receipts = {}
    result = track_preferences.build_track_preference_overlay_lookup(
        {}, account_id=7, library_id=9, track_refs=[PATH],
        expected_track_ids={PATH: 11}, require_active_paths=True,
        preference_action_resolver=lambda _: False, read_receipts=receipts)
    assert store["calls"] == [([PATH], 7, 9)]
    assert receipts == {PATH: {
        "track_preference": result[PATH], "canonical_track_ref": CANONICAL,
        "inventory_track_ref": "inventory-track:9:11"}}
    assert set(result[PATH]) == {"rating", "love_tier", "allowed_actions"}


@pytest.mark.parametrize("selection,expected", [({}, 11), ({PATH: selected(active=False)}, 11),
                                               ({PATH: selected()}, 12), ({PATH: selected()}, True)])
def test_receipt_output_map_does_not_bless_filtered_or_unresolved_selection(store, selection, expected):
    store["selected"] = selection
    receipts = {}
    result = track_preferences.build_track_preference_overlay_lookup(
        {}, account_id=7, library_id=9, track_refs=[PATH],
        expected_track_ids={PATH: expected}, require_active_paths=True,
        preference_action_resolver=lambda _: True, read_receipts=receipts)
    assert result == {}
    assert receipts == {}
