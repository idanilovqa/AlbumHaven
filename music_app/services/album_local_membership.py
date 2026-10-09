from __future__ import annotations

import re
from collections import defaultdict
from pathlib import PurePosixPath, PureWindowsPath
from collections.abc import Mapping, Iterable

_DISC_FOLDER = re.compile(r"(?<![A-Za-z0-9])(?:cd|disc|disk)\s*[-_.]?\s*\d{1,2}(?![A-Za-z0-9])", re.I)


def physical_album_root(path: object) -> str:
    text = str(path or "").strip()
    kind = PureWindowsPath if "\\" in text or re.match(r"^[A-Za-z]:", text) else PurePosixPath
    parent = kind(text).parent
    if _DISC_FOLDER.search(parent.name):
        parent = parent.parent
    return str(parent).casefold() if kind is PureWindowsPath else str(parent)


def physical_album_folder(path: object) -> str:
    text = str(path or "").strip()
    kind = PureWindowsPath if "\\" in text or re.match(r"^[A-Za-z]:", text) else PurePosixPath
    parent = kind(text).parent
    return str(parent).casefold() if kind is PureWindowsPath else str(parent)


def rejected_local_album_paths(entries: Iterable[Mapping[str, object]]) -> dict[str, str]:
    """Keep unrelated physical collections out of a tagged album's sources."""
    from music_app.services.non_album_view_payloads import is_loose_track_album_value
    from music_app.services.metadata import normalize_exception_value

    folders: dict[tuple[str, str], list[Mapping[str, object]]] = defaultdict(list)
    for entry in entries:
        if normalize_exception_value(entry.get("exception_type")) or is_loose_track_album_value(entry.get("album")):
            continue
        path = str(entry.get("path") or "")
        if path:
            folders[(str(entry.get("library_root_id") or ""), physical_album_folder(path))].append(entry)
    rejected: dict[str, str] = {}
    physical_sources: dict[tuple[str, str], list[Mapping[str, object]]] = defaultdict(list)
    sources: dict[tuple[str, str, str, str], list[tuple[list[Mapping[str, object]], set[tuple[str, str, int]]]]] = defaultdict(list)
    for files in folders.values():
        album_names = {_text(entry.get("album")) for entry in files if _text(entry.get("album"))}
        if len(album_names) > 1:
            rejected.update((str(entry["path"]), "Mixed album metadata in one folder") for entry in files)
            continue
        for entry in files:
            path = str(entry.get("path") or "")
            physical_sources[
                (str(entry.get("library_root_id") or ""), physical_album_root(path))
            ].append(entry)

    for files in physical_sources.values():
        groups: dict[tuple[str, str, str, str], list[Mapping[str, object]]] = defaultdict(list)
        for entry in files:
            groups[(_text(entry.get("album_artist") or entry.get("artist")), _text(entry.get("album")), _text(entry.get("edition")), _text(entry.get("year")))].append(entry)
        for identity, group in groups.items():
            signatures = {
                (_text(entry.get("title")), _text(entry.get("artist") or entry.get("album_artist")), _duration(entry.get("duration_seconds")))
                for entry in group
                if _text(entry.get("title"))
            }
            sources[identity].append((group, signatures))
    for copies in sources.values():
        for files, signatures in copies:
            if signatures and any(signatures < other for _files, other in copies):
                rejected.update((str(entry["path"]), "Duplicate track outside album folder") for entry in files)
    return rejected


def _text(value: object) -> str:
    return " ".join(str(value or "").casefold().split())


def _duration(value: object) -> int:
    try:
        return int(value or 0)
    except (ValueError, TypeError):
        return 0


def physical_album_folder_sql(path_expression: str) -> str:
    path = f"replace(library.local_path_key({path_expression}), chr(92), '/')"
    return f"regexp_replace({path}, '/[^/]*$', '')"


