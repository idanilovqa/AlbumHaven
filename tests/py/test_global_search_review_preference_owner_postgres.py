"""Real retained requested-ref read/write authority versus Search membership.

The route exercises the extracted candidate relation through its native owner;
the original _selection_sql and PostgresTrackPreferencesStore remain the
independent oracle. No proposed helper is imported just to manufacture RED.
"""
from uuid import uuid4

import pytest

from music_app.services import track_preferences_postgres as preferences
from tests.py.test_global_private_search_postgres import (
    db, isolated_urls, connect, track_refs,
)


SCENARIOS = ["canonical", "active-path", "multiple-active-files", "known-off",
             "duplicate-preferences", "canonical-path-collision", "wrong-track-id", "revoked-membership"]


def preference_snapshot(db):
    with connect(db.setup) as connection:
        return connection.execute("""select id,track_id,track_key,rating,love_tier,metadata
            from app.track_preferences where account_id=%s and library_id=%s order by id""",
            (db.account, db.library)).fetchall()


def seed_preference_case(db, scenario):
    artist = db.artist("AAA Canonical Preference Artist")
    album = db.album(artist, "Canonical Preference Album")
    track = db.track(album, "Canonical Preference Witness", tier=None)
    value = db.tracks[track]
    requested = value["key"]
    if scenario in {"active-path", "multiple-active-files"}:
        requested = value["path"]
        db.preference(track, "loved", key=requested)
        if scenario == "multiple-active-files":
            with connect(db.setup) as connection:
                for _index in range(2):
                    path = db.root_paths[db.roots[db.library]] + "/" + uuid4().hex + ".flac"
                    connection.execute("""insert into library.local_track_files
                        (track_id,library_root_id,private_path,content_signature)
                        values(%s,%s,%s,'synthetic-preference-review')""", (track, db.roots[db.library], path))
    elif scenario != "known-off":
        db.preference(track, "loved")
    if scenario == "duplicate-preferences":
        db.preference(track, "off", key=value["path"])
    elif scenario == "canonical-path-collision":
        db.track(album, "Other Alias Target", key=value["path"], tier=None)
    elif scenario == "wrong-track-id":
        other = db.track(album, "Wrong Identity Target", tier=None)
        with connect(db.setup) as connection:
            connection.execute("""update app.track_preferences set track_id=%s
                where account_id=%s and library_id=%s and track_key=%s""",
                (other, db.account, db.library, value["key"]))
    elif scenario == "revoked-membership":
        with connect(db.setup) as connection:
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                (db.account, db.library))
    return track, requested


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_search_candidate_facts_match_original_requested_ref_and_guarded_patch_owner(db, scenario):
    track, requested = seed_preference_case(db, scenario)
    value = db.tracks[track]
    params = preferences._selection_params([value["key"], value["path"]], db.account, db.library)
    with connect(db.runtime) as connection:
        rows = connection.execute(preferences._selection_sql(), params).fetchall()
    expected_status = ("forbidden" if scenario == "revoked-membership" else
        "conflict" if scenario in {"duplicate-preferences", "canonical-path-collision", "wrong-track-id"} else "ok")
    assert {row["selection_status"] for row in rows} == {expected_status}
    assert {row["track_ref"] for row in rows} == {value["key"], value["path"]}
    store = preferences.PostgresTrackPreferencesStore({"ALBUM_HAVEN_APP_DATABASE_URL": db.runtime})
    before = preference_snapshot(db)
    if expected_status == "forbidden":
        with pytest.raises(preferences.TrackPreferenceScopeError):
            store.resolve_track(requested, account_id=db.account, library_id=db.library)
        with pytest.raises(preferences.TrackPreferenceScopeError):
            store.patch_preference(requested, {"love_tier": "obsessed"}, account_id=db.account,
                library_id=db.library, expected_track_id=track)
        assert preference_snapshot(db) == before
        db.read(search_presentation="tracks", all_artists="1", expected=403, code="private_search_forbidden")
        return
    for query in (":loved", "-:loved", "-:obsessed"):
        payload = db.read(query, search_presentation="tracks", all_artists="1", omit_sidebar="1")
        refs = [row["inventory_track_ref"] for row in payload["tracks"]]
        tier = "off" if scenario == "known-off" else "loved"
        expected_member = expected_status == "ok" and (
            tier in {"loved", "obsessed"} if query == ":loved" else
            tier == "off" if query == "-:loved" else tier != "obsessed")
        assert refs.count(track_refs(db, [track])[0]) == int(expected_member)
    if expected_status == "conflict":
        with pytest.raises(preferences.TrackPreferenceConflictError):
            store.resolve_track(requested, account_id=db.account, library_id=db.library)
        with pytest.raises(preferences.TrackPreferenceConflictError):
            store.patch_preference(requested, {"love_tier": "obsessed"}, account_id=db.account,
                library_id=db.library, expected_track_id=track)
        assert preference_snapshot(db) == before
        return
    original = store.resolve_track(requested, account_id=db.account, library_id=db.library)
    loaded = store.load_track_preferences([value["key"], value["path"]],
        account_id=db.account, library_id=db.library)
    assert set(loaded) == {value["key"], value["path"]}
    assert all(row["track_id"] == track for row in loaded.values())
    assert {row["preference_key"] for row in loaded.values()} == {original["preference_key"]}
    changed = store.patch_preference(requested, {"love_tier": "obsessed"},
        account_id=db.account, library_id=db.library, expected_track_id=track)
    reread = store.resolve_track(requested, account_id=db.account, library_id=db.library)
    assert changed == reread
    assert reread["love_tier"] == "obsessed"
    assert reread["track_id"] == track
    assert reread["preference_key"] == original["preference_key"]
    if original["preference_id"] is not None:
        assert reread["preference_id"] == original["preference_id"]
    payload = db.read(":obsessed", search_presentation="tracks", all_artists="1", omit_sidebar="1")
    assert [row["inventory_track_ref"] for row in payload["tracks"]].count(track_refs(db, [track])[0]) == 1
    # Observation M must have taken place after the guarded mutation, rather
    # than returning an optimistic pre-update requested-ref selection.
    target_rows = [row for row in preference_snapshot(db) if row["track_key"] == reread["preference_key"]]
    assert len(target_rows) == 1 and target_rows[0]["love_tier"] == "obsessed"


