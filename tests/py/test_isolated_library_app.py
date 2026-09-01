from __future__ import annotations

import asyncio
import ast
import hashlib
import http.client
import io
import json
import math
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import struct
import sys
import threading
import time
from types import SimpleNamespace
import tempfile
from urllib.parse import quote, urlparse

import pytest

import music_app
from tests.e2e.support import isolatedLibraryApp, isolatedPostgres
from music_app.services import (
    cover_provider_apple,
    cover_provider_fallback_web,
    cover_provider_registry,
    relation_projection_postgres,
)
from music_app.services.cover_provider_matching import album_name_in_alt
from music_app.services.library import build_albums_from_file_cache
from music_app.services.playback_pcm import PcmDecoderProcess, PcmOpenCommand


LAUNCHER_PATH = Path("tests/e2e/support/isolatedLibraryApp.py")


def test_preloaded_synthetic_provider_uses_fixture_owned_covers(tmp_path):
    media_root = tmp_path / "media"
    cover_root = media_root / "covers" / "approved"
    cover_root.mkdir(parents=True)
    for index in range(2):
        (cover_root / f"approved-{index}.jpg").write_bytes(f"cover-{index}".encode("ascii"))
    loopback_root = tmp_path / "loopback"
    loopback_root.mkdir()
    (loopback_root / "cover-responses.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "covers": [
                    {
                        "cover_id": "mastodon-crack-the-skye",
                        "artist": "Mastodon",
                        "album": "Crack The Skye",
                        "year": 2009,
                        "width": 7500,
                        "height": 7500,
                        "staged_path": "media/covers/approved/approved-0.jpg",
                        "other_art_staged_path": "media/covers/approved/approved-1.jpg",
                        "other_art_width": 4518,
                        "other_art_height": 4518,
                    },
                    {
                        "cover_id": "flaming-row-pure-shine",
                        "artist": "Flaming Row",
                        "album": "The Pure Shine",
                        "year": 2019,
                        "width": 4518,
                        "height": 4518,
                        "staged_path": "media/covers/approved/approved-1.jpg",
                        "other_art_staged_path": "media/covers/approved/approved-0.jpg",
                        "other_art_width": 7500,
                        "other_art_height": 7500,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    specs = isolatedLibraryApp.build_preloaded_synthetic_provider_cover_specs(media_root)

    assert len(specs) == 2
    assert [(spec["artist"], spec["album"], spec["year"]) for spec in specs] == [
        ("Mastodon", "Crack The Skye", 2009),
        ("Flaming Row", "The Pure Shine", 2019),
    ]
    assert {Path(spec["staged_path"]) for spec in specs} == set(cover_root.iterdir())
    assert all(Path(spec["other_art_staged_path"]).is_relative_to(tmp_path) for spec in specs)
    assert all(spec["staged_path"] != spec["other_art_staged_path"] for spec in specs)


@pytest.mark.parametrize(
    "fixture_profile",
    ["functional-core", "synthetic-large-library", "utility-problematic-files"],
)
def test_preloaded_fixture_requires_exact_media_directory(
    tmp_path, monkeypatch, fixture_profile
):
    fixture_root = tmp_path / "fixture"
    owner_music = fixture_root / "owner" / "Music"
    owner_music.mkdir(parents=True)
    monkeypatch.setenv("ALBUM_HAVEN_FIXTURE_PROFILE", fixture_profile)
    monkeypatch.setenv("ALBUM_HAVEN_FIXTURE_ROOT", str(fixture_root))
    monkeypatch.setenv("ALBUM_HAVEN_MEDIA_ROOT", str(owner_music))

    with pytest.raises(RuntimeError, match="exact.*media|media.*exact"):
        isolatedLibraryApp.configure_preloaded_fixture()


def test_functional_core_preloaded_fixture_accepts_exact_media_directory(
    tmp_path, monkeypatch
):
    fixture_root = tmp_path / "fixture"
    media_root = fixture_root / "media"
    media_root.mkdir(parents=True)
    monkeypatch.setenv("ALBUM_HAVEN_FIXTURE_PROFILE", "functional-core")
    monkeypatch.setenv("ALBUM_HAVEN_FIXTURE_ROOT", str(fixture_root))
    monkeypatch.setenv("ALBUM_HAVEN_MEDIA_ROOT", str(media_root))

    assert isolatedLibraryApp.configure_preloaded_fixture() == media_root.resolve()


def test_functional_core_seeds_only_the_normal_negative_cover_cache(tmp_path):
    cache_path = tmp_path / "app-data" / "cover-search-cache.json"
    coverless_rows = [
        ("Fixture Artist", f"Naturally Coverless {index:02d}", 2026, "")
        for index in range(1, 13)
    ] + [
        ("Mastodon", "Crack The Skye Fixture 07", 2009, ""),
        ("Mastodon", "Crack The Skye Fixture 08", 2009, ""),
    ]
    statements: list[str] = []

    class Result:
        @staticmethod
        def fetchall():
            return coverless_rows

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        @staticmethod
        def execute(statement):
            statements.append(statement)
            return Result()

    seeded = isolatedLibraryApp.seed_functional_cover_search_cache(
        "postgresql://fixture",
        cache_path,
        connect=lambda _url: Connection(),
        updated_at=1234.5,
    )

    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    assert seeded == 12
    assert len(statements) == 1
    assert statements[0].lstrip().casefold().startswith("select")
    assert not any(token in statements[0].casefold() for token in ("update ", "insert ", "delete "))
    assert len(payload["queries"]) == 12
    assert "mastodon::crack the skye fixture 07::::2009" not in payload["queries"]
    assert "mastodon::crack the skye fixture 08::::2009" not in payload["queries"]


def test_functional_core_cover_cache_accepts_shared_wave_growth(tmp_path):
    cache_path = tmp_path / "app-data" / "cover-search-cache.json"
    coverless_rows = [
        ("Fixture Artist", f"Naturally Coverless {index:02d}", 2026, "")
        for index in range(1, 13)
    ] + [
        ("New Destination Artist", "New Coverless Album", 2026, ""),
        ("Mastodon", "Crack The Skye Fixture 07", 2009, ""),
        ("Mastodon", "Crack The Skye Fixture 08", 2009, ""),
    ]

    class Result:
        @staticmethod
        def fetchall():
            return coverless_rows

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        @staticmethod
        def execute(_statement):
            return Result()

    seeded = isolatedLibraryApp.seed_functional_cover_search_cache(
        "postgresql://fixture",
        cache_path,
        connect=lambda _url: Connection(),
        updated_at=1234.5,
    )

    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    assert seeded == 13
    assert len(payload["queries"]) == 13
    assert "new destination artist::new coverless album::::2026" in payload["queries"]
    assert "mastodon::crack the skye fixture 07::::2009" not in payload["queries"]
    assert "mastodon::crack the skye fixture 08::::2009" not in payload["queries"]


def test_functional_core_cover_cache_includes_provider_scenarios_for_non_album_rescan(tmp_path):
    cache_path = tmp_path / "app-data" / "cover-search-cache.json"
    coverless_rows = [
        ("Fixture Artist", f"Naturally Coverless {index:02d}", 2026, "")
        for index in range(1, 13)
    ] + [
        ("Mastodon", "Crack The Skye Fixture 07", 2009, ""),
        ("Mastodon", "Crack The Skye Fixture 08", 2009, ""),
    ]

    class Result:
        @staticmethod
        def fetchall():
            return coverless_rows

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        @staticmethod
        def execute(_statement):
            return Result()

    seeded = isolatedLibraryApp.seed_functional_cover_search_cache(
        "postgresql://fixture",
        cache_path,
        connect=lambda _url: Connection(),
        updated_at=1234.5,
        preserve_provider_scenarios=False,
    )

    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    assert seeded == 14
    assert "mastodon::crack the skye fixture 07::::2009" in payload["queries"]
    assert "mastodon::crack the skye fixture 08::::2009" in payload["queries"]


def test_functional_core_cover_cache_seeds_scan_tag_year_variants(tmp_path):
    cache_path = tmp_path / "app-data" / "cover-search-cache.json"
    coverless_rows = [
        ("Fixture Artist", f"Naturally Coverless {index:02d}", 2026, "")
        for index in range(1, 13)
    ] + [
        ("ДДТ", "Студийные записи", 1990, ""),
        ("ДДТ", "Студийные записи", 1999, ""),
    ]
    statements: list[str] = []

    class Result:
        @staticmethod
        def fetchall():
            return coverless_rows

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        @staticmethod
        def execute(statement):
            statements.append(statement)
            return Result()

    isolatedLibraryApp.seed_functional_cover_search_cache(
        "postgresql://fixture",
        cache_path,
        connect=lambda _url: Connection(),
        updated_at=1234.5,
        preserve_provider_scenarios=False,
    )

    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    statement = statements[0].casefold()
    from music_app.services.cover_provider_cache import cover_query_key

    assert "library.local_track_files" in statement
    assert "scan_cache" in statement
    assert "file_entry" in statement
    assert cover_query_key("ДДТ", "Студийные записи", None, 1990) in payload["queries"]
    assert cover_query_key("ДДТ", "Студийные записи", None, 1999) in payload["queries"]


def test_functional_core_cover_cache_rejects_missing_baseline_rows(tmp_path):
    cache_path = tmp_path / "app-data" / "cover-search-cache.json"
    coverless_rows = [
        ("Fixture Artist", f"Naturally Coverless {index:02d}", 2026, "")
        for index in range(1, 12)
    ]

    class Result:
        @staticmethod
        def fetchall():
            return coverless_rows

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        @staticmethod
        def execute(_statement):
            return Result()

    with pytest.raises(RuntimeError, match="at least 12 naturally coverless"):
        isolatedLibraryApp.seed_functional_cover_search_cache(
            "postgresql://fixture",
            cache_path,
            connect=lambda _url: Connection(),
        )


def decode_sample_probe(path: Path, *, frame_count: int = 256) -> dict[str, object]:
    async def scenario() -> dict[str, object]:
        decoder = await PcmDecoderProcess.start(
            PcmOpenCommand(
                generation=1,
                stream_id=1,
                role="current",
                path=path,
                start_frame=0,
                sample_rate=48_000,
                provisional_duration_seconds=60.0,
            )
        )
        decoder.grant_credit(frame_count)
        pcm = bytearray()
        try:
            while len(pcm) < frame_count * 8:
                chunk = await decoder.read_credited_frames(
                    max_frames=frame_count - (len(pcm) // 8)
                )
                if chunk.frame_count == 0:
                    break
                pcm.extend(chunk.pcm)
        finally:
            await decoder.cancel()
        samples = struct.unpack(f"<{len(pcm) // 4}f", pcm)
        return {
            "frame_count": len(samples) // 2,
            "samples": samples,
            "peak": max((abs(sample) for sample in samples), default=0.0),
        }

    result = asyncio.run(scenario())
    assert result["frame_count"] == frame_count
    assert all(math.isfinite(sample) for sample in result["samples"])
    assert result["peak"] > 0.001
    return result


def _attribute_parts(node: ast.AST) -> list[str]:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return list(reversed(parts))


def test_preloaded_fixture_profiles_are_exact_and_have_no_runtime_normalization_seam():
    source = LAUNCHER_PATH.read_text(encoding="utf-8")

    assert isolatedLibraryApp.PRELOADED_FIXTURE_PROFILES == frozenset(
        {
            "functional-core",
            "synthetic-large-library",
            "utility-problematic-files",
        }
    )
    assert "normalize_ddt_problem_rows" not in source


@pytest.mark.parametrize(
    ("fixture_profile", "expected_mode"),
    [
        ("synthetic-large-library", "preloaded-release"),
        ("utility-problematic-files", "preloaded-release"),
        ("playback-media", "generated-isolated"),
        ("scan-library", "generated-isolated"),
    ],
)
def test_fixture_profile_mode_preserves_released_and_generated_boundaries(
    fixture_profile, expected_mode
):
    assert isolatedLibraryApp.classify_fixture_profile_mode(fixture_profile) == expected_mode


@pytest.mark.parametrize(
    ("fixture_profile", "expected"),
    [
        ("", True),
        ("functional-core", True),
        ("playback-media", False),
        ("scan-library", False),
    ],
)
def test_generated_performance_profiles_skip_unrelated_provider_storage_policy_seed(
    fixture_profile, expected
):
    assert (
        isolatedLibraryApp.fixture_profile_requires_provider_storage_policy_fixture(
            fixture_profile
        )
        is expected
    )


def test_preloaded_fixture_profiles_use_normal_postgres_rows_and_bypass_runtime_shaping():
    source = LAUNCHER_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    main_node = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "main"
    )
    main_source = ast.get_source_segment(source, main_node)
    assert main_source is not None

    assert "fixture_profile_mode = classify_fixture_profile_mode(fixture_profile)" in main_source
    assert 'is_preloaded_fixture = fixture_profile_mode == "preloaded-release"' in main_source
    assert "library_root = configure_preloaded_fixture()" in main_source
    assert "fixture_media_root = library_root if is_preloaded_fixture else None" in main_source
    assert 'if fixture_profile == "functional-core":' in main_source
    assert "seed_functional_cover_search_cache(" in main_source
    assert "if not is_preloaded_fixture and not reuse_state:" in main_source
    assert "if database_preparation_started and not preserve_on_shutdown:" in main_source

    preloaded_branch = main_source.split("if is_preloaded_fixture:", 1)[1].split(
        "elif reuse_state:", 1
    )[0]
    for forbidden in (
        "build_file_cache(",
        "materialize_rarity_fixture_tracks(",
        "materialize_playback_start_fixture_tracks(",
        "materialize_fixture_track_files(",
        "prepare_isolated_database(",
        "persist_fixture_inventory(",
        "reset_application_tables(",
    ):
        assert forbidden not in preloaded_branch

    configure_source = ast.get_source_segment(
        source,
        next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "configure_preloaded_fixture"
        ),
    )
    assert configure_source is not None
    assert "ALBUM_HAVEN_FIXTURE_ROOT" in configure_source
    assert "ALBUM_HAVEN_MEDIA_ROOT" in configure_source
    assert "expected_media_root = fixture_root / \"media\"" in configure_source
    for forbidden in (
        "build_file_cache(",
        "materialize",
        "prepare_isolated_database(",
        "persist_fixture_inventory(",
        "reset_application_tables(",
    ):
        assert forbidden not in configure_source


def test_isolated_library_launcher_is_setup_only_and_runs_the_production_asgi_app():
    source = LAUNCHER_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)

    imported_names = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in node.names
    }
    called_attributes = {
        tuple(_attribute_parts(node.func))
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    assigned_attributes = {
        tuple(_attribute_parts(target))
        for node in ast.walk(tree)
        if isinstance(node, (ast.Assign, ast.AnnAssign))
        for target in (node.targets if isinstance(node, ast.Assign) else [node.target])
        if isinstance(target, ast.Attribute)
    }
    route_decorators = {
        parts[-1]
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        for decorator in node.decorator_list
        if isinstance(decorator, ast.Call)
        if (parts := _attribute_parts(decorator.func))
    }

    assert "create_asgi_app" in imported_names
    assert "uvicorn" in imported_names
    assert ("uvicorn", "run") in called_attributes
    assert "FastAPI" not in imported_names
    assert not any(parts[-1:] == ("FastAPI",) for parts in called_attributes)
    assert route_decorators.isdisjoint({"get", "post", "put", "patch", "delete", "route", "websocket"})
    assert not any(parts[:2] == ("app", "state") for parts in assigned_attributes)
    for forbidden_product_runtime in (
        "install_fake_runtime",
        "add_api_route",
        "app.include_router",
        "app.state.library_state =",
        "app.state.cover_lookup_tasks =",
        "app.state.loops =",
        '"/loops/create"',
        '"/utilities/loops"',
    ):
        assert forbidden_product_runtime not in source


def test_ci_runtime_installs_uvicorn_websocket_transport():
    requirements = {
        line.strip().casefold()
        for line in Path("requirements.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    assert "websockets" in requirements


def test_rating_fixture_updates_qualify_local_album_metadata_in_update_from_statements():
    source = LAUNCHER_PATH.read_text(encoding="utf-8")
    rating_source = source.split(
        "def persist_fixture_album_rating_contract(",
        1,
    )[1].split("def _normalize_provider_query", 1)[0]
    absent_source = rating_source.split('if role == "absent":', 1)[1].split(
        "continue",
        1,
    )[0]

    assert rating_source.count("set metadata = library.local_albums.metadata") == 2
    assert "set metadata = metadata - 'tag_album_rating'" not in rating_source
    assert "set metadata = metadata || jsonb_build_object(" not in rating_source
    assert (
        "library.local_albums.metadata - 'tag_album_rating' - 'tag_album_rating_source'"
        in absent_source
    )


def test_fixture_album_rating_treats_generated_zero_as_absent_but_preserves_contract_zero():
    explicit_zero_fixture = next(
        fixture
        for fixture in isolatedLibraryApp.RATING_FIXTURES
        if fixture[0] == "zero"
    )

    assert isolatedLibraryApp.fixture_album_rating(None, 0, 0) is None
    assert isolatedLibraryApp.fixture_album_rating(None, 1, 0) == 1
    assert (
        isolatedLibraryApp.fixture_album_rating(
            explicit_zero_fixture,
            0,
            0,
        )
        == 0
    )


def test_real_cover_manifest_contains_only_relative_file_names():
    manifest = isolatedLibraryApp.load_real_cover_manifest()
    forbidden_path_keys = {"sourceRoot", "sourcePath", "repoPath", "fileName"}

    def assert_metadata_is_portable(value):
        if isinstance(value, dict):
            assert forbidden_path_keys.isdisjoint(value)
            for nested_value in value.values():
                assert_metadata_is_portable(nested_value)
        elif isinstance(value, list):
            for nested_value in value:
                assert_metadata_is_portable(nested_value)
        elif isinstance(value, str):
            assert not PureWindowsPath(value).is_absolute()
            assert not PurePosixPath(value).is_absolute()

    assert_metadata_is_portable(manifest)
    for cover in manifest["covers"]:
        assert str(cover.get("assetId") or "").strip()
        assert len(str(cover.get("sha256") or "").strip()) == 64


def test_manifest_cover_resolver_delegates_to_pinned_hash(monkeypatch, tmp_path):
    cover_path = tmp_path / "cover.jpg"
    expected_hash = "a" * 64
    monkeypatch.setattr(
        isolatedLibraryApp,
        "resolve_approved_cover_by_sha256",
        lambda value: cover_path if value == expected_hash else None,
    )

    assert isolatedLibraryApp.resolve_manifest_cover_path({"sha256": expected_hash}) == cover_path


@pytest.mark.parametrize(
    "cover",
    [{}, {"sha256": ""}, {"assetId": "approved-cover-01"}],
)
def test_manifest_cover_resolver_rejects_missing_hash(cover):
    with pytest.raises(RuntimeError, match="requires sha256"):
        isolatedLibraryApp.resolve_manifest_cover_path(cover)


def test_isolated_database_urls_require_owned_database_identity_and_separate_roles():
    setup_url = "postgresql://album_haven_migrator@localhost:5432/album_haven_fake_e2e"
    runtime_url = "postgresql://album_haven_app@localhost:5432/album_haven_fake_e2e"

    assert isolatedPostgres.resolve_isolated_database_urls(
        {
            isolatedPostgres.SETUP_DATABASE_ENV: setup_url,
            isolatedPostgres.RUNTIME_DATABASE_ENV: runtime_url,
        }
    ) == (setup_url, runtime_url)

    suffixed_setup = "postgresql://album_haven_migrator_run_1@localhost/album_haven_ci_run_1"
    suffixed_runtime = "postgresql://album_haven_app_run_1@localhost/album_haven_ci_run_1"
    assert isolatedPostgres.resolve_isolated_database_urls(
        {
            isolatedPostgres.SETUP_DATABASE_ENV: suffixed_setup,
            isolatedPostgres.RUNTIME_DATABASE_ENV: suffixed_runtime,
        }
    ) == (suffixed_setup, suffixed_runtime)


@pytest.mark.parametrize(
    ("setup_url", "runtime_url", "message"),
    [
        ("", "", isolatedPostgres.SETUP_DATABASE_ENV),
        (
            "postgresql://album_haven_migrator@localhost/album_haven_core",
            "postgresql://album_haven_app@localhost/album_haven_core",
            "must not target album_haven_core",
        ),
        (
            "postgresql://album_haven_migrator@localhost/another_database",
            "postgresql://album_haven_app@localhost/another_database",
            "must target",
        ),
        (
            "postgresql://album_haven_migrator@localhost:5432/album_haven_fake_e2e",
            "postgresql://album_haven_app@127.0.0.1:5432/album_haven_fake_e2e",
            "must identify the same",
        ),
        (
            "postgresql://postgres@localhost/album_haven_fake_e2e",
            "postgresql://album_haven_app@localhost/album_haven_fake_e2e",
            "must use role 'album_haven_migrator'",
        ),
        (
            "postgresql://album_haven_migrator@localhost/album_haven_fake_e2e",
            "postgresql://postgres@localhost/album_haven_fake_e2e",
            "must use role 'album_haven_app'",
        ),
        (
            "postgresql://album_haven_migrator:secret@localhost/album_haven_fake_e2e",
            "postgresql://album_haven_app@localhost/album_haven_fake_e2e",
            "must not include a password",
        ),
        (
            "postgresql://album_haven_migrator_run_1@db.example.test/album_haven_ci_run_1",
            "postgresql://album_haven_app_run_1@db.example.test/album_haven_ci_run_1",
            "loopback",
        ),
        (
            "postgresql://album_haven_migrator_run_1@localhost/album_haven_ci_run_1?host=db.example.test",
            "postgresql://album_haven_app_run_1@localhost/album_haven_ci_run_1?host=db.example.test",
            "parameter",
        ),
        (
            "postgresql://album_haven_migrator_x@localhost/album_haven_ci__x",
            "postgresql://album_haven_app_x@localhost/album_haven_ci__x",
            "must target",
        ),
        (
            "postgresql://album_haven_migrator__x@localhost/album_haven_ci_x",
            "postgresql://album_haven_app__x@localhost/album_haven_ci_x",
            "must use role",
        ),
        (
            "postgresql://album_haven_migrator_run_2@localhost/album_haven_ci_run_1",
            "postgresql://album_haven_app_run_1@localhost/album_haven_ci_run_1",
            "suffix",
        ),
        (
            "postgresql://album_haven_migrator_run_1@localhost/album_haven_ci_run_1",
            "postgresql://album_haven_app_run_2@localhost/album_haven_ci_run_1",
            "suffix",
        ),
    ],
)
def test_isolated_database_urls_reject_unsafe_identity_or_role(setup_url, runtime_url, message):
    with pytest.raises(RuntimeError, match=message):
        isolatedPostgres.resolve_isolated_database_urls(
            {
                isolatedPostgres.SETUP_DATABASE_ENV: setup_url,
                isolatedPostgres.RUNTIME_DATABASE_ENV: runtime_url,
            }
        )


def _preserve_isolated_environment(monkeypatch):
    environment_keys = {
        "MUSIC_DIR",
        "MUSIC_APP_DATA_DIR",
        "MUSIC_CACHE_PATH",
        "MUSIC_COVER_CACHE_PATH",
        "MUSIC_BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS",
        "MUSIC_BULK_COVER_JOB_WORKERS",
        "MUSIC_LIBRARY_ROOTS_PATH",
        "ALBUM_HAVEN_APP_DATABASE_URL",
        "ALBUM_HAVEN_PERSISTENCE_DEFAULT",
        "ALBUM_HAVEN_COVER_PROVIDER_GROUPS",
        "ALBUM_HAVEN_ENABLED_MUSIC_SERVICES",
        "COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS",
        "APPLE_API_BASE_URL",
        "DUCKDUCKGO_SEARCH_BASE_URL",
        "BING_SEARCH_BASE_URL",
        "MUSICBRAINZ_BASE_URL",
        "COVER_ART_ARCHIVE_BASE_URL",
        "DISCOGS_API_BASE_URL",
        "MUSIC_CACHE_MAX_AGE_SECONDS",
        "MUSICBRAINZ_ENABLED",
        "DISCOGS_CONSUMER_KEY",
        "DISCOGS_CONSUMER_SECRET",
        "SPOTIFY_CLIENT_ID",
        "SPOTIFY_CLIENT_SECRET",
        "LASTFM_API_KEY",
        "LASTFM_API_SECRET",
        "LASTFM_API_ROOT",
        "LASTFM_SESSION",
        "LASTFM_SESSION_KEY",
        "LASTFM_USERNAME",
        "HTTP_PROXY",
        "http_proxy",
        "NO_PROXY",
        "no_proxy",
        "TMP",
        "TEMP",
        "TMPDIR",
        "ALBUM_HAVEN_SESSION_DIR",
    }
    environment_keys.update(
        f"ALBUM_HAVEN_PERSISTENCE_{seam_id.upper()}"
        for seam_id in isolatedLibraryApp._REQUIRED_POSTGRES_SEAMS
    )
    for key in environment_keys:
        monkeypatch.setenv(key, os.environ.get(key, ""))


def test_isolated_environment_uses_inert_filesystem_paths_and_postgres_selectors(tmp_path, monkeypatch):
    runtime_url = "postgresql://album_haven_app@localhost/album_haven_fake_e2e"
    _preserve_isolated_environment(monkeypatch)
    monkeypatch.setattr(tempfile, "tempdir", tempfile.tempdir)

    library_root = isolatedLibraryApp.configure_isolated_environment(tmp_path, runtime_url, 4175)

    assert library_root == tmp_path / "media"
    assert Path(isolatedLibraryApp.os.environ["MUSIC_APP_DATA_DIR"]) == tmp_path / "app-data"
    assert Path(isolatedLibraryApp.os.environ["MUSIC_CACHE_PATH"]).name == "inert-library-cache.json"
    assert Path(isolatedLibraryApp.os.environ["MUSIC_COVER_CACHE_PATH"]).name == "inert-cover-cache.json"
    assert isolatedLibraryApp.os.environ["MUSIC_BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS"] == "0"
    assert isolatedLibraryApp.os.environ["MUSIC_BULK_COVER_JOB_WORKERS"] == "4"
    assert Path(isolatedLibraryApp.os.environ["MUSIC_LIBRARY_ROOTS_PATH"]).name == "inert-library-roots.json"
    assert isolatedLibraryApp.os.environ["ALBUM_HAVEN_APP_DATABASE_URL"] == runtime_url
    assert isolatedLibraryApp.os.environ["ALBUM_HAVEN_COVER_PROVIDER_GROUPS"] == (
        "music_services,manual_urls,discogs,cover_art_archive"
    )
    assert isolatedLibraryApp.os.environ["ALBUM_HAVEN_ENABLED_MUSIC_SERVICES"] == "apple"
    assert isolatedLibraryApp.os.environ["COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS"] == "24"
    assert isolatedLibraryApp.os.environ["APPLE_API_BASE_URL"] == "http://127.0.0.1:4175/itunes"
    assert isolatedLibraryApp.os.environ["DUCKDUCKGO_SEARCH_BASE_URL"] == (
        "http://127.0.0.1:4175/duckduckgo-search"
    )
    assert isolatedLibraryApp.os.environ["BING_SEARCH_BASE_URL"] == (
        "http://127.0.0.1:4175/bing-search"
    )
    assert isolatedLibraryApp.os.environ["MUSICBRAINZ_BASE_URL"] == "http://127.0.0.1:4175/musicbrainz"
    assert isolatedLibraryApp.os.environ["COVER_ART_ARCHIVE_BASE_URL"] == (
        "http://127.0.0.1:4175/coverartarchive"
    )
    assert isolatedLibraryApp.os.environ["DISCOGS_API_BASE_URL"] == (
        "http://127.0.0.1:4175/discogs"
    )
    assert isolatedLibraryApp.os.environ["LASTFM_API_KEY"] == isolatedLibraryApp.LASTFM_FAKE_API_KEY
    assert isolatedLibraryApp.os.environ["LASTFM_API_SECRET"] == isolatedLibraryApp.LASTFM_FAKE_API_SECRET
    assert isolatedLibraryApp.os.environ["LASTFM_API_ROOT"] == "http://127.0.0.1:4175/lastfm"
    assert isolatedLibraryApp.os.environ["LASTFM_SESSION"] == ""
    assert isolatedLibraryApp.os.environ["LASTFM_SESSION_KEY"] == ""
    assert isolatedLibraryApp.os.environ["LASTFM_USERNAME"] == ""
    for seam_id in isolatedLibraryApp._REQUIRED_POSTGRES_SEAMS:
        assert isolatedLibraryApp.os.environ[f"ALBUM_HAVEN_PERSISTENCE_{seam_id.upper()}"] == "postgres"


def test_isolated_environment_keeps_seeded_cover_misses_active_for_unrelated_scan_scenarios(
    tmp_path,
    monkeypatch,
):
    runtime_url = "postgresql://album_haven_app@localhost/album_haven_fake_e2e"
    _preserve_isolated_environment(monkeypatch)
    monkeypatch.setattr(tempfile, "tempdir", tempfile.tempdir)

    isolatedLibraryApp.configure_isolated_environment(
        tmp_path,
        runtime_url,
        4175,
        use_seeded_cover_misses=True,
    )

    assert isolatedLibraryApp.os.environ["MUSIC_BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS"] == "43200"


def test_database_preparation_resets_before_migrations_and_preserves_migration_seed_state(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(
        isolatedPostgres,
        "reset_application_tables",
        lambda _url: calls.append("reset stale rows"),
    )
    monkeypatch.setattr(
        isolatedPostgres,
        "apply_all_migrations",
        lambda _url: calls.append("migrate including 0017 seed"),
    )
    monkeypatch.setattr(
        isolatedPostgres,
        "grant_runtime_role_privileges",
        lambda _setup_url, _runtime_url: calls.append("restore runtime grants"),
    )
    monkeypatch.setattr(
        isolatedPostgres,
        "seed_bootstrap_owner_and_library",
        lambda _url: calls.append("seed launcher fixtures"),
    )
    monkeypatch.setattr(
        isolatedPostgres,
        "assert_runtime_connection",
        lambda _url: calls.append("validate runtime role"),
    )
    monkeypatch.setattr(
        isolatedPostgres,
        "assert_runtime_grants",
        lambda _url: calls.append("validate runtime grants"),
    )

    isolatedPostgres.prepare_isolated_database("setup", "runtime")

    assert calls == [
        "reset stale rows",
        "migrate including 0017 seed",
        "restore runtime grants",
        "seed launcher fixtures",
        "validate runtime role",
        "validate runtime grants",
    ]


def _runtime_table_privilege_rows(failed_check=None):
    rows = []
    for schema_name, table_name in isolatedPostgres._RUNTIME_DELETE_TABLES:
        for privilege in (
            isolatedPostgres._REQUIRED_TABLE_PRIVILEGES
            + isolatedPostgres._DENIED_TABLE_PRIVILEGES
        ):
            granted = privilege in isolatedPostgres._REQUIRED_TABLE_PRIVILEGES
            if failed_check == (schema_name, table_name, privilege):
                granted = not granted
            rows.append(
                {
                    "schema_name": schema_name,
                    "table_name": table_name,
                    "privilege_type": privilege,
                    "granted": granted,
                }
            )
    return rows


def test_runtime_grant_verification_accepts_only_required_table_privileges(monkeypatch):
    boundary_row = {
        "integration_schema_usage": True,
        "integration_schema_create_denied": True,
        "library_schema_usage": True,
        "library_schema_create_denied": True,
        "ops_schema_usage": True,
        "ops_schema_create_denied": True,
        "sequence_usage": True,
        "sequence_select": True,
        "sequence_update_denied": True,
    }

    class GrantResult:
        def __init__(self, rows=None, row=None):
            self.rows = rows
            self.row = row

        def fetchall(self):
            return self.rows

        def fetchone(self):
            return self.row

    class GrantConnection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        @staticmethod
        def execute(query, params=None):
            if "has_table_privilege" in query:
                assert len(params[0]) == len(isolatedPostgres._RUNTIME_DELETE_TABLES)
                assert params[2] == list(
                    isolatedPostgres._REQUIRED_TABLE_PRIVILEGES
                    + isolatedPostgres._DENIED_TABLE_PRIVILEGES
                )
                return GrantResult(rows=_runtime_table_privilege_rows())
            assert "has_schema_privilege" in query
            assert "has_sequence_privilege" in query
            return GrantResult(row=boundary_row)

    monkeypatch.setattr(isolatedPostgres, "_connect", lambda _url: GrantConnection())
    monkeypatch.setattr(isolatedPostgres, "_assert_connected_role", lambda *_args: None)

    isolatedPostgres.assert_runtime_grants("runtime")


@pytest.mark.parametrize(
    ("failed_check", "message"),
    [
        (("integration", "pending_scrobbles", "DELETE"), "integration.pending_scrobbles DELETE"),
        (("library", "manual_versions", "TRUNCATE"), "library.manual_versions TRUNCATE denied"),
        ("ops_schema_create_denied", "ops schema CREATE denied"),
        ("sequence_update_denied", "cover lookup sequence UPDATE denied"),
    ],
)
def test_runtime_grant_verification_fails_loudly_for_missing_or_overbroad_grant(
    monkeypatch,
    failed_check,
    message,
):
    boundary_row = {
        "integration_schema_usage": True,
        "integration_schema_create_denied": True,
        "library_schema_usage": True,
        "library_schema_create_denied": True,
        "ops_schema_usage": True,
        "ops_schema_create_denied": True,
        "sequence_usage": True,
        "sequence_select": True,
        "sequence_update_denied": True,
    }
    table_failure = failed_check if isinstance(failed_check, tuple) else None
    if table_failure is None:
        boundary_row[failed_check] = False

    class GrantResult:
        def __init__(self, rows=None, row=None):
            self.rows = rows
            self.row = row

        def fetchall(self):
            return self.rows

        def fetchone(self):
            return self.row

    class GrantConnection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        @staticmethod
        def execute(query, _params=None):
            if "has_table_privilege" in query:
                return GrantResult(rows=_runtime_table_privilege_rows(table_failure))
            return GrantResult(row=boundary_row)

    monkeypatch.setattr(isolatedPostgres, "_connect", lambda _url: GrantConnection())
    monkeypatch.setattr(isolatedPostgres, "_assert_connected_role", lambda *_args: None)

    with pytest.raises(RuntimeError, match=message):
        isolatedPostgres.assert_runtime_grants("runtime")


def test_reset_ownership_excludes_migration_owned_seed_and_reference_tables():
    rows = [
        {"schemaname": "app", "tablename": "accounts"},
        {"schemaname": "app", "tablename": "client_surface_classes"},
        {"schemaname": "app", "tablename": "deployment_mode_rules"},
        {"schemaname": "app", "tablename": "e2e_problematic_file_fixture_seeds"},
        {"schemaname": "ops", "tablename": "schema_migrations"},
        {"schemaname": "library", "tablename": "local_tracks"},
    ]

    assert isolatedPostgres._reset_owned_table_rows(rows) == [rows[0], rows[-1]]


def test_reset_accepts_pristine_database_without_application_tables(monkeypatch):
    class EmptyResult:
        @staticmethod
        def fetchall():
            return []

    class EmptyConnection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        @staticmethod
        def execute(*_args, **_kwargs):
            return EmptyResult()

    monkeypatch.setattr(isolatedPostgres, "_connect", lambda _url: EmptyConnection())
    monkeypatch.setattr(isolatedPostgres, "_assert_connected_role", lambda *_args: None)

    isolatedPostgres.reset_application_tables("setup")


@pytest.mark.parametrize(
    ("probe_error", "expected_state"),
    [
        (ProcessLookupError(), isolatedPostgres._ProcessIdentityState.ABSENT),
        (PermissionError(), isolatedPostgres._ProcessIdentityState.UNKNOWN),
        (OSError(), isolatedPostgres._ProcessIdentityState.UNKNOWN),
    ],
    ids=["absent", "access-denied", "query-failure"],
)
def test_process_identity_distinguishes_absence_from_probe_failure(
    probe_error,
    expected_state,
    monkeypatch,
):
    def fail_probe(_process_id, _signal):
        raise probe_error

    with monkeypatch.context() as probe_patch:
        probe_patch.setattr(isolatedPostgres.os, "name", "posix")
        probe_patch.setattr(isolatedPostgres.os, "kill", fail_probe)
        result = isolatedPostgres._process_identity(42)

    assert result == isolatedPostgres._ProcessIdentityResult(expected_state)


def test_isolated_database_lock_acquires_with_owned_process_identity(tmp_path, monkeypatch):
    lock_path = tmp_path / "database.lock"
    monkeypatch.setattr(
        isolatedPostgres,
        "_process_identity",
        lambda pid: isolatedPostgres._ProcessIdentityResult(
            isolatedPostgres._ProcessIdentityState.PRESENT,
            f"process-{pid}",
        ),
    )
    lock = isolatedPostgres.IsolatedDatabaseOwnershipLock(lock_path=lock_path)

    lock.acquire()

    owner = json.loads((lock_path / "owner.json").read_text(encoding="utf-8"))
    assert owner["token"] == lock.owner_token
    assert owner["pid"] == os.getpid()
    assert owner["process_identity"] == f"process-{os.getpid()}"
    lock.release()
    assert not lock_path.exists()


def test_isolated_database_lock_waits_for_active_owner_without_hanging(tmp_path, monkeypatch):
    lock_path = tmp_path / "database.lock"
    lock_path.mkdir()
    owner_path = lock_path / "owner.json"
    owner_path.write_text(
        json.dumps({"token": "active", "pid": 42, "process_identity": "active-42"}),
        encoding="utf-8",
    )
    sleeps: list[float] = []

    def release_active_owner(delay: float) -> None:
        sleeps.append(delay)
        owner_path.unlink()
        lock_path.rmdir()

    monkeypatch.setattr(
        isolatedPostgres,
        "_process_identity",
        lambda pid: isolatedPostgres._ProcessIdentityResult(
            isolatedPostgres._ProcessIdentityState.PRESENT,
            "active-42" if pid == 42 else f"current-{pid}",
        ),
    )
    monkeypatch.setattr(isolatedPostgres.time, "monotonic", lambda: 0.0)
    monkeypatch.setattr(isolatedPostgres.time, "sleep", release_active_owner)
    lock = isolatedPostgres.IsolatedDatabaseOwnershipLock(lock_path=lock_path, wait_seconds=1)

    lock.acquire()

    assert sleeps == [isolatedPostgres._DATABASE_LOCK_POLL_SECONDS]
    assert json.loads(owner_path.read_text(encoding="utf-8"))["token"] == lock.owner_token
    lock.release()


def test_isolated_database_lock_rejects_active_owner_at_bounded_deadline(tmp_path, monkeypatch):
    lock_path = tmp_path / "database.lock"
    lock_path.mkdir()
    owner = {"token": "active", "pid": 42, "process_identity": "active-42"}
    (lock_path / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
    monkeypatch.setattr(
        isolatedPostgres,
        "_process_identity",
        lambda _pid: isolatedPostgres._ProcessIdentityResult(
            isolatedPostgres._ProcessIdentityState.PRESENT,
            "active-42",
        ),
    )
    monkeypatch.setattr(
        isolatedPostgres.time,
        "sleep",
        lambda _delay: pytest.fail("zero-wait acquisition must not sleep"),
    )
    lock = isolatedPostgres.IsolatedDatabaseOwnershipLock(lock_path=lock_path, wait_seconds=0)

    with pytest.raises(TimeoutError, match="current owner"):
        lock.acquire()

    assert json.loads((lock_path / "owner.json").read_text(encoding="utf-8")) == owner


@pytest.mark.parametrize(
    "owner_process_result",
    [
        isolatedPostgres._ProcessIdentityResult(isolatedPostgres._ProcessIdentityState.ABSENT),
        isolatedPostgres._ProcessIdentityResult(
            isolatedPostgres._ProcessIdentityState.PRESENT,
            "reused-42",
        ),
    ],
    ids=["absent", "reused-identity"],
)
def test_isolated_database_lock_recovers_stale_owner(
    owner_process_result,
    tmp_path,
    monkeypatch,
):
    lock_path = tmp_path / "database.lock"
    lock_path.mkdir()
    (lock_path / "owner.json").write_text(
        json.dumps({"token": "stale", "pid": 42, "process_identity": "old-42"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        isolatedPostgres,
        "_process_identity",
        lambda pid: (
            owner_process_result
            if pid == 42
            else isolatedPostgres._ProcessIdentityResult(
                isolatedPostgres._ProcessIdentityState.PRESENT,
                f"current-{pid}",
            )
        ),
    )
    lock = isolatedPostgres.IsolatedDatabaseOwnershipLock(lock_path=lock_path, wait_seconds=0)

    lock.acquire()

    owner = json.loads((lock_path / "owner.json").read_text(encoding="utf-8"))
    assert owner["token"] == lock.owner_token
    assert owner["process_identity"] == f"current-{os.getpid()}"
    lock.release()


def test_isolated_database_lock_treats_identity_query_failure_as_live(tmp_path, monkeypatch):
    lock_path = tmp_path / "database.lock"
    lock_path.mkdir()
    owner = {"token": "unknown", "pid": 42, "process_identity": "recorded-42"}
    (lock_path / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
    monkeypatch.setattr(
        isolatedPostgres,
        "_process_identity",
        lambda _pid: isolatedPostgres._ProcessIdentityResult(
            isolatedPostgres._ProcessIdentityState.UNKNOWN
        ),
    )
    lock = isolatedPostgres.IsolatedDatabaseOwnershipLock(lock_path=lock_path, wait_seconds=0)

    with pytest.raises(TimeoutError, match="current owner"):
        lock.acquire()

    assert json.loads((lock_path / "owner.json").read_text(encoding="utf-8")) == owner


def test_concurrent_stale_reaper_cannot_delete_new_live_replacement(tmp_path, monkeypatch):
    lock_path = tmp_path / "database.lock"
    lock_path.mkdir()
    (lock_path / "owner.json").write_text(
        json.dumps({"token": "stale", "pid": 42, "process_identity": "old-42"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        isolatedPostgres,
        "_process_identity",
        lambda pid: isolatedPostgres._ProcessIdentityResult(
            isolatedPostgres._ProcessIdentityState.PRESENT,
            f"current-{pid}",
        ),
    )

    reaper_owner_fd: int | None = None
    second_reaper_blocked = threading.Event()
    if os.name == "nt":
        def controlled_locking(fd, mode, _count):
            nonlocal reaper_owner_fd
            if mode == isolatedPostgres.msvcrt.LK_NBLCK:
                if reaper_owner_fd is not None:
                    second_reaper_blocked.set()
                    raise OSError("reaper lock is held")
                reaper_owner_fd = fd
            elif mode == isolatedPostgres.msvcrt.LK_UNLCK:
                if reaper_owner_fd != fd:
                    raise OSError("reaper lock is not owned by this descriptor")
                reaper_owner_fd = None

        monkeypatch.setattr(isolatedPostgres.msvcrt, "locking", controlled_locking)
    else:
        def controlled_flock(fd, operation):
            nonlocal reaper_owner_fd
            if operation & isolatedPostgres.fcntl.LOCK_UN:
                if reaper_owner_fd != fd:
                    raise OSError("reaper lock is not owned by this descriptor")
                reaper_owner_fd = None
            elif reaper_owner_fd is not None:
                second_reaper_blocked.set()
                raise OSError("reaper lock is held")
            else:
                reaper_owner_fd = fd

        monkeypatch.setattr(isolatedPostgres.fcntl, "flock", controlled_flock)

    first_waiter = isolatedPostgres.IsolatedDatabaseOwnershipLock(
        lock_path=lock_path,
        wait_seconds=0,
    )
    second_waiter = isolatedPostgres.IsolatedDatabaseOwnershipLock(
        lock_path=lock_path,
        wait_seconds=0,
    )
    first_inside_reaper = threading.Event()
    allow_first_reaper = threading.Event()
    first_read_owner = first_waiter._read_owner
    first_read_count = 0

    def pause_after_reaper_owner_read():
        nonlocal first_read_count
        owner = first_read_owner()
        first_read_count += 1
        if first_read_count == 2:
            first_inside_reaper.set()
            if not allow_first_reaper.wait(timeout=2):
                raise TimeoutError("test did not release the first stale reaper")
        return owner

    monkeypatch.setattr(first_waiter, "_read_owner", pause_after_reaper_owner_read)
    acquired: list[isolatedPostgres.IsolatedDatabaseOwnershipLock] = []
    failures: list[BaseException] = []

    def acquire(lock):
        try:
            lock.acquire()
            acquired.append(lock)
        except BaseException as exc:
            failures.append(exc)

    first_thread = threading.Thread(target=acquire, args=(first_waiter,))
    second_thread = threading.Thread(target=acquire, args=(second_waiter,))
    first_thread.start()
    assert first_inside_reaper.wait(timeout=2)
    second_thread.start()
    blocked = second_reaper_blocked.wait(timeout=2)
    allow_first_reaper.set()
    first_thread.join(timeout=2)
    second_thread.join(timeout=2)

    assert blocked, "the concurrent stale reaper entered deletion without serialization"
    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    assert acquired == [first_waiter]
    assert len(failures) == 1
    assert isinstance(failures[0], TimeoutError)
    owner = json.loads((lock_path / "owner.json").read_text(encoding="utf-8"))
    assert owner["token"] == first_waiter.owner_token
    first_waiter.release()


def test_isolated_database_lock_release_refuses_replaced_owner_token(tmp_path, monkeypatch):
    lock_path = tmp_path / "database.lock"
    monkeypatch.setattr(
        isolatedPostgres,
        "_process_identity",
        lambda pid: isolatedPostgres._ProcessIdentityResult(
            isolatedPostgres._ProcessIdentityState.PRESENT,
            f"process-{pid}",
        ),
    )
    lock = isolatedPostgres.IsolatedDatabaseOwnershipLock(lock_path=lock_path)
    lock.acquire()
    replacement_owner = {
        "token": "replacement",
        "pid": 99,
        "process_identity": "process-99",
    }
    (lock_path / "owner.json").write_text(json.dumps(replacement_owner), encoding="utf-8")

    with pytest.raises(RuntimeError, match="owner token changed"):
        lock.release()

    assert json.loads((lock_path / "owner.json").read_text(encoding="utf-8")) == replacement_owner
    assert lock_path.is_dir()


@pytest.mark.parametrize("reset_fails", [False, True])
def test_cleanup_only_reaps_stale_owner_resets_tables_and_releases_without_starting_services(
    reset_fails,
    tmp_path,
    monkeypatch,
):
    lock_path = tmp_path / "database.lock"
    lock_path.mkdir()
    (lock_path / "owner.json").write_text(
        json.dumps({"token": "stale", "pid": 42, "process_identity": "old-42"}),
        encoding="utf-8",
    )
    events: list[str] = []

    monkeypatch.setattr(sys, "argv", ["isolatedLibraryApp.py", "--cleanup-only"])
    monkeypatch.setattr(
        isolatedPostgres,
        "_process_identity",
        lambda pid: isolatedPostgres._ProcessIdentityResult(
            isolatedPostgres._ProcessIdentityState.PRESENT,
            f"current-{pid}",
        ),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "resolve_isolated_database_urls",
        lambda: ("setup", "runtime"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "IsolatedDatabaseOwnershipLock",
        lambda: isolatedPostgres.IsolatedDatabaseOwnershipLock(lock_path=lock_path, wait_seconds=0),
    )

    def reset(database_url):
        owner = json.loads((lock_path / "owner.json").read_text(encoding="utf-8"))
        assert owner["token"] != "stale"
        assert owner["process_identity"] == f"current-{os.getpid()}"
        events.append(f"database.reset:{database_url}")
        if reset_fails:
            raise RuntimeError("cleanup reset failed")

    monkeypatch.setattr(isolatedLibraryApp, "reset_application_tables", reset)

    def unexpected(name):
        def fail(*_args, **_kwargs):
            raise AssertionError(f"cleanup-only unexpectedly called {name}")

        return fail

    monkeypatch.setattr(isolatedLibraryApp.tempfile, "mkdtemp", unexpected("tempfile.mkdtemp"))
    monkeypatch.setattr(
        isolatedLibraryApp,
        "configure_isolated_environment",
        unexpected("configure_isolated_environment"),
    )
    monkeypatch.setattr(isolatedLibraryApp, "load_fixture_config", unexpected("load_fixture_config"))
    monkeypatch.setattr(isolatedLibraryApp, "ProviderFixtureService", unexpected("ProviderFixtureService"))
    monkeypatch.setattr(music_app, "create_asgi_app", unexpected("create_asgi_app"))
    monkeypatch.setattr("uvicorn.run", unexpected("uvicorn.run"))

    if reset_fails:
        with pytest.raises(RuntimeError, match="cleanup reset failed"):
            isolatedLibraryApp.main()
    else:
        isolatedLibraryApp.main()

    assert events == ["database.reset:setup"]
    assert not lock_path.exists()


@pytest.mark.parametrize("failure_point", ["prepare", "none"])
def test_isolated_launcher_holds_database_lock_through_startup_and_teardown_cleanup(
    failure_point,
    tmp_path,
    monkeypatch,
):
    events: list[str] = []
    temp_root = tmp_path / "launcher"
    temp_root.mkdir()

    class RecordingLock:
        def acquire(self):
            events.append("lock.acquire")

        def release(self):
            events.append("lock.release")

    class RecordingProvider:
        def __init__(
            self,
            _port,
            _cover_specs,
            *,
            cover_cache_path=None,
            derivative_root=None,
        ):
            assert cover_cache_path == Path(os.environ["MUSIC_COVER_CACHE_PATH"])
            assert derivative_root == temp_root / "provider-artwork"
            events.append("provider.create")

        def start(self):
            events.append("provider.start")

        def stop(self):
            events.append("provider.stop")

    def prepare(_setup_url, _runtime_url):
        events.append("database.prepare")
        if failure_point == "prepare":
            raise RuntimeError("preparation failed")

    monkeypatch.setattr(sys, "argv", ["isolatedLibraryApp.py", "--provider-port", "4321"])
    monkeypatch.setattr(
        isolatedLibraryApp,
        "resolve_isolated_database_urls",
        lambda: ("setup", "runtime"),
    )
    monkeypatch.setattr(isolatedLibraryApp.tempfile, "mkdtemp", lambda **_kwargs: str(temp_root))
    monkeypatch.setattr(isolatedLibraryApp, "IsolatedDatabaseOwnershipLock", RecordingLock)
    monkeypatch.setattr(isolatedLibraryApp, "install_shutdown_handlers", lambda: None)
    monkeypatch.setattr(
        isolatedLibraryApp,
        "configure_isolated_environment",
        lambda *_args, **_kwargs: temp_root / "media",
    )
    monkeypatch.setattr(isolatedLibraryApp, "load_fixture_config", lambda: {})
    monkeypatch.setattr(
        isolatedLibraryApp,
        "configure_performance_auth_environment",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "provision_performance_auth_owner",
        lambda *_args: None,
    )
    monkeypatch.setattr(isolatedLibraryApp, "stage_real_cover_pool", lambda *_args: [])
    monkeypatch.setattr(
        isolatedLibraryApp,
        "build_file_cache",
        lambda *_args: ({}, temp_root / "loop.mp3", 0, 0),
    )
    monkeypatch.setattr(isolatedLibraryApp, "materialize_fixture_track_files", lambda *_args: None)
    monkeypatch.setattr(isolatedLibraryApp, "materialize_rarity_fixture_tracks", lambda *_args: None)
    monkeypatch.setattr(
        isolatedLibraryApp,
        "materialize_playback_start_fixture_tracks",
        lambda *_args: None,
    )
    monkeypatch.setattr(isolatedLibraryApp, "prepare_isolated_database", prepare)
    monkeypatch.setattr(
        isolatedLibraryApp,
        "persist_fixture_inventory",
        lambda *_args: events.append("database.persist"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "persist_provider_storage_policy_candidates",
        lambda *_args: events.append("provider-candidates.persist"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "materialize_rating_scan_discovery_track",
        lambda *_args: events.append("rating-track.materialize"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "seed_fixture_lastfm_timezone",
        lambda: events.append("lastfm.timezone.seed"),
    )
    monkeypatch.setattr(isolatedLibraryApp, "ProviderFixtureService", RecordingProvider)
    monkeypatch.setattr(isolatedLibraryApp, "_runtime_config", lambda: {})
    monkeypatch.setattr(
        isolatedLibraryApp,
        "assert_production_runtime_configuration",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        music_app,
        "create_asgi_app",
        lambda: SimpleNamespace(state=SimpleNamespace(config={})),
    )
    monkeypatch.setattr("uvicorn.run", lambda *_args, **_kwargs: events.append("server.run"))
    monkeypatch.setattr(
        isolatedLibraryApp,
        "reset_application_tables",
        lambda _url: events.append("database.reset"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp.shutil,
        "rmtree",
        lambda *_args, **_kwargs: events.append("temp.cleanup"),
    )

    if failure_point == "prepare":
        with pytest.raises(RuntimeError, match="preparation failed"):
            isolatedLibraryApp.main()
        assert events == [
            "lock.acquire",
            "database.prepare",
            "database.reset",
            "temp.cleanup",
            "lock.release",
        ]
    else:
        isolatedLibraryApp.main()
        assert events == [
            "lock.acquire",
            "database.prepare",
            "database.persist",
            "provider-candidates.persist",
            "rating-track.materialize",
            "lastfm.timezone.seed",
            "provider.create",
            "provider.start",
            "server.run",
            "provider.stop",
            "database.reset",
            "temp.cleanup",
            "lock.release",
        ]


@pytest.mark.parametrize("reuse_state", [False, True])
def test_isolated_launcher_preserves_and_reuses_runner_owned_restart_state(
    reuse_state,
    tmp_path,
    monkeypatch,
):
    from PIL import Image

    events: list[str] = []
    provider_specs: list[dict[str, object]] = []
    temp_root = tmp_path / "restart-owned"
    temp_root.mkdir()
    staged_root = temp_root / "media" / "staged-covers"
    staged_root.mkdir(parents=True)
    staged_cover_path = staged_root / "fixture-cover.jpg"
    staged_cover_path.write_bytes(b"fixture-cover")
    staged_other_art_path = staged_root / "fixture-other-art.jpg"
    staged_other_art_path.write_bytes(b"fixture-other-art")
    staged_user_cover_source_path = staged_root / "fixture-user-cover-source.jpg"
    Image.new("RGB", (800, 800), color=(48, 96, 144)).save(
        staged_user_cover_source_path,
        format="JPEG",
        quality=95,
    )
    provider_storage_policy_path = staged_root / "provider-storage-policy-cover.jpg"
    provider_storage_policy_path.write_bytes(b"provider-storage-policy-cover")
    staged_cover_specs = [
        {
            "cover_id": "fixture-cover",
            "staged_path": str(staged_cover_path),
            "other_art_staged_path": str(staged_other_art_path),
            "artist": "Fixture Artist",
            "album": "Fixture Album",
            "year": 2024,
            "width": 1200,
            "height": 1200,
        },
        {
            "cover_id": "fixture-user-cover-source",
            "staged_path": str(staged_user_cover_source_path),
            "other_art_staged_path": str(staged_other_art_path),
            "artist": "Fixture User Cover Artist",
            "album": "Fixture User Cover Album",
            "year": 2024,
            "width": 800,
            "height": 800,
        },
    ]
    persisted_user_cover_path = isolatedLibraryApp.materialize_user_owned_cover(
        temp_root / "media" / "Mastodon" / "Crack The Skye Fixture 09",
        staged_user_cover_source_path,
    )
    persisted_user_cover_sha256 = hashlib.sha256(
        persisted_user_cover_path.read_bytes()
    ).hexdigest()

    class RecordingLock:
        def acquire(self):
            events.append("lock.acquire")

        def release(self):
            events.append("lock.release")

    class RecordingProvider:
        def __init__(
            self,
            _port,
            cover_specs,
            *,
            cover_cache_path=None,
            derivative_root=None,
        ):
            assert cover_cache_path == Path(os.environ["MUSIC_COVER_CACHE_PATH"])
            assert derivative_root == temp_root / "provider-artwork"
            events.append("provider.create")
            provider_specs.extend(dict(spec) for spec in cover_specs)

        def start(self):
            events.append("provider.start")

        def stop(self):
            events.append("provider.stop")

    monkeypatch.setattr(sys, "argv", ["isolatedLibraryApp.py", "--provider-port", "4321"])
    monkeypatch.setenv("ALBUM_HAVEN_E2E_TEMP_ROOT", str(temp_root))
    monkeypatch.setenv("ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN", "1")
    if reuse_state:
        monkeypatch.setenv("ALBUM_HAVEN_E2E_REUSE_STATE", "1")
    else:
        monkeypatch.delenv("ALBUM_HAVEN_E2E_REUSE_STATE", raising=False)
    monkeypatch.setattr(
        isolatedLibraryApp,
        "resolve_isolated_database_urls",
        lambda: ("setup", "runtime"),
    )
    monkeypatch.setattr(isolatedLibraryApp, "IsolatedDatabaseOwnershipLock", RecordingLock)
    monkeypatch.setattr(isolatedLibraryApp, "install_shutdown_handlers", lambda: None)
    monkeypatch.setattr(
        isolatedLibraryApp,
        "configure_isolated_environment",
        lambda *_args, **_kwargs: temp_root / "media",
    )
    monkeypatch.setattr(isolatedLibraryApp, "load_fixture_config", lambda: {})
    monkeypatch.setattr(
        isolatedLibraryApp,
        "configure_performance_auth_environment",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "provision_performance_auth_owner",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "stage_real_cover_pool",
        lambda *_args, reuse_existing=False: events.append(
            "covers.reuse" if reuse_existing else "covers.stage"
        )
        or [dict(spec) for spec in staged_cover_specs],
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "build_file_cache",
        lambda *_args: (events.append("inventory.build") or ({}, temp_root / "loop.mp3", 0, 0)),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "materialize_fixture_track_files",
        lambda *_args: events.append("tracks.materialize"),
    )
    monkeypatch.setattr(isolatedLibraryApp, "materialize_rarity_fixture_tracks", lambda *_args: None)
    monkeypatch.setattr(
        isolatedLibraryApp,
        "materialize_playback_start_fixture_tracks",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "prepare_isolated_database",
        lambda *_args: events.append("database.prepare"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "persist_fixture_inventory",
        lambda *_args: events.append("database.persist"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "persist_provider_storage_policy_candidates",
        lambda *_args: events.append("provider-candidates.persist"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "materialize_rating_scan_discovery_track",
        lambda *_args: events.append("rating-track.materialize"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "seed_fixture_lastfm_timezone",
        lambda: events.append("lastfm.timezone.seed"),
    )
    monkeypatch.setattr(isolatedLibraryApp, "ProviderFixtureService", RecordingProvider)
    monkeypatch.setattr(isolatedLibraryApp, "_runtime_config", lambda: {})
    monkeypatch.setattr(
        isolatedLibraryApp,
        "assert_production_runtime_configuration",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        music_app,
        "create_asgi_app",
        lambda: SimpleNamespace(state=SimpleNamespace(config={})),
    )
    monkeypatch.setattr("uvicorn.run", lambda *_args, **_kwargs: events.append("server.run"))
    monkeypatch.setattr(
        isolatedLibraryApp,
        "reset_application_tables",
        lambda *_args: events.append("database.reset"),
    )
    monkeypatch.setattr(
        isolatedLibraryApp.shutil,
        "rmtree",
        lambda *_args, **_kwargs: events.append("temp.cleanup"),
    )

    isolatedLibraryApp.main()

    if reuse_state:
        restored_user_cover_path = Path(
            str(provider_specs[1].get("user_owned_cover_path") or "")
        )
        assert restored_user_cover_path == persisted_user_cover_path
        assert restored_user_cover_path.is_file()
        assert hashlib.sha256(restored_user_cover_path.read_bytes()).hexdigest() == (
            persisted_user_cover_sha256
        )
        storage_policy_specs = [
            spec
            for spec in provider_specs
            if spec.get("cover_id") == "provider-storage-policy-cover"
        ]
        assert len(storage_policy_specs) == 1
        assert Path(str(storage_policy_specs[0]["staged_path"])) == (
            provider_storage_policy_path
        )
        assert provider_storage_policy_path.is_file()
        assert events == [
            "covers.reuse",
            "lock.acquire",
            "provider.create",
            "provider.start",
            "server.run",
            "provider.stop",
            "lock.release",
        ]
    else:
        assert events == [
            "covers.stage",
            "inventory.build",
            "tracks.materialize",
            "lock.acquire",
            "database.prepare",
            "database.persist",
            "provider-candidates.persist",
            "rating-track.materialize",
            "lastfm.timezone.seed",
            "provider.create",
            "provider.start",
            "server.run",
            "provider.stop",
            "lock.release",
        ]


def test_real_cover_pool_reuses_staged_metadata_without_copying_sources(
    tmp_path: Path,
    monkeypatch,
):
    source_dir = tmp_path / "sources"
    source_dir.mkdir()
    first_source = source_dir / "first-wide.jpg"
    second_source = source_dir / "second-wide.jpg"
    first_source.write_bytes(b"first source bytes")
    second_source.write_bytes(b"second source bytes")
    manifest_covers = [
        {
            "assetId": "approved-cover-01",
            "extension": ".jpg",
            "sha256": "1" * 64,
            "artist": "First Artist",
            "album": "First Album",
            "year": 2001,
            "width": 1000,
            "height": 700,
        },
        {
            "assetId": "approved-cover-02",
            "extension": ".jpg",
            "sha256": "2" * 64,
            "artist": "Second Artist",
            "album": "Second Album",
            "year": 2002,
            "width": 1200,
            "height": 600,
        },
    ]
    source_paths = {"1" * 64: first_source, "2" * 64: second_source}
    monkeypatch.setattr(
        isolatedLibraryApp,
        "load_real_cover_manifest",
        lambda: {"covers": manifest_covers},
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "resolve_manifest_cover_path",
        lambda cover: source_paths[str(cover["sha256"])],
    )
    library_root = tmp_path / "library"
    fixture_config = {"approvedCoverPoolSize": len(manifest_covers)}

    staged_specs = isolatedLibraryApp.stage_real_cover_pool(fixture_config, library_root)
    staged_bytes = {
        Path(str(spec["staged_path"])): Path(str(spec["staged_path"])).read_bytes()
        for spec in staged_specs
    }

    def reject_copy(*_args, **_kwargs):
        raise AssertionError("restart reuse must not copy committed cover sources")

    monkeypatch.setattr(isolatedLibraryApp.shutil, "copy2", reject_copy)

    reused_specs = isolatedLibraryApp.stage_real_cover_pool(
        fixture_config,
        library_root,
        reuse_existing=True,
    )

    assert reused_specs == staged_specs
    assert {
        path: path.read_bytes()
        for path in staged_bytes
    } == staged_bytes


def test_materialized_album_art_is_independent_and_restart_reuse_preserves_promoted_cover(
    tmp_path: Path,
):
    staged_cover = tmp_path / "staged" / "cover.jpg"
    staged_other_art = tmp_path / "staged" / "other-art.jpg"
    staged_cover.parent.mkdir(parents=True)
    original_cover_bytes = b"shared staged cover bytes"
    original_other_art_bytes = b"shared staged other-art bytes"
    promoted_cover_bytes = b"album-specific promoted cover bytes"
    staged_cover.write_bytes(original_cover_bytes)
    staged_other_art.write_bytes(original_other_art_bytes)
    cover_spec = {
        "staged_path": str(staged_cover),
        "other_art_staged_path": str(staged_other_art),
    }
    first_album = tmp_path / "library" / "Artist One" / "Album One"
    sibling_album = tmp_path / "library" / "Artist Two" / "Album Two"

    first_cover, first_other_art = isolatedLibraryApp.materialize_album_art(
        first_album,
        cover_spec,
    )
    sibling_cover, sibling_other_art = isolatedLibraryApp.materialize_album_art(
        sibling_album,
        cover_spec,
    )
    first_cover.write_bytes(promoted_cover_bytes)

    assert staged_cover.read_bytes() == original_cover_bytes
    assert sibling_cover.read_bytes() == original_cover_bytes
    assert staged_other_art.read_bytes() == original_other_art_bytes
    assert first_other_art.read_bytes() == original_other_art_bytes
    assert sibling_other_art.read_bytes() == original_other_art_bytes

    rematerialized_cover, rematerialized_other_art = isolatedLibraryApp.materialize_album_art(
        first_album,
        cover_spec,
    )

    assert rematerialized_cover == first_cover
    assert rematerialized_cover.read_bytes() == promoted_cover_bytes
    assert rematerialized_other_art == first_other_art


def test_isolated_fixture_generation_builds_40_artists_400_albums_and_7200_tracks(tmp_path, monkeypatch):
    cover_path = tmp_path / "fixture-cover.jpg"
    cover_path.write_bytes(b"cover")
    front_cover_path = tmp_path / "fixture-front-cover.jpg"
    front_cover_path.write_bytes(b"front-cover")
    disc_cover_path = tmp_path / "fixture-disc-cover.jpg"
    disc_cover_path.write_bytes(b"disc-cover")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"other-art")
    cover_specs = [
        {
            "cover_id": "fixture",
            "staged_path": str(front_cover_path),
            "other_art_staged_path": str(cover_path),
            "artist": "Mastodon",
            "album": "Crack The Skye",
            "year": 2009,
        },
        {
            "cover_id": "first-display-fixture",
            "staged_path": str(disc_cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": "A Perfect Circle",
            "album": "Thirteenth Step",
            "year": 2003,
        },
    ]
    monkeypatch.setattr(
        isolatedLibraryApp,
        "ensure_playable_loop_source",
        lambda path: path.parent.mkdir(parents=True, exist_ok=True) or path.write_bytes(b"loop"),
    )

    file_cache, loop_source, artist_count, album_count = isolatedLibraryApp.build_file_cache(
        isolatedLibraryApp.load_fixture_config(),
        tmp_path / "media",
        cover_specs,
    )

    assert artist_count == 40
    assert album_count == 400
    assert len(file_cache) == 7200
    assert loop_source.read_bytes() == b"loop"
    assert len({entry["album_artist"] for entry in file_cache.values()}) == 40
    assert len({(entry["album_artist"], entry["album"]) for entry in file_cache.values()}) == 400
    benchmark_fixture_entries = {
        (
            entry["album_artist"],
            entry["album"],
            Path(path).name,
        ): entry
        for path, entry in file_cache.items()
        if (
            entry["album_artist"],
            entry["album"],
        )
        in {
            (
                isolatedLibraryApp.RARITY_FIXTURE_ARTIST,
                isolatedLibraryApp.TRACK_ORDER_FIXTURE_ALBUM,
            ),
            (
                isolatedLibraryApp.PROBLEMATIC_TRACK_ARTIST,
                isolatedLibraryApp.PROBLEMATIC_TRACK_ALBUM,
            ),
            (
                isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST,
                isolatedLibraryApp.PROBLEMATIC_ENCODING_ALBUM,
            ),
        }
    }
    assert {
        (artist, album)
        for artist, album, _filename in benchmark_fixture_entries
    } == {
        (
            isolatedLibraryApp.RARITY_FIXTURE_ARTIST,
            isolatedLibraryApp.TRACK_ORDER_FIXTURE_ALBUM,
        ),
        (
            isolatedLibraryApp.PROBLEMATIC_TRACK_ARTIST,
            isolatedLibraryApp.PROBLEMATIC_TRACK_ALBUM,
        ),
        (
            isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST,
            isolatedLibraryApp.PROBLEMATIC_ENCODING_ALBUM,
        ),
    }
    assert {
        entry["track_number"]
        for (artist, album, _filename), entry in benchmark_fixture_entries.items()
        if (
            artist,
            album,
        )
        == (
            isolatedLibraryApp.RARITY_FIXTURE_ARTIST,
            isolatedLibraryApp.TRACK_ORDER_FIXTURE_ALBUM,
        )
    } == {None}
    assert any(
        entry["track_number"] is None
        for (artist, album, _filename), entry in benchmark_fixture_entries.items()
        if (
            artist,
            album,
        )
        == (
            isolatedLibraryApp.PROBLEMATIC_TRACK_ARTIST,
            isolatedLibraryApp.PROBLEMATIC_TRACK_ALBUM,
        )
    )
    problematic_track_entries = [
        entry
        for (artist, album, _filename), entry in benchmark_fixture_entries.items()
        if (artist, album)
        == (
            isolatedLibraryApp.PROBLEMATIC_TRACK_ARTIST,
            isolatedLibraryApp.PROBLEMATIC_TRACK_ALBUM,
        )
    ]
    assert problematic_track_entries
    assert {entry["cover_path"] for entry in problematic_track_entries} == {None}
    assert {entry["cover_revision"] for entry in problematic_track_entries} == {None}
    encoding_entries = [
        entry
        for (artist, album, _filename), entry in benchmark_fixture_entries.items()
        if (
            artist,
            album,
        )
        == (
            isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST,
            isolatedLibraryApp.PROBLEMATIC_ENCODING_ALBUM,
        )
    ]
    assert encoding_entries
    assert any(
        entry["title"] == isolatedLibraryApp.PROBLEMATIC_ENCODING_TRACK_TITLE
        for entry in encoding_entries
    )
    assert {entry["track_number"] for entry in encoding_entries} == {None}
    assert {entry["cover_path"] for entry in encoding_entries} == {None}
    assert {entry["year"] for entry in encoding_entries} == {None}
    numeric_multidisc_entries = [
        entry
        for entry in file_cache.values()
        if (
            entry["album_artist"] == isolatedLibraryApp.TRACK_CREDIT_ALBUM_ARTIST
            and entry["album"]
            == isolatedLibraryApp.BONUS_DURATION_NUMERIC_MULTIDISC_ALBUM
        )
    ]
    untagged_numeric_multidisc_entries = sorted(
        (entry for entry in numeric_multidisc_entries if entry["disc_number"] is None),
        key=lambda entry: Path(str(entry["path"])).name,
    )
    disc_two_numeric_multidisc_entries = sorted(
        (entry for entry in numeric_multidisc_entries if entry["disc_number"] == 2),
        key=lambda entry: Path(str(entry["path"])).name,
    )
    assert [
        int(entry["track_number"]) for entry in untagged_numeric_multidisc_entries
    ] == [1, 2, 3]
    assert {
        entry["disc_number_raw"] for entry in untagged_numeric_multidisc_entries
    } == {None}
    assert [
        int(entry["track_number"]) for entry in disc_two_numeric_multidisc_entries
    ] == list(range(1, 16))
    assert {
        entry["disc_number_raw"] for entry in disc_two_numeric_multidisc_entries
    } == {"2"}
    auto_number_entries = {
        Path(path).name: entry
        for path, entry in file_cache.items()
        if (
            entry["album_artist"] == isolatedLibraryApp.TAG_RENAME_FIXTURE_ARTIST
            and entry["album"] == isolatedLibraryApp.TAG_AUTO_NUMBER_FIXTURE_ALBUM
        )
    }
    assert len(auto_number_entries) == 18
    assert set(auto_number_entries) == {
        str(track["filename"])
        for track in isolatedLibraryApp.TAG_AUTO_NUMBER_FIXTURE_TRACKS
    }
    assert {
        int(entry["track_number"])
        for entry in auto_number_entries.values()
    } == set(range(1, 19))
    ddt_albums = {
        entry["album"]
        for entry in file_cache.values()
        if entry["album_artist"] == isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ARTIST
    }
    assert len(ddt_albums) == 60
    assert isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ALBUM in ddt_albums
    assert "Ремиксы" in ddt_albums
    ddt_gallery_names = [
        album_name for _year, album_name in isolatedLibraryApp.DDT_GALLERY_ALBUMS
    ]
    assert (2000, "Ремиксы") in isolatedLibraryApp.DDT_GALLERY_ALBUMS
    assert ddt_gallery_names.index(
        isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ALBUM
    ) == ddt_gallery_names.index("Публикация") + 1
    studio_records_entries = sorted(
        (
            entry
            for entry in file_cache.values()
            if (
                entry["album_artist"] == isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ARTIST
                and entry["album"] == isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ALBUM
            )
        ),
        key=lambda entry: int(entry["track_number"]),
    )
    assert len(studio_records_entries) == 16
    assert all(entry["edition"] is None for entry in studio_records_entries)
    assert {entry["cover_path"] for entry in studio_records_entries} == {None}
    assert {entry["cover_revision"] for entry in studio_records_entries} == {None}
    assert {
        int(entry["track_number"]): entry["year"]
        for entry in studio_records_entries
    } == {
        **{track_number: 1990 for track_number in range(1, 5)},
        **{track_number: 1999 for track_number in range(5, 9)},
        9: None,
        10: None,
        11: None,
        **{track_number: 1999 for track_number in range(12, 16)},
        16: None,
    }
    remixes_entries = sorted(
        (
            entry
            for entry in file_cache.values()
            if (
                entry["album_artist"] == isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ARTIST
                and entry["album"] == "Ремиксы"
            )
        ),
        key=lambda entry: int(entry["track_number"]),
    )
    assert [entry["title"] for entry in remixes_entries] == [
        "Фонограммщик",
        "Террорист",
        "Конвейер",
        "Храм",
        "Российское Танго",
        "В последнюю осень",
        "Mилиционер в рок-клубе",
        "Революция",
        "Мальчик слепой",
        "Это всё",
    ]
    assert {
        entry["album"]
        for entry in (
            *studio_records_entries,
            *remixes_entries,
        )
    } == {
        isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ALBUM,
        "Ремиксы",
    }
    assert all(
        entry["album_artist"] == isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ARTIST
        for entry in (
            *studio_records_entries,
            *remixes_entries,
        )
    )
    assert sum(
        1
        for entry in file_cache.values()
        if (
            entry["album_artist"] == isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ARTIST
            and entry["album"] in {
                isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ALBUM,
                "Ремиксы",
            }
        )
    ) == 26
    track_credit_entries = sorted(
        (
            entry
            for entry in file_cache.values()
            if entry["album_artist"] == isolatedLibraryApp.TRACK_CREDIT_ALBUM_ARTIST
            and entry["album"] == isolatedLibraryApp.TRACK_CREDIT_ALBUM
        ),
        key=lambda entry: int(entry["track_number"]),
    )
    assert [
        (entry["title"], entry["artist"])
        for entry in track_credit_entries[:4]
    ] == [
        ("Clean Signal (feat. Featured Voice)", "Solo Voice"),
        ("Bright Signal featured Guest Two", "Ensemble Two"),
        ("Deep Signal featuring Guest Three", "Ensemble Three"),
        ("Open Signal feature Guest Four", "Ensemble Four"),
    ]
    ordinary_track_credit_entries = sorted(
        (
            entry
            for entry in file_cache.values()
            if entry["album_artist"] == isolatedLibraryApp.ORDINARY_TRACK_CREDIT_ARTIST
            and entry["album"] == isolatedLibraryApp.ORDINARY_TRACK_CREDIT_ALBUM
        ),
        key=lambda entry: int(entry["track_number"]),
    )
    assert (
        ordinary_track_credit_entries[0]["title"],
        ordinary_track_credit_entries[0]["artist"],
    ) == (
        isolatedLibraryApp.ORDINARY_TRACK_CREDIT_TITLE,
        isolatedLibraryApp.ORDINARY_TRACK_CREDIT_ARTIST,
    )
    compilation_entries = sorted(
        (
            entry
            for entry in file_cache.values()
            if entry["album"] == isolatedLibraryApp.COMPILATION_FAMILY_ALBUM
        ),
        key=lambda entry: int(entry["track_number"]),
    )
    control_entries = sorted(
        (
            entry
            for entry in file_cache.values()
            if entry["album"] == isolatedLibraryApp.CONTROL_FAMILY_ALBUM
        ),
        key=lambda entry: int(entry["track_number"]),
    )
    assert len(compilation_entries) == 18
    assert len(control_entries) == 18
    assert {
        entry["album_artist"]
        for entry in compilation_entries
    } == {isolatedLibraryApp.COMPILATION_FAMILY_SOURCE_ARTIST}
    assert {
        entry["album_artist"]
        for entry in control_entries
    } == {isolatedLibraryApp.CONTROL_FAMILY_SOURCE_ARTIST}
    assert {
        entry["artist"]
        for entry in compilation_entries
    } == set(isolatedLibraryApp.COMPILATION_FAMILY_MEMBERS)
    assert {
        entry["artist"]
        for entry in control_entries
    } == set(isolatedLibraryApp.CONTROL_FAMILY_MEMBERS)
    assert {
        Path(str(entry["path"])).parent.name
        for entry in control_entries
    } == {"Disc 1", "Disc 2"}
    control_owner = " / ".join(isolatedLibraryApp.CONTROL_FAMILY_MEMBERS)
    relation_root = tmp_path / "media"
    control_relation_views = relation_projection_postgres.build_relation_views_from_postgres_rows(
        {"MUSIC_DIR": relation_root},
        [
            {
                "album_id": 1,
                "owner_artist_id": 1,
                "owner_artist_name": control_owner,
                "album_artist": control_owner,
                "album_is_compilation": False,
                "member_artist_id": (
                    isolatedLibraryApp.CONTROL_FAMILY_MEMBERS.index(entry["artist"]) + 2
                ),
                "member_artist_name": entry["artist"],
                "featured_kind": "featured_member",
                "track_file_id": index,
                "library_root_id": "isolated-main-root",
                "root_path": str(relation_root),
                "relative_path": str(
                    Path(str(entry["path"])).relative_to(relation_root)
                ),
                "private_path": entry["path"],
            }
            for index, entry in enumerate(control_entries, start=1)
        ],
    )
    assert set(control_relation_views["folder_related"][isolatedLibraryApp.CONTROL_FAMILY_MEMBERS[0]]) == {
        isolatedLibraryApp.CONTROL_FAMILY_MEMBERS[1],
    }
    assert set(control_relation_views["folder_related"][isolatedLibraryApp.CONTROL_FAMILY_MEMBERS[1]]) == {
        isolatedLibraryApp.CONTROL_FAMILY_MEMBERS[0],
    }
    assert control_relation_views["alias_to_canonical"][control_owner] == (
        isolatedLibraryApp.CONTROL_FAMILY_MEMBERS[0]
    )
    for member_artist, solo_album in isolatedLibraryApp.ARTIST_FAMILY_SOLO_ALBUMS.items():
        solo_entries = [
            entry
            for entry in file_cache.values()
            if entry["album_artist"] == member_artist
            and entry["album"] == solo_album
        ]
        assert len(solo_entries) == 18
        assert {entry["artist"] for entry in solo_entries} == {member_artist}

    built_albums = {
        album.name: album
        for album in build_albums_from_file_cache(file_cache)
    }
    compilation_album = built_albums[isolatedLibraryApp.COMPILATION_FAMILY_ALBUM]
    control_album = built_albums[isolatedLibraryApp.CONTROL_FAMILY_ALBUM]
    assert compilation_album.is_compilation is True
    assert compilation_album.album_artist == " / ".join(
        isolatedLibraryApp.COMPILATION_FAMILY_MEMBERS
    )
    assert compilation_album.album_artist != isolatedLibraryApp.TRACK_CREDIT_ALBUM_ARTIST
    assert set(compilation_album.artists) == set(
        isolatedLibraryApp.COMPILATION_FAMILY_MEMBERS
    )
    assert control_album.is_compilation is True
    assert control_album.album_artist == " / ".join(
        isolatedLibraryApp.CONTROL_FAMILY_MEMBERS
    )
    rating_fixture_albums = {
        str(entry["album"]): entry["album_rating"]
        for entry in file_cache.values()
        if entry["album_artist"] == isolatedLibraryApp.RATING_FIXTURE_ARTIST
    }
    assert {
        album: rating_fixture_albums[album]
        for _role, album, _tag_rating in isolatedLibraryApp.RATING_FIXTURES
    } == {
        album: tag_rating
        for _role, album, tag_rating in isolatedLibraryApp.RATING_FIXTURES
    }
    rarity_entries = sorted(
        (
            entry
            for entry in file_cache.values()
            if entry["album_artist"] == isolatedLibraryApp.RARITY_FIXTURE_ARTIST
            and entry["album"] == isolatedLibraryApp.RARITY_FIXTURE_ALBUM
        ),
        key=lambda entry: int(entry["track_number"]),
    )
    assert [
        (entry["title"], entry["track_number"], Path(str(entry["path"])).name)
        for entry in rarity_entries
    ] == [
        (
            track["title"],
            int(track.get("track_number") or generated_track_number),
            track["filename"],
        )
        for generated_track_number, track in enumerate(
            isolatedLibraryApp.RARITY_FIXTURE_TRACKS,
            start=1,
        )
    ]
    assert all(entry["exception_type"] is None for entry in rarity_entries)
    assert all(
        entry["edition"] is None for entry in rarity_entries
    ), "the Postgres/file-cache identity must match the physical rarity tracks without TXXX edition tags"
    rename_entries = sorted(
        (
            entry
            for entry in file_cache.values()
            if entry["album_artist"] == isolatedLibraryApp.TAG_RENAME_FIXTURE_ARTIST
            and entry["album"] == isolatedLibraryApp.TAG_RENAME_FIXTURE_ALBUM
        ),
        key=lambda entry: int(entry["track_number"]),
    )
    assert [
        (entry["title"], entry["track_number"], Path(str(entry["path"])).name)
        for entry in rename_entries
    ] == [
        (track["title"], track_number, track["filename"])
        for track_number, track in enumerate(
            isolatedLibraryApp.TAG_RENAME_FIXTURE_TRACKS,
            start=1,
        )
    ]
    playback_start_entries = sorted(
        (
            entry
            for entry in file_cache.values()
            if entry["album_artist"] == isolatedLibraryApp.PLAYBACK_START_ARTIST
            and entry["album"] == isolatedLibraryApp.PLAYBACK_START_ALBUM
        ),
        key=lambda entry: int(entry["track_number"]),
    )
    assert [
        (
            entry["title"],
            entry["duration_seconds"],
            entry["duration_display"],
            Path(str(entry["path"])).name,
        )
        for entry in playback_start_entries
    ] == [
        (
            track["title"],
            track["duration_seconds"],
            isolatedLibraryApp._format_duration(int(track["duration_seconds"])),
            track["filename"],
        )
        for track in isolatedLibraryApp.PLAYBACK_START_TRACK_FIXTURES
    ]
    assert len({entry["path"] for entry in playback_start_entries}) == len(
        isolatedLibraryApp.PLAYBACK_START_TRACK_FIXTURES
    )
    measured_indices = [
        index
        for index, track in enumerate(isolatedLibraryApp.PLAYBACK_START_TRACK_FIXTURES)
        if str(track["role"]).startswith("measured-")
    ]
    assert all(
        right_index - left_index > 1
        for left_index, right_index in zip(measured_indices, measured_indices[1:])
    )
    balancing_entries = [
        entry
        for entry in file_cache.values()
        if entry["album_artist"] == isolatedLibraryApp.RARITY_FIXTURE_ARTIST
        and entry["album"] != isolatedLibraryApp.RARITY_FIXTURE_ALBUM
    ]
    balancing_album_counts = {}
    for entry in balancing_entries:
        balancing_album_counts.setdefault(str(entry["album"]), 0)
        balancing_album_counts[str(entry["album"])] += 1
    tracks_per_album = int(
        isolatedLibraryApp.load_fixture_config()["tracksPerAlbum"]
    )
    track_order_track_count = isolatedLibraryApp.TRACK_ORDER_FIXTURE_TRACK_COUNT
    track_order_fixture_deficit = tracks_per_album - track_order_track_count
    ddt_renderer_fixture_deficit = (
        tracks_per_album
        - len(isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_TRACKS)
        + tracks_per_album
        - len(isolatedLibraryApp.DDT_REMIXES_FIXTURE_TRACKS)
    )
    track_order_balance_count = (
        tracks_per_album
        + track_order_fixture_deficit
        + ddt_renderer_fixture_deficit
    )
    backdrop_fixture_count = len(isolatedLibraryApp.TAG_BACKDROP_FIXTURE_TRACKS)
    assert sorted(balancing_album_counts.values()) == (
        [track_order_track_count]
        + [tracks_per_album] * 7
        + [backdrop_fixture_count]
        + [track_order_balance_count]
    )
    albums = {}
    for entry in file_cache.values():
        album_key = (str(entry["album_artist"]), str(entry["album"]))
        cover_value = entry["cover_path"]
        albums[album_key] = Path(str(cover_value)) if cover_value else None
    missing_cover_albums = {
        album_key
        for album_key, album_cover_path in albums.items()
        if album_cover_path is None
    }
    local_albums = {
        album_key: album_cover_path
        for album_key, album_cover_path in albums.items()
        if album_cover_path is not None
    }

    generated_problem_albums = {
        (
            isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST,
            isolatedLibraryApp.PROBLEMATIC_ENCODING_ALBUM,
        ),
        (
            isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST,
            isolatedLibraryApp.PROBLEMATIC_MISSING_METADATA_ALBUM,
        ),
    }
    cover_lookup_empty_album_keys = {
        ("Mastodon", "Crack The Skye Fixture 07"),
        ("Mastodon", "Crack The Skye Fixture 08"),
    }
    expected_missing_cover_albums = {
        *generated_problem_albums,
        *cover_lookup_empty_album_keys,
        (
            isolatedLibraryApp.PROBLEMATIC_TRACK_ARTIST,
            isolatedLibraryApp.PROBLEMATIC_TRACK_ALBUM,
        ),
        (
            isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ARTIST,
            isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ALBUM,
        ),
    }
    assert missing_cover_albums == expected_missing_cover_albums
    assert {artist for artist, _album in missing_cover_albums} == {
        isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST,
        isolatedLibraryApp.PROBLEMATIC_TRACK_ARTIST,
        isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ARTIST,
        "Mastodon",
    }
    assert all(
        entry["cover_path"] is None
        and entry["track_number"] is None
        and entry["year"] is None
        and entry["release_date"] is None
        for entry in file_cache.values()
        if (str(entry["album_artist"]), str(entry["album"])) in generated_problem_albums
    )
    cover_lookup_empty_entries = [
        entry
        for entry in file_cache.values()
        if (str(entry["album_artist"]), str(entry["album"]))
        in cover_lookup_empty_album_keys
    ]
    assert cover_lookup_empty_entries
    assert all(
        entry["cover_path"] is None
        and entry["cover_revision"] is None
        and entry["local_cover_width"] is None
        and entry["local_cover_height"] is None
        for entry in cover_lookup_empty_entries
    )
    assert sum(
        1
        for entry in file_cache.values()
        if (str(entry["album_artist"]), str(entry["album"])) in missing_cover_albums
    ) == (
        4 * isolatedLibraryApp.load_fixture_config()["tracksPerAlbum"]
        + len(problematic_track_entries)
        + len(isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_TRACKS)
    )
    joseph_album_key = (
        isolatedLibraryApp.JOSEPH_ARTIST,
        isolatedLibraryApp.JOSEPH_ALBUM,
    )
    assert joseph_album_key in local_albums
    joseph_cover_path = local_albums.pop(joseph_album_key)
    assert joseph_cover_path is not None
    assert joseph_cover_path.is_file()
    [joseph_staged_source] = [
        path
        for path in (tmp_path / "media").rglob(isolatedLibraryApp.JOSEPH_COVER_FILENAME)
        if "_e2e_cover_pool" not in path.parts
    ]
    assert joseph_cover_path.read_bytes() == joseph_staged_source.read_bytes()
    from PIL import Image
    with Image.open(joseph_cover_path) as joseph_cover:
        assert joseph_cover.size == (1200, 1200)
        assert joseph_cover.format == "PNG"

    local_album_key = (
        str(file_cache[str(loop_source.resolve(strict=False))]["album_artist"]),
        str(file_cache[str(loop_source.resolve(strict=False))]["album"]),
    )
    local_cover_path = local_albums[local_album_key]
    assert local_album_key == (
        str(file_cache[str(loop_source.resolve(strict=False))]["album_artist"]),
        str(file_cache[str(loop_source.resolve(strict=False))]["album"]),
    )
    assert local_cover_path == loop_source.parent / "cover.jpg"
    assert local_cover_path.read_bytes() == b"disc-cover"
    assert (local_cover_path.parent / "booklet-other-art.jpg").read_bytes() == b"other-art"
    manifest_target_cover_path = local_albums[("Mastodon", "Crack The Skye")]
    assert manifest_target_cover_path is not None
    assert manifest_target_cover_path.name == "cover.jpg"
    assert manifest_target_cover_path.read_bytes() == b"front-cover"
    manifest_target_root = manifest_target_cover_path.parent
    nested_art_bytes = {
        "Front.jpg": (manifest_target_root / "Art" / "Front.jpg").read_bytes(),
        "Back.jpg": (manifest_target_root / "Art" / "Back.jpg").read_bytes(),
        "CD.JPG": (manifest_target_root / "Art" / "CD.JPG").read_bytes(),
    }
    assert nested_art_bytes == {
        "Front.jpg": b"cover",
        "Back.jpg": b"disc-cover",
        "CD.JPG": b"front-cover",
    }
    assert len(set(nested_art_bytes.values())) == 3
    assert nested_art_bytes["CD.JPG"] == manifest_target_cover_path.read_bytes()
    expected_cover_revisions = {
        cover_value: hashlib.sha256(Path(cover_value).read_bytes()).hexdigest()
        for cover_value in {
            str(entry["cover_path"])
            for entry in file_cache.values()
            if entry["cover_path"]
        }
    }
    assert all(
        entry["cover_revision"]
        == expected_cover_revisions[str(entry["cover_path"])]
        for entry in file_cache.values()
        if entry["cover_path"]
    )
    mastodon_entries = [
        entry
        for entry in file_cache.values()
        if entry["album_artist"] == "Mastodon"
        and entry["album"] == "Crack The Skye"
    ]
    manifest_target_revision = hashlib.sha256(
        manifest_target_cover_path.read_bytes()
    ).hexdigest()
    assert mastodon_entries
    assert {entry["cover_path"] for entry in mastodon_entries} == {
        str(manifest_target_cover_path)
    }
    assert {entry["cover_revision"] for entry in mastodon_entries} == {
        manifest_target_revision
    }
    materialized_covers = list((tmp_path / "media").rglob("cover.jpg"))
    ddt_studio_records_cover_path = (
        Path(str(studio_records_entries[0]["path"])).parent / "cover.jpg"
    )
    non_materialized_cover_albums = {
        joseph_album_key,
        *cover_lookup_empty_album_keys,
        (
            isolatedLibraryApp.PROBLEMATIC_TRACK_ARTIST,
            isolatedLibraryApp.PROBLEMATIC_TRACK_ALBUM,
        ),
        (
            isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ARTIST,
            isolatedLibraryApp.DDT_STUDIO_RECORDS_FIXTURE_ALBUM,
        ),
    }
    assert len(materialized_covers) == len(albums) - len(non_materialized_cover_albums)
    assert joseph_cover_path not in materialized_covers
    assert ddt_studio_records_cover_path not in materialized_covers
    assert local_cover_path in materialized_covers
    assert all(
        album_cover_path.name == "cover.jpg" and album_cover_path.is_file()
        for album_cover_path in materialized_covers
    )
    assert set((tmp_path / "media").rglob("booklet-other-art.jpg")) == {
        local_cover_path.parent / "booklet-other-art.jpg",
    }
    assert all(
        album_cover_path.read_bytes() in {b"cover", b"front-cover", b"disc-cover"}
        for album_key, album_cover_path in albums.items()
        if album_key != joseph_album_key and album_cover_path is not None
    )
    partial_lookup_cover_path = local_albums[("Mastodon", "Crack The Skye Fixture 02")]
    partial_lookup_cover_path.write_bytes(b"selected remote cover")
    assert cover_path.read_bytes() == b"cover"


def test_problematic_encoding_fixture_offers_two_independent_text_repairs(tmp_path, monkeypatch):
    from music_app.services.library_browse_postgres import (
        _problematic_encoding_repair_preview,
    )

    cover_path = tmp_path / "fixture-cover.jpg"
    cover_path.write_bytes(b"cover")
    other_cover_path = tmp_path / "fixture-other-cover.jpg"
    other_cover_path.write_bytes(b"other-cover")
    back_cover_path = tmp_path / "fixture-back-cover.jpg"
    back_cover_path.write_bytes(b"back-cover")
    cover_specs = [
        {
            "cover_id": "fixture",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(back_cover_path),
            "artist": "Mastodon",
            "album": "Crack The Skye",
            "year": 2009,
        },
        {
            "cover_id": "first-display-fixture",
            "staged_path": str(other_cover_path),
            "other_art_staged_path": str(cover_path),
            "artist": "A Perfect Circle",
            "album": "Thirteenth Step",
            "year": 2003,
        },
    ]
    monkeypatch.setattr(
        isolatedLibraryApp,
        "ensure_playable_loop_source",
        lambda path: path.parent.mkdir(parents=True, exist_ok=True) or path.write_bytes(b"loop"),
    )
    file_cache, _loop_source, _artist_count, _album_count = (
        isolatedLibraryApp.build_file_cache(
            isolatedLibraryApp.load_fixture_config(),
            tmp_path / "media",
            cover_specs,
        )
    )
    selected_track = next(
        entry
        for entry in file_cache.values()
        if entry["album_artist"] == isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST
        and entry["album"] == isolatedLibraryApp.PROBLEMATIC_ENCODING_ALBUM
        and entry["title"] == isolatedLibraryApp.PROBLEMATIC_ENCODING_TRACK_TITLE
    )

    preview = _problematic_encoding_repair_preview(
        {"_file_entries": [selected_track], "_ignored_repair_keys": set()},
        include_preview_rows=True,
    )

    assert preview["has_repairs"] is True
    assert {
        row["field"]: row["repaired"] for row in preview["preview_rows"]
    } == {
        "artist": "Track Artist Signal",
        "title": "Broken Encoding Signal",
    }
    assert len({row["row_key"] for row in preview["preview_rows"]}) == 2

def test_isolated_fixture_leaves_relation_projection_for_normal_startup_rebuild():
    source = LAUNCHER_PATH.read_text(encoding="utf-8")
    persist_source = source.split("def persist_fixture_inventory(", 1)[1].split(
        "def _normalize_provider_query", 1
    )[0]

    assert "PostgresScanCacheAdapter(setup_config).save_snapshot" in persist_source
    assert "relation_views=" not in persist_source
    assert "ensure_relation_projection_ready" not in persist_source


def test_isolated_fixture_postgres_inventory_is_current_and_needs_no_metadata_repair(
    tmp_path,
    monkeypatch,
):
    from config import PERSISTENCE_BACKEND_POSTGRES
    from music_app.services import library_hydration, scan_cache_persistence
    from music_app.services.library_hydration import hydrate_library_state_from_disk
    from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION

    cover_path = tmp_path / "fixture-cover.jpg"
    cover_path.write_bytes(b"front-cover")
    alternate_cover_path = tmp_path / "fixture-alternate-cover.jpg"
    alternate_cover_path.write_bytes(b"alternate-cover")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"back-cover")
    monkeypatch.setattr(
        isolatedLibraryApp,
        "ensure_playable_loop_source",
        lambda path: path.parent.mkdir(parents=True, exist_ok=True)
        or path.write_bytes(b"loop"),
    )
    file_cache, _loop_source, artist_count, album_count = (
        isolatedLibraryApp.build_file_cache(
            isolatedLibraryApp.load_fixture_config(),
            tmp_path / "media",
            [
                {
                    "cover_id": "fixture",
                    "staged_path": str(cover_path),
                    "other_art_staged_path": str(other_art_path),
                    "artist": "Mastodon",
                    "album": "Crack The Skye",
                    "year": 2009,
                },
                {
                    "cover_id": "fixture-alternate",
                    "staged_path": str(alternate_cover_path),
                    "other_art_staged_path": str(other_art_path),
                    "artist": "A Perfect Circle",
                    "album": "Thirteenth Step",
                    "year": 2003,
                },
            ],
        )
    )

    assert (artist_count, album_count, len(file_cache)) == (40, 400, 7200)
    assert {
        entry.get("metadata_schema_version")
        for entry in file_cache.values()
    } == {FILE_METADATA_SCHEMA_VERSION}
    assert all(
        entry["album"] != isolatedLibraryApp.RATING_SCAN_DISCOVERY_ALBUM
        for entry in file_cache.values()
    )

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    albums = build_albums_from_file_cache(file_cache)
    *_inventory_rows, track_file_rows = (
        scan_cache_persistence._inventory_rows_from_albums(file_cache, albums)
    )
    persisted_file_cache = {
        str(row["private_path"]): row["metadata"]["scan_cache"]["file_entry"]
        for row in track_file_rows
    }
    assert len(persisted_file_cache) == 7200
    assert {
        entry.get("metadata_schema_version")
        for entry in persisted_file_cache.values()
    } == {FILE_METADATA_SCHEMA_VERSION}

    class PersistedFixtureAdapter:
        backend = PERSISTENCE_BACKEND_POSTGRES

        def load_snapshot(self, _cache_path, _root_identity):
            return persisted_file_cache, 123.0, {}, 0.0, None

    monkeypatch.setattr(
        library_hydration,
        "library_root_cache_identity",
        lambda _config: "isolated-root-identity",
    )
    monkeypatch.setattr(
        library_hydration,
        "load_separate_release_keys",
        lambda _config: set(),
    )
    monkeypatch.setattr(
        library_hydration,
        "select_runtime_persistence_adapter",
        lambda _seam_id, _config: SimpleNamespace(
            effective_backend=PERSISTENCE_BACKEND_POSTGRES
        ),
    )
    library_state = {"albums": []}

    hydrated = hydrate_library_state_from_disk(
        library_state,
        {
            "CACHE_PATH": tmp_path / "inert-library-cache.json",
            "IMAGE_EXTENSIONS": {".jpg"},
        },
        ensure_relations=False,
        validate_cache=False,
        scan_cache_adapter=PersistedFixtureAdapter(),
    )

    assert hydrated is True
    assert library_state["scan_metadata_repair_required"] is False
    assert len(library_state["file_cache"]) == 7200
    assert len(library_state["albums"]) == 400


def test_artist_family_fixture_separates_owner_and_members_and_overrides_control_false(
    monkeypatch,
):
    recorded_calls = []
    rows = [
        (
            isolatedLibraryApp.COMPILATION_FAMILY_ALBUM,
            " / ".join(isolatedLibraryApp.COMPILATION_FAMILY_MEMBERS),
            True,
            [" / ".join(isolatedLibraryApp.COMPILATION_FAMILY_MEMBERS)],
            sorted(isolatedLibraryApp.COMPILATION_FAMILY_MEMBERS),
        ),
        (
            isolatedLibraryApp.CONTROL_FAMILY_ALBUM,
            " / ".join(isolatedLibraryApp.CONTROL_FAMILY_MEMBERS),
            False,
            [" / ".join(isolatedLibraryApp.CONTROL_FAMILY_MEMBERS)],
            sorted(isolatedLibraryApp.CONTROL_FAMILY_MEMBERS),
        ),
        (
            isolatedLibraryApp.SOUNDTRACK_FAMILY_ALBUM,
            " / ".join(isolatedLibraryApp.SOUNDTRACK_FAMILY_MEMBERS),
            False,
            [" / ".join(isolatedLibraryApp.SOUNDTRACK_FAMILY_MEMBERS)],
            sorted(isolatedLibraryApp.SOUNDTRACK_FAMILY_MEMBERS),
        ),
    ]

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, _exc_type, _exc, _traceback):
            return False

        def execute(self, sql, params):
            normalized_sql = " ".join(str(sql).split()).lower()
            recorded_calls.append((normalized_sql, params))
            if normalized_sql.startswith("update library.local_albums"):
                return SimpleNamespace(rowcount=1)
            if normalized_sql.startswith("update library.local_album_featured_artists"):
                return SimpleNamespace(rowcount=2)
            return SimpleNamespace(fetchall=lambda: rows)

    monkeypatch.setitem(
        sys.modules,
        "psycopg",
        SimpleNamespace(connect=lambda database_url: FakeConnection()),
    )

    isolatedLibraryApp.persist_fixture_artist_family_compilation_contract(
        "postgresql://album_haven_migrator@localhost/album_haven_fake_e2e"
    )

    assert [call[1] for call in recorded_calls[:3]] == [
        (True, isolatedLibraryApp.COMPILATION_FAMILY_ALBUM),
        (False, isolatedLibraryApp.CONTROL_FAMILY_ALBUM),
        (False, isolatedLibraryApp.SOUNDTRACK_FAMILY_ALBUM),
    ]
    verification_sql = recorded_calls[-1][0]
    assert "from library.local_albums" in verification_sql
    assert "join library.local_album_featured_artists" in verification_sql
    assert "join library.local_artists" in verification_sql
    assert "featured_kind = 'owner'" in verification_sql
    assert "featured_kind <> 'owner'" in verification_sql


def test_joseph_cover_fixture_requires_hash_verified_private_bytes(tmp_path, monkeypatch):
    from PIL import Image

    source_path = tmp_path / "private-player-artwork.png"
    Image.new("RGB", (1200, 1200), color=(28, 64, 96)).save(source_path, format="PNG")
    monkeypatch.setattr(
        isolatedLibraryApp,
        "resolve_approved_cover_by_sha256",
        lambda expected_hash: source_path,
    )
    monkeypatch.setattr(
        isolatedLibraryApp,
        "JOSEPH_COVER_SHA256",
        hashlib.sha256(source_path.read_bytes()).hexdigest(),
    )
    staged = isolatedLibraryApp.stage_joseph_cover(tmp_path)
    staged_path = Path(str(staged["staged_path"]))

    assert staged_path.read_bytes() == source_path.read_bytes()
    assert (staged["width"], staged["height"]) == (1200, 1200)
    assert staged_path.name == "synthetic-player-artwork.png"


def test_isolated_fixture_seeds_alias_parity_rows_and_nested_family_paths(tmp_path, monkeypatch):
    cover_path = tmp_path / "fixture-cover.jpg"
    cover_path.write_bytes(b"front-cover")
    disc_cover_path = tmp_path / "fixture-disc-cover.jpg"
    disc_cover_path.write_bytes(b"disc-cover")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"back-cover")
    monkeypatch.setattr(
        isolatedLibraryApp,
        "ensure_playable_loop_source",
        lambda path: path.parent.mkdir(parents=True, exist_ok=True) or path.write_bytes(b"loop"),
    )
    file_cache, _loop_source, _artist_count, _album_count = isolatedLibraryApp.build_file_cache(
        isolatedLibraryApp.load_fixture_config(),
        tmp_path / "media",
        [
            {
                "cover_id": "fixture",
                "staged_path": str(cover_path),
                "other_art_staged_path": str(other_art_path),
                "artist": "",
                "album": "",
            },
            {
                "cover_id": "fixture-disc",
                "staged_path": str(disc_cover_path),
                "other_art_staged_path": str(other_art_path),
                "artist": "",
                "album": "",
            },
        ],
    )

    joseph_cover_paths = {
        Path(str(entry["cover_path"]))
        for entry in file_cache.values()
        if entry["album_artist"] == isolatedLibraryApp.JOSEPH_ARTIST
        and entry["album"] == isolatedLibraryApp.JOSEPH_ALBUM
    }
    assert {path.name for path in joseph_cover_paths} == {
        isolatedLibraryApp.JOSEPH_COVER_FILENAME
    }
    assert all(path.parent.name == "Joseph - Part One - The Dreamer" for path in joseph_cover_paths)

    seeded_album_entries = {
        (str(entry["album_artist"]), str(entry["album"])): entry
        for entry in file_cache.values()
        if str(entry["album"]) in {
            album
            for album, _year in isolatedLibraryApp.ALIAS_PARITY_ARTIST_FIXTURES.values()
        }
    }
    assert set(seeded_album_entries) == {
        (artist, album)
        for artist, (album, _year) in isolatedLibraryApp.ALIAS_PARITY_ARTIST_FIXTURES.items()
        if artist != isolatedLibraryApp.SNOW_WHITE_RAW_ARTIST
    } | {
        (
            isolatedLibraryApp.SNOW_WHITE_DISPLAY_ARTIST,
            isolatedLibraryApp.SNOW_WHITE_ALBUM,
        )
    }
    for artist, (album, year) in isolatedLibraryApp.ALIAS_PARITY_ARTIST_FIXTURES.items():
        if artist == isolatedLibraryApp.SNOW_WHITE_RAW_ARTIST:
            snow_white_entries = [
                candidate
                for candidate in file_cache.values()
                if candidate["album"] == album
            ]
            assert snow_white_entries
            assert all(candidate["edition"] is None for candidate in snow_white_entries)
            assert {
                str(candidate["artist"]) for candidate in snow_white_entries
            } == set(isolatedLibraryApp.SNOW_WHITE_TRACK_ARTISTS)
            assert {
                str(candidate["album_artist"]) for candidate in snow_white_entries
            } == {isolatedLibraryApp.SNOW_WHITE_DISPLAY_ARTIST}
            assert {
                (str(candidate["album"]), candidate["year"])
                for candidate in snow_white_entries
            } == {(album, year)}
            continue
        entry = seeded_album_entries[(artist, album)]
        assert entry["album_artist"] == artist
        assert entry["artist"] == artist
        assert entry["year"] == year
        assert {
            (str(candidate["album"]), candidate["year"])
            for candidate in file_cache.values()
            if candidate["album_artist"] == artist
        } == {(album, year)}
    morse_album_scope = {
        (str(entry["album_artist"]), str(entry["album"]), entry["year"])
        for entry in file_cache.values()
        if str(entry["album_artist"]) in isolatedLibraryApp.MORSE_ALIAS_FIXTURES
    }
    assert morse_album_scope == {
        (artist, album, year)
        for artist, (album, year) in isolatedLibraryApp.MORSE_ALIAS_FIXTURES.items()
    }
    for artist in (
        *isolatedLibraryApp.MORSE_ALIAS_FIXTURES,
        isolatedLibraryApp.JOSEPH_ARTIST,
    ):
        artist_paths = {
            Path(str(entry["path"]))
            for entry in file_cache.values()
            if entry["album_artist"] == artist
        }
        assert artist_paths
        assert all(
            path.relative_to(tmp_path / "media").parts[:2]
            == ("Progressive Projects", "Morse Family")
            for path in artist_paths
        )

    from music_app.services.library_inventory_postgres import local_inventory_identity_key

    whitespace_display_artist = "Signal  Family Lead"
    assert local_inventory_identity_key(whitespace_display_artist) == "signal family lead"
    whitespace_paths = {
        artist: {
            Path(str(entry["path"]))
            for entry in file_cache.values()
            if entry["album_artist"] == artist
        }
        for artist in isolatedLibraryApp.WHITESPACE_FAMILY_FIXTURES
    }
    assert all(whitespace_paths.values())
    assert all(
        path.relative_to(tmp_path / "media").parts[:2]
        == ("Progressive Projects", "Whitespace Family")
        for artist_paths in whitespace_paths.values()
        for path in artist_paths
    )

    soundtrack_root = ("Soundtracks", "Shared Film")
    shared_soundtrack_paths = {
        Path(str(entry["path"]))
        for entry in file_cache.values()
        if entry["album"] == isolatedLibraryApp.SOUNDTRACK_FAMILY_ALBUM
    }
    soundtrack_solo_paths = {
        str(entry["album"]): Path(str(entry["path"]))
        for entry in file_cache.values()
        if entry["album"]
        in {
            isolatedLibraryApp.ARTIST_FAMILY_SOLO_ALBUMS[artist]
            for artist in isolatedLibraryApp.SOUNDTRACK_FAMILY_MEMBERS
        }
    }
    assert shared_soundtrack_paths
    assert all(
        path.relative_to(tmp_path / "media").parts[:2] == soundtrack_root
        for path in shared_soundtrack_paths
    )
    assert set(soundtrack_solo_paths) == {
        isolatedLibraryApp.ARTIST_FAMILY_SOLO_ALBUMS[artist]
        for artist in isolatedLibraryApp.SOUNDTRACK_FAMILY_MEMBERS
    }
    assert all(
        path.relative_to(tmp_path / "media").parts[:2] != soundtrack_root
        for path in soundtrack_solo_paths.values()
    )

    from music_app.services.relation_projection_postgres import (
        build_relation_views_from_postgres_rows,
    )

    relation_rows = []
    relation_root = tmp_path / "media"
    for album_id, artist in enumerate(
        isolatedLibraryApp.WHITESPACE_FAMILY_FIXTURES,
        start=1,
    ):
        track_path = min(whitespace_paths[artist], key=str)
        relation_rows.append({
            "album_id": album_id,
            "album_artist": artist,
            "owner_artist_name": artist,
            "member_artist_name": artist,
            "library_root_id": "isolated-main-root",
            "root_path": str(relation_root),
            "relative_path": str(track_path.relative_to(relation_root)),
            "private_path": str(track_path),
        })
    relation_views = build_relation_views_from_postgres_rows(
        {"MUSIC_DIR": relation_root},
        relation_rows,
    )
    assert relation_views["folder_related"][whitespace_display_artist] == {
        "Signal Family Relative"
    }


def test_isolated_fixture_copies_playback_album_bytes_and_other_production_paths(tmp_path):
    library_root = tmp_path / "media"
    loop_source = library_root / "Artist" / "Album" / "01 - Loop.mp3"
    preloaded_track = library_root / "Artist" / "Album" / "02 - Track 2.mp3"
    player_artwork_tracks = [
        (
            library_root
            / isolatedLibraryApp.JOSEPH_ARTIST
            / isolatedLibraryApp.JOSEPH_ALBUM.replace(":", " -")
            / f"{track_number:02d} - Track {track_number}.mp3"
        )
        for track_number in (1, 2)
    ]
    track_credit_player_track = (
        library_root
        / isolatedLibraryApp.TRACK_CREDIT_ALBUM_ARTIST
        / isolatedLibraryApp.TRACK_CREDIT_ALBUM
        / "01 - Credit Signal 1.mp3"
    )
    placeholder = library_root / "Other Artist" / "Other Album" / "01 - Track 1.mp3"
    loop_source.parent.mkdir(parents=True)
    loop_source.write_bytes(b"playable-loop")
    file_cache = {
        str(loop_source): {"path": str(loop_source), "mtime": 0.0, "size": 0},
        str(preloaded_track): {"path": str(preloaded_track), "mtime": 0.0, "size": 0},
        **{
            str(player_artwork_track): {
                "path": str(player_artwork_track),
                "mtime": 0.0,
                "size": 0,
                "album_artist": isolatedLibraryApp.JOSEPH_ARTIST,
                "album": isolatedLibraryApp.JOSEPH_ALBUM,
                "track_number": track_number,
            }
            for track_number, player_artwork_track in enumerate(player_artwork_tracks, start=1)
        },
        str(track_credit_player_track): {
            "path": str(track_credit_player_track),
            "mtime": 0.0,
            "size": 0,
            "album_artist": isolatedLibraryApp.TRACK_CREDIT_ALBUM_ARTIST,
            "album": isolatedLibraryApp.TRACK_CREDIT_ALBUM,
            "track_number": 1,
        },
        str(placeholder): {"path": str(placeholder), "mtime": 0.0, "size": 0},
    }

    isolatedLibraryApp.materialize_fixture_track_files(file_cache, loop_source)

    assert loop_source.read_bytes() == b"playable-loop"
    assert preloaded_track.read_bytes() == b"playable-loop"
    assert all(
        player_artwork_track.read_bytes() == b"playable-loop"
        for player_artwork_track in player_artwork_tracks
    )
    assert track_credit_player_track.read_bytes() == b"playable-loop"
    assert placeholder.is_file()
    assert placeholder.stat().st_size == 0
    for track_path, metadata in file_cache.items():
        stat = Path(track_path).stat()
        assert metadata["mtime"] == stat.st_mtime
        assert metadata["size"] == stat.st_size


def test_fixture_materialization_creates_each_track_parent_once_without_prechecking_new_files(
    tmp_path,
    monkeypatch,
):
    library_root = tmp_path / "media"
    loop_source = library_root / "Playback Artist" / "Playback Album" / "01 - Loop.mp3"
    loop_source.parent.mkdir(parents=True)
    loop_source.write_bytes(b"playable-loop")
    track_paths = (
        library_root / "Artist One" / "Album One" / "01 - Track 1.mp3",
        library_root / "Artist One" / "Album One" / "02 - Track 2.mp3",
        library_root / "Artist Two" / "Album Two" / "01 - Track 1.mp3",
    )
    preexisting_track = (
        library_root / "Artist One" / "Album One" / "00 - Existing Track.mp3"
    )
    preexisting_track.parent.mkdir(parents=True)
    preexisting_track.write_bytes(b"existing-track")
    file_cache = {
        str(loop_source): {"path": str(loop_source), "mtime": 0.0, "size": 0},
        str(preexisting_track): {
            "path": str(preexisting_track),
            "mtime": 0.0,
            "size": 0,
        },
        **{
            str(track_path): {"path": str(track_path), "mtime": 0.0, "size": 0}
            for track_path in track_paths
        },
    }
    expected_parents = {track_path.parent.resolve(strict=False) for track_path in track_paths}
    mkdir_calls = []
    is_file_calls = []
    original_mkdir = Path.mkdir
    original_is_file = Path.is_file

    def recording_mkdir(path, *args, **kwargs):
        resolved_path = path.resolve(strict=False)
        if resolved_path in expected_parents and kwargs.get("parents") is True:
            mkdir_calls.append(resolved_path)
        return original_mkdir(path, *args, **kwargs)

    def recording_is_file(path):
        resolved_path = path.resolve(strict=False)
        if resolved_path in {track_path.resolve(strict=False) for track_path in track_paths}:
            is_file_calls.append(resolved_path)
        return original_is_file(path)

    monkeypatch.setattr(Path, "mkdir", recording_mkdir)
    monkeypatch.setattr(Path, "is_file", recording_is_file)

    isolatedLibraryApp.materialize_fixture_track_files(file_cache, loop_source)

    assert {parent: mkdir_calls.count(parent) for parent in expected_parents} == {
        parent: 1 for parent in expected_parents
    }
    assert is_file_calls == []
    assert all(track_path.is_file() for track_path in track_paths)
    assert preexisting_track.read_bytes() == b"existing-track"
    assert file_cache[str(preexisting_track)]["size"] == len(b"existing-track")


def test_fixture_path_normalization_skips_resolve_for_absolute_paths(tmp_path, monkeypatch):
    absolute_path = tmp_path / "media" / "track.mp3"
    relative_path = Path("relative-fixture-track.mp3")
    original_resolve = Path.resolve
    resolve_calls = []

    def recording_resolve(path, *args, **kwargs):
        resolve_calls.append(path)
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", recording_resolve)

    assert isolatedLibraryApp._absolute_fixture_path(absolute_path) == absolute_path
    resolved_relative = isolatedLibraryApp._absolute_fixture_path(relative_path)

    assert resolve_calls == [relative_path]
    assert resolved_relative.is_absolute()


def test_cover_revision_cache_hashes_each_staged_source_once(tmp_path, monkeypatch):
    source = tmp_path / "staged-cover.jpg"
    source.write_bytes(b"staged-cover-bytes")
    original_read_bytes = Path.read_bytes
    source_reads = []

    def recording_read_bytes(path):
        if path == source:
            source_reads.append(path)
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", recording_read_bytes)
    revisions_by_source = {}
    expected = hashlib.sha256(b"staged-cover-bytes").hexdigest()

    assert isolatedLibraryApp._cached_cover_revision(source, revisions_by_source) == expected
    assert isolatedLibraryApp._cached_cover_revision(source, revisions_by_source) == expected
    assert source_reads == [source]


def test_problematic_encoding_fixture_materializes_playable_scan_readable_id3(tmp_path):
    from mutagen.id3 import ID3
    from mutagen.mp3 import MP3

    from music_app.services.metadata import read_metadata_for_file

    library_root = tmp_path / "media"
    loop_source = library_root / "Playback Artist" / "Playback Album" / "01 - Loop.mp3"
    encoding_track = (
        library_root
        / isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST
        / isolatedLibraryApp.PROBLEMATIC_ENCODING_ALBUM
        / "01 - Track 1.mp3"
    )
    isolatedLibraryApp.ensure_playable_loop_source(loop_source)
    file_cache = {
        str(loop_source): {"path": str(loop_source), "mtime": 0.0, "size": 0},
        str(encoding_track): {
            "path": str(encoding_track),
            "mtime": 0.0,
            "size": 0,
            "album_artist": isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST,
            "album": isolatedLibraryApp.PROBLEMATIC_ENCODING_ALBUM,
            "artist": isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST,
            "title": isolatedLibraryApp.PROBLEMATIC_ENCODING_TRACK_TITLE,
            "track_number": None,
            "year": None,
            "release_date": None,
        },
    }

    isolatedLibraryApp.materialize_fixture_track_files(file_cache, loop_source)

    decoded = decode_sample_probe(encoding_track)
    assert decoded["frame_count"] == 256
    assert decoded["peak"] > 0.001
    assert MP3(encoding_track).info.length > 0
    tags = ID3(encoding_track)
    assert str(tags["TPE1"]) == isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST
    assert str(tags["TPE2"]) == isolatedLibraryApp.PROBLEMATIC_METADATA_ARTIST
    assert str(tags["TALB"]) == isolatedLibraryApp.PROBLEMATIC_ENCODING_ALBUM
    assert str(tags["TIT2"]) == isolatedLibraryApp.PROBLEMATIC_ENCODING_TRACK_TITLE
    assert "TRCK" not in tags
    assert "TDRC" not in tags
    scanned = read_metadata_for_file(encoding_track)
    assert scanned["title"] == isolatedLibraryApp.PROBLEMATIC_ENCODING_TRACK_TITLE
    assert scanned["track_number"] is None
    assert scanned["year"] is None


def test_cover_lookup_fixture_track_materializes_scan_readable_seed_metadata(tmp_path):
    from music_app.services.metadata import read_metadata_for_file

    library_root = tmp_path / "media"
    loop_source = library_root / "Playback Artist" / "Playback Album" / "01 - Loop.mp3"
    cover_lookup_track = (
        library_root / "Mastodon" / "Crack The Skye" / "01 - Track 1.mp3"
    )
    isolatedLibraryApp.ensure_playable_loop_source(loop_source)
    file_cache = {
        str(loop_source): {"path": str(loop_source), "mtime": 0.0, "size": 0},
        str(cover_lookup_track): {
            "path": str(cover_lookup_track),
            "mtime": 0.0,
            "size": 0,
            "album_artist": "Mastodon",
            "album": "Crack The Skye",
            "artist": "Mastodon",
            "title": "Crack The Skye Track 1",
            "track_number": 1,
            "disc_number": 1,
            "year": 2009,
            "release_date": "2009-01-01",
            "edition": "Fixture Edition",
        },
    }

    isolatedLibraryApp.materialize_fixture_track_files(file_cache, loop_source)

    scanned = read_metadata_for_file(cover_lookup_track)
    assert {
        "album_artist": scanned["album_artist"],
        "album": scanned["album"],
        "artist": scanned["artist"],
        "title": scanned["title"],
        "track_number": scanned["track_number"],
        "disc_number": scanned["disc_number"],
        "year": scanned["year"],
        "release_date": scanned["release_date"],
        "edition": scanned["edition"],
    } == {
        "album_artist": "Mastodon",
        "album": "Crack The Skye",
        "artist": "Mastodon",
        "title": "Crack The Skye Track 1",
        "track_number": 1,
        "disc_number": 1,
        "year": 2009,
        "release_date": "2009-01-01",
        "edition": "Fixture Edition",
    }


def test_isolated_ffmpeg_helper_hides_its_windows_process(tmp_path, monkeypatch):
    recorded = {}

    def fake_run(command, **kwargs):
        recorded["command"] = command
        recorded["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(isolatedLibraryApp, "_resolve_ffmpeg_executable", lambda: "ffmpeg-test")
    monkeypatch.setattr(isolatedLibraryApp.subprocess, "run", fake_run)

    isolatedLibraryApp.ensure_playable_loop_source(tmp_path / "loop.mp3")

    assert recorded["command"][0] == "ffmpeg-test"
    assert recorded["kwargs"]["creationflags"] == isolatedLibraryApp._NO_WINDOW_CREATION_FLAGS
    assert recorded["kwargs"]["capture_output"] is True
    assert recorded["kwargs"]["check"] is False


def test_playable_loop_source_builds_distinct_stereo_mp3_without_visible_windows(
    tmp_path,
    monkeypatch,
):
    recorded = {}

    def fake_run(command, **kwargs):
        recorded["command"] = command
        recorded["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(isolatedLibraryApp, "_resolve_ffmpeg_executable", lambda: "ffmpeg-test")
    monkeypatch.setattr(isolatedLibraryApp.subprocess, "run", fake_run)

    destination = tmp_path / "loop.mp3"
    isolatedLibraryApp.ensure_playable_loop_source(destination)

    command = recorded["command"]
    input_indexes = [index for index, argument in enumerate(command) if argument == "-i"]
    input_sources = [command[index + 1] for index in input_indexes]
    assert len(input_sources) == 2
    assert all(source.startswith("anoisesrc=") for source in input_sources)
    assert input_sources[0] != input_sources[1]
    assert all("duration=14" in source for source in input_sources)
    assert all("sample_rate=44100" in source for source in input_sources)
    assert all("seed=" in source for source in input_sources)
    assert command[command.index("-filter_complex") + 1] == (
        "[0:a][1:a]amerge=inputs=2[stereo]"
    )
    assert command[command.index("-map") + 1] == "[stereo]"
    assert command[command.index("-ac") + 1] == "2"
    assert command[command.index("-codec:a") + 1] == "libmp3lame"
    assert command[command.index("-q:a") + 1] == "4"
    assert command[-1] == str(destination)
    assert recorded["kwargs"]["creationflags"] == isolatedLibraryApp._NO_WINDOW_CREATION_FLAGS
    assert recorded["kwargs"]["capture_output"] is True
    assert recorded["kwargs"]["check"] is False


def test_rarity_fixture_audio_builds_contained_four_second_sine_mp3_command(
    tmp_path,
    monkeypatch,
):
    library_root = tmp_path / "media"
    destination = (
        library_root
        / isolatedLibraryApp.RARITY_FIXTURE_ARTIST
        / isolatedLibraryApp.RARITY_FIXTURE_ALBUM
        / isolatedLibraryApp.RARITY_FIXTURE_TRACKS[0]["filename"]
    )
    recorded = {}

    def fake_run(command, **kwargs):
        recorded["command"] = command
        recorded["kwargs"] = kwargs
        Path(command[-1]).write_bytes(b"generated-mp3")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(isolatedLibraryApp, "_resolve_ffmpeg_executable", lambda: "ffmpeg-test")
    monkeypatch.setattr(isolatedLibraryApp.subprocess, "run", fake_run)

    result = isolatedLibraryApp.generate_rarity_fixture_audio(
        library_root,
        destination,
        frequency_hz=440,
    )

    assert result == destination.resolve(strict=False)
    assert recorded["command"] == [
        "ffmpeg-test",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4:sample_rate=44100",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "4",
        str(destination.resolve(strict=False)),
    ]
    assert recorded["kwargs"]["creationflags"] == isolatedLibraryApp._NO_WINDOW_CREATION_FLAGS
    assert recorded["kwargs"]["capture_output"] is True
    assert recorded["kwargs"]["check"] is False


def test_rarity_fixture_audio_rejects_an_escaping_destination_before_creation(tmp_path):
    library_root = tmp_path / "media"
    escaping_destination = tmp_path / "owner-music" / "escaped.mp3"

    with pytest.raises(RuntimeError, match="escaped isolated library root"):
        isolatedLibraryApp.generate_rarity_fixture_audio(
            library_root,
            escaping_destination,
            frequency_hz=440,
        )

    assert not escaping_destination.exists()


@pytest.mark.parametrize("duration_seconds", [300, 15, 60])
def test_playback_start_audio_builds_contained_fixed_bitrate_mp3_command(
    duration_seconds,
    tmp_path,
    monkeypatch,
):
    library_root = tmp_path / "media"
    destination = (
        library_root
        / isolatedLibraryApp.PLAYBACK_START_ARTIST
        / isolatedLibraryApp.PLAYBACK_START_ALBUM
        / f"{duration_seconds} seconds.mp3"
    )
    recorded = {}

    def fake_run(command, **kwargs):
        recorded["command"] = command
        recorded["kwargs"] = kwargs
        Path(command[-1]).write_bytes(b"generated-fixed-bitrate-mp3")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(isolatedLibraryApp, "_resolve_ffmpeg_executable", lambda: "ffmpeg-test")
    monkeypatch.setattr(isolatedLibraryApp.subprocess, "run", fake_run)

    result = isolatedLibraryApp.generate_playback_start_fixture_audio(
        library_root,
        destination,
        duration_seconds=duration_seconds,
        frequency_hz=330,
    )

    assert result == destination.resolve(strict=False)
    assert recorded["command"] == [
        "ffmpeg-test",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=330:duration={duration_seconds}:sample_rate=44100",
        "-ac",
        "2",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        f"{isolatedLibraryApp.PLAYBACK_START_BITRATE_KBPS}k",
        "-write_xing",
        "0",
        str(destination.resolve(strict=False)),
    ]
    assert recorded["kwargs"]["creationflags"] == isolatedLibraryApp._NO_WINDOW_CREATION_FLAGS
    assert recorded["kwargs"]["capture_output"] is True
    assert recorded["kwargs"]["check"] is False


def test_playback_start_inventory_rejects_a_tracks_per_album_mismatch_before_writing(tmp_path):
    config = dict(isolatedLibraryApp.load_fixture_config())
    config["tracksPerAlbum"] = len(isolatedLibraryApp.PLAYBACK_START_TRACK_FIXTURES) - 1

    with pytest.raises(
        RuntimeError,
        match=r"playback-start fixture requires tracksPerAlbum=18, received 17",
    ):
        isolatedLibraryApp.build_file_cache(
            config,
            tmp_path / "media",
            [{"staged_path": str(tmp_path / "unused-cover.jpg")}],
        )

    assert not (tmp_path / "media").exists()


def test_gapless_fixture_persists_integer_cache_durations_without_rounding_manifest(tmp_path):
    template_path = tmp_path / "template.flac"
    template_path.write_bytes(b"template")
    file_cache = {
        str(template_path.resolve(strict=False)): {
            "path": str(template_path.resolve(strict=False)),
            "mtime": template_path.stat().st_mtime,
            "size": template_path.stat().st_size,
        }
    }
    tracks = []
    for fixture in isolatedLibraryApp.GAPLESS_PLAYBACK_TRACK_FIXTURES:
        track_path = tmp_path / str(fixture["filename"])
        track_path.write_bytes(b"gapless")
        tracks.append(
            {
                "kind": fixture["kind"],
                "title": fixture["title"],
                "path": str(track_path.resolve(strict=False)),
                "durationSeconds": float(fixture["duration_seconds"]),
                "sampleRate": 48_000,
            }
        )
    manifest = {"tracks": tracks}

    isolatedLibraryApp.register_gapless_playback_fixture(file_cache, manifest)

    for track in tracks:
        persisted_duration = file_cache[str(track["path"])]["duration_seconds"]
        assert type(persisted_duration) is int
        assert persisted_duration == int(track["durationSeconds"])
    very_short = next(track for track in tracks if track["kind"] == "very-short")
    assert very_short["durationSeconds"] == 0.08
    long_track = next(track for track in tracks if track["kind"] == "long")
    assert long_track["durationSeconds"] == 360.0
    encoded_chain = [track for track in tracks if str(track["kind"]).startswith("encoded-chain-")]
    assert [track["kind"] for track in encoded_chain] == [
        "encoded-chain-a",
        "encoded-chain-b",
        "encoded-chain-c",
    ]
    assert [Path(track["path"]).suffix.lower() for track in encoded_chain] == [".mp3"] * 3
    assert [track["durationSeconds"] for track in encoded_chain] == [6.0, 6.0, 6.0]


def test_gapless_fixture_registration_accepts_empty_cache_and_builds_complete_metadata(
    tmp_path,
):
    track_path = tmp_path / "01 - Empty Seed Signal.flac"
    track_path.write_bytes(b"gapless-fixture")
    track = {
        "kind": "boundary-outgoing",
        "title": "Empty Seed Signal",
        "path": str(track_path.resolve(strict=False)),
        "durationSeconds": 2.0,
        "sampleRate": 48_000,
        "expectedBoundarySamples": {"left": [0.25], "right": [0.25]},
    }
    file_cache = {}

    isolatedLibraryApp.register_gapless_playback_fixture(
        file_cache,
        {"tracks": [track]},
    )

    metadata = file_cache[str(track_path.resolve(strict=False))]
    expected = {
        "path": str(track_path.resolve(strict=False)),
        "mtime": track_path.stat().st_mtime,
        "size": len(b"gapless-fixture"),
        "album": isolatedLibraryApp.GAPLESS_PLAYBACK_ALBUM,
        "album_artist": isolatedLibraryApp.GAPLESS_PLAYBACK_ARTIST,
        "artist": isolatedLibraryApp.GAPLESS_PLAYBACK_ARTIST,
        "title": "Empty Seed Signal",
        "track_number": 1,
        "disc_number": 1,
        "disc_number_raw": "1",
        "duration_seconds": 2,
        "duration_display": "0:02",
        "cover_path": None,
        "cover_revision": None,
        "comment": "gapless-fixture kind=boundary-outgoing",
        "gapless_fixture": {
            "kind": "boundary-outgoing",
            "expected_boundary_samples": {"left": [0.25], "right": [0.25]},
            "sample_rate": 48_000,
        },
    }
    assert {key: metadata[key] for key in expected} == expected


def test_track_credit_current_and_automatic_continuity_materialize_from_playable_source(
    tmp_path,
):
    from mutagen.mp3 import MP3

    library_root = tmp_path / "media"
    loop_source = library_root / "Playback Artist" / "Playback Album" / "01 - Loop.mp3"
    isolatedLibraryApp.ensure_playable_loop_source(loop_source)
    track_paths = [
        library_root
        / isolatedLibraryApp.TRACK_CREDIT_ALBUM_ARTIST
        / isolatedLibraryApp.TRACK_CREDIT_ALBUM
        / f"{track_number:02d} - Credit Signal {track_number}.mp3"
        for track_number in (1, 2)
    ]
    ordinary_track = (
        library_root / "Ordinary Artist" / "Ordinary Album" / "01 - Ordinary.mp3"
    )
    file_cache = {
        str(loop_source): {"path": str(loop_source), "mtime": 0.0, "size": 0},
        **{
            str(track_path): {
                "path": str(track_path),
                "mtime": 0.0,
                "size": 0,
                "album_artist": isolatedLibraryApp.TRACK_CREDIT_ALBUM_ARTIST,
                "album": isolatedLibraryApp.TRACK_CREDIT_ALBUM,
                "track_number": track_number,
            }
            for track_number, track_path in enumerate(track_paths, start=1)
        },
        str(ordinary_track): {
            "path": str(ordinary_track),
            "mtime": 0.0,
            "size": 0,
            "album_artist": "Ordinary Artist",
            "album": "Ordinary Album",
            "track_number": 1,
        },
    }

    isolatedLibraryApp.materialize_fixture_track_files(file_cache, loop_source)

    source_probe = decode_sample_probe(loop_source)
    current_probe = decode_sample_probe(track_paths[0])
    continuity_probe = decode_sample_probe(track_paths[1])
    assert current_probe["samples"] == pytest.approx(source_probe["samples"], abs=1e-7)
    assert continuity_probe["samples"] == pytest.approx(source_probe["samples"], abs=1e-7)
    assert current_probe["peak"] == pytest.approx(source_probe["peak"], abs=1e-7)
    assert continuity_probe["peak"] == pytest.approx(source_probe["peak"], abs=1e-7)
    assert len(track_paths) >= 2
    assert track_paths[0].read_bytes() == loop_source.read_bytes()
    assert track_paths[1].read_bytes() == loop_source.read_bytes()
    assert all(MP3(track_path).info.length > 0 for track_path in track_paths[:2])
    assert all(
        file_cache[str(track_path)]["size"] == loop_source.stat().st_size
        for track_path in track_paths
    )
    assert ordinary_track.is_file()
    assert ordinary_track.stat().st_size == 0


def test_playback_start_audio_rejects_an_escaping_destination_before_creation(tmp_path):
    library_root = tmp_path / "media"
    escaping_destination = tmp_path / "owner-music" / "escaped.mp3"

    with pytest.raises(RuntimeError, match="escaped isolated library root"):
        isolatedLibraryApp.generate_playback_start_fixture_audio(
            library_root,
            escaping_destination,
            duration_seconds=60,
            frequency_hz=330,
        )

    assert not escaping_destination.exists()


def test_playback_start_fixture_materializes_three_generated_sources_and_copied_medium_paths(
    tmp_path,
    monkeypatch,
):
    library_root = tmp_path / "media"
    album_dir = (
        library_root
        / isolatedLibraryApp.PLAYBACK_START_ARTIST
        / isolatedLibraryApp.PLAYBACK_START_ALBUM
    )
    file_cache = {
        str((album_dir / str(track["filename"])).resolve(strict=False)): {
            "path": str((album_dir / str(track["filename"])).resolve(strict=False)),
            "mtime": 0.0,
            "size": 0,
            "duration_seconds": int(track["duration_seconds"]),
        }
        for track in isolatedLibraryApp.PLAYBACK_START_TRACK_FIXTURES
    }
    generated_durations = []

    def generate(_library_root, destination, *, duration_seconds, frequency_hz):
        assert _library_root == library_root
        assert destination.resolve(strict=False).is_relative_to(library_root.resolve(strict=False))
        generated_durations.append(duration_seconds)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(f"fixed-{duration_seconds}-{frequency_hz}".encode("ascii"))
        return destination

    monkeypatch.setattr(
        isolatedLibraryApp,
        "generate_playback_start_fixture_audio",
        generate,
    )

    isolatedLibraryApp.materialize_playback_start_fixture_tracks(library_root, file_cache)

    assert generated_durations == [300, 60, 15]
    materialized_paths = [
        album_dir / str(track["filename"])
        for track in isolatedLibraryApp.PLAYBACK_START_TRACK_FIXTURES
    ]
    assert all(path.is_file() for path in materialized_paths)
    assert len({path.resolve(strict=False) for path in materialized_paths}) == len(materialized_paths)
    medium_bytes = {
        path.read_bytes()
        for path, track in zip(materialized_paths, isolatedLibraryApp.PLAYBACK_START_TRACK_FIXTURES)
        if int(track["duration_seconds"]) == 60
    }
    assert medium_bytes == {b"fixed-60-330"}
    for path in materialized_paths:
        metadata = file_cache[str(path.resolve(strict=False))]
        stat = path.stat()
        assert metadata["mtime"] == stat.st_mtime
        assert metadata["size"] == stat.st_size


def test_playback_start_fixture_is_materialized_before_inventory_persistence():
    source = LAUNCHER_PATH.read_text(encoding="utf-8")
    main_source = source.split("def main() -> None:", 1)[1]

    assert main_source.index("materialize_playback_start_fixture_tracks(") < main_source.index(
        "persist_fixture_inventory("
    )


def test_rarity_fixture_id3_tags_match_the_two_track_album_contract(tmp_path):
    from mutagen.id3 import ID3

    library_root = tmp_path / "media"
    track = isolatedLibraryApp.RARITY_FIXTURE_TRACKS[1]
    destination = (
        library_root
        / isolatedLibraryApp.RARITY_FIXTURE_ARTIST
        / isolatedLibraryApp.RARITY_FIXTURE_ALBUM
        / track["filename"]
    )
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"")

    isolatedLibraryApp.write_rarity_fixture_id3_tags(
        library_root,
        destination,
        title=str(track["title"]),
        track_number=2,
    )

    tags = ID3(destination)
    assert str(tags["TPE1"]) == isolatedLibraryApp.RARITY_FIXTURE_ARTIST
    assert str(tags["TPE2"]) == isolatedLibraryApp.RARITY_FIXTURE_ARTIST
    assert str(tags["TALB"]) == isolatedLibraryApp.RARITY_FIXTURE_ALBUM
    assert str(tags["TIT2"]) == track["title"]
    assert str(tags["TRCK"]) == "2/2"
    assert str(tags["TPOS"]) == "1/1"
    assert str(tags["TDRC"]) == str(isolatedLibraryApp.RARITY_FIXTURE_YEAR)
    assert tags.getall("TXXX") == []


def test_isolated_fixture_lastfm_target_survives_alias_fixture_reordering(tmp_path, monkeypatch):
    cover_specs = []
    for index, (artist, album, year) in enumerate(
        [("Mastodon", "Crack The Skye", 2009), ("Flaming Row", "The Pure Shine", 2019)]
    ):
        front_cover_path = tmp_path / f"front-cover-{index}.jpg"
        front_cover_path.write_bytes(f"front-cover-{index}".encode("ascii"))
        back_cover_path = tmp_path / f"back-cover-{index}.jpg"
        back_cover_path.write_bytes(f"back-cover-{index}".encode("ascii"))
        cover_specs.append({
            "cover_id": f"fixture-{index}",
            "staged_path": str(front_cover_path),
            "other_art_staged_path": str(back_cover_path),
            "artist": artist,
            "album": album,
            "year": year,
        })
    monkeypatch.setattr(
        isolatedLibraryApp,
        "ensure_playable_loop_source",
        lambda path: path.parent.mkdir(parents=True, exist_ok=True) or path.write_bytes(b"loop"),
    )

    file_cache, loop_source, _artist_count, _album_count = isolatedLibraryApp.build_file_cache(
        isolatedLibraryApp.load_fixture_config(),
        tmp_path / "media-a",
        cover_specs,
    )
    original_target = file_cache[str(loop_source.resolve(strict=False))]

    monkeypatch.setattr(
        isolatedLibraryApp,
        "ALIAS_PARITY_ARTIST_FIXTURES",
        dict(reversed(list(isolatedLibraryApp.ALIAS_PARITY_ARTIST_FIXTURES.items()))),
    )
    reordered_cache, reordered_loop_source, _artist_count, _album_count = (
        isolatedLibraryApp.build_file_cache(
            isolatedLibraryApp.load_fixture_config(),
            tmp_path / "media-b",
            cover_specs,
        )
    )
    reordered_target = reordered_cache[str(reordered_loop_source.resolve(strict=False))]

    expected_target = (
        isolatedLibraryApp.LASTFM_SCROBBLE_ARTIST,
        isolatedLibraryApp.LASTFM_SCROBBLE_ALBUM,
        isolatedLibraryApp.LASTFM_SCROBBLE_TRACK,
        isolatedLibraryApp.LASTFM_SCROBBLE_YEAR,
    )
    assert (
        original_target["album_artist"],
        original_target["album"],
        original_target["title"],
        original_target["year"],
    ) == expected_target
    assert (
        reordered_target["album_artist"],
        reordered_target["album"],
        reordered_target["title"],
        reordered_target["year"],
    ) == expected_target
    assert loop_source.name == "01 - Fake Loop Source.mp3"
    assert reordered_loop_source.name == "01 - Fake Loop Source.mp3"


def test_provider_fixture_serves_music_service_musicbrainz_and_cover_archive_shapes(tmp_path):
    cover_path = tmp_path / "fixture.jpg"
    cover_path.write_bytes(b"fixture-image")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"fixture-other-art-image")
    cover_spec = {
        "cover_id": "fixture",
        "staged_path": str(cover_path),
        "other_art_staged_path": str(other_art_path),
        "other_art_width": 800,
        "other_art_height": 1200,
        "artist": "Fixture Artist",
        "album": "Fixture Album",
        "year": 2024,
        "width": 1200,
        "height": 1200,
    }
    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        [cover_spec],
    )
    connection = None
    service.start()
    port = service._server.server_address[1]
    try:
        service._server.set_cover_lookup_mode("normal")
        assert service._server.itunes_search_delay_seconds == 0
        manual_urls = service.manual_urls("fixture")
        assert manual_urls == {
            "page": f"http://127.0.0.1:{port}/manual/fixture",
            "cover": f"http://127.0.0.1:{port}/manual/fixture/cover.jpg",
            "other_art": f"http://127.0.0.1:{port}/manual/fixture/other-art.jpg",
        }
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        connection.request("HEAD", "/covers/fixture.jpg")
        response = connection.getresponse()
        assert response.status == 200
        assert response.getheader("Content-Type") == "image/jpeg"
        assert response.read() == b""

        term = quote("Fixture Artist Fixture Album")
        connection.request("GET", f"/itunes/search?term={term}&entity=album&limit=20")
        response = connection.getresponse()
        assert response.status == 200
        apple_payload = json.loads(response.read())
        assert apple_payload["resultCount"] == 1
        assert apple_payload["results"][0]["artistName"] == "Fixture Artist"
        assert apple_payload["results"][0]["collectionName"] == "Fixture Album"
        assert apple_payload["results"][0]["artworkUrl100"].endswith(
            "/apple/artwork/fixture/100x100bb.jpg"
        )
        collection_url = apple_payload["results"][0]["collectionViewUrl"]
        artist_url = apple_payload["results"][0]["artistViewUrl"]

        service._server.set_cover_lookup_mode("failed")
        connection.request("GET", f"/itunes/search?term={term}&entity=album&limit=20")
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read()) == []
        service._server.set_cover_lookup_mode("normal")

        connection.request("GET", urlparse(collection_url).path)
        response = connection.getresponse()
        assert response.status == 200
        assert response.getheader("Content-Type") == "text/html; charset=utf-8"
        album_html = response.read().decode("utf-8")
        assert '<meta property="og:title" content="Fixture Album">' in album_html
        assert "Fixture Album by Fixture Artist on Apple Music" in album_html

        page_candidates = cover_provider_apple.collect_apple_page_candidates(
            collection_url,
            "Album Haven E2E test",
            "Fixture Album",
            http_get_text=lambda *_args, **_kwargs: album_html,
            extract_og_image=cover_provider_fallback_web.extract_og_image,
            album_name_in_alt=album_name_in_alt,
        )
        assert len(page_candidates) == 1
        assert page_candidates[0].endswith("/apple/artwork/fixture/9999x9999bb-100.jpg")
        connection.request("GET", urlparse(page_candidates[0]).path)
        response = connection.getresponse()
        assert response.status == 200
        assert response.getheader("Content-Type") == "image/jpeg"
        assert response.read() == b"fixture-image"

        connection.request("GET", urlparse(artist_url).path)
        response = connection.getresponse()
        assert response.status == 200
        artist_html = response.read().decode("utf-8")
        assert cover_provider_apple.extract_apple_album_urls(artist_html) == [collection_url]

        connection.request("GET", f"/itunes/search?term={quote('Fixture Artist')}&entity=musicArtist")
        response = connection.getresponse()
        assert response.status == 200
        artist_payload = json.loads(response.read())
        assert artist_payload["results"][0]["artistViewUrl"] == artist_url

        connection.request("GET", f"/musicbrainz/release/?query={term}&fmt=json&limit=20")
        response = connection.getresponse()
        assert response.status == 200
        musicbrainz_payload = json.loads(response.read())
        assert musicbrainz_payload["releases"] == [{
            "id": "fixture",
            "title": "Fixture Album",
            "date": "2024-01-01",
            "artist-credit": [{"name": "Fixture Artist"}],
        }]

        connection.request("GET", "/coverartarchive/release/fixture")
        response = connection.getresponse()
        assert response.status == 200
        archive_payload = json.loads(response.read())
        assert archive_payload["release"] == "fixture"
        assert len(archive_payload["images"]) == 2
        assert [image["front"] for image in archive_payload["images"]] == [True, False]
        assert archive_payload["images"][0]["front"] is True
        assert archive_payload["images"][0]["image"].endswith(
            "/coverartarchive/image/fixture.jpg"
        )
        assert archive_payload["images"][0]["width"] == 1200
        assert archive_payload["images"][1]["front"] is False
        assert archive_payload["images"][1]["types"] == ["Booklet"]
        assert archive_payload["images"][1]["image"] == (
            f"http://cover-fixture.example:{port}"
            "/manual/fixture/other-art.jpg?source=cover_art_archive"
        )
        assert archive_payload["images"][1]["width"] == 800

        discogs_term = quote("Fixture Artist Fixture Album")
        connection.request(
            "GET",
            f"/discogs/database/search?q={discogs_term}&type=release",
        )
        response = connection.getresponse()
        assert response.status == 200
        discogs_search_payload = json.loads(response.read())
        assert discogs_search_payload["pagination"]["items"] == 1
        discogs_result = discogs_search_payload["results"][0]
        assert discogs_result["title"] == "Fixture Artist - Fixture Album"
        assert discogs_result["type"] == "release"
        assert discogs_result["year"] == 2024
        discogs_release_path = urlparse(discogs_result["resource_url"]).path

        connection.request("GET", f"/discogs{discogs_release_path}")
        response = connection.getresponse()
        assert response.status == 200
        discogs_release_payload = json.loads(response.read())
        assert discogs_release_payload["artists_sort"] == "Fixture Artist"
        assert discogs_release_payload["title"] == "Fixture Album"
        assert len(discogs_release_payload["images"]) == 2
        assert [image["type"] for image in discogs_release_payload["images"]] == [
            "primary",
            "secondary",
        ]
        assert discogs_release_payload["images"][0]["type"] == "primary"
        assert discogs_release_payload["images"][0]["uri"].endswith(
            "/covers/fixture.jpg"
        )
        assert discogs_release_payload["images"][1] == {
            "type": "secondary",
            "uri": (
                f"http://cover-fixture.example:{port}"
                "/manual/fixture/other-art.jpg?source=discogs"
            ),
            "uri150": (
                f"http://cover-fixture.example:{port}"
                "/manual/fixture/other-art.jpg?source=discogs"
            ),
            "width": 800,
            "height": 1200,
        }
        manual_other_art = urlparse(manual_urls["other_art"])
        provider_other_art = [
            urlparse(archive_payload["images"][1]["image"]),
            urlparse(discogs_release_payload["images"][1]["uri"]),
        ]
        manual_other_art_identity = (manual_other_art.path, manual_other_art.query)
        provider_other_art_identities = {
            (image.path, image.query)
            for image in provider_other_art
        }
        assert manual_other_art_identity not in provider_other_art_identities
        assert len(provider_other_art_identities) == 2

        provider_evidence = service._server.snapshot_cover_lookup_evidence()
        assert provider_evidence["discogs_search_requests"] == 1
        assert provider_evidence["discogs_detail_requests"] == 1

        connection.request("GET", urlparse(manual_urls["page"]).path)
        response = connection.getresponse()
        assert response.status == 200
        manual_html = response.read().decode("utf-8")
        assert (
            f'<meta property="og:image" content="http://cover-fixture.example:{port}'
            '/manual/fixture/cover.jpg">'
        ) in manual_html

        connection.request("GET", urlparse(manual_urls["cover"]).path)
        response = connection.getresponse()
        assert response.status == 200
        assert response.read() == b"fixture-image"

        connection.request("GET", urlparse(manual_urls["other_art"]).path)
        response = connection.getresponse()
        assert response.status == 200
        assert response.read() == b"fixture-other-art-image"
    finally:
        if connection is not None:
            connection.close()
        service.stop()


def test_provider_fixture_defaults_to_no_results_until_provider_scenarios_opt_in(
    tmp_path,
):
    cover_path = tmp_path / "fixture.jpg"
    cover_path.write_bytes(b"fixture-image")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"fixture-other-art-image")
    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        [{
            "cover_id": "fixture-07",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 07",
            "year": 2009,
            "width": 1200,
            "height": 1200,
        }],
        itunes_search_delay_seconds=0,
    )
    connection = None
    service.start()
    port = service._server.server_address[1]
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        targets = (
            "Mastodon Crack The Skye Fixture 07",
            "Mastodon Crack The Skye Fixture 08",
            "Mastodon Crack The Skye Fixture 09",
        )

        assert service._server.get_cover_lookup_mode() == "no-results"
        for target in targets:
            connection.request(
                "GET",
                f"/itunes/search?term={quote(target)}&entity=album&limit=20",
            )
            response = connection.getresponse()
            assert response.status == 200
            assert json.loads(response.read())["resultCount"] == 0

        service._server.set_cover_lookup_mode("normal")
        for target in targets:
            connection.request(
                "GET",
                f"/itunes/search?term={quote(target)}&entity=album&limit=20",
            )
            response = connection.getresponse()
            assert response.status == 200
            assert json.loads(response.read())["resultCount"] == 1
    finally:
        if connection is not None:
            connection.close()
        service.stop()


def test_provider_fixture_mode_change_invalidates_the_scenario_cover_cache(tmp_path):
    cover_path = tmp_path / "fixture.jpg"
    cover_path.write_bytes(b"fixture-image")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"fixture-other-art-image")
    cover_cache_path = tmp_path / "app-data" / "inert-cover-cache.json"
    cover_cache_path.parent.mkdir(parents=True)
    cover_cache_path.write_text('{"stale": true}', encoding="utf-8")
    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        [{
            "cover_id": "fixture-07",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 07",
            "year": 2009,
            "width": 1200,
            "height": 1200,
        }],
        cover_cache_path=cover_cache_path,
    )

    service.start()
    try:
        service._server.set_cover_lookup_mode("automatic-scan")
        assert not cover_cache_path.exists()
    finally:
        service.stop()


def test_provider_fixture_automatic_coverless_mode_isolates_fixture08_from_fixture09(
    tmp_path,
):
    cover_path = tmp_path / "fixture.jpg"
    cover_path.write_bytes(b"fixture-image")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"fixture-other-art-image")
    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        [{
            "cover_id": "fixture-07",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 07",
            "year": 2009,
            "width": 1200,
            "height": 1200,
        }],
        itunes_search_delay_seconds=0,
    )
    connection = None
    service.start()
    port = service._server.server_address[1]
    try:
        service._server.set_cover_lookup_mode("automatic-coverless")
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)

        connection.request(
            "GET",
            "/itunes/search?"
            f"term={quote('Mastodon Crack The Skye Fixture 08')}"
            "&entity=album&limit=20",
        )
        fixture08_response = connection.getresponse()
        assert fixture08_response.status == 200
        fixture08_payload = json.loads(fixture08_response.read())
        assert fixture08_payload["resultCount"] == 1
        assert len(fixture08_payload["results"]) == 1
        assert fixture08_payload["results"][0]["collectionName"] == (
            "Crack The Skye Fixture 08"
        )
        assert "automatic-candidate-primary" in (
            fixture08_payload["results"][0]["artworkUrl100"]
        )

        connection.request(
            "GET",
            "/itunes/search?"
            f"term={quote('Mastodon Crack The Skye Fixture 09')}"
            "&entity=album&limit=20",
        )
        fixture09_response = connection.getresponse()
        assert fixture09_response.status == 200
        fixture09_payload = json.loads(fixture09_response.read())
        assert fixture09_payload["resultCount"] == 1
        assert len(fixture09_payload["results"]) == 1
        assert fixture09_payload["results"][0]["collectionName"] == (
            "Crack The Skye Fixture 09"
        )
        assert "automatic-coverless-neutral" in (
            fixture09_payload["results"][0]["artworkUrl100"]
        )
    finally:
        if connection is not None:
            connection.close()
        service.stop()


def test_provider_fixture_automatic_coverless_primes_fixture09_without_improving_its_user_cover(
    tmp_path,
):
    from PIL import Image

    cover_specs = []
    for index in range(2):
        cover_path = tmp_path / f"fixture-{index}.jpg"
        Image.new(
            "RGB",
            (800, 800),
            color=(32 + (index * 96), 64, 160 - (index * 64)),
        ).save(cover_path, format="JPEG", quality=95)
        other_art_path = tmp_path / f"fixture-{index}-other-art.jpg"
        other_art_path.write_bytes(f"other-art-{index}".encode("ascii"))
        cover_specs.append({
            "cover_id": f"fixture-{index}",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": f"Fixture Artist {index}",
            "album": f"Fixture Album {index}",
            "year": 2024,
            "width": 1200,
            "height": 1200,
        })

    user_owned_cover_path = isolatedLibraryApp.materialize_user_owned_cover(
        tmp_path / "user-owned-album",
        Path(str(cover_specs[1]["staged_path"])),
    )
    cover_specs[1]["user_owned_cover_path"] = str(user_owned_cover_path)
    with Image.open(user_owned_cover_path) as user_owned_image:
        assert user_owned_image.size == (640, 640)

    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        cover_specs,
        itunes_search_delay_seconds=0,
    )
    handler = object.__new__(isolatedLibraryApp._ProviderFixtureHandler)
    handler.server = service._server
    try:
        service._server.set_cover_lookup_mode("automatic-coverless")
        fixture08_specs = handler._matching_specs(
            "Mastodon Crack The Skye Fixture 08",
        )
        assert [spec["cover_id"] for spec in fixture08_specs] == [
            "automatic-candidate-primary",
        ]

        fixture09_specs = handler._matching_specs(
            "Mastodon Crack The Skye Fixture 09",
        )
        assert len(fixture09_specs) == 1
        assert fixture09_specs[0]["cover_id"] == "automatic-coverless-neutral"
        assert fixture09_specs[0]["candidate_fixture_mode"] == (
            "automatic-coverless-neutral"
        )
        assert fixture09_specs[0]["staged_path"] != str(user_owned_cover_path)
        with Image.open(fixture09_specs[0]["staged_path"]) as neutral_image:
            assert neutral_image.size == (600, 600)
        assert fixture09_specs[0]["original_source_sha256"] == hashlib.sha256(
            user_owned_cover_path.read_bytes()
        ).hexdigest()
        assert fixture09_specs[0]["width"] == 600
        assert fixture09_specs[0]["height"] == 600

        service._server.set_cover_lookup_mode("same-art-improvement")
        same_art_specs = handler._matching_specs(
            "Mastodon Crack The Skye Fixture 09",
        )
        assert [spec["cover_id"] for spec in same_art_specs] == [
            "user-owned-same-art-improvement",
        ]
        assert same_art_specs[0]["width"] == 3000
        assert same_art_specs[0]["height"] == 3000

        service._server.set_cover_lookup_mode("automatic-scan")
        automatic_improvement_specs = handler._matching_specs(
            "Mastodon Crack The Skye Fixture 09",
        )
        assert [spec["cover_id"] for spec in automatic_improvement_specs] == [
            "user-owned-improvement-primary",
        ]
        assert automatic_improvement_specs[0]["width"] > same_art_specs[0]["width"]
        assert automatic_improvement_specs[0]["height"] > same_art_specs[0]["height"]
    finally:
        service._server.server_close()


def test_provider_fixture_later_request_returns_candidates_before_terminal_mode_reset(
    tmp_path,
):
    cover_path = tmp_path / "fixture.jpg"
    cover_path.write_bytes(b"fixture-image")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"fixture-other-art-image")
    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        [{
            "cover_id": "fixture-07",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": "Mastodon",
            "album": "Crack The Skye Fixture 07",
            "year": 2009,
            "width": 1200,
            "height": 1200,
        }],
        itunes_search_delay_seconds=0,
    )
    service.start()
    port = service._server.server_address[1]
    request_result: dict[str, object] = {}

    def request_musicbrainz_candidates() -> None:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        try:
            query = quote('artist:"Mastodon" AND release:"Crack The Skye Fixture 07"')
            connection.request("GET", f"/musicbrainz/release/?query={query}")
            response = connection.getresponse()
            request_result["status"] = response.status
            request_result["payload"] = json.loads(response.read())
        except Exception as exc:  # pragma: no cover - asserted on the owner thread
            request_result["error"] = exc
        finally:
            connection.close()

    request_thread = threading.Thread(target=request_musicbrainz_candidates)
    try:
        service._server.set_cover_lookup_mode("normal")
        service._server.hold_cover_lookup_later_provider()
        request_thread.start()

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            evidence = service._server.snapshot_cover_lookup_evidence()
            if evidence["musicbrainz_started"] == 1:
                break
            time.sleep(0.01)
        else:
            pytest.fail("MusicBrainz fixture request never reached the held provider gate")

        service._server.release_cover_lookup_later_provider()
        request_thread.join(timeout=2)
        assert not request_thread.is_alive(), "released provider response did not complete"
        assert "error" not in request_result
        assert request_result["status"] == 200
        assert request_result["payload"] == {
            "count": 1,
            "releases": [{
                "id": "fixture-07",
                "title": "Crack The Skye Fixture 07",
                "date": "2009-01-01",
                "artist-credit": [{"name": "Mastodon"}],
            }],
        }

        service._server.set_cover_lookup_mode("no-results")
        assert service._server.get_cover_lookup_mode() == "no-results"
    finally:
        service._server.release_cover_lookup_later_provider()
        request_thread.join(timeout=2)
        service.stop()


def test_provider_fixture_control_sets_reports_validates_and_resets_apple_search_delay(
    tmp_path,
):
    cover_path = tmp_path / "fixture.jpg"
    cover_path.write_bytes(b"fixture-image")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"fixture-other-art-image")
    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        [{
            "cover_id": "fixture",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": "Fixture Artist",
            "album": "Fixture Album",
            "year": 2024,
            "width": 1200,
            "height": 1200,
        }],
        itunes_search_delay_seconds=0,
    )
    connection = None
    service.start()
    port = service._server.server_address[1]

    def post_control(delay_seconds):
        body = json.dumps({
            "action": "set-itunes-search-delay",
            "delay_seconds": delay_seconds,
        }).encode("utf-8")
        connection.request(
            "POST",
            "/cover-lookup-fixture/control",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        payload = response.read()
        return response.status, payload

    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        service._server.set_cover_lookup_mode("normal")
        status, payload = post_control(0.1)
        assert status == 200
        assert json.loads(payload)["itunes_search_delay_seconds"] == pytest.approx(0.1)

        term = quote("Fixture Artist Fixture Album")
        started = time.monotonic()
        connection.request("GET", f"/itunes/search?term={term}&entity=album&limit=20")
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read())["resultCount"] == 1
        delayed_elapsed = time.monotonic() - started
        assert delayed_elapsed >= 0.09

        status, _payload = post_control(-0.01)
        assert status == 400

        status, payload = post_control(0)
        assert status == 200
        assert json.loads(payload)["itunes_search_delay_seconds"] == 0

        started = time.monotonic()
        connection.request("GET", f"/itunes/search?term={term}&entity=album&limit=20")
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read())["resultCount"] == 1
        reset_elapsed = time.monotonic() - started
        assert reset_elapsed < delayed_elapsed

        connection.request("GET", "/cover-lookup-fixture/evidence")
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read())["itunes_search_delay_seconds"] == 0
    finally:
        if connection is not None:
            connection.close()
        service.stop()


