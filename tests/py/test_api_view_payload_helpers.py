from __future__ import annotations

from types import SimpleNamespace

from music_app.routes import api_view_payload_helpers
from music_app.services.selected_artist_membership import selected_artist_family_artists
from music_app.services.artist_sidebar import build_artists_sidebar


def test_api_view_payload_helpers_do_not_expose_dead_flask_path_fallbacks():
    assert not hasattr(api_view_payload_helpers, "current_app")
    assert not hasattr(api_view_payload_helpers, "normalize_music_file_path")
    assert not hasattr(api_view_payload_helpers, "_entry_matches_visible_artist_path")


def test_build_artists_sidebar_collapses_case_only_shared_artist_variants():
    albums = [
        SimpleNamespace(
            album_artist="MONO / A.A. Williams",
            artists=["MONO", "A.A. Williams"],
            is_compilation=True,
        ),
        SimpleNamespace(
            album_artist="Mono / A.A. Williams",
            artists=["Mono", "A.A. Williams"],
            is_compilation=True,
        ),
    ]

    sidebar = build_artists_sidebar(albums, {
        "alias_to_canonical": {
            "MONO": "Mono",
            "Mono": "Mono",
            "A.A. Williams": "A.A. Williams",
        },
    })

    assert sidebar == [
        {
            "artist": "Mono / A.A. Williams",
            "artist_display": "Mono / A.A. Williams",
            "count": 2,
        },
    ]


def test_selected_artist_family_artists_is_owned_by_selected_artist_membership_service():
    assert (
        api_view_payload_helpers._selected_artist_family_artists
        is selected_artist_family_artists
    )


def test_selected_artist_family_artists_uses_canonical_aliases_before_related_artists():
    family_artists = api_view_payload_helpers._selected_artist_family_artists(
        "MONO",
        ["Broadcast", "A.A. Williams"],
        {
            "Mono": [
                "MONO / A.A. Williams",
                "Mono",
            ],
        },
        {
            "MONO": "Mono",
            "Mono": "Mono",
        },
    )

    assert family_artists == [
        "MONO / A.A. Williams",
        "Broadcast",
        "A.A. Williams",
    ]


def test_selected_artist_family_artists_dedupes_alias_and_related_artist_spellings():
    family_artists = api_view_payload_helpers._selected_artist_family_artists(
        "Mono",
        [
            "mono",
            "Broadcast",
            "Mono / A.A. Williams",
            "Broadcast",
        ],
        {
            "Mono": [
                "MONO",
                "Mono / A.A. Williams",
            ],
        },
        {
            "Mono": "Mono",
        },
    )

    assert family_artists == [
        "Mono / A.A. Williams",
        "Broadcast",
    ]


def test_selected_artist_family_artists_filters_blank_related_artists():
    family_artists = api_view_payload_helpers._selected_artist_family_artists(
        "Mono",
        [
            "",
            "  ",
            "Broadcast",
        ],
        {
            "Mono": [],
        },
        {
            "Mono": "Mono",
        },
    )

    assert family_artists == ["Broadcast"]


def test_selected_artist_family_artists_excludes_featured_aliases_from_family_candidates():
    family_artists = api_view_payload_helpers._selected_artist_family_artists(
        "Ария",
        ["Дубинин & Холстинин", "Кипелов"],
        {
            "Ария": [
                "Ария",
                "Ария feat U.D.O.",
                "Ария featuring Симфонический оркестр",
            ],
        },
        {
            "Ария": "Ария",
            "Ария feat U.D.O.": "Ария",
            "Ария featuring Симфонический оркестр": "Ария",
        },
    )

    assert family_artists == ["Дубинин & Холстинин", "Кипелов"]


def test_album_matches_group_artist_rejects_canonicalized_collaboration_alias_members():
    album = SimpleNamespace(
        key="compilation-track",
        name="Exit in Darkness",
        album_artist="Compilation",
        artists=["Mono / A.A. Williams"],
        year=2021,
        release_date="2021-12-03",
        is_compilation=True,
    )

    assert api_view_payload_helpers._album_matches_group_artist(
        album,
        "Mono",
        {
            "Mono / A.A. Williams": "Mono",
            "Mono": "Mono",
        },
    ) is False


def test_album_matches_group_artist_keeps_word_substrings_from_triggering_collaboration_filter():
    album = SimpleNamespace(
        key="within-temptation",
        name="Mother Earth",
        album_artist="Within Temptation",
        artists=["Within Temptation"],
        year=2000,
        release_date="2000-12-11",
        is_compilation=False,
    )

    assert api_view_payload_helpers._album_matches_group_artist(
        album,
        "Within Temptation",
        {
            "Within Temptation": "Within Temptation",
        },
    ) is True


