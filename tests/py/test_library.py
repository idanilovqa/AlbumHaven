from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.models.library import Album, Track
from music_app.services.library import (
    _apply_album_display_metadata_if_present,
    _apply_album_note_seams,
    _album_payload_signature_core,
    _apply_gallery_summary_opinion_payloads,
    _build_album_opinion_payloads,
    _normalize_album_preview_payload,
    _album_payload_signature,
    _album_payload_track_signature,
    _album_preview_payload_signature,
    _build_album_base_payload,
    _build_album_preview_gallery_list_block,
    _build_album_detail_gallery_list_block,
    _build_album_detail_setup_payloads,
    _build_album_detail_track_payloads,
    _finalize_album_payload_for_viewer,
    album_preview_to_dict,
    album_to_dict,
    build_albums_from_file_cache,
    filter_album_top_items_for_viewer,
    get_album_duplicate_sources,
    strip_private_album_preference_overlays,
)
from music_app.services.relations import build_relation_views
from tests.py.runtime_testing import configure_test_app_paths


@pytest.fixture
def explicit_config(tmp_path, monkeypatch):
    paths = configure_test_app_paths(tmp_path, monkeypatch)
    return {
        "DATA_DIR": paths["data_dir"],
        "MUSIC_DIR": paths["music_dir"],
        "CACHE_PATH": paths["cache_path"],
        "COVER_CACHE_PATH": paths["cover_cache_path"],
        "LIBRARY_ROOTS_PATH": paths["library_roots_path"],
        "TESTING": True,
    }


def test_library_tests_do_not_depend_on_flask_runtime_helpers():
    source = Path(__file__).read_text(encoding="utf-8")
    forbidden_terms = [
        "tests.py." "flask_fixtures",
        "from " "flask",
        "import " "flask",
        "app_" "context(",
        "app." "app_" "context(",
        "app." "config",
        "app." "logger",
        "app." "library_state",
        "cli" "ent as ",
    ]

    assert not [term for term in forbidden_terms if term in source]


def _entry(*, path: str, title: str, artist: str, album_artist: str, album: str, track_number: int) -> dict[str, object]:
    return {
        "path": path,
        "title": title,
        "artist": artist,
        "album_artist": album_artist,
        "album": album,
        "year": 2013,
        "track_number": track_number,
        "disc_number": 1,
        "disc_number_raw": "1",
        "edition": "",
        "album_rating": 0,
        "duration_seconds": 180,
        "cover_path": None,
    }


def test_build_albums_from_file_cache_keeps_dominant_artist_for_one_off_guest_album():
    album_artist = "Howard Shore / Billy Boyd"
    album_name = "The Hobbit: The Desolation of Smaug"
    file_cache = {
        "track-1": _entry(
            path="C:/Music/Howard Shore/The Hobbit/01.mp3",
            title="Track 1",
            artist="Howard Shore",
            album_artist=album_artist,
            album=album_name,
            track_number=1,
        ),
        "track-2": _entry(
            path="C:/Music/Howard Shore/The Hobbit/02.mp3",
            title="Track 2",
            artist="Howard Shore",
            album_artist=album_artist,
            album=album_name,
            track_number=2,
        ),
        "track-3": _entry(
            path="C:/Music/Howard Shore/The Hobbit/03.mp3",
            title="Track 3",
            artist="Howard Shore",
            album_artist=album_artist,
            album=album_name,
            track_number=3,
        ),
        "track-4": _entry(
            path="C:/Music/Howard Shore/The Hobbit/04.mp3",
            title="Track 4",
            artist="Billy Boyd",
            album_artist=album_artist,
            album=album_name,
            track_number=4,
        ),
    }

    albums = build_albums_from_file_cache(file_cache)

    assert len(albums) == 1
    album = albums[0]
    assert album.album_artist == "Howard Shore"
    assert album.artists == ["Howard Shore"]
    assert album.is_compilation is False
    assert [track.artist for track in album.tracks] == [
        "Howard Shore",
        "Howard Shore",
        "Howard Shore",
        "Billy Boyd",
    ]


def test_build_albums_from_file_cache_preserves_persisted_non_compilation_family_members():
    album_name = "Non-Compilation Cross-Credits"
    album_artist = "Control Signal Lead"
    member_artists = ("Control Signal Lead", "Control Signal Partner")
    file_cache = {
        f"track-{track_number}": {
            **_entry(
                path=(
                    "C:/Music/Control Family/Non-Compilation Cross-Credits/"
                    f"Disc {track_number}/0{track_number}.mp3"
                ),
                title=f"Control Signal {track_number}",
                artist=member_artist,
                album_artist=album_artist,
                album=album_name,
                track_number=track_number,
            ),
            "is_compilation": False,
        }
        for track_number, member_artist in enumerate(member_artists, start=1)
    }

    albums = build_albums_from_file_cache(file_cache)

    assert len(albums) == 1
    album = albums[0]
    assert album.is_compilation is False
    assert album.album_artist == " / ".join(member_artists)
    assert album.artists == list(member_artists)
    persisted_relation_views = build_relation_views(
        albums,
        {"MUSIC_DIR": Path("C:/Music")},
    )
    assert persisted_relation_views["folder_related"] == {
        "Control Signal Lead": {"Control Signal Partner"},
        "Control Signal Partner": {"Control Signal Lead"},
    }
    assert persisted_relation_views["alias_to_canonical"][
        "Control Signal Lead / Control Signal Partner"
    ] == "Control Signal Lead"

    inferred_albums = build_albums_from_file_cache(
        {
            cache_key: {
                field: value
                for field, value in entry.items()
                if field != "is_compilation"
            }
            for cache_key, entry in file_cache.items()
        }
    )
    assert inferred_albums[0].is_compilation is True
    inferred_relation_views = build_relation_views(
        inferred_albums,
        {"MUSIC_DIR": Path("C:/Music")},
    )
    assert inferred_relation_views["folder_related"] == {}


def test_build_albums_from_file_cache_deduplicates_repeated_composite_album_artist_names():
    repeated_album_artist = (
        "Frank Churchill / Leigh Harline / Larry Morey / "
        "Frank Churchill / Larry Morey"
    )
    expected_album_artist = "Frank Churchill / Leigh Harline / Larry Morey"
    file_cache = {
        f"track-{track_number}": _entry(
            path=f"C:/Music/Snow White And The Seven Dwarfs/{track_number:02}.mp3",
            title=f"Track {track_number}",
            artist=repeated_album_artist,
            album_artist=repeated_album_artist,
            album="Snow White And The Seven Dwarfs",
            track_number=track_number,
        )
        for track_number in range(1, 4)
    }

    albums = build_albums_from_file_cache(file_cache)

    assert len(albums) == 1
    album = albums[0]
    assert album.album_artist == expected_album_artist
    assert album.artists == ["Frank Churchill", "Leigh Harline", "Larry Morey"]
    assert album.album_artist.count("Frank Churchill") == 1
    assert album.album_artist.count("Larry Morey") == 1
    assert album.key == (
        "frank churchill / leigh harline / larry morey / "
        "frank churchill / larry morey::snow white and the seven dwarfs"
    )


