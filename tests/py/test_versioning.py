from __future__ import annotations

import json
from pathlib import Path

import config
from scripts.prepare_release import (
    _extract_changelog_section,
    _update_package_version,
    _update_readme_version,
    read_changelog_section,
)
from tests.py.asgi_testing import run_asgi_request
from version import RELEASE_VERSION, normalize_release_version, write_release_version


def test_config_app_version_matches_release_version():
    assert config.APP_VERSION == RELEASE_VERSION


def test_normalize_release_version_accepts_semver():
    assert normalize_release_version("1.2.3") == "1.2.3"


def test_normalize_release_version_rejects_non_semver():
    try:
        normalize_release_version("1.2")
    except ValueError as exc:
        assert "major.minor.patch" in str(exc)
    else:
        raise AssertionError("Expected normalize_release_version to reject non-semver input.")


def test_write_release_version_updates_only_release_line(tmp_path: Path):
    version_path = tmp_path / "version.py"
    version_path.write_text(
        'RELEASE_VERSION = "0.1.0"\n'
        "\n"
        "def keep_helper() -> str:\n"
        '    return "still here"\n',
        encoding="utf-8",
    )

    write_release_version(version_path, "2.3.4")

    assert version_path.read_text(encoding="utf-8") == (
        'RELEASE_VERSION = "2.3.4"\n'
        "\n"
        "def keep_helper() -> str:\n"
        '    return "still here"\n'
    )


def test_write_release_version_raises_when_release_line_missing(tmp_path: Path):
    version_path = tmp_path / "version.py"
    version_path.write_text("HELPER = 'missing release version'\n", encoding="utf-8")

    try:
        write_release_version(version_path, "2.3.4")
    except RuntimeError as exc:
        assert "RELEASE_VERSION" in str(exc)
    else:
        raise AssertionError("Expected write_release_version to fail loudly when the release line is missing.")


def test_write_release_version_is_a_no_op_when_version_is_already_current(tmp_path: Path):
    version_path = tmp_path / "version.py"
    version_path.write_text(
        'RELEASE_VERSION = "2.3.4"\n'
        "\n"
        "def keep_helper() -> str:\n"
        '    return "still here"\n',
        encoding="utf-8",
    )

    write_release_version(version_path, "2.3.4")

    assert version_path.read_text(encoding="utf-8") == (
        'RELEASE_VERSION = "2.3.4"\n'
        "\n"
        "def keep_helper() -> str:\n"
        '    return "still here"\n'
    )


def test_prepare_release_updates_package_version(tmp_path: Path):
    package_path = tmp_path / "package.json"
    package_path.write_text(json.dumps({
        "name": "musicapp",
        "version": "0.1.0",
        "packages": {
            "": {
                "version": "0.1.0",
            },
        },
    }), encoding="utf-8")

    _update_package_version(package_path, "2.3.4")

    saved = json.loads(package_path.read_text(encoding="utf-8"))
    assert saved["version"] == "2.3.4"
    assert saved["packages"][""]["version"] == "2.3.4"


def test_prepare_release_updates_readme_version_marker(tmp_path: Path):
    readme_path = tmp_path / "README.md"
    readme_path.write_text("# AlbumHaven\n\nCurrent release: `0.1.0`\n", encoding="utf-8")

    _update_readme_version(readme_path, "2.3.4")

    assert readme_path.read_text(encoding="utf-8") == "# AlbumHaven\n\nCurrent release: `2.3.4`\n"


def test_prepare_release_readme_update_is_a_no_op_when_version_is_already_current(tmp_path: Path):
    readme_path = tmp_path / "README.md"
    readme_path.write_text("# AlbumHaven\n\nCurrent release: `2.3.4`\n", encoding="utf-8")

    _update_readme_version(readme_path, "2.3.4")

    assert readme_path.read_text(encoding="utf-8") == "# AlbumHaven\n\nCurrent release: `2.3.4`\n"


def test_extract_changelog_section_matches_repo_heading_format():
    notes = (
        "# Release Notes\n\n"
        "## 2.3.4 - 2026-05-17\n\n"
        "### Highlights\n\n"
        "- Prepared versioning.\n\n"
        "## 2.3.3 - 2026-05-10\n\n"
        "- Previous release.\n"
    )

    extracted = _extract_changelog_section(notes, "2.3.4")

    assert extracted == "## 2.3.4 - 2026-05-17\n\n### Highlights\n\n- Prepared versioning.\n"


def test_read_changelog_section_raises_when_version_heading_missing(tmp_path: Path):
    notes_path = tmp_path / "CHANGELOG.md"
    notes_path.write_text("# Release Notes\n\n## 2.3.3 - 2026-05-10\n", encoding="utf-8")

    try:
        read_changelog_section(notes_path, "2.3.4")
    except RuntimeError as exc:
        assert "## 2.3.4 - YYYY-MM-DD" in str(exc)
    else:
        raise AssertionError("Expected read_changelog_section to require a matching release heading.")


def test_index_exposes_release_meta_tag(asgi_app, monkeypatch):
    from music_app.routes import web_asgi

    def fake_build_postgres_root_startup_view(*, config, query_args):
        initial_view = web_asgi._build_empty_initial_view(
            config=config,
            query_raw=str(query_args.get("q") or "").strip(),
            selected_artist=str(query_args.get("artist") or "").strip(),
            active_surface="albums",
        )
        initial_view["initial_view_partial"] = True
        return initial_view, None, 0.0

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(
        web_asgi,
        "get_primary_music_root",
        lambda config: Path(config["MUSIC_DIR"]).expanduser().resolve(strict=False),
    )
    monkeypatch.setattr(
        web_asgi,
        "_build_postgres_root_startup_view",
        fake_build_postgres_root_startup_view,
    )

    status, _headers, body = run_asgi_request(asgi_app, "GET", "/")

    assert status == 200
    assert f'<meta name="album-haven-version" content="{RELEASE_VERSION}">'.encode("utf-8") in body


def test_frontend_bootstrap_defaults_read_release_meta():
    repo_root = Path(__file__).resolve().parents[2]
    app_js_path = repo_root / "music_app" / "static" / "app.js"
    bootstrap_state_path = repo_root / "music_app" / "static" / "js" / "runtime" / "bootstrap-state.js"

    app_js = app_js_path.read_text(encoding="utf-8")
    bootstrap_state_js = bootstrap_state_path.read_text(encoding="utf-8")

    assert 'meta[name="album-haven-version"]' in app_js
    assert 'meta[name="album-haven-version"]' in bootstrap_state_js
