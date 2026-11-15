from pathlib import Path

import pytest

from music_app.services import cover_state


def _candidate(root, name, *, square=True, digest="a" * 64):
    return {
        "path": str(root / name), "filename": name, "relative_path": name,
        "width": 600, "height": 600 if square else 300,
        "resolution": "600x600" if square else "600x300",
        "is_squareish": square, "is_active": False,
        "area": 360000 if square else 180000, "depth": 1, "sha256": digest,
    }


def _serialize_without_file_access(monkeypatch, root, inventory, entry=None):
    def forbidden(*args, **kwargs):
        raise AssertionError("Indexed gallery must not read the filesystem")

    track = str(root / "track.mp3")
    with monkeypatch.context() as patches:
        patches.setattr(cover_state.os, "scandir", forbidden)
        patches.setattr(cover_state, "_file_sha256", forbidden)
        patches.setattr(cover_state, "restrict_album_root_to_represented_disc", forbidden)
        patches.setattr(Path, "stat", forbidden)
        return cover_state.serialize_cover_gallery_payload(
            album_root=root, track_paths={track}, file_cache={track: entry or {}},
            image_extensions={".jpg"}, image_dimensions=forbidden,
            is_squareish_cover=lambda width, height: width == height,
            local_inventory=inventory,
        )


def test_indexed_gallery_has_exact_sections_and_selected_source_without_disk_reads(monkeypatch, tmp_path):
    candidates = [
        _candidate(tmp_path, "cover.jpg"),
        _candidate(tmp_path, "original.jpg"),
        _candidate(tmp_path, "booklet.jpg", square=False, digest="b" * 64),
    ]
    payload = _serialize_without_file_access(
        monkeypatch, tmp_path,
        {"available": True, "complete": True, "candidates": candidates},
        {"cover_path": str(tmp_path / "cover.jpg"), "cover_revision": "a" * 64},
    )
    assert [item["filename"] for item in payload["local_covers"]] == ["cover.jpg", "original.jpg"]
    assert [item["filename"] for item in payload["other_art"]] == ["booklet.jpg"]
    assert payload["selected_source_path"] == str(tmp_path / "original.jpg")
    assert payload["local_covers"][0]["is_active"] is True
    assert payload["local_covers"][1]["cover_revision"] == "a" * 64
    assert payload["local_inventory_complete"] is True
    assert payload["local_inventory_pending"] is False
    assert all(not item["is_active"] for item in candidates), "Serialization must not mutate stored inventory"


@pytest.mark.parametrize("inventory", [{"available": False}, {"available": False, "complete": False, "candidates": []}])
def test_unavailable_index_is_pending_never_an_empty_gallery(monkeypatch, tmp_path, inventory):
    payload = _serialize_without_file_access(monkeypatch, tmp_path, inventory)
    assert payload["local_inventory_pending"] is True
    assert payload["local_inventory_complete"] is False
    assert "local_covers" not in payload
    assert "other_art" not in payload


def test_incomplete_index_preserves_known_cards_while_refresh_is_pending(monkeypatch, tmp_path):
    payload = _serialize_without_file_access(
        monkeypatch, tmp_path,
        {"available": True, "complete": False, "candidates": [_candidate(tmp_path, "known.jpg")]},
    )
    assert [item["filename"] for item in payload["local_covers"]] == ["known.jpg"]
    assert payload["local_inventory_pending"] is True
    assert payload["local_inventory_complete"] is False


def test_successful_empty_index_is_immediately_empty_without_disk_reads(monkeypatch, tmp_path):
    payload = _serialize_without_file_access(
        monkeypatch, tmp_path, {"available": True, "complete": True, "candidates": []},
    )
    assert payload["local_covers"] == []
    assert payload["other_art"] == []
    assert payload["local_inventory_complete"] is True
    assert payload["local_inventory_pending"] is False


def test_initial_duplicate_bytes_do_not_infer_a_saved_art_choice(monkeypatch, tmp_path):
    payload = _serialize_without_file_access(
        monkeypatch, tmp_path,
        {"available": True, "complete": True, "candidates": [
            _candidate(tmp_path, "cover.jpg"), _candidate(tmp_path, "original.jpg"),
        ]},
        {"cover_path": str(tmp_path / "cover.jpg")},
    )
    assert payload["selected_source_path"] == str(tmp_path / "cover.jpg")
    assert payload["local_covers"][1]["duplicate_of"] == str(tmp_path / "cover.jpg")
    assert all("cover_revision" not in item for item in payload["local_covers"])


def test_indexed_gallery_keeps_selected_cover_stored_outside_album_root(monkeypatch, tmp_path):
    active = tmp_path / "art-store" / "selected.jpg"
    payload = _serialize_without_file_access(
        monkeypatch, tmp_path / "album",
        {"available": True, "complete": True, "candidates": []},
        {"cover_path": str(active), "cover_revision": "c" * 64,
         "local_cover_width": 512, "local_cover_height": 512},
    )
    assert len(payload["local_covers"]) == 1
    selected = payload["local_covers"][0]
    assert selected["path"] == str(active)
    assert selected["is_active"] is True
    assert selected["width"] == selected["height"] == 512
    assert payload["selected_source_path"] == str(active)


def test_partial_indexed_gallery_does_not_publish_stale_active_dimensions(monkeypatch, tmp_path):
    active = tmp_path / "album" / "selected.jpg"
    payload = _serialize_without_file_access(
        monkeypatch,
        tmp_path / "album",
        {"available": True, "complete": False, "candidates": []},
        {
            "cover_path": str(active),
            "cover_revision": "d" * 64,
            "local_cover_width": 599,
            "local_cover_height": 543,
        },
    )

    candidate = (payload["local_covers"] + payload["other_art"])[0]
    assert candidate["path"] == str(active)
    assert candidate["resolution"] == "Unknown"
    assert candidate["width"] == candidate["height"] == 0


def test_remote_only_progress_can_serialize_before_local_root_is_indexed(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        raise AssertionError("Remote-only progress must not resolve a local root")

    monkeypatch.setattr(cover_state, "restrict_album_root_to_represented_disc", forbidden)
    payload = cover_state.serialize_cover_gallery_payload(
        album_root=None, track_paths={str(tmp_path / "track.mp3")}, file_cache={},
        image_extensions={".jpg"}, image_dimensions=forbidden,
        is_squareish_cover=forbidden, include_local=False,
        task_payload={"id": "running-lookup", "status": "running"},
    )
    assert payload["ok"] is True
    assert payload["task"]["status"] == "running"
    assert payload["local_inventory_complete"] is False
    assert "local_covers" not in payload
    assert "other_art" not in payload


def test_indexed_gallery_excludes_external_managed_active_preview(monkeypatch, tmp_path):
    active = tmp_path / ".album-haven" / "v1" / "cover_variants" / "preview.jpg"
    payload = _serialize_without_file_access(
        monkeypatch, tmp_path / "album",
        {"available": True, "complete": True, "candidates": []},
        {"cover_path": str(active), "local_cover_width": 480, "local_cover_height": 480},
    )
    assert payload["local_covers"] == []
    assert payload["other_art"] == []
