from __future__ import annotations

import hashlib

import pytest

from music_app.services.cue_program import (
    CueIndex,
    parse_cue_program,
    resolve_cue_timeline,
)


def test_parse_inherits_album_fields_and_accepts_quoted_and_unquoted_files():
    text = """TITLE "Album Title"
PERFORMER "Album Artist"
REM GENRE "Modern Classical"
FILE "disc one.flac" WAVE
  TRACK 01 AUDIO
    TITLE "Opening"
    INDEX 01 00:00:00
FILE disc-two.flac WAVE
  TRACK 02 AUDIO
    TITLE "Finale"
    PERFORMER "Guest"
    INDEX 01 00:00:00
"""

    program = parse_cue_program(text, source_name="album.cue")

    assert program.album_title == "Album Title"
    assert program.performer == "Album Artist"
    assert program.files == ("disc one.flac", "disc-two.flac")
    assert [(track.title, track.performer, track.source_ref) for track in program.tracks] == [
        ("Opening", "Album Artist", "disc one.flac"),
        ("Finale", "Guest", "disc-two.flac"),
    ]
    assert program.provenance == (("REM", "GENRE", "Modern Classical"),)
    assert program.revision_sha256 == hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert program.problems == ()


def test_parse_preserves_indexes_pregap_postgap_and_non_audio_problem():
    program = parse_cue_program(
        """FILE image.bin BINARY
  TRACK 01 MODE1/2352
    INDEX 01 00:00:00
FILE image.flac WAVE
  TRACK 02 AUDIO
    PREGAP 00:02:00
    INDEX 00 00:00:00
    INDEX 01 00:02:00
    INDEX 02 00:30:00
    POSTGAP 00:01:00
""",
        source_name="mixed.cue",
    )

    assert program.tracks[0].mode == "MODE1/2352"
    assert any("non-audio" in problem.lower() for problem in program.problems)
    audio = program.tracks[1]
    assert audio.indexes == (CueIndex(0, 0), CueIndex(1, 150), CueIndex(2, 2250))
    assert audio.pregap_frames == 150
    assert audio.postgap_frames == 75


def test_parse_keeps_musicbrainz_identity_with_the_track():
    program = parse_cue_program(
        'FILE "image.flac" WAVE\n'
        '  TRACK 01 AUDIO\n'
        '    REM MUSICBRAINZ_TRACKID 12345678-1234-1234-1234-123456789abc\n'
        '    INDEX 01 00:00:00\n',
        source_name="album.cue",
    )

    assert program.tracks[0].provenance == (
        ("REM", "MUSICBRAINZ_TRACKID", "12345678-1234-1234-1234-123456789abc"),
    )
    assert program.provenance == ()


def test_resolve_uses_next_index01_and_decoded_final_duration():
    parsed = parse_cue_program(
        """TITLE "Album"
FILE image.flac WAVE
  TRACK 01 AUDIO
    TITLE "One"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Two"
    INDEX 00 03:00:00
    INDEX 01 03:02:00
    INDEX 02 03:30:00
""",
        source_name="album.cue",
    )

    resolved = resolve_cue_timeline(parsed, media_frames={"image.flac": 30_000})

    first, second = resolved.tracks
    assert (first.start_frame, first.end_frame) == (0, 13_650)
    assert (second.start_frame, second.end_frame) == (13_650, 30_000)
    assert second.pregap_frames == 150
    assert second.indexes[-1] == CueIndex(2, 15_750)
    assert resolved.problems == ()


def test_resolve_multi_file_tracks_end_at_each_source_duration():
    parsed = parse_cue_program(
        """FILE disc1.flac WAVE
  TRACK 01 AUDIO
    INDEX 01 00:00:00
FILE disc2.flac WAVE
  TRACK 02 AUDIO
    INDEX 01 00:00:00
""",
        source_name="album.cue",
    )

    resolved = resolve_cue_timeline(parsed, media_frames={"disc1.flac": 4_500, "disc2.flac": 6_000})

    assert [(track.source_ref, track.start_frame, track.end_frame) for track in resolved.tracks] == [
        ("disc1.flac", 0, 4_500),
        ("disc2.flac", 0, 6_000),
    ]


def test_resolve_projects_hidden_track_one_audio_as_track_zero():
    parsed = parse_cue_program(
        """TITLE "Album"
PERFORMER "Artist"
FILE image.flac WAVE
  TRACK 01 AUDIO
    TITLE "First listed track"
    INDEX 00 00:00:00
    INDEX 01 00:02:00
""",
        source_name="album.cue",
    )

    resolved = resolve_cue_timeline(parsed, media_frames={"image.flac": 9_000})

    hidden, first = resolved.tracks
    assert (hidden.number, hidden.title, hidden.performer) == (0, "Hidden Track One Audio", "Artist")
    assert (hidden.start_frame, hidden.end_frame) == (0, 150)
    assert (first.start_frame, first.end_frame) == (150, 9_000)


@pytest.mark.parametrize("timestamp", ["00:60:00", "00:00:75", "-1:00:00", "broken"])
def test_parse_reports_invalid_timestamps(timestamp):
    program = parse_cue_program(
        f"FILE image.flac WAVE\n  TRACK 01 AUDIO\n    INDEX 01 {timestamp}\n",
        source_name="bad.cue",
    )

    assert any("timestamp" in problem.lower() for problem in program.problems)


def test_parse_and_resolve_report_missing_and_descending_boundaries():
    parsed = parse_cue_program(
        """FILE image.flac WAVE
  TRACK 01 AUDIO
    INDEX 01 03:00:00
    INDEX 02 02:59:00
  TRACK 02 AUDIO
    INDEX 01 02:00:00
  TRACK 03 AUDIO
""",
        source_name="bad.cue",
    )
    resolved = resolve_cue_timeline(parsed, media_frames={"image.flac": 20_000})

    joined = " ".join(resolved.problems).lower()
    assert "descending" in joined
    assert "track 03" in joined and "index 01" in joined
    assert "overlap" in joined


def test_parse_reports_malformed_quoted_line_without_raising():
    program = parse_cue_program(
        'FILE "unterminated.flac WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n',
        source_name="bad.cue",
    )

    assert program.tracks
    assert any("malformed" in problem.lower() for problem in program.problems)


def test_cue_models_are_immutable():
    program = parse_cue_program(
        "FILE image.flac WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n",
        source_name="album.cue",
    )

    with pytest.raises((AttributeError, TypeError)):
        program.tracks[0].start_frame = 1


def test_cue_text_decodes_utf8_russian_windows_1251_and_western_windows_1252():
    from music_app.services.cue_program import decode_cue_text

    assert decode_cue_text('PERFORMER "ДДТ"'.encode("utf-8")) == 'PERFORMER "ДДТ"'
    assert decode_cue_text('TITLE "Студийные записи"'.encode("cp1251")) == 'TITLE "Студийные записи"'
    assert decode_cue_text('PERFORMER "Björk"'.encode("cp1252")) == 'PERFORMER "Björk"'
