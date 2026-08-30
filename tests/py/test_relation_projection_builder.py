from __future__ import annotations

import builtins
from copy import deepcopy
import importlib
import os
from pathlib import Path

import pytest

from music_app.services.cache import deserialize_relation_views, serialize_relation_views
from music_app.services import relation_projection_postgres as projection
from music_app.services.relation_projection_postgres import (
    build_relation_views_from_postgres_rows,
)


def _row(
    *,
    album_id: int,
    artist: str,
    member: str | None = None,
    root_id: int = 11,
    root_path: str = r"C:\Music",
    relative_path: str | None = None,
    private_path: str | None = None,
    compilation: object = False,
    featured_kind: str | None = None,
    relation_evidence_kind: str | None = None,
    member_artist_is_album_wide_track_artist: bool = False,
) -> dict[str, object]:
    row = {
        "album_id": album_id,
        "owner_artist_id": album_id * 10,
        "owner_artist_name": artist,
        "album_artist": artist,
        "album_is_compilation": compilation,
        "member_artist_id": album_id * 10 + 1,
        "member_artist_name": member or artist,
        "featured_kind": featured_kind or (
            "owner" if member in {None, artist} else "featured_track_artist"
        ),
        "member_artist_is_album_wide_track_artist": (
            member_artist_is_album_wide_track_artist
        ),
        "track_file_id": album_id * 100,
        "library_root_id": root_id,
        "root_path": root_path,
        "relative_path": relative_path,
        "private_path": private_path,
    }
    if relation_evidence_kind is not None:
        row["relation_evidence_kind"] = relation_evidence_kind
    return row


def _family_rows(
    *,
    root_id: int = 11,
    root_path: str = r"C:\Music",
    prefix: str = r"Collective\Shared Era",
) -> list[dict[str, object]]:
    separator = "/" if root_path.startswith("/") else "\\"
    first_relative = separator.join([prefix, "Artist One", "Album One", "01.flac"])
    second_relative = separator.join([prefix, "Artist Two", "Album Two", "02.flac"])
    root = root_path.rstrip("/\\")
    return [
        _row(
            album_id=1,
            artist="Artist One",
            root_id=root_id,
            root_path=root_path,
            relative_path=first_relative,
            private_path=f"{root}{separator}{first_relative}",
        ),
        _row(
            album_id=2,
            artist="Artist Two",
            root_id=root_id,
            root_path=root_path,
            relative_path=second_relative,
            private_path=f"{root}{separator}{second_relative}",
        ),
    ]


def _build(rows: list[dict[str, object]]) -> dict[str, object]:
    return projection.build_relation_views_from_postgres_rows(
        {"MUSIC_DIR": Path(r"C:\compatibility-only")},
        rows,
    )


def test_pure_builder_module_owns_the_planned_fact_and_function_interfaces():
    builder = importlib.import_module(
        "music_app.services.relation_projection_builder"
    )
    PostgresTrackLocationFact = builder.PostgresTrackLocationFact
    PostgresRelationAlbumFact = builder.PostgresRelationAlbumFact
    location = PostgresTrackLocationFact(
        library_root_id="11",
        root_path=r"C:\Music",
        relative_parts=("Collective", "Shared Era", "Artist", "Album", "01.flac"),
    )
    album = PostgresRelationAlbumFact(
        album_id=1,
        album_artist="Artist",
        is_compilation=False,
        artists=("Artist",),
        locations=(location,),
    )

    assert builder.PostgresTrackLocationFact is PostgresTrackLocationFact
    assert builder.PostgresRelationAlbumFact is PostgresRelationAlbumFact
    assert callable(builder.root_relative_parts)
    assert callable(builder.serialized_family_key)
    assert callable(builder.build_postgres_relation_views)
    assert album.locations == (location,)
    assert builder.serialized_family_key("11", ("Collective", "Shared Era")) == (
        '["11","collective","shared era"]'
    )


