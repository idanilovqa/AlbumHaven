"""Additive local descriptor/race tests; authored statically, root executes."""
from dataclasses import FrozenInstanceError, replace
import hashlib
from io import BytesIO
import os
from pathlib import Path
import stat

import pytest
from PIL import Image

from music_app.services import public_top_artwork_acquisition as acquisition


@pytest.fixture
def source(tmp_path):
    try:
        acquisition._require_platform()
    except acquisition.ArtworkAcquisitionUnavailable:
        pytest.skip("descriptor-relative POSIX filesystem is required")
    root = tmp_path / "admitted"
    cover = root / "album" / "cover.png"
    cover.parent.mkdir(parents=True)
    with Image.new("RGB", (512, 256), "red") as image:
        image.save(cover)
    return root, cover, describe(root, cover)


def describe(root, cover, **changes):
    return acquisition.describe_artwork_source(**{
        "library_id": 23, "local_album_id": 47, "artwork_root_id": 61,
        "artwork_root_path": root, "stored_cover_path": str(cover),
        "resolved_cover_path": cover, **changes})


def patch_open(monkeypatch, function):
    supported = acquisition.os.supports_dir_fd | {function}
    monkeypatch.setattr(acquisition.os, "open", function)
    monkeypatch.setattr(acquisition.os, "supports_dir_fd", supported)


def test_capture_is_exact_bounded_png_with_separate_artwork_root(source):
    root, cover, descriptor = source
    assert descriptor.artwork_root_id == 61
    assert descriptor.relative_parts == ("album", "cover.png")
    assert (descriptor.root_device, descriptor.root_inode) == (
        root.stat().st_dev, root.stat().st_ino)
    result = acquisition.capture_artwork(descriptor)
    assert result.source is descriptor
    assert (result.width, result.height) == (256, 128)
    assert result.sanitizer_contract == 1
    assert result.mime_type == "image/png"
    assert result.content_digest == hashlib.sha256(result.png).hexdigest()
    assert result.input_bytes == cover.stat().st_size
    assert result.input_pixels == 512 * 256
    assert len(result.png) <= 320 * 1024
    assert result.file_observation.inode == cover.stat().st_ino
    with Image.open(BytesIO(result.png)) as image:
        assert image.info == {}
        assert image.getpixel((0, 0)) == (255, 0, 0)


def test_descriptor_and_capture_are_frozen(source):
    root, cover, descriptor = source
    with pytest.raises(FrozenInstanceError):
        descriptor.artwork_root_id = 99
    result = acquisition.capture_artwork(descriptor)
    with pytest.raises(FrozenInstanceError):
        result.png = b"different"


def test_describing_selection_reads_no_file_bytes(source, monkeypatch):
    root, cover, descriptor = source
    real = os.open
    def only_directories(path, flags, **kwargs):
        assert flags & os.O_DIRECTORY
        return real(path, flags, **kwargs)
    patch_open(monkeypatch, only_directories)
    assert describe(root, cover) == descriptor


def test_fresh_descriptor_detects_selection_and_root_changes(source):
    root, cover, descriptor = source
    assert describe(root, cover) == descriptor
    assert describe(root, cover, stored_cover_path="album/cover.png") != descriptor
    assert describe(root, cover, artwork_root_id=62) != descriptor
    assert describe(root, cover, local_album_id=48) != descriptor
    replacement = root.with_name("retired")
    root.rename(replacement)
    root.mkdir()
    assert describe(root, cover) != descriptor
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable, match="artwork_source_changed"):
        acquisition.capture_artwork(descriptor)


def test_disk_edit_after_capture_does_not_change_prepared_bytes(source):
    root, cover, descriptor = source
    captured = acquisition.capture_artwork(descriptor)
    before = captured.png
    with Image.new("RGB", (10, 10), "blue") as image:
        image.save(cover)
    assert describe(root, cover) == descriptor
    assert captured.png == before
    assert hashlib.sha256(before).hexdigest() == captured.content_digest


@pytest.mark.parametrize("change", [
    {"library_id": True}, {"artwork_root_id": 0}, {"local_album_id": -1},
    {"stored_cover_path": ""}, {"stored_cover_path": "\x00"},
    {"stored_cover_path": "https://example.invalid/cover.png"},
    {"stored_cover_path": "file:///private/cover.png"},
    {"stored_cover_path": "  ftp://example.invalid/cover.png  "},
    {"artwork_root_path": Path("relative")},
    {"resolved_cover_path": Path("https://example.invalid/cover.png")},
])
def test_malformed_or_url_like_selection_is_rejected(source, change):
    root, cover, descriptor = source
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable):
        describe(root, cover, **change)


