"""Process-scoped minimum for repairing unconfirmed cover selections."""
from __future__ import annotations

import os

AUTOMATIC_COVER_REPAIR_MIN_EDGE = int(os.environ.get("ALBUM_HAVEN_COVER_REPAIR_MIN_EDGE", "1200"))
if AUTOMATIC_COVER_REPAIR_MIN_EDGE < 1200:
    raise ValueError("ALBUM_HAVEN_COVER_REPAIR_MIN_EDGE must be at least 1200.")


def automatic_cover_repair_minimum_edge() -> int:
    return AUTOMATIC_COVER_REPAIR_MIN_EDGE