def test_public_postgres_wrapper_delegates_to_the_pure_owner(monkeypatch):
    expected = {"artists": ["Pure Owner"]}
    monkeypatch.setattr(
        projection,
        "build_postgres_relation_views",
        lambda rows: expected if rows else {},
    )

    assert projection.build_relation_views_from_postgres_rows(
        {"MUSIC_DIR": Path(r"C:\compatibility-only")},
        [_row(album_id=1, artist="Pure Owner")],
    ) == expected


def test_postgres_relation_builder_never_calls_filesystem_methods(monkeypatch):
    def fail(*_args, **_kwargs):
        raise AssertionError("Postgres relation projection touched the filesystem")

    rows = (
        _family_rows()
        + [
            _row(
                album_id=3,
                artist="Morse Portnoy George",
                relative_path=r"Shared\MPG A\song.flac",
                private_path=r"C:\Music\Shared\MPG A\song.flac",
            ),
            _row(
                album_id=4,
                artist="Morse, Portnoy & George",
                relative_path=r"Shared\MPG B\song.flac",
                private_path=r"C:\Music\Shared\MPG B\song.flac",
            ),
        ]
    )
    for row in rows:
        row["track_path"] = row["private_path"]

    with monkeypatch.context() as filesystem_guard:
        for method in (
            "resolve",
            "exists",
            "is_file",
            "is_dir",
            "stat",
            "open",
            "iterdir",
            "glob",
            "rglob",
        ):
            filesystem_guard.setattr(Path, method, fail)
        filesystem_guard.setattr(builtins, "open", fail)
        for method in ("stat", "scandir", "listdir", "walk"):
            filesystem_guard.setattr(os, method, fail)
        relation_views = _build(rows)

    assert relation_views["folder_related"]["Artist One"] == {"Artist Two"}
    assert relation_views["alias_to_canonical"]["Morse, Portnoy & George"] == "Morse Portnoy George"


def test_postgres_relation_builder_keeps_only_ordinary_shared_release_evidence():
    ordinary_rows = _family_rows(prefix=r"Projects\Ordinary Shared Release")
    compilation_rows = [
        _row(
            album_id=10,
            artist="Various Artists",
            member=member,
            compilation=True,
            relative_path=rf"Compilations\VA Signal\{index:02d}.flac",
            private_path=rf"C:\Music\Compilations\VA Signal\{index:02d}.flac",
        )
        for index, member in enumerate(("Sia", "VA Guest"), start=1)
    ]
    soundtrack_rows = [
        _row(
            album_id=20 + index,
            artist=artist,
            featured_kind="owner",
            relation_evidence_kind="soundtrack_root",
            relative_path=rf"Soundtracks\Shared Film\{artist}\Album\01.flac",
            private_path=rf"C:\Music\Soundtracks\Shared Film\{artist}\Album\01.flac",
        )
        for index, artist in enumerate(("Sia", "Soundtrack Guest"), start=1)
    ]
    guest_only_rows = [
        _row(
            album_id=30,
            artist="Sia",
            member="Featured Guest",
            featured_kind="featured_track_artist",
            relative_path=r"Projects\Guest Credit\Sia\Album\01.flac",
            private_path=r"C:\Music\Projects\Guest Credit\Sia\Album\01.flac",
        )
    ]

    relation_views = _build(
        ordinary_rows + compilation_rows + soundtrack_rows + guest_only_rows
    )

    assert relation_views["folder_related"]["Artist One"] == {"Artist Two"}
    assert relation_views["folder_related"]["Artist Two"] == {"Artist One"}
    for excluded_artist in ("Sia", "VA Guest", "Soundtrack Guest", "Featured Guest"):
        assert excluded_artist not in relation_views["folder_related"]
        assert all(
            excluded_artist not in members
            for members in relation_views["family_to_artists"].values()
        )


