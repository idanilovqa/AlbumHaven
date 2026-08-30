from __future__ import annotations

import importlib.util
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
from types import ModuleType
from typing import Any

import pytest
import zstandard


LOADER_PATH = Path(__file__).parents[2] / "scripts" / "ci" / "load-fixture-profile.py"
BOOTSTRAP_PATH = Path(__file__).parents[2] / "scripts" / "ci" / "bootstrap-windows-postgres.ps1"


def _load_fixture_loader_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("album_haven_ci_fixture_loader", LOADER_PATH)
    assert spec is not None and spec.loader is not None, f"loader is missing: {LOADER_PATH}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_seed(path: Path, rows: list[object]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    compressor = zstandard.ZstdCompressor(write_checksum=True)
    payload = b"".join(
        (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        for row in rows
    )
    path.write_bytes(compressor.compress(payload))
    return path


def _manifest(*, counts: dict[str, int] | None = None, assertions: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "manifestVersion": 1,
        "release": "fixtures-v1.0.0",
        "generatorCommit": "a" * 40,
        "profiles": {
            "functional-core": {
                "schemaVersion": 1,
                "databaseSeed": "database/functional-core.ndjson.zst",
                "mediaRoot": "media",
                "counts": counts or {"artists": 1, "albums": 1, "tracks": 1, "trackFiles": 1},
                "namedScenarioAssertions": assertions
                or {"joseph": {"artist": "Neal Morse", "album": "Joseph: Part One - The Dreamer", "year": 2023}},
            }
        },
    }


class _RecordingCopy:
    def __init__(self, owner: "_RecordingConnection", statement: str) -> None:
        self.owner = owner
        self.statement = statement

    def __enter__(self) -> "_RecordingCopy":
        self.owner.copy_statements.append(self.statement)
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def write_row(self, row: tuple[object, ...]) -> None:
        self.owner.copied_rows.append(row)


class _RecordingCursor:
    def __init__(self, owner: "_RecordingConnection") -> None:
        self.owner = owner

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def copy(self, statement: str) -> _RecordingCopy:
        return _RecordingCopy(self.owner, statement)

    def execute(self, statement: str, parameters: object = None) -> "_RecordingCursor":
        self.owner.executed.append((statement, parameters))
        return self

    def fetchone(self) -> tuple[str, str]:
        return ("album_haven_ci_123", "album_haven_migrator_123")


class _RecordingTransaction:
    def __init__(self, owner: "_RecordingConnection") -> None:
        self.owner = owner

    def __enter__(self) -> "_RecordingTransaction":
        self.owner.events.append("begin")
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.owner.events.append("rollback" if exc_type is not None else "commit")
        return None


class _RecordingConnection:
    def __init__(self) -> None:
        self.copy_statements: list[str] = []
        self.copied_rows: list[tuple[object, ...]] = []
        self.executed: list[tuple[str, object]] = []
        self.events: list[str] = []

    def __enter__(self) -> "_RecordingConnection":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def cursor(self) -> _RecordingCursor:
        return _RecordingCursor(self)

    def execute(self, statement: str, parameters: object = None) -> _RecordingCursor:
        return _RecordingCursor(self).execute(statement, parameters)

    def transaction(self) -> _RecordingTransaction:
        return _RecordingTransaction(self)


def test_loader_iter_seed_rows_decodes_zstd_ndjson_envelopes_in_source_order(tmp_path: Path) -> None:
    loader = _load_fixture_loader_module()
    seed = _write_seed(
        tmp_path / "fixture.ndjson.zst",
        [
            {"table": "local_albums", "record": {"albumKey": "album-1", "title": "Album"}},
            {"table": "local_artists", "record": {"artistKey": "artist-1", "name": "Artist"}},
        ],
    )

    assert list(loader.iter_seed_rows(seed)) == [
        ("local_albums", {"albumKey": "album-1", "title": "Album"}),
        ("local_artists", {"artistKey": "artist-1", "name": "Artist"}),
    ]


def test_loader_rejects_unknown_seed_table_before_database_write(tmp_path: Path) -> None:
    loader = _load_fixture_loader_module()
    seed = _write_seed(tmp_path / "fixture.ndjson.zst", [{"table": "ops.schema_migrations", "record": {"checksum": "hostile"}}])

    with pytest.raises(ValueError, match="unknown fixture table"):
        list(loader.iter_seed_rows(seed))


@pytest.mark.parametrize(
    "payload",
    [
        b"not-zstd",
        zstandard.ZstdCompressor().compress(b"not-json\n"),
        zstandard.ZstdCompressor().compress(b'{"table":"local_artists"}\n'),
        zstandard.ZstdCompressor().compress(b'{"table":"local_artists","record":[]}\n'),
    ],
)
def test_loader_rejects_corrupt_compressed_json_or_row_envelope(tmp_path: Path, payload: bytes) -> None:
    loader = _load_fixture_loader_module()
    seed = tmp_path / "fixture.ndjson.zst"
    seed.write_bytes(payload)

    with pytest.raises(ValueError, match="fixture row|zstd|JSON"):
        list(loader.iter_seed_rows(seed))


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda value: value.update(manifestVersion=2), "manifest schema"),
        (lambda value: value["profiles"].pop("functional-core"), "profile"),
        (lambda value: value["profiles"]["functional-core"].update(schemaVersion=2), "profile schema"),
        (lambda value: value["profiles"]["functional-core"].pop("counts"), "counts"),
        (lambda value: value["profiles"]["functional-core"].pop("namedScenarioAssertions"), "named"),
        (lambda value: value["profiles"]["functional-core"].pop("mediaRoot"), "media root"),
    ],
)
def test_loader_rejects_manifest_profile_contract_mismatches(mutation: Any, message: str) -> None:
    loader = _load_fixture_loader_module()
    manifest = _manifest()
    mutation(manifest)

    with pytest.raises(ValueError, match=message):
        loader.validate_manifest_profile(manifest, "functional-core")


@pytest.mark.parametrize(
    "database_url",
    [
        "postgresql://album_haven_migrator@db.example.test/album_haven_ci_123",
        "postgresql://album_haven_migrator@localhost/album_haven_core",
        "https://album_haven_migrator@localhost/album_haven_ci_123",
        "postgresql://album_haven_migrator@localhost/postgres",
        "postgresql://album_haven_app_123@localhost/album_haven_ci_123",
        "postgresql://album_haven_migrator_123@localhost/album_haven_ci_456",
        "postgresql://album_haven_migrator_123@localhost/album_haven_ci_123?host=db.example.test",
        "postgresql://album_haven_migrator_123@localhost/album_haven_ci_123?hostaddr=203.0.113.1",
    ],
)
def test_loader_rejects_remote_reserved_or_non_postgres_database_urls(database_url: str) -> None:
    loader = _load_fixture_loader_module()

    with pytest.raises(ValueError, match="loopback|database|scheme|migrator|parameter"):
        loader.validate_database_url(database_url)