def test_outside_root_and_parent_traversal_are_rejected(source):
    root, cover, descriptor = source
    for other in (root.parent / "outside.png", root / ".." / "outside.png", root):
        with pytest.raises(acquisition.ArtworkAcquisitionUnavailable):
            describe(root, other)


def test_tampered_relative_parts_and_root_identity_are_rejected(source):
    root, cover, descriptor = source
    for changed in (replace(descriptor, relative_parts=("..", "outside.png")),
                    replace(descriptor, artwork_root_path=str(root) + "/."),
                    replace(descriptor, root_inode=True),
                    replace(descriptor, root_inode=descriptor.root_inode + 1)):
        with pytest.raises(acquisition.ArtworkAcquisitionUnavailable):
            acquisition.capture_artwork(changed)


def test_unsupported_platform_never_tries_a_fallback_open(monkeypatch):
    monkeypatch.setattr(acquisition.os, "supports_dir_fd", set())
    def forbidden(*args, **kwargs):
        raise AssertionError("unsupported platform attempted a pathname open")
    monkeypatch.setattr(acquisition.os, "open", forbidden)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable, match="artwork_platform_unavailable"):
        acquisition.capture_artwork(None)


@pytest.mark.parametrize("target", ["file", "descendant", "root", "ancestor"])
def test_symlink_at_any_level_is_rejected(source, tmp_path, target):
    root, cover, descriptor = source
    if target == "file":
        original = cover.with_name("original.png")
        cover.rename(original)
        cover.symlink_to(original)
    elif target == "descendant":
        original = root / "retired-album"
        cover.parent.rename(original)
        cover.parent.symlink_to(original, target_is_directory=True)
    elif target == "root":
        original = root.with_name("retired-root")
        root.rename(original)
        root.symlink_to(original, target_is_directory=True)
    else:
        # A separately admitted path still cannot contain a symlink ancestor.
        alias = tmp_path / "alias"
        alias.symlink_to(root, target_is_directory=True)
        with pytest.raises(acquisition.ArtworkAcquisitionUnavailable):
            describe(alias / "album", alias / "album" / "cover.png")
        return
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable):
        acquisition.capture_artwork(descriptor)


def test_fifo_is_rejected_before_open_or_read(source, monkeypatch):
    root, cover, descriptor = source
    cover.unlink()
    os.mkfifo(cover)
    real_open = os.open
    def no_file_open(path, flags, **kwargs):
        assert flags & os.O_DIRECTORY
        return real_open(path, flags, **kwargs)
    patch_open(monkeypatch, no_file_open)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable, match="artwork_not_regular"):
        acquisition.capture_artwork(descriptor)


def test_regular_to_fifo_open_race_is_nonblocking_and_never_read(source, monkeypatch):
    root, cover, descriptor = source
    real_open = os.open
    def replace_before_open(path, flags, **kwargs):
        if path == "cover.png":
            assert flags & os.O_NONBLOCK
            assert flags & os.O_NOFOLLOW
            cover.unlink()
            os.mkfifo(cover)
        return real_open(path, flags, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError("special-file bytes were read")
    patch_open(monkeypatch, replace_before_open)
    monkeypatch.setattr(acquisition.os, "read", forbidden)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable, match="artwork_not_regular"):
        acquisition.capture_artwork(descriptor)


def test_regular_to_symlink_open_race_never_reads_outside_root(source, tmp_path, monkeypatch):
    root, cover, descriptor = source
    outside = tmp_path / "outside.png"
    outside.write_bytes(cover.read_bytes())
    real_open = os.open
    def replace_before_open(path, flags, **kwargs):
        if path == "cover.png":
            cover.unlink()
            cover.symlink_to(outside)
        return real_open(path, flags, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError("out-of-root bytes were read")
    patch_open(monkeypatch, replace_before_open)
    monkeypatch.setattr(acquisition.os, "read", forbidden)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable):
        acquisition.capture_artwork(descriptor)


def test_directory_replacement_after_open_is_detected_before_file_read(source, monkeypatch):
    root, cover, descriptor = source
    real_open = os.open
    def replace_after_open(path, flags, **kwargs):
        fd = real_open(path, flags, **kwargs)
        if path == "album":
            cover.parent.rename(root / "retired-album")
            cover.parent.mkdir()
        return fd
    def forbidden(*args, **kwargs):
        raise AssertionError("detached directory bytes were read")
    patch_open(monkeypatch, replace_after_open)
    monkeypatch.setattr(acquisition.os, "read", forbidden)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable, match="artwork_source_changed"):
        acquisition.capture_artwork(descriptor)