def test_postgres_relation_builder_keeps_legitimate_collaboration_named_children_discoverable():
    rows = [
        _row(
            album_id=41,
            artist="Artist A & Artist B",
            featured_kind="owner",
            relative_path=(
                r"Projects\Legitimate Collaborations\Artist A & Artist B"
                r"\Shared Album One\01.flac"
            ),
            private_path=(
                r"C:\Music\Projects\Legitimate Collaborations\Artist A & Artist B"
                r"\Shared Album One\01.flac"
            ),
        ),
        _row(
            album_id=42,
            artist="Artist C feat. Artist D",
            featured_kind="owner",
            relative_path=(
                r"Projects\Legitimate Collaborations\Artist C feat. Artist D"
                r"\Shared Album Two\01.flac"
            ),
            private_path=(
                r"C:\Music\Projects\Legitimate Collaborations\Artist C feat. Artist D"
                r"\Shared Album Two\01.flac"
            ),
        ),
    ]

    relation_views = _build(rows)

    expected_members = {"Artist A & Artist B", "Artist C feat. Artist D"}
    assert relation_views["folder_related"]["Artist A & Artist B"] == {
        "Artist C feat. Artist D"
    }
    assert relation_views["folder_related"]["Artist C feat. Artist D"] == {
        "Artist A & Artist B"
    }
    assert expected_members in [
        set(members) for members in relation_views["family_to_artists"].values()
    ]
    assert expected_members <= set(relation_views["artists"])


def test_postgres_relation_builder_keeps_album_wide_track_identity_in_family_without_promoting_guests():
    rows = [
        _row(
            album_id=51,
            artist="Ария",
            member="U.D.O.",
            featured_kind="featured_track_artist",
            relative_path=r"Heavy\Ария\Ария\Штиль\01.flac",
            private_path=r"C:\Music\Heavy\Ария\Ария\Штиль\01.flac",
        ),
        _row(
            album_id=52,
            artist="Виталий Дубинин feat Владимир Холстинин",
            member="Дубинин & Холстинин",
            featured_kind="featured_track_artist",
            member_artist_is_album_wide_track_artist=True,
            relative_path=(
                r"Heavy\Ария\Дубинин & Холстинин\Авария\01.flac"
            ),
            private_path=(
                r"C:\Music\Heavy\Ария\Дубинин & Холстинин\Авария\01.flac"
            ),
        ),
        _row(
            album_id=53,
            artist="Виталий Дубинин",
            relative_path=(
                r"Heavy\Ария\Виталий Дубинин\Бал-маскарад\01.flac"
            ),
            private_path=(
                r"C:\Music\Heavy\Ария\Виталий Дубинин\Бал-маскарад\01.flac"
            ),
        ),
    ]

    relation_views = _build(rows)

    assert relation_views["folder_related"]["Ария"] == {
        "Виталий Дубинин",
        "Дубинин & Холстинин",
    }
    assert "U.D.O." not in relation_views["folder_related"]["Ария"]


def test_soundtrack_album_owner_and_track_members_do_not_join_sia_family():
    ordinary_rows = [
        _row(
            album_id=40 + index,
            artist=artist,
            relative_path=rf"Projects\Ordinary Sia Family\{artist}\Album\01.flac",
            private_path=rf"C:\Music\Projects\Ordinary Sia Family\{artist}\Album\01.flac",
        )
        for index, artist in enumerate(("Sia", "Ordinary Shared Artist"), start=1)
    ]
    soundtrack_owner = "Sia / Soundtrack Signal Guest"
    soundtrack_rows = [
        _row(
            album_id=50,
            artist=soundtrack_owner,
            member=member,
            featured_kind="featured_track_artist",
            relation_evidence_kind="soundtrack_root",
            relative_path=rf"Soundtracks\Shared Film\{soundtrack_owner}\Album\{index:02d}.flac",
            private_path=rf"C:\Music\Soundtracks\Shared Film\{soundtrack_owner}\Album\{index:02d}.flac",
        )
        for index, member in enumerate(("Sia", "Soundtrack Signal Guest"), start=1)
    ]

    relation_views = _build(ordinary_rows + soundtrack_rows)

    assert relation_views["folder_related"]["Sia"] == {"Ordinary Shared Artist"}
    assert soundtrack_owner not in relation_views["folder_related"]["Sia"]
    assert "Soundtrack Signal Guest" not in relation_views["folder_related"]["Sia"]
    assert all(
        soundtrack_owner not in members and "Soundtrack Signal Guest" not in members
        for members in relation_views["family_to_artists"].values()
        if "Sia" in members
    )


