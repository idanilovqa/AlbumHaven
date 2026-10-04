"""Response ownership and successful scoped hydration through both builders."""
from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

from tests.py.track_taste_testing import assert_taste_locations, taste, taste_database


def hostile_track(track):
    overlay = {"rating": 5, "love_tier": "obsessed", "allowed_actions": {
        "client_surface_class": "private_web", "can_rate": True, "can_set_love_tier": True}}
    return {"track_id": track["id"], "path": track["paths"][0], "track_ref": track["paths"][0],
            "title": track["title"], "track_number": 1, "disc_number": 1,
            "artist": "Taste Artist", "album_artist": "Taste Artist", "duration_seconds": 60,
            "track_scrobble_count": 7, "track_preference_overlay": deepcopy(overlay),
            "track_preference": deepcopy(overlay), "can_edit_preferences": True}


def cached_payload(taste, primary, duplicate):
    main, extra = hostile_track(primary), hostile_track(duplicate)
    return {"key": taste.album_key, "name": "Taste Album", "album_artist": "Taste Artist",
            "year": 2020, "album_rating": 0, "total_duration_seconds": 60,
            "tracks": [main], "track_rows": [deepcopy(main)],
            "gallery_list_block": {"track_rows": [deepcopy(main)]},
            "duplicate_sources": [{"key": taste.album_key, "name": "Duplicate",
                "album_artist": "Taste Artist", "tracks": [deepcopy(main), extra],
                "track_rows": [deepcopy(main), deepcopy(extra)],
                "gallery_list_block": {"track_rows": [deepcopy(main), deepcopy(extra)]}}]}


@pytest.mark.parametrize("builder", ["runtime", "sql"])
@pytest.mark.parametrize("order", ["A-B", "B-A"])
def test_nested_cached_taste_is_response_owned_and_duplicate_only_tracks_are_scoped(
    taste, monkeypatch, builder, order,
):
    from music_app.services import album_details, library_browse_postgres
    primary, duplicate = taste.add_track("main"), taste.add_track("duplicate-only")
    for account, rating, love in ((taste.a, 1, "loved"), (taste.b, 3, "off")):
        taste.seed_preference(account, primary, rating=rating, love_tier=love)
        taste.seed_preference(account, duplicate, rating=rating, love_tier=love)
    source = cached_payload(taste, primary, duplicate)
    frozen = deepcopy(source)
    # The runtime serializer may return cached private dictionaries; the SQL
    # builder returns a fresh payload on each call. Taste SQL and policy
    # projection still execute for real in both supported builders.
    monkeypatch.setattr(album_details, "album_to_dict", lambda *_args, **_kwargs: source)
    if builder == "sql":
        repository = library_browse_postgres.PostgresLibraryBrowseRepository(taste.config)
        monkeypatch.setattr(library_browse_postgres, "_selected_artist_album_payloads", lambda *_args, **_kwargs: [deepcopy(source)])
        # Album opinions are outside this track-only contract; their separate
        # mutation of source dictionaries must not obscure the taste boundary.
        monkeypatch.setattr(repository, "_apply_private_album_rating_overlays", lambda *_args, **_kwargs: None)
    def build(account):
        scope = {"account_id": account, "library_id": taste.l1,
                 "preference_action_resolver": lambda track_id: track_id == primary["id"]}
        if builder == "sql":
            return repository.build_album_detail_payload(taste.album_key, **scope)
        return album_details.build_album_detail_payload(taste.album_key,
            config=taste.config, inventory_library_id=taste.l1,
            library_state={"albums": [SimpleNamespace(key=taste.album_key)], "file_cache": {}, "scan_in_progress": True},
            **scope)
    accounts = (taste.a, taste.b) if order == "A-B" else (taste.b, taste.a)
    first = build(accounts[0])
    first_snapshot = deepcopy(first)
    second = build(accounts[1])
    assert first == first_snapshot
    assert source == frozen
    for account, payload in ((accounts[0], first), (accounts[1], second)):
        rating, love = (1, "loved") if account == taste.a else (3, "off")
        assert_taste_locations(payload, primary["paths"][0], rating=rating, love_tier=love, editable=True)
        assert_taste_locations(payload, duplicate["paths"][0], rating=rating, love_tier=love, editable=False)
        assert payload["track_rows"][0]["track_stats"]["scrobble_count"] == 7


