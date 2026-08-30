from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PRODUCTION_ROOT = ROOT / "music_app"
def _source_files(root: Path, suffixes: set[str]) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.suffix in suffixes)


def test_production_source_does_not_observe_problematic_files_e2e_setup_seams():
    forbidden_markers = (
        "ALBUM_HAVEN_E2E_PROBLEMATIC_SEED_KEY",
        "ALBUM_HAVEN_E2E_PROBLEMATIC_FIXTURE_PATH",
        "e2e_problematic_file_fixture_seeds",
        '"/__e2e/',
        "'/__e2e/",
    )
    violations: list[str] = []
    for path in _source_files(PRODUCTION_ROOT, {".py", ".js"}):
        source = path.read_text(encoding="utf-8")
        for marker in forbidden_markers:
            if marker in source:
                violations.append(f"{path.relative_to(ROOT)}: {marker}")
    assert violations == []
