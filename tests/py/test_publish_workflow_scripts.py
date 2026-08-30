from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CLASSIFY_SCRIPT = REPO_ROOT / "scripts" / "classify-publish-changes.ps1"
LAUNCH_CHECK_SCRIPT = REPO_ROOT / "scripts" / "test-coderabbit-launch.ps1"


def _run(command: list[str], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env.setdefault("GIT_AUTHOR_NAME", "Codex")
    env.setdefault("GIT_AUTHOR_EMAIL", "codex@example.com")
    env.setdefault("GIT_COMMITTER_NAME", "Codex")
    env.setdefault("GIT_COMMITTER_EMAIL", "codex@example.com")
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


def _powershell(script: Path, *args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return _run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            *args,
        ],
        cwd=cwd,
    )


def _write(repo: Path, relative_path: str, contents: str) -> None:
    path = repo / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def _commit_all(repo: Path, message: str) -> str:
    _run(["git", "add", "."], cwd=repo)
    _run(["git", "commit", "-m", message], cwd=repo)
    return _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()


def _init_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _run(["git", "init"], cwd=repo)
    _run(["git", "branch", "-M", "main"], cwd=repo)
    _write(repo, "README.md", "# Temp Repo\n")
    _commit_all(repo, "initial")
    _run(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], cwd=repo)
    return repo


def test_test_coderabbit_launch_reports_ready_for_host_gh_auth(tmp_path: Path):
    launcher = tmp_path / "gh.cmd"
    launcher.write_text(
        "@echo off\n"
        'if "%1"=="auth" (\n'
        '  if "%2"=="status" (\n'
        "    echo github.com\n"
        "    echo   Logged in to github.com account idanilovqa ^(keyring^)\n"
        "    echo   - Active account: true\n"
        "    echo   - Token scopes: 'repo', 'workflow'\n"
        "    exit /b 0\n"
        "  )\n"
        ")\n"
        "exit /b 1\n",
        encoding="utf-8",
    )

    result = _powershell(
        LAUNCH_CHECK_SCRIPT,
        "-Command",
        str(launcher),
        cwd=tmp_path,
    )

    payload = json.loads(result.stdout)
    assert payload["status"] == "ready"
    assert payload["ready"] is True
    assert payload["launcherKind"] == "host_gh"
    assert payload["account"] == "idanilovqa"
    assert payload["activeAccount"] is True
    assert payload["tokenScopes"] == ["repo", "workflow"]
    assert payload["resolvedCommandPath"].lower().endswith("gh.cmd")


def test_test_coderabbit_launch_reports_incomplete_host_gh_auth(tmp_path: Path):
    launcher = tmp_path / "gh.cmd"
    launcher.write_text(
        "@echo off\n"
        'if "%1"=="auth" (\n'
        '  if "%2"=="status" (\n'
        "    echo github.com\n"
        "    echo   Logged in to github.com account idanilovqa ^(keyring^)\n"
        "    echo   - Active account: false\n"
        "    exit /b 0\n"
        "  )\n"
        ")\n"
        "exit /b 1\n",
        encoding="utf-8",
    )

    result = _powershell(
        LAUNCH_CHECK_SCRIPT,
        "-Command",
        str(launcher),
        cwd=tmp_path,
    )

    payload = json.loads(result.stdout)
    assert payload["status"] == "auth_incomplete"
    assert payload["ready"] is False
    assert payload["account"] == "idanilovqa"
    assert payload["activeAccount"] is False
    assert "active authenticated account" in payload["notes"]


def test_test_coderabbit_launch_reports_missing_command(tmp_path: Path):
    result = _powershell(
        LAUNCH_CHECK_SCRIPT,
        "-Command",
        "coderabbit-not-installed",
        cwd=tmp_path,
    )

    payload = json.loads(result.stdout)
    assert payload["status"] == "command_not_found"
    assert payload["ready"] is False


def test_classify_publish_changes_reports_metadata_only_release_updates(tmp_path: Path):
    repo = _init_repo(tmp_path)
    base = _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
    _run(["git", "checkout", "-b", "feature/release"], cwd=repo)
    _write(repo, "docs/release-notes.md", "# Release Notes\n")
    _write(
        repo,
        "package.json",
        json.dumps({"name": "music-app", "version": "1.2.3"}, indent=2) + "\n",
    )
    head = _commit_all(repo, "release metadata")

    result = _powershell(
        CLASSIFY_SCRIPT,
        "-RepoRoot",
        str(repo),
        "-BaseRef",
        base,
        "-HeadRef",
        head,
        cwd=repo,
    )

    payload = json.loads(result.stdout)
    assert payload["metadataOnly"] is True
    assert payload["requiresPerformanceE2E"] is False
    assert set(payload["classes"]) == {"docs", "metadata"}
    assert payload["changedFiles"] == ["docs/release-notes.md", "package.json"]


def test_classify_publish_changes_marks_runtime_and_script_changes_as_non_metadata(tmp_path: Path):
    repo = _init_repo(tmp_path)
    base = _run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
    _run(["git", "checkout", "-b", "feature/runtime"], cwd=repo)
    _write(repo, "music_app/static/js/runtime/app.js", "console.log('runtime');\n")
    _write(repo, "scripts/prepare_release.ps1", "Write-Host 'prepare'\n")
    head = _commit_all(repo, "runtime and script")

    result = _powershell(
        CLASSIFY_SCRIPT,
        "-RepoRoot",
        str(repo),
        "-BaseRef",
        base,
        "-HeadRef",
        head,
        cwd=repo,
    )

    payload = json.loads(result.stdout)
    assert payload["metadataOnly"] is False
    assert payload["requiresPerformanceE2E"] is True
    assert set(payload["classes"]) == {"runtime", "script"}