@pytest.mark.parametrize("case", ["no-scope", "no-provenance", "wrong-provenance", "public"])
def test_unscoped_public_or_foreign_inventory_skips_private_queries(taste, monkeypatch, case):
    from music_app.services import album_details
    primary, duplicate = taste.add_track("primary"), taste.add_track("duplicate")
    source = cached_payload(taste, primary, duplicate)
    before = deepcopy(source)
    def forbidden(*_args, **_kwargs):
        raise AssertionError("unscoped/public/mismatched inventory performed private taste lookup")
    monkeypatch.setattr(album_details, "build_track_preference_overlay_lookup", forbidden)
    kwargs = {"account_id": taste.b, "library_id": taste.l1, "inventory_library_id": taste.l1}
    if case == "no-scope":
        kwargs.pop("account_id")
    elif case == "no-provenance":
        kwargs.pop("inventory_library_id")
    elif case == "wrong-provenance":
        kwargs["inventory_library_id"] = taste.l2
    else:
        kwargs["public_safe"] = True
    payload = album_details._attach_album_detail_track_rows(source, config=taste.config,
        preference_action_resolver=lambda _id: True, **kwargs)
    assert source == before
    if case == "public":
        inspected = {"raw": 0, "shared": 0, "gallery": 0}
        def check_neutral(preference):
            assert preference["rating"] is None
            assert preference["love_tier"] == "off"
            assert preference["allowed_actions"]["can_rate"] is False
            assert preference["allowed_actions"]["can_set_love_tier"] is False
        def check(container):
            for track in container.get("tracks", []):
                inspected["raw"] += 1
                assert track["track_preference_overlay"] is None
                check_neutral(track["track_preference"])
                assert track["can_edit_preferences"] is False
            for position, rows in (("shared", container.get("track_rows", [])),
                                   ("gallery", container.get("gallery_list_block", {}).get("track_rows", []))):
                for row in rows:
                    inspected[position] += 1
                    check_neutral(row["track_preference"])
                    assert row["can_edit_preferences"] is False
            for source in container.get("duplicate_sources", []):
                check(source)
        check(payload)
        assert inspected == {"raw": 3, "shared": 3, "gallery": 3}
    else:
        for track in (primary, duplicate):
            assert_taste_locations(payload, track["paths"][0], rating=None, love_tier="off", editable=False)


@pytest.mark.parametrize("case", ["missing", "conflicting-history", "wrong-numeric-id", "foreign-path-is-local-key"])
def test_hostile_source_overlay_cannot_revive_or_substitute_taste(taste, case):
    from music_app.services import album_details
    track, duplicate = taste.add_track("neutral"), taste.add_track("duplicate")
    if case == "conflicting-history":
        taste.seed_preference(taste.b, track, rating=1)
        taste.seed_preference(taste.b, track, key=track["paths"][0], rating=4)
    else:
        taste.seed_preference(taste.b, track, rating=4)
    source = cached_payload(taste, track, duplicate)
    if case == "missing":
        with taste.connect() as connection:
            connection.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true') where track_id=%s", (track["id"],))
    elif case == "wrong-numeric-id":
        source["tracks"][0]["track_id"] = duplicate["id"]
        source["duplicate_sources"][0]["tracks"][0]["track_id"] = duplicate["id"]
    elif case == "foreign-path-is-local-key":
        foreign = taste.add_track("foreign", library_id=taste.l2, paths=[track["key"]])
        for container in (source, source["duplicate_sources"][0]):
            container["tracks"][0].pop("track_id")
            container["tracks"][0]["path"] = foreign["paths"][0]
        track = {**track, "paths": foreign["paths"]}
    before = deepcopy(source)
    payload = album_details._attach_album_detail_track_rows(source, config=taste.config,
        account_id=taste.b, library_id=taste.l1, inventory_library_id=taste.l1,
        preference_action_resolver=lambda _id: True)
    assert source == before
    assert_taste_locations(payload, track["paths"][0], rating=None, love_tier="off", editable=False)


def test_valid_never_rated_track_is_neutral_and_editable(taste):
    from music_app.services import album_details
    track, duplicate = taste.add_track("new"), taste.add_track("new-duplicate")
    payload = album_details._attach_album_detail_track_rows(cached_payload(taste, track, duplicate),
        config=taste.config, account_id=taste.b, library_id=taste.l1,
        inventory_library_id=taste.l1, preference_action_resolver=lambda _id: True)
    for item in (track, duplicate):
        assert_taste_locations(payload, item["paths"][0], rating=None, love_tier="off", editable=True)


def test_non_album_shared_helper_is_neutral_when_unscoped(taste, monkeypatch):
    from music_app.services import album_details
    main, duplicate = taste.add_track("non-album"), taste.add_track("non-album-duplicate")
    def forbidden(*_args, **_kwargs):
        raise AssertionError("unscoped non-album helper queried private preferences")
    monkeypatch.setattr(album_details, "build_track_preference_overlay_lookup", forbidden)
    payload = album_details._attach_shared_track_rows(cached_payload(taste, main, duplicate), config=taste.config)
    for track in (main, duplicate):
        assert_taste_locations(payload, track["paths"][0], rating=None, love_tier="off", editable=False)