def test_provider_fixture_no_results_mode_serves_empty_web_search_boundaries(tmp_path):
    cover_path = tmp_path / "fixture.jpg"
    cover_path.write_bytes(b"fixture-image")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"fixture-other-art-image")
    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        [{
            "cover_id": "fixture",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": "Fixture Artist",
            "album": "Fixture Album",
            "year": 2024,
            "width": 1200,
            "height": 1200,
        }],
        itunes_search_delay_seconds=0,
    )
    connection = None
    service.start()
    service._server.set_cover_lookup_mode("no-results")
    port = service._server.server_address[1]
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        responses = []
        for path in (
            "/duckduckgo-search?q=Fixture+Artist+Fixture+Album",
            "/bing-search?q=Fixture+Artist+Fixture+Album",
        ):
            connection.request("GET", path)
            response = connection.getresponse()
            assert response.status == 200
            assert response.getheader("Content-Type") == "text/html; charset=utf-8"
            responses.append(response.read().decode("utf-8"))

        assert responses == [
            "<!doctype html><html><body></body></html>",
            "<!doctype html><html><body></body></html>",
        ]
        assert all(
            cover_provider_apple.extract_apple_album_links_from_search_html(html) == []
            for html in responses
        )
    finally:
        if connection is not None:
            connection.close()
        service.stop()