def physical_album_root_sql(path_expression: str) -> str:
    parent = physical_album_folder_sql(path_expression)
    name = f"regexp_replace({parent}, '^.*/', '')"
    return f"""case when {name} ~* '(^|[^[:alnum:]])(cd|disc|disk)[[:space:]]*[-_.]?[[:space:]]*[0-9]{{1,2}}([^[:alnum:]]|$)'
      then regexp_replace({parent}, '/[^/]*$', '') else {parent} end"""


def local_album_membership_ctes_sql(*, scope_album_key: bool = False) -> str:
    """Classify existing inventory without changing tags or deleting files."""
    if not scope_album_key:
        # Scan publication owns full physical classification. Browse reads its
        # durable projection instead of rebuilding every source on each request.
        return """
        local_album_membership as materialized (
          select files.id as file_id, files.track_id, files.private_path,
            files.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}' as problem
          from library.local_track_files files
          join library.library_roots roots on roots.id = files.library_root_id and roots.is_active is true
          join bootstrap_context on bootstrap_context.library_id = roots.library_id
          where files.scan_cache_stale is false
            and nullif(files.metadata #>> '{scan_cache,file_entry,local_album_membership_problem}', '') is not null
        )
        """
    seeds = ""
    scope = ""
    if scope_album_key:
        seed_root = physical_album_root_sql("seed_files.private_path")
        file_root = physical_album_root_sql("files.private_path")
        seeds = f"""
        local_membership_selected_albums as materialized (
          select albums.id from library.local_albums albums join bootstrap_context
            on bootstrap_context.library_id = albums.library_id
          where albums.album_key = %(album_key)s
        ),
        local_membership_selected_roots as materialized (
          select distinct seed_files.library_root_id, {seed_root} as physical_root
          from library.local_track_files seed_files join library.local_tracks seed_tracks
            on seed_tracks.id = seed_files.track_id
          where seed_tracks.album_id in (select id from local_membership_selected_albums)
            and seed_files.scan_cache_stale is false
        ),"""
        scope = f"""and (tracks.album_id in (select id from local_membership_selected_albums)
          or (files.library_root_id, {file_root}) in (
            select library_root_id, physical_root from local_membership_selected_roots))"""
    return r"""
        __SCOPE_SEEDS__
        local_membership_track_overrides as materialized (
          select distinct on (library_id, track_id) library_id, track_id, override_payload
          from library.exception_overrides where track_id is not null
          order by library_id, track_id, updated_at desc, id desc
        ),
        local_membership_files as materialized (
          select files.id as file_id, tracks.id as track_id, tracks.library_id,
            files.library_root_id, files.private_path,
          __PHYSICAL_ROOT__ as physical_root,
          __PHYSICAL_FOLDER__ as physical_folder,
            regexp_replace(lower(btrim(coalesce(files.scan_file_album, tracks.metadata ->> 'album', albums.title, ''))), '[[:space:]]+', ' ', 'g') as album_name,
            regexp_replace(lower(btrim(coalesce(files.scan_file_album_artist, tracks.metadata ->> 'album_artist', ''))), '[[:space:]]+', ' ', 'g') as album_artist,
            regexp_replace(lower(btrim(coalesce(files.metadata #>> '{scan_cache,file_entry,edition}', albums.metadata ->> 'edition', ''))), '[[:space:]]+', ' ', 'g') as edition,
            btrim(coalesce(files.scan_file_year, albums.release_year::text, '')) as release_year,
            case when nullif(btrim(coalesce(files.metadata #>> '{scan_cache,file_entry,title}', tracks.title, '')), '') is not null
            then jsonb_build_array(
              regexp_replace(lower(btrim(coalesce(files.metadata #>> '{scan_cache,file_entry,title}', tracks.title, ''))), '[[:space:]]+', ' ', 'g'),
              regexp_replace(lower(btrim(coalesce(files.metadata #>> '{scan_cache,file_entry,artist}', artists.name, ''))), '[[:space:]]+', ' ', 'g'),
              trunc(coalesce(tracks.duration_seconds, 0))::bigint
            )::text end as track_signature
          from library.local_track_files files
          join library.local_tracks tracks on tracks.id = files.track_id
          join bootstrap_context on bootstrap_context.library_id = tracks.library_id
          join library.library_roots roots on roots.id = files.library_root_id and roots.is_active is true
          left join library.local_albums albums on albums.id = tracks.album_id
          left join library.local_artists artists on artists.id = tracks.artist_id
          left join library.exception_overrides membership_path_override
            on membership_path_override.library_id = tracks.library_id and membership_path_override.track_key = files.private_path
          left join local_membership_track_overrides membership_track_override
            on membership_track_override.library_id = tracks.library_id and membership_track_override.track_id = tracks.id
           and membership_path_override.id is null
          where files.scan_cache_stale is false
            __SCOPE_FILTER__
            and coalesce(files.scan_file_album, tracks.metadata ->> 'album', albums.title, '')
              !~* '^[![:space:]\[\(-]*non[[:space:]_-]*album([[:space:]]|$)'
            and lower(btrim(coalesce(case
              when membership_path_override.override_payload ? 'exception_type' then membership_path_override.override_payload ->> 'exception_type'
              when jsonb_typeof(membership_path_override.override_payload) = 'string' then membership_path_override.override_payload #>> '{}'
              when membership_track_override.override_payload ? 'exception_type' then membership_track_override.override_payload ->> 'exception_type'
              when jsonb_typeof(membership_track_override.override_payload) = 'string' then membership_track_override.override_payload #>> '{}'
              else files.metadata #>> '{scan_cache,file_entry,exception_type}' end, ''))) in ('', 'none', 'null')
        ),
        local_membership_mixed_roots as materialized (
          select library_id, library_root_id, physical_folder
          from local_membership_files
          group by library_id, library_root_id, physical_folder
          having count(distinct nullif(album_name, '')) > 1
        ),
        local_membership_sources as materialized (
          select files.library_id, files.library_root_id, files.physical_root,
            files.album_name, files.album_artist, files.edition, files.release_year,
            coalesce(array_agg(distinct files.track_signature) filter (where files.track_signature is not null), array[]::text[]) as signatures
          from local_membership_files files
          where not exists (select 1 from local_membership_mixed_roots mixed
            where mixed.library_id = files.library_id and mixed.library_root_id = files.library_root_id
              and mixed.physical_folder = files.physical_folder)
          group by files.library_id, files.library_root_id, files.physical_root,
            files.album_name, files.album_artist, files.edition, files.release_year
        ),
        local_membership_orphan_sources as materialized (
          select distinct source.library_id, source.library_root_id, source.physical_root,
            source.album_name, source.album_artist, source.edition, source.release_year
          from local_membership_sources source
          join local_membership_sources other
            on other.library_id = source.library_id and other.album_name = source.album_name
           and other.album_artist = source.album_artist and other.edition = source.edition and other.release_year = source.release_year
           and cardinality(source.signatures) < cardinality(other.signatures)
           and cardinality(source.signatures) > 0
           and source.signatures <@ other.signatures
        ),
        local_album_membership as materialized (
          select files.file_id, files.track_id, files.private_path,
            case when mixed.library_id is not null then 'Mixed album metadata in one folder'
              when source.library_id is not null
              then 'Duplicate track outside album folder' else null end as problem
          from local_membership_files files
          left join local_membership_mixed_roots mixed
            on mixed.library_id = files.library_id and mixed.library_root_id = files.library_root_id
           and mixed.physical_folder = files.physical_folder
          left join local_membership_orphan_sources source
            on source.library_id = files.library_id and source.library_root_id = files.library_root_id
           and source.physical_root = files.physical_root and source.album_name = files.album_name
           and source.album_artist = files.album_artist and source.edition = files.edition and source.release_year = files.release_year
        )
    """.replace("__PHYSICAL_ROOT__", physical_album_root_sql("files.private_path")).replace(
        "__PHYSICAL_FOLDER__", physical_album_folder_sql("files.private_path")
    ).replace("__SCOPE_SEEDS__", seeds).replace("__SCOPE_FILTER__", scope)
