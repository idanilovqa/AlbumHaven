from __future__ import annotations

import re
from pathlib import Path

RELEASE_VERSION = "0.9.41"

_SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
_RELEASE_LINE_PATTERN = re.compile(r'(?m)^RELEASE_VERSION = "[^"]+"[ \t]*\r?$')


def normalize_release_version(value: str) -> str:
    normalized = str(value or "").strip()
    if not _SEMVER_PATTERN.fullmatch(normalized):
        raise ValueError(f"Release version must use major.minor.patch semver, got: {value!r}")
    return normalized


def write_release_version(version_path: Path, value: str) -> None:
    normalized = normalize_release_version(value)
    release_line = f'RELEASE_VERSION = "{normalized}"'

    if not version_path.exists():
        version_path.write_text(release_line + "\n", encoding="utf-8")
        return

    contents = version_path.read_text(encoding="utf-8")
    match = _RELEASE_LINE_PATTERN.search(contents)
    if not match:
        raise RuntimeError("Could not find the RELEASE_VERSION assignment to update.")
    if match.group(0) == release_line:
        return
    updated = _RELEASE_LINE_PATTERN.sub(release_line, contents, count=1)
    version_path.write_text(updated, encoding="utf-8")
