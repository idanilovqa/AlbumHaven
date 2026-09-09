"""Shared bounded JSON request parsing for authenticated mutation routes."""

from __future__ import annotations

import json

from fastapi import Request


MAX_JSON_OBJECT_BODY_BYTES = 16_384


class JSONBodyTooLarge(ValueError):
    """Raised before JSON decoding when a request exceeds the accepted bound."""


async def read_bounded_json_object(
    request: Request,
    *,
    max_bytes: int = MAX_JSON_OBJECT_BODY_BYTES,
) -> dict[str, object] | None:
    """Read one JSON object without buffering more than ``max_bytes`` bytes."""

    raw_length = str(request.headers.get("content-length") or "").strip()
    declared_length: int | None = None
    if raw_length:
        try:
            declared_length = int(raw_length)
        except ValueError:
            return None
        if declared_length < 0:
            return None
        if declared_length > max_bytes:
            raise JSONBodyTooLarge

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > max_bytes:
            raise JSONBodyTooLarge
    if declared_length is not None and len(body) != declared_length:
        return None
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        return None
    return payload if isinstance(payload, dict) else None
