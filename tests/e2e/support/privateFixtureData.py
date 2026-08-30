from __future__ import annotations

import hashlib
import os
from pathlib import Path


TEST_DATA_ROOT_ENV = "ALBUM_HAVEN_TEST_DATA_ROOT"


def resolve_approved_cover_by_sha256(expected_sha256: str) -> Path:
    normalized_hash = str(expected_sha256 or "").strip().lower()
    configured_root = str(os.environ.get(TEST_DATA_ROOT_ENV) or "").strip()
    if not configured_root:
        raise RuntimeError(
            "Private cover fixtures are opt-in. Set ALBUM_HAVEN_TEST_DATA_ROOT "
            "to an album-haven-test-data source checkout."
        )

    approved_root = (
        Path(configured_root).expanduser().resolve(strict=False)
        / "assets"
        / "approved-covers"
    )
    if not approved_root.is_dir():
        raise RuntimeError(
            "ALBUM_HAVEN_TEST_DATA_ROOT must contain assets/approved-covers."
        )

    for candidate in sorted(path for path in approved_root.iterdir() if path.is_file()):
        actual_hash = hashlib.sha256(candidate.read_bytes()).hexdigest()
        if actual_hash == normalized_hash:
            return candidate

    raise RuntimeError(
        f"Private approved covers do not contain expected SHA-256 {normalized_hash}."
    )