def test_build_artist_membership_groups_member_match_includes_canonicalized_collaboration_alias_member():
    album = SimpleNamespace(
        key="compilation-track",
        name="Exit in Darkness",
        album_artist="Compilation",
        artists=["Mono / A.A. Williams"],
        year=2021,
        release_date="2021-12-03",
        is_compilation=True,
    )

    groups = api_view_payload_helpers._build_artist_membership_groups(
        [album],
        ["Mono"],
        {
            "Mono / A.A. Williams": "Mono",
            "Mono": "Mono",
        },
        {
            "Mono": [
                "Mono",
                "Mono / A.A. Williams",
            ],
        },
        exact_group_matches=False,
        album_serializer=lambda current_album: {
            "name": current_album.name,
            "album_artist": current_album.album_artist,
        },
    )

    assert groups == [
        {
            "artist": "Compilation",
            "artist_display": "Compilation",
            "albums": [
                {
                    "name": "Exit in Darkness",
                    "album_artist": "Compilation",
                },
            ],
        },
    ]


def test_build_artist_membership_groups_exact_group_match_excludes_canonicalized_collaboration_alias_member():
    album = SimpleNamespace(
        key="compilation-track",
        name="Exit in Darkness",
        album_artist="Compilation",
        artists=["Mono / A.A. Williams"],
        year=2021,
        release_date="2021-12-03",
        is_compilation=True,
    )

    groups = api_view_payload_helpers._build_artist_membership_groups(
        [album],
        ["Mono"],
        {
            "Mono / A.A. Williams": "Mono",
            "Mono": "Mono",
        },
        {
            "Mono": [
                "Mono",
                "Mono / A.A. Williams",
            ],
        },
        exact_group_matches=True,
        album_serializer=lambda current_album: {
            "name": current_album.name,
            "album_artist": current_album.album_artist,
        },
    )

    assert groups == []


def test_build_artist_membership_groups_skips_excluded_album_keys():
    included_album = SimpleNamespace(
        key="kept-album",
        name="Nowhere, Now Here",
        album_artist="Mono",
        artists=["Mono"],
        year=2019,
        release_date="2019-01-25",
        is_compilation=False,
    )
    excluded_album = SimpleNamespace(
        key="skip-album",
        name="Hymn to the Immortal Wind",
        album_artist="Mono",
        artists=["Mono"],
        year=2009,
        release_date="2009-03-24",
        is_compilation=False,
    )

    groups = api_view_payload_helpers._build_artist_membership_groups(
        [excluded_album, included_album],
        ["Mono"],
        {
            "Mono": "Mono",
        },
        {
            "Mono": ["Mono"],
        },
        exclude_album_keys={"skip-album"},
        album_serializer=lambda current_album: current_album.name,
    )

    assert groups == [
        {
            "artist": "Mono",
            "artist_display": "Mono",
            "albums": ["Nowhere, Now Here"],
        },
    ]


def test_build_artist_membership_groups_keeps_current_stable_album_sort_policy():
    later_named_album = SimpleNamespace(
        key="late-name",
        name="The Last Dawn",
        album_artist="Mono",
        artists=["Mono"],
        year=2014,
        release_date="2014-10-29",
        is_compilation=False,
    )
    earlier_release_album = SimpleNamespace(
        key="earlier-release",
        name="Rays of Darkness",
        album_artist="Mono",
        artists=["Mono"],
        year=2014,
        release_date="2014-10-24",
        is_compilation=False,
    )
    earlier_year_album = SimpleNamespace(
        key="earlier-year",
        name="Hymn to the Immortal Wind",
        album_artist="Mono",
        artists=["Mono"],
        year=2009,
        release_date="2009-03-24",
        is_compilation=False,
    )

    groups = api_view_payload_helpers._build_artist_membership_groups(
        [later_named_album, earlier_release_album, earlier_year_album],
        ["Mono"],
        {
            "Mono": "Mono",
        },
        {
            "Mono": ["Mono"],
        },
        album_serializer=lambda current_album: current_album.name,
    )

    assert groups == [
        {
            "artist": "Mono",
            "artist_display": "Mono",
            "albums": [
                "Hymn to the Immortal Wind",
                "Rays of Darkness",
                "The Last Dawn",
            ],
        },
    ]