def test_connector_only_non_latin_signatures_do_not_bridge_distinct_artist_aliases():
    rows = _family_rows()
    rows[0].update(
        owner_artist_name="Ария",
        album_artist="Ария",
        member_artist_name="Ария feat Симфонический оркестр",
    )
    rows[1].update(
        owner_artist_name="Виталий Дубинин",
        album_artist="Виталий Дубинин",
        member_artist_name="Виталий Дубинин feat Владимир Холстинин",
    )

    relation_views = _build(rows)

    assert relation_views["alias_to_canonical"]["Ария"] == "Ария"
    assert relation_views["alias_to_canonical"]["Ария feat Симфонический оркестр"] == "Ария"
    assert relation_views["alias_to_canonical"]["Виталий Дубинин"] == "Виталий Дубинин"
    assert (
        relation_views["alias_to_canonical"]["Виталий Дубинин feat Владимир Холстинин"]
        == "Виталий Дубинин"
    )


def test_shared_collaboration_alias_does_not_merge_two_solo_artist_identities():
    collaboration = "Ария feat U.D.O."
    rows = [
        _row(
            album_id=1,
            artist="U.D.O.",
            member=collaboration,
            relative_path=r"Heavy\U.D.O.\Album\01.flac",
            private_path=r"C:\Music\Heavy\U.D.O.\Album\01.flac",
        ),
        _row(
            album_id=2,
            artist="Ария",
            member=collaboration,
            relative_path=r"Heavy\Ария\Album\01.flac",
            private_path=r"C:\Music\Heavy\Ария\Album\01.flac",
        ),
    ]

    relation_views = _build(rows)

    assert relation_views["alias_to_canonical"]["U.D.O."] == "U.D.O."
    assert relation_views["alias_to_canonical"]["Ария"] == "Ария"
    assert relation_views["alias_to_canonical"][collaboration] == "Ария"


def test_connector_words_in_ascii_artist_names_do_not_merge_distinct_identities():
    rows = [
        _row(
            album_id=1,
            artist="X Ambassadors",
            relative_path=r"Alternative\X Ambassadors\Album\01.flac",
            private_path=r"C:\Music\Alternative\X Ambassadors\Album\01.flac",
        ),
        _row(
            album_id=2,
            artist="Ambassadors",
            relative_path=r"Alternative\Ambassadors\Album\01.flac",
            private_path=r"C:\Music\Alternative\Ambassadors\Album\01.flac",
        ),
        _row(
            album_id=3,
            artist="With Confidence",
            relative_path=r"Alternative\With Confidence\Album\01.flac",
            private_path=r"C:\Music\Alternative\With Confidence\Album\01.flac",
        ),
        _row(
            album_id=4,
            artist="Confidence",
            relative_path=r"Alternative\Confidence\Album\01.flac",
            private_path=r"C:\Music\Alternative\Confidence\Album\01.flac",
        ),
    ]

    relation_views = _build(rows)

    for artist in ("X Ambassadors", "Ambassadors", "With Confidence", "Confidence"):
        assert relation_views["alias_to_canonical"][artist] == artist


def test_root_relative_parts_prefers_valid_stored_relative_path():
    builder = importlib.import_module(
        "music_app.services.relation_projection_builder"
    )
    row = _row(
        album_id=1,
        artist="Artist",
        relative_path=r"Collective\Shared Era\Artist\Album\01.flac",
        private_path=r"Z:\currently-unmounted\wrong.flac",
    )

    assert builder.root_relative_parts(row) == (
        "11",
        ("Collective", "Shared Era", "Artist", "Album", "01.flac"),
    )


@pytest.mark.parametrize(
    ("root_id", "root_path", "prefix", "expected_label"),
    [
        (11, r"C:\Music", r"Collective\Shared Era", "Collective/Shared Era"),
        (12, r"\\server\music", r"Collective\Shared Era", "Collective/Shared Era"),
        (13, "/srv/music", "Collective/Shared Era", "Collective/Shared Era"),
    ],
    ids=["windows-drive", "windows-unc", "posix"],
)
def test_postgres_relation_builder_uses_stored_path_flavor_lexically(
    root_id,
    root_path,
    prefix,
    expected_label,
):
    relation_views = _build(
        _family_rows(root_id=root_id, root_path=root_path, prefix=prefix)
    )

    assert relation_views["folder_related"]["Artist One"] == {"Artist Two"}
    assert [family["label"] for family in relation_views["sidebar_families"]] == [
        expected_label
    ]