def test_fixture_seeds_saved_timezone_by_default_and_blanks_only_for_auto_detection(
    tmp_path,
    monkeypatch,
):
    from music_app.services import lastfm

    saved_settings = []
    monkeypatch.setattr(
        lastfm,
        "load_lastfm_settings",
        lambda _config: {
            "connected_at": "2026-07-23T01:02:03+00:00",
            "session_key": "fixture-session",
            "user_timezone": "America/Denver",
            "username": "fixture_listener",
        },
    )
    monkeypatch.setattr(
        lastfm,
        "save_lastfm_settings",
        lambda _config, settings: saved_settings.append(dict(settings)),
    )

    isolatedLibraryApp.seed_fixture_lastfm_timezone()

    assert saved_settings == [{
        "connected_at": "2026-07-23T01:02:03+00:00",
        "session_key": "fixture-session",
        "user_timezone": "America/Denver",
        "username": "fixture_listener",
    }]

    monkeypatch.setenv("ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE", "blank")
    isolatedLibraryApp.seed_fixture_lastfm_timezone()
    assert saved_settings[-1] == {
        "connected_at": "2026-07-23T01:02:03+00:00",
        "session_key": "fixture-session",
        "username": "fixture_listener",
    }

    cover_path = tmp_path / "fixture.jpg"
    cover_path.write_bytes(b"fixture-image")
    other_art_path = tmp_path / "fixture-other-art.jpg"
    other_art_path.write_bytes(b"fixture-other-art-image")
    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        [{
            "cover_id": "fixture",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": "Fixture Artist",
            "album": "Fixture Album",
            "year": 2024,
            "width": 1200,
            "height": 1200,
        }],
        itunes_search_delay_seconds=0,
    )
    connection = None
    service.start()
    port = service._server.server_address[1]
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        connection.request("POST", "/lastfm-fixture/reset-timezone", body=b"")
        response = connection.getresponse()
        assert response.status == 404
        response.read()
    finally:
        if connection is not None:
            connection.close()
        service.stop()


