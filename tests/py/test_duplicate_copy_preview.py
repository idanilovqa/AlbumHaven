"""Focused contracts for path-free duplicate-copy deletion previews."""

from datetime import datetime, timezone
import asyncio
import json
from types import SimpleNamespace

import pytest

from music_app.services.duplicate_copy_preview import (
    DuplicateCopyPreviewConflict,
    DuplicateCopyPreviewService,
)
from music_app.services.duplicate_copy_review import DuplicateCopyReferenceService


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _Connection:
    def __init__(self, rows):
        self._rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def execute(self, _query, _params):
        return _Result(self._rows)


def _row(file_id, root_id, root_path, path):
    stat = path.stat()
    now = datetime.now(timezone.utc)
    return {
        "id": file_id,
        "track_id": file_id + 100,
        "library_root_id": root_id,
        "private_path": str(path),
        "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc),
        "file_size_bytes": stat.st_size,
        "last_seen_at": now,
        "root_path": str(root_path),
        "configured_root_id": f"root-{root_id}",
        "is_active": True,
        "scan_cache_stale": False,
        "source": "runtime_scan_cache",
    }


def test_preview_binds_current_generation_and_reports_path_free_folder_counts(tmp_path):
    roots = [tmp_path / "main", tmp_path / "hoard"]
    files = []
    for root in roots:
        release = root / "Artist" / "Release"
        release.mkdir(parents=True)
        audio = release / "01.flac"
        audio.write_bytes(b"audio")
        files.append(audio)
    (files[0].parent / "cover.jpg").write_bytes(b"cover")
    rows = [_row(index, index, root, path) for index, (root, path) in enumerate(zip(roots, files), 1)]
    config = {"hmac": {"secret": "s" * 32, "key_version": 7}}
    copy_ref = DuplicateCopyReferenceService(config).issue(
        library_id=5,
        album_key="album:key",
        paths=[str(files[0])],
    )
    service = DuplicateCopyPreviewService(config, connect=lambda _url: _Connection(rows))

    preview = service.preview(library_id=5, album_key="album:key", copy_ref=copy_ref)

    assert preview == {
        "indexed_audio_file_count": 1,
        "other_file_count": 1,
        "surviving_copy_count": 1,
        "confirmation_ref": preview["confirmation_ref"],
    }
    assert preview["confirmation_ref"].startswith("dcc1.7.")
    assert "private_path" not in json.dumps(preview)
    assert str(tmp_path) not in json.dumps(preview)


def test_preview_rejects_stale_copy_reference_and_missing_survivor(tmp_path):
    root = tmp_path / "main"
    release = root / "Release"
    release.mkdir(parents=True)
    first = release / "01.flac"
    second = release / "02.flac"
    first.write_bytes(b"one")
    second.write_bytes(b"two")
    config = {"hmac": {"secret": "s" * 32, "key_version": 7}}
    ref = DuplicateCopyReferenceService(config).issue(
        library_id=5,
        album_key="album:key",
        paths=[str(first)],
    )
    service = DuplicateCopyPreviewService(
        config,
        connect=lambda _url: _Connection([_row(1, 1, root, first), _row(2, 1, root, second)]),
    )

    with pytest.raises(DuplicateCopyPreviewConflict, match="changed"):
        service.preview(library_id=5, album_key="album:key", copy_ref=ref)


def test_preview_rejects_survivor_that_disappeared_after_inventory(tmp_path):
    roots = [tmp_path / "main", tmp_path / "hoard"]
    files = []
    for root in roots:
        release = root / "Release"
        release.mkdir(parents=True)
        audio = release / "01.flac"
        audio.write_bytes(b"audio")
        files.append(audio)
    rows = [_row(index, index, root, path) for index, (root, path) in enumerate(zip(roots, files), 1)]
    config = {"hmac": {"secret": "s" * 32, "key_version": 7}}
    ref = DuplicateCopyReferenceService(config).issue(
        library_id=5,
        album_key="album:key",
        paths=[str(files[0])],
    )
    files[1].unlink()
    service = DuplicateCopyPreviewService(config, connect=lambda _url: _Connection(rows))

    with pytest.raises(DuplicateCopyPreviewConflict, match="changed"):
        service.preview(library_id=5, album_key="album:key", copy_ref=ref)


def test_preview_never_scopes_an_entire_configured_library_root(tmp_path):
    roots = [tmp_path / "main", tmp_path / "hoard"]
    files = []
    for root in roots:
        root.mkdir()
        audio = root / "01.flac"
        audio.write_bytes(b"audio")
        files.append(audio)
    rows = [_row(index, index, root, path) for index, (root, path) in enumerate(zip(roots, files), 1)]
    config = {"hmac": {"secret": "s" * 32, "key_version": 7}}
    ref = DuplicateCopyReferenceService(config).issue(
        library_id=5,
        album_key="album:key",
        paths=[str(files[0])],
    )
    service = DuplicateCopyPreviewService(config, connect=lambda _url: _Connection(rows))

    with pytest.raises(DuplicateCopyPreviewConflict, match="changed"):
        service.preview(library_id=5, album_key="album:key", copy_ref=ref)


def test_preview_route_requires_both_delete_actions_and_returns_no_store(monkeypatch):
    from music_app.routes import api_read_asgi_routes as routes

    required = []

    def require(action, **_options):
        async def check(_request):
            required.append(action)
        return check

    class Preview:
        def __init__(self, config):
            assert config["hmac"]["key_version"] == 7

        def preview(self, **values):
            assert values == {"library_id": 5, "album_key": "album:key", "copy_ref": "dcr1.7.token"}
            return {"indexed_audio_file_count": 1, "other_file_count": 0,
                    "surviving_copy_count": 1, "confirmation_ref": "dcc1.7.token"}

    monkeypatch.setattr(routes, "require_action", require)
    monkeypatch.setattr(routes, "DuplicateCopyPreviewService", Preview)
    request = SimpleNamespace(
        query_params={"album_key": "album:key", "copy_ref": "dcr1.7.token"},
        state=SimpleNamespace(current_actor=SimpleNamespace(current_library_id=5)),
        app=SimpleNamespace(state=SimpleNamespace(
            config={},
            auth_policy_config={"hmac": {"secret": "s" * 32, "key_version": 7}},
        )),
    )

    response = asyncio.run(routes.utilities_duplicate_copy_preview(request))

    assert required == ["library.inventory.manage", "library.covers.delete"]
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert json.loads(response.body) == {
        "ok": True,
        "preview": {"indexed_audio_file_count": 1, "other_file_count": 0,
                    "surviving_copy_count": 1, "confirmation_ref": "dcc1.7.token"},
    }