def test_valid_relative_path_wins_over_nonexistent_private_path():
    rows = _family_rows()
    rows[0]["private_path"] = r"Z:\unmounted\wrong\01.flac"
    rows[1]["private_path"] = r"Z:\unmounted\wrong\02.flac"

    relation_views = _build(rows)

    assert relation_views["folder_related"]["Artist One"] == {"Artist Two"}


def test_missing_relative_path_falls_back_to_lexical_root_containment():
    rows = _family_rows()
    for row in rows:
        row["relative_path"] = None

    relation_views = _build(rows)

    assert relation_views["folder_related"]["Artist One"] == {"Artist Two"}


def test_windows_fallback_containment_is_case_insensitive():
    rows = _family_rows(root_path=r"c:\MUSIC")
    for row in rows:
        row["relative_path"] = None
        row["private_path"] = str(row["private_path"]).replace(r"c:\MUSIC", r"C:\music")

    assert _build(rows)["folder_related"]["Artist One"] == {"Artist Two"}


def test_posix_fallback_containment_is_case_sensitive():
    rows = _family_rows(root_path="/srv/Music", prefix="Collective/Shared Era")
    for row in rows:
        row["relative_path"] = None
        row["private_path"] = str(row["private_path"]).replace("/srv/Music", "/srv/music")

    relation_views = _build(rows)

    assert relation_views["family_to_artists"] == {}
    assert relation_views["folder_related"] == {}


@pytest.mark.parametrize(
    ("root_id", "root_path"),
    [(None, r"C:\Music"), (11, None), ("", r"C:\Music"), (11, "")],
)
def test_missing_root_facts_keep_artists_but_never_create_families(root_id, root_path):
    rows = _family_rows()
    for row in rows:
        row["library_root_id"] = root_id
        row["root_path"] = root_path

    relation_views = _build(rows)

    assert set(relation_views["artists"]) == {"Artist One", "Artist Two"}
    assert relation_views["family_to_artists"] == {}
    assert relation_views["folder_related"] == {}


@pytest.mark.parametrize(
    ("relative_path", "private_path"),
    [
        (r"..\Outside\Artist\Album\song.flac", r"C:\Outside\Artist\Album\song.flac"),
        (None, r"D:\Other\Artist\Album\song.flac"),
        (None, "/srv/music/Artist/Album/song.flac"),
        (None, None),
    ],
    ids=["traversal", "outside-root", "mismatched-flavor", "missing-location"],
)
def test_invalid_location_never_creates_a_folder_family(relative_path, private_path):
    rows = _family_rows()
    for row in rows:
        row["relative_path"] = relative_path
        row["private_path"] = private_path

    relation_views = _build(rows)

    assert relation_views["family_to_artists"] == {}
    assert relation_views["folder_related"] == {}
    assert set(relation_views["artists"]) == {"Artist One", "Artist Two"}


def test_invalid_absolute_relative_path_falls_back_to_contained_private_path():
    rows = _family_rows()
    for row in rows:
        row["relative_path"] = r"C:\invalid\absolute.flac"

    relation_views = _build(rows)

    assert relation_views["folder_related"]["Artist One"] == {"Artist Two"}


