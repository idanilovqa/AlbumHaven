from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zipfile import ZIP_DEFLATED, ZipFile

import pytest


REPOSITORY = "owner/private-fixtures"
RELEASE = "fixtures-v1.0.0"
PROFILE = "functional-core"
PROFILES = (
    "functional-core",
    "synthetic-large-library",
    "utility-problematic-files",
    "scan-library",
    "playback-media",
)
SCRIPT = Path(__file__).parents[2] / "scripts" / "ci" / "fetch-test-fixtures.ps1"


def _archive(
    *,
    seed: bool = True,
    traversal: bool = False,
    media_file_only: bool = False,
    extra_entries: tuple[tuple[str, bytes], ...] = (),
) -> bytes:
    buffer = io.BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        if seed:
            archive.writestr("database/functional-core.ndjson.zst", b"seed")
        archive.writestr("media" if media_file_only else "media/track.mp3", b"audio")
        if traversal:
            archive.writestr("../escaped.txt", b"escape")
        for name, contents in extra_entries:
            archive.writestr(name, contents)
    return buffer.getvalue()


def _manifest(archive: bytes, *, manifest_schema: int = 1, profile_schema: int = 1) -> bytes:
    profile_payload = {
        "archive": "functional-core.zip",
        "databaseSeed": "database/functional-core.ndjson.zst",
        "mediaRoot": "media",
        "schemaVersion": profile_schema,
        "sha256": hashlib.sha256(archive).hexdigest(),
        "counts": {"tracks": 1},
        "namedScenarioAssertions": {"case": "fixture-download"},
    }
    payload = {
        "manifestVersion": manifest_schema,
        "release": RELEASE,
        "generatorCommit": "a" * 40,
        "profiles": {name: dict(profile_payload) for name in PROFILES},
    }
    return json.dumps(payload, separators=(",", ":")).encode()


class ReleaseServer:
    def __init__(self, manifest: bytes, archive: bytes, *, include_archive: bool = True) -> None:
        self.manifest = manifest
        self.archive = archive
        self.include_archive = include_archive
        self.requests: list[tuple[str, str | None]] = []
        self.asset_base_url: str | None = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                owner.requests.append((self.path, self.headers.get("Authorization")))
                if self.path == f"/repos/{REPOSITORY}/releases/tags/{RELEASE}":
                    assets = [
                        {
                            "name": "manifest.json",
                            "url": f"{owner.asset_base_url or owner.base_url}/assets/manifest",
                        }
                    ]
                    if owner.include_archive:
                        assets.append(
                            {
                                "name": "functional-core.zip",
                                "url": f"{owner.asset_base_url or owner.base_url}/assets/archive",
                            }
                        )
                    self._send(json.dumps({"tag_name": RELEASE, "assets": assets}).encode())
                elif self.path == "/assets/manifest":
                    self._send(owner.manifest)
                elif self.path == "/assets/archive" and owner.include_archive:
                    self._send(owner.archive, "application/octet-stream")
                else:
                    self.send_error(404)

            def _send(self, body: bytes, content_type: str = "application/json") -> None:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "ReleaseServer":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def _run(
    server: ReleaseServer,
    tmp_path: Path,
    manifest_sha: str,
    *,
    token: str | None = "test-secret-token",
    github_env_name: str = "github.env",
    release: str = RELEASE,
) -> tuple[subprocess.CompletedProcess[str], Path]:
    github_env = tmp_path / github_env_name
    environment = os.environ.copy()
    environment.pop("ALBUM_HAVEN_FIXTURES_TOKEN", None)
    if token is not None:
        environment["ALBUM_HAVEN_FIXTURES_TOKEN"] = token
    executable = shutil.which("pwsh") or shutil.which("powershell")
    if executable is None:
        pytest.skip("PowerShell is required for the fixture downloader contract")
    result = subprocess.run(
        [
            executable,
            "-NoProfile",
            "-File",
            str(SCRIPT),
            "-Release",
            release,
            "-Profile",
            PROFILE,
            "-ManifestSha256",
            manifest_sha,
            "-Repository",
            REPOSITORY,
            "-ApiBaseUrl",
            server.base_url,
            "-RunnerTemp",
            str(tmp_path / "runner-temp"),
            "-GithubEnv",
            str(github_env),
        ],
        capture_output=True,
        encoding="utf-8",
        env=environment,
        timeout=30,
        check=False,
    )
    return result, github_env


def _exports(path: Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in path.read_text(encoding="utf-8-sig").splitlines())