def test_build_artist_membership_groups_keeps_shared_selected_artist_album_under_each_member_group():
    album = SimpleNamespace(
        key="shared-release",
        name="Exit in Darkness",
        album_artist="Mono / A.A. Williams",
        artists=["Mono", "A.A. Williams"],
        year=2021,
        release_date="2021-12-03",
        is_compilation=False,
    )

    groups = api_view_payload_helpers._build_artist_membership_groups(
        [album],
        ["Mono", "A.A. Williams"],
        {
            "Mono": "Mono",
            "A.A. Williams": "A.A. Williams",
            "Mono / A.A. Williams": "Mono / A.A. Williams",
        },
        {
            "Mono": ["Mono"],
            "A.A. Williams": ["A.A. Williams"],
            "Mono / A.A. Williams": ["Mono / A.A. Williams"],
        },
        album_serializer=lambda current_album: {
            "name": current_album.name,
            "album_artist": current_album.album_artist,
        },
    )

    assert groups == [
        {
            "artist": "Mono",
            "artist_display": "Mono",
            "albums": [
                {
                    "name": "Exit in Darkness",
                    "album_artist": "Mono / A.A. Williams",
                },
            ],
        },
        {
            "artist": "A.A. Williams",
            "artist_display": "A.A. Williams",
            "albums": [
                {
                    "name": "Exit in Darkness",
                    "album_artist": "Mono / A.A. Williams",
                },
            ],
        },
    ]


def test_build_artist_membership_groups_keeps_distinct_payloads_for_multiple_keyless_albums():
    first_album = SimpleNamespace(
        key="",
        name="First Release",
        album_artist="Mono",
        artists=["Mono"],
        year=2009,
        release_date="2009-03-24",
        is_compilation=False,
    )
    second_album = SimpleNamespace(
        key="",
        name="Second Release",
        album_artist="Mono",
        artists=["Mono"],
        year=2010,
        release_date="2010-03-24",
        is_compilation=False,
    )

    groups = api_view_payload_helpers._build_artist_membership_groups(
        [first_album, second_album],
        ["Mono"],
        {
            "Mono": "Mono",
        },
        {
            "Mono": ["Mono"],
        },
        album_payload_cache={},
        album_serializer=lambda current_album: {
            "name": current_album.name,
        },
    )

    assert groups == [
        {
            "artist": "Mono",
            "artist_display": "Mono",
            "albums": [
                {"name": "First Release"},
                {"name": "Second Release"},
            ],
        },
    ]


def test_preferred_group_artist_from_albums_keeps_current_shortest_punctuation_light_name():
    albums = [
        SimpleNamespace(album_artist="Morse, Portnoy & George"),
        SimpleNamespace(album_artist="Morse Portnoy George"),
    ]

    preferred = api_view_payload_helpers._preferred_group_artist_from_albums(
        "Morse, Portnoy & George",
        albums,
    )

    assert preferred == "Morse Portnoy George"


def test_build_group_artist_display_keeps_merged_visible_spellings_for_matching_album_artists():
    albums = [
        SimpleNamespace(album_artist="Morse, Portnoy & George"),
        SimpleNamespace(album_artist="Morse Portnoy George"),
        SimpleNamespace(album_artist="Transatlantic"),
    ]

    display = api_view_payload_helpers._build_group_artist_display(
        "Morse Portnoy George",
        "Morse, Portnoy & George",
        albums,
    )

    assert display == "Morse Portnoy George / Morse, Portnoy & George"


def test_build_group_artist_display_preserves_literal_slashes_in_artist_names():
    display = api_view_payload_helpers._build_group_artist_display(
        "AC/DC",
        "AC/DC",
        [SimpleNamespace(album_artist="AC/DC")],
    )

    assert display == "AC/DC"


def test_merge_duplicate_artist_groups_keeps_current_artist_display_and_album_ordering():
    later_named_album = {
        "name": "Cover 2 Cover",
        "album_artist": "Morse Portnoy George",
        "year": 2012,
        "release_date": "2012-09-11",
    }
    earlier_release_album = {
        "name": "Cover to Cover",
        "album_artist": "Morse, Portnoy & George",
        "year": 2006,
        "release_date": "2006-09-01",
    }
    latest_album = {
        "name": "Songs from November",
        "album_artist": "Morse, Portnoy & George",
        "year": 2024,
        "release_date": "2024-08-16",
    }

    merged = api_view_payload_helpers._merge_duplicate_artist_groups([
        {
            "artist": "Morse Portnoy George",
            "artist_display": "Morse Portnoy George",
            "albums": [later_named_album],
        },
        {
            "artist": "Morse, Portnoy & George",
            "artist_display": "Morse, Portnoy & George",
            "albums": [earlier_release_album],
        },
        {
            "artist": "Morse Portnoy George",
            "artist_display": "Morse Portnoy George",
            "albums": [latest_album],
        },
    ])

    assert merged == [
        {
            "artist": "Morse Portnoy George",
            "artist_display": "Morse Portnoy George / Morse, Portnoy & George",
            "albums": [
                earlier_release_album,
                later_named_album,
                latest_album,
            ],
        },
    ]