def test_candidate_image_gate_blocks_only_apple_provider_storage_policy_artwork(
    tmp_path,
    monkeypatch,
):
    target_cover_path = tmp_path / "provider-storage-policy-cover.jpg"
    target_cover_path.write_bytes(b"provider-storage-policy-image")
    other_art_path = tmp_path / "other-art.jpg"
    other_art_path.write_bytes(b"other-art-image")
    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        [
            {
                "cover_id": "provider-storage-policy-cover",
                "staged_path": str(target_cover_path),
                "other_art_staged_path": str(other_art_path),
                "artist": "Storage Policy Artist",
                "album": "Storage Policy Album",
                "year": 2024,
                "width": 900,
                "height": 900,
            },
        ],
        itunes_search_delay_seconds=0,
    )
    gate_entered = threading.Event()
    original_wait = service._server.wait_for_cover_lookup_candidate_image

    def record_gate_entry():
        gate_entered.set()
        original_wait()

    monkeypatch.setattr(
        service._server,
        "wait_for_cover_lookup_candidate_image",
        record_gate_entry,
    )
    providers = ("apple", "deezer", "spotify", "youtube_music")
    request_barrier = threading.Barrier(len(providers) + 1)
    completed = {provider: threading.Event() for provider in providers}
    results = {provider: [] for provider in providers}
    request_threads = []
    service.start()
    service._server.hold_cover_lookup_candidate_images()
    port = service._server.server_address[1]

    def request_artwork(provider):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        try:
            request_barrier.wait(timeout=2)
            connection.request(
                "GET",
                "/apple/artwork/provider-storage-policy-cover/100x100bb.jpg"
                f"?provider={provider}",
            )
            response = connection.getresponse()
            results[provider].extend(
                [
                    response.status,
                    response.getheader("Content-Type"),
                    response.read(),
                ]
            )
        finally:
            connection.close()
            completed[provider].set()

    try:
        for provider in providers:
            request_thread = threading.Thread(
                target=request_artwork,
                args=(provider,),
            )
            request_threads.append(request_thread)
            request_thread.start()

        request_barrier.wait(timeout=2)
        assert gate_entered.wait(timeout=1)
        assert not completed["apple"].is_set()

        for provider in ("deezer", "spotify", "youtube_music"):
            assert completed[provider].wait(timeout=1), (
                f"{provider} candidate image was blocked by the Apple-only gate"
            )
            assert results[provider] == [
                200,
                "image/jpeg",
                b"provider-storage-policy-image",
            ]

        provider_evidence = service._server.snapshot_cover_lookup_evidence()
        assert provider_evidence["candidate_image_requests"] == 1
        assert provider_evidence["candidate_image_released"] is False

        service._server.release_cover_lookup_candidate_images()
        assert completed["apple"].wait(timeout=1)
        assert results["apple"] == [
            200,
            "image/jpeg",
            b"provider-storage-policy-image",
        ]
    finally:
        service._server.release_cover_lookup_candidate_images()
        for request_thread in request_threads:
            request_thread.join(timeout=3)
        service.stop()