def test_valid_authenticated_download_extracts_and_exports(tmp_path: Path) -> None:
    archive = _archive()
    manifest = _manifest(archive)
    with ReleaseServer(manifest, archive) as server:
        result, github_env = _run(server, tmp_path, hashlib.sha256(manifest).hexdigest())

    assert result.returncode == 0, result.stderr
    exports = _exports(github_env)
    assert exports["ALBUM_HAVEN_FIXTURE_RELEASE"] == RELEASE
    assert exports["ALBUM_HAVEN_FIXTURE_PROFILE"] == PROFILE
    root = Path(exports["ALBUM_HAVEN_FIXTURE_ROOT"])
    assert Path(exports["ALBUM_HAVEN_MEDIA_ROOT"]) == root / "media"
    assert (root / "database" / "functional-core.ndjson.zst").read_bytes() == b"seed"
    assert json.loads((root / "manifest.json").read_text(encoding="utf-8"))["generatorCommit"] == "a" * 40
    assert all(auth == "Bearer test-secret-token" for _, auth in server.requests)
    output = result.stdout + result.stderr
    assert "test-secret-token" not in output
    assert server.base_url not in output


@pytest.mark.parametrize("corrupt", ["manifest", "archive"])
def test_bad_checksum_is_rejected_before_export(tmp_path: Path, corrupt: str) -> None:
    archive = _archive()
    manifest = _manifest(archive)
    served_archive = archive + b"corrupt" if corrupt == "archive" else archive
    pinned_sha = "0" * 64 if corrupt == "manifest" else hashlib.sha256(manifest).hexdigest()
    with ReleaseServer(manifest, served_archive) as server:
        result, github_env = _run(server, tmp_path, pinned_sha)

    assert result.returncode != 0
    assert "sha" in (result.stdout + result.stderr).lower()
    assert "test-secret-token" not in result.stdout + result.stderr
    assert server.base_url not in result.stdout + result.stderr
    assert not github_env.exists() or not github_env.read_text(encoding="utf-8").strip()
    assert not list((tmp_path / "runner-temp").glob("album-haven-fixtures-*"))


@pytest.mark.parametrize("manifest_schema,profile_schema", [(2, 1), (1, 2)])
def test_unknown_schema_version_is_rejected(
    tmp_path: Path, manifest_schema: int, profile_schema: int
) -> None:
    archive = _archive()
    manifest = _manifest(
        archive, manifest_schema=manifest_schema, profile_schema=profile_schema
    )
    with ReleaseServer(manifest, archive) as server:
        result, github_env = _run(server, tmp_path, hashlib.sha256(manifest).hexdigest())

    assert result.returncode != 0
    assert "schema" in (result.stdout + result.stderr).lower()
    assert not github_env.exists() or not github_env.read_text(encoding="utf-8").strip()


@pytest.mark.parametrize("field", ["generatorCommit", "counts", "namedScenarioAssertions", "extra-profile"])
def test_incomplete_manifest_contract_is_rejected(tmp_path: Path, field: str) -> None:
    archive = _archive()
    payload = json.loads(_manifest(archive))
    if field == "generatorCommit":
        del payload["generatorCommit"]
    elif field == "extra-profile":
        payload["profiles"]["unexpected"] = dict(payload["profiles"][PROFILE])
    else:
        del payload["profiles"]["scan-library"][field]
    manifest = json.dumps(payload, separators=(",", ":")).encode()
    with ReleaseServer(manifest, archive) as server:
        result, github_env = _run(server, tmp_path, hashlib.sha256(manifest).hexdigest())

    assert result.returncode != 0
    assert "manifest schema" in (result.stdout + result.stderr).lower()
    assert not github_env.exists() or not github_env.read_text(encoding="utf-8").strip()


@pytest.mark.parametrize("missing", ["asset", "seed", "seed-directory", "media-file"])
def test_missing_asset_or_required_member_is_rejected(tmp_path: Path, missing: str) -> None:
    archive = _archive(
        seed=missing not in {"seed", "seed-directory"},
        media_file_only=missing == "media-file",
        extra_entries=(("database/functional-core.ndjson.zst/", b""),)
        if missing == "seed-directory"
        else (),
    )
    manifest = _manifest(archive)
    with ReleaseServer(manifest, archive, include_archive=missing != "asset") as server:
        result, github_env = _run(server, tmp_path, hashlib.sha256(manifest).hexdigest())

    assert result.returncode != 0
    assert "missing" in (result.stdout + result.stderr).lower()
    assert not github_env.exists() or not github_env.read_text(encoding="utf-8").strip()


@pytest.mark.parametrize(
    "unsafe_entry",
    ["../escaped.txt", "media/track.mp3:secret", "Media/track.mp3", "media/trailing. /file.mp3"],
)
def test_unsafe_windows_archive_paths_are_rejected_without_escape(
    tmp_path: Path, unsafe_entry: str
) -> None:
    archive = _archive(extra_entries=((unsafe_entry, b"escape"),))
    manifest = _manifest(archive)
    with ReleaseServer(manifest, archive) as server:
        result, github_env = _run(server, tmp_path, hashlib.sha256(manifest).hexdigest())

    assert result.returncode != 0
    assert "archive" in (result.stdout + result.stderr).lower()
    assert not (tmp_path / "escaped.txt").exists()
    assert not github_env.exists() or not github_env.read_text(encoding="utf-8").strip()


