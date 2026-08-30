from __future__ import annotations

import json
from pathlib import Path
import time
from typing import Literal
from uuid import uuid4


MalformedPolicy = Literal["default", "raise"]


def load_json_file(
    path: Path | str,
    *,
    default: object,
    malformed: MalformedPolicy = "default",
) -> object:
    if malformed not in {"default", "raise"}:
        raise ValueError(f"Unsupported malformed JSON policy: {malformed!r}")

    resolved_path = Path(path).expanduser().resolve(strict=False)
    if not resolved_path.exists():
        return default
    try:
        return json.loads(resolved_path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        if malformed == "raise":
            raise
        return default


def save_json_file(
    path: Path | str,
    payload: object,
    *,
    sort_keys: bool = True,
) -> None:
    resolved_path = Path(path).expanduser().resolve(strict=False)
    resolved_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = resolved_path.with_name(
        f".{resolved_path.name}.{uuid4().hex}.tmp"
    )
    try:
        temp_path.write_text(
            json.dumps(payload, indent=2, sort_keys=sort_keys, ensure_ascii=False),
            encoding="utf-8",
        )
        for attempt in range(3):
            try:
                temp_path.replace(resolved_path)
                break
            except PermissionError:
                if attempt == 2:
                    raise
                time.sleep(0.01)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