def test_cover_matching_fixture_derives_legitimate_art_from_the_active_7500px_source(
    tmp_path,
):
    from PIL import Image, ImageChops, ImageDraw, ImageStat

    original_path = tmp_path / "fixture-original.jpg"
    original = Image.new("RGB", (96, 96), (12, 24, 36))
    drawing = ImageDraw.Draw(original)
    drawing.rectangle((0, 0, 47, 47), fill=(220, 32, 48))
    drawing.rectangle((48, 0, 95, 47), fill=(34, 190, 76))
    drawing.rectangle((0, 48, 47, 95), fill=(32, 78, 220))
    drawing.rectangle((48, 48, 95, 95), fill=(238, 206, 42))
    original.save(original_path, format="JPEG", quality=95)
    original.close()

    distinct_path = tmp_path / "fixture-distinct.jpg"
    Image.new("RGB", (96, 96), (240, 240, 240)).save(
        distinct_path,
        format="JPEG",
        quality=95,
    )
    original_other_art = tmp_path / "fixture-original-booklet.jpg"
    Image.new("RGB", (40, 80), (48, 64, 80)).save(original_other_art, format="JPEG")
    approved_booklet = tmp_path / "fixture-approved-booklet.jpg"
    Image.new("RGB", (80, 40), (96, 112, 128)).save(approved_booklet, format="JPEG")
    cover_specs = [
        {
            "cover_id": "fixture-original",
            "staged_path": str(original_path),
            "other_art_cover_id": "fixture-original-booklet",
            "other_art_staged_path": str(original_other_art),
            "other_art_width": 40,
            "other_art_height": 80,
            "artist": "Original Fixture Artist",
            "album": "Original Fixture Album",
            "year": 2024,
            "width": 7500,
            "height": 7500,
        },
        {
            "cover_id": "fixture-distinct",
            "staged_path": str(distinct_path),
            "other_art_cover_id": "fixture-approved-booklet",
            "other_art_staged_path": str(approved_booklet),
            "other_art_width": 80,
            "other_art_height": 40,
            "artist": "Distinct Fixture Artist",
            "album": "Distinct Fixture Album",
            "year": 2024,
            "width": 2937,
            "height": 6819,
        },
    ]

    first_specs = isolatedLibraryApp._cover_matching_provider_specs(cover_specs)
    second_specs = isolatedLibraryApp._cover_matching_provider_specs(cover_specs)
    accepted_first = {
        str(spec["fixture_role"]): spec
        for spec in first_specs
        if spec["fixture_role"] in {"base", "deluxe"}
    }
    accepted_second = {
        str(spec["fixture_role"]): spec
        for spec in second_specs
        if spec["fixture_role"] in {"base", "deluxe"}
    }

    assert set(accepted_first) == {"base", "deluxe"}
    assert {
        role: (int(spec["width"]), int(spec["height"]))
        for role, spec in accepted_first.items()
    } == {
        "base": (1000, 1000),
        "deluxe": (1400, 1400),
    }
    derivative_paths = {
        Path(str(spec["staged_path"]))
        for spec in accepted_first.values()
    }
    assert len(derivative_paths) == 1
    derivative_path = derivative_paths.pop()
    assert derivative_path not in {original_path, distinct_path}
    assert derivative_path.is_file()
    assert {
        Path(str(spec["staged_path"]))
        for spec in accepted_second.values()
    } == {derivative_path}
    first_derivative_sha = hashlib.sha256(derivative_path.read_bytes()).hexdigest()
    assert {
        hashlib.sha256(Path(str(spec["staged_path"])).read_bytes()).hexdigest()
        for spec in accepted_second.values()
    } == {first_derivative_sha}

    original_source_sha = hashlib.sha256(original_path.read_bytes()).hexdigest()
    for spec in accepted_first.values():
        assert spec["original_source_sha256"] == original_source_sha
        assert spec["other_art_cover_id"] == cover_specs[1]["other_art_cover_id"]
        assert spec["other_art_staged_path"] == cover_specs[1]["other_art_staged_path"]
        assert spec["other_art_width"] == cover_specs[1]["other_art_width"]
        assert spec["other_art_height"] == cover_specs[1]["other_art_height"]

    with Image.open(original_path) as source_image:
        source_pixels = source_image.convert("RGB")
    with Image.open(distinct_path) as distinct_image:
        distinct_pixels = distinct_image.convert("RGB")
    with Image.open(derivative_path) as derivative_image:
        assert derivative_image.size == (4518, 4518)
        derivative_pixels = derivative_image.convert("RGB").resize(
            source_pixels.size,
            resample=Image.Resampling.LANCZOS,
        )
    similar_rms = ImageStat.Stat(
        ImageChops.difference(source_pixels, derivative_pixels),
    ).rms
    distinct_rms = ImageStat.Stat(
        ImageChops.difference(source_pixels, distinct_pixels),
    ).rms
    assert max(similar_rms) < 12
    assert max(distinct_rms) > 60