def test_build_albums_deduplicates_overlapping_clean_track_album_artist_values():
    full_credit = "Frank Churchill / Leigh Harline / Larry Morey"
    shorter_credit = "Frank Churchill / Larry Morey"
    file_cache = {
        f"track-{track_number}": _entry(
            path=f"C:/Music/Snow White And The Seven Dwarfs/{track_number:02}.mp3",
            title=f"Track {track_number}",
            artist=track_artist,
            album_artist=track_artist,
            album="Snow White And The Seven Dwarfs",
            track_number=track_number,
        )
        for track_number, track_artist in enumerate(
            [full_credit, shorter_credit, full_credit, shorter_credit],
            start=1,
        )
    }

    albums = build_albums_from_file_cache(file_cache)

    assert len(albums) == 1
    album = albums[0]
    assert album.album_artist == full_credit
    assert album.artists == [full_credit, shorter_credit]
    assert album.key == (
        "frank churchill / leigh harline / larry morey::"
        "snow white and the seven dwarfs"
    )


@pytest.mark.parametrize(
    "album_artist",
    [
        "Tyler, The Creator",
        "Earth, Wind & Fire",
    ],
)
def test_build_albums_from_file_cache_preserves_punctuation_in_single_artist_names(album_artist):
    file_cache = {
        f"track-{track_number}": _entry(
            path=f"C:/Music/{album_artist}/Album/{track_number:02}.mp3",
            title=f"Track {track_number}",
            artist=album_artist,
            album_artist=album_artist,
            album="Album",
            track_number=track_number,
        )
        for track_number in range(1, 4)
    }

    albums = build_albums_from_file_cache(file_cache)

    assert len(albums) == 1
    album = albums[0]
    assert album.album_artist == album_artist
    assert album.artists == [album_artist]
    assert album.key == f"{album_artist.casefold()}::album"


def test_build_albums_from_file_cache_treats_cyrillic_and_as_collaboration_marker():
    album_name = "Collaboration Album"
    file_cache = {
        "track-1": _entry(
            path="C:/Music/Kipelov/Collaboration Album/01.mp3",
            title="Track 1",
            artist="Кипелов",
            album_artist="Кипелов",
            album=album_name,
            track_number=1,
        ),
        "track-2": _entry(
            path="C:/Music/Kipelov/Collaboration Album/02.mp3",
            title="Track 2",
            artist="Кипелов и Маврин",
            album_artist="Кипелов",
            album=album_name,
            track_number=2,
        ),
    }

    albums = build_albums_from_file_cache(file_cache)

    assert len(albums) == 1
    album = albums[0]
    assert album.album_artist == "Кипелов"
    assert album.artists == ["Кипелов"]
    assert album.is_compilation is False


def test_collaboration_remainder_prefixes_has_single_cyrillic_assignment():
    source = Path("music_app/services/library.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    assignments = [
        node
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name)
            and target.id == "_COLLAB_REMAINDER_PREFIXES"
            for target in node.targets
        )
    ]

    assert len(assignments) == 1
    value = ast.literal_eval(assignments[0].value)
    assert "и" in value
    assert "Рё" not in value