def test_path_replacement_after_open_is_detected_before_read(source, monkeypatch):
    root, cover, descriptor = source
    original = cover.read_bytes()
    real_open = os.open
    def replace_after_open(path, flags, **kwargs):
        fd = real_open(path, flags, **kwargs)
        if path == "cover.png":
            cover.rename(cover.with_suffix(".retired"))
            cover.write_bytes(original)
        return fd
    def forbidden(*args, **kwargs):
        raise AssertionError("changed pathname was read")
    patch_open(monkeypatch, replace_after_open)
    monkeypatch.setattr(acquisition.os, "read", forbidden)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable, match="artwork_source_changed"):
        acquisition.capture_artwork(descriptor)


def test_in_place_mutation_during_read_rejects_capture(source, monkeypatch):
    root, cover, descriptor = source
    real_read = os.read
    changed = False
    def mutate(fd, count):
        nonlocal changed
        value = real_read(fd, count)
        if not changed:
            changed = True
            with cover.open("ab") as output:
                output.write(b"changed")
        return value
    monkeypatch.setattr(acquisition.os, "read", mutate)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable, match="artwork_source_changed"):
        acquisition.capture_artwork(descriptor)


def test_change_during_decode_rejects_capture(source, monkeypatch):
    root, cover, descriptor = source
    real = acquisition.sanitize_artwork_pixels
    def mutate(payload, **limits):
        result = real(payload, **limits)
        cover.unlink()
        return result
    monkeypatch.setattr(acquisition, "sanitize_artwork_pixels", mutate)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable):
        acquisition.capture_artwork(descriptor)


def test_source_size_limit_is_checked_before_read(source, monkeypatch):
    root, cover, descriptor = source
    with cover.open("wb") as output:
        output.truncate(acquisition.MAX_INPUT_BYTES + 1)
    def forbidden(*args, **kwargs):
        raise AssertionError("oversize source was read")
    monkeypatch.setattr(acquisition.os, "read", forbidden)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable, match="artwork_input_limit"):
        acquisition.capture_artwork(descriptor)


def test_capture_passes_exact_public_budgets_to_shared_sanitizer(source, monkeypatch):
    root, cover, descriptor = source
    real = acquisition.sanitize_artwork_pixels
    calls = []
    def checked(payload, **limits):
        calls.append(limits)
        return real(payload, **limits)
    monkeypatch.setattr(acquisition, "sanitize_artwork_pixels", checked)
    acquisition.capture_artwork(descriptor)
    assert calls == [{"max_input_bytes": 16 * 1024 * 1024,
                      "max_pixels": 16_000_000, "max_edge": 256,
                      "max_output_bytes": 320 * 1024}]


def test_read_overflow_is_bounded_even_if_file_grows(source, monkeypatch):
    root, cover, descriptor = source
    requests = []
    def overflowing(fd, count):
        requests.append(count)
        return b"x" * count
    monkeypatch.setattr(acquisition.os, "read", overflowing)
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable, match="artwork_input_limit"):
        acquisition.capture_artwork(descriptor)
    assert sum(requests) == acquisition.MAX_INPUT_BYTES + 1
    assert max(requests) <= 64 * 1024


@pytest.mark.parametrize("fail", [False, True])
def test_every_opened_descriptor_closes_on_success_and_decode_error(source, monkeypatch, fail):
    root, cover, descriptor = source
    opened, closed = [], []
    real_open, real_close = os.open, os.close
    def tracked_open(path, flags, **kwargs):
        fd = real_open(path, flags, **kwargs)
        opened.append(fd)
        assert not os.get_inheritable(fd)
        return fd
    def tracked_close(fd):
        closed.append(fd)
        return real_close(fd)
    patch_open(monkeypatch, tracked_open)
    monkeypatch.setattr(acquisition.os, "close", tracked_close)
    if fail:
        cover.write_bytes(b"not an image")
        with pytest.raises(acquisition.ArtworkAcquisitionUnavailable):
            acquisition.capture_artwork(descriptor)
    else:
        acquisition.capture_artwork(descriptor)
    assert closed == list(reversed(opened))


def test_exact_public_file_input_limit_is_accepted(source):
    root, cover, descriptor = source
    original = cover.read_bytes()
    cover.write_bytes(original + b"x" * (acquisition.MAX_INPUT_BYTES - len(original)))
    result = acquisition.capture_artwork(descriptor)
    assert result.input_bytes == acquisition.MAX_INPUT_BYTES
    assert b"x" * 1000 not in result.png


def test_decode_failure_does_not_include_private_path(source):
    root, cover, descriptor = source
    cover.write_bytes(b"broken-private-image")
    with pytest.raises(acquisition.ArtworkAcquisitionUnavailable) as error:
        acquisition.capture_artwork(descriptor)
    assert str(root) not in str(error.value)
    assert str(cover) not in str(error.value)
