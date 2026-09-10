from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
from typing import Any, Callable, Iterator, Mapping
from urllib.parse import unquote, urlparse

import psycopg
from psycopg import sql
import zstandard


ALLOWED_FIXTURE_TABLES = frozenset(
    {
        "album_ratings",
        "covers",
        "exception_overrides",
        "ignored_repairs",
        "ignored_versions",
        "local_album_featured_artists",
        "local_album_cover_candidate_snapshots",
        "local_albums",
        "local_artist_family_links",
        "local_artists",
        "local_track_files",
        "local_tracks",
        "scan-file-index",
    }
)

PRODUCT_PROJECTION_ORDER = (
    "app.accounts",
    "app.bootstrap_owners",
    "library.libraries",
    "library.library_roots",
    "library.library_root_settings",
    "library.local_artists",
    "library.local_albums",
    "library.local_tracks",
    "library.local_track_files",
    "app.album_ratings",
    "library.local_artist_family_links",
    "library.local_album_featured_artists",
    "library.local_album_cover_candidate_snapshots",
    "library.ignored_versions",
    "library.ignored_repairs",
    "library.exception_overrides",
    "covers",
)

_APPLICATION_SCHEMAS = ("app", "integration", "library", "ops")
_MIGRATION_OWNED_TABLES = frozenset(
    {
        ("app", "client_surface_classes"),
        ("app", "deployment_mode_rules"),
        ("app", "e2e_problematic_file_fixture_seeds"),
        ("ops", "schema_migrations"),
    }
)

_SOURCE_COUNT_KEYS = {
    "albumRatings": "album_ratings",
    "artists": "local_artists",
    "albums": "local_albums",
    "tracks": "local_tracks",
    "trackFiles": "local_track_files",
    "logicalTrackFiles": "scan-file-index",
    "featuredArtistLinks": "local_album_featured_artists",
    "coverCandidateSnapshots": "local_album_cover_candidate_snapshots",
    "artistFamilyLinks": "local_artist_family_links",
    "ignoredVersions": "ignored_versions",
    "ignoredRepairs": "ignored_repairs",
    "exceptionOverrides": "exception_overrides",
    "covers": "covers",
}

_PROJECTED_COUNT_KEYS = {
    **_SOURCE_COUNT_KEYS,
    "logicalTrackFiles": "local_track_files",
}

_PATH_FIELDS = {
    "covers": ("path",),
    "local_albums": ("coverPath",),
    "local_track_files": ("privatePath", "relativePath", "path"),
    "scan-file-index": ("path",),
}

_PROBLEMATIC_FILES_TYPES = (
    "Encoding problem",
    "Incomplete track order",
    "Missing cover art",
    "Missing track number",
    "Missing year",
    "Year mismatch",
)
_PROBLEMATIC_FILES_REASONS = (
    "Encoding problem",
    "Incomplete track order: Disc 1 missing 2",
    "Incomplete track order: Disc 1 missing 1, 4, 5, 6, 7, 8, 9",
    "Incomplete track order: Disc 2 missing 1, 2, 3",
    "Missing cover art",
    "Missing track number",
    "Missing year",
    "Year mismatch",
)
_PROBLEMATIC_FILES_ALBUMS = (
    ("Neal Morse", "Neal Morse Plays Pink Floyd", ("Missing cover art", "Missing track number", "Missing year")),
    ("E2E Rarity Artist", "Two Track Rarity Fixture", ("Incomplete track order: Disc 1 missing 2",)),
    (
        "E2E Rarity Artist",
        "Natural Filename Order Fixture",
        ("Missing track number", "Incomplete track order: Disc 1 missing 1, 4, 5, 6, 7, 8, 9"),
    ),
    ("E2E Rarity Artist", "Sparse Album Edit Fixture", ("Year mismatch",)),
    (
        "Generated Problem Fixture",
        "Encoding And Missing Metadata",
        ("Missing year", "Missing cover art", "Missing track number", "Encoding problem"),
    ),
    ("Mastodon", "Crack The Skye Fixture 07", ("Missing cover art",)),
    ("Mastodon", "Crack The Skye Fixture 08", ("Missing cover art",)),
    ("Various Artists", "Explicit Disc Label Control", ("Incomplete track order: Disc 2 missing 1, 2, 3",)),
    *tuple(
        (
            "Synthetic Problem Control Artist",
            f"Missing Cover Control {index:02d}",
            ("Missing cover art",),
        )
        for index in range(1, 11)
    ),
)
_UTILITY_PROBLEMATIC_PROFILE = "utility-problematic-files"
_UTILITY_PROBLEMATIC_COUNTS = {
    "artists": 40,
    "albums": 400,
    "tracks": 7200,
    "trackFiles": 7200,
    "covers": 386,
}
_UTILITY_PROBLEMATIC_ASSERTION_KEYS = frozenset(
    {
        "problematicItemCount",
        "candidateTrackFileCount",
        "expectedProblemTypes",
        "expectedProblemReasons",
        "expectedProblematicAlbums",
        "summariesCompact",
        "initialDetailMatchesFirstSummary",
    }
)
_UTILITY_PROBLEMATIC_TABLES = (
    "covers",
    "local_albums",
    "local_artists",
    "local_track_files",
    "local_tracks",
)
_IGNORED_REPAIR_PORTABLE_FIELDS = frozenset({"album"})
_FUNCTIONAL_SCAN_DISCOVERY_PATH = (
    "media/Album Rating Contract/Rating Scan Discovery/01 - New Tagged Rating.mp3"
)


def validate_fixture_record(table: str, record: Mapping[str, Any]) -> None:
    if table == "ignored_repairs":
        repair_key = record.get("repairKey")
        track_ref = record.get("trackRef")
        repair_field = record.get("field")
        has_legacy_key = (
            isinstance(repair_key, str)
            and bool(repair_key.strip())
            and "\0" not in repair_key
        )
        has_portable_key = (
            isinstance(track_ref, str)
            and bool(track_ref.strip())
            and "\0" not in track_ref
            and isinstance(repair_field, str)
            and repair_field in _IGNORED_REPAIR_PORTABLE_FIELDS
        )
        if has_legacy_key == has_portable_key:
            raise ValueError(
                "ignored repair requires exactly one legacy or portable identity"
            )
        if has_legacy_key and (track_ref is not None or repair_field is not None):
            raise ValueError("ignored repair identity is ambiguous")
        if has_portable_key and repair_key is not None:
            raise ValueError("ignored repair identity is ambiguous")

    for field in _PATH_FIELDS.get(table, ()):
        value = record.get(field)
        if value is None:
            continue
        if not isinstance(value, str) or not value or "\0" in value:
            raise ValueError(f"{table}.{field} must be a fixture-relative path")
        posix_path = PurePosixPath(value.replace("\\", "/"))
        windows_path = PureWindowsPath(value)
        if (
            posix_path.is_absolute()
            or windows_path.is_absolute()
            or windows_path.drive
            or ".." in posix_path.parts
            or ".." in windows_path.parts
        ):
            raise ValueError(f"{table}.{field} must be a fixture-relative path")