def test_album_serializers_expose_album_display_metadata_seam():
    album = SimpleNamespace(
        key="mono-1",
        name="Hymn to the Immortal Wind",
        album_artist="Mono",
        artists=["Mono"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2009,
        edition="",
        album_rating=9,
        total_duration_seconds=305,
        release_date="2009-03-14",
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        tracks=[],
        album_display_metadata={
            "display_country": {
                "name": "Japan",
                "code": "jp",
                "source_kind": "artist",
            },
            "generalized_genre": {
                "name": "Post-Rock",
                "slug": "post-rock",
                "source_kind": "release_group",
            },
            "exact_genres": [
                {
                    "name": "Post-Rock",
                    "slug": "post-rock",
                    "source_kind": "release_group",
                },
                {
                    "name": "Ambient",
                    "slug": "ambient",
                    "source_kind": "artist",
                },
            ],
            "source_provenance": {
                "provider": "musicbrainz",
                "provider_record_kind": "release_group",
                "provider_record_id": "rg-1",
                "generalized_genre_algorithm_version": "v1",
            },
            "freshness_state": "fresh",
        },
        album_note={},
        visible_album_notes=[],
    )

    preview_payload = album_preview_to_dict(album)
    detail_payload = album_to_dict(album)

    expected_metadata = {
        "display_country": {
            "name": "Japan",
            "code": "JP",
            "source_kind": "artist",
        },
        "generalized_genre": {
            "name": "Post-Rock",
            "slug": "post-rock",
            "source_kind": "release_group",
        },
        "exact_genres": [
            {
                "name": "Post-Rock",
                "slug": "post-rock",
                "source_kind": "release_group",
            },
            {
                "name": "Ambient",
                "slug": "ambient",
                "source_kind": "artist",
            },
        ],
        "source_provenance": {
            "provider": "musicbrainz",
            "provider_record_kind": "release_group",
            "provider_record_id": "rg-1",
            "generalized_genre_algorithm_version": "v1",
        },
        "freshness_state": "fresh",
    }

    assert preview_payload["album_display_metadata"] == expected_metadata
    assert detail_payload["album_display_metadata"] == expected_metadata


def test_album_to_dict_routes_album_display_metadata_through_shared_helper(monkeypatch):
    album = SimpleNamespace(
        key="mono-1",
        name="Hymn to the Immortal Wind",
        album_artist="Mono",
        artists=["Mono"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2009,
        edition="",
        album_rating=9,
        total_duration_seconds=305,
        release_date="2009-03-14",
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        tracks=[],
        album_note={},
        visible_album_notes=[],
    )
    seen_albums = []

    def fake_apply_album_display_metadata_if_present(payload, target_album):
        seen_albums.append(target_album)
        payload = dict(payload)
        payload["album_display_metadata"] = {"source": "shared-helper"}
        return payload

    monkeypatch.setattr(
        "music_app.services.library._apply_album_display_metadata_if_present",
        fake_apply_album_display_metadata_if_present,
    )

    payload = album_to_dict(album)

    assert seen_albums == [album]
    assert payload["album_display_metadata"] == {"source": "shared-helper"}


def test_strip_private_album_preference_overlays_removes_track_payload_private_fields():
    payload = {
        "album_ref": "album-1",
        "album_note": {
            "album_ref": "album-1",
            "note_ref": "note-1",
            "is_present": True,
            "visibility": "private",
            "body": "Private listener note",
            "updated_at": "2026-06-01T00:00:00Z",
            "revision_count": 2,
            "reply_summary": {"reply_count": 4, "latest_reply_at": "2026-06-02T00:00:00Z"},
            "allowed_actions": {
                "can_create": True,
                "can_edit": True,
                "can_delete": True,
                "can_share": True,
                "can_view_history": True,
                "can_reply": True,
            },
        },
        "visible_album_notes": [
            {
                "note_ref": "note-2",
                "album_ref": "album-1",
                "body_preview": "Shared preview",
                "reply_summary": {"reply_count": 1},
                "allowed_actions": {"can_reply": True},
            },
        ],
        "tracks": [
            {
                "title": "Private Track",
                "track_preference_overlay": {"rating": 5},
                "playback_state_overlay": {"can_play": True},
                "track_scrobble_count": 12,
            },
        ],
        "track_rows": [],
        "duplicate_sources": [
            {
                "label": "1",
                "tracks": [
                    {
                        "title": "Duplicate Track",
                        "track_preference_overlay": {"love_tier": "obsessed"},
                        "playback_state_overlay": {"queue_index": 1},
                        "track_scrobble_count": 8,
                    },
                ],
            },
        ],
    }

    sanitized = strip_private_album_preference_overlays(payload)

    assert "album_note" not in sanitized
    assert "visible_album_notes" not in sanitized
    assert sanitized["tracks"][0]["track_preference_overlay"] is None
    assert sanitized["tracks"][0]["playback_state_overlay"] is None
    assert sanitized["tracks"][0]["track_scrobble_count"] is None
    duplicate_track = sanitized["duplicate_sources"][0]["tracks"][0]
    assert duplicate_track["track_preference_overlay"] is None
    assert duplicate_track["playback_state_overlay"] is None
    assert duplicate_track["track_scrobble_count"] is None


def test_album_to_dict_cache_signature_tracks_album_note_changes():
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2001,
        release_date="2001-01-01",
        edition="",
        album_rating=8,
        total_duration_seconds=0,
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        tracks=[],
        album_note={
            "note_ref": "note-1",
            "body": "First note",
            "is_present": True,
        },
        visible_album_notes=[],
    )

    first_payload = album_to_dict(album)
    album.album_note = {
        "note_ref": "note-1",
        "body": "Revised note",
        "is_present": True,
    }
    second_payload = album_to_dict(album)

    assert first_payload["album_note"]["body"] == "First note"
    assert second_payload["album_note"]["body"] == "Revised note"


def test_album_serialization_cache_tracks_cover_revision_at_unchanged_path():
    album = Album(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        cover_path=Path("Artist One/Album One/cover.jpg"),
        cover_revision="old-cover-bytes",
    )

    first_preview = album_preview_to_dict(album)
    first_detail = album_to_dict(album)
    album.cover_revision = "new-cover-bytes"
    second_preview = album_preview_to_dict(album)
    second_detail = album_to_dict(album)

    assert first_preview["cover_revision"] == "old-cover-bytes"
    assert first_detail["cover_revision"] == "old-cover-bytes"
    assert second_preview["cover_revision"] == "new-cover-bytes"
    assert second_detail["cover_revision"] == "new-cover-bytes"


def test_album_detail_cache_tracks_nested_track_cover_revision_at_unchanged_path():
    track = Track(
        path=Path("Artist One/Album One/01 - Track One.mp3"),
        title="Track One",
        cover_path=Path("Artist One/Album One/cover.jpg"),
        cover_revision="old-track-cover-bytes",
    )
    album = Album(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        tracks=[track],
        cover_path=Path("Artist One/Album One/cover.jpg"),
        cover_revision="unchanged-album-cover-bytes",
    )

    first_detail = album_to_dict(album)
    track.cover_revision = "new-track-cover-bytes"
    second_detail = album_to_dict(album)

    assert first_detail["cover_revision"] == "unchanged-album-cover-bytes"
    assert first_detail["tracks"][0]["cover_revision"] == "old-track-cover-bytes"
    assert second_detail["cover_revision"] == "unchanged-album-cover-bytes"
    assert second_detail["tracks"][0]["cover_revision"] == "new-track-cover-bytes"


def test_album_detail_cache_tracks_nested_track_genre_changes():
    track = Track(
        path=Path("Artist One/Album One/01 - Track One.mp3"),
        title="Track One",
        genre="Progressive Rock",
    )
    album = Album(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        tracks=[track],
    )

    first_detail = album_to_dict(album)
    track.genre = "Art Rock"
    second_detail = album_to_dict(album)

    assert first_detail["tracks"][0]["genre"] == "Progressive Rock"
    assert second_detail["tracks"][0]["genre"] == "Art Rock"


def test_album_detail_track_payload_preserves_editable_genre():
    track = Track(
        path=Path("Artist One/Album One/01 - Track One.mp3"),
        title="Track One",
        genre="Progressive Rock",
    )
    album = Album(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        tracks=[track],
    )

    detail = album_to_dict(album)

    assert detail["tracks"][0]["genre"] == "Progressive Rock"


def test_album_preview_to_dict_cache_signature_tracks_visible_album_notes_changes():
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2001,
        release_date="2001-01-01",
        edition="",
        album_rating=8,
        total_duration_seconds=0,
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        tracks=[],
        album_note={
            "note_ref": "note-1",
            "body": "First note",
            "is_present": True,
        },
        visible_album_notes=[
            {
                "note_ref": "note-2",
                "body_preview": "First shared note",
            },
        ],
    )

    first_payload = album_preview_to_dict(album)
    album.visible_album_notes = [
        {
            "note_ref": "note-2",
            "body_preview": "Updated shared note",
        },
    ]
    second_payload = album_preview_to_dict(album)

    assert first_payload["visible_album_notes"][0]["body_preview"] == "First shared note"
    assert second_payload["visible_album_notes"][0]["body_preview"] == "Updated shared note"