def test_cross_origin_asset_url_is_rejected_without_token_disclosure(tmp_path: Path) -> None:
    archive = _archive()
    manifest = _manifest(archive)
    with ReleaseServer(manifest, archive) as hostile:
        with ReleaseServer(manifest, archive) as server:
            server.asset_base_url = hostile.base_url
            result, github_env = _run(server, tmp_path, hashlib.sha256(manifest).hexdigest())

    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert "unsafe origin" in output.lower()
    assert "test-secret-token" not in output
    assert server.base_url not in output
    assert hostile.base_url not in output
    assert hostile.requests == []
    assert not github_env.exists() or not github_env.read_text(encoding="utf-8").strip()


def test_release_environment_injection_is_rejected_before_request(tmp_path: Path) -> None:
    archive = _archive()
    manifest = _manifest(archive)
    with ReleaseServer(manifest, archive) as server:
        result, github_env = _run(
            server,
            tmp_path,
            hashlib.sha256(manifest).hexdigest(),
            release=f"{RELEASE}\nINJECTED=value",
        )

    assert result.returncode != 0
    assert server.requests == []
    assert not github_env.exists() or "INJECTED=" not in github_env.read_text(encoding="utf-8")


def test_missing_token_fails_before_request_without_secret_leak(tmp_path: Path) -> None:
    archive = _archive()
    manifest = _manifest(archive)
    with ReleaseServer(manifest, archive) as server:
        result, github_env = _run(
            server, tmp_path, hashlib.sha256(manifest).hexdigest(), token=None
        )

    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert "ALBUM_HAVEN_FIXTURES_TOKEN" in output
    assert "test-secret-token" not in output
    assert server.base_url not in output
    assert server.requests == []
    assert not github_env.exists() or not github_env.read_text(encoding="utf-8").strip()


def test_cache_hit_creates_distinct_writable_isolated_extractions(tmp_path: Path) -> None:
    archive = _archive()
    manifest = _manifest(archive)
    manifest_sha = hashlib.sha256(manifest).hexdigest()
    with ReleaseServer(manifest, archive) as server:
        first, first_env = _run(server, tmp_path, manifest_sha, github_env_name="first.env")
        second, second_env = _run(server, tmp_path, manifest_sha, github_env_name="second.env")

    assert first.returncode == second.returncode == 0, first.stderr + second.stderr
    assert sum(path == "/assets/archive" for path, _ in server.requests) == 1
    first_root = Path(_exports(first_env)["ALBUM_HAVEN_FIXTURE_ROOT"])
    second_root = Path(_exports(second_env)["ALBUM_HAVEN_FIXTURE_ROOT"])
    assert first_root != second_root
    first_track = first_root / "media" / "track.mp3"
    second_track = second_root / "media" / "track.mp3"
    first_track.write_bytes(b"mutated")
    assert second_track.read_bytes() == b"audio"
    second_track.write_bytes(b"second-mutation")
    assert first_track.read_bytes() == b"mutated"
    cached_archives = list((tmp_path / "runner-temp").glob("**/functional-core.zip"))
    assert len(cached_archives) == 1
    assert hashlib.sha256(cached_archives[0].read_bytes()).hexdigest() == hashlib.sha256(archive).hexdigest()


def test_concurrent_jobs_publish_or_revalidate_one_immutable_cache_entry(tmp_path: Path) -> None:
    archive = _archive()
    manifest = _manifest(archive)
    manifest_sha = hashlib.sha256(manifest).hexdigest()
    with ReleaseServer(manifest, archive) as server:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    _run,
                    server,
                    tmp_path,
                    manifest_sha,
                    github_env_name=f"concurrent-{index}.env",
                )
                for index in range(2)
            ]
            results = [future.result(timeout=45) for future in futures]

    assert all(result.returncode == 0 for result, _ in results), "\n".join(
        result.stderr for result, _ in results
    )
    roots = [Path(_exports(env_file)["ALBUM_HAVEN_FIXTURE_ROOT"]) for _, env_file in results]
    assert roots[0] != roots[1]
    assert 1 <= sum(path == "/assets/archive" for path, _ in server.requests) <= 2
    cached_archives = list((tmp_path / "runner-temp").glob("**/functional-core.zip"))
    assert len(cached_archives) == 1
    assert hashlib.sha256(cached_archives[0].read_bytes()).hexdigest() == hashlib.sha256(archive).hexdigest()