def iter_seed_rows(path: Path) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield validated fixture envelopes without materializing the seed in memory."""
    try:
        with path.open("rb") as compressed:
            with zstandard.ZstdDecompressor().stream_reader(compressed) as reader:
                with io.TextIOWrapper(reader, encoding="utf-8") as text:
                    for line_number, line in enumerate(text, 1):
                        if not line.strip():
                            continue
                        try:
                            envelope = json.loads(line)
                        except json.JSONDecodeError as exc:
                            raise ValueError(
                                f"fixture row {line_number} is invalid JSON"
                            ) from exc
                        if not isinstance(envelope, dict):
                            raise ValueError(f"fixture row {line_number} must be an object")
                        table = envelope.get("table")
                        record = envelope.get("record")
                        if not isinstance(table, str) or not isinstance(record, dict):
                            raise ValueError(
                                f"fixture row {line_number} has an invalid row envelope"
                            )
                        if table not in ALLOWED_FIXTURE_TABLES:
                            raise ValueError(f"unknown fixture table: {table}")
                        validate_fixture_record(table, record)
                        yield table, record
    except ValueError:
        raise
    except (OSError, UnicodeError, zstandard.ZstdError) as exc:
        raise ValueError(f"zstd fixture rows could not be decoded: {exc}") from exc


def validate_manifest_profile(
    manifest: Mapping[str, Any], profile: str
) -> Mapping[str, Any]:
    if manifest.get("manifestVersion") != 1:
        raise ValueError("manifest schema version is unsupported")
    profiles = manifest.get("profiles")
    if not isinstance(profiles, dict) or profile not in profiles:
        raise ValueError(f"fixture profile is missing: {profile}")
    definition = profiles[profile]
    if not isinstance(definition, dict) or definition.get("schemaVersion") != 1:
        raise ValueError("fixture profile schema version is unsupported")
    counts = definition.get("counts")
    if not isinstance(counts, dict) or not counts or any(
        isinstance(value, bool) or not isinstance(value, int) or value < 0
        for value in counts.values()
    ):
        raise ValueError("fixture profile counts are invalid")
    assertions = definition.get("namedScenarioAssertions")
    if not isinstance(assertions, dict) or not assertions:
        raise ValueError("fixture profile named assertions are invalid")
    seed = definition.get("databaseSeed")
    if not isinstance(seed, str) or not seed.endswith(".ndjson.zst"):
        raise ValueError("fixture profile database seed is invalid")
    media_root = definition.get("mediaRoot")
    if not isinstance(media_root, str) or not media_root.strip():
        raise ValueError("fixture profile media root is invalid")
    validate_fixture_record("local_track_files", {"relativePath": media_root})
    return definition


def _read_json_list(path: Path, label: str) -> list[Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"fixture {label} is missing or invalid") from exc
    if not isinstance(value, list):
        raise ValueError(f"fixture {label} is invalid")
    return value


def _require_fixture_file(fixture_root: Path, relative_path: str) -> Path:
    validate_fixture_record("local_track_files", {"privatePath": relative_path})
    path = (fixture_root / relative_path).resolve()
    if fixture_root.resolve() not in path.parents or not path.is_file():
        raise ValueError(f"fixture file is missing: {relative_path}")
    return path


def _functional_scan_discovery_contract(
    profile: str, assertions: Mapping[str, Any]
) -> dict[str, Any] | None:
    inventory = assertions.get("functionalInventory")
    if not isinstance(inventory, dict) or "scanDiscovery" not in inventory:
        return None
    if profile != "functional-core":
        raise ValueError("fixture scan discovery contract has the wrong profile")
    value = inventory.get("scanDiscovery")
    required_keys = {
        "artist",
        "album",
        "track",
        "albumRating",
        "databaseRowsBeforeScan",
        "physicalFileCount",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required_keys
        or any(
            not isinstance(value[key], str) or not value[key]
            for key in ("artist", "album", "track")
        )
        or isinstance(value.get("albumRating"), bool)
        or not isinstance(value.get("albumRating"), int)
        or value.get("databaseRowsBeforeScan") != 0
        or value.get("physicalFileCount") != 1
    ):
        raise ValueError("fixture scan discovery contract is invalid")
    return value


def validate_functional_scan_discovery_contract(
    fixture_root: Path, profile: str, assertions: Mapping[str, Any]
) -> None:
    if _functional_scan_discovery_contract(profile, assertions) is None:
        return
    try:
        _require_fixture_file(fixture_root, _FUNCTIONAL_SCAN_DISCOVERY_PATH)
    except ValueError as exc:
        raise ValueError("fixture scan discovery file is missing") from exc


def validate_auxiliary_contract(
    fixture_root: Path, profile: str, definition: Mapping[str, Any]
) -> None:
    counts = definition["counts"]
    assertions = definition["namedScenarioAssertions"]
    actual: dict[str, int] = {}

    if profile == "functional-core":
        validate_functional_scan_discovery_contract(
            fixture_root, profile, assertions
        )
        covers: list[Any] = []
        if "approvedCovers" in counts or "approvedCoverHashes" in assertions:
            covers = _read_json_list(
                fixture_root / "approved-cover-index.json", "approved cover index"
            )
            actual["approvedCovers"] = len(covers)
        if "ownedMutations" in counts:
            actual["ownedMutations"] = len(
                _read_json_list(
                    fixture_root / "scenarios" / "owned-mutations.json",
                    "owned mutations",
                )
            )
        if "ddtMaterializedTaggedFiles" in counts:
            actual["ddtMaterializedTaggedFiles"] = sum(
                1
                for album in ("Студийные записи", "Ремиксы")
                for path in (fixture_root / "media" / "ДДТ" / album).rglob("*.mp3")
                if path.is_file()
            )
        expected_hashes = assertions.get("approvedCoverHashes", {})
        if not isinstance(expected_hashes, dict):
            raise ValueError("fixture approved cover hashes are invalid")
        indexed = {
            Path(str(item.get("path", ""))).name: item
            for item in covers
            if isinstance(item, dict)
        }
        for name, expected_hash in expected_hashes.items():
            item = indexed.get(str(name))
            if item is None or item.get("sha256") != expected_hash:
                raise ValueError(f"fixture approved cover hash mismatch: {name}")
            path = _require_fixture_file(fixture_root, str(item["path"]))
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
                raise ValueError(f"fixture approved cover hash mismatch: {name}")
    elif profile == "playback-media":
        rows = _read_json_list(fixture_root / "media-index.json", "media index")
        physical = [row for row in rows if isinstance(row, dict) and row.get("class") != "db-only"]
        for row in physical:
            _require_fixture_file(fixture_root, str(row.get("path", "")))
        actual.update(
            mediaIndexRows=len(rows),
            physicalFiles=len(physical),
            dbOnlyRows=sum(1 for row in rows if isinstance(row, dict) and row.get("class") == "db-only"),
        )
        if {row.get("class") for row in rows if isinstance(row, dict)} != set(assertions.get("classes", [])):
            raise ValueError("fixture playback classes mismatch")
        if not set(assertions.get("cases", [])).issubset(
            {row.get("case") for row in rows if isinstance(row, dict)}
        ):
            raise ValueError("fixture playback cases mismatch")
        if any(
            not isinstance(row, dict)
            or row.get("generator", {}).get("ffmpegVersion") != assertions.get("ffmpegVersion")
            for row in rows
        ):
            raise ValueError("fixture FFmpeg identity mismatch")
    elif profile == "scan-library":
        actual["physicalFiles"] = sum(
            1 for path in (fixture_root / "media" / "scan-library").rglob("*") if path.is_file()
        )
    elif profile == "synthetic-large-library":
        ddt = assertions.get("ddt", {})
        paths = ddt.get("materializedTaggedFiles", []) if isinstance(ddt, dict) else []
        if not isinstance(paths, list):
            raise ValueError("fixture materialized tagged files are invalid")
        for relative_path in paths:
            _require_fixture_file(fixture_root, str(relative_path))
        actual["physicalTaggedFiles"] = len(paths)

    supported = set(_SOURCE_COUNT_KEYS) | set(actual) | {"ddtAlbums"}
    if profile == "functional-core":
        supported.add("physicalTrackFiles")
    unsupported = set(counts) - supported
    if unsupported:
        raise ValueError(f"unsupported fixture counts: {sorted(unsupported)!r}")
    mismatches = {
        key: (int(counts[key]), value)
        for key, value in actual.items()
        if key in counts and int(counts[key]) != value
    }
    if mismatches:
        raise ValueError(f"fixture count mismatch: {mismatches!r}")


def validate_database_url(database_url: str) -> str:
    parsed = urlparse(database_url)
    if parsed.scheme not in {"postgresql", "postgres"}:
        raise ValueError("database URL scheme must be postgresql")
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("database URL must use a loopback host")
    if parsed.query or parsed.params or parsed.fragment:
        raise ValueError("database URL parameters are forbidden")
    database_name = unquote((parsed.path or "").lstrip("/"))
    if database_name == "album_haven_core":
        raise ValueError("database album_haven_core is forbidden for CI fixtures")
    if not database_name.startswith("album_haven_ci_") or not database_name[15:]:
        raise ValueError("database name must use the album_haven_ci_ suffix contract")
    suffix = database_name.removeprefix("album_haven_ci_")
    if re.fullmatch(r"[a-z0-9]+(?:_[a-z0-9]+)*", suffix) is None:
        raise ValueError("database name must use a strict CI suffix")
    username = unquote(parsed.username or "")
    if username != f"album_haven_migrator_{suffix}":
        raise ValueError("database URL must use the matching suffixed migrator role")
    if parsed.password is not None:
        raise ValueError("database URL must use pgpass instead of an embedded password")
    return database_url


def validate_connected_identity(connection: Any, database_url: str) -> None:
    parsed = urlparse(database_url)
    expected_database = unquote((parsed.path or "").lstrip("/"))
    expected_role = unquote(parsed.username or "")
    row = connection.execute(
        "select current_database(), current_user"
    ).fetchone()
    if row is None or str(row[0]) != expected_database or str(row[1]) != expected_role:
        raise ValueError("connected database identity does not match the fixture URL")


def reset_application_tables(connection: Any) -> None:
    rows = connection.execute(
        """
        select schemaname, tablename
        from pg_catalog.pg_tables
        where schemaname = any(%s)
        order by schemaname, tablename
        """,
        (list(_APPLICATION_SCHEMAS),),
    ).fetchall()
    reset_tables = [
        (str(row[0]), str(row[1]))
        for row in rows
        if (str(row[0]), str(row[1])) not in _MIGRATION_OWNED_TABLES
    ]
    if not reset_tables:
        return
    connection.execute(
        sql.SQL("truncate table {} restart identity cascade").format(
            sql.SQL(", ").join(
                sql.SQL(".").join((sql.Identifier(schema), sql.Identifier(table)))
                for schema, table in reset_tables
            )
        )
    )


def _fixture_owned_absolute_path(fixture_root: Path, relative_path: str) -> Path:
    portable_path = PurePosixPath(str(relative_path or "").replace("\\", "/"))
    resolved_path = fixture_root.joinpath(*portable_path.parts).resolve(strict=False)
    if resolved_path != fixture_root and fixture_root not in resolved_path.parents:
        raise ValueError("fixture record path escapes the fixture root")
    return resolved_path


def canonical_product_identity_key(value: object) -> str:
    """Match the product's locale-independent durable identity normalization."""
    return " ".join(str(value or "").strip().casefold().split())


def bind_fixture_record_to_extracted_root(
    table: str,
    record: Mapping[str, Any],
    fixture_root: Path,
    provider_port: int | None = None,
) -> dict[str, Any]:
    bound = dict(record)
    if table == "local_artists":
        bound["productArtistKey"] = canonical_product_identity_key(bound.get("name"))
    if table == "local_albums":
        bound["productTitleKey"] = canonical_product_identity_key(bound.get("title"))
    if table == "scan-file-index":
        bound["productArtistKey"] = canonical_product_identity_key(bound.get("artist"))
        bound["productTitleKey"] = canonical_product_identity_key(bound.get("album"))
    if table in {"local_track_files", "scan-file-index"}:
        portable_path = str(
            bound.get("privatePath") or bound.get("path") or ""
        ).strip()
        if portable_path:
            resolved_path = _fixture_owned_absolute_path(fixture_root, portable_path)
            bound["absolutePrivatePath"] = str(resolved_path)
            if resolved_path.is_file():
                stat = resolved_path.stat()
                bound["fileSizeBytes"] = stat.st_size
                bound["modifiedAtEpoch"] = stat.st_mtime
                metadata = dict(bound.get("metadata") or {})
                scan_cache = dict(metadata.get("scan_cache") or {})
                file_entry = dict(scan_cache.get("file_entry") or {})
                file_entry.update(
                    {
                        "path": str(resolved_path),
                        "mtime": stat.st_mtime,
                        "size": stat.st_size,
                    }
                )
                scan_cache["file_entry"] = file_entry
                metadata["scan_cache"] = scan_cache
                bound["metadata"] = metadata
    elif table == "local_albums":
        portable_path = str(bound.get("coverPath") or "").strip()
        if portable_path:
            bound["absoluteCoverPath"] = str(
                _fixture_owned_absolute_path(fixture_root, portable_path)
            )
    elif table == "covers":
        portable_path = str(bound.get("path") or "").strip()
        if portable_path:
            bound["absolutePath"] = str(
                _fixture_owned_absolute_path(fixture_root, portable_path)
            )
    elif table == "local_album_cover_candidate_snapshots":
        if provider_port is None:
            raise ValueError("fixture cover candidate snapshots require PLAYWRIGHT_PROVIDER_PORT")
        candidates = bound.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            raise ValueError("fixture cover candidate snapshots require candidates")
        resolved_candidates = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise ValueError("fixture cover candidate snapshot candidate is invalid")
            resolved = dict(candidate)
            for field in ("url", "thumbnail_url"):
                value = resolved.get(field)
                if not isinstance(value, str) or "${PROVIDER_PORT}" not in value:
                    raise ValueError("fixture cover candidate URL is not provider-port scoped")
                resolved[field] = value.replace("${PROVIDER_PORT}", str(provider_port))
            resolved_candidates.append(resolved)
        bound["candidates"] = resolved_candidates
    return bound


def copy_seed_to_staging(
    connection: Any,
    seed_path: Path,
    fixture_root: Path | None = None,
    provider_port: int | None = None,
) -> Counter[str]:
    counts: Counter[str] = Counter()
    scan_artists: set[str] = set()
    scan_albums: set[tuple[str, str]] = set()
    with connection.cursor() as cursor:
        with cursor.copy(
            "copy fixture_stage (ordinal, table_name, record) from stdin"
        ) as copy:
            for ordinal, (table, record) in enumerate(iter_seed_rows(seed_path), 1):
                if fixture_root is not None:
                    record = bind_fixture_record_to_extracted_root(
                        table,
                        record,
                        fixture_root,
                        provider_port,
                    )
                copy.write_row(
                    (
                        ordinal,
                        table,
                        json.dumps(
                            record,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ),
                    )
                )
                counts[table] += 1
                if table == "scan-file-index":
                    scan_artists.add(str(record.get("artist") or ""))
                    scan_albums.add(
                        (
                            str(record.get("artist") or ""),
                            str(record.get("album") or ""),
                        )
                    )
    if counts["scan-file-index"]:
        counts["local_artists"] = len(scan_artists)
        counts["local_albums"] = len(scan_albums)
        counts["local_tracks"] = counts["scan-file-index"]
        counts["local_track_files"] = counts["scan-file-index"]
    return counts