def test_album_preview_payload_signature_tracks_visible_album_notes_changes():
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2001,
        release_date="2001-01-01",
        edition="",
        album_rating=8,
        total_duration_seconds=0,
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        crowd_opinion=None,
        friends_opinion=None,
        album_popularity=None,
        tracks=[],
    )

    first_signature = _album_preview_payload_signature(
        album,
        viewer_opinion_preferences={"show_rated": True},
        include_album_note_seams=True,
        album_note_payload={"note_ref": "note-1", "body": "First note"},
        visible_album_notes_payload=[{"note_ref": "note-2", "body_preview": "First shared note"}],
    )
    second_signature = _album_preview_payload_signature(
        album,
        viewer_opinion_preferences={"show_rated": True},
        include_album_note_seams=True,
        album_note_payload={"note_ref": "note-1", "body": "First note"},
        visible_album_notes_payload=[{"note_ref": "note-2", "body_preview": "Updated shared note"}],
    )

    assert first_signature != second_signature


def test_album_payload_signature_core_tracks_shared_album_fields():
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label="Cover Source",
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2001,
        release_date="2001-01-01",
        edition="",
        album_rating=8,
        total_duration_seconds=0,
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        album_display_metadata={"primary_text": "Original"},
        crowd_opinion=None,
        friends_opinion=None,
        album_popularity=None,
    )

    first_signature = _album_payload_signature_core(
        album,
        viewer_opinion_preferences={"show_popularity": False, "show_rated": True},
    )
    second_signature = _album_payload_signature_core(
        album,
        viewer_opinion_preferences={"show_rated": True, "show_popularity": False},
    )

    assert first_signature == second_signature

    album.remote_cover_source_label = "Updated Source"

    third_signature = _album_payload_signature_core(
        album,
        viewer_opinion_preferences={"show_rated": True, "show_popularity": False},
    )

    assert first_signature != third_signature


def test_album_payload_signature_tracks_visible_album_notes_changes():
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2001,
        release_date="2001-01-01",
        edition="",
        album_rating=8,
        total_duration_seconds=0,
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        crowd_opinion=None,
        friends_opinion=None,
        album_popularity=None,
        tracks=[],
    )

    first_signature = _album_payload_signature(
        album,
        client_surface_class="private_web",
        viewer_opinion_preferences={"show_rated": True},
        move_availability=None,
        album_note_payload={"note_ref": "note-1", "body": "First note"},
        visible_album_notes_payload=[{"note_ref": "note-2", "body_preview": "First shared note"}],
    )
    second_signature = _album_payload_signature(
        album,
        client_surface_class="private_web",
        viewer_opinion_preferences={"show_rated": True},
        move_availability=None,
        album_note_payload={"note_ref": "note-1", "body": "First note"},
        visible_album_notes_payload=[{"note_ref": "note-2", "body_preview": "Updated shared note"}],
    )

    assert first_signature != second_signature


def test_album_payload_track_signature_tracks_overlay_changes():
    track = SimpleNamespace(
        path="C:/Music/Artist One/Album One/01.mp3",
        title="Track One",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Artist One",
        album="Album One",
        album_artist="Artist One",
        year=2001,
        release_date="2001-01-01",
        edition="",
        album_rating=8,
        exception_type=None,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        duration_seconds=180,
        track_preference_overlay={"rating": 4},
        playback_state_overlay=None,
        track_scrobble_count=2,
        track_popularity={"score": 5},
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
    )

    first_signature = _album_payload_track_signature(track)
    track.track_preference_overlay = {"rating": 5}
    second_signature = _album_payload_track_signature(track)

    assert first_signature != second_signature


def test_build_album_detail_track_payloads_reuses_track_serializers(monkeypatch):
    album = SimpleNamespace(
        tracks=[
            SimpleNamespace(path="C:/Music/Artist One/Album One/01.mp3"),
            SimpleNamespace(path="C:/Music/Artist One/Album One/02.mp3"),
        ],
    )
    expected_album = album

    seen_tracks = []

    def fake_track_to_dict(track):
        seen_tracks.append(track.path)
        return {"path": track.path}

    def fake_build_track_rows(
        tracks, *, album, client_surface_class, viewer_opinion_preferences
    ):
        assert list(tracks) == expected_album.tracks
        assert album is expected_album
        assert client_surface_class == "private_web"
        assert viewer_opinion_preferences == {"show_rated": True}
        return [{"row": "ok"}]

    monkeypatch.setattr("music_app.services.library._track_to_dict", fake_track_to_dict)
    monkeypatch.setattr("music_app.services.library.build_track_rows", fake_build_track_rows)

    track_payloads, track_rows = _build_album_detail_track_payloads(
        album,
        client_surface_class="private_web",
        viewer_opinion_preferences={"show_rated": True},
    )

    assert seen_tracks == [
        "C:/Music/Artist One/Album One/01.mp3",
        "C:/Music/Artist One/Album One/02.mp3",
    ]
    assert track_payloads == [
        {"path": "C:/Music/Artist One/Album One/01.mp3"},
        {"path": "C:/Music/Artist One/Album One/02.mp3"},
    ]
    assert track_rows == [{"row": "ok"}]


def test_build_album_detail_gallery_list_block_injects_summary_opinion_payloads(monkeypatch):
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        year=2001,
        album_rating=8,
        total_duration_seconds=180,
    )

    def fake_build_album_gallery_list_block(**kwargs):
        assert kwargs["album_key"] == "album-1"
        assert kwargs["track_count"] == 2
        assert kwargs["track_rows_source"] == "inline"
        return {"summary": {"album_preference": kwargs["album_preference"]}, "track_rows": kwargs["track_rows"]}

    monkeypatch.setattr(
        "music_app.services.library.build_album_gallery_list_block",
        fake_build_album_gallery_list_block,
    )

    gallery_list_block = _build_album_detail_gallery_list_block(
        album,
        track_rows=[{"title": "Track One"}, {"title": "Track Two"}],
        album_preference={"rating": None},
        tag_album_rating=8,
        tag_album_rating_source="tag",
        crowd_opinion={"average_rating": 4.2},
        friends_opinion={"friend_count": 2},
        album_popularity={"score": 9},
    )

    assert gallery_list_block["summary"]["crowd_opinion"] == {"average_rating": 4.2}
    assert gallery_list_block["summary"]["friends_opinion"] == {"friend_count": 2}
    assert gallery_list_block["summary"]["album_popularity"] == {"score": 9}


