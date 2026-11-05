from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def _provider_config_environment(overrides: dict[str, str]) -> dict[str, str]:
    environment = os.environ.copy()
    for key in (
        "ALBUM_HAVEN_ENABLED_MUSIC_SERVICES",
        "COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS",
        "APPLE_API_BASE_URL",
        "MUSICBRAINZ_BASE_URL",
        "COVER_ART_ARCHIVE_BASE_URL",
    ):
        environment.pop(key, None)
    environment.update(overrides)
    return environment


def _read_provider_config(overrides: dict[str, str]) -> dict[str, object]:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import json; from config import Config; "
                "print(json.dumps({"
                "'apple': Config.APPLE_API_BASE_URL, "
                "'musicbrainz': Config.MUSICBRAINZ_BASE_URL, "
                "'cover_art_archive': Config.COVER_ART_ARCHIVE_BASE_URL, "
                "'enabled_music_services': sorted(Config.ENABLED_MUSIC_SERVICES)"
                "}))"
            ),
        ],
        cwd=ROOT,
        env=_provider_config_environment(overrides),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def test_provider_endpoint_config_defaults_to_public_services():
    assert _read_provider_config({}) == {
        "apple": "https://itunes.apple.com",
        "musicbrainz": "https://musicbrainz.org/ws/2",
        "cover_art_archive": "https://coverartarchive.org",
        "enabled_music_services": ["apple", "deezer", "genius", "spotify", "youtube_music"],
    }


def test_provider_endpoint_config_accepts_self_hosted_overrides_and_trims_slashes():
    assert _read_provider_config({
        "APPLE_API_BASE_URL": "http://provider.test/itunes/",
        "MUSICBRAINZ_BASE_URL": "http://provider.test/musicbrainz/",
        "COVER_ART_ARCHIVE_BASE_URL": "http://provider.test/coverartarchive/",
    }) == {
        "apple": "http://provider.test/itunes",
        "musicbrainz": "http://provider.test/musicbrainz",
        "cover_art_archive": "http://provider.test/coverartarchive",
        "enabled_music_services": ["apple", "deezer", "genius", "spotify", "youtube_music"],
    }


def test_provider_config_accepts_explicit_enabled_music_services():
    config = _read_provider_config({"ALBUM_HAVEN_ENABLED_MUSIC_SERVICES": " youtube_music,apple "})

    assert config["enabled_music_services"] == ["apple", "youtube_music"]


def test_provider_config_defaults_to_120_second_manual_lookup_budget():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from config import Config; print(Config.COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS)",
        ],
        cwd=ROOT,
        env=_provider_config_environment({}),
        capture_output=True,
        text=True,
        check=True,
    )

    assert float(result.stdout.strip()) == 120.0


def test_provider_config_rejects_unknown_enabled_music_services():
    result = subprocess.run(
        [sys.executable, "-c", "from config import Config"],
        cwd=ROOT,
        env=_provider_config_environment({"ALBUM_HAVEN_ENABLED_MUSIC_SERVICES": "apple,tidal"}),
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "Unknown music service(s): tidal" in result.stderr
