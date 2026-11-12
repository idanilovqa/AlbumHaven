"""Focused filesystem transaction contracts for confirmed duplicate removal."""

from datetime import datetime, timezone
import asyncio
import json
from types import SimpleNamespace

import pytest

from music_app.services.duplicate_copy_preview import DuplicateCopyPreviewService
from music_app.services.duplicate_copy_removal import (
    DuplicateCopyRemovalConflict,
    DuplicateCopyRemovalService,
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


class _Reservation:
    def __init__(self):
        self.released = False

    def release(self):
        self.released = True


def _row(file_id, root_id, root_path, path):
    result = path.stat()
    now = datetime.now(timezone.utc)
    return {
        "id": file_id,
        "track_id": file_id + 100,
        "library_root_id": root_id,
        "private_path": str(path),
        "modified_at": datetime.fromtimestamp(result.st_mtime, timezone.utc),
        "file_size_bytes": result.st_size,
        "last_seen_at": now,
        "root_path": str(root_path),
        "configured_root_id": f"root-{root_id}",
        "is_active": True,
        "scan_cache_stale": False,
        "source": "runtime_scan_cache",
    }


def _fixture(tmp_path):
    roots = [tmp_path / "main", tmp_path / "hoard"]
    files = []
    for root in roots:
        release = root / "Artist" / "Release"
        release.mkdir(parents=True)
        audio = release / "01.flac"
        audio.write_bytes(b"audio")
        files.append(audio)
    sidecar = files[0].parent / "cover.jpg"
    sidecar.write_bytes(b"cover")
    rows = [_row(index, index, root, path) for index, (root, path) in enumerate(zip(roots, files), 1)]
    config = {"hmac": {"secret": "s" * 32, "key_version": 7}}
    copy_ref = DuplicateCopyReferenceService(config).issue(
        library_id=5,
        album_key="album:key",
        paths=[str(files[0])],
    )
    confirmation_ref = DuplicateCopyPreviewService(
        config,
        connect=lambda _url: _Connection(rows),
    ).preview(library_id=5, album_key="album:key", copy_ref=copy_ref)["confirmation_ref"]
    return config, rows, files, sidecar, copy_ref, confirmation_ref


def test_removal_deletes_entire_album_folder_after_inventory_retirement(tmp_path):
    config, rows, files, sidecar, copy_ref, confirmation_ref = _fixture(tmp_path)
    reservation = _Reservation()
    calls = []

    class Publisher:
        def persist_targeted_inventory_mutation(self, **values):
            assert not files[0].parent.exists()
            assert files[1].exists()
            confirmation = values["confirmed_duplicate_removal"]
            assert confirmation.physical_deletion_confirmed is True
            assert len(confirmation.selected_files) == len(confirmation.survivor_files) == 1
            calls.append(values)
            return {"retired_file_count": 1, "affected_album_keys": ["album:key"],
                    "inventory_mutation_revision": 9}

    service = DuplicateCopyRemovalService(
        config,
        connect=lambda _url: _Connection(rows),
        publisher=Publisher(),
        reservation_acquirer=lambda _keys: reservation,
    )

    result = service.remove(
        library_id=5,
        album_key="album:key",
        copy_ref=copy_ref,
        confirmation_ref=confirmation_ref,
    )

    assert result == {"retired_file_count": 1, "affected_album_keys": ["album:key"],
                      "inventory_mutation_revision": 9}
    assert not files[0].parent.exists()
    assert not sidecar.exists()
    assert files[1].exists()
    assert calls[0]["root_id"] == "root-1"
    assert reservation.released is True
    assert not list(files[0].parent.parent.glob(".albumhaven-delete-*"))


def test_removal_restores_whole_folder_when_inventory_retirement_fails(tmp_path):
    config, rows, files, sidecar, copy_ref, confirmation_ref = _fixture(tmp_path)
    reservation = _Reservation()

    class Publisher:
        def persist_targeted_inventory_mutation(self, **_values):
            assert not files[0].parent.exists()
            raise RuntimeError("synthetic publication failure")

    service = DuplicateCopyRemovalService(
        config,
        connect=lambda _url: _Connection(rows),
        publisher=Publisher(),
        reservation_acquirer=lambda _keys: reservation,
    )

    with pytest.raises(RuntimeError, match="synthetic publication failure"):
        service.remove(
            library_id=5,
            album_key="album:key",
            copy_ref=copy_ref,
            confirmation_ref=confirmation_ref,
        )

    assert files[0].read_bytes() == b"audio"
    assert sidecar.read_bytes() == b"cover"
    assert not list(files[0].parent.parent.glob(".albumhaven-delete-*"))
    assert reservation.released is True


def test_removal_rejects_stale_confirmation_before_touching_folder(tmp_path):
    config, rows, files, sidecar, copy_ref, _confirmation_ref = _fixture(tmp_path)
    publisher_called = False

    class Publisher:
        def persist_targeted_inventory_mutation(self, **_values):
            nonlocal publisher_called
            publisher_called = True

    service = DuplicateCopyRemovalService(
        config,
        connect=lambda _url: _Connection(rows),
        publisher=Publisher(),
        reservation_acquirer=lambda _keys: _Reservation(),
    )

    with pytest.raises(DuplicateCopyRemovalConflict, match="changed"):
        service.remove(
            library_id=5,
            album_key="album:key",
            copy_ref=copy_ref,
            confirmation_ref="dcc1.7.stale",
        )

    assert files[0].exists() and sidecar.exists()
    assert publisher_called is False


def test_removal_reports_changed_physical_copy_as_conflict(tmp_path):
    config, rows, files, sidecar, copy_ref, confirmation_ref = _fixture(tmp_path)
    files[0].write_bytes(b"changed")
    service = DuplicateCopyRemovalService(
        config,
        connect=lambda _url: _Connection(rows),
        publisher=object(),
        reservation_acquirer=lambda _keys: _Reservation(),
    )

    with pytest.raises(DuplicateCopyRemovalConflict, match="changed"):
        service.remove(
            library_id=5,
            album_key="album:key",
            copy_ref=copy_ref,
            confirmation_ref=confirmation_ref,
        )

    assert files[0].exists() and sidecar.exists()


def test_removal_replays_unknown_publication_outcome_before_cleanup(tmp_path):
    config, rows, files, sidecar, copy_ref, confirmation_ref = _fixture(tmp_path)
    calls = 0

    class Publisher:
        def persist_targeted_inventory_mutation(self, **_values):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ConnectionError("lost commit acknowledgment")
            return {"retired_file_count": 0, "affected_album_keys": [],
                    "inventory_mutation_revision": 0}

    service = DuplicateCopyRemovalService(
        config,
        connect=lambda _url: _Connection(rows),
        publisher=Publisher(),
        reservation_acquirer=lambda _keys: _Reservation(),
    )

    service.remove(
        library_id=5,
        album_key="album:key",
        copy_ref=copy_ref,
        confirmation_ref=confirmation_ref,
    )

    assert calls == 2
    assert not files[0].parent.exists()
    assert not sidecar.exists()


def test_removal_hides_filesystem_details_when_folder_staging_fails(tmp_path, monkeypatch):
    config, rows, files, sidecar, copy_ref, confirmation_ref = _fixture(tmp_path)

    def fail_staging(_source, _target):
        raise OSError(f"cannot rename private path {files[0].parent}")

    monkeypatch.setattr(type(files[0].parent), "replace", fail_staging)
    service = DuplicateCopyRemovalService(
        config,
        connect=lambda _url: _Connection(rows),
        publisher=object(),
        reservation_acquirer=lambda _keys: _Reservation(),
    )

    with pytest.raises(DuplicateCopyRemovalConflict) as failure:
        service.remove(
            library_id=5,
            album_key="album:key",
            copy_ref=copy_ref,
            confirmation_ref=confirmation_ref,
        )

    assert str(files[0].parent) not in str(failure.value)
    assert files[0].exists() and sidecar.exists()


def test_removal_route_requires_both_delete_actions_and_exact_confirmation(monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as routes

    required = []
    received = []

    def require(action, **_options):
        async def check(_request):
            required.append(action)
        return check

    class Removal:
        def __init__(self, config):
            assert config["hmac"]["key_version"] == 7

        def remove(self, **values):
            received.append(values)
            return {"retired_file_count": 1, "affected_album_keys": ["album:key"],
                    "inventory_mutation_revision": 9}

    async def payload(_request):
        return {
            "album_key": "album:key",
            "copy_ref": "dcr1.7.copy",
            "confirmation_ref": "dcc1.7.confirmation",
            "confirmed": True,
        }

    monkeypatch.setattr(routes, "require_action", require)
    monkeypatch.setattr(routes, "_json_payload", payload)
    monkeypatch.setattr(routes, "DuplicateCopyRemovalService", Removal)
    request = SimpleNamespace(
        state=SimpleNamespace(current_actor=SimpleNamespace(current_library_id=5)),
        app=SimpleNamespace(state=SimpleNamespace(
            config={},
            auth_policy_config={"hmac": {"secret": "s" * 32, "key_version": 7}},
        )),
    )

    response = asyncio.run(routes.utilities_remove_duplicate_copy(request))

    assert required == ["library.inventory.manage", "library.covers.delete"]
    assert received == [{
        "library_id": 5,
        "album_key": "album:key",
        "copy_ref": "dcr1.7.copy",
        "confirmation_ref": "dcc1.7.confirmation",
    }]
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert json.loads(response.body)["result"]["retired_file_count"] == 1