def test_build_album_opinion_payloads_reuses_viewer_preferences(monkeypatch):
    album = SimpleNamespace(key="album-1")
    seen_preferences = []

    def fake_crowd_opinion_payload(target_album, *, viewer_opinion_preferences):
        assert target_album is album
        seen_preferences.append(("crowd", viewer_opinion_preferences))
        return {"average_rating": 4.2}

    def fake_friends_opinion_payload(target_album, *, viewer_opinion_preferences):
        assert target_album is album
        seen_preferences.append(("friends", viewer_opinion_preferences))
        return {"friend_count": 2}

    def fake_album_popularity_payload(target_album, *, viewer_opinion_preferences):
        assert target_album is album
        seen_preferences.append(("popularity", viewer_opinion_preferences))
        return {"score": 9}

    monkeypatch.setattr(
        "music_app.services.library.build_crowd_opinion_payload",
        fake_crowd_opinion_payload,
    )
    monkeypatch.setattr(
        "music_app.services.library.build_friends_opinion_payload",
        fake_friends_opinion_payload,
    )
    monkeypatch.setattr(
        "music_app.services.library.build_album_popularity_payload",
        fake_album_popularity_payload,
    )

    crowd_opinion, friends_opinion, album_popularity = _build_album_opinion_payloads(
        album,
        viewer_opinion_preferences={"show_rated": True},
    )

    assert seen_preferences == [
        ("crowd", {"show_rated": True}),
        ("friends", {"show_rated": True}),
        ("popularity", {"show_rated": True}),
    ]
    assert crowd_opinion == {"average_rating": 4.2}
    assert friends_opinion == {"friend_count": 2}
    assert album_popularity == {"score": 9}


def test_album_preview_to_dict_reuses_shared_opinion_payloads(monkeypatch):
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2001,
        release_date="2001-01-01",
        edition="",
        album_rating=8,
        total_duration_seconds=180,
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        tracks=[],
    )
    seen_preferences = []

    def fake_build_album_opinion_payloads(target_album, *, viewer_opinion_preferences):
        assert target_album is album
        seen_preferences.append(viewer_opinion_preferences)
        return (
            {"average_rating": 4.2},
            {"friend_count": 2},
            {"score": 9},
        )

    def fail_if_called(*args, **kwargs):
        raise AssertionError("preview should use the shared opinion helper")

    monkeypatch.setattr(
        "music_app.services.library._build_album_opinion_payloads",
        fake_build_album_opinion_payloads,
    )
    monkeypatch.setattr(
        "music_app.services.library.build_crowd_opinion_payload",
        fail_if_called,
    )
    monkeypatch.setattr(
        "music_app.services.library.build_friends_opinion_payload",
        fail_if_called,
    )
    monkeypatch.setattr(
        "music_app.services.library.build_album_popularity_payload",
        fail_if_called,
    )

    payload = album_preview_to_dict(album)

    assert len(seen_preferences) == 1
    assert seen_preferences[0]["show_crowd_opinion"] is False
    assert seen_preferences[0]["show_friends_opinions"] is False
    assert payload["gallery_list_block"]["summary"]["crowd_opinion"] == {"average_rating": 4.2}
    assert payload["gallery_list_block"]["summary"]["friends_opinion"] == {"friend_count": 2}
    assert payload["gallery_list_block"]["summary"]["album_popularity"] == {"score": 9}


def test_album_preview_to_dict_accepts_explicit_config_and_viewer_preferences_without_framework_context(
    explicit_config,
    monkeypatch,
):
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2001,
        release_date="2001-01-01",
        edition="",
        album_rating=8,
        total_duration_seconds=180,
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        tracks=[],
    )
    seen_preferences: list[dict[str, object]] = []
    seen_move_configs: list[object] = []

    def fake_build_move_availability_payload(target_album, config):
        assert target_album is album
        seen_move_configs.append(config)
        return {"can_move": True, "reason": "explicit-config"}

    def fake_build_album_opinion_payloads(target_album, *, viewer_opinion_preferences):
        assert target_album is album
        seen_preferences.append(viewer_opinion_preferences)
        return (
            {"average_rating": 4.2},
            {"friend_count": 2},
            {"score": 9},
        )

    monkeypatch.setattr(
        "music_app.services.library.build_move_availability_payload",
        fake_build_move_availability_payload,
    )
    monkeypatch.setattr(
        "music_app.services.library._build_album_opinion_payloads",
        fake_build_album_opinion_payloads,
    )

    payload = album_preview_to_dict(
        album,
        config=explicit_config,
        viewer_opinion_preferences={"show_crowd_opinion": True},
        include_album_note_seams=False,
    )

    assert seen_move_configs == [explicit_config]
    assert len(seen_preferences) == 1
    assert seen_preferences[0]["show_crowd_opinion"] is True
    assert payload["move_availability"] == {"can_move": True, "reason": "explicit-config"}
    assert payload["gallery_list_block"]["summary"]["crowd_opinion"] == {"average_rating": 4.2}


def test_album_preview_to_dict_omitted_config_leaves_move_availability_none_without_explicit_config(monkeypatch):
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        is_compilation=False,
        cover_path=None,
        local_cover_width=None,
        local_cover_height=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year=2001,
        release_date="2001-01-01",
        edition="",
        album_rating=8,
        total_duration_seconds=180,
        library_root_id=None,
        library_root_category=None,
        root_provenance=None,
        tracks=[],
    )

    def fail_if_called(target_album, config):
        raise AssertionError("move availability should require explicit config")

    monkeypatch.setattr(
        "music_app.services.library.build_move_availability_payload",
        fail_if_called,
    )

    payload = album_preview_to_dict(album, include_album_note_seams=False)

    assert payload["move_availability"] is None
    assert payload["gallery_list_block"]["summary"]["title"] == "Album One"


def test_build_album_preview_gallery_list_block_initializes_default_preview_block(monkeypatch):
    seen_kwargs = {}

    def fake_build_album_gallery_list_block(**kwargs):
        seen_kwargs.update(kwargs)
        return {
            "summary": {
                "title": kwargs["album_name"],
            },
            "track_rows": kwargs["track_rows"],
            "track_rows_source": kwargs["track_rows_source"],
        }

    monkeypatch.setattr(
        "music_app.services.library.build_album_gallery_list_block",
        fake_build_album_gallery_list_block,
    )

    gallery_list_block = _build_album_preview_gallery_list_block(
        album_key="album-1",
        album_name="Album One",
        album_artist="Artist One",
        album_year=2001,
        album_rating=8,
        total_duration_seconds=180,
        track_count=2,
        album_preference={"rating": None, "to_listen": True},
        tag_album_rating=8,
        tag_album_rating_source="tag",
    )

    assert seen_kwargs == {
        "album_key": "album-1",
        "album_name": "Album One",
        "album_artist": "Artist One",
        "album_year": 2001,
        "album_rating": 8,
        "total_duration_seconds": 180,
        "track_count": 2,
        "track_rows": [],
        "track_rows_source": "album_details",
        "album_preference": {"rating": None, "to_listen": True},
        "tag_album_rating": 8,
        "tag_album_rating_source": "tag",
    }
    assert gallery_list_block["summary"]["album_preference"] == {
        "rating": None,
        "to_listen": True,
    }


