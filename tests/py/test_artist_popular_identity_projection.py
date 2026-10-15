"""Persisted Artist scope facts; never infer request identity from display text."""
import pytest

from music_app.services.selected_artist_membership import project_local_artist_scope


def project(albums=None, rows=None, names=None):
    return project_local_artist_scope(
        [{"album_id": 20}, {"album_id": 10}] if albums is None else albums,
        [{"album_id": 10, "artist_id": 7, "artist_name": "A"},
         {"album_id": 20, "artist_id": 7, "artist_name": "A"}] if rows is None else rows,
        selected_names=["A"] if names is None else names,
    )


def test_projection_retains_display_album_order_and_numeric_identity():
    assert project() == {"kind": "selected_artists", "artist_ids": ["7"],
                         "album_order": ["20", "10"],
                         "memberships": [{"artist_id": "7", "basis": "primary_credit"}]}


def test_alias_canonicalization_preserves_original_row_identity():
    assert project(albums=[{"album_id": 10}], rows=[{
        "album_id": 10, "artist_id": None, "artist_name": "Canonical",
        "source_artist_id": 8, "source_artist_name": "Alias",
    }], names=["Canonical", "Alias"])["artist_ids"] == ["8"]


def test_unselected_credit_does_not_expand_artist_set():
    result = project(rows=[
        {"album_id": 10, "artist_id": 7, "artist_name": "A"},
        {"album_id": 20, "artist_id": 7, "artist_name": "A"},
        {"album_id": 20, "artist_id": 99, "artist_name": "Guest"},
    ])
    assert result["artist_ids"] == ["7"]


def test_duplicate_album_occurrences_and_rows_do_not_duplicate_scope():
    assert project(albums=[{"album_id": 20}, {"album_id": 20}, {"album_id": 10}]) == project()


@pytest.mark.parametrize("bad", [None, True, 0, -1, "7", "artist/A", 2**63])
def test_bad_artist_identity_cannot_be_repaired_from_label(bad):
    assert project(albums=[{"album_id": 10}], rows=[{
        "album_id": 10, "artist_id": bad, "artist_name": "A",
    }]) is None


@pytest.mark.parametrize("bad", [None, True, 0, -1, "10", "Artist/Album", 2**63])
def test_bad_album_identity_cannot_be_repaired_from_key(bad):
    assert project(albums=[{"album_id": bad, "key": "Artist/Album"}]) is None


def test_missing_row_membership_cannot_be_completed_from_other_album():
    assert project(rows=[{"album_id": 10, "artist_id": 7, "artist_name": "A"}]) is None


def test_no_selected_artist_is_not_whole_library():
    assert project(names=[]) is None
    assert project(albums=[], rows=[]) is None


def test_original_null_identity_does_not_fall_back_to_canonical_label_id():
    assert project(albums=[{"album_id": 10}], rows=[{
        "album_id": 10, "artist_id": 7, "source_artist_id": None,
        "artist_name": "A", "source_artist_name": "A",
    }]) is None


def test_same_name_distinct_persisted_rows_remain_distinct():
    assert project(rows=[
        {"album_id": 10, "artist_id": 7, "artist_name": "A"},
        {"album_id": 20, "artist_id": 8, "artist_name": "A"},
    ])["artist_ids"] == ["7", "8"]


def test_projection_does_not_mutate_input_facts():
    albums = [{"album_id": 10}]
    rows = [{"album_id": 10, "artist_id": 7, "artist_name": "A"}]
    project(albums, rows)
    assert albums == [{"album_id": 10}]
    assert rows == [{"album_id": 10, "artist_id": 7, "artist_name": "A"}]


def test_family_membership_operator_is_retained_per_id():
    value = project_local_artist_scope([{"album_id": 10}],
        [{"album_id": 10, "artist_id": 7, "artist_name": "A"}],
        selected_names=["A"], membership_basis="family_credit")
    assert value["memberships"] == [{"artist_id": "7", "basis": "family_credit"}]


def test_unknown_membership_operator_is_rejected():
    with pytest.raises(ValueError):
        project_local_artist_scope([], [], selected_names=[], membership_basis="all_credits")


def test_real_alias_row_owner_retains_original_ids_for_group_projection():
    from music_app.services.library_browse_postgres import (
        _canonicalize_artist_rows, _attach_selected_artist_identity_scopes,
    )
    rows = _canonicalize_artist_rows([
        {"artist_id": 7, "artist_name": "Alias", "album_id": 10},
    ], {"Alias": "Canonical"})
    assert rows[0]["artist_id"] is None
    assert rows[0]["source_artist_id"] == 7
    assert rows[0]["source_artist_name"] == "Alias"
    groups = [{"artist": "Canonical", "albums": [{"album_id": 10}]}]
    _attach_selected_artist_identity_scopes(groups, rows,
        alias_to_canonical={"Alias": "Canonical"},
        canonical_to_aliases={"Canonical": ["Canonical", "Alias"]})
    assert groups[0]["popular_selection_scope"]["artist_ids"] == ["7"]


