from __future__ import annotations

import mimetypes
from pathlib import Path

from music_app.services.foobar_integrations import resolve_foobar_reference_asset


MAX_LOCAL_PLAYLIST_ANALYZE_BYTES = 2 * 1024 * 1024


def build_foobar_asset_url(asset_key: str, download: bool) -> str:
    suffix = "?download=1" if download else ""
    return f"/utilities/integrations/foobar/assets/{asset_key}{suffix}"


def resolve_foobar_asset(asset_key: str) -> tuple[dict[str, str], Path]:
    asset_definition, asset_path = resolve_foobar_reference_asset(asset_key)
    mime_type, _encoding = mimetypes.guess_type(asset_path.name)
    return {
        **asset_definition,
        "mime_type": mime_type or "text/plain",
        "filename": asset_path.name,
    }, asset_path
