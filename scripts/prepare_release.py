from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from version import normalize_release_version, write_release_version


ROOT = Path(__file__).resolve().parents[1]
VERSION_PATH = ROOT / "version.py"
PACKAGE_JSON_PATH = ROOT / "package.json"
PACKAGE_LOCK_PATH = ROOT / "package-lock.json"
README_PATH = ROOT / "README.md"

_README_RELEASE_PATTERN = re.compile(r"(?m)^Current release:\s+`[^`]+`$")
_CHANGELOG_HEADING_PATTERN = r"(?m)^##\s+{version}\s+-\s+\d{{4}}-\d{{2}}-\d{{2}}\s*$"


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _update_package_version(path: Path, version: str) -> None:
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["version"] = version
    if isinstance(payload.get("packages"), dict):
        root_package = payload["packages"].get("")
        if isinstance(root_package, dict):
            root_package["version"] = version
    _write_json(path, payload)


def _update_readme_version(path: Path, version: str) -> None:
    contents = path.read_text(encoding="utf-8")
    match = _README_RELEASE_PATTERN.search(contents)
    if not match:
        raise RuntimeError("Could not find the README current release marker to update.")
    replacement = f"Current release: `{version}`"
    if match.group(0) == replacement:
        return
    updated = _README_RELEASE_PATTERN.sub(replacement, contents, count=1)
    path.write_text(updated, encoding="utf-8")


def _extract_changelog_section(contents: str, version: str) -> str:
    version_pattern = re.compile(_CHANGELOG_HEADING_PATTERN.format(version=re.escape(version)))
    match = version_pattern.search(contents)
    if not match:
        raise RuntimeError(
            f"Could not find a CHANGELOG.md section headed like '## {version} - YYYY-MM-DD'."
        )
    next_match = re.search(r"(?m)^##\s+", contents[match.end():])
    if not next_match:
        return contents[match.start():].strip() + "\n"
    end = match.end() + next_match.start()
    return contents[match.start():end].strip() + "\n"


def read_changelog_section(path: Path, version: str) -> str:
    return _extract_changelog_section(path.read_text(encoding="utf-8"), version)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Update Album Haven release version markers before a release.",
    )
    parser.add_argument("version", help="Release version in major.minor.patch format.")
    args = parser.parse_args()

    version = normalize_release_version(args.version)
    write_release_version(VERSION_PATH, version)
    _update_package_version(PACKAGE_JSON_PATH, version)
    _update_package_version(PACKAGE_LOCK_PATH, version)
    _update_readme_version(README_PATH, version)

    print(f"Prepared release version {version}.")
    print("Reminder: add or update the matching CHANGELOG.md heading before tagging the release.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
