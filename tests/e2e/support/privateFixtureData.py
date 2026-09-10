from __future__ import annotations

import hashlib
import os
from pathlib import Path


TEST_DATA_ROOT_ENV = "ALBUM_HAVEN_TEST_DATA_ROOT"
APPROVED_COVER_ROOT_ENV = "ALBUM_HAVEN_APPROVED_COVER_ROOT"


def resolve_approved_cover_by_sha256(expected_sha256: str) -> Path:
    normalized_hash = str(expected_sha256 or "").strip().lower()
    released_root = str(os.environ.get(APPROVED_COVER_ROOT_ENV) or "").strip()
    configured_root = str(os.environ.get(TEST_DATA_ROOT_ENV) or "").strip()
    if released_root:
        approved_root = Path(released_root).expanduser().resolve(strict=False)
    elif configured_root:
        approved_root = (
            Path(configured_root).expanduser().resolve(strict=False)
            / "assets"
            / "approved-covers"
        )
    else:
        raise RuntimeError(
            "Private cover fixtures are opt-in. Set ALBUM_HAVEN_APPROVED_COVER_ROOT "
            "to a verified released cover directory or ALBUM_HAVEN_TEST_DATA_ROOT "
            "to an album-haven-test-data source checkout."
        )
    if not approved_root.is_dir():
        raise RuntimeError(
            "The configured approved-cover fixture directory does not exist."
        )

    for candidate in sorted(path for path in approved_root.iterdir() if path.is_file()):
        actual_hash = hashlib.sha256(candidate.read_bytes()).hexdigest()
        if actual_hash == normalized_hash:
            return candidate

    raise RuntimeError(
        f"Private approved covers do not contain expected SHA-256 {normalized_hash}."
    )