def index_fixture_staging(connection: Any) -> None:
    """Index fixture join keys after COPY so validation stays linear on CI."""
    statements = (
        "create index fixture_stage_table_idx on fixture_stage (table_name)",
        "create index fixture_stage_artist_key_idx on fixture_stage ((record->>'artistKey')) where table_name='local_artists'",
        "create index fixture_stage_artist_name_idx on fixture_stage ((record->>'name')) where table_name='local_artists'",
        "create index fixture_stage_album_key_artist_ref_idx on fixture_stage ((record->>'albumKey'), (record->>'artistRef')) where table_name='local_albums'",
        "create index fixture_stage_album_artist_ref_idx on fixture_stage ((record->>'artistRef')) where table_name='local_albums'",
        "create index fixture_stage_album_title_idx on fixture_stage ((record->>'title')) where table_name='local_albums'",
        "create index fixture_stage_track_key_album_ref_idx on fixture_stage ((record->>'trackKey'), (record->>'albumRef')) where table_name='local_tracks'",
        "create index fixture_stage_track_album_ref_idx on fixture_stage ((record->>'albumRef')) where table_name='local_tracks'",
        "create index fixture_stage_track_artist_ref_idx on fixture_stage ((record->>'artistRef')) where table_name='local_tracks'",
        "create index fixture_stage_file_track_ref_idx on fixture_stage ((coalesce(record->>'trackRef',record->>'logicalKey'))) where table_name='local_track_files'",
        "create index fixture_stage_family_artist_ref_idx on fixture_stage ((record->>'artistRef')) where table_name='local_artist_family_links'",
        "create index fixture_stage_family_related_ref_idx on fixture_stage ((record->>'relatedArtistRef')) where table_name='local_artist_family_links'",
        "create index fixture_stage_featured_album_ref_idx on fixture_stage ((record->>'albumRef')) where table_name='local_album_featured_artists'",
        "create index fixture_stage_featured_artist_ref_idx on fixture_stage ((record->>'artistRef')) where table_name='local_album_featured_artists'",
        "create index fixture_stage_cover_album_ref_idx on fixture_stage ((record->>'albumRef')) where table_name='covers'",
        "create index fixture_stage_rating_album_ref_idx on fixture_stage ((record->>'albumRef')) where table_name='album_ratings'",
        "create index fixture_stage_snapshot_album_ref_idx on fixture_stage ((record->>'albumRef')) where table_name='local_album_cover_candidate_snapshots'",
        "create index fixture_stage_ignored_repair_track_ref_idx on fixture_stage ((record->>'trackRef')) where table_name='ignored_repairs'",
        "analyze fixture_stage",
    )
    for statement in statements:
        connection.execute(statement)


def validate_staged_references(connection: Any) -> None:
    row = connection.execute(
        """
        select sum(unresolved_count) from (
          select count(*) unresolved_count from fixture_stage s
          where s.table_name='local_albums' and not exists (
            select 1 from fixture_stage a where a.table_name='local_artists'
              and a.record->>'artistKey'=s.record->>'artistRef')
          union all
          select count(*) from fixture_stage s where s.table_name='local_tracks' and (
            not exists (select 1 from fixture_stage a where a.table_name='local_artists' and a.record->>'artistKey'=s.record->>'artistRef')
            or not exists (select 1 from fixture_stage a where a.table_name='local_albums' and a.record->>'albumKey'=s.record->>'albumRef'))
          union all
          select count(*) from fixture_stage s where s.table_name='local_track_files'
            and not exists (select 1 from fixture_stage t where t.table_name='local_tracks' and t.record->>'trackKey'=coalesce(s.record->>'trackRef',s.record->>'logicalKey'))
          union all
          select count(*) from fixture_stage s where s.table_name='local_artist_family_links' and (
            not exists (select 1 from fixture_stage a where a.table_name='local_artists' and a.record->>'artistKey'=s.record->>'artistRef')
            or not exists (select 1 from fixture_stage a where a.table_name='local_artists' and a.record->>'artistKey'=s.record->>'relatedArtistRef'))
          union all
          select count(*) from fixture_stage s where s.table_name='local_album_featured_artists' and (
            not exists (select 1 from fixture_stage a where a.table_name='local_artists' and a.record->>'artistKey'=s.record->>'artistRef')
            or not exists (select 1 from fixture_stage a where a.table_name='local_albums' and a.record->>'albumKey'=s.record->>'albumRef'))
          union all
          select count(*) from fixture_stage s where s.table_name='album_ratings'
            and not exists (select 1 from fixture_stage a where a.table_name='local_albums' and a.record->>'albumKey'=s.record->>'albumRef')
          union all
          select count(*) from fixture_stage s where s.table_name='local_album_cover_candidate_snapshots'
            and not exists (select 1 from fixture_stage a where a.table_name='local_albums' and a.record->>'albumKey'=s.record->>'albumRef')
          union all
          select count(*) from fixture_stage s where s.table_name='exception_overrides'
            and not exists (select 1 from fixture_stage t where t.table_name='local_tracks' and t.record->>'trackKey'=coalesce(s.record->>'trackRef',s.record->>'trackKey'))
          union all
          select count(*) from fixture_stage s where s.table_name='ignored_repairs'
            and s.record->>'repairKey' is null
            and (
              s.record->>'field' is null
              or (select count(*) from fixture_stage f
                  where f.table_name='local_track_files'
                    and f.record->>'trackRef'=s.record->>'trackRef') <> 1
            )
          union all
          select count(*) from fixture_stage s where s.table_name='covers'
            and not exists (select 1 from fixture_stage a where a.table_name='local_albums' and a.record->>'albumKey'=s.record->>'albumRef')
        ) unresolved
        """
    ).fetchone()
    if row is None or int(row[0] or 0) != 0:
        raise ValueError("unresolved fixture reference")


def validate_staged_profile_counts(
    connection: Any, expected_counts: Mapping[str, int]
) -> None:
    if "ddtAlbums" not in expected_counts:
        return
    row = connection.execute(
        """
        select count(*) from fixture_stage album
        join fixture_stage artist
          on artist.table_name='local_artists'
         and artist.record->>'artistKey'=album.record->>'artistRef'
        where album.table_name='local_albums'
          and artist.record->>'name' in ('ДДТ', 'DDT')
        """
    ).fetchone()
    actual = 0 if row is None else int(row[0])
    expected = int(expected_counts["ddtAlbums"])
    if actual != expected:
        raise ValueError(
            f"fixture count mismatch: expected ddtAlbums={expected}, got {actual}"
        )


def validate_staged_physical_track_files(
    connection: Any, profile: str, expected_counts: Mapping[str, int]
) -> None:
    if "physicalTrackFiles" not in expected_counts:
        return
    if profile != "functional-core":
        raise ValueError("physical track file count requires functional-core")
    row = connection.execute(
        """
        select count(*)
        from fixture_stage
        where table_name=%s
          and record->>'materialized'='true'
        """,
        ("local_track_files",),
    ).fetchone()
    actual = 0 if row is None else int(row[0])
    expected = int(expected_counts["physicalTrackFiles"])
    if actual != expected:
        raise ValueError(
            f"fixture physical track file count mismatch: expected {expected}, got {actual}"
        )


def _problematic_files_filtering_contract(
    profile: str,
    counts: Mapping[str, Any],
    assertions: Mapping[str, Any],
) -> dict[str, Any] | None:
    if profile != _UTILITY_PROBLEMATIC_PROFILE:
        if "problematic-files-filtering" in assertions:
            raise ValueError(
                "fixture named scenario mismatch: problematic-files-filtering"
            )
        return None
    if set(counts) != set(_UTILITY_PROBLEMATIC_COUNTS) or any(
        counts.get(key) != value for key, value in _UTILITY_PROBLEMATIC_COUNTS.items()
    ):
        raise ValueError("fixture named scenario mismatch: problematic-files-filtering")
    value = assertions.get("problematic-files-filtering")
    if not isinstance(value, dict) or set(value) != _UTILITY_PROBLEMATIC_ASSERTION_KEYS:
        raise ValueError("fixture named scenario mismatch: problematic-files-filtering")

    album_values = value.get("expectedProblematicAlbums")
    if not isinstance(album_values, list):
        raise ValueError("fixture named scenario mismatch: problematic-files-filtering")
    normalized_albums: list[dict[str, Any]] = []
    seen_identities: set[tuple[str, str]] = set()
    for row in album_values:
        if not isinstance(row, dict) or set(row) != {
            "artist",
            "album",
            "problemReasons",
        }:
            raise ValueError("fixture named scenario mismatch: problematic-files-filtering")
        artist = row.get("artist")
        album = row.get("album")
        reasons = row.get("problemReasons")
        if (
            not isinstance(artist, str)
            or not artist
            or not isinstance(album, str)
            or not album
            or not isinstance(reasons, list)
            or not reasons
            or not all(isinstance(reason, str) and reason for reason in reasons)
            or len(reasons) != len(set(reasons))
        ):
            raise ValueError("fixture named scenario mismatch: problematic-files-filtering")
        identity = (artist, album)
        if identity in seen_identities:
            raise ValueError("fixture named scenario mismatch: problematic-files-filtering")
        seen_identities.add(identity)
        normalized_albums.append(
            {"artist": artist, "album": album, "problemReasons": list(reasons)}
        )

    expected_album_contract = {
        (artist, album): tuple(reasons)
        for artist, album, reasons in _PROBLEMATIC_FILES_ALBUMS
    }
    actual_album_contract = {
        (row["artist"], row["album"]): tuple(row["problemReasons"])
        for row in normalized_albums
    }
    if (
        value.get("problematicItemCount") != 18
        or value.get("candidateTrackFileCount") != 125
        or value.get("expectedProblemTypes") != list(_PROBLEMATIC_FILES_TYPES)
        or value.get("expectedProblemReasons") != list(_PROBLEMATIC_FILES_REASONS)
        or actual_album_contract != expected_album_contract
        or len(normalized_albums) != 18
        or value.get("summariesCompact") is not True
        or value.get("initialDetailMatchesFirstSummary") is not True
    ):
        raise ValueError("fixture named scenario mismatch: problematic-files-filtering")
    return {
        "problematicItemCount": 18,
        "candidateTrackFileCount": 125,
        "expectedProblemTypes": list(_PROBLEMATIC_FILES_TYPES),
        "expectedProblemReasons": list(_PROBLEMATIC_FILES_REASONS),
        "expectedProblematicAlbums": normalized_albums,
        "summariesCompact": True,
        "initialDetailMatchesFirstSummary": True,
    }


