from __future__ import annotations

import json
from pathlib import Path

import pytest

from music_app.services.json_files import load_json_file, save_json_file


def test_load_json_file_returns_default_for_missing_file_without_creating_parent(tmp_path):
    path = tmp_path / "missing" / "store.json"

    assert load_json_file(path, default={"items": []}) == {"items": []}
    assert not path.parent.exists()


def test_load_json_file_can_default_or_raise_for_malformed_payload(tmp_path):
    path = tmp_path / "store.json"
    path.write_text("{not-json", encoding="utf-8")

    assert load_json_file(
        path,
        default={"items": []},
        malformed="default",
    ) == {"items": []}

    with pytest.raises(json.JSONDecodeError):
        load_json_file(path, default={"items": []}, malformed="raise")


def test_load_json_file_rejects_unknown_malformed_policy_before_reading(tmp_path):
    path = tmp_path / "store.json"
    path.write_text('{"ok": true}', encoding="utf-8")

    with pytest.raises(ValueError, match="Unsupported malformed JSON policy"):
        load_json_file(path, default={}, malformed="quiet")


def test_save_json_file_creates_parent_and_writes_stable_utf8_json(tmp_path):
    path = tmp_path / "nested" / "store.json"

    save_json_file(path, {"b": 2, "a": "Kino"})

    assert path.read_text(encoding="utf-8") == '{\n  "a": "Kino",\n  "b": 2\n}'


def test_save_json_file_replaces_existing_file_atomically(tmp_path):
    path = tmp_path / "store.json"
    path.write_text('{"old": true}', encoding="utf-8")

    save_json_file(path, {"new": True})

    assert json.loads(path.read_text(encoding="utf-8")) == {"new": True}
    assert list(tmp_path.glob(".store.json.*.tmp")) == []


def test_save_json_file_preserves_existing_file_when_replace_fails(tmp_path, monkeypatch):
    path = tmp_path / "store.json"
    path.write_text('{"old": true}', encoding="utf-8")

    def fail_replace(self: Path, target: Path):
        raise PermissionError("locked")

    monkeypatch.setattr(Path, "replace", fail_replace)

    with pytest.raises(PermissionError):
        save_json_file(path, {"new": True})

    assert path.read_text(encoding="utf-8") == '{"old": true}'
    assert list(tmp_path.glob(".store.json.*.tmp")) == []


def test_save_json_file_retries_transient_permission_error(tmp_path, monkeypatch):
    path = tmp_path / "store.json"
    path.write_text('{"old": true}', encoding="utf-8")
    original_replace = Path.replace
    attempts = 0

    def flaky_replace(self: Path, target: Path):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise PermissionError("temporarily locked")
        return original_replace(self, target)

    monkeypatch.setattr(Path, "replace", flaky_replace)

    save_json_file(path, {"new": True})

    assert attempts == 3
    assert json.loads(path.read_text(encoding="utf-8")) == {"new": True}
    assert list(tmp_path.glob(".store.json.*.tmp")) == []
