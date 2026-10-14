"""Pure command/recipe contracts: normal imports, no application construction."""
from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from music_app.services import library_mix_postgres as mixes
from music_app.services.library_mix import normalize_library_mix_recipe, recipe_payload
from music_app.services.owned_playlists import PlaylistError, normalize_playlist_command


def create_body():
    return {"mode": "ordinary", "source_protocol": "library_mix_selection_v1",
            "source": {"kind": "library", "ref": str(uuid4()), "revision": str(uuid4())},
            "title": "Library Mix", "entry_refs": [str(uuid4()), str(uuid4())],
            "request_key": str(uuid4())}


@pytest.mark.parametrize("order", ["regular", "shuffle", "unplayed_first"])
def test_playback_override_is_bound_into_normal_create_digest(order):
    body = create_body()
    original = normalize_playlist_command("create", body)
    ordered = normalize_playlist_command("create", {**body, "mix_playback_order": order})
    assert ordered.data["entry_refs"] == original.data["entry_refs"]
    assert ordered.data["mix_playback_order"] == order
    assert ordered.digest != original.digest
    reversed_command = normalize_playlist_command("create", {**body, "entry_refs": list(reversed(body["entry_refs"]))})
    assert reversed_command.digest != original.digest


@pytest.mark.parametrize("protocol", ["library_selection_v1", "complete_inventory_selection_v1"])
def test_playback_override_is_not_accepted_for_other_library_source_protocols(protocol):
    body = {**create_body(), "source_protocol": protocol, "mix_playback_order": "shuffle"}
    with pytest.raises(PlaylistError, match="invalid_command"):
        normalize_playlist_command("create", body)


@pytest.mark.parametrize("order", [None, "", "popular", 1, True, [], {}])
def test_invalid_playback_override_fails_normal_command_validation(order):
    with pytest.raises(PlaylistError, match="invalid_command"):
        normalize_playlist_command("create", {**create_body(), "mix_playback_order": order})


@pytest.mark.parametrize("field,value", [("owner_account_id", 7), ("library_id", 7),
                                         ("track_ids", [1]), ("query", "Album"),
                                         ("popularity_count", 999999)])
def test_recipe_rejects_browser_supplied_authority_membership_and_ranking(field, value):
    with pytest.raises(PlaylistError, match="invalid_library_mix_recipe"):
        mixes._recipe({"selection_basis": "per_artist", "songs_per_group": 3,
                       "auto_update": True, field: value})


def test_stored_recipe_rejects_silent_version_or_provenance_reinterpretation():
    recipe = normalize_library_mix_recipe({"selection_basis": "per_album", "songs_per_group": 1,
                                          "auto_update": True})
    stored = recipe_payload(recipe)
    assert mixes._stored_recipe(stored) == recipe
    for changed in ({**stored, "version": True}, {**stored, "provider": "personal"},
                    {**stored, "source": "selection"}, {**stored, "extra": "untrusted"}):
        with pytest.raises(PlaylistError, match="source_changed"):
            mixes._stored_recipe(changed)


def test_coverage_examples_and_counts_have_separate_bounds():
    diagnostics = [(index, "missing_provider_mapping") for index in range(1, 102)]
    assert mixes._coverage([], diagnostics) == {
        "selected_count": 0, "excluded_count": 101,
        "reasons": {"missing_provider_mapping": 101}, "diagnostics_truncated": True}


def test_manual_membership_lock_is_recipe_specific():
    payload = recipe_payload(normalize_library_mix_recipe({
        "selection_basis": "per_artist", "songs_per_group": 2, "auto_update": True}))
    stored = {"recipe_version": payload.pop("version"), **payload,
              "last_evaluated_at": datetime.now(timezone.utc), "coverage": {}}
    command = normalize_playlist_command("save", {"title": "Only metadata", "revision": "1",
        "request_key": str(uuid4())}, playlist_ref=str(uuid4()))
    mixes.require_manual_membership(command, {"library_mix": stored})
    order = replace(command, data={**command.data, "item_order": []})
    with pytest.raises(PlaylistError, match="library_mix_membership_locked"):
        mixes.require_manual_membership(order, {"library_mix": stored})
    mixes.require_manual_membership(order, {"library_mix": {**stored, "auto_update": False}})
    mixes.require_manual_membership(order, {})


def test_disabled_popularity_refresh_does_not_import_provider_or_runtime_modules():
    import sys
    before = set(sys.modules)
    result = mixes._request_popularity_refresh(SimpleNamespace(_config={}), 73, "idle")
    assert result == {"popularity_refresh_status": "idle", "popularity_refresh_error": "not_configured"}
    assert not ({"config", "music_app.services.state", "music_app.services.lastfm",
                 "music_app.services.library_popularity_refresh", "music_app.services.persistence_selection"}
                & (set(sys.modules) - before))