def test_loader_allows_only_declared_fixture_tables() -> None:
    loader = _load_fixture_loader_module()

    assert loader.ALLOWED_FIXTURE_TABLES == frozenset(
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


@pytest.mark.parametrize(
    ("table", "record"),
    [
        ("local_track_files", {"privatePath": "../../owner.mp3"}),
        ("local_track_files", {"relativePath": r"X:\PrivateRoot\song.mp3"}),
        ("local_albums", {"coverPath": "/owner/cover.jpg"}),
        ("covers", {"path": r"\\server\share\cover.jpg"}),
    ],
)
def test_loader_rejects_fixture_paths_that_escape_the_extracted_root(
    table: str, record: dict[str, object]
) -> None:
    loader = _load_fixture_loader_module()

    with pytest.raises(ValueError, match="fixture-relative"):
        loader.validate_fixture_record(table, record)


@pytest.mark.parametrize(
    "record",
    [
        {},
        {"repairKey": ""},
        {"trackRef": "track-1"},
        {"field": "album"},
        {"trackRef": "track-1", "field": "unsupported"},
        {"repairKey": "legacy::album", "trackRef": "track-1", "field": "album"},
    ],
)
def test_loader_rejects_invalid_or_ambiguous_ignored_repair_records(
    record: dict[str, object],
) -> None:
    loader = _load_fixture_loader_module()

    with pytest.raises(ValueError, match="ignored repair"):
        loader.validate_fixture_record("ignored_repairs", record)


def test_loader_accepts_legacy_and_portable_ignored_repair_records() -> None:
    loader = _load_fixture_loader_module()

    loader.validate_fixture_record("ignored_repairs", {"repairKey": "legacy::album"})
    loader.validate_fixture_record(
        "ignored_repairs",
        {"trackRef": "track-1", "field": "album"},
    )


def _scan_discovery_assertions() -> dict[str, object]:
    return {
        "functionalInventory": {
            "scanDiscovery": {
                "artist": "Album Rating Contract",
                "album": "Rating Scan Discovery",
                "track": "New Tagged Rating",
                "albumRating": 9,
                "databaseRowsBeforeScan": 0,
                "physicalFileCount": 1,
            }
        }
    }


def test_loader_treats_scan_discovery_as_physical_only_not_a_named_database_identity() -> None:
    loader = _load_fixture_loader_module()

    identities = loader._identity_assertions(_scan_discovery_assertions())

    assert not any(name.startswith("functionalInventory.scanDiscovery") for name in identities)


def test_loader_requires_the_physical_only_scan_discovery_file(tmp_path: Path) -> None:
    loader = _load_fixture_loader_module()
    scan_path = (
        tmp_path
        / "media"
        / "Album Rating Contract"
        / "Rating Scan Discovery"
        / "01 - New Tagged Rating.mp3"
    )
    scan_path.parent.mkdir(parents=True)
    scan_path.write_bytes(b"fixture-id3")

    loader.validate_functional_scan_discovery_contract(
        tmp_path,
        "functional-core",
        _scan_discovery_assertions(),
    )
    scan_path.unlink()
    with pytest.raises(ValueError, match="scan discovery"):
        loader.validate_functional_scan_discovery_contract(
            tmp_path,
            "functional-core",
            _scan_discovery_assertions(),
        )


def test_loader_rejects_scan_discovery_rows_before_the_incremental_scan() -> None:
    loader = _load_fixture_loader_module()
    statements: list[str] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[int]:
            return (1,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append(statement)
            assert parameters == (
                "functional-core",
                "Album Rating Contract",
                "Rating Scan Discovery",
                "New Tagged Rating",
            )
            return Result()

    with pytest.raises(ValueError, match="scan discovery.*before incremental scan"):
        loader.validate_projected_scan_discovery_absence(
            Connection(),
            "functional-core",
            _scan_discovery_assertions(),
        )

    sql = "\n".join(statements)
    assert "from library.local_artists ar" not in sql
    assert "library.local_artists" in sql
    assert "library.local_albums" in sql
    assert "library.local_tracks" in sql


def test_load_fixture_profile_enforces_scan_discovery_before_and_after_projection() -> None:
    loader = _load_fixture_loader_module()
    source = Path(loader.__file__).read_text(encoding="utf-8")
    auxiliary_source = source[
        source.index("def validate_auxiliary_contract(") : source.index(
            "def validate_database_url("
        )
    ]
    load_source = source[source.index("def load_fixture_profile(") :]

    assert "validate_functional_scan_discovery_contract(" in auxiliary_source
    projection_index = load_source.index("for statement in statements[2:]")
    scan_discovery_index = load_source.index(
        "validate_projected_scan_discovery_absence("
    )
    assert projection_index < scan_discovery_index


def test_loader_rejects_unresolved_staged_references() -> None:
    loader = _load_fixture_loader_module()

    class Result:
        @staticmethod
        def fetchone() -> tuple[int]:
            return (1,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            assert "fixture_stage" in statement
            return Result()

    with pytest.raises(ValueError, match="unresolved fixture reference"):
        loader.validate_staged_references(Connection())


def test_loader_validates_portable_ignored_repair_track_references() -> None:
    loader = _load_fixture_loader_module()
    statements: list[str] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[int]:
            return (0,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append(statement)
            return Result()

    loader.validate_staged_references(Connection())

    sql = "\n".join(statements)
    assert "s.table_name='ignored_repairs'" in sql
    assert "s.record->>'trackRef'" in sql
    assert "s.record->>'field'" in sql
    assert "s.record->>'repairKey'" in sql


def test_loader_rejects_mismatched_projected_portable_ignored_repairs() -> None:
    loader = _load_fixture_loader_module()
    statements: list[str] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[int]:
            return (1,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append(statement)
            assert parameters == ("functional-core",)
            return Result()

    with pytest.raises(ValueError, match="ignored repair mismatch after projection"):
        loader.validate_projected_ignored_repairs(Connection(), "functional-core")

    sql = "\n".join(statements)
    assert "fixture_stage" in sql
    assert "library.ignored_repairs" in sql
    assert "library.local_track_files" in sql
    assert "f.private_path || '::' || (s.record->>'field')" in sql


def test_load_fixture_profile_validates_portable_ignored_repairs_after_projection() -> None:
    loader = _load_fixture_loader_module()
    source = Path(loader.__file__).read_text(encoding="utf-8")
    load_source = source[source.index("def load_fixture_profile(") :]

    projection_index = load_source.index("for statement in statements[2:]")
    ignored_repairs_index = load_source.index("validate_projected_ignored_repairs(")
    assert projection_index < ignored_repairs_index


def test_loader_rejects_named_family_relationship_mismatch() -> None:
    loader = _load_fixture_loader_module()

    class Result:
        @staticmethod
        def fetchone() -> tuple[bool]:
            return (False,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            assert "local_artist_family_links" in statement
            return Result()

    with pytest.raises(ValueError, match="named relationship mismatch"):
        loader.validate_staged_named_relationships(
            Connection(),
            {
                "nealMorseFamily": {"artists": ["Neal Morse", "Cosmic Cathedral"]},
                "ariaFamily": {"artists": ["Ария", "Кипелов"]},
                "devinTownsendFamily": {
                    "familyArtists": ["Devin Townsend", "IR8 / Sexoturica"]
                },
            },
        )


def test_loader_rejects_connected_database_identity_that_differs_from_url() -> None:
    loader = _load_fixture_loader_module()

    class Result:
        @staticmethod
        def fetchone() -> tuple[str, str]:
            return ("album_haven_core", "album_haven_migrator_owner")

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            assert "current_database" in statement
            return Result()

    with pytest.raises(ValueError, match="connected database identity"):
        loader.validate_connected_identity(
            Connection(),
            "postgresql://album_haven_migrator_123@localhost/album_haven_ci_123",
        )


def test_loader_rejects_auxiliary_count_that_is_not_backed_by_fixture_files(
    tmp_path: Path,
) -> None:
    loader = _load_fixture_loader_module()
    definition = {
        "counts": {"physicalTaggedFiles": 1},
        "namedScenarioAssertions": {
            "ddt": {"materializedTaggedFiles": ["media/writable/missing.mp3"]}
        },
    }

    with pytest.raises(ValueError, match="count mismatch|missing"):
        loader.validate_auxiliary_contract(
            tmp_path, "synthetic-large-library", definition
        )


def test_loader_counts_functional_ddt_files_from_product_media_layout(
    tmp_path: Path,
) -> None:
    loader = _load_fixture_loader_module()
    studio_root = tmp_path / "media" / "ДДТ" / "Студийные записи"
    remix_root = tmp_path / "media" / "ДДТ" / "Ремиксы"
    studio_root.mkdir(parents=True)
    remix_root.mkdir(parents=True)
    for number in range(1, 17):
        (studio_root / f"{number:02d}. Студийная запись {number}.mp3").write_bytes(
            b"fixture"
        )
    for number in range(1, 11):
        (remix_root / f"{number:02d}. Ремикс {number}.mp3").write_bytes(b"fixture")
    archive_root = tmp_path / "media" / "ДДТ" / "Периферия"
    archive_root.mkdir(parents=True)
    (archive_root / "01. Архивная запись.mp3").write_bytes(b"fixture")

    loader.validate_auxiliary_contract(
        tmp_path,
        "functional-core",
        {
            "counts": {"ddtMaterializedTaggedFiles": 26},
            "namedScenarioAssertions": {},
        },
    )


def test_loader_validates_functional_physical_track_file_count_after_staging() -> None:
    loader = _load_fixture_loader_module()
    statements: list[tuple[str, object]] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[int]:
            return (7200,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append((statement, parameters))
            return Result()

    loader.validate_staged_physical_track_files(
        Connection(),
        "functional-core",
        {"physicalTrackFiles": 7200},
    )
    assert len(statements) == 1
    assert "fixture_stage" in statements[0][0]
    assert "materialized" in statements[0][0]
    assert statements[0][1] == ("local_track_files",)

    with pytest.raises(ValueError, match="physical track file count"):
        loader.validate_staged_physical_track_files(
            Connection(),
            "functional-core",
            {"physicalTrackFiles": 7199},
        )

    source = Path(loader.__file__).read_text(encoding="utf-8")
    load_source = source[source.index("def load_fixture_profile(") :]
    assert load_source.index("copy_seed_to_staging(") < load_source.index(
        "validate_staged_physical_track_files("
    )


def _synthetic_v102_problematic_files_assertion() -> dict[str, object]:
    albums: list[dict[str, object]] = [
        {
            "artist": "Neal Morse",
            "album": "Neal Morse Plays Pink Floyd",
            "problemReasons": [
                "Missing cover art",
                "Missing track number",
                "Missing year",
            ],
        },
        {
            "artist": "E2E Rarity Artist",
            "album": "Two Track Rarity Fixture",
            "problemReasons": ["Incomplete track order: Disc 1 missing 2"],
        },
        {
            "artist": "E2E Rarity Artist",
            "album": "Natural Filename Order Fixture",
            "problemReasons": [
                "Missing track number",
                "Incomplete track order: Disc 1 missing 1, 4, 5, 6, 7, 8, 9",
            ],
        },
        {
            "artist": "E2E Rarity Artist",
            "album": "Sparse Album Edit Fixture",
            "problemReasons": ["Year mismatch"],
        },
        {
            "artist": "Generated Problem Fixture",
            "album": "Encoding And Missing Metadata",
            "problemReasons": [
                "Missing year",
                "Missing cover art",
                "Missing track number",
                "Encoding problem",
            ],
        },
        {
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 07",
            "problemReasons": ["Missing cover art"],
        },
        {
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 08",
            "problemReasons": ["Missing cover art"],
        },
        {
            "artist": "Various Artists",
            "album": "Explicit Disc Label Control",
            "problemReasons": ["Incomplete track order: Disc 2 missing 1, 2, 3"],
        },
    ]
    albums.extend(
        {
            "artist": "Synthetic Problem Control Artist",
            "album": f"Missing Cover Control {index:02d}",
            "problemReasons": ["Missing cover art"],
        }
        for index in range(1, 11)
    )
    return {
        "problematicItemCount": 18,
        "candidateTrackFileCount": 125,
        "expectedProblemTypes": [
            "Encoding problem",
            "Incomplete track order",
            "Missing cover art",
            "Missing track number",
            "Missing year",
            "Year mismatch",
        ],
        "expectedProblemReasons": [
            "Encoding problem",
            "Incomplete track order: Disc 1 missing 2",
            "Incomplete track order: Disc 1 missing 1, 4, 5, 6, 7, 8, 9",
            "Incomplete track order: Disc 2 missing 1, 2, 3",
            "Missing cover art",
            "Missing track number",
            "Missing year",
            "Year mismatch",
        ],
        "expectedProblematicAlbums": albums,
        "summariesCompact": True,
        "initialDetailMatchesFirstSummary": True,
    }


UTILITY_PROBLEMATIC_PROFILE = "utility-problematic-files"
UTILITY_PROBLEMATIC_COUNTS = {
    "artists": 40,
    "albums": 400,
    "tracks": 7200,
    "trackFiles": 7200,
    "covers": 386,
}


def _utility_problematic_named_assertions() -> dict[str, object]:
    return {
        "problematic-files-filtering": _synthetic_v102_problematic_files_assertion()
    }


def test_loader_validates_exact_aria_exclusive_selection_and_track_credit() -> None:
    loader = _load_fixture_loader_module()
    statements: list[tuple[str, object]] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[bool]:
            return (True,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append((statement, parameters))
            return Result()

    loader.validate_staged_named_relationships(
        Connection(),
        {
            "ariaFamily": {
                "artists": [
                    "Ария",
                    "Кипелов",
                    "Виталий Дубинин",
                    "Дубинин & Холстинин",
                    "Ария & Хелависа",
                ],
                "featuredAlbum": "Tribute To Harley-Davidson",
                "featuredTrack": {
                    "title": "Штиль",
                    "number": 3,
                    "secondaryCredit": "feat. U.D.O.",
                },
                "exclusiveSelection": {
                    "artist": "Ария & Хелависа",
                    "albums": ["No albums"],
                    "excludedAlbum": "Точка невозврата",
                },
            }
        },
    )

    serialized_parameters = json.dumps(
        [parameters for _statement, parameters in statements], ensure_ascii=False
    )
    for exact_value in (
        "Ария & Хелависа",
        "Ария feat U.D.O.",
        "No albums",
        "Точка невозврата",
        "Tribute To Harley-Davidson",
        "Штиль",
        "feat. U.D.O.",
    ):
        assert exact_value in serialized_parameters
    normalized_sql = " ".join(statement.casefold() for statement, _ in statements)
    assert "local_albums" in normalized_sql
    assert "local_tracks" in normalized_sql
    assert "local_album_featured_artists" in normalized_sql
    exclusive_sql = next(
        statement.casefold()
        for statement, parameters in statements
        if parameters and "No albums" in str(parameters)
    )
    assert "local_albums" in exclusive_sql
    assert "artistref" in exclusive_sql
    assert "title" in exclusive_sql
    assert "count" in exclusive_sql or "array_agg" in exclusive_sql
    track_credit_sql = next(
        statement.casefold()
        for statement, parameters in statements
        if parameters and "feat. U.D.O." in str(parameters)
    )
    assert "local_tracks" in track_credit_sql
    assert "local_album_featured_artists" in track_credit_sql
    assert "artistref" in track_credit_sql
    assert "metadata" in track_credit_sql
    assert "track_artist" in track_credit_sql


def test_loader_fails_closed_when_aria_exclusive_selection_ownership_mismatches() -> None:
    loader = _load_fixture_loader_module()

    class Result:
        @staticmethod
        def fetchone() -> tuple[bool]:
            return (False,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            if parameters and (
                "No albums" in str(parameters)
                or "Точка невозврата" in str(parameters)
            ):
                return Result()
            return type("PassingResult", (), {"fetchone": staticmethod(lambda: (True,))})()

    with pytest.raises(ValueError, match="ariaFamily.exclusiveSelection"):
        loader.validate_staged_named_relationships(
            Connection(),
            {
                "ariaFamily": {
                    "artists": ["Ария", "Ария & Хелависа"],
                    "featuredAlbum": "Tribute To Harley-Davidson",
                    "featuredTrack": {
                        "title": "Штиль",
                        "number": 3,
                        "secondaryCredit": "feat. U.D.O.",
                    },
                    "exclusiveSelection": {
                        "artist": "Ария & Хелависа",
                        "albums": ["No albums"],
                        "excludedAlbum": "Точка невозврата",
                    },
                }
            },
        )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update(problematicItemCount=17),
        lambda value: value.update(candidateTrackFileCount=124),
        lambda value: value["expectedProblemTypes"].append("Missing year"),
        lambda value: value["expectedProblemReasons"].pop(),
        lambda value: value["expectedProblematicAlbums"][0][
            "problemReasons"
        ].append("Unexpected problem"),
        lambda value: value["expectedProblematicAlbums"].pop(),
        lambda value: value["expectedProblematicAlbums"].__setitem__(
            -1, dict(value["expectedProblematicAlbums"][0])
        ),
        lambda value: value["expectedProblematicAlbums"][0].pop("problemReasons"),
        lambda value: value.update(summariesCompact=False),
        lambda value: value.update(initialDetailMatchesFirstSummary=False),
        lambda value: value.update(unexpectedContractKey=True),
    ],
)
def test_loader_rejects_malformed_problematic_files_filtering_contract(
    mutation: Any,
) -> None:
    loader = _load_fixture_loader_module()
    assertion = _synthetic_v102_problematic_files_assertion()
    mutation(assertion)

    with pytest.raises(ValueError, match="problematic-files-filtering"):
        loader._problematic_files_filtering_contract(
            UTILITY_PROBLEMATIC_PROFILE,
            UTILITY_PROBLEMATIC_COUNTS,
            {"problematic-files-filtering": assertion},
        )


def test_loader_ignores_legacy_synthetic_large_problematic_files_track_count() -> None:
    loader = _load_fixture_loader_module()

    assert loader._problematic_files_filtering_contract(
        "synthetic-large-library",
        {
            "artists": 2081,
            "albums": 5346,
            "tracks": 57980,
            "trackFiles": 57980,
            "covers": 5251,
        },
        {"utilityScenarios": {"problematic-files-filtering": {"trackFileCount": 32}}},
    ) is None


def test_loader_accepts_top_level_dedicated_problematic_files_contract() -> None:
    loader = _load_fixture_loader_module()

    contract = loader._problematic_files_filtering_contract(
        UTILITY_PROBLEMATIC_PROFILE,
        UTILITY_PROBLEMATIC_COUNTS,
        _utility_problematic_named_assertions(),
    )

    assert contract == _synthetic_v102_problematic_files_assertion()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda counts: counts.pop("covers"),
        lambda counts: counts.update(unexpectedCount=1),
    ],
)
def test_loader_rejects_non_exact_dedicated_problematic_count_keys(
    mutation: Any,
) -> None:
    loader = _load_fixture_loader_module()
    counts = dict(UTILITY_PROBLEMATIC_COUNTS)
    mutation(counts)

    with pytest.raises(ValueError, match="problematic-files-filtering"):
        loader._problematic_files_filtering_contract(
            UTILITY_PROBLEMATIC_PROFILE,
            counts,
            _utility_problematic_named_assertions(),
        )


def test_loader_staged_problematic_files_validation_covers_required_row_shapes() -> None:
    loader = _load_fixture_loader_module()
    statements: list[tuple[str, object]] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[bool]:
            return (True,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append((statement, parameters))
            return Result()

    loader.validate_staged_problematic_files_scenario(
        Connection(),
        UTILITY_PROBLEMATIC_PROFILE,
        UTILITY_PROBLEMATIC_COUNTS,
        _utility_problematic_named_assertions(),
    )

    normalized_sql = " ".join(statement.casefold() for statement, _ in statements)
    for required_shape in (
        "local_albums",
        "local_tracks",
        "local_track_files",
        "staged_files",
        "candidate",
        "scan_cache",
        "stale",
        "coverpath",
        "tracknumber",
        "discnumber",
        "releaseyear",
        "metadata",
        "encoding",
    ):
        assert required_shape in normalized_sql
    assert "scan_cache->>'stale'='false'" in normalized_sql
    assert "stale' is distinct from 'true'" not in normalized_sql
    serialized_parameters = json.dumps(
        [parameters for _statement, parameters in statements], ensure_ascii=False
    )
    assert "Synthetic Problem Control Artist" in serialized_parameters
    assert "Missing Cover Control 10" in serialized_parameters
    assert "Incomplete track order: Disc 2 missing 1, 2, 3" in serialized_parameters
    for expected in (40, 400, 7200, 386, 125, 18, 14):
        assert str(expected) in serialized_parameters
    assertion = _synthetic_v102_problematic_files_assertion()
    for album in assertion["expectedProblematicAlbums"]:
        assert album["artist"] in serialized_parameters
        assert album["album"] in serialized_parameters
        for reason in album["problemReasons"]:
            assert reason in serialized_parameters


def test_loader_staged_problematic_files_rejects_auxiliary_envelope_tables() -> None:
    loader = _load_fixture_loader_module()
    statements: list[tuple[str, object]] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[bool]:
            return (True,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append((statement, parameters))
            return Result()

    loader.validate_staged_problematic_files_scenario(
        Connection(),
        UTILITY_PROBLEMATIC_PROFILE,
        UTILITY_PROBLEMATIC_COUNTS,
        _utility_problematic_named_assertions(),
    )

    normalized_sql = " ".join(statements[0][0].casefold().split())
    assert "fixture_stage" in normalized_sql
    assert "table_name <> all(%s::text[])" in normalized_sql
    assert "count(distinct table_name)" in normalized_sql
    parameters = statements[0][1]
    assert parameters is not None
    assert set(parameters[-2]) == {
        "covers",
        "local_albums",
        "local_artists",
        "local_track_files",
        "local_tracks",
    }
    assert parameters[-1] == 5


def test_loader_fails_closed_when_staged_problematic_files_rows_mismatch() -> None:
    loader = _load_fixture_loader_module()

    class Result:
        @staticmethod
        def fetchone() -> tuple[bool]:
            return (False,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            return Result()

    with pytest.raises(ValueError, match="problematic-files-filtering"):
        loader.validate_staged_problematic_files_scenario(
            Connection(),
            UTILITY_PROBLEMATIC_PROFILE,
            UTILITY_PROBLEMATIC_COUNTS,
            _utility_problematic_named_assertions(),
        )


def test_loader_projected_problematic_files_validation_uses_normal_profile_rows() -> None:
    loader = _load_fixture_loader_module()
    statements: list[tuple[str, object]] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[bool]:
            return (True,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append((statement, parameters))
            return Result()

    loader.validate_projected_problematic_files_scenario(
        Connection(),
        UTILITY_PROBLEMATIC_PROFILE,
        UTILITY_PROBLEMATIC_COUNTS,
        _utility_problematic_named_assertions(),
    )

    normalized_sql = " ".join(statement.casefold() for statement, _ in statements)
    for required_shape in (
        "library.libraries",
        "library.local_artists",
        "library.local_albums",
        "library.local_tracks",
        "library.local_track_files",
        "cover_path",
        "metadata",
    ):
        assert required_shape in normalized_sql
    serialized_parameters = json.dumps(
        [parameters for _statement, parameters in statements], ensure_ascii=False
    )
    assert UTILITY_PROBLEMATIC_PROFILE in serialized_parameters
    for expected in (40, 400, 7200, 386, 125, 18, 14):
        assert str(expected) in serialized_parameters
    for album in _synthetic_v102_problematic_files_assertion()[
        "expectedProblematicAlbums"
    ]:
        assert album["artist"] in serialized_parameters
        assert album["album"] in serialized_parameters
        for reason in album["problemReasons"]:
            assert reason in serialized_parameters


def test_loader_projected_problematic_files_normalizes_windows_separator_for_missing_track_exception() -> None:
    loader = _load_fixture_loader_module()
    statements: list[str] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[bool]:
            return (True,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append(statement)
            return Result()

    loader.validate_projected_problematic_files_scenario(
        Connection(),
        UTILITY_PROBLEMATIC_PROFILE,
        UTILITY_PROBLEMATIC_COUNTS,
        _utility_problematic_named_assertions(),
    )

    normalized_sql = " ".join(statements[0].split())
    normalized_path = "replace(private_path, chr(92), '/')"
    assert normalized_sql.count(normalized_path) == 1
    assert (
        f"track_number is null and {normalized_path} "
        "!~ '/(alpha|beta)\\.mp3$'"
    ) in normalized_sql


def test_load_fixture_profile_validates_problematic_files_rows_after_projection() -> None:
    loader = _load_fixture_loader_module()
    source = Path(loader.__file__).read_text(encoding="utf-8")
    load_source = source[source.index("def load_fixture_profile(") :]

    projection_index = load_source.index("_validate_projected_named_identities(")
    problematic_index = load_source.index(
        "validate_projected_problematic_files_scenario("
    )
    assert projection_index < problematic_index


def test_loader_projection_order_resolves_refs_into_normal_product_tables() -> None:
    loader = _load_fixture_loader_module()

    assert loader.PRODUCT_PROJECTION_ORDER == (
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
    sql = "\n".join(loader.product_projection_statements("functional-core"))
    assert "artistRef" in sql and "artist_key" in sql
    assert "s.record->>'productArtistKey'" in sql
    assert "jsonb_build_object('fixture_artist_key',s.record->>'artistKey'" in sql
    assert "a.metadata->>'fixture_artist_key'=s.record->>'artistRef'" in sql
    assert "ar.metadata->>'fixture_artist_key'=s.record->>'artistRef'" in sql
    assert "library.local_album_cover_candidate_snapshots" in sql
    assert "a.artist_key || '::' || (s.record->>'productTitleKey')" in sql
    assert "jsonb_build_object('fixture_album_key',s.record->>'albumKey'" in sql
    assert "al.metadata->>'fixture_album_key'=s.record->>'albumRef'" in sql
    assert "albumRef" in sql and "album_key" in sql
    assert "trackRef" in sql and "track_key" in sql
    assert "rootRef" in sql and "root_id" in sql
    assert "library.local_artists" in sql
    assert "library.local_albums" in sql
    assert "library.local_tracks" in sql
    assert "library.local_track_files" in sql
    assert "al.artist_id, 'owner'" in sql
    assert "jsonb_build_object('source','cloud_fixture','profile',c.profile)" in sql
    owner_projection_index = sql.index("al.artist_id, 'owner'")
    explicit_credit_index = sql.index("s.record->>'featuredKind'")
    assert owner_projection_index < explicit_credit_index
    loader_source = LOADER_PATH.read_text(encoding="utf-8")
    assert "f.featured_kind <> 'owner'" in loader_source
    assert "fixture relationship mismatch after projection: album owners" in loader_source
    assert "fixture identity mismatch after projection: canonical artist keys" in loader_source
    assert "fixture identity mismatch after projection: canonical album keys" in loader_source
    assert "insert into app.album_ratings" in sql
    assert "album_ratings" in sql
    assert "albumRef" in sql
    assert "local-bootstrap-owner" in sql
    assert "Local Library" in sql
    assert "owner_account_id" in sql
    assert "library.library_root_settings" in sql
    assert "settings_payload" in sql
    assert "main_library_roots" in sql
    assert "c.media_root" in sql
    assert "runtime_scan_cache" in sql
    assert "metadata_schema_version" in sql
    assert "release_date" in sql
    assert "library_root_identity" in sql
    assert "scan_cache" in sql
    assert "absolutePrivatePath" in sql
    assert "absoluteCoverPath" in sql
    assert "absolutePath" in sql
    assert "fixture_track_key" in sql
    assert "modifiedAtEpoch" in sql
    assert "jsonb_build_object(" in sql
    assert "|| coalesce(s.record->'metadata'#>'{scan_cache,file_entry}'" in sql
    assert "rawDiscNumber" in sql
    assert "cover_selection_origin" in sql
    assert "'genre', t.metadata->>'genre'" in sql
    ignored_repairs_sql = next(
        statement
        for statement in loader.product_projection_statements("functional-core")
        if statement.startswith("insert into library.ignored_repairs")
    )
    assert "join library.local_tracks" in ignored_repairs_sql
    assert "join library.local_track_files" in ignored_repairs_sql
    assert "f.private_path || '::' || (s.record->>'field')" in ignored_repairs_sql
    assert "coalesce(nullif(s.record->>'repairKey','')" in ignored_repairs_sql


def test_loader_binds_locale_independent_product_identity_keys(tmp_path: Path) -> None:
    loader = _load_fixture_loader_module()

    assert loader.canonical_product_identity_key("  ДДТ  ") == "ддт"
    assert loader.canonical_product_identity_key("Morse   Portnoy  George") == (
        "morse portnoy george"
    )
    assert loader.bind_fixture_record_to_extracted_root(
        "local_artists",
        {"artistKey": "ddt", "name": "ДДТ"},
        tmp_path,
    )["productArtistKey"] == "ддт"
    assert loader.bind_fixture_record_to_extracted_root(
        "local_albums",
        {"albumKey": "cover", "title": "  Cover   to Cover "},
        tmp_path,
    )["productTitleKey"] == "cover to cover"
    scan_record = loader.bind_fixture_record_to_extracted_root(
        "scan-file-index",
        {
            "path": "media/DDT/Studio/01.mp3",
            "artist": " ДДТ ",
            "album": " Студийные   записи ",
        },
        tmp_path,
    )
    assert scan_record["productArtistKey"] == "ддт"
    assert scan_record["productTitleKey"] == "студийные записи"


def test_loader_binds_cover_candidate_urls_to_the_owned_provider_port(tmp_path: Path) -> None:
    loader = _load_fixture_loader_module()
    record = loader.bind_fixture_record_to_extracted_root(
        "local_album_cover_candidate_snapshots",
        {
            "candidates": [
                {
                    "url": "http://cover-fixture.example:${PROVIDER_PORT}/cover.jpg",
                    "thumbnail_url": "http://cover-fixture.example:${PROVIDER_PORT}/thumb.jpg",
                }
            ]
        },
        tmp_path,
        5202,
    )

    assert record["candidates"][0]["url"] == "http://cover-fixture.example:5202/cover.jpg"
    assert record["candidates"][0]["thumbnail_url"] == "http://cover-fixture.example:5202/thumb.jpg"


def test_loader_rejects_cover_candidate_seed_without_owned_provider_port(tmp_path: Path) -> None:
    loader = _load_fixture_loader_module()

    with pytest.raises(ValueError, match="PLAYWRIGHT_PROVIDER_PORT"):
        loader.bind_fixture_record_to_extracted_root(
            "local_album_cover_candidate_snapshots",
            {"candidates": [{"url": "x", "thumbnail_url": "x"}]},
            tmp_path,
        )


def test_loader_root_settings_match_the_preloaded_media_root_and_scan_snapshot() -> None:
    loader = _load_fixture_loader_module()
    media_root = Path(r"D:\a\_temp\album-haven-fixtures-contract\media")

    settings = loader.library_root_settings_payload(media_root, "functional-core")

    assert settings == {
        "version": 1,
        "main_library_roots": [
            {
                "id": "functional-core-root",
                "path": str(media_root),
                "layout_mode": "artist",
            }
        ],
        "hoarding_library_roots": [],
        "new_arrivals_roots": [],
        "move_policy": {},
    }
    expected_identity = hashlib.sha256(
        json.dumps(settings, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    assert loader.library_root_identity(settings) == expected_identity


def test_loader_uses_copy_staging_then_resets_identities_and_analyzes() -> None:
    loader = _load_fixture_loader_module()
    statements = loader.product_projection_statements("synthetic-large-library")
    normalized = [" ".join(statement.casefold().split()) for statement in statements]

    assert normalized[0].startswith("create temporary table")
    assert any("setval" in statement and "pg_get_serial_sequence" in statement for statement in normalized)
    assert normalized[-1].startswith("analyze ")
    assert "library.local_artists" in normalized[-1]
    assert "library.local_track_files" in normalized[-1]


def test_loader_copy_seed_to_staging_uses_psycopg_row_copy(tmp_path: Path) -> None:
    loader = _load_fixture_loader_module()
    seed = _write_seed(tmp_path / "fixture.ndjson.zst", [{"table": "local_artists", "record": {"artistKey": "a", "name": "Artist"}}])
    connection = _RecordingConnection()

    loader.copy_seed_to_staging(connection, seed)

    assert len(connection.copy_statements) == 1
    assert "copy" in connection.copy_statements[0].casefold()
    assert "fixture" in connection.copy_statements[0].casefold()
    assert connection.copied_rows == [(1, "local_artists", json.dumps({"artistKey": "a", "name": "Artist"}, ensure_ascii=False, separators=(",", ":")))]


def test_loader_indexes_staging_join_keys_before_validation_and_projection() -> None:
    loader = _load_fixture_loader_module()
    connection = _RecordingConnection()

    loader.index_fixture_staging(connection)

    statements = [" ".join(statement.casefold().split()) for statement, _ in connection.executed]
    assert statements[-1] == "analyze fixture_stage"
    assert any(
        "where table_name='local_artists'" in statement
        and "record->>'artistkey'" in statement
        for statement in statements
    )
    assert any(
        "where table_name='local_albums'" in statement
        and "record->>'albumkey'" in statement
        and "record->>'artistref'" in statement
        for statement in statements
    )
    assert any(
        "where table_name='local_tracks'" in statement
        and "record->>'trackkey'" in statement
        and "record->>'albumref'" in statement
        for statement in statements
    )
    assert any(
        "where table_name='local_track_files'" in statement
        and "coalesce(record->>'trackref',record->>'logicalkey')" in statement
        for statement in statements
    )


def test_loader_binds_portable_track_file_to_extracted_windows_identity(
    tmp_path: Path,
) -> None:
    loader = _load_fixture_loader_module()
    fixture_root = tmp_path / "fixture"
    media_path = fixture_root / "media" / "Artist" / "Album" / "01 - Track.mp3"
    media_path.parent.mkdir(parents=True)
    media_path.write_bytes(b"fixture-audio")

    bound = loader.bind_fixture_record_to_extracted_root(
        "local_track_files",
        {
            "trackRef": "fixture-track-01",
            "privatePath": "media/Artist/Album/01 - Track.mp3",
            "relativePath": "Artist/Album/01 - Track.mp3",
            "metadata": {
                "scan_cache": {
                    "file_entry": {"title": "Track", "mtime": 0.0, "size": 0}
                }
            },
        },
        fixture_root.resolve(),
    )

    expected_path = str(media_path.resolve())
    assert bound["absolutePrivatePath"] == expected_path
    assert bound["fileSizeBytes"] == len(b"fixture-audio")
    assert bound["modifiedAtEpoch"] == media_path.stat().st_mtime
    assert bound["metadata"]["scan_cache"]["file_entry"] == {
        "title": "Track",
        "path": expected_path,
        "mtime": media_path.stat().st_mtime,
        "size": len(b"fixture-audio"),
    }


def test_loader_rejects_count_mismatch() -> None:
    loader = _load_fixture_loader_module()

    with pytest.raises(ValueError, match="count mismatch"):
        loader.validate_loaded_contract(
            {"artists": 23, "albums": 71},
            {"joseph": {"artist": "Neal Morse"}},
            {"artists": 22, "albums": 71},
            {"joseph": {"artist": "Neal Morse"}},
        )


def test_loader_rejects_named_identity_mismatch() -> None:
    loader = _load_fixture_loader_module()

    with pytest.raises(ValueError, match="named identity mismatch"):
        loader.validate_loaded_contract(
            {"artists": 23},
            {"joseph": {"artist": "Neal Morse", "album": "Joseph: Part One - The Dreamer", "year": 2023}},
            {"artists": 23},
            {"joseph": {"artist": "Neal Morse", "album": "Wrong Album", "year": 2023}},
        )


def test_loader_discovers_nested_named_artist_album_and_track_identities() -> None:
    loader = _load_fixture_loader_module()
    identities = loader._identity_assertions(
        {
            "ariaFamily": {
                "artists": ["Ария", "Кипелов"],
                "featuredAlbum": "Tribute To Harley-Davidson",
                "featuredTrack": {
                    "title": "Штиль",
                    "number": 3,
                    "secondaryCredit": "feat. U.D.O.",
                },
                "searchFollowUp": "БИ-2",
            },
            "ddt": {
                "albums": [{"title": "Периферия", "year": 1984}],
                "studioTracks": ["Студийная запись 1"],
                "remixTracks": ["Фонограммщик"],
            },
            "utilityScenarios": {
                "selected-artist-browse": {"artist": "Devin Townsend"},
                "root-album-browse": {"album": "Synthetic Scale Album 00159"},
            },
        }
    )

    assert {item.get("artist") for item in identities.values()} >= {
        "Ария",
        "Кипелов",
        "БИ-2",
        "Devin Townsend",
    }
    assert {item.get("album") for item in identities.values()} >= {
        "Tribute To Harley-Davidson",
        "Периферия",
        "Synthetic Scale Album 00159",
    }
    assert any(
        item.get("trackTitle") == "Штиль"
        and item.get("album") == "Tribute To Harley-Davidson"
        and item.get("artist") == "Ария feat U.D.O."
        and item.get("trackNumber") == 3
        and item.get("secondaryCredit") == "feat. U.D.O."
        for item in identities.values()
    )
    assert any(
        item.get("album") == "Периферия"
        and item.get("artist") == "ДДТ"
        and item.get("year") == 1984
        for item in identities.values()
    )
    assert any(
        item.get("trackTitle") == "Студийная запись 1"
        and item.get("album") == "Студийные записи"
        and item.get("artist") == "ДДТ"
        for item in identities.values()
    )
    assert any(
        item.get("trackTitle") == "Фонограммщик"
        and item.get("album") == "Ремиксы"
        and item.get("artist") == "ДДТ"
        for item in identities.values()
    )


def test_loader_extracts_exact_numeric_artist_family_relationship_contract() -> None:
    loader = _load_fixture_loader_module()

    contract = loader._numeric_artist_family_contract(
        {
            "numericArtistFamily": {
                "primaryArtist": "3",
                "familyArtists": [
                    "3",
                    "Emerson, Lake & Palmer",
                    "Emerson, Lake & Powell",
                ],
                "relationshipSource": "numeric-three-approved-family",
                "symmetricRelationships": True,
                "everyFamilyArtistHasAlbums": True,
                "everyFamilyArtistHasCoveredAlbum": True,
            }
        }
    )

    assert contract == {
        "primary": "3",
        "artists": ("3", "Emerson, Lake & Palmer", "Emerson, Lake & Powell"),
        "related": ("Emerson, Lake & Palmer", "Emerson, Lake & Powell"),
        "source": "numeric-three-approved-family",
        "directedEdgeCount": 4,
    }


def test_loader_casts_optional_named_identity_parameters_for_postgres_nulls() -> None:
    loader = _load_fixture_loader_module()
    statements: list[str] = []

    class Result:
        @staticmethod
        def fetchone() -> tuple[int]:
            return (1,)

    class Connection:
        @staticmethod
        def execute(statement: str, parameters: object = None) -> Result:
            statements.append(statement)
            return Result()

    loader._validate_staged_named_identities(
        Connection(), {"artist-only": {"artist": "Neal Morse"}}
    )

    normalized = " ".join(statements[0].casefold().split())
    assert "%s::text is null" in normalized
    assert "%s::integer is null" in normalized

def test_loader_rolls_back_transaction_when_seed_is_corrupt(tmp_path: Path) -> None:
    loader = _load_fixture_loader_module()
    fixture_root = tmp_path / "fixture"
    fixture_root.mkdir()
    (fixture_root / "manifest.json").write_text(json.dumps(_manifest()), encoding="utf-8")
    (fixture_root / "media").mkdir()
    seed = fixture_root / "database" / "functional-core.ndjson.zst"
    seed.parent.mkdir()
    seed.write_bytes(b"corrupt")
    connection = _RecordingConnection()

    with pytest.raises(ValueError):
        loader.load_fixture_profile(
            fixture_root=fixture_root,
            profile="functional-core",
            database_url="postgresql://album_haven_migrator_123@localhost/album_haven_ci_123",
            connect=lambda _url: connection,
        )

    assert connection.events == ["begin", "rollback"]
    assert "commit" not in connection.events


def test_loader_replace_existing_resets_normal_product_tables_inside_load_transaction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    loader = _load_fixture_loader_module()
    fixture_root = tmp_path / "fixture"
    fixture_root.mkdir()
    (fixture_root / "manifest.json").write_text(json.dumps(_manifest()), encoding="utf-8")
    (fixture_root / "media").mkdir()
    _write_seed(
        fixture_root / "database" / "functional-core.ndjson.zst",
        [{"table": "local_artists", "record": {"artistKey": "artist-1", "name": "Artist"}}],
    )
    connection = _RecordingConnection()
    events: list[str] = []

    monkeypatch.setattr(loader, "validate_connected_identity", lambda *_args: events.append("identity"))
    monkeypatch.setattr(loader, "reset_application_tables", lambda _connection: events.append("reset"))
    monkeypatch.setattr(loader, "product_projection_statements", lambda _profile: ("stage", "context"))
    monkeypatch.setattr(loader, "copy_seed_to_staging", lambda *_args: {"local_artists": 1})
    monkeypatch.setattr(loader, "validate_staged_references", lambda *_args: None)
    monkeypatch.setattr(loader, "validate_staged_profile_counts", lambda *_args: None)
    monkeypatch.setattr(loader, "validate_staged_named_relationships", lambda *_args: None)
    monkeypatch.setattr(loader, "validate_staged_problematic_files_scenario", lambda *_args: None)
    monkeypatch.setattr(loader, "_database_source_counts", lambda *_args: ({}, {}))
    monkeypatch.setattr(loader, "_validate_staged_named_identities", lambda *_args: None)
    monkeypatch.setattr(loader, "_validate_projected_counts", lambda *_args: None)
    monkeypatch.setattr(loader, "_validate_projected_named_identities", lambda *_args: None)
    monkeypatch.setattr(loader, "validate_projected_ignored_repairs", lambda *_args: None)
    monkeypatch.setattr(loader, "validate_projected_scan_discovery_absence", lambda *_args: None)
    monkeypatch.setattr(loader, "validate_projected_problematic_files_scenario", lambda *_args: None)

    loader.load_fixture_profile(
        fixture_root=fixture_root,
        profile="functional-core",
        database_url="postgresql://album_haven_migrator_123@localhost/album_haven_ci_123",
        replace_existing=True,
        connect=lambda _url: connection,
    )

    assert events == ["identity", "reset"]
    assert connection.events == ["begin", "commit"]
    assert [statement for statement, _parameters in connection.executed[:3]] == [
        "stage",
        "context",
        "insert into fixture_context (profile, fixture_root, media_root, root_settings, root_identity) values (%s, %s, %s, %s::jsonb, %s)",
    ]


def test_loader_reset_targets_only_application_tables_and_preserves_migration_authority() -> None:
    loader = _load_fixture_loader_module()

    class Result:
        @staticmethod
        def fetchall() -> list[tuple[str, str]]:
            return [
                ("app", "accounts"),
                ("app", "client_surface_classes"),
                ("library", "local_tracks"),
                ("ops", "schema_migrations"),
            ]

    class Connection:
        def __init__(self) -> None:
            self.statements: list[object] = []

        def execute(self, statement: object, _parameters: object = None) -> Result:
            self.statements.append(statement)
            return Result()

    connection = Connection()
    loader.reset_application_tables(connection)

    assert len(connection.statements) == 2
    reset_statement = repr(connection.statements[1])
    assert "accounts" in reset_statement
    assert "local_tracks" in reset_statement
    assert "client_surface_classes" not in reset_statement
    assert "schema_migrations" not in reset_statement


def test_loader_cli_exposes_explicit_replace_existing_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    loader = _load_fixture_loader_module()
    monkeypatch.setattr(
        "sys.argv",
        [
            "load-fixture-profile.py",
            "--fixture-root=C:/fixture",
            "--profile=functional-core",
            "--database-url=postgresql://album_haven_migrator_1@localhost/album_haven_ci_1",
            "--replace-existing",
        ],
    )

    assert loader._parse_args().replace_existing is True


def _run_bootstrap_contract(tmp_path: Path, **overrides: str) -> subprocess.CompletedProcess[str]:
    executable = shutil.which("pwsh") or shutil.which("powershell")
    if executable is None:
        pytest.skip("PowerShell is required for the Windows Postgres bootstrap contract")
    pgbin = tmp_path / "PostgreSQL" / "17" / "bin"
    pgbin.mkdir(parents=True, exist_ok=True)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir(parents=True, exist_ok=True)
    arguments = {
        "ServiceName": "postgresql-x64-17",
        "ExpectedMajorVersion": "17",
        "Pgbin": str(pgbin),
        "HostName": "localhost",
        "DatabaseSuffix": "run_123_attempt_2_python_windows",
        "RepositoryRoot": str(Path(__file__).parents[2]),
        "RunnerTemp": str(runner_temp),
        "GithubEnv": str(tmp_path / "github.env"),
        "StatePath": str(tmp_path / "bootstrap-state.json"),
    }
    arguments.update(overrides)
    command = [executable, "-NoProfile", "-File", str(BOOTSTRAP_PATH), "-Mode", "Contract"]
    for name, value in arguments.items():
        command.extend((f"-{name}", value))
    return subprocess.run(command, capture_output=True, encoding="utf-8", check=False, timeout=30)


def _bootstrap_contract(tmp_path: Path, **overrides: str) -> dict[str, object]:
    result = _run_bootstrap_contract(tmp_path, **overrides)
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert isinstance(payload, dict)
    return payload


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"ServiceName": "postgresql-x64-16"}, "service"),
        ({"ExpectedMajorVersion": "16"}, "version"),
        ({"Pgbin": r"C:\Program Files\PostgreSQL\16\bin"}, "PGBIN"),
        ({"HostName": "db.example.test"}, "loopback"),
        ({"HostName": "0.0.0.0"}, "loopback"),
        ({"DatabaseSuffix": "../album_haven_core"}, "suffix"),
        ({"DatabaseSuffix": ""}, "suffix"),
    ],
)
def test_bootstrap_contract_rejects_wrong_service_version_pgbin_host_or_suffix(
    tmp_path: Path, overrides: dict[str, str], message: str
) -> None:
    result = _run_bootstrap_contract(tmp_path, **overrides)
    assert result.returncode != 0
    assert message.casefold() in (result.stdout + result.stderr).casefold()


def test_bootstrap_contract_pins_postgres_17_server_and_client_preflight(tmp_path: Path) -> None:
    contract = _bootstrap_contract(tmp_path)
    assert contract["service"] == {
        "name": "postgresql-x64-17",
        "expectedMajorVersion": 17,
        "host": "localhost",
        "allowedHosts": ["localhost", "127.0.0.1", "::1"],
    }
    assert contract["preflight"] == {
        "requiredExecutables": ["postgres.exe", "psql.exe", "pg_isready.exe"],
        "serverVersionProbe": "show server_version_num",
        "clientVersionProbe": "psql --version",
        "requiredMajorVersion": 17,
        "readinessTimeoutSeconds": 60,
    }


def test_bootstrap_contract_accepts_matching_local_postgres_18_service_and_client(tmp_path: Path) -> None:
    contract = _bootstrap_contract(
        tmp_path,
        ServiceName="postgresql-x64-18",
        ExpectedMajorVersion="18",
        Pgbin=str(tmp_path / "PostgreSQL" / "18" / "bin"),
    )
    assert contract["service"]["name"] == "postgresql-x64-18"
    assert contract["service"]["expectedMajorVersion"] == 18
    assert contract["preflight"]["requiredMajorVersion"] == 18


def test_bootstrap_preflight_skips_noop_service_reconfiguration() -> None:
    source = BOOTSTRAP_PATH.read_text(encoding="utf-8")
    assert "if ($service.StartType -ne 'Automatic')" in source
    assert "if ($service.Status -ne 'Running')" in source


def test_bootstrap_contract_uses_strict_suffixed_database_and_role_names(tmp_path: Path) -> None:
    contract = _bootstrap_contract(tmp_path)
    assert contract["database"] == "album_haven_ci_run_123_attempt_2_python_windows"
    assert contract["database"] != "album_haven_core"
    assert contract["roles"] == {
        "migrator": "album_haven_migrator_run_123_attempt_2_python_windows",
        "app": "album_haven_app_run_123_attempt_2_python_windows",
        "readonly": "album_haven_readonly_run_123_attempt_2_python_windows",
    }
    assert contract["appPrivilegeMode"] == "Direct"
    assert _bootstrap_contract(tmp_path, AppPrivilegeMode="Inherited")["appPrivilegeMode"] == "Inherited"


def test_bootstrap_contract_applies_lexical_migrations_atomically_with_checksums(tmp_path: Path) -> None:
    contract = _bootstrap_contract(tmp_path)
    migrations = contract["migrations"]
    expected = sorted(path.name for path in (Path(__file__).parents[2] / "migrations" / "postgres").glob("*.sql"))
    assert [migration["name"] for migration in migrations] == expected
    assert all(migration["sha256"] for migration in migrations)
    assert all("ON_ERROR_STOP=1" in migration["arguments"] for migration in migrations)
    assert all("-1" in migration["arguments"] or "--single-transaction" in migration["arguments"] for migration in migrations)
    assert all(migration["recordChecksumAfterSuccess"] is True for migration in migrations)


def test_bootstrap_contract_defines_least_privilege_positive_and_negative_probes(tmp_path: Path) -> None:
    contract = _bootstrap_contract(tmp_path)
    assert contract["privilegeProbes"] == {
        "migrator": {"allow": ["create-schema", "temporary-table", "select", "insert", "update", "delete", "sequence-usage"], "deny": ["superuser", "createdb", "createrole", "replication", "bypassrls"]},
        "app": {"allow": ["connect", "temporary-table", "schema-usage", "select", "insert", "update", "sequence-usage"], "deny": ["create-schema", "truncate", "references", "trigger", "ops-write"]},
        "readonly": {"allow": ["connect", "schema-usage", "select"], "deny": ["temporary-table", "insert", "update", "delete", "truncate", "sequence-usage"]},
    }


def test_bootstrap_provision_executes_positive_and_negative_role_actions() -> None:
    source = BOOTSTRAP_PATH.read_text(encoding="utf-8").casefold()

    assert "create temporary table ci_privilege_probe" in source
    assert "create temporary table ci_app_privilege_probe" in source
    assert "create temporary table ci_readonly_privilege_probe" in source
    assert "grant temporary on database" in source
    assert "not has_database_privilege(current_user,current_database(),'temporary')" in source
    assert "insert into library.libraries" in source
    assert "update library.libraries" in source
    assert "exception when insufficient_privilege" in source
    assert "truncate table library.libraries" in source
    assert "insert into ops.schema_migrations" in source
    assert "delete from library.libraries" in source


def test_bootstrap_app_login_supports_explicit_suite_owned_privilege_modes() -> None:
    source = BOOTSTRAP_PATH.read_text(encoding="utf-8").casefold()

    assert "create role $($names.roles.app) login" in source
    assert "[validateset('direct', 'inherited')][string]$appprivilegemode = 'direct'" in source
    assert "'inherit in role album_haven_app'" in source
    assert "'noinherit'" in source
    assert "if ($appprivilegemode -ceq 'direct')" in source
    assert "has_schema_privilege('album_haven_app'" in source
    assert "has_table_privilege('album_haven_app'" in source
    assert "has_sequence_privilege('album_haven_app'" in source
    assert "has_function_privilege('album_haven_app'" in source
    assert "grant %s on schema %i to %i" in source
    assert "grant %s on table %s to %i" in source
    assert "grant %s on sequence %s to %i" in source
    assert "grant %s on function %s to %i" in source
    assert "invoke-psqltext $psql $names.roles.migrator $names.database $copyappprivilegessql" in source
    assert "has_schema_privilege(current_user,'integration','usage')" in source
    assert "has_table_privilege(current_user,'integration.lastfm_settings','select,insert,update')" in source


def test_bootstrap_contract_limits_teardown_to_exact_owned_database_and_roles(tmp_path: Path) -> None:
    contract = _bootstrap_contract(tmp_path)
    assert contract["teardown"] == {
        "terminateDatabase": "album_haven_ci_run_123_attempt_2_python_windows",
        "dropDatabase": "album_haven_ci_run_123_attempt_2_python_windows",
        "dropRoles": ["album_haven_app_run_123_attempt_2_python_windows", "album_haven_readonly_run_123_attempt_2_python_windows", "album_haven_migrator_run_123_attempt_2_python_windows"],
        "stateRequired": True,
        "rejectUnownedTargets": True,
    }


def test_bootstrap_teardown_rejects_unowned_pgpass_before_filesystem_deletion(tmp_path: Path) -> None:
    executable = shutil.which("pwsh") or shutil.which("powershell")
    if executable is None:
        pytest.skip("PowerShell is required for the bootstrap contract")
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    state_path = tmp_path / "bootstrap-state.json"
    victim = tmp_path / "must-not-delete.txt"
    victim.write_text("owner data", encoding="utf-8")
    state_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "suffix": "run_123_attempt_2_python_windows",
                "database": "album_haven_ci_run_123_attempt_2_python_windows",
                "roles": {
                    "migrator": "album_haven_migrator_run_123_attempt_2_python_windows",
                    "app": "album_haven_app_run_123_attempt_2_python_windows",
                    "readonly": "album_haven_readonly_run_123_attempt_2_python_windows",
                },
                "pgpass": str(victim),
                "host": "localhost",
                "port": 5432,
            }
        ),
        encoding="utf-8",
    )
    result = subprocess.run(
        [
            executable,
            "-NoProfile",
            "-File",
            str(BOOTSTRAP_PATH),
            "-Mode",
            "Teardown",
            "-Pgbin",
            r"C:\Program Files\PostgreSQL\17\bin",
            "-DatabaseSuffix",
            "run_123_attempt_2_python_windows",
            "-RepositoryRoot",
            str(Path(__file__).parents[2]),
            "-RunnerTemp",
            str(runner_temp),
            "-GithubEnv",
            str(tmp_path / "github.env"),
            "-StatePath",
            str(state_path),
        ],
        capture_output=True,
        encoding="utf-8",
        check=False,
        timeout=30,
    )

    assert result.returncode != 0
    assert "unowned" in (result.stdout + result.stderr).casefold()
    assert victim.read_text(encoding="utf-8") == "owner data"


def test_bootstrap_persists_exact_teardown_receipt_before_creating_roles() -> None:
    source = BOOTSTRAP_PATH.read_text(encoding="utf-8")

    assert source.index("Bootstrap targets already exist") < source.index(
        "[IO.File]::WriteAllText($StatePath"
    )
    assert source.index("[IO.File]::WriteAllText($StatePath") < source.index(
        "Invoke-PsqlText $psql $AdminRole 'postgres' $roleSql"
    )


def test_bootstrap_contract_keeps_pgpass_scoped_and_exports_passwordless_urls(tmp_path: Path) -> None:
    contract = _bootstrap_contract(tmp_path)
    serialized = json.dumps(contract, sort_keys=True)
    pgpass_path = Path(contract["pgpass"]["path"]).resolve()
    assert pgpass_path.is_relative_to((tmp_path / "runner-temp").resolve())
    assert contract["pgpass"]["scope"] == "job"
    assert contract["pgpass"]["deleteOnTeardown"] is True
    assert contract["secrets"]["maskBeforeUse"] is True
    assert "password" not in serialized.casefold()
    exports = contract["githubEnvExports"]
    assert exports["PGPASSFILE"] == str(pgpass_path)
    assert all("@localhost/album_haven_ci_run_123_attempt_2_python_windows" in value for key, value in exports.items() if key.endswith("DATABASE_URL"))
    assert not any(
        ":" in value.split("://", 1)[1].split("@", 1)[0]
        for key, value in exports.items()
        if key.endswith("DATABASE_URL")
    )


def test_bootstrap_contract_hands_fixture_to_copy_loader_and_analyze(tmp_path: Path) -> None:
    contract = _bootstrap_contract(tmp_path)
    assert contract["fixtureLoad"] == {
        "script": "scripts/ci/load-fixture-profile.py",
        "databaseUrlEnvironment": "ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL",
        "fixtureRootEnvironment": "ALBUM_HAVEN_FIXTURE_ROOT",
        "profileEnvironment": "ALBUM_HAVEN_FIXTURE_PROFILE",
        "copyRequired": True,
        "analyzeRequired": True,
        "beforeTestExecution": True,
    }


def test_isolated_postgres_skip_or_fail_ci_fails_in_ci_and_skips_locally(monkeypatch: pytest.MonkeyPatch) -> None:
    from tests.py import test_isolated_postgres_live

    monkeypatch.setenv("CI", "true")
    with pytest.raises(pytest.fail.Exception, match="Postgres unavailable"):
        test_isolated_postgres_live._skip_or_fail_ci("Postgres unavailable")
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    with pytest.raises(pytest.fail.Exception, match="Postgres unavailable"):
        test_isolated_postgres_live._skip_or_fail_ci("Postgres unavailable")
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    with pytest.raises(pytest.skip.Exception, match="Postgres unavailable"):
        test_isolated_postgres_live._skip_or_fail_ci("Postgres unavailable")