def test_provider_artwork_spec_is_materialized_to_declared_dimensions(tmp_path):
    from PIL import Image

    released_cover_root = tmp_path / "released-covers"
    released_cover_root.mkdir()
    derivative_root = tmp_path / "attempt-owned-provider-artwork"
    source_path = released_cover_root / "provider-source.jpg"
    Image.new("RGB", (96, 64), (24, 48, 72)).save(source_path, format="JPEG")
    source_spec = {
        "cover_id": "prepared-provider-cover",
        "staged_path": str(source_path),
        "width": 120,
        "height": 80,
    }

    source_files_before = tuple(path.name for path in released_cover_root.iterdir())
    first = isolatedLibraryApp._prepare_provider_artwork_spec(
        source_spec,
        derivative_root=derivative_root,
    )
    second = isolatedLibraryApp._prepare_provider_artwork_spec(
        source_spec,
        derivative_root=derivative_root,
    )

    prepared_path = Path(str(first["staged_path"]))
    assert prepared_path != source_path
    assert prepared_path.parent == derivative_root
    assert second["staged_path"] == first["staged_path"]
    assert tuple(path.name for path in released_cover_root.iterdir()) == source_files_before
    assert first["original_source_sha256"] == hashlib.sha256(
        source_path.read_bytes()
    ).hexdigest()
    with Image.open(prepared_path) as prepared_image:
        assert prepared_image.size == (120, 80)


