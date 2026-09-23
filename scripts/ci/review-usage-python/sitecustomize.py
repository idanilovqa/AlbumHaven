"""Register private review telemetry only in the explicitly scoped action process."""

import json
import os
from pathlib import Path


_usage_path = os.environ.get("ALBUM_HAVEN_REVIEW_USAGE_FILE")
if _usage_path:
    try:
        from private_usage_callback import register

        register(_usage_path)
    except Exception:
        # Python reports unhandled sitecustomize errors to stderr; keep this private
        # and preserve the review's original startup and failure behavior.
        try:
            Path(_usage_path + ".status.json").write_text(
                json.dumps({"schemaVersion": 1, "state": "registration-failed"}),
                encoding="utf-8",
            )
        except OSError:
            pass
