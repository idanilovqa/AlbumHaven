from pathlib import Path

import pytest

from music_app.services import generated_preview_storage as storage_module
from music_app.services.generated_preview_storage import (
    PreviewStoragePolicy,
    PreviewStorageSnapshot,
    is_managed_preview_path,
    managed_preview_relative_path,
    validate_custom_root,
)


def snapshot(**overrides):
    values = {
        "mode": "album_folders",
        "active_root": None,
        "requested_mode": None,
        "requested_root": None,
        "operation_state": "idle",
    }
    values.update(overrides)
    return PreviewStorageSnapshot(**values)


def test_record_generated_preview_uses_canonical_album_path_and_content_hash(tmp_path):
    source_path = tmp_path / "Music" / "Artist" / "Album" / "cover.jpg"
    preview_path = (
        tmp_path
        / "Generated Previews"
        / "v1"
        / "cover_variants"
        / "aa"
        / "aabb.jpg"
    )
    preview_path.parent.mkdir(parents=True)
    preview_path.write_bytes(b"published-preview")
    recorded = []

    class Repository:
        def record_inventory(self, **metadata):
            recorded.append(metadata)

    storage_module.record_generated_preview(
        Repository(), source_path, preview_path
    )

    assert recorded == [
        {
            "album_preview_path": str(
                source_path.parent
                / ".album-haven"
                / "cover_variants"
                / "aa"
                / "aabb.jpg"
            ),
            "managed_relative_path": "v1/cover_variants/aa/aabb.jpg",
            "byte_count": len(b"published-preview"),
            "sha256": "c4b34f40b6f92d609dfbc4acb89544dc769d2c81bee2ec34d79256104f2bd9a9",
        }
    ]


def test_album_folder_policy_preserves_existing_cache_layout(tmp_path):
    source = tmp_path / "Music" / "Artist" / "Album" / "cover.jpg"
    policy = PreviewStoragePolicy(snapshot())

    assert policy.write_cache_root(source) == source.parent / ".album-haven"
    assert policy.read_cache_roots(source) == (source.parent / ".album-haven",)


def test_custom_policy_uses_versioned_hash_sharded_root(tmp_path):
    source = tmp_path / "Music" / "Artist" / "Album" / "cover.jpg"
    custom = tmp_path / "Generated Previews"
    policy = PreviewStoragePolicy(snapshot(mode="custom", active_root=custom))

    assert policy.write_cache_root(source) == custom / "v1"
    assert policy.read_cache_roots(source) == (custom / "v1",)


@pytest.mark.parametrize(
    ("active_mode", "active_root", "requested_mode", "requested_root", "expected"),
    [
        ("album_folders", None, "custom", "D:/previews", (Path("D:/previews/v1"), None)),
        ("custom", "D:/previews", "album_folders", None, (None, Path("D:/previews/v1"))),
    ],
)
def test_relocation_reads_target_before_source(
    tmp_path, active_mode, active_root, requested_mode, requested_root, expected
):
    source = tmp_path / "Artist" / "Album" / "cover.jpg"
    album_root = source.parent / ".album-haven"
    expected_roots = tuple(album_root if item is None else item for item in expected)
    policy = PreviewStoragePolicy(
        snapshot(
            mode=active_mode,
            active_root=active_root,
            requested_mode=requested_mode,
            requested_root=requested_root,
            operation_state="running",
        )
    )

    assert policy.write_cache_root(source) == expected_roots[0]
    assert policy.read_cache_roots(source) == expected_roots


def test_canceled_relocation_reads_partial_target_but_writes_active_location(tmp_path):
    source = tmp_path / "Music" / "Artist" / "Album" / "cover.jpg"
    custom_root = tmp_path / "Generated Previews"
    policy = PreviewStoragePolicy(
        snapshot(
            mode="album_folders",
            requested_mode="custom",
            requested_root=custom_root,
            operation_state="canceled",
        )
    )

    assert policy.write_cache_root(source) == source.parent / ".album-haven"
    assert policy.read_cache_roots(source) == (
        custom_root / "v1",
        source.parent / ".album-haven",
    )


def test_managed_relative_path_normalizes_legacy_and_versioned_layouts(tmp_path):
    legacy = tmp_path / ".album-haven" / "cover_variants" / "ab" / "abcdef.webp"
    versioned = tmp_path / "v1" / "cover_variants" / "ab" / "abcdef.webp"

    expected = Path("v1/cover_variants/ab/abcdef.webp")
    assert managed_preview_relative_path(legacy) == expected
    assert managed_preview_relative_path(versioned) == expected
    assert managed_preview_relative_path(tmp_path / "cover.jpg") is None


def test_managed_preview_classifier_requires_the_internal_marker_boundary(tmp_path):
    assert is_managed_preview_path(
        tmp_path / "Album/.album-haven/cover_variants/ab/abcdef.webp"
    )
    assert is_managed_preview_path(
        tmp_path / "Album/.album-haven/v1/cover_variants/ab/abcdef.webp"
    )
    assert not is_managed_preview_path(tmp_path / "Album/.album-haven/cover.jpg")
    assert not is_managed_preview_path(tmp_path / "Album/cover_variants/abcdef.webp")


def test_policy_classifies_both_active_and_requested_custom_roots(tmp_path):
    active = tmp_path / "active"
    requested = tmp_path / "requested"
    policy = PreviewStoragePolicy(
        snapshot(
            mode="custom",
            active_root=active,
            requested_mode="custom",
            requested_root=requested,
            operation_state="running",
        )
    )

    assert policy.is_managed_preview_path(active / "v1/cover_variants/ab/abcdef.webp")
    assert policy.is_managed_preview_path(requested / "v1/cover_variants/ab/abcdef.webp")
    assert not policy.is_managed_preview_path(requested / "cover.jpg")


def test_custom_root_validation_rejects_relative_nested_and_unwritable_paths(tmp_path):
    library_root = tmp_path / "Music"
    with pytest.raises(ValueError, match="absolute"):
        validate_custom_root(Path("relative/previews"), [library_root])
    with pytest.raises(ValueError, match="music root"):
        validate_custom_root(library_root / "previews", [library_root])
    with pytest.raises(ValueError, match="writable"):
        validate_custom_root(
            tmp_path / "previews", [library_root], probe=lambda _path: False
        )


def test_custom_root_validation_accepts_an_absolute_root_through_injected_probe(tmp_path):
    requested = tmp_path / "previews"
    assert validate_custom_root(
        requested,
        [tmp_path / "Music"],
        probe=lambda path: path == requested.resolve(strict=False),
    ) == requested.resolve(strict=False)