def test_provider_fixture_prepares_generated_apple_artwork_before_start(
    tmp_path,
    monkeypatch,
):
    cover_specs = []
    for index in range(4):
        cover_path = tmp_path / f"fixture-{index}.jpg"
        cover_path.write_bytes(f"cover-{index}".encode("ascii"))
        other_art_path = tmp_path / f"fixture-{index}-other.jpg"
        other_art_path.write_bytes(f"other-{index}".encode("ascii"))
        cover_specs.append({
            "cover_id": f"fixture-{index}",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": f"Artist {index}",
            "album": f"Album {index}",
            "year": 2024,
            "width": 96,
            "height": 96,
        })

    prepared_ids: list[str] = []

    def record_preparation(spec):
        prepared_ids.append(str(spec["cover_id"]))
        return {**spec, "prepared_before_start": True}

    monkeypatch.setattr(
        isolatedLibraryApp,
        "_prepare_provider_artwork_spec",
        record_preparation,
    )
    service = isolatedLibraryApp.ProviderFixtureService(0, cover_specs)
    try:
        expected_ids = {
            "metallica-kill-em-all-base",
            "metallica-kill-em-all-deluxe",
            "automatic-candidate-primary",
            "automatic-coverless-neutral",
            "user-owned-improvement-primary",
            "user-owned-same-art-improvement",
            "automatic-improvement-alternate",
            "morse-cover-to-cover-conjunction",
        }
        assert expected_ids <= set(prepared_ids)
        prepared_specs = {
            str(spec["cover_id"]): spec
            for spec in service._server.cover_specs
            if str(spec["cover_id"]) in expected_ids
        }
        assert set(prepared_specs) == expected_ids
        assert all(spec["prepared_before_start"] is True for spec in prepared_specs.values())
    finally:
        service._server.server_close()