def test_build_album_preview_gallery_list_block_normalizes_existing_summary_album_preference():
    gallery_list_block = _build_album_preview_gallery_list_block(
        album_key="album-1",
        album_name="Album One",
        album_artist="Artist One",
        album_year=2001,
        album_rating=8,
        total_duration_seconds=180,
        track_count=2,
        album_preference={"rating": None, "to_listen": False},
        tag_album_rating=8,
        tag_album_rating_source="tag",
        gallery_list_block={
            "summary": {
                "album_preference": {
                    "to_listen": 1,
                    "can_toggle_to_listen": 1,
                },
            },
            "track_rows": [],
        },
    )

    assert gallery_list_block["summary"]["album_preference"] == {
        "rating": None,
        "favorite_override": None,
        "is_favorite": False,
        "favorite_source": None,
        "can_edit": False,
        "to_listen": True,
        "is_relisten": False,
        "can_toggle_to_listen": True,
    }


def test_normalize_album_preview_payload_applies_shared_preview_defaults(monkeypatch):
    monkeypatch.setattr(
        "music_app.services.library._build_album_preview_gallery_list_block",
        lambda **kwargs: {"summary": {"title": kwargs["album_name"]}, "track_rows": []},
    )

    payload = _normalize_album_preview_payload(
        {
            "key": "album-1",
            "name": "Album One",
            "album_artist": "Artist One",
            "album_rating": 8,
            "total_duration_seconds": 180,
        },
        track_count=1,
        open_directory_paths=["C:/Music/Artist One/Album One"],
    )

    assert payload["album_ref"] == "album-1"
    assert payload["artists"] == []
    assert payload["is_compilation"] is False
    assert payload["track_count_preview"] == 1
    assert payload["open_directory_paths"] == ["C:/Music/Artist One/Album One"]
    assert payload["preview_only"] is True
    assert payload["has_duplicate_files"] is False
    assert payload["duplicate_sources"] == []
    assert payload["tracks"] == []
    assert payload["tag_album_rating"] == 8
    assert payload["tag_album_rating_source"] == "file_tag"
    assert payload["gallery_list_block"] == {
        "summary": {"title": "Album One"},
        "track_rows": [],
    }


def test_normalize_album_preview_payload_deduplicates_card_artist_without_changing_identity():
    raw_artist = (
        "Frank Churchill / Leigh Harline / Larry Morey / "
        "Frank Churchill / Larry Morey"
    )
    payload = _normalize_album_preview_payload(
        {
            "key": f"{raw_artist.casefold()}::snow-white-and-the-seven-dwarfs",
            "name": "Snow White And The Seven Dwarfs",
            "album_artist": raw_artist,
            "artists": [
                "Frank Churchill / Leigh Harline / Larry Morey",
                "Frank Churchill / Larry Morey",
            ],
            "year": 1937,
        },
        track_count=26,
        open_directory_paths=[],
    )

    assert payload["album_artist"] == "Frank Churchill / Leigh Harline / Larry Morey"
    assert payload["artists"] == [
        "Frank Churchill / Leigh Harline / Larry Morey",
        "Frank Churchill / Larry Morey",
    ]
    assert payload["key"] == (
        f"{raw_artist.casefold()}::snow-white-and-the-seven-dwarfs"
    )


def test_build_album_detail_setup_payloads_uses_duplicate_sources_and_explicit_config_move_availability(
    explicit_config,
    monkeypatch,
):
    album = SimpleNamespace(key="album-1")

    def fake_get_album_duplicate_sources(target_album):
        assert target_album is album
        return [{"label": "1", "tracks": []}]

    def fake_build_move_availability_payload(target_album, config):
        assert target_album is album
        assert config is explicit_config
        return {"can_move": True}

    monkeypatch.setattr(
        "music_app.services.library.get_album_duplicate_sources",
        fake_get_album_duplicate_sources,
    )
    monkeypatch.setattr(
        "music_app.services.library.build_move_availability_payload",
        fake_build_move_availability_payload,
    )

    duplicate_sources, move_availability = _build_album_detail_setup_payloads(album, config=explicit_config)

    assert duplicate_sources == [{"label": "1", "tracks": []}]
    assert move_availability == {"can_move": True}


def test_build_album_detail_setup_payloads_omitted_config_leaves_move_availability_none_without_explicit_config(
    monkeypatch,
):
    album = SimpleNamespace(key="album-1")

    monkeypatch.setattr(
        "music_app.services.library.get_album_duplicate_sources",
        lambda target_album: [{"label": "1", "tracks": []}],
    )

    def fail_if_called(target_album, config):
        raise AssertionError("move availability should require explicit config")

    monkeypatch.setattr(
        "music_app.services.library.build_move_availability_payload",
        fail_if_called,
    )

    duplicate_sources, move_availability = _build_album_detail_setup_payloads(album)

    assert duplicate_sources == [{"label": "1", "tracks": []}]
    assert move_availability is None


def test_get_album_duplicate_sources_emits_sorted_folder_payloads(monkeypatch):
    serialized_titles: list[str] = []

    def fake_track_to_dict(track):
        serialized_titles.append(track.title)
        return {"title": track.title}

    monkeypatch.setattr("music_app.services.library._track_to_dict", fake_track_to_dict)

    first_folder_path = "C:/Music/Artist One/Album One"
    second_folder_path = "C:/Music/Artist One/Album One Copy"
    expected_first_folder_path = str(Path(first_folder_path))
    expected_second_folder_path = str(Path(second_folder_path))
    first_folder_tracks = [
        SimpleNamespace(
            path=f"{first_folder_path}/disc2/02 - Beta.mp3",
            disc_number=2,
            track_number=2,
            title="Beta",
            duration_seconds=200,
            artist="Artist One",
            album_artist="Artist One",
            album="Album One",
            year=2001,
            release_date="2001-01-01",
            edition="",
            cover_path=None,
        ),
        SimpleNamespace(
            path=f"{first_folder_path}/disc1/01 - Alpha.mp3",
            disc_number=1,
            track_number=1,
            title="Alpha",
            duration_seconds=180,
            artist="Artist One",
            album_artist="Artist One",
            album="Album One",
            year=2001,
            release_date="2001-01-01",
            edition="",
            cover_path=None,
        ),
    ]
    second_folder_tracks = [
        SimpleNamespace(
            path=f"{second_folder_path}/01 - Alpha.mp3",
            disc_number=1,
            track_number=1,
            title="Alpha",
            duration_seconds=180,
            artist="Artist One",
            album_artist="Artist One",
            album="Album One",
            year=2001,
            release_date="2001-01-01",
            edition="",
            cover_path=None,
        ),
        SimpleNamespace(
            path=f"{second_folder_path}/02 - Beta.mp3",
            disc_number=2,
            track_number=2,
            title="Beta",
            duration_seconds=200,
            artist="Artist One",
            album_artist="Artist One",
            album="Album One",
            year=2001,
            release_date="2001-01-01",
            edition="",
            cover_path=None,
        ),
    ]

    album = SimpleNamespace(tracks=[*first_folder_tracks, *second_folder_tracks])

    payload = get_album_duplicate_sources(album)

    assert payload == [
        {
            "index": 0,
            "label": "1",
            "folder_path": expected_first_folder_path,
            "folder_name": "Album One",
            "track_count": 2,
            "total_duration_seconds": 380,
            "total_duration_display": "6m 20s",
            "tracks": [{"title": "Alpha"}, {"title": "Beta"}],
        },
        {
            "index": 1,
            "label": "2",
            "folder_path": expected_second_folder_path,
            "folder_name": "Album One Copy",
            "track_count": 2,
            "total_duration_seconds": 380,
            "total_duration_display": "6m 20s",
            "tracks": [{"title": "Alpha"}, {"title": "Beta"}],
        },
    ]
    assert serialized_titles == ["Alpha", "Beta", "Alpha", "Beta"]