def test_matching_family_labels_in_two_roots_keep_distinct_opaque_keys():
    relation_views = _build(
        _family_rows(root_id=11, root_path=r"C:\Music")
        + [
            {
                **row,
                "album_id": int(row["album_id"]) + 10,
                "owner_artist_id": int(row["owner_artist_id"]) + 100,
                "owner_artist_name": str(row["owner_artist_name"]).replace("One", "Three").replace("Two", "Four"),
                "album_artist": str(row["album_artist"]).replace("One", "Three").replace("Two", "Four"),
                "member_artist_name": str(row["member_artist_name"]).replace("One", "Three").replace("Two", "Four"),
                "library_root_id": 22,
                "root_path": r"D:\Archive",
                "private_path": str(row["private_path"]).replace(r"C:\Music", r"D:\Archive"),
            }
            for row in _family_rows(root_id=11, root_path=r"C:\Music")
        ]
    )

    families = relation_views["sidebar_families"]
    assert [family["label"] for family in families] == [
        "Collective/Shared Era",
        "Collective/Shared Era",
    ]
    assert len({family["family"] for family in families}) == 2
    assert all(family["family"] != family["label"] for family in families)
    assert relation_views["folder_related"]["Artist One"] == {"Artist Two"}
    assert relation_views["folder_related"]["Artist Three"] == {"Artist Four"}


def test_join_expanded_rows_do_not_multiply_sidebar_counts_or_family_members():
    rows = _family_rows()
    expanded = [deepcopy(row) for row in rows for _ in range(250)]

    relation_views = _build(expanded)

    assert relation_views["artists_sidebar"] == [
        {"artist": "Artist One", "count": 1},
        {"artist": "Artist Two", "count": 1},
    ]
    assert relation_views["folder_related"]["Artist One"] == {"Artist Two"}


def test_compilation_members_never_form_a_family():
    rows = _family_rows()
    for row in rows:
        row["album_id"] = 99
        row["album_artist"] = "Various Artists"
        row["owner_artist_name"] = "Various Artists"
        row["album_is_compilation"] = True

    relation_views = _build(rows)

    assert relation_views["family_to_artists"] == {}
    assert relation_views["folder_related"] == {}


def test_compilation_flag_does_not_discard_non_various_album_owner_from_folder_family():
    rows = [
        _row(
            album_id=1,
            artist="Devin Townsend",
            relative_path=(
                r"Progressive\Devin Townsend\Devin Townsend\Solo Album\01.flac"
            ),
            private_path=(
                r"C:\Music\Progressive\Devin Townsend\Devin Townsend\Solo Album\01.flac"
            ),
        ),
        _row(
            album_id=2,
            artist="IR8 / Sexoturica",
            member="IR8",
            compilation=True,
            featured_kind="featured_member",
            relative_path=(
                r"Progressive\Devin Townsend\IR8 vs Sexoturica\Split Release\01.flac"
            ),
            private_path=(
                r"C:\Music\Progressive\Devin Townsend\IR8 vs Sexoturica\Split Release\01.flac"
            ),
        ),
        _row(
            album_id=2,
            artist="IR8 / Sexoturica",
            member="Sexoturica",
            compilation=True,
            featured_kind="featured_member",
            relative_path=(
                r"Progressive\Devin Townsend\IR8 vs Sexoturica\Split Release\02.flac"
            ),
            private_path=(
                r"C:\Music\Progressive\Devin Townsend\IR8 vs Sexoturica\Split Release\02.flac"
            ),
        ),
    ]

    relation_views = _build(rows)

    assert relation_views["folder_related"]["Devin Townsend"] == {"IR8"}
    assert "Sexoturica" not in relation_views["folder_related"]["Devin Townsend"]


def test_whitespace_aliases_collapse_while_empty_signatures_stay_isolated():
    rows = [
        _row(
            album_id=index,
            artist=artist,
            relative_path=rf"Shared\Artist {index}\song.flac",
            private_path=rf"C:\Music\Shared\Artist {index}\song.flac",
        )
        for index, artist in enumerate(
            ["Signal  Family", "Signal Family", "東京事変", "Борис", "!!!", "***"],
            start=1,
        )
    ]

    relation_views = _build(rows)

    assert relation_views["alias_to_canonical"]["Signal  Family"] == "Signal Family"
    for artist in ["東京事変", "Борис", "!!!", "***"]:
        assert relation_views["alias_to_canonical"][artist] == artist


def test_sidebar_family_label_survives_relation_view_serialization_roundtrip():
    relation_views = _build(_family_rows())

    roundtrip = deserialize_relation_views(serialize_relation_views(relation_views))

    assert roundtrip["sidebar_families"] == relation_views["sidebar_families"]