def validate_staged_problematic_files_scenario(
    connection: Any,
    profile: str,
    counts: Mapping[str, Any],
    assertions: Mapping[str, Any],
) -> None:
    contract = _problematic_files_filtering_contract(profile, counts, assertions)
    if contract is None:
        return
    row = connection.execute(
        """
        with expected as (
          select artist, album, "problemReasons" problem_reasons
          from jsonb_to_recordset(%s::jsonb)
            as item(artist text, album text, "problemReasons" jsonb)
        ), staged_artists as (
          select record->>'artistKey' artist_key, record->>'name' artist
          from fixture_stage where table_name='local_artists'
        ), staged_albums as (
          select album.record->>'albumKey' album_key,
                 album.record->>'title' album,
                 nullif(album.record->>'releaseYear','')::integer release_year,
                 album.record->>'coverPath' cover_path,
                 artist.artist
          from fixture_stage album
          join staged_artists artist
            on artist.artist_key=album.record->>'artistRef'
          where album.table_name='local_albums'
        ), staged_tracks as (
          select track.record->>'trackKey' track_key,
                 track.record->>'albumRef' album_key,
                 track.record->>'title' title,
                 nullif(track.record->>'discNumber','')::integer disc_number,
                 nullif(track.record->>'trackNumber','')::integer track_number,
                 track.record->'metadata' metadata,
                 artist.artist track_artist
          from fixture_stage track
          join staged_artists artist
            on artist.artist_key=track.record->>'artistRef'
          where track.table_name='local_tracks'
        ), staged_files as (
          select file.ordinal, track.album_key, album.artist, album.album,
                 album.release_year, album.cover_path,
                 track.title, track.track_artist,
                 track.disc_number, track.track_number,
                 coalesce(file.record->>'privatePath',file.record->>'path') private_path,
                 file.record->'metadata' metadata,
                 file.record->'metadata'->'scan_cache' scan_cache,
                 file.record->'metadata'->'scan_cache'->'file_entry' file_entry
          from fixture_stage file
          join staged_tracks track
            on track.track_key=coalesce(file.record->>'trackRef',file.record->>'logicalKey')
          join staged_albums album on album.album_key=track.album_key
          where file.table_name='local_track_files'
        ), active as (
          select * from staged_files
          where scan_cache is not null
            and scan_cache->>'stale'='false'
        ), candidate as (
          select active.*, expected.problem_reasons
          from active
          join expected using (artist, album)
        ), uncovered as (
          select album.* from staged_albums album
          where nullif(album.cover_path,'') is null
            and not exists (
              select 1 from fixture_stage cover
              where cover.table_name='covers'
                and cover.record->>'albumRef'=album.album_key
            )
        ), expected_uncovered as (
          select artist, album from expected
          where problem_reasons ? 'Missing cover art'
        ), album_counts as (
          select artist, count(*) album_count
          from staged_albums group by artist
        ), candidate_flags as (
          select artist, album,
                 bool_or(nullif(file_entry->>'track_number','') is null) missing_track_number,
                 bool_or(nullif(file_entry->>'year','') is null) missing_year,
                 bool_or(
                   (file_entry->>'year') ~ '^[0-9]+$'
                   and (file_entry->>'year')::integer <> release_year
                 ) year_mismatch,
                 bool_or(
                   file_entry->>'title' ~ '[^[:ascii:]]'
                   or file_entry->>'artist' ~ '[^[:ascii:]]'
                 ) encoding
          from candidate group by artist, album
        ), encoding_shape as (
          select exists (
            select 1 from candidate
            where artist='Generated Problem Fixture'
              and album='Encoding And Missing Metadata'
              and (file_entry->>'title' ~ '[^[:ascii:]]' or file_entry->>'artist' ~ '[^[:ascii:]]')
          ) present
        )
        select
          (select count(*) from staged_artists)=%s
          and (select count(*) from staged_albums)=%s
          and (select count(*) from staged_tracks)=%s
          and (select count(*) from staged_files)=%s
          and (select count(*) from fixture_stage where table_name='covers')=%s
          and (select count(*) from active)=%s
          and not exists (
            select 1 from staged_files
            where scan_cache is null or coalesce(scan_cache->>'stale','')<>'false'
          )
          and (select count(*) from expected)=%s
          and (select count(*) from candidate)=%s
          and (select count(distinct (artist,album)) from candidate)=%s
          and (select count(*) from uncovered)=%s
          and not exists (
            select artist, album from expected_uncovered
            except select artist, album from uncovered
          )
          and not exists (
            select artist, album from uncovered
            except select artist, album from expected_uncovered
          )
          and not exists (select 1 from album_counts where album_count<>10)
          and not exists (
            select 1 from active
            where jsonb_typeof(metadata) is distinct from 'object'
              or jsonb_typeof(scan_cache) is distinct from 'object'
              or jsonb_typeof(file_entry) is distinct from 'object'
              or not (file_entry ?& array['album','album_artist','artist','title','disc_number','track_number','year'])
              or file_entry->>'album' is distinct from album
              or file_entry->>'album_artist' is distinct from artist
              or file_entry->>'artist' is distinct from track_artist
              or file_entry->>'title' is distinct from title
              or nullif(file_entry->>'disc_number','')::integer is distinct from disc_number
              or nullif(file_entry->>'track_number','')::integer is distinct from track_number
          )
          and not exists (
            select 1 from active
            where not exists (
              select 1 from expected
              where expected.artist=active.artist and expected.album=active.album
            ) and (
              disc_number is null or disc_number<=0
              or track_number is null or track_number<=0
              or nullif(file_entry->>'year','') is null
              or nullif(file_entry->>'year','')::integer is distinct from release_year
              or nullif(file_entry->>'album','') is null
              or nullif(file_entry->>'album_artist','') is null
              or nullif(file_entry->>'artist','') is null
              or nullif(file_entry->>'title','') is null
            )
          )
          and not exists (
            select 1 from expected
            join candidate_flags using (artist,album)
            where candidate_flags.missing_track_number
                    is distinct from (expected.problem_reasons ? 'Missing track number')
               or candidate_flags.missing_year
                    is distinct from (expected.problem_reasons ? 'Missing year')
               or candidate_flags.year_mismatch
                    is distinct from (expected.problem_reasons ? 'Year mismatch')
               or candidate_flags.encoding
                    is distinct from (expected.problem_reasons ? 'Encoding problem')
          )
          and (
            select array_agg(format('%%s:%%s',disc_number,track_number) order by ordinal)
            from candidate where artist=%s and album=%s
          )=%s::text[]
          and (
            select array_agg(format('%%s:%%s',disc_number,coalesce(track_number::text,'null')) order by ordinal)
            from candidate where artist=%s and album=%s
          )=%s::text[]
          and (
            select array_agg(format('%%s:%%s',disc_number,track_number) order by ordinal)
            from candidate where artist=%s and album=%s
          )=%s::text[]
          and not exists (
            select 1 from candidate
            where artist=%s and album=%s and track_number is null
              and private_path !~ '/(alpha|beta)\\.mp3$'
          )
          and (select present from encoding_shape)
          and not exists (
            select 1 from fixture_stage
            where table_name <> all(%s::text[])
          )
          and (select count(distinct table_name) from fixture_stage)=%s
        """,
        (
            json.dumps(contract["expectedProblematicAlbums"], ensure_ascii=False),
            counts["artists"],
            counts["albums"],
            counts["tracks"],
            counts["trackFiles"],
            counts["covers"],
            counts["trackFiles"],
            contract["problematicItemCount"],
            contract["candidateTrackFileCount"],
            contract["problematicItemCount"],
            14,
            "E2E Rarity Artist",
            "Two Track Rarity Fixture",
            ["1:1", "1:3"],
            "E2E Rarity Artist",
            "Natural Filename Order Fixture",
            ["1:2", "1:3", "1:10", "1:null", "1:null"],
            "Various Artists",
            "Explicit Disc Label Control",
            [*[f"1:{number}" for number in range(1, 10)], *[f"2:{number}" for number in range(4, 13)]],
            "E2E Rarity Artist",
            "Natural Filename Order Fixture",
            list(_UTILITY_PROBLEMATIC_TABLES),
            len(_UTILITY_PROBLEMATIC_TABLES),
        ),
    ).fetchone()
    if row is None or row[0] is not True:
        raise ValueError("fixture staged scenario mismatch: problematic-files-filtering")


def validate_projected_problematic_files_scenario(
    connection: Any,
    profile: str,
    counts: Mapping[str, Any],
    assertions: Mapping[str, Any],
) -> None:
    contract = _problematic_files_filtering_contract(profile, counts, assertions)
    if contract is None:
        return
    row = connection.execute(
        """
        with expected as (
          select artist, album, "problemReasons" problem_reasons
          from jsonb_to_recordset(%s::jsonb)
            as item(artist text, album text, "problemReasons" jsonb)
        ), scoped_library as (
          select id from library.libraries where metadata->>'profile'=%s
        ), projected_artists as (
          select artist.id artist_id, artist.name artist
          from library.local_artists artist
          join scoped_library library on library.id=artist.library_id
        ), projected_albums as (
          select album.id album_id, album.title album, album.release_year,
                 album.cover_path, artist.artist
          from library.local_albums album
          join scoped_library library on library.id=album.library_id
          join projected_artists artist on artist.artist_id=album.artist_id
        ), projected_tracks as (
          select track.id track_id, track.title,
                 track.disc_number, track.track_number, track.metadata,
                 album.album_id, album.album, album.release_year,
                 album.cover_path, album.artist,
                 artist.artist track_artist
          from library.local_tracks track
          join scoped_library library on library.id=track.library_id
          join projected_albums album on album.album_id=track.album_id
          join projected_artists artist on artist.artist_id=track.artist_id
        ), projected_files as (
          select file.id ordinal, track.*,
                 file.private_path, file.metadata file_metadata,
                 file.metadata->'scan_cache' scan_cache,
                 file.metadata->'scan_cache'->'file_entry' file_entry
          from library.local_track_files file
          join projected_tracks track on track.track_id=file.track_id
        ), active as (
          select * from projected_files
          where scan_cache is not null and scan_cache->>'stale'='false'
        ), candidate as (
          select active.*, expected.problem_reasons
          from active join expected using (artist,album)
        ), uncovered as (
          select * from projected_albums where cover_path is null
        ), expected_uncovered as (
          select artist, album from expected
          where problem_reasons ? 'Missing cover art'
        ), album_counts as (
          select artist, count(*) album_count
          from projected_albums group by artist
        ), candidate_flags as (
          select artist, album,
                 bool_or(nullif(file_entry->>'track_number','') is null) missing_track_number,
                 bool_or(nullif(file_entry->>'year','') is null) missing_year,
                 bool_or(
                   (file_entry->>'year') ~ '^[0-9]+$'
                   and (file_entry->>'year')::integer <> release_year
                 ) year_mismatch,
                 bool_or(
                   file_entry->>'title' ~ '[^[:ascii:]]'
                   or file_entry->>'artist' ~ '[^[:ascii:]]'
                 ) encoding
          from candidate group by artist,album
        )
        select
          (select count(*) from scoped_library)=1
          and (select count(*) from projected_artists)=%s
          and (select count(*) from projected_albums)=%s
          and (select count(*) from projected_tracks)=%s
          and (select count(*) from projected_files)=%s
          and (select count(*) from projected_albums where cover_path is not null)=%s
          and (select count(*) from active)=%s
          and not exists (
            select 1 from projected_files
            where scan_cache is null or coalesce(scan_cache->>'stale','')<>'false'
          )
          and (select count(*) from expected)=%s
          and (select count(*) from candidate)=%s
          and (select count(distinct (artist,album)) from candidate)=%s
          and (select count(*) from uncovered)=%s
          and not exists (
            select artist,album from expected_uncovered
            except select artist,album from uncovered
          )
          and not exists (
            select artist,album from uncovered
            except select artist,album from expected_uncovered
          )
          and not exists (select 1 from album_counts where album_count<>10)
          and not exists (
            select 1 from active
            where jsonb_typeof(file_metadata) is distinct from 'object'
               or jsonb_typeof(scan_cache) is distinct from 'object'
               or jsonb_typeof(file_entry) is distinct from 'object'
               or not (file_entry ?& array['album','album_artist','artist','title','disc_number','track_number','year'])
               or file_entry->>'album' is distinct from album
               or file_entry->>'album_artist' is distinct from artist
               or file_entry->>'artist' is distinct from track_artist
               or file_entry->>'title' is distinct from title
               or nullif(file_entry->>'disc_number','')::integer is distinct from disc_number
               or nullif(file_entry->>'track_number','')::integer is distinct from track_number
          )
          and not exists (
            select 1 from active
            where not exists (
              select 1 from expected
              where expected.artist=active.artist and expected.album=active.album
            ) and (
              disc_number is null or disc_number<=0
              or track_number is null or track_number<=0
              or nullif(file_entry->>'year','') is null
              or nullif(file_entry->>'year','')::integer is distinct from release_year
              or nullif(file_entry->>'album','') is null
              or nullif(file_entry->>'album_artist','') is null
              or nullif(file_entry->>'artist','') is null
              or nullif(file_entry->>'title','') is null
            )
          )
          and not exists (
            select 1 from expected
            join candidate_flags using (artist,album)
            where candidate_flags.missing_track_number
                    is distinct from (expected.problem_reasons ? 'Missing track number')
               or candidate_flags.missing_year
                    is distinct from (expected.problem_reasons ? 'Missing year')
               or candidate_flags.year_mismatch
                    is distinct from (expected.problem_reasons ? 'Year mismatch')
               or candidate_flags.encoding
                    is distinct from (expected.problem_reasons ? 'Encoding problem')
          )
          and (
            select array_agg(format('%%s:%%s',disc_number,track_number) order by ordinal)
            from candidate where artist=%s and album=%s
          )=%s::text[]
          and (
            select array_agg(format('%%s:%%s',disc_number,coalesce(track_number::text,'null')) order by ordinal)
            from candidate where artist=%s and album=%s
          )=%s::text[]
          and (
            select array_agg(format('%%s:%%s',disc_number,track_number) order by ordinal)
            from candidate where artist=%s and album=%s
          )=%s::text[]
          and not exists (
            select 1 from candidate
            where artist=%s and album=%s and track_number is null
              and replace(private_path, chr(92), '/') !~ '/(alpha|beta)\\.mp3$'
          )
        """,
        (
            json.dumps(contract["expectedProblematicAlbums"], ensure_ascii=False),
            profile,
            counts["artists"],
            counts["albums"],
            counts["tracks"],
            counts["trackFiles"],
            counts["covers"],
            counts["trackFiles"],
            contract["problematicItemCount"],
            contract["candidateTrackFileCount"],
            contract["problematicItemCount"],
            14,
            "E2E Rarity Artist",
            "Two Track Rarity Fixture",
            ["1:1", "1:3"],
            "E2E Rarity Artist",
            "Natural Filename Order Fixture",
            ["1:2", "1:3", "1:10", "1:null", "1:null"],
            "Various Artists",
            "Explicit Disc Label Control",
            [*[f"1:{number}" for number in range(1, 10)], *[f"2:{number}" for number in range(4, 13)]],
            "E2E Rarity Artist",
            "Natural Filename Order Fixture",
        ),
    ).fetchone()
    if row is None or row[0] is not True:
        raise ValueError(
            "fixture projected scenario mismatch: problematic-files-filtering"
        )