def test_get_album_duplicate_sources_rejects_mismatched_folder_track_groups(monkeypatch):
    serialized_titles: list[str] = []

    def fake_track_to_dict(track):
        serialized_titles.append(track.title)
        return {"title": track.title}

    monkeypatch.setattr("music_app.services.library._track_to_dict", fake_track_to_dict)

    first_folder_path = "C:/Music/Artist One/Album One"
    second_folder_path = "C:/Music/Artist One/Album One Copy"
    album = SimpleNamespace(
        tracks=[
            SimpleNamespace(
                path=f"{first_folder_path}/01 - Alpha.mp3",
                disc_number=1,
                track_number=1,
                title="Alpha",
                duration_seconds=180,
                artist="Artist One",
                album_artist="Artist One",
                album="Album One",
                year=2001,
                release_date="2001-01-01",
                edition="",
                cover_path=None,
            ),
            SimpleNamespace(
                path=f"{second_folder_path}/01 - Gamma.mp3",
                disc_number=1,
                track_number=1,
                title="Gamma",
                duration_seconds=180,
                artist="Artist One",
                album_artist="Artist One",
                album="Album One",
                year=2001,
                release_date="2001-01-01",
                edition="",
                cover_path=None,
            ),
        ]
    )

    payload = get_album_duplicate_sources(album)

    assert payload == []
    assert getattr(album, "_cached_duplicate_sources") == []
    assert serialized_titles == []


def test_build_album_base_payload_keeps_shared_album_fields():
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One", "Artist Two"],
        is_compilation=True,
        cover_path="C:/Music/Artist One/Album One/cover.jpg",
        local_cover_width=600,
        local_cover_height=600,
        remote_cover_url="https://example.com/cover.jpg",
        remote_cover_thumbnail_url="https://example.com/cover-thumb.jpg",
        remote_cover_source="provider",
        remote_cover_source_label="Provider",
        remote_cover_album_url="https://example.com/album",
        remote_cover_width=1200,
        remote_cover_height=1200,
        year=2001,
        release_date="2001-01-01",
        edition="Deluxe",
        album_rating=8,
        total_duration_seconds=180,
        library_root_id="root-1",
        library_root_category="main_library",
        root_provenance={"root_id": "root-1"},
    )

    payload = _build_album_base_payload(
        album,
        album_ref="album-1",
        album_preference={"rating": None},
        tag_album_rating=8,
        tag_album_rating_source="file_tag",
        move_availability={"can_move": True},
    )

    assert payload["album_ref"] == "album-1"
    assert payload["name"] == "Album One"
    assert payload["artists"] == ["Artist One", "Artist Two"]
    assert payload["is_compilation"] is True
    assert payload["cover_path"] == "C:/Music/Artist One/Album One/cover.jpg"
    assert payload["album_preference"] == {"rating": None}
    assert payload["tag_album_rating"] == 8
    assert payload["tag_album_rating_source"] == "file_tag"
    assert payload["total_duration_display"] == "3m 00s"
    assert payload["library_root_id"] == "root-1"
    assert payload["move_availability"] == {"can_move": True}


@pytest.mark.parametrize(
    ("stored_origin", "expected_origin"),
    [("user", "user"), ("automatic", "automatic"), ("legacy", None), ("", None)],
)
def test_album_payload_normalizes_cover_selection_origin(stored_origin, expected_origin):
    album = SimpleNamespace(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        is_compilation=False,
        cover_path=None,
        cover_selection_origin=stored_origin,
        year=2001,
        release_date=None,
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[],
    )

    payload = _build_album_base_payload(
        album,
        album_ref="album-1",
        album_preference={"rating": None},
        tag_album_rating=None,
        tag_album_rating_source=None,
        move_availability=None,
    )

    assert payload["cover_selection_origin"] == expected_origin


def test_apply_album_display_metadata_if_present_sets_metadata_only_when_present(monkeypatch):
    payload = {"key": "album-1"}

    monkeypatch.setattr(
        "music_app.services.library.build_album_display_metadata_payload",
        lambda album: {"display_country": {"name": "Japan", "code": "JP"}},
    )
    monkeypatch.setattr(
        "music_app.services.library.has_album_display_metadata_values",
        lambda metadata: bool(metadata),
    )

    updated_payload = _apply_album_display_metadata_if_present(payload, {"key": "album-1"})

    assert updated_payload["album_display_metadata"] == {
        "display_country": {"name": "Japan", "code": "JP"},
    }

    monkeypatch.setattr(
        "music_app.services.library.build_album_display_metadata_payload",
        lambda album: {},
    )

    unchanged_payload = _apply_album_display_metadata_if_present({"key": "album-2"}, {"key": "album-2"})

    assert "album_display_metadata" not in unchanged_payload


def test_apply_gallery_summary_opinion_payloads_sets_summary_fields():
    gallery_list_block = {"summary": {"title": "Album One"}}

    updated_block = _apply_gallery_summary_opinion_payloads(
        gallery_list_block,
        crowd_opinion={"average_rating": 4.2},
        friends_opinion={"friend_count": 2},
        album_popularity={"score": 9},
    )

    assert updated_block["summary"]["crowd_opinion"] == {"average_rating": 4.2}
    assert updated_block["summary"]["friends_opinion"] == {"friend_count": 2}
    assert updated_block["summary"]["album_popularity"] == {"score": 9}


