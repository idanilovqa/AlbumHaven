from __future__ import annotations

from pathlib import Path

from music_app.services.postgres_connections import pooled_connection


class CueMoveDependencyError(RuntimeError):
    pass


def _contained(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_cue_bundle_move(config, source_folder: Path, *, connect=None) -> set[Path]:
    """Return the exact contained CUE bundle; reject cross-folder/shared media."""
    database_url = config.get("ALBUM_HAVEN_APP_DATABASE_URL")
    if not database_url:
        return set()
    source_folder = Path(source_folder).resolve(strict=False)
    connector = connect or pooled_connection
    with connector(database_url) as connection:
        rows = connection.execute(
            """/* cue_move_dependencies */
            select root.root_path, program.source_identity, media.private_path,
                   array_agg(distinct reference_root.root_path || E'\n' || reference_program.source_identity)
                     as referencing_sources
            from library.cue_programs program
            join library.library_roots root on root.id = program.library_root_id
            join library.cue_track_segments segment on segment.program_id = program.id
            join library.cue_media_sources media on media.id = segment.media_source_id
            join library.cue_track_segments reference_segment
              on reference_segment.media_source_id = media.id
            join library.cue_programs reference_program
              on reference_program.id = reference_segment.program_id
             and reference_program.is_active and reference_program.is_valid
            join library.library_roots reference_root
              on reference_root.id = reference_program.library_root_id
            where program.is_active and program.is_valid
            group by root.root_path, program.source_identity, media.private_path"""
        ).fetchall()

    dependencies: set[Path] = set()
    for row in rows:
        root = Path(row["root_path"]).resolve(strict=False)
        program_path = (root / row["source_identity"]).resolve(strict=False)
        if not _contained(program_path, source_folder):
            continue
        media_path = Path(row["private_path"]).resolve(strict=False)
        if not _contained(media_path, source_folder):
            raise CueMoveDependencyError("CUE media outside the album folder cannot move as one bundle.")
        for reference in row.get("referencing_sources") or ():
            reference_text = str(reference)
            if "\n" in reference_text:
                reference_root, reference_identity = reference_text.split("\n", 1)
                reference_path = (Path(reference_root) / reference_identity).resolve(strict=False)
            else:
                reference_path = (root / reference_text).resolve(strict=False)
            if not _contained(reference_path, source_folder):
                raise CueMoveDependencyError("A CUE media source is shared by another program.")
        dependencies.update((program_path, media_path))
    return dependencies