def _numeric_artist_family_contract(
    assertions: Mapping[str, Any],
) -> dict[str, Any] | None:
    assertion = assertions.get("numericArtistFamily")
    if assertion is None:
        return None
    if not isinstance(assertion, dict):
        raise ValueError("fixture named relationship mismatch: numericArtistFamily")
    primary = assertion.get("primaryArtist")
    artists_value = assertion.get("familyArtists")
    source = assertion.get("relationshipSource")
    if (
        not isinstance(primary, str)
        or not isinstance(artists_value, list)
        or len(artists_value) < 2
        or not all(isinstance(name, str) and name for name in artists_value)
        or len(set(artists_value)) != len(artists_value)
        or artists_value.count(primary) != 1
        or not isinstance(source, str)
        or not source
        or assertion.get("symmetricRelationships") is not True
        or assertion.get("everyFamilyArtistHasAlbums") is not True
        or assertion.get("everyFamilyArtistHasCoveredAlbum") is not True
    ):
        raise ValueError("fixture named relationship mismatch: numericArtistFamily")
    artists = tuple(artists_value)
    related = tuple(name for name in artists if name != primary)
    return {
        "primary": primary,
        "artists": artists,
        "related": related,
        "source": source,
        "directedEdgeCount": 2 * len(related),
    }


def validate_staged_named_relationships(
    connection: Any, assertions: Mapping[str, Any]
) -> None:
    families = (
        (
            "nealMorseFamily",
            "artists",
            "neal-morse-approved-family",
            None,
            "everyJourneyAlbumHasCover",
        ),
        (
            "ariaFamily",
            "artists",
            "aria-approved-family",
            "Ария feat U.D.O.",
            "everyJourneyArtistHasCoveredAlbum",
        ),
        (
            "devinTownsendFamily",
            "familyArtists",
            "devin-townsend-approved-family",
            None,
            None,
        ),
    )
    for assertion_key, artists_key, source_family, excluded, cover_flag in families:
        assertion = assertions.get(assertion_key)
        if not isinstance(assertion, dict):
            continue
        artists = assertion.get(artists_key)
        if not isinstance(artists, list) or len(artists) < 2 or not all(
            isinstance(name, str) for name in artists
        ):
            raise ValueError(f"fixture named relationship mismatch: {assertion_key}")
        require_covers = bool(cover_flag and assertion.get(cover_flag) is True)
        row = connection.execute(
            """
            with named as (
              select record->>'artistKey' artist_key, record->>'name' artist_name
              from fixture_stage
              where table_name='local_artists' and record->>'name'=any(%s::text[])
            ), family_links as (
              select link.record
              from fixture_stage link
              where link.table_name='local_artist_family_links'
                and link.record->>'sourceFamily'=%s
                and link.record->>'artistRef' in (select artist_key from named)
                and link.record->>'relatedArtistRef' in (select artist_key from named)
            )
            select
              (select count(*) from named)=%s
              and (select count(*) from family_links)=%s
              and not exists (
                select 1 from fixture_stage link
                join fixture_stage excluded_artist
                  on excluded_artist.table_name='local_artists'
                 and excluded_artist.record->>'artistKey' in (
                   link.record->>'artistRef', link.record->>'relatedArtistRef')
                where link.table_name='local_artist_family_links'
                  and link.record->>'sourceFamily'=%s
                  and %s::text is not null
                  and excluded_artist.record->>'name'=%s
              )
              and (
                not %s::boolean or not exists (
                  select 1 from fixture_stage album
                  join named artist on artist.artist_key=album.record->>'artistRef'
                  where album.table_name='local_albums'
                    and nullif(album.record->>'coverPath','') is null
                    and not exists (
                      select 1 from fixture_stage cover
                      where cover.table_name='covers'
                        and cover.record->>'albumRef'=album.record->>'albumKey')
                )
              )
            """,
            (
                artists,
                source_family,
                len(artists),
                2 * (len(artists) - 1),
                source_family,
                excluded,
                excluded,
                require_covers,
            ),
        ).fetchone()
        if row is None or row[0] is not True:
            raise ValueError(f"fixture named relationship mismatch: {assertion_key}")

    numeric = _numeric_artist_family_contract(assertions)
    if numeric is not None:
        row = connection.execute(
            """
            with named as (
              select record->>'artistKey' artist_key, record->>'name' artist_name
              from fixture_stage
              where table_name='local_artists' and record->>'name'=any(%s::text[])
            ), source_links as (
              select origin.artist_name, related.artist_name related_name
              from fixture_stage link
              join named origin on origin.artist_key=link.record->>'artistRef'
              join named related on related.artist_key=link.record->>'relatedArtistRef'
              where link.table_name='local_artist_family_links'
                and link.record->>'sourceFamily'=%s
            )
            select
              (select count(*) from named)=%s
              and (select count(*) from source_links)=%s
              and (select count(distinct (artist_name, related_name)) from source_links)=%s
              and not exists (
                select 1 from source_links
                where not (
                  (artist_name=%s and related_name=any(%s::text[]))
                  or (related_name=%s and artist_name=any(%s::text[]))
                )
              )
              and not exists (
                select 1 from named artist
                where not exists (
                  select 1 from fixture_stage album
                  where album.table_name='local_albums'
                    and album.record->>'artistRef'=artist.artist_key
                )
              )
              and not exists (
                select 1 from named artist
                where not exists (
                  select 1 from fixture_stage album
                  where album.table_name='local_albums'
                    and album.record->>'artistRef'=artist.artist_key
                    and (
                      nullif(album.record->>'coverPath','') is not null
                      or exists (
                        select 1 from fixture_stage cover
                        where cover.table_name='covers'
                          and cover.record->>'albumRef'=album.record->>'albumKey'
                      )
                    )
                )
              )
            """,
            (
                list(numeric["artists"]),
                numeric["source"],
                len(numeric["artists"]),
                numeric["directedEdgeCount"],
                numeric["directedEdgeCount"],
                numeric["primary"],
                list(numeric["related"]),
                numeric["primary"],
                list(numeric["related"]),
            ),
        ).fetchone()
        if row is None or row[0] is not True:
            raise ValueError("fixture named relationship mismatch: numericArtistFamily")

    aria = assertions.get("ariaFamily")
    if isinstance(aria, dict):
        track = aria.get("featuredTrack", {})
        exclusive = aria.get("exclusiveSelection")
        if (
            exclusive
            != {
                "artist": "Ария & Хелависа",
                "albums": ["No albums"],
                "excludedAlbum": "Точка невозврата",
            }
        ):
            raise ValueError(
                "fixture named relationship mismatch: ariaFamily.exclusiveSelection"
            )
        row = connection.execute(
            """
            with named as (
              select record->>'artistKey' artist_key, record->>'name' artist_name
              from fixture_stage
              where table_name='local_artists' and record->>'name'=any(%s::text[])
            ), exclusive_albums as (
              select album.record
              from fixture_stage album
              join named artist on artist.artist_key=album.record->>'artistRef'
              where album.table_name='local_albums' and artist.artist_name=%s
            )
            select
              (select count(*) from exclusive_albums)=%s
              and (select array_agg(record->>'title' order by record->>'title') from exclusive_albums)=%s::text[]
              and exists (
                select 1 from exclusive_albums album
                join fixture_stage track
                  on track.table_name='local_tracks'
                 and track.record->>'albumRef'=album.record->>'albumKey'
                join named artist on artist.artist_key=track.record->>'artistRef'
                where artist.artist_name=%s
              )
              and exists (
                select 1 from fixture_stage album
                join named artist on artist.artist_key=album.record->>'artistRef'
                where album.table_name='local_albums'
                  and album.record->>'title'=%s
                  and artist.artist_name=%s
              )
              and not exists (
                select 1 from fixture_stage album
                join named artist on artist.artist_key=album.record->>'artistRef'
                where album.table_name='local_albums'
                  and album.record->>'title'=%s
                  and artist.artist_name=%s
              )
            """,
            (
                ["Ария", exclusive["artist"]],
                exclusive["artist"],
                len(exclusive["albums"]),
                exclusive["albums"],
                exclusive["artist"],
                exclusive["excludedAlbum"],
                "Ария",
                exclusive["excludedAlbum"],
                exclusive["artist"],
            ),
        ).fetchone()
        if row is None or row[0] is not True:
            raise ValueError(
                "fixture named relationship mismatch: ariaFamily.exclusiveSelection"
            )
        row = connection.execute(
            """
            select exists (
              select 1 from fixture_stage featured
              join fixture_stage album on album.table_name='local_albums' and album.record->>'albumKey'=featured.record->>'albumRef'
              join fixture_stage artist on artist.table_name='local_artists' and artist.record->>'artistKey'=featured.record->>'artistRef'
              join fixture_stage track
                on track.table_name='local_tracks'
               and track.record->>'albumRef'=album.record->>'albumKey'
               and track.record->>'title'=%s
               and nullif(track.record->>'trackNumber','')::integer=%s
              join fixture_stage track_artist
                on track_artist.table_name='local_artists'
               and track_artist.record->>'artistKey'=track.record->>'artistRef'
              where featured.table_name='local_album_featured_artists'
                and album.record->>'title'=%s
                and artist.record->>'name'='U.D.O.'
                and featured.record->>'featuredKind'='featured_track_artist'
                and nullif(featured.record->'metadata'->>'trackNumber','')::integer=%s
                and track_artist.record->>'name'=%s
                and track.record->'metadata'->>'secondaryCredit'=%s
            )
            """,
            (
                track.get("title") if isinstance(track, dict) else None,
                track.get("number") if isinstance(track, dict) else None,
                aria.get("featuredAlbum"),
                track.get("number") if isinstance(track, dict) else None,
                "Ария feat U.D.O.",
                track.get("secondaryCredit") if isinstance(track, dict) else None,
            ),
        ).fetchone()
        if row is None or row[0] is not True:
            raise ValueError("fixture named relationship mismatch: ariaFamily.featuredTrack")


def library_root_settings_payload(media_root: Path, profile: str) -> dict[str, Any]:
    return {
        "version": 1,
        "main_library_roots": [
            {
                "id": f"{profile}-root",
                "path": str(media_root),
                "layout_mode": "artist",
            }
        ],
        "hoarding_library_roots": [],
        "new_arrivals_roots": [],
        "move_policy": {},
    }