def test_apply_album_note_seams_respects_enabled_flag():
    base_payload = {"key": "album-1"}

    disabled_payload = _apply_album_note_seams(
        dict(base_payload),
        album_note_payload={"note_ref": "note-1"},
        visible_album_notes_payload=[{"note_ref": "note-2"}],
        enabled=False,
    )
    enabled_payload = _apply_album_note_seams(
        dict(base_payload),
        album_note_payload={"note_ref": "note-1"},
        visible_album_notes_payload=[{"note_ref": "note-2"}],
        enabled=True,
    )

    assert "album_note" not in disabled_payload
    assert "visible_album_notes" not in disabled_payload
    assert enabled_payload["album_note"] == {"note_ref": "note-1"}
    assert enabled_payload["visible_album_notes"] == [{"note_ref": "note-2"}]


def test_finalize_album_payload_for_viewer_only_strips_private_fields_for_public_safe_payloads():
    payload = {
        "album_note": {"note_ref": "note-1"},
        "visible_album_notes": [{"note_ref": "note-2"}],
        "album_preference": {"rating": 5},
        "top_viewer_overlay": {"item_progress": {"progress_state": "active"}},
        "crowd_opinion": {"average_rating": 4.0},
        "friends_opinion": {"friend_count": 2},
        "album_popularity": {"score": 9},
        "track_rows": [],
    }

    assert _finalize_album_payload_for_viewer(payload, public_safe=False) is payload
    public_payload = _finalize_album_payload_for_viewer(payload, public_safe=True)
    assert "album_note" not in public_payload
    assert "visible_album_notes" not in public_payload


def _top_album(
    key: str,
    *,
    app_rating: int | None = None,
    tag_rating: int | None = None,
    progress_state: str = "not_started",
    follow_up_state: str = "none",
    hide_rated: bool = False,
    hide_listened: bool = False,
    action_needed_focus: bool = False,
) -> dict[str, object]:
    return {
        "key": key,
        "album_rating": tag_rating or 0,
        "album_preference": {
            "rating": app_rating,
            "favorite_override": None,
            "is_favorite": False,
            "favorite_source": None,
            "can_edit": False,
            "to_listen": False,
            "is_relisten": False,
            "can_toggle_to_listen": False,
        },
        "top_viewer_overlay": {
            "item_progress": {
                "effective_baseline_at": "2026-06-09T12:00:00Z",
                "baseline_rating": None,
                "progress_state": progress_state,
                "follow_up_state": follow_up_state,
            },
            "viewer_filters": {
                "hide_rated_albums": hide_rated,
                "hide_listened_albums": hide_listened,
                "action_needed_focus": action_needed_focus,
            },
            "can_edit_viewer_filters": False,
        },
    }


def test_filter_album_top_items_uses_app_owned_rating_for_hide_rated():
    albums = [
        _top_album("tag-only-rated", tag_rating=9, hide_rated=True),
        _top_album("app-rated", app_rating=8, tag_rating=0, hide_rated=True),
        _top_album("unrated", hide_rated=True),
    ]

    visible = filter_album_top_items_for_viewer(albums)

    assert [album["key"] for album in visible] == [
        "tag-only-rated",
        "unrated",
    ]


def test_filter_album_top_items_hides_only_completed_items_for_hide_listened():
    albums = [
        _top_album(
            "completed",
            progress_state="completed",
            follow_up_state="none",
            hide_listened=True,
        ),
        _top_album(
            "needs-rating",
            progress_state="active",
            follow_up_state="needs_rating",
            hide_listened=True,
        ),
        _top_album(
            "needs-relisten-clear",
            progress_state="active",
            follow_up_state="needs_relisten_clear",
            hide_listened=True,
        ),
    ]

    visible = filter_album_top_items_for_viewer(albums)

    assert [album["key"] for album in visible] == [
        "needs-rating",
        "needs-relisten-clear",
    ]


def test_filter_album_top_items_action_needed_focus_keeps_relisten_follow_up_visible():
    albums = [
        _top_album(
            "needs-rating",
            progress_state="active",
            follow_up_state="needs_rating",
            hide_rated=True,
            action_needed_focus=True,
        ),
        _top_album(
            "needs-relisten-clear",
            app_rating=10,
            progress_state="active",
            follow_up_state="needs_relisten_clear",
            hide_rated=True,
            action_needed_focus=True,
        ),
        _top_album(
            "completed",
            app_rating=9,
            progress_state="completed",
            follow_up_state="none",
            hide_rated=True,
            action_needed_focus=True,
        ),
    ]

    visible = filter_album_top_items_for_viewer(albums)

    assert [album["key"] for album in visible] == [
        "needs-rating",
        "needs-relisten-clear",
    ]


def test_album_preview_to_dict_normalizes_viewer_scoped_listen_through_contract():
    payload = album_preview_to_dict(
        {
            "key": "listen-through-1",
            "name": "Listen Through One",
            "album_artist": "Viewer Artist",
            "artists": ["Viewer Artist"],
            "album_rating": 7,
            "tracks": [],
            "album_preference": {
                "to_listen": True,
                "can_toggle_to_listen": True,
            },
            "top_viewer_overlay": {
                "item_progress": {
                    "progress_state": "ACTIVE",
                    "follow_up_state": "needs_rating",
                },
                "viewer_filters": {
                    "hide_rated_albums": 1,
                },
            },
            "gallery_list_block": {
                "block_kind": "album",
                "album_key": "listen-through-1",
                "summary": {
                    "title": "Listen Through One",
                    "album_artist": "Viewer Artist",
                    "year": 2004,
                    "album_rating": 7,
                },
                "track_rows_source": "album_details",
                "track_rows": [],
                "trailing_divider": {
                    "total_duration_seconds": 0,
                    "total_duration_display": "0s",
                },
            },
        }
    )

    assert payload["album_preference"] == {
        "rating": None,
        "favorite_override": None,
        "is_favorite": False,
        "favorite_source": None,
        "can_edit": False,
        "to_listen": True,
        "is_relisten": False,
        "can_toggle_to_listen": True,
    }
    assert payload["top_viewer_overlay"] == {
        "item_progress": {
            "effective_baseline_at": None,
            "baseline_rating": None,
            "progress_state": "active",
            "follow_up_state": "needs_rating",
        },
        "viewer_filters": {
            "hide_rated_albums": True,
            "hide_listened_albums": False,
            "action_needed_focus": False,
        },
        "can_edit_viewer_filters": False,
    }
    assert payload["gallery_list_block"]["summary"]["album_preference"] == payload["album_preference"]
