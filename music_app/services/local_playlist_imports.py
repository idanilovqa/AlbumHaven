from __future__ import annotations

from collections.abc import Callable
from pathlib import PurePath


JsonDict = dict[str, object]
LOCAL_PLAYLIST_IMPORT_ANALYZE_ROUTE = "/utilities/imports/local-playlists/analyze"
LOCAL_PLAYLIST_IMPORT_EXECUTE_ROUTE = "/utilities/imports/local-playlists/import"

_SUPPORTED_SOURCE_DEFS: tuple[dict[str, str], ...] = (
    {
        "extension": ".fpl",
        "source_kind": "foobar_fpl",
        "parser_mode": "binary_adapter_reserved",
        "label": "Foobar `.fpl` playlist",
    },
    {
        "extension": ".m3u",
        "source_kind": "m3u_playlist",
        "parser_mode": "text_playlist_reserved",
        "label": "M3U playlist",
    },
    {
        "extension": ".m3u8",
        "source_kind": "m3u8_playlist",
        "parser_mode": "text_playlist_reserved",
        "label": "UTF-8 M3U playlist",
    },
    {
        "extension": ".pls",
        "source_kind": "pls_playlist",
        "parser_mode": "text_playlist_reserved",
        "label": "PLS playlist",
    },
)


def _supported_extensions() -> list[str]:
    return [definition["extension"] for definition in _SUPPORTED_SOURCE_DEFS]


def supported_local_playlist_extensions() -> list[str]:
    return _supported_extensions()


def _build_target_options() -> list[JsonDict]:
    return [
        {
            "key": "playlist",
            "title": "Playlist",
            "description": "Manual playlist import stays the default Phase 3 recommendation until analyzer matching lands.",
        },
        {
            "key": "album_top",
            "title": "Album Top",
            "description": "Album Top creation stays blocked until later album-group and completion analysis work lands.",
        },
    ]


def _build_local_library_completion_payload() -> JsonDict:
    return {
        "status": "preview_direction_reserved",
        "label": "Completion preview direction reserved",
        "detail": "Later analyzer work will show missing tracks and local-library completion candidates before Album Top creation.",
    }


def build_local_playlist_import_integration_payload(
    *,
    build_analyze_url: Callable[[], str],
    build_import_url: Callable[[], str],
) -> JsonDict:
    return {
        "key": "local_playlist_import",
        "title": "Import Local Playlist",
        "description": "Separate Utilities analyze/preview seam for local playlist files before parser and persistence work land.",
        "status_label": "Analyze/preview contract ready",
        "analyze_route": build_analyze_url(),
        "import_route": build_import_url(),
        "supported_extensions": _supported_extensions(),
        "target_options": _build_target_options(),
        "local_library_completion": _build_local_library_completion_payload(),
        "import_status": {
            "can_import": False,
            "label": "Final import execution lands later",
            "detail": "Phase 3 only prepares the analyze/preview contract and local-first validation seams.",
        },
    }


def _get_source_definition(filename: str) -> dict[str, str] | None:
    extension = PurePath(str(filename or "")).suffix.lower()
    for definition in _SUPPORTED_SOURCE_DEFS:
        if definition["extension"] == extension:
            return definition
    return None


def is_supported_local_playlist_filename(filename: str) -> bool:
    return _get_source_definition(filename) is not None


def analyze_local_playlist_upload(
    *,
    filename: str,
    size_bytes: int,
) -> JsonDict:
    source_definition = _get_source_definition(filename)
    if source_definition is None:
        supported = ", ".join(_supported_extensions())
        raise ValueError(f"Unsupported playlist file. Supported extensions: {supported}.")

    return {
        "ok": True,
        "analysis": {
            "status": {
                "key": "preview_contract_ready",
                "label": "Preview contract ready",
                "detail": "Phase 3 validates the selected file and returns the future analysis shape before parser work lands.",
            },
            "source": {
                "filename": filename,
                "extension": source_definition["extension"],
                "source_kind": source_definition["source_kind"],
                "parser_mode": source_definition["parser_mode"],
                "size_bytes": int(size_bytes),
            },
            "target_recommendation": {
                "recommended_target": "playlist",
                "allowed_targets": ["playlist"],
                "blocked_targets": [
                    {
                        "key": "album_top",
                        "reason": "Album-group matching and local-library completion analysis land in later phases.",
                    },
                ],
            },
            "local_library_completion": _build_local_library_completion_payload(),
            "preview": {
                "normalized_rows": [],
                "album_groups": [],
                "unresolved_rows": [],
            },
            "import_status": {
                "can_import": False,
                "label": "Parser and import execution land later",
                "detail": "This Phase 3 seam stops at validation plus preview-shape prep.",
            },
        },
    }