def test_real_membership_owner_excludes_collaboration_alias_from_primary_scope():
    from music_app.services.library_browse_postgres import _attach_selected_artist_identity_scopes
    groups = [{"artist": "A", "albums": [{"album_id": 10}]}]
    _attach_selected_artist_identity_scopes(groups, [
        {"artist_id": 7, "artist_name": "A", "album_id": 10},
        {"artist_id": 8, "artist_name": "A & B", "album_id": 10},
    ], alias_to_canonical={"A & B": "A"},
        canonical_to_aliases={"A": ["A", "A & B"]})
    assert groups[0]["popular_selection_scope"]["artist_ids"] == ["7"]


def test_repeated_featured_credit_expansion_keeps_each_credit_identity():
    from music_app.services.library_browse_postgres import _canonicalize_artist_rows
    rows = [{"album_id": 10, "artist_id": 90, "artist_name": "Outer",
             "source_artist_id": 91, "source_artist_name": "Prior outer",
             "album_featured_artists": [
                 {"artist_id": 7, "artist_name": "Alias A"},
                 {"artist_id": 8, "artist_name": "Alias B"},
             ]}]
    aliases = {"Alias A": "A", "Alias B": "B"}
    once = _canonicalize_artist_rows(rows, aliases)
    twice = _canonicalize_artist_rows(once, aliases)
    for result in (once, twice):
        assert {(row["source_artist_id"], row["source_artist_name"], row["artist_name"])
                for row in result} == {(7, "Alias A", "A"), (8, "Alias B", "B")}
    assert len(once) == 2
    assert len(twice) == 4


def test_restored_family_collaboration_keeps_its_own_persisted_id():
    from music_app.services.library_browse_postgres import (
        _selected_artist_family_groups_from_preview_rows,
        _attach_selected_artist_identity_scopes,
    )
    aliases = {"A & B": "A"}
    canonical = {"A": ["A", "A & B"]}
    rows = [{"artist_id": 8, "artist_name": "A & B", "album_id": 10,
             "album_key": "display-only", "album_title": "Together",
             "album_metadata": {"album_artist": "A & B", "artists": ["A & B"]}}]
    groups = _selected_artist_family_groups_from_preview_rows(["A & B"], rows,
        alias_to_canonical=aliases, canonical_to_aliases=canonical)
    assert len(groups) == 1
    assert groups[0]["artist"] == "A & B"
    _attach_selected_artist_identity_scopes(groups, rows,
        alias_to_canonical=aliases, canonical_to_aliases=canonical,
        membership_basis="family_credit")
    assert groups[0]["popular_selection_scope"]["artist_ids"] == ["8"]
    assert groups[0]["popular_selection_scope"]["memberships"] == [
        {"artist_id": "8", "basis": "family_credit"}]



def test_preview_popular_filter_projection_never_copies_private_root_metadata():
    from music_app.services.library_browse_postgres import _root_album_browse_album_payloads
    import json
    result = _root_album_browse_album_payloads([{
        "album_id": 9007199254740993, "album_key": "opaque-key", "album_title": "Album",
        "album_metadata": {"root_provenance": {"categories": [" HOARD ", "/private/sentinel"],
            "private_path": "/private/sentinel", "root_id": "secret-root", "extra": "secret-extra"}},
    }], "Artist", include_artist_members=True)
    assert result[0]["popular_album_id"] == "9007199254740993"
    assert result[0]["root_provenance"] == {"categories": ["hoard"]}
    serialized = json.dumps(result)
    for forbidden in ("/private/sentinel", "secret-root", "secret-extra", "private_path"):
        assert forbidden not in serialized


@pytest.mark.parametrize('fallback', ['new_arrivals', 'hoard'])
def test_full_and_preview_share_bounded_file_category_fallback(fallback):
    from music_app.services.library_browse_postgres import _selected_artist_album_payloads, _root_album_browse_album_payloads
    row = {'album_id': 20, 'album_key': 'opaque', 'album_title': 'Album', 'album_metadata': {},
           'file_library_root_category': fallback, 'file_entry': {}, 'track_id': 1, 'track_title': 'Track'}
    full = _selected_artist_album_payloads([row], 'Artist')
    preview = _root_album_browse_album_payloads([row], 'Artist')
    assert full[0]['root_provenance']['categories'] == preview[0]['root_provenance']['categories'] == [fallback]
