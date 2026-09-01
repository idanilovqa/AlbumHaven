from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from tests.e2e.support import privateFixtureData


def test_private_fixture_root_requires_explicit_opt_in(monkeypatch):
    monkeypatch.delenv(privateFixtureData.TEST_DATA_ROOT_ENV, raising=False)

    with pytest.raises(RuntimeError, match="ALBUM_HAVEN_TEST_DATA_ROOT"):
        privateFixtureData.resolve_approved_cover_by_sha256("0" * 64)


def test_private_fixture_resolver_finds_only_hash_verified_approved_cover(
    tmp_path: Path,
    monkeypatch,
):
    approved_root = tmp_path / "assets" / "approved-covers"
    approved_root.mkdir(parents=True)
    expected_file = approved_root / "private-name.png"
    expected_file.write_bytes(b"approved fixture bytes")
    expected_hash = hashlib.sha256(expected_file.read_bytes()).hexdigest()
    (approved_root / "different.png").write_bytes(b"different bytes")
    monkeypatch.setenv(privateFixtureData.TEST_DATA_ROOT_ENV, str(tmp_path))

    assert privateFixtureData.resolve_approved_cover_by_sha256(expected_hash) == expected_file


def test_private_fixture_resolver_reports_missing_expected_hash(tmp_path: Path, monkeypatch):
    approved_root = tmp_path / "assets" / "approved-covers"
    approved_root.mkdir(parents=True)
    (approved_root / "wrong.png").write_bytes(b"wrong bytes")
    monkeypatch.setenv(privateFixtureData.TEST_DATA_ROOT_ENV, str(tmp_path))

    with pytest.raises(RuntimeError, match="expected SHA-256"):
        privateFixtureData.resolve_approved_cover_by_sha256("f" * 64)


def test_private_fixture_resolver_accepts_dedicated_released_cover_root(
    tmp_path: Path,
    monkeypatch,
):
    approved_root = tmp_path / "released-approved-covers"
    approved_root.mkdir()
    expected_file = approved_root / "approved.jpg"
    expected_file.write_bytes(b"released approved cover")
    expected_hash = hashlib.sha256(expected_file.read_bytes()).hexdigest()
    monkeypatch.delenv(privateFixtureData.TEST_DATA_ROOT_ENV, raising=False)
    monkeypatch.setenv("ALBUM_HAVEN_APPROVED_COVER_ROOT", str(approved_root))

    assert privateFixtureData.resolve_approved_cover_by_sha256(expected_hash) == expected_file