def test_provider_fixture_serves_every_cover_matching_candidate_image(tmp_path):
    cover_specs = []
    for index, payload in enumerate((b"large-fixture-image", b"small-fixture-image")):
        cover_path = tmp_path / f"fixture-{index}.jpg"
        cover_path.write_bytes(payload)
        other_art_path = tmp_path / f"fixture-{index}-other-art.jpg"
        other_art_path.write_bytes(f"other-art-{index}".encode("ascii"))
        cover_specs.append({
            "cover_id": f"fixture-{index}",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": f"Fixture Artist {index}",
            "album": f"Fixture Album {index}",
            "year": 2024,
            "width": 1200,
            "height": 1200,
        })

    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        cover_specs,
        itunes_search_delay_seconds=0,
    )
    matching_specs = service._server.cover_lookup_matching_specs
    assert {
        str(spec["cover_id"])
        for spec in matching_specs
    } == {
        "metallica-kill-em-all-base",
        "metallica-kill-em-all-deluxe",
        "metallica-kill-em-all-false-single",
        "metallica-kill-em-all-false-tribute",
        "metallica-kill-em-all-false-remix",
        "metallica-kill-em-all-false-featuring",
        "metallica-kill-em-all-false-other-band",
        "metallica-kill-em-all-false-featured-artist",
        "metallica-kill-em-all-false-collaboration-artist",
        "metallica-kill-em-all-false-orchestra",
        "metallica-kill-em-all-false-experience",
        "metallica-kill-em-all-false-project",
    }
    assert {
        str(spec["artist"])
        for spec in matching_specs
        if str(spec["fixture_role"]).startswith("false-artist-identity")
    } == {
        "Metallica feat. Discrepancies",
        "Metallica & Discrepancies",
        "Metallica Orchestra",
        "Metallica Experience",
        "The Metallica Project",
    }

    connection = None
    service.start()
    port = service._server.server_address[1]
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        for spec in matching_specs:
            cover_id = str(spec["cover_id"])
            expected_cover = Path(str(spec["staged_path"])).read_bytes()
            expected_other_art = Path(str(spec["other_art_staged_path"])).read_bytes()

            connection.request("GET", f"/covers/{cover_id}.jpg")
            response = connection.getresponse()
            assert response.status == 200
            assert response.getheader("Content-Type") == "image/jpeg"
            assert response.read() == expected_cover
            assert expected_cover

            connection.request(
                "GET",
                f"/apple/artwork/{cover_id}/9999x9999bb-100.jpg",
            )
            response = connection.getresponse()
            assert response.status == 200
            assert response.getheader("Content-Type") == "image/jpeg"
            assert response.read() == expected_cover

            connection.request("GET", f"/manual/{cover_id}/other-art.jpg")
            response = connection.getresponse()
            assert response.status == 200
            assert response.getheader("Content-Type") == "image/jpeg"
            assert response.read() == expected_other_art
            assert expected_other_art
    finally:
        if connection is not None:
            connection.close()
        service.stop()


def test_provider_fixture_serves_declared_dimensions_for_legitimate_apple_matching_artwork(
    tmp_path,
):
    from PIL import Image

    cover_specs = []
    for index, color in enumerate(((32, 64, 96), (96, 64, 32))):
        cover_path = tmp_path / f"fixture-{index}.jpg"
        Image.new("RGB", (64, 64), color).save(cover_path, format="JPEG")
        other_art_path = tmp_path / f"fixture-{index}-other-art.jpg"
        Image.new("RGB", (32, 48), color).save(other_art_path, format="JPEG")
        cover_specs.append({
            "cover_id": f"fixture-{index}",
            "staged_path": str(cover_path),
            "other_art_staged_path": str(other_art_path),
            "artist": f"Fixture Artist {index}",
            "album": f"Fixture Album {index}",
            "year": 2024,
            "width": 64,
            "height": 64,
        })

    service = isolatedLibraryApp.ProviderFixtureService(
        0,
        cover_specs,
        itunes_search_delay_seconds=0,
    )
    connection = None
    service.start()
    port = service._server.server_address[1]
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        expected_dimensions = {
            "metallica-kill-em-all-base": (1000, 1000),
            "metallica-kill-em-all-deluxe": (1400, 1400),
        }
        for cover_id, dimensions in expected_dimensions.items():
            connection.request(
                "GET",
                f"/apple/artwork/{cover_id}/9999x9999bb-100.jpg",
            )
            response = connection.getresponse()
            assert response.status == 200
            with Image.open(io.BytesIO(response.read())) as artwork:
                assert artwork.size == dimensions
    finally:
        if connection is not None:
            connection.close()
        service.stop()


def test_production_runtime_configuration_requires_all_postgres_seams_and_isolated_paths(
    tmp_path,
    monkeypatch,
):
    calls: list[str] = []

    def select_postgres(seam_id, _config):
        calls.append(seam_id)
        return SimpleNamespace(effective_backend="postgres")

    monkeypatch.setattr(
        "music_app.services.persistence_selection.select_runtime_persistence_adapter",
        select_postgres,
    )
    config = {
        "MUSIC_DIR": tmp_path / "media",
        "DATA_DIR": tmp_path / "app-data",
        "CACHE_PATH": tmp_path / "app-data" / "inert-library-cache.json",
        "COVER_CACHE_PATH": tmp_path / "app-data" / "inert-cover-cache.json",
        "LIBRARY_ROOTS_PATH": tmp_path / "app-data" / "inert-library-roots.json",
        "COVER_PROVIDER_GROUPS": frozenset({"music_services", "manual_urls", "discogs", "cover_art_archive"}),
        "ENABLED_MUSIC_SERVICES": frozenset({"apple"}),
        "LASTFM_API_KEY": isolatedLibraryApp.LASTFM_FAKE_API_KEY,
        "LASTFM_API_SECRET": isolatedLibraryApp.LASTFM_FAKE_API_SECRET,
        "LASTFM_API_ROOT": "http://127.0.0.1:4175/lastfm",
    }

    isolatedLibraryApp.assert_production_runtime_configuration(config, tmp_path)

    assert calls == list(isolatedLibraryApp._REQUIRED_POSTGRES_SEAMS)


def test_production_runtime_configuration_rejects_file_persistence(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "music_app.services.persistence_selection.select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(effective_backend="file"),
    )
    config = {
        key: tmp_path / key.lower()
        for key in ("MUSIC_DIR", "DATA_DIR", "CACHE_PATH", "COVER_CACHE_PATH", "LIBRARY_ROOTS_PATH")
    }
    config["COVER_PROVIDER_GROUPS"] = frozenset({"music_services", "manual_urls", "discogs", "cover_art_archive"})
    config["ENABLED_MUSIC_SERVICES"] = frozenset({"apple"})

    with pytest.raises(RuntimeError, match="requires Postgres"):
        isolatedLibraryApp.assert_production_runtime_configuration(config, tmp_path)


def test_production_runtime_configuration_rejects_non_fixture_music_services(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "music_app.services.persistence_selection.select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(effective_backend="postgres"),
    )
    config = {
        key: tmp_path / key.lower()
        for key in ("MUSIC_DIR", "DATA_DIR", "CACHE_PATH", "COVER_CACHE_PATH", "LIBRARY_ROOTS_PATH")
    }
    config["COVER_PROVIDER_GROUPS"] = frozenset({"music_services", "manual_urls", "discogs", "cover_art_archive"})
    config["ENABLED_MUSIC_SERVICES"] = frozenset({"apple", "deezer"})

    with pytest.raises(RuntimeError, match="fixture-backed Apple provider"):
        isolatedLibraryApp.assert_production_runtime_configuration(config, tmp_path)


def test_provider_port_resolves_from_base_url_or_port_environment():
    assert isolatedLibraryApp.resolve_provider_port(
        None,
        {"PLAYWRIGHT_PROVIDER_BASE_URL": "http://127.0.0.1:4319"},
    ) == 4319
    assert isolatedLibraryApp.resolve_provider_port(
        None,
        {"PLAYWRIGHT_PROVIDER_PORT": "4321"},
    ) == 4321
