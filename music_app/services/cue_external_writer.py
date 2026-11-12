"""Validated external-CUE rendering and atomic replacement."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
import stat
import tempfile
from collections.abc import Callable, Mapping, Sequence

from music_app.services.cue_program import parse_cue_program


_DIRECTIVE = re.compile(r"^(?P<indent>\s*)(?P<name>[A-Za-z]+)(?:\s+(?P<value>.*?))?(?P<ending>\r?\n)?$")
_TRACK = re.compile(r"^\s*TRACK\s+(?P<number>\d+)\s+\S+", re.IGNORECASE)


class CueExternalWriteConflict(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class RenderedExternalCue:
    source_bytes: bytes
    persisted_fields: dict[int, frozenset[str] | None]


@dataclass(frozen=True, slots=True)
class CueExternalWritePlan:
    program_id: int
    source_kind: str
    root_id: str
    root_path: Path
    source_path: Path
    source_bytes: bytes
    corrections: tuple[Mapping[str, object], ...]
    media_durations: Mapping[str, float]


def _decode(source: bytes) -> tuple[str, str]:
    if source.startswith(b"\xef\xbb\xbf"):
        return source.decode("utf-8-sig"), "utf-8-sig"
    try:
        return source.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return source.decode("latin-1"), "latin-1"


def _safe_text(value: object) -> str | None:
    text = value if isinstance(value, str) else None
    if text is None or not text or any(character in text for character in ('"', "\r", "\n")):
        return None
    return text


def _timestamp(frame: int) -> str:
    minutes, remainder = divmod(frame, 60 * 75)
    seconds, frames = divmod(remainder, 75)
    return f"{minutes:02d}:{seconds:02d}:{frames:02d}"


def render_external_cue(source: bytes, corrections: Sequence[Mapping[str, object]]) -> RenderedExternalCue:
    text, encoding = _decode(source)
    lines = text.splitlines(keepends=True)
    newline = "\r\n" if "\r\n" in text else "\n"
    track_matches = [
        (index, match)
        for index, line in enumerate(lines)
        if (match := _TRACK.match(line))
    ]
    track_starts = [index for index, _match in track_matches]
    range_position_by_number = {
        int(match.group("number")): position
        for position, (_index, match) in enumerate(track_matches)
    }
    ranges = [
        (start, track_starts[position + 1] if position + 1 < len(track_starts) else len(lines))
        for position, start in enumerate(track_starts)
    ]
    replacements: dict[int, str] = {}
    before: dict[int, list[str]] = {}
    after: dict[int, list[str]] = {}
    persisted: dict[int, set[str] | None] = {}

    metadata_rows = [row for row in corrections if row.get("kind") == "metadata"]
    global_values: dict[str, list[tuple[int, str]]] = {"album": [], "album_artist": []}
    for row in metadata_rows:
        correction_id = row.get("id")
        fields = row.get("payload", {}).get("fields") if isinstance(row.get("payload"), Mapping) else None
        if type(correction_id) is not int or not isinstance(fields, Mapping):
            continue
        persisted[correction_id] = set()
        for field in ("album", "album_artist"):
            value = _safe_text(fields.get(field))
            if value is not None:
                global_values[field].append((correction_id, value))

    first_track = track_starts[0] if track_starts else len(lines)
    global_names = {"album": "TITLE", "album_artist": "PERFORMER"}
    for field, values in global_values.items():
        unique_values = {value for _correction_id, value in values}
        if len(unique_values) != 1:
            continue
        value = next(iter(unique_values))
        matching = [
            index for index, line in enumerate(lines[:first_track])
            if (match := _DIRECTIVE.match(line)) and match.group("name").upper() == global_names[field]
        ]
        if matching:
            for index in matching:
                match = _DIRECTIVE.match(lines[index])
                replacements[index] = (
                    f'{match.group("indent")}{global_names[field]} "{value}"'
                    f'{match.group("ending") or ""}'
                )
        else:
            insertion = next(
                (
                    index
                    for index, line in enumerate(lines[:first_track])
                    if line.lstrip().upper().startswith("FILE ")
                ),
                first_track,
            )
            before.setdefault(insertion, []).append(f'{global_names[field]} "{value}"{newline}')
        for correction_id, _value in values:
            current = persisted.get(correction_id)
            if isinstance(current, set):
                current.add(field)

    for row in corrections:
        correction_id = row.get("id")
        ordinal = row.get("program_ordinal")
        track_number = row.get("track_number")
        kind = row.get("kind")
        payload = row.get("payload")
        if type(correction_id) is not int or type(ordinal) is not int or not isinstance(payload, Mapping):
            continue
        range_position = (
            range_position_by_number.get(track_number)
            if type(track_number) is int
            else ordinal
        )
        if range_position is None or range_position < 0 or range_position >= len(ranges):
            continue
        start, end = ranges[range_position]
        if kind == "boundary":
            frame = payload.get("start_frame")
            if type(frame) is not int or frame < 0:
                continue
            index_line = next((
                index for index in range(start + 1, end)
                if (match := _DIRECTIVE.match(lines[index]))
                and match.group("name").upper() == "INDEX"
                and str(match.group("value") or "").split(maxsplit=1)[0] == "01"
            ), None)
            if index_line is None:
                continue
            match = _DIRECTIVE.match(lines[index_line])
            replacements[index_line] = (
                f'{match.group("indent")}INDEX 01 {_timestamp(frame)}'
                f'{match.group("ending") or ""}'
            )
            persisted[correction_id] = None
            continue
        if kind != "metadata":
            continue
        fields = payload.get("fields")
        if not isinstance(fields, Mapping):
            continue
        indent_match = _DIRECTIVE.match(lines[start])
        indent = f'{indent_match.group("indent")}  ' if indent_match else "  "
        for field, directive in (("title", "TITLE"), ("artist", "PERFORMER")):
            value = _safe_text(fields.get(field))
            if value is None:
                continue
            matching = [
                index for index in range(start + 1, end)
                if (match := _DIRECTIVE.match(lines[index])) and match.group("name").upper() == directive
            ]
            if matching:
                for index in matching:
                    match = _DIRECTIVE.match(lines[index])
                    replacements[index] = f'{match.group("indent")}{directive} "{value}"{match.group("ending") or ""}'
            else:
                after.setdefault(start, []).append(f'{indent}{directive} "{value}"{newline}')
            current = persisted.get(correction_id)
            if isinstance(current, set):
                current.add(field)

    output: list[str] = []
    for index, line in enumerate(lines):
        output.extend(before.get(index, ()))
        output.append(replacements.get(index, line))
        output.extend(after.get(index, ()))
    output.extend(before.get(len(lines), ()))
    rendered = "".join(output).encode(encoding)
    parsed = parse_cue_program(_decode(rendered)[0], source_name="external-write.cue")
    if parsed.problems:
        raise CueExternalWriteConflict("The corrected CUE program is invalid.")
    return RenderedExternalCue(
        rendered,
        {
            correction_id: (frozenset(fields) if isinstance(fields, set) else None)
            for correction_id, fields in persisted.items()
            if fields is None or fields
        },
    )


def _temporary_file(path: Path, payload: bytes, mode: int) -> Path:
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def atomic_replace_external_cue(path: Path, *, expected_source: bytes, replacement: bytes) -> Path:
    source = Path(path)
    try:
        source_stat = source.lstat()
    except OSError as error:
        raise CueExternalWriteConflict("The external CUE source is unavailable.") from error
    if not stat.S_ISREG(source_stat.st_mode) or stat.S_ISLNK(source_stat.st_mode):
        raise CueExternalWriteConflict("The external CUE source is not a regular file.")
    try:
        current = source.read_bytes()
    except OSError as error:
        raise CueExternalWriteConflict("The external CUE source is unavailable.") from error
    if current != expected_source:
        raise CueExternalWriteConflict("The external CUE source changed. Reload before applying.")
    if current == replacement:
        return Path(f"{source}.albumhaven-backup")
    mode = stat.S_IMODE(source_stat.st_mode)
    backup = Path(f"{source}.albumhaven-backup")
    backup_temp = _temporary_file(source, current, mode)
    try:
        replacement_temp = _temporary_file(source, replacement, mode)
    except BaseException:
        backup_temp.unlink(missing_ok=True)
        raise
    prior_backup_temp = None
    if backup.exists():
        backup_stat = backup.lstat()
        if not stat.S_ISREG(backup_stat.st_mode) or stat.S_ISLNK(backup_stat.st_mode):
            backup_temp.unlink(missing_ok=True)
            replacement_temp.unlink(missing_ok=True)
            raise CueExternalWriteConflict("The external CUE backup is not a regular file.")
        try:
            prior_backup_temp = _temporary_file(
                source,
                backup.read_bytes(),
                stat.S_IMODE(backup_stat.st_mode),
            )
        except BaseException:
            backup_temp.unlink(missing_ok=True)
            replacement_temp.unlink(missing_ok=True)
            raise
    preserve_prior_backup = False
    try:
        os.replace(backup_temp, backup)
        try:
            os.replace(replacement_temp, source)
        except BaseException:
            try:
                if prior_backup_temp is None:
                    backup.unlink(missing_ok=True)
                else:
                    os.replace(prior_backup_temp, backup)
            except BaseException:
                preserve_prior_backup = True
                raise
            raise
    finally:
        backup_temp.unlink(missing_ok=True)
        replacement_temp.unlink(missing_ok=True)
        if prior_backup_temp is not None and not preserve_prior_backup:
            prior_backup_temp.unlink(missing_ok=True)
    return backup


class CueExternalWriteService:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect=None,
        load_plan: Callable[[int, int], CueExternalWritePlan] | None = None,
        reconcile: Callable[[CueExternalWritePlan], int] | None = None,
        finalize: Callable[[int, int, dict[int, frozenset[str] | None]], None] | None = None,
    ) -> None:
        self._config = dict(config)
        self._database_url = self._config.get("ALBUM_HAVEN_APP_DATABASE_URL")
        if connect is None:
            from music_app.services.postgres_connections import pooled_connection

            connect = pooled_connection
        self._connect = connect
        self._load = load_plan or self._load_plan
        self._reconcile = reconcile or self._reconcile_program
        self._finalize = finalize or self._finalize_corrections

    def _load_plan(self, library_id: int, program_id: int) -> CueExternalWritePlan:
        with self._connect(self._database_url) as connection:
            program = connection.execute(
                """/* cue_external_write_program */
                select p.id, p.source_kind, p.source_identity, p.source_bytes,
                       r.root_path,
                       coalesce(nullif(r.metadata ->> 'root_id', ''), r.id::text) as root_id
                from library.cue_programs p
                join library.library_roots r on r.id = p.library_root_id and r.library_id = p.library_id
                where p.id = %s and p.library_id = %s and p.is_active and p.is_valid
                """,
                (program_id, library_id),
            ).fetchone()
            if program is None:
                raise CueExternalWriteConflict("The CUE program changed. Reload before applying.")
            corrections = tuple(dict(row) for row in connection.execute(
                """/* cue_external_write_corrections */
                select c.id, c.correction_kind as kind, c.payload,
                       s.program_ordinal, t.track_number
                from library.cue_corrections c
                join library.cue_track_segments s on s.track_id = c.track_id and s.program_id = c.base_program_id
                join library.local_tracks t on t.id = s.track_id and t.library_id = c.library_id
                where c.library_id = %s and c.base_program_id = %s and c.status = 'active'
                order by s.program_ordinal, c.id
                """,
                (library_id, program_id),
            ).fetchall())
            media = connection.execute(
                """/* cue_external_write_media */
                select distinct m.private_path, m.decoded_duration_frames
                from library.cue_track_segments s
                join library.cue_media_sources m on m.id = s.media_source_id
                where s.program_id = %s
                """,
                (program_id,),
            ).fetchall()
        try:
            root = Path(str(program["root_path"])).resolve(strict=True)
        except OSError as error:
            raise CueExternalWriteConflict("The external CUE source is unavailable.") from error
        source_identity = str(program["source_identity"])
        if program["source_kind"] == "embedded":
            source_identity = source_identity.partition("#embedded-cue")[0]
        source_candidate = root / source_identity
        try:
            source_is_symlink = source_candidate.is_symlink()
            source = source_candidate.resolve(strict=False)
        except OSError as error:
            raise CueExternalWriteConflict("The external CUE source is unavailable.") from error
        if source_is_symlink:
            raise CueExternalWriteConflict("The external CUE source is outside its library root.")
        if not source.is_relative_to(root):
            raise CueExternalWriteConflict("The external CUE source is outside its library root.")
        return CueExternalWritePlan(
            program_id=int(program["id"]),
            source_kind=str(program["source_kind"]),
            root_id=str(program["root_id"]),
            root_path=root,
            source_path=source,
            source_bytes=bytes(program["source_bytes"]),
            corrections=corrections,
            media_durations={
                str(row["private_path"]): int(row["decoded_duration_frames"] or 0) / 75
                for row in media
            },
        )

    def _reconcile_program(self, plan: CueExternalWritePlan) -> int:
        from music_app.services.library_indexing import discover_cue_sources
        from music_app.services.scan_cache_persistence import select_scan_cache_adapter

        candidates = discover_cue_sources(
            plan.root_path,
            [plan.source_path],
            metadata_by_path={
                path: {"duration_seconds": duration}
                for path, duration in plan.media_durations.items()
            },
            supported_extensions={
                str(extension).casefold()
                for extension in self._config.get("SUPPORTED_EXTENSIONS", ())
            },
            max_bytes=int(self._config.get("CUE_MAX_BYTES", 1024 * 1024)),
            root_id=plan.root_id,
        )
        if len(candidates) != 1 or candidates[0].program.problems:
            raise CueExternalWriteConflict("The corrected CUE program could not be reconciled.")
        select_scan_cache_adapter(self._config).reconcile_cue_sources(
            root_id=plan.root_id,
            candidates=candidates,
            changed_paths=(str(plan.source_path),),
        )
        with self._connect(self._database_url) as connection:
            row = connection.execute(
                """/* cue_external_write_active_program */
                select id from library.cue_programs
                where library_id = (select library_id from library.cue_programs where id = %s)
                  and library_root_id = (select library_root_id from library.cue_programs where id = %s)
                  and source_kind = 'external'
                  and source_identity = (select source_identity from library.cue_programs where id = %s)
                  and is_active and is_valid
                order by updated_at desc, id desc limit 1
                """,
                (plan.program_id, plan.program_id, plan.program_id),
            ).fetchone()
        if row is None:
            raise CueExternalWriteConflict("The corrected CUE program was not activated.")
        return int(row["id"])

    def _finalize_corrections(
        self,
        old_program_id: int,
        new_program_id: int,
        persisted_fields: dict[int, frozenset[str] | None],
    ) -> None:
        from psycopg.types.json import Jsonb

        conflict = "External and embedded CUE programs differ."
        with self._connect(self._database_url) as connection, connection.transaction():
            rows = connection.execute(
                """/* cue_external_write_finalize_rows */
                select id, correction_kind, payload
                from library.cue_corrections
                where base_program_id = %s and status = 'active'
                order by id
                """,
                (old_program_id,),
            ).fetchall()
            for row in rows:
                correction_id = int(row["id"])
                written = persisted_fields.get(correction_id, frozenset())
                payload = row.get("payload") if isinstance(row, Mapping) else row["payload"]
                fields = payload.get("fields") if isinstance(payload, Mapping) else None
                remaining = (
                    {key: value for key, value in fields.items() if key not in written}
                    if isinstance(fields, Mapping) and isinstance(written, frozenset)
                    else {}
                )
                if correction_id not in persisted_fields or remaining:
                    next_payload = {"fields": remaining} if isinstance(fields, Mapping) else payload
                    connection.execute(
                        """/* cue_external_write_rebase_correction */
                        update library.cue_corrections
                        set base_program_id = %s, payload = %s, updated_at = now()
                        where id = %s and status = 'active'
                        """,
                        (new_program_id, Jsonb(next_payload), correction_id),
                    )
                else:
                    connection.execute(
                        """/* cue_external_write_restore_correction */
                        update library.cue_corrections
                        set status = 'restored', restored_at = now(), updated_at = now()
                        where id = %s and status = 'active'
                        """,
                        (correction_id,),
                    )
            different_embedded = connection.execute(
                """/* cue_external_write_dual_source_conflict */
                select exists (
                  select 1
                  from library.cue_track_segments external_segment
                  join library.cue_track_segments embedded_segment
                    on embedded_segment.media_source_id = external_segment.media_source_id
                  join library.cue_programs embedded on embedded.id = embedded_segment.program_id
                  join library.cue_programs external on external.id = external_segment.program_id
                  where external.id = %s and embedded.source_kind = 'embedded'
                    and embedded.is_active and embedded.is_valid
                    and embedded.revision_sha256 <> external.revision_sha256
                ) as differs
                """,
                (new_program_id,),
            ).fetchone()
            if bool(different_embedded and different_embedded["differs"]):
                connection.execute(
                    """update library.cue_programs
                    set source_problems = case when source_problems ? %s
                      then source_problems else source_problems || jsonb_build_array(%s) end,
                      updated_at = now()
                    where id = %s""",
                    (conflict, conflict, new_program_id),
                )
            else:
                connection.execute(
                    """update library.cue_programs
                    set source_problems = source_problems - %s, updated_at = now()
                    where id = %s""",
                    (conflict, new_program_id),
                )

    def write_program(self, *, library_id: int, program_id: int) -> dict[str, object]:
        plan = self._load(library_id, program_id)
        if plan.source_kind != "external":
            return {"written_to_tags": False, "write_reason": "embedded"}
        rendered = render_external_cue(plan.source_bytes, plan.corrections)
        if not rendered.persisted_fields:
            return {"written_to_tags": False, "write_reason": "no_supported_changes"}
        try:
            atomic_replace_external_cue(
                plan.source_path,
                expected_source=plan.source_bytes,
                replacement=rendered.source_bytes,
            )
        except CueExternalWriteConflict:
            raise
        except OSError as error:
            raise CueExternalWriteConflict("The external CUE source could not be written.") from error
        try:
            new_program_id = self._reconcile(plan)
        except Exception as error:
            replacement_stat = plan.source_path.stat()
            temporary = _temporary_file(
                plan.source_path,
                plan.source_bytes,
                stat.S_IMODE(replacement_stat.st_mode),
            )
            try:
                os.replace(temporary, plan.source_path)
            finally:
                temporary.unlink(missing_ok=True)
            if isinstance(error, CueExternalWriteConflict):
                raise
            raise CueExternalWriteConflict("The corrected CUE program could not be reconciled.") from error
        self._finalize(plan.program_id, new_program_id, rendered.persisted_fields)
        return {
            "written_to_tags": True,
            "program_id": new_program_id,
        }

    def has_retained_revision(self, *, library_id: int, program_id: int) -> bool:
        plan = self._load(library_id, program_id)
        if plan.source_kind != "external":
            return False
        backup = Path(f"{plan.source_path}.albumhaven-backup")
        try:
            backup_stat = backup.lstat()
        except OSError:
            return False
        return stat.S_ISREG(backup_stat.st_mode) and not stat.S_ISLNK(backup_stat.st_mode)

    def restore_program(self, *, library_id: int, program_id: int) -> dict[str, object]:
        plan = self._load(library_id, program_id)
        if plan.source_kind != "external":
            return {"restored_source": False, "restore_reason": "embedded"}
        backup = Path(f"{plan.source_path}.albumhaven-backup")
        try:
            backup_stat = backup.lstat()
            prior_source = backup.read_bytes()
        except OSError as error:
            raise CueExternalWriteConflict("The retained CUE revision is unavailable.") from error
        if not stat.S_ISREG(backup_stat.st_mode) or stat.S_ISLNK(backup_stat.st_mode):
            raise CueExternalWriteConflict("The retained CUE revision is unavailable.")
        if parse_cue_program(_decode(prior_source)[0], source_name="retained.cue").problems:
            raise CueExternalWriteConflict("The retained CUE revision is invalid.")
        try:
            atomic_replace_external_cue(
                plan.source_path,
                expected_source=plan.source_bytes,
                replacement=prior_source,
            )
        except CueExternalWriteConflict:
            raise
        except OSError as error:
            raise CueExternalWriteConflict("The retained CUE revision could not be restored.") from error
        try:
            new_program_id = self._reconcile(plan)
        except Exception as error:
            atomic_replace_external_cue(
                plan.source_path,
                expected_source=prior_source,
                replacement=plan.source_bytes,
            )
            if isinstance(error, CueExternalWriteConflict):
                raise
            raise CueExternalWriteConflict("The restored CUE program could not be reconciled.") from error
        return {"restored_source": True, "program_id": new_program_id}