@pytest.mark.parametrize("requested_kind", ["canonical", "active-path"])
def test_retained_patch_rejects_wrong_expected_identity_without_any_write(db, requested_kind):
    track, _requested = seed_preference_case(db, "active-path")
    requested = db.tracks[track]["key" if requested_kind == "canonical" else "path"]
    before = preference_snapshot(db)
    store = preferences.PostgresTrackPreferencesStore({"ALBUM_HAVEN_APP_DATABASE_URL": db.runtime})
    with pytest.raises(preferences.TrackPreferenceNotFoundError):
        store.patch_preference(requested, {"love_tier": "obsessed"}, account_id=db.account,
            library_id=db.library, expected_track_id=db.loved)
    assert preference_snapshot(db) == before


@pytest.mark.parametrize("requested", ["track:absent-review-identity", "/synthetic-global-search/absent-review.flac"])
def test_retained_missing_identity_is_never_known_off_or_patchable(db, requested):
    store = preferences.PostgresTrackPreferencesStore({"ALBUM_HAVEN_APP_DATABASE_URL": db.runtime})
    before = preference_snapshot(db)
    with pytest.raises(preferences.TrackPreferenceNotFoundError):
        store.resolve_track(requested, account_id=db.account, library_id=db.library)
    with pytest.raises(preferences.TrackPreferenceNotFoundError):
        store.patch_preference(requested, {"love_tier": "obsessed"}, account_id=db.account,
            library_id=db.library, expected_track_id=db.loved)
    assert preference_snapshot(db) == before
