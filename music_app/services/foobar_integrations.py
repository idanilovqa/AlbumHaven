from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import mimetypes
import re


JsonDict = dict[str, object]

_FOOBAR_REFERENCE_DIR = Path(__file__).resolve().parents[2] / "docs" / "future-feature-plans" / "foobar-reference-assets"
_FOOBAR_HELP_COPY_PATH = _FOOBAR_REFERENCE_DIR / "how-to-modal-copy.md"
_FOOBAR_REFERENCE_ASSET_DEFS: tuple[dict[str, str], ...] = (
    {
        "asset_key": "how-to-modal-copy",
        "filename": "how-to-modal-copy.md",
        "title": "How To modal copy",
        "description": "Exact checked-in help copy baseline for the future Foobar How To modal.",
    },
    {
        "asset_key": "text-tools-standard-preset",
        "filename": "text-tools-standard-preset.txt",
        "title": "Standard Text Tools preset",
        "description": "Recommended default Text Tools preset for readable manual exports.",
    },
    {
        "asset_key": "text-tools-enhanced-preset",
        "filename": "text-tools-enhanced-preset.txt",
        "title": "Enhanced Text Tools preset",
        "description": "Optional richer Text Tools preset with enhanced playback-history fields.",
    },
    {
        "asset_key": "foobar-internal-setup-summary-2026-05-28",
        "filename": "foobar-internal-setup-summary-2026-05-28.md",
        "title": "Portable setup summary",
        "description": "Observed portable-install notes captured on May 28, 2026.",
    },
    {
        "asset_key": "backup-foobar-db-script",
        "filename": "backup_foobar_db.ps1",
        "title": "Backup Foobar DB helper",
        "description": "Optional external PowerShell helper for local Foobar backup work outside Album Haven.",
    },
    {
        "asset_key": "export-text-tools-stats-script",
        "filename": "export_text_tools_stats.py",
        "title": "Export Text Tools stats helper",
        "description": "Optional external Python helper for richer local Foobar exports outside Album Haven.",
    },
    {
        "asset_key": "register-foobar-db-task-script",
        "filename": "register_foobar_db_task.ps1",
        "title": "Register Foobar DB task helper",
        "description": "Optional external PowerShell helper that registers a Windows scheduled task outside Album Haven.",
    },
)


def _slugify_heading(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.strip().lower())
    return slug.strip("-")


def _read_foobar_help_copy() -> str:
    if not _FOOBAR_HELP_COPY_PATH.exists():
        raise FileNotFoundError(f"Foobar help copy not found: {_FOOBAR_HELP_COPY_PATH}")
    return _FOOBAR_HELP_COPY_PATH.read_text(encoding="utf-8")


def _parse_foobar_help_sections(markdown_text: str) -> list[JsonDict]:
    sections: list[JsonDict] = []
    current_title = ""
    current_lines: list[str] = []

    def flush() -> None:
        nonlocal current_title, current_lines
        if not current_title:
            return
        sections.append({
            "key": _slugify_heading(current_title),
            "title": current_title,
            "body_markdown": "\n".join(current_lines).strip(),
        })
        current_title = ""
        current_lines = []

    for raw_line in markdown_text.splitlines():
        if raw_line.startswith("## "):
            flush()
            current_title = raw_line[3:].strip()
            continue
        if current_title:
            current_lines.append(raw_line.rstrip())
    flush()
    return sections


def list_foobar_reference_assets(
    *,
    build_asset_url: Callable[[str, bool], str],
) -> list[JsonDict]:
    assets: list[JsonDict] = []
    for asset_definition in _FOOBAR_REFERENCE_ASSET_DEFS:
        mime_type, _encoding = mimetypes.guess_type(asset_definition["filename"])
        assets.append({
            "asset_key": asset_definition["asset_key"],
            "filename": asset_definition["filename"],
            "title": asset_definition["title"],
            "description": asset_definition["description"],
            "mime_type": mime_type or "text/plain",
            "view_url": build_asset_url(asset_definition["asset_key"], False),
            "download_url": build_asset_url(asset_definition["asset_key"], True),
        })
    return assets


def build_foobar_integration_payload(
    *,
    build_help_url: Callable[[], str],
    build_asset_url: Callable[[str, bool], str],
) -> JsonDict:
    return {
        "key": "foobar",
        "title": "Foobar2000",
        "description": "Help-first setup, manual export references, and local sync contract prep.",
        "status_label": "How To and reference assets ready",
        "help_route": build_help_url(),
        "problem_surface": "Utilities > Problematic Files",
        "source_families": [
            {
                "key": "manual_snapshot_exports",
                "title": "Manual snapshot exports",
                "description": "Playback Statistics XML, standard Text Tools, and enhanced Text Tools files stay one-time user-triggered snapshots.",
            },
            {
                "key": "live_custom_db",
                "title": "Live custom DB source",
                "description": "A selected Foobar custom DB path stays one-time import only until Continuous Foobar sync is enabled later.",
            },
        ],
        "continuous_sync": {
            "label": "Continuous Foobar sync",
            "enabled": False,
            "default_state": "off",
            "disabled_behavior": "One-time import only",
            "cadence_when_enabled": "Once a week",
        },
        "write_back_scopes": [
            "History of plays",
            "Favorite songs",
        ],
        "reference_assets": list_foobar_reference_assets(build_asset_url=build_asset_url),
    }


def build_foobar_help_payload(
    *,
    build_asset_url: Callable[[str, bool], str],
) -> JsonDict:
    sections = _parse_foobar_help_sections(_read_foobar_help_copy())
    assets = list_foobar_reference_assets(build_asset_url=build_asset_url)
    return {
        "ok": True,
        "integration_key": "foobar",
        "title": "Foobar2000 Setup Help",
        "problem_surface": "Utilities > Problematic Files",
        "reference_asset_count": len(assets),
        "reference_assets": assets,
        "sections": sections,
    }


def resolve_foobar_reference_asset(asset_key: str) -> tuple[dict[str, str], Path]:
    normalized_key = str(asset_key or "").strip()
    for asset_definition in _FOOBAR_REFERENCE_ASSET_DEFS:
        if asset_definition["asset_key"] != normalized_key:
            continue
        return asset_definition, (_FOOBAR_REFERENCE_DIR / asset_definition["filename"])
    raise KeyError(normalized_key)