def library_root_identity(settings: Mapping[str, Any]) -> str:
    serialized = json.dumps(settings, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def product_projection_statements(profile: str) -> tuple[str, ...]:
    if not profile or any(character not in "abcdefghijklmnopqrstuvwxyz-" for character in profile):
        raise ValueError("fixture profile name is invalid")
    statements = (
        "create temporary table fixture_stage (ordinal bigint primary key, table_name text not null, record jsonb not null) on commit drop",
        "create temporary table fixture_context (profile text not null, fixture_root text not null, media_root text not null, root_settings jsonb not null, root_identity text not null) on commit drop",
        "with owner_account as (insert into app.accounts (display_name, account_kind, username_display, username_normalized, contact_email, contact_email_normalized, metadata) select 'CI Fixture Owner', 'bootstrap_owner', 'ci-fixture-owner', 'ci-fixture-owner', 'ci-fixture-owner@example.test', 'ci-fixture-owner@example.test', jsonb_build_object('source','cloud_fixture','profile',profile) from fixture_context returning id), bootstrap_owner as (insert into app.bootstrap_owners (account_id, owner_key, metadata) select id, 'local-bootstrap-owner', jsonb_build_object('source','cloud_fixture') from owner_account returning account_id) insert into library.libraries (owner_account_id, name, library_kind, metadata) select b.account_id, 'Local Library', 'local', jsonb_build_object('source','cloud_fixture','profile',c.profile,'scan_cache',jsonb_build_object('library_root_identity',c.root_identity,'last_scan',1.0,'relation_views','{}'::jsonb,'relations_last_built',0.0)) from bootstrap_owner b cross join fixture_context c",
        "insert into library.library_roots (library_id, root_path, root_kind, metadata) select l.id, c.media_root, 'main_library', jsonb_build_object('source','cloud_fixture','root_id',c.root_settings#>>'{main_library_roots,0,id}','category','main_library','category_key','main_library_roots') from library.libraries l cross join fixture_context c where l.metadata->>'profile'=c.profile",
        "insert into library.library_root_settings (library_id, layout_mode, root_categories, settings_payload) select l.id, 'artist', jsonb_build_object(c.media_root,jsonb_build_object('root_id',c.root_settings#>>'{main_library_roots,0,id}','category','main_library','category_key','main_library_roots')), c.root_settings from library.libraries l cross join fixture_context c where l.metadata->>'profile'=c.profile",
        "insert into library.local_artists (library_id, artist_key, name, sort_name, metadata) select l.id, s.record->>'productArtistKey', s.record->>'name', nullif(s.record->>'sortName',''), coalesce(s.record->'metadata','{}'::jsonb) || jsonb_build_object('fixture_artist_key',s.record->>'artistKey','fixture_product_artist_key',s.record->>'productArtistKey') from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile where s.table_name='local_artists' union all select distinct l.id, s.record->>'productArtistKey', s.record->>'artist', s.record->>'artist', jsonb_build_object('source','cloud_scan_fixture','fixture_artist_key','scan-artist-' || md5(s.record->>'artist'),'fixture_product_artist_key',s.record->>'productArtistKey') from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile where s.table_name='scan-file-index'",
        "insert into library.local_albums (library_id, artist_id, album_key, title, release_year, cover_path, metadata) select l.id, a.id, a.artist_key || '::' || (s.record->>'productTitleKey'), s.record->>'title', nullif(s.record->>'releaseYear','')::integer, nullif(s.record->>'absoluteCoverPath',''), coalesce(s.record->'metadata','{}'::jsonb) || jsonb_build_object('fixture_album_key',s.record->>'albumKey','fixture_product_title_key',s.record->>'productTitleKey') from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile join library.local_artists a on a.library_id=l.id and a.metadata->>'fixture_artist_key'=s.record->>'artistRef' where s.table_name='local_albums' union all select distinct l.id, a.id, a.artist_key || '::' || (s.record->>'productTitleKey'), s.record->>'album', nullif(s.record->>'year','')::integer, null, jsonb_build_object('source','cloud_scan_fixture','fixture_album_key','scan-album-' || md5((s.record->>'artist') || chr(31) || (s.record->>'album')),'fixture_product_title_key',s.record->>'productTitleKey') from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile join library.local_artists a on a.library_id=l.id and a.metadata->>'fixture_artist_key'='scan-artist-' || md5(s.record->>'artist') where s.table_name='scan-file-index'",
        "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, disc_number, track_number, duration_seconds, metadata) select l.id, al.id, ar.id, file.record->>'absolutePrivatePath', s.record->>'title', nullif(s.record->>'discNumber','')::integer, nullif(s.record->>'trackNumber','')::integer, nullif(s.record->>'durationSeconds','')::numeric, coalesce(s.record->'metadata','{}'::jsonb) || jsonb_build_object('fixture_track_key',s.record->>'trackKey') from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile join library.local_albums al on al.library_id=l.id and al.metadata->>'fixture_album_key'=s.record->>'albumRef' join library.local_artists ar on ar.library_id=l.id and ar.metadata->>'fixture_artist_key'=s.record->>'artistRef' join fixture_stage file on file.table_name='local_track_files' and file.record->>'trackRef'=s.record->>'trackKey' where s.table_name='local_tracks' union all select l.id, al.id, ar.id, s.record->>'absolutePrivatePath', s.record->>'title', nullif(s.record->>'discNumber','')::integer, nullif(s.record->>'trackNumber','')::integer, null, jsonb_build_object('source','cloud_scan_fixture','fixture_track_key',s.record->>'logicalKey') from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile join library.local_artists ar on ar.library_id=l.id and ar.metadata->>'fixture_artist_key'='scan-artist-' || md5(s.record->>'artist') join library.local_albums al on al.library_id=l.id and al.metadata->>'fixture_album_key'='scan-album-' || md5((s.record->>'artist') || chr(31) || (s.record->>'album')) where s.table_name='scan-file-index'",
        """
        insert into library.local_track_files
          (track_id, library_root_id, private_path, relative_path, file_size_bytes, modified_at, metadata)
        select
          t.id,
          r.id,
          s.record->>'absolutePrivatePath',
          coalesce(s.record->>'relativePath', s.record->>'path'),
          nullif(s.record->>'fileSizeBytes','')::bigint,
          to_timestamp(nullif(s.record->>'modifiedAtEpoch','')::double precision),
          coalesce(s.record->'metadata','{}'::jsonb) || jsonb_build_object(
            'scan_cache',
            coalesce(s.record->'metadata'->'scan_cache','{}'::jsonb) || jsonb_build_object(
              'source', 'runtime_scan_cache',
              'stale', coalesce((s.record->'metadata'#>>'{scan_cache,stale}')::boolean,false),
              'file_entry',
              jsonb_build_object(
                  'path', s.record->>'absolutePrivatePath',
                  'mtime', 0.0,
                  'size', coalesce(nullif(s.record->>'fileSizeBytes','')::bigint,0),
                  'album', al.title,
                  'album_artist', aa.name,
                  'artist', coalesce(nullif(t.metadata->>'displayArtist',''),nullif(t.metadata->>'rawArtist',''),ta.name),
                  'title', t.title,
                  'genre', t.metadata->>'genre',
                  'track_number', t.track_number,
                  'disc_number', t.disc_number,
                  'disc_number_raw', coalesce(nullif(t.metadata->>'rawDiscNumber',''),t.disc_number::text),
                  'duration_seconds', t.duration_seconds,
                  'cover_path', al.cover_path,
                  'cover_revision', al.metadata->>'cover_revision',
                  'cover_selection_origin', al.metadata->>'cover_selection_origin',
                  'local_cover_width', nullif(al.metadata->>'local_cover_width','')::integer,
                  'local_cover_height', nullif(al.metadata->>'local_cover_height','')::integer,
                  'remote_cover_url', al.metadata->>'remote_cover_url',
                  'remote_cover_thumbnail_url', al.metadata->>'remote_cover_thumbnail_url',
                  'remote_cover_source', al.metadata->>'remote_cover_source',
                  'remote_cover_source_label', al.metadata->>'remote_cover_source_label',
                  'year', case when t.metadata ? 'rawYear' then t.metadata->'rawYear' else to_jsonb(al.release_year) end,
                  'edition', al.metadata->>'edition',
                  'library_root_id', c.root_settings#>>'{main_library_roots,0,id}',
                  'library_root_category', 'main_library'
                ) || coalesce(s.record->'metadata'#>'{scan_cache,file_entry}',
                  '{}'::jsonb
                ) || jsonb_build_object(
                'metadata_schema_version', 2,
                'release_date', coalesce(
                  s.record->'metadata'#>'{scan_cache,file_entry,release_date}',
                  case
                    when t.metadata ? 'rawReleaseDate' then t.metadata->'rawReleaseDate'
                    when t.metadata ? 'rawYear' then t.metadata->'rawYear'
                    else to_jsonb(al.release_year::text)
                  end
                )
              )
            )
          )
        from fixture_stage s
        cross join fixture_context c
        join library.libraries l on l.metadata->>'profile'=c.profile
        join library.local_tracks t
          on t.library_id=l.id and t.metadata->>'fixture_track_key'=coalesce(s.record->>'trackRef',s.record->>'logicalKey')
        left join library.local_albums al on al.id=t.album_id and al.library_id=l.id
        left join library.local_artists aa on aa.id=al.artist_id and aa.library_id=l.id
        left join library.local_artists ta on ta.id=t.artist_id and ta.library_id=l.id
        join library.library_roots r
          on r.library_id=l.id
         and coalesce(nullif(s.record->>'rootRef',''),c.root_settings#>>'{main_library_roots,0,id}')
             = c.root_settings#>>'{main_library_roots,0,id}'
        where s.table_name in ('local_track_files','scan-file-index')
        order by s.ordinal
        """.strip(),
        "insert into app.album_ratings (account_id, library_id, album_key, rating, provenance, metadata) select l.owner_account_id, l.id, al.album_key, nullif(s.record->>'rating','')::smallint, coalesce(nullif(s.record->>'provenance',''),'cloud_fixture'), coalesce(s.record->'metadata','{}'::jsonb) from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile join library.local_albums al on al.library_id=l.id and al.metadata->>'fixture_album_key'=s.record->>'albumRef' where s.table_name='album_ratings' order by s.ordinal",
        "insert into library.local_artist_family_links (library_id, artist_id, related_artist_id, relationship_weight, source_family, source_ref, metadata) select l.id, a.id, r.id, coalesce(nullif(s.record->>'relationshipWeight','')::smallint,1), coalesce(nullif(s.record->>'sourceFamily',''),'cloud_fixture'), s.record->>'sourceRef', coalesce(s.record->'metadata','{}'::jsonb) from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile join library.local_artists a on a.library_id=l.id and a.metadata->>'fixture_artist_key'=s.record->>'artistRef' join library.local_artists r on r.library_id=l.id and r.metadata->>'fixture_artist_key'=s.record->>'relatedArtistRef' where s.table_name='local_artist_family_links' order by s.ordinal",
        "insert into library.local_album_featured_artists (library_id, album_id, artist_id, featured_kind, metadata) select al.library_id, al.id, al.artist_id, 'owner', jsonb_build_object('source','cloud_fixture','profile',c.profile) from library.local_albums al cross join fixture_context c join library.libraries l on l.id=al.library_id and l.metadata->>'profile'=c.profile order by al.id",
        "insert into library.local_album_featured_artists (library_id, album_id, artist_id, featured_kind, metadata) select l.id, al.id, ar.id, s.record->>'featuredKind', coalesce(s.record->'metadata','{}'::jsonb) from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile join library.local_albums al on al.library_id=l.id and al.metadata->>'fixture_album_key'=s.record->>'albumRef' join library.local_artists ar on ar.library_id=l.id and ar.metadata->>'fixture_artist_key'=s.record->>'artistRef' where s.table_name='local_album_featured_artists' order by s.ordinal",
        "insert into library.local_album_cover_candidate_snapshots (album_id, search_generation, search_kind, status, revision, candidates, best_candidate_id, started_at, updated_at, finished_at) select al.id, (s.record->>'searchGeneration')::uuid, s.record->>'searchKind', s.record->>'status', (s.record->>'revision')::bigint, s.record->'candidates', s.record->>'bestCandidateId', now(), now(), now() from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile join library.local_albums al on al.library_id=l.id and al.metadata->>'fixture_album_key'=s.record->>'albumRef' where s.table_name='local_album_cover_candidate_snapshots' order by s.ordinal",
        "insert into library.ignored_versions (library_id, version_key, metadata) select l.id, s.record->>'versionKey', coalesce(s.record->'metadata','{}'::jsonb) from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile where s.table_name='ignored_versions' order by s.ordinal",
        "insert into library.ignored_repairs (library_id, repair_key, metadata) select l.id, coalesce(nullif(s.record->>'repairKey',''), f.private_path || '::' || (s.record->>'field')), coalesce(s.record->'metadata','{}'::jsonb) from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile left join library.local_tracks t on t.library_id=l.id and t.metadata->>'fixture_track_key'=s.record->>'trackRef' left join library.local_track_files f on f.track_id=t.id where s.table_name='ignored_repairs' order by s.ordinal",
        "insert into library.exception_overrides (library_id, track_id, track_key, override_payload) select l.id, t.id, t.track_key, coalesce(s.record->'overridePayload','{}'::jsonb) from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile join library.local_tracks t on t.library_id=l.id and t.metadata->>'fixture_track_key'=s.record->>'trackKey' where s.table_name='exception_overrides' order by s.ordinal",
        "update library.local_albums al set cover_path=s.record->>'absolutePath' from fixture_stage s cross join fixture_context c join library.libraries l on l.metadata->>'profile'=c.profile where s.table_name='covers' and al.library_id=l.id and al.metadata->>'fixture_album_key'=s.record->>'albumRef'",
        "select setval(pg_get_serial_sequence('library.local_artists','id'), greatest(coalesce((select max(id) from library.local_artists),1),1), exists(select 1 from library.local_artists))",
        "select setval(pg_get_serial_sequence('library.local_albums','id'), greatest(coalesce((select max(id) from library.local_albums),1),1), exists(select 1 from library.local_albums))",
        "select setval(pg_get_serial_sequence('library.local_tracks','id'), greatest(coalesce((select max(id) from library.local_tracks),1),1), exists(select 1 from library.local_tracks))",
        "select setval(pg_get_serial_sequence('library.local_track_files','id'), greatest(coalesce((select max(id) from library.local_track_files),1),1), exists(select 1 from library.local_track_files))",
        "analyze app.album_ratings, library.libraries, library.library_roots, library.library_root_settings, library.local_artists, library.local_albums, library.local_tracks, library.local_track_files, library.local_artist_family_links, library.local_album_featured_artists, library.local_album_cover_candidate_snapshots, library.ignored_versions, library.ignored_repairs, library.exception_overrides",
    )
    return statements


def validate_loaded_contract(
    expected_counts: Mapping[str, int],
    expected_assertions: Mapping[str, Any],
    actual_counts: Mapping[str, int],
    actual_assertions: Mapping[str, Any],
) -> None:
    if dict(expected_counts) != dict(actual_counts):
        raise ValueError(
            f"fixture count mismatch: expected {dict(expected_counts)!r}, got {dict(actual_counts)!r}"
        )
    if dict(expected_assertions) != dict(actual_assertions):
        raise ValueError("fixture named identity mismatch")


def _database_source_counts(
    expected: Mapping[str, int], staged: Mapping[str, int]
) -> tuple[dict[str, int], dict[str, int]]:
    expected_database: dict[str, int] = {}
    actual_database: dict[str, int] = {}
    for key, table in _SOURCE_COUNT_KEYS.items():
        if key in expected:
            expected_database[key] = int(expected[key])
            actual_database[key] = int(staged.get(table, 0))
    return expected_database, actual_database


def _identity_assertions(assertions: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    identities: dict[str, dict[str, Any]] = {}
    artist_scalar_keys = {
        "artist",
        "primaryArtist",
        "combinedArtist",
        "searchFollowUp",
        "query",
    }
    album_scalar_keys = {
        "album",
        "featuredAlbum",
        "resonanceAlbum",
        "cosmicCathedralAlbum",
        "splitRelease",
    }

    def visit(value: Any, path: tuple[str, ...]) -> None:
        if path == ("functionalInventory", "scanDiscovery"):
            return
        name = ".".join(path)
        if isinstance(value, list):
            if path and path[-1] in {"artists", "familyArtists"}:
                for index, artist_name in enumerate(value):
                    if isinstance(artist_name, str):
                        identities[f"{name}[{index}]"] = {"artist": artist_name}
            for index, item in enumerate(value):
                visit(item, (*path, f"[{index}]"))
            return
        if not isinstance(value, dict):
            return

        identity: dict[str, Any] = {}
        if isinstance(value.get("artist"), str):
            identity["artist"] = value["artist"]
        if isinstance(value.get("album"), str):
            identity["album"] = value["album"]
        if "year" in value:
            identity["year"] = value["year"]
        if isinstance(value.get("title"), str) and "year" in value:
            identity["album"] = value["title"]
        if path and path[-1] == "featuredTrack":
            identity.update(
                {
                    "trackTitle": value.get("title"),
                    "trackNumber": value.get("number"),
                    "secondaryCredit": value.get("secondaryCredit"),
                }
            )
        if identity:
            identities[name] = identity

        for key, item in value.items():
            item_path = (*path, key)
            if isinstance(item, str) and key in artist_scalar_keys:
                identities[".".join(item_path)] = {"artist": item}
            elif isinstance(item, str) and key in album_scalar_keys:
                identities[".".join(item_path)] = {"album": item}
            visit(item, item_path)

    visit(dict(assertions), ())
    aria = assertions.get("ariaFamily")
    if isinstance(aria, dict):
        if isinstance(aria.get("featuredAlbum"), str):
            identities["ariaFamily.featuredAlbum"] = {
                "artist": "Ария",
                "album": aria["featuredAlbum"],
            }
        track = aria.get("featuredTrack")
        if isinstance(track, dict) and isinstance(track.get("title"), str):
            identities["ariaFamily.featuredTrack"] = {
                "artist": "Ария feat U.D.O.",
                "album": aria.get("featuredAlbum"),
                "trackTitle": track["title"],
                "trackNumber": track.get("number"),
                "secondaryCredit": track.get("secondaryCredit"),
            }

    ddt = assertions.get("ddt")
    if isinstance(ddt, dict):
        for index, album in enumerate(ddt.get("albums", [])):
            if isinstance(album, dict) and isinstance(album.get("title"), str):
                identities[f"ddt.albums[{index}]"] = {
                    "artist": "ДДТ",
                    "album": album["title"],
                    "year": album.get("year"),
                }
        for key, album_name in (
            ("studioTracks", "Студийные записи"),
            ("remixTracks", "Ремиксы"),
        ):
            for index, title in enumerate(ddt.get(key, [])):
                if isinstance(title, str):
                    identities[f"ddt.{key}[{index}]"] = {
                        "artist": "ДДТ",
                        "album": album_name,
                        "trackTitle": title,
                    }

    neal = assertions.get("nealMorseFamily")
    if isinstance(neal, dict):
        for key, artist_name in (
            ("resonanceAlbum", "Neal Morse & The Resonance"),
            ("cosmicCathedralAlbum", "Cosmic Cathedral"),
        ):
            if isinstance(neal.get(key), str):
                identities[f"nealMorseFamily.{key}"] = {
                    "artist": artist_name,
                    "album": neal[key],
                }
    return identities


def _validate_staged_named_identities(
    connection: Any, assertions: Mapping[str, Any]
) -> None:
    for name, identity in _identity_assertions(assertions).items():
        track_title = identity.get("trackTitle")
        if track_title is not None:
            row = connection.execute(
                """
                select 1 from fixture_stage t
                join fixture_stage album on album.table_name='local_albums' and album.record->>'albumKey'=t.record->>'albumRef'
                join fixture_stage artist on artist.table_name='local_artists' and artist.record->>'artistKey'=t.record->>'artistRef'
                where t.table_name='local_tracks'
                  and t.record->>'title'=%s
                  and (%s::text is null or album.record->>'title'=%s)
                  and (%s::text is null or artist.record->>'name'=%s)
                  and (%s::integer is null or nullif(t.record->>'trackNumber','')::integer=%s)
                  and (%s::text is null or t.record->'metadata'->>'secondaryCredit'=%s)
                limit 1
                """,
                (
                    track_title,
                    identity.get("album"),
                    identity.get("album"),
                    identity.get("artist"),
                    identity.get("artist"),
                    identity.get("trackNumber"),
                    identity.get("trackNumber"),
                    identity.get("secondaryCredit"),
                    identity.get("secondaryCredit"),
                ),
            ).fetchone()
            if row is None:
                raise ValueError(f"fixture named identity mismatch: {name}")
            continue
        artist = identity.get("artist")
        album = identity.get("album")
        year = identity.get("year")
        row = connection.execute(
            """
            select 1
            from fixture_stage album
            left join fixture_stage artist
              on artist.table_name = 'local_artists'
             and artist.record->>'artistKey' = album.record->>'artistRef'
            where (
              album.table_name = 'local_albums'
              and (%s::text is null or artist.record->>'name' = %s)
              and (%s::text is null or album.record->>'title' = %s)
              and (%s::integer is null or nullif(album.record->>'releaseYear','')::integer = %s)
            ) or (
              album.table_name = 'scan-file-index'
              and (%s::text is null or album.record->>'artist' = %s)
              and (%s::text is null or album.record->>'album' = %s)
              and (%s::integer is null or nullif(album.record->>'year','')::integer = %s)
            )
            limit 1
            """,
            (
                artist,
                artist,
                album,
                album,
                year,
                year,
                artist,
                artist,
                album,
                album,
                year,
                year,
            ),
        ).fetchone()
        if row is None:
            raise ValueError(f"fixture named identity mismatch: {name}")


def _validate_projected_named_identities(
    connection: Any, profile: str, assertions: Mapping[str, Any]
) -> None:
    for name, identity in _identity_assertions(assertions).items():
        track_title = identity.get("trackTitle")
        if track_title is not None:
            row = connection.execute(
                """
                select 1 from library.libraries l
                join library.local_tracks t on t.library_id=l.id
                join library.local_albums al on al.id=t.album_id and al.library_id=l.id
                join library.local_artists ar on ar.id=t.artist_id and ar.library_id=l.id
                where l.metadata->>'profile'=%s and t.title=%s
                  and (%s::text is null or al.title=%s)
                  and (%s::text is null or ar.name=%s)
                  and (%s::integer is null or t.track_number=%s)
                  and (%s::text is null or t.metadata->>'secondaryCredit'=%s)
                limit 1
                """,
                (
                    profile,
                    track_title,
                    identity.get("album"),
                    identity.get("album"),
                    identity.get("artist"),
                    identity.get("artist"),
                    identity.get("trackNumber"),
                    identity.get("trackNumber"),
                    identity.get("secondaryCredit"),
                    identity.get("secondaryCredit"),
                ),
            ).fetchone()
            if row is None:
                raise ValueError(
                    f"fixture named identity mismatch after projection: {name}"
                )
            continue
        artist = identity.get("artist")
        album = identity.get("album")
        year = identity.get("year")
        row = connection.execute(
            """
            select 1
            from library.libraries l
            left join library.local_artists ar on ar.library_id = l.id
            left join library.local_albums al
              on al.library_id = l.id and (ar.id is null or al.artist_id = ar.id)
            where l.metadata->>'profile' = %s
              and (%s::text is null or ar.name = %s)
              and (%s::text is null or al.title = %s)
              and (%s::integer is null or al.release_year = %s)
            limit 1
            """,
            (profile, artist, artist, album, album, year, year),
        ).fetchone()
        if row is None:
            raise ValueError(f"fixture named identity mismatch after projection: {name}")


def _validate_projected_counts(
    connection: Any,
    profile: str,
    expected_counts: Mapping[str, int],
    staged_counts: Mapping[str, int],
) -> None:
    row = connection.execute(
        """
        select
          (select count(*) from library.local_artists a where a.library_id=l.id),
          (select count(*) from library.local_albums a where a.library_id=l.id),
          (select count(*) from library.local_tracks t where t.library_id=l.id),
          (select count(*) from library.local_track_files f join library.local_tracks t on t.id=f.track_id where t.library_id=l.id),
          (select count(*) from app.album_ratings r where r.account_id=l.owner_account_id and r.library_id=l.id),
          (select count(*) from library.local_artist_family_links f where f.library_id=l.id),
          (select count(*) from library.local_album_featured_artists f where f.library_id=l.id and f.featured_kind <> 'owner'),
          (select count(*) from library.ignored_versions v where v.library_id=l.id),
          (select count(*) from library.ignored_repairs r where r.library_id=l.id),
          (select count(*) from library.exception_overrides e where e.library_id=l.id)
          ,(select count(*) from library.local_albums a where a.library_id=l.id and exists (select 1 from fixture_stage s where s.table_name='covers' and s.record->>'albumRef'=a.metadata->>'fixture_album_key') and a.cover_path is not null)
          ,(select count(*) from library.local_album_cover_candidate_snapshots s join library.local_albums a on a.id=s.album_id where a.library_id=l.id)
        from library.libraries l where l.metadata->>'profile'=%s
        """,
        (profile,),
    ).fetchone()
    if row is None:
        raise ValueError("fixture count mismatch: projected library is missing")
    owner_row = connection.execute(
        """
        select
          (select count(*) from library.local_album_featured_artists f
             where f.library_id=l.id and f.featured_kind='owner')
            = (select count(*) from library.local_albums a where a.library_id=l.id)
          and not exists (
            select 1
            from library.local_albums a
            left join library.local_album_featured_artists f
              on f.library_id=a.library_id
             and f.album_id=a.id
             and f.artist_id=a.artist_id
             and f.featured_kind='owner'
            where a.library_id=l.id and f.id is null
          )
        from library.libraries l
        where l.metadata->>'profile'=%s
        group by l.id
        """,
        (profile,),
    ).fetchone()
    if owner_row is None or owner_row[0] is not True:
        raise ValueError("fixture relationship mismatch after projection: album owners")
    artist_identity_row = connection.execute(
        """
        select not exists (
          select 1
          from library.local_artists a
          join library.libraries l on l.id=a.library_id
          where l.metadata->>'profile'=%s
            and a.artist_key <> a.metadata->>'fixture_product_artist_key'
        )
        """,
        (profile,),
    ).fetchone()
    if artist_identity_row is None or artist_identity_row[0] is not True:
        raise ValueError(
            "fixture identity mismatch after projection: canonical artist keys"
        )
    album_identity_row = connection.execute(
        """
        select not exists (
          select 1
          from library.local_albums al
          join library.local_artists ar
            on ar.library_id=al.library_id and ar.id=al.artist_id
          join library.libraries l on l.id=al.library_id
          where l.metadata->>'profile'=%s
            and al.album_key <> ar.artist_key || '::' || (al.metadata->>'fixture_product_title_key')
        )
        """,
        (profile,),
    ).fetchone()
    if album_identity_row is None or album_identity_row[0] is not True:
        raise ValueError(
            "fixture identity mismatch after projection: canonical album keys"
        )
    table_counts = {
        "local_artists": int(row[0]),
        "local_albums": int(row[1]),
        "local_tracks": int(row[2]),
        "local_track_files": int(row[3]),
        "album_ratings": int(row[4]),
        "local_artist_family_links": int(row[5]),
        "local_album_featured_artists": int(row[6]),
        "ignored_versions": int(row[7]),
        "ignored_repairs": int(row[8]),
        "exception_overrides": int(row[9]),
        "covers": int(row[10]),
        "local_album_cover_candidate_snapshots": int(row[11]),
        "scan-file-index": int(staged_counts.get("scan-file-index", 0)),
    }
    expected_database, _ = _database_source_counts(expected_counts, staged_counts)
    actual_database = {
        key: table_counts[table]
        for key, table in _PROJECTED_COUNT_KEYS.items()
        if key in expected_database
    }
    if expected_database != actual_database:
        raise ValueError(
            f"fixture count mismatch after projection: expected {expected_database!r}, got {actual_database!r}"
        )


def validate_projected_ignored_repairs(connection: Any, profile: str) -> None:
    row = connection.execute(
        """
        with requested(profile) as (values (%s)),
        expected as (
          select l.id library_id,
                 coalesce(
                   nullif(s.record->>'repairKey',''),
                   f.private_path || '::' || (s.record->>'field')
                 ) repair_key,
                 coalesce(s.record->'metadata','{}'::jsonb) metadata
          from fixture_stage s
          cross join fixture_context c
          join library.libraries l on l.metadata->>'profile'=c.profile
          left join library.local_tracks t
            on t.library_id=l.id
           and t.metadata->>'fixture_track_key'=s.record->>'trackRef'
          left join library.local_track_files f on f.track_id=t.id
          where s.table_name='ignored_repairs'
        ), actual as (
          select r.library_id, r.repair_key, r.metadata
          from library.ignored_repairs r
          join library.libraries l on l.id=r.library_id
          cross join requested q
          where l.metadata->>'profile'=q.profile
        ), mismatches as (
          (select library_id, repair_key, metadata from expected
           except all
           select library_id, repair_key, metadata from actual)
          union all
          (select library_id, repair_key, metadata from actual
           except all
           select library_id, repair_key, metadata from expected)
        )
        select count(*) from mismatches
        """,
        (profile,),
    ).fetchone()
    if row is None or int(row[0] or 0) != 0:
        raise ValueError("ignored repair mismatch after projection")


def validate_projected_scan_discovery_absence(
    connection: Any, profile: str, assertions: Mapping[str, Any]
) -> None:
    contract = _functional_scan_discovery_contract(profile, assertions)
    if contract is None:
        return
    row = connection.execute(
        """
        with requested(profile, artist_name, album_title, track_title) as (
          values (%s, %s, %s, %s)
        )
        select
          (select count(*) from library.local_albums al
           join library.local_artists ar on ar.id=al.artist_id
           join library.libraries l on l.id=al.library_id
           cross join requested q
           where l.metadata->>'profile'=q.profile
             and ar.name=q.artist_name and al.title=q.album_title)
          +
          (select count(*) from library.local_tracks t
           join library.local_albums al on al.id=t.album_id
           join library.local_artists ar on ar.id=al.artist_id
           join library.libraries l on l.id=t.library_id
           cross join requested q
           where l.metadata->>'profile'=q.profile
             and ar.name=q.artist_name and al.title=q.album_title
             and t.title=q.track_title)
        """,
        (profile, contract["artist"], contract["album"], contract["track"]),
    ).fetchone()
    if row is None or int(row[0] or 0) != 0:
        raise ValueError("scan discovery rows exist before incremental scan")


def load_fixture_profile(
    *,
    fixture_root: Path,
    profile: str,
    database_url: str,
    replace_existing: bool = False,
    connect: Callable[[str], Any] = psycopg.connect,
) -> None:
    fixture_root = fixture_root.resolve()
    manifest_path = fixture_root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("fixture manifest is invalid JSON") from exc
    definition = validate_manifest_profile(manifest, profile)
    validate_auxiliary_contract(fixture_root, profile, definition)
    validate_database_url(database_url)
    seed_path = (fixture_root / str(definition["databaseSeed"])).resolve()
    if fixture_root not in seed_path.parents:
        raise ValueError("fixture database seed escapes the fixture root")
    media_root = (fixture_root / str(definition["mediaRoot"])).resolve()
    if fixture_root not in media_root.parents or not media_root.is_dir():
        raise ValueError("fixture media root is missing or escapes the fixture root")
    root_settings = library_root_settings_payload(media_root, profile)
    root_identity = library_root_identity(root_settings)
    provider_port: int | None = None
    if int(definition["counts"].get("coverCandidateSnapshots", 0)):
        raw_provider_port = os.environ.get("PLAYWRIGHT_PROVIDER_PORT", "")
        if re.fullmatch(r"[1-9][0-9]{0,4}", raw_provider_port) is None:
            raise ValueError("PLAYWRIGHT_PROVIDER_PORT is required for fixture cover candidates")
        provider_port = int(raw_provider_port)
        if provider_port > 65535:
            raise ValueError("PLAYWRIGHT_PROVIDER_PORT is invalid")

    with connect(database_url) as connection:
        validate_connected_identity(connection, database_url)
        with connection.transaction():
            if replace_existing:
                reset_application_tables(connection)
            statements = product_projection_statements(profile)
            connection.execute(statements[0])
            connection.execute(statements[1])
            connection.execute(
                "insert into fixture_context (profile, fixture_root, media_root, root_settings, root_identity) values (%s, %s, %s, %s::jsonb, %s)",
                (
                    profile,
                    str(fixture_root),
                    str(media_root),
                    json.dumps(root_settings, ensure_ascii=False, separators=(",", ":")),
                    root_identity,
                ),
            )
            staged_counts = copy_seed_to_staging(
                connection,
                seed_path,
                fixture_root,
                provider_port,
            )
            index_fixture_staging(connection)
            validate_staged_references(connection)
            validate_staged_profile_counts(connection, definition["counts"])
            validate_staged_physical_track_files(
                connection, profile, definition["counts"]
            )
            validate_staged_named_relationships(
                connection, definition["namedScenarioAssertions"]
            )
            validate_staged_problematic_files_scenario(
                connection,
                profile,
                definition["counts"],
                definition["namedScenarioAssertions"],
            )
            expected_counts, actual_counts = _database_source_counts(
                definition["counts"], staged_counts
            )
            if expected_counts != actual_counts:
                raise ValueError(
                    f"fixture count mismatch: expected {expected_counts!r}, got {actual_counts!r}"
                )
            _validate_staged_named_identities(
                connection, definition["namedScenarioAssertions"]
            )
            for statement in statements[2:]:
                connection.execute(statement)
            _validate_projected_counts(
                connection, profile, definition["counts"], staged_counts
            )
            _validate_projected_named_identities(
                connection, profile, definition["namedScenarioAssertions"]
            )
            validate_projected_ignored_repairs(connection, profile)
            validate_projected_scan_discovery_absence(
                connection, profile, definition["namedScenarioAssertions"]
            )
            validate_projected_problematic_files_scenario(
                connection,
                profile,
                definition["counts"],
                definition["namedScenarioAssertions"],
            )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load an Album Haven CI fixture profile")
    parser.add_argument(
        "--fixture-root",
        type=Path,
        default=os.environ.get("ALBUM_HAVEN_FIXTURE_ROOT"),
        required=not bool(os.environ.get("ALBUM_HAVEN_FIXTURE_ROOT")),
    )
    parser.add_argument(
        "--profile",
        default=os.environ.get("ALBUM_HAVEN_FIXTURE_PROFILE"),
        required=not bool(os.environ.get("ALBUM_HAVEN_FIXTURE_PROFILE")),
    )
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_MIGRATOR_URL"),
        required=not bool(os.environ.get("DATABASE_MIGRATOR_URL")),
    )
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="Transactionally reset normal application tables before loading the fixture.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    load_fixture_profile(
        fixture_root=args.fixture_root,
        profile=args.profile,
        database_url=args.database_url,
        replace_existing=args.replace_existing,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
