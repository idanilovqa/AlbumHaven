from __future__ import annotations

from pathlib import Path

from music_app.routes.api_loop_helpers import (
    parse_pitch_semitones,
    parse_required_loop_id,
    resolve_loop_creation_source,
    validate_loop_create_payload,
)


def test_validate_loop_create_payload_requires_name_and_valid_time_window():
    assert validate_loop_create_payload({"start_seconds": 1, "end_seconds": 2}) == (
        None,
        ({"ok": False, "error": "Loop name is required"}, 400),
    )
    assert validate_loop_create_payload({"name": "Loop", "start_seconds": "bad", "end_seconds": 2}) == (
        None,
        ({"ok": False, "error": "Loop start and end times are required"}, 400),
    )
    assert validate_loop_create_payload({"name": "Loop", "start_seconds": 2, "end_seconds": 2}) == (
        None,
        ({"ok": False, "error": "Loop end must be after loop start"}, 400),
    )


def test_validate_loop_create_payload_returns_normalized_loop_fields():
    validated, error = validate_loop_create_payload(
        {
            "name": "  Chorus Loop  ",
            "source_loop_id": " parent-loop ",
            "start_seconds": "1.5",
            "end_seconds": "4.5",
        }
    )

    assert error is None
    assert validated == {
        "name": "Chorus Loop",
        "start_seconds": 1.5,
        "end_seconds": 4.5,
        "parent_loop_id": "parent-loop",
    }


def test_resolve_loop_creation_source_prefers_saved_parent_loop_metadata(tmp_path):
    source_path = tmp_path / "loops" / "parent.mp3"
    source_path.parent.mkdir()
    source_path.write_bytes(b"parent-audio")
    parent_loop = {
        "id": "parent-loop",
        "artist": "Parent Artist",
        "title": "Parent Title",
        "album": "Parent Album",
        "cover_path": "C:/covers/parent.jpg",
    }

    source_details, error = resolve_loop_creation_source(
        {"source_loop_id": "parent-loop", "source_path": "ignored"},
        config={},
        get_loop=lambda config, loop_id: parent_loop if loop_id == "parent-loop" else None,
        resolve_loop_media_path=lambda config, loop_id: source_path if loop_id == "parent-loop" else None,
        normalize_music_file_path=lambda raw_path: Path(raw_path),
        file_cache={},
    )

    assert error is None
    assert source_details == {
        "source_path": source_path,
        "artist": "Parent Artist",
        "title": "Parent Title",
        "album": "Parent Album",
        "cover_path": "C:/covers/parent.jpg",
        "parent_loop_id": "parent-loop",
    }


def test_resolve_loop_creation_source_uses_file_cache_metadata_for_track_source(tmp_path):
    source_path = tmp_path / "Artist" / "Song.mp3"
    source_path.parent.mkdir()
    source_path.write_bytes(b"source-audio")

    source_details, error = resolve_loop_creation_source(
        {"source_path": str(source_path), "artist": "Payload Artist"},
        config={},
        get_loop=lambda config, loop_id: None,
        resolve_loop_media_path=lambda config, loop_id: None,
        normalize_music_file_path=lambda raw_path: source_path if raw_path == str(source_path) else None,
        file_cache={
            str(source_path): {
                "artist": "Cached Artist",
                "title": "Cached Title",
                "album": "Cached Album",
                "cover_path": "C:/covers/cached.jpg",
            }
        },
    )

    assert error is None
    assert source_details == {
        "source_path": source_path,
        "artist": "Payload Artist",
        "title": "Cached Title",
        "album": "Cached Album",
        "cover_path": "C:/covers/cached.jpg",
        "parent_loop_id": "",
    }


def test_resolve_loop_creation_source_reports_missing_sources():
    parent_result = resolve_loop_creation_source(
        {"source_loop_id": "missing-parent"},
        config={},
        get_loop=lambda config, loop_id: {"id": loop_id},
        resolve_loop_media_path=lambda config, loop_id: None,
        normalize_music_file_path=lambda raw_path: None,
        file_cache={},
    )
    track_result = resolve_loop_creation_source(
        {"source_path": "missing.mp3"},
        config={},
        get_loop=lambda config, loop_id: None,
        resolve_loop_media_path=lambda config, loop_id: None,
        normalize_music_file_path=lambda raw_path: None,
        file_cache={},
    )

    assert parent_result == (None, ({"ok": False, "error": "Saved loop source file was not found"}, 400))
    assert track_result == (
        None,
        ({"ok": False, "error": "Source file was not found or is outside the music library"}, 400),
    )


def test_parse_required_loop_id_and_pitch_values_preserve_route_validation_contracts():
    assert parse_required_loop_id({}) == (None, ({"ok": False, "error": "Missing loop id"}, 400))
    assert parse_required_loop_id({"loop_id": " loop-1 "}) == ("loop-1", None)
    assert parse_pitch_semitones({"semitones": "bad"}) == (
        None,
        ({"ok": False, "error": "Invalid pitch value"}, 400),
    )
    assert parse_pitch_semitones({"semitones": -20}) == (-12, None)
    assert parse_pitch_semitones({"semitones": 20}) == (12, None)
    assert parse_pitch_semitones({}) == (0, None)
