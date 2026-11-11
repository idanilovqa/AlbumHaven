"""Side-effect-free CUE parsing and frame-accurate timeline resolution."""

from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import shlex
from typing import Mapping


@dataclass(frozen=True, slots=True)
class CueIndex:
    number: int
    frame: int


@dataclass(frozen=True, slots=True)
class CueTrack:
    number: int
    mode: str
    title: str | None
    performer: str | None
    source_ref: str | None
    indexes: tuple[CueIndex, ...]
    pregap_frames: int | None = None
    postgap_frames: int | None = None
    start_frame: int | None = None
    end_frame: int | None = None


@dataclass(frozen=True, slots=True)
class CueProgram:
    album_title: str | None
    performer: str | None
    files: tuple[str, ...]
    tracks: tuple[CueTrack, ...]
    revision_sha256: str
    problems: tuple[str, ...]
    provenance: tuple[tuple[str, ...], ...] = ()
    source_name: str = ""


def _tokens(line: str) -> list[str]:
    lexer = shlex.shlex(line, posix=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    lexer.escape = ""
    return list(lexer)


def _timestamp_frames(value: str, *, line_number: int, problems: list[str]) -> int | None:
    parts = value.split(":")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        problems.append(f"Line {line_number}: invalid CUE timestamp {value!r}.")
        return None
    minutes, seconds, frames = (int(part) for part in parts)
    if seconds > 59 or frames > 74:
        problems.append(f"Line {line_number}: invalid CUE timestamp {value!r}.")
        return None
    return minutes * 60 * 75 + seconds * 75 + frames


def _deduplicated(values: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(values))


def parse_cue_program(text: str, *, source_name: str) -> CueProgram:
    """Parse CUE text without resolving paths or reading media."""
    album_title: str | None = None
    album_performer: str | None = None
    current_source: str | None = None
    files: list[str] = []
    tracks: list[dict[str, object]] = []
    current_track: dict[str, object] | None = None
    problems: list[str] = []
    provenance: list[tuple[str, ...]] = []

    for line_number, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            parts = _tokens(line)
        except ValueError as error:
            problems.append(f"Line {line_number}: malformed CUE statement ({error}).")
            continue
        if not parts:
            continue
        command = parts[0].upper()

        if command == "REM":
            if len(parts) >= 2:
                provenance.append(("REM", parts[1].upper(), " ".join(parts[2:])))
            continue
        if command == "FILE":
            if len(parts) < 3:
                problems.append(f"Line {line_number}: FILE needs a source and type.")
                current_source = None
                continue
            if len(parts) > 3:
                problems.append(f"Line {line_number}: unquoted FILE source is ambiguous.")
            current_source = parts[1]
            if current_source not in files:
                files.append(current_source)
            current_track = None
            continue
        if command == "TRACK":
            try:
                number = int(parts[1])
                mode = parts[2].upper()
            except (IndexError, ValueError):
                problems.append(f"Line {line_number}: malformed TRACK statement.")
                current_track = None
                continue
            if number <= 0:
                problems.append(f"Line {line_number}: TRACK number must be positive.")
            current_track = {
                "number": number,
                "mode": mode,
                "source_ref": current_source,
                "title": None,
                "performer": None,
                "indexes": [],
                "pregap_frames": None,
                "postgap_frames": None,
            }
            tracks.append(current_track)
            if current_source is None:
                problems.append(f"Track {number:02d}: TRACK appears before FILE.")
            if mode != "AUDIO":
                problems.append(f"Track {number:02d}: non-audio mode {mode} is ignored for playback.")
            continue
        if command in {"TITLE", "PERFORMER"}:
            value = " ".join(parts[1:]).strip() or None
            if current_track is None:
                if command == "TITLE":
                    album_title = value
                else:
                    album_performer = value
            else:
                current_track[command.lower()] = value
            continue
        if command in {"INDEX", "PREGAP", "POSTGAP"}:
            if current_track is None:
                problems.append(f"Line {line_number}: {command} appears outside TRACK.")
                continue
            timestamp_position = 2 if command == "INDEX" else 1
            try:
                timestamp = parts[timestamp_position]
            except IndexError:
                problems.append(f"Line {line_number}: malformed {command} statement.")
                continue
            frame = _timestamp_frames(timestamp, line_number=line_number, problems=problems)
            if frame is None:
                continue
            if command == "INDEX":
                try:
                    index_number = int(parts[1])
                except ValueError:
                    problems.append(f"Line {line_number}: malformed INDEX number.")
                    continue
                indexes = current_track["indexes"]
                assert isinstance(indexes, list)
                indexes.append(CueIndex(index_number, frame))
            else:
                current_track[f"{command.lower()}_frames"] = frame
            continue

        # Standard metadata not needed by the timeline remains available for
        # later identity work without turning parser extensions into I/O work.
        provenance.append((command, *parts[1:]))

    cue_tracks: list[CueTrack] = []
    seen_numbers: set[int] = set()
    previous_start_by_source: dict[str, int] = {}
    for values in tracks:
        number = int(values["number"])
        mode = str(values["mode"])
        source_ref = values["source_ref"] if isinstance(values["source_ref"], str) else None
        indexes = tuple(values["indexes"])
        if number in seen_numbers:
            problems.append(f"Track {number:02d}: duplicate TRACK number.")
        seen_numbers.add(number)
        if len({index.number for index in indexes}) != len(indexes):
            problems.append(f"Track {number:02d}: duplicate INDEX number.")
        if any(right.frame < left.frame for left, right in zip(indexes, indexes[1:])):
            problems.append(f"Track {number:02d}: descending INDEX timestamps.")
        index01 = next((index.frame for index in indexes if index.number == 1), None)
        index00 = next((index.frame for index in indexes if index.number == 0), None)
        if mode == "AUDIO" and index01 is None:
            problems.append(f"Track {number:02d}: AUDIO track has no INDEX 01.")
        if index00 is not None and index01 is not None and index00 > index01:
            problems.append(f"Track {number:02d}: descending INDEX 00/01 boundary.")
        if source_ref is not None and index01 is not None:
            previous_start = previous_start_by_source.get(source_ref)
            if previous_start is not None and index01 <= previous_start:
                problems.append(f"Track {number:02d}: overlapping or descending track boundary.")
            previous_start_by_source[source_ref] = index01
        index_pregap = index01 - index00 if index00 is not None and index01 is not None else None
        explicit_pregap = values["pregap_frames"] if isinstance(values["pregap_frames"], int) else None
        if index_pregap is not None and explicit_pregap is not None and index_pregap != explicit_pregap:
            problems.append(f"Track {number:02d}: PREGAP conflicts with INDEX 00/01.")
        cue_tracks.append(CueTrack(
            number=number,
            mode=mode,
            title=values["title"] if isinstance(values["title"], str) else album_title,
            performer=values["performer"] if isinstance(values["performer"], str) else album_performer,
            source_ref=source_ref,
            indexes=indexes,
            pregap_frames=index_pregap if index_pregap is not None else explicit_pregap,
            postgap_frames=values["postgap_frames"] if isinstance(values["postgap_frames"], int) else None,
            start_frame=index01,
        ))

    return CueProgram(
        album_title=album_title,
        performer=album_performer,
        files=tuple(files),
        tracks=tuple(cue_tracks),
        revision_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        problems=_deduplicated(problems),
        provenance=tuple(provenance),
        source_name=str(source_name),
    )


def resolve_cue_timeline(program: CueProgram, *, media_frames: Mapping[str, int]) -> CueProgram:
    """Attach exclusive segment ends using decoded per-source frame counts."""
    problems = list(program.problems)
    resolved: list[CueTrack] = []
    audio_tracks = [track for track in program.tracks if track.mode == "AUDIO"]

    for position, track in enumerate(program.tracks):
        if track.mode != "AUDIO" or track.start_frame is None or track.source_ref is None:
            resolved.append(track)
            continue
        next_start = next(
            (
                candidate.start_frame
                for candidate in program.tracks[position + 1:]
                if candidate.mode == "AUDIO"
                and candidate.source_ref == track.source_ref
                and candidate.start_frame is not None
            ),
            None,
        )
        source_frames = media_frames.get(track.source_ref)
        if next_start is None:
            if not isinstance(source_frames, int) or isinstance(source_frames, bool) or source_frames < 0:
                problems.append(f"Track {track.number:02d}: decoded duration is missing for {track.source_ref}.")
                end_frame = None
            else:
                end_frame = source_frames
        else:
            end_frame = next_start
        if end_frame is not None and end_frame <= track.start_frame:
            problems.append(f"Track {track.number:02d}: overlapping or empty resolved segment.")
        if isinstance(source_frames, int) and end_frame is not None and end_frame > source_frames:
            problems.append(f"Track {track.number:02d}: segment exceeds decoded duration.")
        resolved.append(replace(track, end_frame=end_frame))

    first_audio = audio_tracks[0] if audio_tracks else None
    if first_audio is not None and first_audio.start_frame and first_audio.source_ref:
        hidden = CueTrack(
            number=0,
            mode="AUDIO",
            title="Hidden Track One Audio",
            performer=first_audio.performer or program.performer,
            source_ref=first_audio.source_ref,
            indexes=(CueIndex(1, 0),),
            start_frame=0,
            end_frame=first_audio.start_frame,
        )
        resolved.insert(program.tracks.index(first_audio), hidden)

    return replace(program, tracks=tuple(resolved), problems=_deduplicated(problems))
